import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { type JsonRecord } from "./common";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scrubGeneratedLxdIdentity(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubGeneratedLxdIdentity(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const next: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if ((key === "config" || key === "expanded_config") && isRecord(item)) {
      next[key] = Object.fromEntries(Object.entries(item).filter(([configKey]) => !/^volatile\.(uuid(?:\.generation)?|vsock_id|last_state\..*|.*\.(hwaddr|host_name))$/.test(configKey)));
      continue;
    }

    if ((key === "devices" || key === "expanded_devices") && isRecord(item)) {
      next[key] = Object.fromEntries(
        Object.entries(item).map(([deviceName, device]) => {
          if (!isRecord(device)) {
            return [deviceName, scrubGeneratedLxdIdentity(device)];
          }
          const scrubbedDevice = { ...device };
          delete scrubbedDevice.hwaddr;
          delete scrubbedDevice["ipv4.address"];
          delete scrubbedDevice["ipv6.address"];
          return [deviceName, scrubGeneratedLxdIdentity(scrubbedDevice)];
        })
      );
      continue;
    }

    next[key] = scrubGeneratedLxdIdentity(item);
  }

  return next;
}

function scrubRestoreAsNewHostState(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubRestoreAsNewHostState(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const next: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if ((key === "config" || key === "expanded_config") && isRecord(item)) {
      next[key] = Object.fromEntries(Object.entries(item).filter(([configKey]) => configKey !== "user.proxy"));
      continue;
    }

    if ((key === "devices" || key === "expanded_devices") && isRecord(item)) {
      next[key] = Object.fromEntries(
        Object.entries(item)
          .filter(([, device]) => !(isRecord(device) && (device.type === "proxy" || device.type === "disk" && device.path !== "/")))
          .map(([deviceName, device]) => [deviceName, scrubRestoreAsNewHostState(device)])
      );
      continue;
    }

    next[key] = scrubRestoreAsNewHostState(item);
  }

  return next;
}

export function rewriteRecoveredBackupMetadata(backup: JsonRecord, oldName: string, newName: string): JsonRecord {
  if (backup.version !== undefined && backup.version !== 2) throw new Error(`Unsupported LXD recovery metadata version ${backup.version}`);
  const result = structuredClone(backup);
  const instanceKey = isRecord(result.instance) ? "instance" : "container";
  const instance = result[instanceKey];
  if (!isRecord(instance) || instance.name !== oldName) throw new Error(`recovered LXD backup metadata did not reference source instance '${oldName}'`);
  const rename = (item: unknown, hostState: boolean): unknown => {
    if (!isRecord(item)) return item;
    const copy = { ...item };
    if (typeof copy.name === "string" && (copy.name === oldName || copy.name.startsWith(`${oldName}/`))) copy.name = newName + copy.name.slice(oldName.length);
    const identity = scrubGeneratedLxdIdentity(copy);
    return hostState ? scrubRestoreAsNewHostState(identity) : identity;
  };
  result[instanceKey] = rename(instance, true);
  if (Array.isArray(result.snapshots)) result.snapshots = result.snapshots.map((item) => rename(item, true));
  if (Array.isArray(result.volumes)) result.volumes = result.volumes.map((item) => rename(item, false));
  if (isRecord(result.volume)) result.volume = rename(result.volume, false);
  if (Array.isArray(result.volume_snapshots)) result.volume_snapshots = result.volume_snapshots.map((item) => rename(item, false));
  return result;
}

/** Remap storage references only; application config and unrelated disks are not renamed. */
export function relocateRecoveredStorage(backup: JsonRecord, pool: JsonRecord, member: string): JsonRecord {
  const result = structuredClone(backup);
  const instance = (result.instance ?? result.container) as JsonRecord;
  const disks = (instance.expanded_devices ?? instance.devices) as Record<string, JsonRecord>;
  const root = Object.entries(disks).find(([, device]) => device.type === "disk" && device.path === "/");
  if (!root || typeof root[1].pool !== "string") throw new Error("Recovery metadata has no root storage pool");
  const oldPool = root[1].pool;
  const remapInstance = (guest: JsonRecord) => {
    guest.location = member;
    const devices = (guest.devices ??= {}) as Record<string, JsonRecord>;
    devices[root[0]] = { ...root[1], pool: pool.name };
    if (isRecord(guest.expanded_devices)) guest.expanded_devices[root[0]] = { ...root[1], pool: pool.name };
  };
  remapInstance(instance);
  if (Array.isArray(result.snapshots)) for (const snapshot of result.snapshots) if (isRecord(snapshot)) remapInstance(snapshot);
  if (Array.isArray(result.pools)) result.pools = result.pools.map((entry) => isRecord(entry) && entry.name === oldPool ? pool : entry);
  if (Array.isArray(result.volumes)) for (const volume of result.volumes) if (isRecord(volume) && volume.pool === oldPool) { volume.pool = pool.name; volume.location = member; }
  if (oldPool !== pool.name && Array.isArray(result.profiles)) {
    for (const profile of result.profiles) if (isRecord(profile) && isRecord(profile.devices)) {
      for (const disk of Object.values(profile.devices)) if (isRecord(disk) && disk.type === "disk" && disk.path === "/" && disk.pool === oldPool) disk.pool = pool.name;
    }
  }
  return result;
}

export function rewriteBackupYaml(mountPath: string, oldName: string, newName: string): void {
  const backupPath = join(mountPath, "backup.yaml");
  if (!existsSync(backupPath)) {
    throw new Error(`recovered LXD dataset is missing backup.yaml at ${backupPath}`);
  }

  const backup = parse(readFileSync(backupPath, "utf8")) as unknown;
  if (!isRecord(backup)) {
    throw new Error(`recovered LXD backup metadata is not an object: ${backupPath}`);
  }

  try {
    writeFileSync(backupPath, stringify(rewriteRecoveredBackupMetadata(backup, oldName, newName)));
  } catch (error) {
    const message = String(error).replace(/^Error: /, "");
    throw new Error(message.includes(backupPath) ? message : `${message}: ${backupPath}`);
  }
}
