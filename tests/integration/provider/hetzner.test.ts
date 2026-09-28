import { afterEach, describe, expect, test } from "bun:test";
import type { IntegrationLogger } from "../lib/logger";
import type { IntegrationConfig } from "../types";
import { HetznerCloudProvider } from "./hetzner";

const originalFetch = globalThis.fetch;
const originalSleep = Bun.sleep;

type FetchCall = {
  input: Parameters<typeof fetch>[0];
  init?: Parameters<typeof fetch>[1];
};

const logger = {
  path: "",
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  }
} as unknown as IntegrationLogger;

function createProvider(hcloudLocation = "fsn1", hcloudImage = "ubuntu-24.04"): HetznerCloudProvider {
  return new HetznerCloudProvider(
    {
      hcloudToken: "token-1",
      hcloudLocation,
      hcloudImage
    } as IntegrationConfig,
    logger
  );
}

function installFetchMock(responses: Response[]): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ input, init });
    const response = responses.shift();
    if (!response) {
      throw new Error(`unexpected fetch call ${String(input)}`);
    }
    return response;
  }) as typeof fetch;
  return calls;
}

function callPath(call: FetchCall): string {
  return new URL(String(call.input)).pathname;
}

function setSleepMock(handler: (ms: number) => Promise<void>): void {
  (Bun as unknown as { sleep: typeof Bun.sleep }).sleep = handler as typeof Bun.sleep;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  (Bun as unknown as { sleep: typeof Bun.sleep }).sleep = originalSleep;
});

describe("Hetzner Cloud provider cleanup", () => {
  test.each(["ubuntu-24.04", "ubuntu-26.04"])("createServer uses the selected %s image", async (image) => {
    const calls = installFetchMock([
      new Response(JSON.stringify({ locations: [{ name: "fsn1" }] })),
      new Response(JSON.stringify({ server: { id: 42, name: "server-1" } }), { status: 201 }),
      new Response(JSON.stringify({ server: { id: 42, name: "server-1", public_net: { ipv4: { ip: "192.0.2.42" } } } }))
    ]);
    await createProvider("fsn1", image).createServer("server-1", "cx22", "fsn1", [1], {});
    expect(JSON.parse(String(calls[1].init?.body)).image).toBe(image);
  });

  test("createServer retries transient placement failures", async () => {
    const sleeps: number[] = [];
    setSleepMock(async (ms) => {
      sleeps.push(ms);
    });
    const calls = installFetchMock([
      new Response(JSON.stringify({ locations: [{ name: "fsn1", network_zone: "eu-central" }] }), { status: 200 }),
      new Response(JSON.stringify({ error: { code: "resource_unavailable", message: "error during placement" } }), { status: 412 }),
      new Response(JSON.stringify({ server: { id: 42, name: "server-1" }, action: { id: 99, status: "running" } }), { status: 201 }),
      new Response(JSON.stringify({ server: { id: 42, name: "server-1", public_net: { ipv4: { ip: "192.0.2.42" } } } }), {
        status: 200
      })
    ]);

    const server = await createProvider().createServer("server-1", "cx22", "fsn1", [1], {});

    expect(server).toEqual({ id: 42, name: "server-1", ipv4: "192.0.2.42" });
    expect(calls.map(callPath)).toEqual(["/v1/locations", "/v1/servers", "/v1/servers", "/v1/servers/42"]);
    expect(calls.map((call) => call.init?.method)).toEqual(["GET", "POST", "POST", "GET"]);
    expect(sleeps).toEqual([15000]);
  });

  test("createServer tries alternate locations for a requested network zone", async () => {
    const sleeps: number[] = [];
    setSleepMock(async (ms) => {
      sleeps.push(ms);
    });
    const calls = installFetchMock([
      new Response(
        JSON.stringify({
          locations: [
            { name: "fsn1", network_zone: "eu-central" },
            { name: "nbg1", network_zone: "eu-central" }
          ]
        }),
        { status: 200 }
      ),
      new Response(JSON.stringify({ error: { code: "resource_unavailable", message: "error during placement" } }), { status: 412 }),
      new Response(JSON.stringify({ server: { id: 42, name: "server-1" }, action: { id: 99, status: "running" } }), { status: 201 }),
      new Response(JSON.stringify({ server: { id: 42, name: "server-1", public_net: { ipv4: { ip: "192.0.2.42" } } } }), {
        status: 200
      })
    ]);

    const server = await createProvider("eu-central").createServer("server-1", "cx22", "eu-central", [1], {});
    const createBodies = calls
      .filter((call) => callPath(call) === "/v1/servers" && call.init?.body)
      .map((call) => JSON.parse(String(call.init?.body)) as { location: string });

    expect(server).toEqual({ id: 42, name: "server-1", ipv4: "192.0.2.42" });
    expect(createBodies.map((body) => body.location)).toEqual(["nbg1", "fsn1"]);
    expect(sleeps).toEqual([15000]);
  });

  test("deleteVolume retries transient locked responses", async () => {
    const sleeps: number[] = [];
    setSleepMock(async (ms) => {
      sleeps.push(ms);
    });
    const calls = installFetchMock([
      new Response(JSON.stringify({ error: { code: "locked" } }), { status: 423 }),
      new Response(null, { status: 204 })
    ]);

    await createProvider().deleteVolume(42);

    expect(calls.map(callPath)).toEqual(["/v1/volumes/42", "/v1/volumes/42"]);
    expect(calls.map((call) => call.init?.method)).toEqual(["DELETE", "DELETE"]);
    expect(sleeps).toEqual([5000]);
  });

  test("serverExists reports missing servers without throwing", async () => {
    const calls = installFetchMock([new Response(null, { status: 404 })]);

    await expect(createProvider().serverExists(42)).resolves.toBe(false);

    expect(calls.map(callPath)).toEqual(["/v1/servers/42"]);
    expect(calls.map((call) => call.init?.method)).toEqual(["GET"]);
  });

  test("deleteVolume detaches attached volumes before retrying deletion", async () => {
    const sleeps: number[] = [];
    setSleepMock(async (ms) => {
      sleeps.push(ms);
    });
    const calls = installFetchMock([
      new Response("volume is attached", { status: 422 }),
      new Response(JSON.stringify({ volume: { id: 42, server: 100 } }), { status: 200 }),
      new Response(JSON.stringify({ action: { id: 77, status: "running" } }), { status: 201 }),
      new Response(JSON.stringify({ action: { id: 77, status: "success" } }), { status: 200 }),
      new Response(null, { status: 204 })
    ]);

    await createProvider().deleteVolume(42);

    expect(calls.map(callPath)).toEqual([
      "/v1/volumes/42",
      "/v1/volumes/42",
      "/v1/volumes/42/actions/detach",
      "/v1/actions/77",
      "/v1/volumes/42"
    ]);
    expect(calls.map((call) => call.init?.method)).toEqual(["DELETE", "GET", "POST", "GET", "DELETE"]);
    expect(sleeps).toEqual([5000]);
  });
});
