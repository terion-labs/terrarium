import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { confirm } from "@inquirer/prompts";
import { runAllowFailure, runInteractiveChecked, shellEscape } from "../lib/common";
import { lxcArgs, lxcCommand, readInstance, instanceType, record, vmCapability, type InstanceType, type LxdInstance } from "../lib/lxd-instance";
import { checkedCommand, completeSnapshot, instanceComponents, instanceStorage, physicalZfsRoot, withSnapshotHolds, withIndependentFullStream, type InstanceStorage, type StorageComponent } from "../lib/lxd-storage";
import { loadBackupManifests, promoteBackupSet, stageBackupSet, withBackupLock } from "../lib/s3-backup-sets";
import { selectBackup } from "../lib/backup-manifest";
import { prepareVmGuestIdentity, quarantineVm, sanitizeInstanceHostState, ensureQuarantineAcl } from "../lib/guest-identity";
import { rewriteBackupYaml, relocateRecoveredStorage } from "../lib/recovery-metadata";
import { prepareRootfsDirectoryForLxdRecover, mountRootfsDatasetForLxdRecover } from "../lib/recovery-rootfs";

type RestoreSet = { components: StorageComponent[]; stagingRoot: string };

async function optionalInstance(name: string): Promise<LxdInstance | undefined> {
  const result = await runAllowFailure(lxcArgs("query", `/1.0/instances/${encodeURIComponent(name)}?project=default`), { timeoutMs: 15_000 });
  if (result.exitCode === 0) return readInstance(name);
  if (/not found|404/i.test(result.stderr + result.stdout)) return undefined;
  throw new Error(`Cannot inspect restore target ${name}: ${result.stderr.trim()}`);
}

export async function resolveRestoreStorage(name: string, pool: string): Promise<InstanceStorage> {
  const instance = await optionalInstance(name);
  if (instance) {
    const host = await vmCapability();
    if (host.clustered && instance.location !== host.member) throw new Error(`${name} is on ${instance.location}; restore it on that member`);
    return instanceStorage(instance);
  }
  const root = await physicalZfsRoot(pool);
  const matches: InstanceStorage[] = [];
  for (const type of ["container", "virtual-machine"] as const) {
    const components = instanceComponents(root, type, name);
    if ((await runAllowFailure(["zfs", "list", "-H", components[0]!.dataset])).exitCode === 0) matches.push({ pool, root, type, components });
  }
  if (matches.length !== 1) throw new Error(`${name}: expected one local instance dataset, found ${matches.length}`);
  return matches[0]!;
}

async function stageLocal(storage: InstanceStorage, at: string): Promise<RestoreSet> {
  const snapshots = await completeSnapshot(storage, at);
  if (!snapshots.length) throw new Error(`No complete local snapshot set matches ${at || "the requested instance"}`);
  const stagingRoot = `${storage.root}/terrarium-restore-${randomUUID()}`;
  await checkedCommand(["zfs", "create", "-o", "mountpoint=none", stagingRoot]);
  const components = storage.components.map((part) => ({ role: part.role, dataset: `${stagingRoot}/${part.role}` }));
  try {
    await withSnapshotHolds(snapshots.map((part) => part.snapshot), async () => {
      for (const snapshot of snapshots) {
        const target = components.find((part) => part.role === snapshot.role)!;
        await withIndependentFullStream(snapshot, storage.root, async (send) => {
          await checkedCommand(["bash", "-c", `set -o pipefail; ${send.map(shellEscape).join(" ")} | zfs receive -u ${snapshot.role === "filesystem" ? "-o mountpoint=none " : ""}${shellEscape(target.dataset)}`]);
        });
        const guid = (await checkedCommand(["zfs", "get", "-H", "-p", "-o", "value", "guid", `${target.dataset}@${snapshot.snapshot.split("@")[1]}`])).trim();
        if (guid !== snapshot.guid) throw new Error(`${target.dataset}: local snapshot GUID mismatch`);
        await checkedCommand(["zfs", "set", `org.terrarium:source-txg=${snapshot.txg}`, `${target.dataset}@${snapshot.snapshot.split("@")[1]}`]);
      }
    });
    return { components, stagingRoot };
  } catch (error) {
    await runAllowFailure(["zfs", "destroy", "-r", stagingRoot]);
    throw error;
  }
}

function storageMountPath(pool: string, type: InstanceType, name: string): string {
  const root = existsSync("/var/snap/lxd/common/lxd/storage-pools") ? "/var/snap/lxd/common/lxd/storage-pools" : "/var/lib/lxd/storage-pools";
  return join(root, pool, type === "virtual-machine" ? "virtual-machines" : "containers", name);
}

async function inspectStagedMetadata(staged: RestoreSet, type: InstanceType, source: string, target: string, pool: string): Promise<{ architecture: string }> {
  const path = join(process.env.TERRARIUM_STATE_DIR ?? "/var/lib/terrarium", "restore", randomUUID());
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const filesystem = staged.components.find((part) => part.role === "filesystem")!.dataset;
  await checkedCommand(["zfs", "set", "mountpoint=legacy", filesystem]);
  await checkedCommand(["mount", "-t", "zfs", filesystem, path]);
  try {
    const metadata = record(parse(readFileSync(join(path, "backup.yaml"), "utf8")), "LXD recovery metadata");
    if (metadata.version !== undefined && metadata.version !== 2) throw new Error(`Unsupported LXD recovery metadata version ${metadata.version}`);
    const instance = record(metadata.instance ?? metadata.container, "recovered instance");
    if (instance.name !== source) throw new Error(`Snapshot metadata belongs to ${instance.name}, expected ${source}`);
    const metadataType = instance.type === undefined && type === "container" ? "container" : instanceType(instance.type);
    if (metadataType !== type) throw new Error("Snapshot metadata and storage component type disagree");
    if (type === "container" && (await runAllowFailure(["zfs", "list", "-H", `${filesystem}/rootfs`])).exitCode !== 0) prepareRootfsDirectoryForLxdRecover(path);
    const host = await vmCapability();
    const destinationPool = record(JSON.parse(await lxcCommand(["query", `/1.0/storage-pools/${encodeURIComponent(pool)}${host.clustered ? `?target=${encodeURIComponent(host.member)}` : ""}`])), "destination pool");
    writeFileSync(join(path, "backup.yaml"), stringify(relocateRecoveredStorage(metadata, destinationPool, host.member)));
    if (target !== source) {
      rewriteBackupYaml(path, source, target);
      if (type === "virtual-machine") {
        await ensureQuarantineAcl();
        const rewritten = record(parse(readFileSync(join(path, "backup.yaml"), "utf8")), "recovery metadata");
        const guest = record(rewritten.instance, "recovery instance");
        const config = record(guest.config, "recovery config");
        const devices = record(guest.devices, "recovery devices");
        const expanded = record(guest.expanded_devices ?? guest.devices, "expanded recovery devices");
        const saved = [];
        for (const [name, value] of Object.entries(expanded)) {
          const device = record(value, "recovery NIC");
          if (device.type !== "nic") continue;
          if (typeof device.network !== "string") throw new Error(`${name}: restore-as-new requires an OVN NIC for identity quarantine`);
          const network = record(JSON.parse(await lxcCommand(["query", `/1.0/networks/${encodeURIComponent(device.network)}?project=default`])), "recovery network");
          if (network.type !== "ovn") throw new Error(`${name}: restore-as-new requires OVN quarantine support`);
          saved.push({ name, original: device });
          devices[name] = { ...device, "security.acls": "terrarium-clone-quarantine", "security.acls.default.ingress.action": "drop", "security.acls.default.egress.action": "drop" };
        }
        config["boot.autostart"] = "false";
        config["user.terrarium.quarantined-nics"] = JSON.stringify(saved);
        guest.config = config;
        guest.devices = devices;
        writeFileSync(join(path, "backup.yaml"), stringify(rewritten));
      }
    }
    return { architecture: String(instance.architecture ?? "") };
  } finally {
    await checkedCommand(["umount", path]);
    rmSync(path, { recursive: true });
  }
}

async function mountRestoredFilesystem(pool: string, type: InstanceType, name: string, components: StorageComponent[]): Promise<void> {
  const filesystem = components.find((part) => part.role === "filesystem")!.dataset;
  const path = storageMountPath(pool, type, name);
  mkdirSync(path, { recursive: true });
  await checkedCommand(["zfs", "set", "mountpoint=legacy", filesystem]);
  await checkedCommand(["mount", "-t", "zfs", filesystem, path]);
  if (type === "container") {
    const rootfs = `${filesystem}/rootfs`;
    if ((await runAllowFailure(["zfs", "list", "-H", rootfs])).exitCode === 0) await mountRootfsDatasetForLxdRecover(rootfs, join(path, "rootfs"));
    else prepareRootfsDirectoryForLxdRecover(path);
  }
}

async function finishRestore(staged: RestoreSet, pool: string, root: string, type: InstanceType, source: string, target: string, existing?: LxdInstance): Promise<void> {
  const targets = instanceComponents(root, type, target);
  if (!existing) {
    if (await optionalInstance(target)) throw new Error(`Instance ${target} already exists; choose a different --as-new name`);
    for (const part of targets) if ((await runAllowFailure(["zfs", "list", "-H", part.dataset])).exitCode === 0) throw new Error(`Restore target ${part.dataset} already exists`);
  }
  const metadata = await inspectStagedMetadata(staged, type, source, target, pool);
  const host = await vmCapability();
  if (type === "virtual-machine" && !host.available) throw new Error(host.reason);
  if (metadata.architecture && !host.architectures.includes(metadata.architecture)) throw new Error(`This host cannot run restored ${metadata.architecture} instances`);
  if (existing) {
    if (existing.type !== type || existing.architecture !== metadata.architecture) throw new Error("Restore type or architecture does not match the existing instance");
    if (!(await confirm({ message: `Replace the disks of ${target} with this verified restore set? Previous disks will be retained.`, default: false }))) throw new Error("operation cancelled");
    if (existing.status.toLowerCase() !== "stopped") await lxcCommand(["stop", target, "--timeout", "60"], { timeoutMs: 90_000 });
  }
  await promoteBackupSet(staged, targets, !!existing);
  // LXD must mount VM metadata inside its own mount namespace. Mounting it
  // externally at the LXD path can hide backup.yaml from the snap daemon.
  if (type === "container" && (await runAllowFailure(["zfs", "list", "-H", `${targets[0]!.dataset}/rootfs`])).exitCode === 0) await mountRestoredFilesystem(pool, type, target, targets);
  if (!existing) {
    console.log(`Prepared ${target} (${type}) in LXD pool ${pool}. Select this pool and import the instance in the following LXD recovery dialog.`);
    await runInteractiveChecked([process.env.TERRARIUM_LXD_BIN ?? "/snap/bin/lxd", "recover"]);
    const imported = await readInstance(target);
    if (imported.type !== type) throw new Error(`Recovered ${target} has the wrong instance type`);
    await sanitizeInstanceHostState(target);
    if (type === "virtual-machine") {
      const saved = await quarantineVm(await readInstance(target));
      await prepareVmGuestIdentity(target, false, saved);
    }
  }
  console.log(`Restored ${target} (${type}); start it with lxc start ${target}`);
}

export async function restoreLocalSet(instance: string, at: string, newName: string, pool: string): Promise<void> {
  await withBackupLock(async () => {
    const storage = await resolveRestoreStorage(instance, pool);
    const existing = newName ? undefined : await optionalInstance(instance);
    if (!newName && !existing) throw new Error("An unregistered source must be restored with --as-new");
    const staged = await stageLocal(storage, at);
    await finishRestore(staged, storage.pool, storage.root, storage.type, instance, newName || instance, existing);
  });
}

/** Returns false only when no versioned backup exists; callers may then use legacy container manifests. */
export async function restoreS3Set(config: Record<string, unknown>, instance: string, at: string, newName: string, pool: string): Promise<boolean> {
  return withBackupLock(async () => {
    const existing = newName ? undefined : await optionalInstance(instance);
    const manifests = await loadBackupManifests(config);
    const selected = selectBackup(manifests, instance, at, existing?.config["volatile.uuid"]);
    if (!selected) {
      if (manifests.some((item) => item.instance === instance)) throw new Error(`No versioned backup matches ${instance} and the selected identity/restore point`);
      return false;
    }
    if (!newName && !existing) throw new Error("An unregistered source must be restored with --as-new");
    const host = await vmCapability();
    if (existing && host.clustered && existing.location !== host.member) throw new Error(`Restore ${instance} on ${existing.location}`);
    const restorePool = existing ? Object.values(existing.expanded_devices).find((device) => device.type === "disk" && device.path === "/")?.pool : pool;
    if (!restorePool) throw new Error("Existing instance has no root pool");
    const root = await physicalZfsRoot(restorePool);
    const staged = await stageBackupSet(config, manifests, selected, root);
    await finishRestore(staged, restorePool, root, selected.instance_type, instance, newName || instance, existing);
    return true;
  });
}
