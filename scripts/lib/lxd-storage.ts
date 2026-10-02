import { runAllowFailure, shellEscape, type CommandOptions } from "./common";
import { randomUUID } from "node:crypto";
import { lxcCommand, record, vmCapability, type InstanceType, type LxdInstance } from "./lxd-instance";

export type StorageComponent = { role: "filesystem" | "block"; dataset: string };
export type InstanceStorage = { pool: string; root: string; type: InstanceType; components: StorageComponent[] };
export type SnapshotComponent = StorageComponent & { snapshot: string; guid: string; txg: string };

export async function checkedCommand(args: string[], options: CommandOptions = {}): Promise<string> {
  const result = await runAllowFailure(args, options);
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}

export function instanceComponents(root: string, type: InstanceType, name: string): StorageComponent[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)) throw new Error(`Invalid LXD instance name: ${name}`);
  const dataset = `${root}/${type === "virtual-machine" ? "virtual-machines" : "containers"}/${name}`;
  return [{ role: "filesystem", dataset }, ...(type === "virtual-machine" ? [{ role: "block" as const, dataset: `${dataset}.block` }] : [])];
}

export async function physicalZfsRoot(pool: string): Promise<string> {
  const host = await vmCapability();
  const info = record(JSON.parse(await lxcCommand(["query", `/1.0/storage-pools/${encodeURIComponent(pool)}${host.clustered ? `?target=${encodeURIComponent(host.member)}` : ""}`], { timeoutMs: 15_000 })), "LXD storage pool");
  if (info.driver !== "zfs") throw new Error(`Pool ${pool} uses ${info.driver}; Terrarium snapshots and replication require ZFS`);
  const config = record(info.config, "LXD storage config");
  const root = String(config["zfs.pool_name"] || config.source || pool);
  if (!/^[a-zA-Z][a-zA-Z0-9_.:/-]*$/.test(root) || root.includes("@")) throw new Error(`Pool ${pool} did not advertise a valid physical ZFS dataset`);
  await checkedCommand(["zfs", "list", "-H", "-o", "name", root]);
  return root;
}

export async function instanceStorage(instance: LxdInstance): Promise<InstanceStorage> {
  const disk = Object.values(instance.expanded_devices).find((device) => device.type === "disk" && device.path === "/");
  if (!disk?.pool) throw new Error(`${instance.name}: no root storage pool found`);
  const root = await physicalZfsRoot(disk.pool);
  const components = instanceComponents(root, instance.type, instance.name);
  for (const component of components) {
    const type = (await checkedCommand(["zfs", "get", "-H", "-o", "value", "type", component.dataset])).trim();
    if (type !== (component.role === "block" ? "volume" : "filesystem")) throw new Error(`${component.dataset}: unexpected ZFS type ${type}`);
    if (instance.type === "virtual-machine") {
      const datasets = (await checkedCommand(["zfs", "list", "-H", "-r", "-o", "name", component.dataset])).trim().split("\n");
      if (datasets.length !== 1) throw new Error(`${component.dataset}: unexpected child datasets in the LXD VM storage layout; refusing an incomplete backup`);
    }
  }
  return { pool: disk.pool, root, type: instance.type, components };
}

export function selectCompleteSnapshot(components: StorageComponent[], rows: string, match = "", skipFrequent = false): SnapshotComponent[] {
  const byDataset = new Map<string, Map<string, SnapshotComponent>>();
  const order: string[] = [];
  for (const line of rows.trim().split("\n")) {
    const [snapshot, guid, localTxg, sourceTxg] = line.trim().split(/\s+/);
    const txg = sourceTxg && sourceTxg !== "-" ? sourceTxg : localTxg;
    if (!snapshot || !guid || !txg) continue;
    const [dataset, suffix] = snapshot.split("@");
    const component = components.find((component) => component.dataset === dataset);
    const matches = !match || (match.startsWith("@") ? suffix === match.slice(1) : snapshot.includes(match));
    if (!component || !suffix || !matches || skipFrequent && /(^|_)frequently$/.test(suffix)) continue;
    const snapshots = byDataset.get(dataset!) ?? new Map<string, SnapshotComponent>();
    snapshots.set(suffix, { ...component, snapshot, guid, txg });
    byDataset.set(dataset!, snapshots);
    if (component === components[0]) order.push(suffix);
  }
  for (const suffix of order.reverse()) {
    const set = components.map((component) => byDataset.get(component.dataset)?.get(suffix));
    if (set.every((item): item is SnapshotComponent => !!item) && new Set(set.map((item) => item.txg)).size === 1) return set;
  }
  return [];
}

export async function completeSnapshot(storage: InstanceStorage, match = "", skipFrequent = false): Promise<SnapshotComponent[]> {
  const rows = await checkedCommand(["zfs", "list", "-H", "-p", "-t", "snapshot", "-o", "name,guid,createtxg,org.terrarium:source-txg", "-s", "creation"]);
  return selectCompleteSnapshot(storage.components, rows, match, skipFrequent);
}

/** Flatten external image origins while retaining native LXD snapshots and child filesystems. */
export async function withIndependentFullStream<T>(snapshot: SnapshotComponent, root: string, work: (send: string[]) => Promise<T>): Promise<T> {
  const suffix = snapshot.snapshot.split("@")[1]!;
  const stagingRoot = `${root}/terrarium-send-${randomUUID()}`;
  await checkedCommand(["zfs", "create", "-o", "mountpoint=none", stagingRoot]);
  try {
    const rows = (await checkedCommand(["zfs", "list", "-H", "-r", "-t", "filesystem,volume", "-o", "name,type", snapshot.dataset])).trim().split("\n");
    for (const row of rows) {
      const [dataset, type] = row.split(/\s+/) as [string, string];
      const snapshots = (await checkedCommand(["zfs", "list", "-H", "-p", "-r", "-t", "snapshot", "-o", "name", "-s", "createtxg", dataset])).trim().split("\n").filter((name) => name.startsWith(`${dataset}@`));
      const selected = snapshots.indexOf(`${dataset}@${suffix}`);
      if (selected < 0) throw new Error(`${dataset}: full recursive backup is missing snapshot ${suffix}`);
      const first = snapshots[0]!;
      const destination = `${stagingRoot}/data${dataset.slice(snapshot.dataset.length)}`;
      const receive = ["zfs", "receive", "-u", "-o", type === "volume" ? "volmode=none" : "mountpoint=none", destination];
      const transfer = async (send: string[]) => checkedCommand(["bash", "-c", `set -o pipefail; ${send.map(shellEscape).join(" ")} | ${receive.map(shellEscape).join(" ")}`]);
      await withSnapshotHolds(snapshots.slice(0, selected + 1), async () => {
        await transfer(["zfs", "send", "-p", first]);
        if (selected > 0) await transfer(["zfs", "send", "-p", "-I", first, `${dataset}@${suffix}`]);
      });
    }
    return await work(["zfs", "send", "-R", `${stagingRoot}/data@${suffix}`]);
  } finally {
    const cleanup = await runAllowFailure(["zfs", "destroy", "-r", stagingRoot]);
    if (cleanup.exitCode !== 0) console.warn(`Could not remove full-backup staging ${stagingRoot}: ${cleanup.stderr.trim()}`);
  }
}

/** Recursive holds protect descendants and both sibling VM datasets from pruning during a transfer. */
export async function withSnapshotHolds<T>(snapshots: string[], work: () => Promise<T>): Promise<T> {
  const tag = `terrarium-${process.pid}-${crypto.randomUUID()}`;
  const held: string[] = [];
  try {
    for (const snapshot of [...new Set(snapshots)]) {
      await checkedCommand(["zfs", "hold", "-r", tag, snapshot]);
      held.push(snapshot);
    }
    return await work();
  } finally {
    for (const snapshot of held.reverse()) {
      const result = await runAllowFailure(["zfs", "release", "-r", tag, snapshot]);
      if (result.exitCode !== 0) console.warn(`Could not release ${tag} on ${snapshot}: ${result.stderr.trim()}`);
    }
  }
}
