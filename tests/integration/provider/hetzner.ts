import type { IntegrationConfig, ServerRecord, VolumeRecord } from "../types";
import { IntegrationLogger } from "../lib/logger";

type HetznerAction = { id: number; status: string };
type HetznerServerResponse = { server: { id: number; name: string; public_net?: { ipv4?: { ip?: string } } }; action?: HetznerAction };
type HetznerVolumeResponse = {
  volume: {
    id: number;
    name: string;
    linux_device?: string;
    server?: number | null;
  };
  action?: HetznerAction;
};
type HetznerSshKey = { id: number; name: string; public_key: string };
type HetznerLocation = { name: string; network_zone?: string };
export type HetznerSshKeyHandle = { id: number; reused: boolean };
export type HetznerServerCreated = { id: number; name: string };
export type HetznerVolumeCreated = { id: number; name: string; linuxDevice?: string };

const VOLUME_DELETE_ATTEMPTS = 12;
const VOLUME_DELETE_RETRY_MS = 5000;
const SERVER_CREATE_ATTEMPTS = 5;
const SERVER_CREATE_RETRY_MS = 15000;

function normalizePublicKey(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
}

function isPlacementUnavailable(status: number, body: string): boolean {
  return status === 412 && body.includes("resource_unavailable");
}

/**
 * Minimal Hetzner Cloud REST client for ephemeral integration resources.
 *
 * Using the HTTP API directly keeps local manual runs and Actions consistent
 * without requiring the `hcloud` CLI to be installed.
 */
export class HetznerCloudProvider {
  private readonly token: string;
  private readonly logger: IntegrationLogger;
  private readonly requestedLocation: string;
  private readonly image: string;
  private readonly requestTimeoutMs = 30000;
  private readonly maxAttempts = 8;
  private resolvedLocationName = "";
  private resolvedLocationNames: string[] = [];

  constructor(config: IntegrationConfig, logger: IntegrationLogger) {
    this.token = config.hcloudToken;
    this.logger = logger;
    this.requestedLocation = config.hcloudLocation.trim();
    this.image = config.hcloudImage;
  }

  private async requestResponse(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `https://api.hetzner.cloud/v1${path}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.logger.info(`hetzner ${method} ${path}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json"
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });
        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxAttempts) {
          break;
        }
        await Bun.sleep(attempt * 2000);
      }
    }
    throw new Error(`Hetzner API ${method} ${path} failed after retries: ${String(lastError)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.requestResponse(method, path, body);
    if (!response.ok) {
      throw new Error(`Hetzner API ${method} ${path} failed with HTTP ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private async resolveLocationNames(): Promise<string[]> {
    if (this.resolvedLocationNames.length > 0) {
      return this.resolvedLocationNames;
    }

    const response = await this.request<{ locations?: HetznerLocation[] }>("GET", "/locations");
    const locations = response.locations ?? [];
    const exact = locations.find((location) => location.name === this.requestedLocation);
    if (exact) {
      this.resolvedLocationNames = [exact.name];
      this.resolvedLocationName = exact.name;
      return this.resolvedLocationNames;
    }

    const matchingZone = locations
      .filter((location) => location.network_zone === this.requestedLocation)
      .sort((left, right) => left.name.localeCompare(right.name));
    if (matchingZone.length > 0) {
      const preferred = matchingZone.find((location) => location.name === "nbg1") ?? matchingZone[0];
      this.resolvedLocationNames = [preferred, ...matchingZone.filter((location) => location.name !== preferred.name)].map(
        (location) => location.name
      );
      this.resolvedLocationName = this.resolvedLocationNames[0] ?? "";
      this.logger.info(`resolved Hetzner network zone ${this.requestedLocation} to locations ${this.resolvedLocationNames.join(", ")}`);
      return this.resolvedLocationNames;
    }

    throw new Error(`unable to resolve Hetzner location ${this.requestedLocation}`);
  }

  private async resolveLocationName(): Promise<string> {
    const locations = await this.resolveLocationNames();
    return this.resolvedLocationName || locations[0] || "";
  }

  async createSshKey(name: string, publicKey: string): Promise<HetznerSshKeyHandle> {
    const normalized = normalizePublicKey(publicKey);
    const response = await this.requestResponse("POST", "/ssh_keys", {
      name,
      public_key: normalized
    });
    if (response.ok) {
      const payload = (await response.json()) as { ssh_key: { id: number } };
      return { id: payload.ssh_key.id, reused: false };
    }

    const body = await response.text();
    if (response.status === 409 && body.includes("public_key")) {
      const existing = await this.findSshKeyByPublicKey(normalized);
      if (existing) {
        this.logger.info(`reuse existing Hetzner SSH key ${existing.id} (${existing.name})`);
        return { id: existing.id, reused: true };
      }
    }
    throw new Error(`Hetzner API POST /ssh_keys failed with HTTP ${response.status}: ${body}`);
  }

  private async findSshKeyByPublicKey(publicKey: string): Promise<HetznerSshKey | null> {
    const response = await this.request<{ ssh_keys?: HetznerSshKey[] }>("GET", "/ssh_keys");
    const normalized = normalizePublicKey(publicKey);
    return (response.ssh_keys ?? []).find((key) => normalizePublicKey(key.public_key) === normalized) ?? null;
  }

  async deleteSshKey(id: number): Promise<void> {
    const response = await this.requestResponse("DELETE", `/ssh_keys/${id}`);
    if (!response.ok && response.status !== 404) {
      throw new Error(`failed to delete Hetzner SSH key ${id}: HTTP ${response.status}`);
    }
  }

  async createServer(
    name: string,
    serverType: string,
    location: string,
    sshKeyIds: number[],
    labels: Record<string, string>,
    onCreated?: (server: HetznerServerCreated) => void | Promise<void>
  ): Promise<ServerRecord> {
    const locationCandidates = await this.resolveLocationNames();

    let response: HetznerServerResponse | null = null;
    for (let attempt = 1; attempt <= SERVER_CREATE_ATTEMPTS; attempt += 1) {
      const candidateLocation = locationCandidates[(attempt - 1) % locationCandidates.length] || location;
      const body = {
        name,
        server_type: serverType,
        image: this.image,
        location: candidateLocation,
        ssh_keys: sshKeyIds,
        labels
      };
      const raw = await this.requestResponse("POST", "/servers", body);
      if (raw.ok) {
        response = (await raw.json()) as HetznerServerResponse;
        this.resolvedLocationName = candidateLocation;
        break;
      }

      const errorBody = await raw.text();
      if (attempt < SERVER_CREATE_ATTEMPTS && isPlacementUnavailable(raw.status, errorBody)) {
        this.logger.warn(
          `Hetzner server placement unavailable in ${candidateLocation}; retrying create in ${SERVER_CREATE_RETRY_MS}ms`
        );
        await Bun.sleep(SERVER_CREATE_RETRY_MS);
        continue;
      }
      throw new Error(`Hetzner API POST /servers failed with HTTP ${raw.status}: ${errorBody}`);
    }

    if (!response) {
      throw new Error("Hetzner API POST /servers failed without a response");
    }

    if (response.action) {
      this.logger.info(
        `created Hetzner server ${response.server.id} with action ${response.action.id}; waiting for server readiness instead of action completion`
      );
    }
    await onCreated?.({ id: response.server.id, name: response.server.name });
    return await this.waitForServer(response.server.id);
  }

  async waitForServer(id: number, timeoutMs = 240000): Promise<ServerRecord> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const response = await this.request<{ server: { id: number; name: string; public_net?: { ipv4?: { ip?: string } } } }>(
          "GET",
          `/servers/${id}`
        );
        const ip = response.server.public_net?.ipv4?.ip;
        if (ip) {
          return { id: response.server.id, name: response.server.name, ipv4: ip };
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await Bun.sleep(3000);
    }
    const suffix = lastError ? `; last error: ${lastError}` : "";
    throw new Error(`timed out waiting for Hetzner server ${id} IPv4${suffix}`);
  }

  async deleteServer(id: number): Promise<void> {
    const response = await this.requestResponse("DELETE", `/servers/${id}`);
    if (!response.ok && response.status !== 404) {
      throw new Error(`failed to delete Hetzner server ${id}: HTTP ${response.status}`);
    }
  }

  async serverExists(id: number): Promise<boolean> {
    const response = await this.requestResponse("GET", `/servers/${id}`);
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`Hetzner API GET /servers/${id} failed with HTTP ${response.status}: ${await response.text()}`);
    }
    return true;
  }

  async waitForServerDeleted(id: number, timeoutMs = 240000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      const response = await this.requestResponse("GET", `/servers/${id}`);
      if (response.status === 404) {
        return;
      }
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${await response.text()}`;
      }
      await Bun.sleep(3000);
    }
    const suffix = lastError ? `; last error: ${lastError}` : "";
    throw new Error(`timed out waiting for Hetzner server ${id} deletion${suffix}`);
  }

  async createVolume(
    name: string,
    sizeGb: number,
    location: string,
    labels: Record<string, string>,
    onCreated?: (volume: HetznerVolumeCreated) => void | Promise<void>
  ): Promise<VolumeRecord> {
    const resolvedLocation = await this.resolveLocationName();
    const response = await this.request<HetznerVolumeResponse>("POST", "/volumes", {
      name,
      size: sizeGb,
      location: resolvedLocation || location,
      labels,
      format: ""
    });
    await onCreated?.({
      id: response.volume.id,
      name: response.volume.name,
      linuxDevice: response.volume.linux_device
    });
    if (response.action) {
      await this.waitForAction(response.action.id);
    }
    return {
      id: response.volume.id,
      name: response.volume.name,
      linuxDevice: response.volume.linux_device
    };
  }

  async attachVolume(volumeId: number, serverId: number): Promise<VolumeRecord> {
    const response = await this.request<HetznerVolumeResponse>("POST", `/volumes/${volumeId}/actions/attach`, {
      server: serverId,
      automount: false
    });
    if (response.action) {
      this.logger.info(`attaching Hetzner volume ${volumeId} with action ${response.action.id}; waiting for volume state instead of action completion`);
    }
    return await this.waitForAttachedVolume(volumeId, serverId);
  }

  async deleteVolume(id: number): Promise<void> {
    let lastFailure = "";
    for (let attempt = 1; attempt <= VOLUME_DELETE_ATTEMPTS; attempt += 1) {
      const response = await this.requestResponse("DELETE", `/volumes/${id}`);
      if (response.ok || response.status === 404) {
        return;
      }

      const body = await response.text();
      lastFailure = `HTTP ${response.status}${body ? `: ${body}` : ""}`;
      if (response.status === 422) {
        const detachState = await this.detachVolumeIfNeeded(id);
        if (detachState === "missing") {
          return;
        }
        this.logger.info(`Hetzner volume ${id} delete blocked by attachment (${detachState}); retrying`);
        await Bun.sleep(VOLUME_DELETE_RETRY_MS);
        continue;
      }

      if (this.isLockedResponse(response.status, body) && attempt < VOLUME_DELETE_ATTEMPTS) {
        this.logger.info(`Hetzner volume ${id} delete is locked; retrying after provider settles`);
        await Bun.sleep(VOLUME_DELETE_RETRY_MS);
        continue;
      }

      throw new Error(`failed to delete Hetzner volume ${id}: ${lastFailure}`);
    }

    throw new Error(`failed to delete Hetzner volume ${id} after retries: ${lastFailure}`);
  }

  private async detachVolumeIfNeeded(id: number): Promise<"already-detached" | "detaching" | "locked" | "missing"> {
    const volumeResponse = await this.requestResponse("GET", `/volumes/${id}`);
    if (volumeResponse.status === 404) {
      return "missing";
    }
    if (!volumeResponse.ok) {
      const body = await volumeResponse.text();
      if (this.isLockedResponse(volumeResponse.status, body)) {
        return "locked";
      }
      throw new Error(`Hetzner API GET /volumes/${id} failed with HTTP ${volumeResponse.status}: ${body}`);
    }

    const volume = (await volumeResponse.json()) as { volume: { id: number; server?: number | null } };
    if (!volume.volume.server) {
      return "already-detached";
    }

    const detachResponse = await this.requestResponse("POST", `/volumes/${id}/actions/detach`);
    if (detachResponse.status === 404) {
      return "missing";
    }
    const body = await detachResponse.text();
    if (!detachResponse.ok) {
      if (this.isLockedResponse(detachResponse.status, body)) {
        return "locked";
      }
      throw new Error(`Hetzner API POST /volumes/${id}/actions/detach failed with HTTP ${detachResponse.status}: ${body}`);
    }

    const response = body ? (JSON.parse(body) as { action?: HetznerAction }) : {};
    if (!response.action) {
      return "detaching";
    }
    await this.waitForAction(response.action.id);
    return "detaching";
  }

  private isLockedResponse(status: number, body: string): boolean {
    return status === 423 || body.includes('"code":"locked"') || body.includes('"code": "locked"');
  }

  private async waitForAttachedVolume(volumeId: number, serverId: number, timeoutMs = 240000): Promise<VolumeRecord> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const volume = await this.request<{ volume: { id: number; name: string; linux_device?: string; server?: number | null } }>(
          "GET",
          `/volumes/${volumeId}`
        );
        if (volume.volume.server === serverId && volume.volume.linux_device) {
          return {
            id: volume.volume.id,
            name: volume.volume.name,
            linuxDevice: volume.volume.linux_device
          };
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await Bun.sleep(3000);
    }
    const suffix = lastError ? `; last error: ${lastError}` : "";
    throw new Error(`timed out waiting for Hetzner volume ${volumeId} to attach to server ${serverId}${suffix}`);
  }

  private async waitForAction(actionId: number, timeoutMs = 240000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await this.request<{ action: HetznerAction; error?: { message?: string } }>("GET", `/actions/${actionId}`);
      if (response.action.status === "success") {
        return;
      }
      if (response.action.status === "error") {
        throw new Error(`Hetzner action ${actionId} failed: ${response.error?.message || "unknown error"}`);
      }
      await Bun.sleep(2500);
    }
    throw new Error(`timed out waiting for Hetzner action ${actionId}`);
  }
}
