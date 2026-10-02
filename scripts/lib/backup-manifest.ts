import { instanceType, record, type InstanceType } from "./lxd-instance";

export type BackupComponent = {
  role: "filesystem" | "block";
  dataset: string;
  snapshot: string;
  guid: string;
  txg: string;
  object_key: string;
  sha256: string;
  bytes: number;
};

export type BackupManifest = {
  version: 2;
  id: string;
  installation: string;
  project: "default";
  instance: string;
  instance_uuid: string;
  instance_type: InstanceType;
  architecture: string;
  pool: string;
  snapshot: string;
  created_at: string;
  parent: string | null;
  components: BackupComponent[];
};

function string(value: unknown, key: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid backup manifest ${key}`);
  return value;
}

export function parseBackupManifest(value: unknown): BackupManifest {
  const data = record(value, "backup manifest");
  if (data.version !== 2 || data.project !== "default") throw new Error("Unsupported backup manifest version or project");
  const type = instanceType(data.instance_type);
  if (!Array.isArray(data.components)) throw new Error("Backup manifest is missing components");
  const components = data.components.map((item): BackupComponent => {
    const part = record(item, "backup component");
    if (part.role !== "filesystem" && part.role !== "block") throw new Error("Unknown backup component role");
    const component: BackupComponent = { role: part.role, dataset: string(part.dataset, "dataset"), snapshot: string(part.snapshot, "snapshot"), guid: string(part.guid, "guid"), txg: string(part.txg, "txg"), object_key: string(part.object_key, "object_key"), sha256: string(part.sha256, "sha256"), bytes: part.bytes as number };
    if (!/^\d+$/.test(component.guid) || !/^\d+$/.test(component.txg) || !/^[a-f0-9]{64}$/.test(component.sha256) || !Number.isSafeInteger(component.bytes) || component.bytes <= 0) throw new Error("Invalid backup component checksum, size or snapshot identity");
    if (!component.snapshot.startsWith(`${component.dataset}@`) || component.object_key.startsWith("/") || component.object_key.split("/").includes("..")) throw new Error("Invalid backup component path");
    return component;
  });
  const roles = components.map((part) => part.role).sort().join(",");
  if (roles !== (type === "virtual-machine" ? "block,filesystem" : "filesystem")) throw new Error("Incomplete or duplicate backup components");
  const snapshot = string(data.snapshot, "snapshot");
  if (components.some((part) => part.snapshot.split("@")[1] !== snapshot) || new Set(components.map((part) => part.txg)).size !== 1) throw new Error("Backup components are from different snapshot transactions");
  if (data.parent !== null && typeof data.parent !== "string") throw new Error("Invalid backup parent");
  const result: BackupManifest = {
    version: 2, project: "default", id: string(data.id, "id"), installation: string(data.installation, "installation"),
    instance: string(data.instance, "instance"), instance_uuid: string(data.instance_uuid, "instance_uuid"),
    instance_type: type, architecture: string(data.architecture, "architecture"), pool: string(data.pool, "pool"),
    snapshot, created_at: string(data.created_at, "created_at"), parent: data.parent as string | null, components
  };
  if (!Number.isFinite(Date.parse(result.created_at))) throw new Error("Invalid backup timestamp");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(result.instance)) throw new Error("Invalid backup instance name");
  if (result.id !== `${result.installation}/default/${result.instance}/${result.instance_uuid}/${snapshot}`) throw new Error("Backup identity does not match its provenance");
  for (const part of [result.installation, result.instance_uuid, snapshot]) if (!/^[a-zA-Z0-9_.:-]+$/.test(part)) throw new Error("Invalid backup identity segment");
  const datasetRoots = components.map((part) => {
    const suffix = `/${type === "virtual-machine" ? "virtual-machines" : "containers"}/${result.instance}${part.role === "block" ? ".block" : ""}`;
    if (!part.dataset.endsWith(suffix) || !/^[a-zA-Z][a-zA-Z0-9_.:/-]*$/.test(part.dataset)) throw new Error("Backup component does not belong to its instance");
    if (!part.object_key.endsWith(`/streams-v2/${result.id}/${part.role}.zfs.zst`)) throw new Error("Backup stream key does not match its component identity");
    return part.dataset.slice(0, -suffix.length);
  });
  if (new Set(datasetRoots).size !== 1) throw new Error("Backup components belong to different storage roots");
  return result;
}

export function backupChain(manifests: BackupManifest[], selected: BackupManifest): BackupManifest[] {
  const byId = new Map<string, BackupManifest>();
  for (const manifest of manifests) {
    if (byId.has(manifest.id)) throw new Error(`Duplicate backup manifest ${manifest.id}`);
    byId.set(manifest.id, manifest);
  }
  const chain: BackupManifest[] = [];
  const seen = new Set<string>();
  let current: BackupManifest | undefined = selected;
  while (current) {
    if (seen.has(current.id)) throw new Error("Backup chain contains a cycle");
    if (current.installation !== selected.installation || current.instance_uuid !== selected.instance_uuid || current.instance !== selected.instance || current.instance_type !== selected.instance_type || current.architecture !== selected.architecture) throw new Error("Backup chain crosses instance identities");
    chain.push(current);
    seen.add(current.id);
    if (!current.parent) break;
    const parent = byId.get(current.parent);
    if (!parent) throw new Error(`Backup chain is missing parent ${current.parent}`);
    if (Date.parse(parent.created_at) >= Date.parse(current.created_at)) throw new Error("Backup parent is not older than its child");
    current = parent;
  }
  return chain.reverse();
}

export function selectBackup(manifests: BackupManifest[], instance: string, match = "", uuid?: string): BackupManifest | undefined {
  const matches = manifests.filter((item) => item.instance === instance && (!uuid || item.instance_uuid === uuid) && (!match || item.id === match || item.snapshot.includes(match) || item.created_at.includes(match)));
  if (new Set(matches.map((item) => `${item.installation}/${item.instance_uuid}`)).size > 1) throw new Error(`Multiple backup identities exist for ${instance}; use --at with the full backup ID from backup list`);
  return matches.sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
}
