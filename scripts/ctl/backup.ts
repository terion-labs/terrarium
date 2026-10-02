import { directoryHasEntries, restoreCommandRunners, prepareRootfsDirectoryForLxdRecover, mountRootfsDatasetForLxdRecover, type CommandRunner, type RestoreCommandRunners } from "../lib/recovery-rootfs";
export { prepareRootfsDirectoryForLxdRecover, mountRootfsDatasetForLxdRecover } from "../lib/recovery-rootfs";
import { rewriteBackupYaml } from "../lib/recovery-metadata";
export { rewriteRecoveredBackupMetadata, rewriteBackupYaml } from "../lib/recovery-metadata";
import { replicateBackupSets } from "./replicate";
import { restoreLocalSet, restoreS3Set } from "./restore-set";
import { physicalZfsRoot } from "../lib/lxd-storage";
import { loadBackupManifests, withBackupLock } from "../lib/s3-backup-sets";
import { confirm } from "@inquirer/prompts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { heading, label, requireConfig, success, value } from "./context";
import { configBoolean, configString, normalizeS3Endpoint, runAllowFailure, runInteractive, runText } from "../lib/common";
import { backupExportCmd } from "../terrarium-s3-export";
import { reconstructFromS3 } from "../terrarium-zfs-reconstruct";
import { PREFIX } from "./context";

/**
 * Lists local ZFS restore points and remote S3 manifests for the active host.
 *
 * The output stays intentionally raw and grep-friendly because this command is
 * often used as a quick operator inspection tool before a restore.
 */
export async function backupListCmd(): Promise<void> {
  const config = requireConfig();
  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
  const bucket = configString(config, "terrarium_s3_bucket");
  const prefix = configString(config, "terrarium_s3_prefix", "terrarium");
  const endpoint = normalizeS3Endpoint(configString(config, "terrarium_s3_endpoint"));
  const awsEnv: Record<string, string> = {};
  const accessKey = configString(config, "terrarium_s3_access_key");
  const secretKey = configString(config, "terrarium_s3_secret_key");
  const region = configString(config, "terrarium_s3_region", "us-east-1");
  if (accessKey) awsEnv.AWS_ACCESS_KEY_ID = accessKey;
  if (secretKey) awsEnv.AWS_SECRET_ACCESS_KEY = secretKey;
  if (region) awsEnv.AWS_DEFAULT_REGION = region;
  awsEnv.AWS_EC2_METADATA_DISABLED = "true";
  const awsBase = ["aws"];
  if (endpoint) {
    awsBase.push("--endpoint-url", endpoint);
  }

  const root = await physicalZfsRoot(pool);
  console.log(heading("Local ZFS snapshots"));
  const snapshotsRaw = await runAllowFailure(["zfs", "list", "-H", "-t", "snapshot", "-o", "name", "-s", "creation"]);
  const snapshots = snapshotsRaw.stdout
    .split("\n")
    .filter((line) => line.startsWith(`${root}/containers/`) || line.startsWith(`${root}/virtual-machines/`))
    .filter(Boolean);
  if (snapshots.length > 0) {
    console.log(snapshots.join("\n"));
  }

  if (configBoolean(config, "terrarium_enable_s3") && bucket) {
    console.log(`\n${heading("S3 restore sets")}`);
    for (const manifest of await loadBackupManifests(config)) console.log(`${manifest.created_at} ${manifest.instance_type} ${manifest.id}`);
    console.log(`\n${heading("Legacy S3 manifests")}`);
    const output = (
      await runAllowFailure([...awsBase, "s3", "ls", `s3://${bucket}/${prefix}/manifests/`, "--recursive"], { env: awsEnv })
    ).stdout.trim();
    if (output) {
      console.log(output);
    }
  }
}

/** Prompts before destructive restore operations that overwrite current state. */
async function confirmDestructive(message: string): Promise<void> {
  const approved = await confirm({ message, default: false });
  if (!approved) {
    throw new Error("operation cancelled");
  }
}

async function stopInstanceForRestore(instance: string): Promise<void> {
  const stopped = await runAllowFailure(["lxc", "--project", "default", "stop", instance, "--timeout", "60"], { timeoutMs: 90_000 });
  if (stopped.exitCode !== 0 && !/already stopped/i.test(stopped.stderr + stopped.stdout)) throw new Error(`Could not gracefully stop ${instance}: ${stopped.stderr.trim()}`);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const info = await runAllowFailure(["lxc", "info", instance]);
    if (info.exitCode !== 0 || /Status:\s+STOPPED\b/.test(info.stdout)) {
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`timed out waiting for ${instance} to stop before restore`);
}

export async function assertNewRestoreTargetIsUnused(instance: string, targetDataset: string, runCommand: CommandRunner = runAllowFailure): Promise<void> {
  const instanceCheck = await runCommand(["lxc", "info", instance]);
  if (instanceCheck.exitCode === 0) {
    throw new Error(`restore target instance '${instance}' already exists; choose a different --as-new name`);
  }

  const datasetCheck = await runCommand(["zfs", "list", "-H", targetDataset]);
  if (datasetCheck.exitCode === 0) {
    throw new Error(`restore target dataset '${targetDataset}' already exists; choose a different --as-new name`);
  }
}

/**
 * Prints the explicit operator handoff for restore-as-new flows.
 *
 * Terrarium automates dataset reconstruction, but LXD still requires an
 * interactive `lxd recover` step to import the recovered volume as an instance.
 */
function printAsNewRecoveryNotice(pool: string, dataset: string, instanceName: string): void {
  console.log(`\n${heading("Manual LXD Import Required")}`);
  console.log("Terrarium restored the ZFS dataset and prepared its LXD recovery metadata.");
  console.log("LXD recovery is still interactive upstream, so Terrarium will drive you through that handoff and then verify the import.");
  console.log(`${label("Recovered dataset:")} ${value(dataset)}`);
  console.log(`${label("Target instance name:")} ${value(instanceName)}`);
  console.log(`${label("Next steps:")} 1) Terrarium will now start ${value("lxd recover")}`);
  console.log(`            2) Select storage pool ${value(pool)} when prompted`);
  console.log(`            3) Import the recovered volume as instance ${value(instanceName)}`);
  console.log(`            4) Terrarium verifies the import with ${value(`lxc info ${instanceName}`)}`);
}

/** Starts the upstream interactive LXD recovery flow after Terrarium has prepared the dataset. */
async function handOffToLxdRecover(): Promise<void> {
  console.log(`\n${label("Starting:")} ${value("lxd recover")}`);
  await runInteractive(["lxd", "recover"], PREFIX);
}

function lxdStorageRoot(pool: string): string {
  for (const root of ["/var/snap/lxd/common/lxd/storage-pools", "/var/lib/lxd/storage-pools"]) {
    const path = join(root, pool);
    if (existsSync(path)) {
      return path;
    }
  }
  return join("/var/snap/lxd/common/lxd/storage-pools", pool);
}

async function prepareDatasetForLxdRecover(pool: string, targetDataset: string, oldName: string, newName: string): Promise<string> {
  const mountPath = join(lxdStorageRoot(pool), "containers", newName);
  const rootfsPath = join(mountPath, "rootfs");
  const rootfsDataset = `${targetDataset}/rootfs`;
  await runText(["mkdir", "-p", mountPath], PREFIX);
  await runAllowFailure(["zfs", "unmount", targetDataset]);
  await runText(["zfs", "set", `mountpoint=${mountPath}`, targetDataset], PREFIX);
  const mount = await runAllowFailure(["zfs", "mount", targetDataset]);
  if (mount.exitCode !== 0 && !`${mount.stderr}\n${mount.stdout}`.toLowerCase().includes("already mounted")) {
    throw new Error(`failed to mount recovered dataset at ${mountPath}: ${mount.stderr.trim() || mount.stdout.trim()}`);
  }
  const hasRootfsDataset = await zfsDatasetExists(rootfsDataset);
  if (hasRootfsDataset) {
    await mountRootfsDatasetForLxdRecover(rootfsDataset, rootfsPath);
  }
  rewriteBackupYaml(mountPath, oldName, newName);
  if (!hasRootfsDataset) {
    prepareRootfsDirectoryForLxdRecover(mountPath);
  }
  return mountPath;
}

async function mountRecoveredDataset(targetDataset: string, mountPath: string): Promise<void> {
  const rootfsPath = join(mountPath, "rootfs");
  const rootfsDataset = `${targetDataset}/rootfs`;
  await runText(["mkdir", "-p", mountPath], PREFIX);
  await runText(["zfs", "set", `mountpoint=${mountPath}`, targetDataset], PREFIX);
  const mount = await runAllowFailure(["zfs", "mount", targetDataset]);
  if (mount.exitCode !== 0 && !`${mount.stderr}\n${mount.stdout}`.toLowerCase().includes("already mounted")) {
    throw new Error(`failed to remount recovered dataset at ${mountPath}: ${mount.stderr.trim() || mount.stdout.trim()}`);
  }

  if (await zfsDatasetExists(rootfsDataset)) {
    await mountRootfsDatasetForLxdRecover(rootfsDataset, rootfsPath);
    return;
  }

  if (!directoryHasEntries(rootfsPath)) {
    const datasetState = await runAllowFailure(["zfs", "get", "-H", "-o", "property,value", "mounted,mountpoint,canmount", targetDataset]);
    throw new Error(
      [
        `recovered LXD dataset is mounted but missing rootfs contents at ${rootfsPath}`,
        datasetState.stdout.trim() ? `zfs state:\n${datasetState.stdout.trim()}` : "",
        datasetState.stderr.trim() ? `zfs stderr:\n${datasetState.stderr.trim()}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }
}

async function zfsDatasetExists(dataset: string, runCommand: CommandRunner = runAllowFailure): Promise<boolean> {
  return (await runCommand(["zfs", "list", "-H", dataset])).exitCode === 0;
}

async function zfsSnapshotExists(snapshot: string, runCommand: CommandRunner = runAllowFailure): Promise<boolean> {
  return (await runCommand(["zfs", "list", "-H", "-t", "snapshot", snapshot])).exitCode === 0;
}

export function rollbackSnapshotsForDatasetTree(snapshot: string, availableSnapshots: string[]): string[] {
  const snapshotMarker = snapshot.indexOf("@");
  if (snapshotMarker === -1) {
    throw new Error(`invalid ZFS snapshot name: ${snapshot}`);
  }

  const dataset = snapshot.slice(0, snapshotMarker);
  const snapshotSuffix = snapshot.slice(snapshotMarker);
  const descendants = availableSnapshots
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${dataset}/`) && item.endsWith(snapshotSuffix))
    .sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left));

  return [...descendants, snapshot];
}

export async function cloneRootfsSnapshotIfPresent(
  sourceDataset: string,
  snapshot: string,
  targetDataset: string,
  targetMountPath: string,
  runners: RestoreCommandRunners = {}
): Promise<boolean> {
  const snapshotMarker = snapshot.indexOf("@");
  if (snapshotMarker === -1) {
    throw new Error(`invalid ZFS snapshot name: ${snapshot}`);
  }

  const { run, runRequired } = restoreCommandRunners(runners);
  const childSnapshot = `${sourceDataset}/rootfs${snapshot.slice(snapshotMarker)}`;
  if (!(await zfsSnapshotExists(childSnapshot, run))) {
    return false;
  }

  const rootfsDataset = `${targetDataset}/rootfs`;
  const rootfsPath = join(targetMountPath, "rootfs");
  await runRequired(["zfs", "clone", "-o", `mountpoint=${rootfsPath}`, childSnapshot, rootfsDataset]);
  console.log(success(`Cloned rootfs snapshot ${childSnapshot} to ${rootfsDataset}`));
  return true;
}

async function recoverAsNewInstance(pool: string, sourceName: string, targetDataset: string, newName: string): Promise<void> {
  const mountPath = await prepareDatasetForLxdRecover(pool, targetDataset, sourceName, newName);
  console.log(`${label("Prepared mount:")} ${value(mountPath)}`);
  printAsNewRecoveryNotice(pool, targetDataset, newName);
  await handOffToLxdRecover();
  await mountRecoveredDataset(targetDataset, mountPath);
  const imported = await runAllowFailure(["lxc", "info", newName]);
  if (imported.exitCode !== 0) {
    const volumes = await runAllowFailure(["lxc", "storage", "volume", "list", pool]);
    const datasets = await runAllowFailure(["zfs", "list", "-H", "-o", "name,mountpoint", targetDataset]);
    throw new Error(
      [
        `LXD recovery completed but instance '${newName}' was not imported.`,
        volumes.stdout.trim() ? `storage volumes:\n${volumes.stdout.trim()}` : "",
        datasets.stdout.trim() ? `dataset:\n${datasets.stdout.trim()}` : "",
        imported.stderr.trim() ? `lxc info stderr:\n${imported.stderr.trim()}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }
}

/** Restores an S3-backed dataset chain either in-place or into a new importable dataset. */
async function restoreS3(
  instance: string,
  at: string,
  mode: "in-place" | "as-new",
  newName: string,
  pool: string
): Promise<void> {
  const root = await physicalZfsRoot(pool);
  const target = mode === "in-place" ? `${root}/containers/${instance}` : `${root}/containers/${newName}`;
  if (mode === "in-place") {
    await confirmDestructive(`Reconstruct ${instance} in place into ${target}?`);
  } else if (!newName) {
    throw new Error("--as-new requires a target name");
  }

  if (mode === "as-new") {
    await assertNewRestoreTargetIsUnused(newName, target);
  }

  await reconstructFromS3(instance, at, target, undefined, mode === "in-place" ? () => stopInstanceForRestore(instance) : undefined);
  if (mode === "in-place") await mountRecoveredDataset(target, join(lxdStorageRoot(pool), "containers", instance));
  if (mode === "in-place") {
    console.log(success(`Reconstructed dataset for ${instance} into ${target}`));
    console.log(`${label("Next:")} ${value(`lxc start ${instance}`)}`);
  } else {
    console.log(success(`Reconstructed dataset into ${target}`));
    await recoverAsNewInstance(pool, instance, target, newName);
  }
}

/**
 * Dispatches the Terrarium backup command family.
 *
 * This keeps the main CLI registration thin while preserving a single backup
 * command surface for list/export/restore.
 */
export async function backupActionCmd(
  action: string,
  options: { source?: string; instance?: string; at?: string; asNew?: string }
): Promise<void> {
  if (action === "list") {
    await backupListCmd();
    return;
  }

  if (action === "replicate") {
    await replicateBackupSets(requireConfig());
    return;
  }

  if (action === "export") {
    await backupExportCmd();
    return;
  }

  if (action !== "restore") {
    throw new Error(`unsupported backup action: ${action}`);
  }

  const source = options.source || "local";
  const instance = options.instance;
  const at = options.at || "";
  const newName = options.asNew ?? "";
  if (!instance) {
    throw new Error("backup restore requires --instance; --source defaults to local, --at defaults to the latest restore point, and --as-new is optional");
  }
  for (const name of [instance, newName].filter(Boolean)) if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)) throw new Error(`Invalid LXD instance name: ${name}`);

  const config = requireConfig();
  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
  const mode = newName ? "as-new" : "in-place";

  if (source === "local") {
    await restoreLocalSet(instance, at, newName, pool);
    return;
  }
  if (source === "s3") {
    if (!(await restoreS3Set(config, instance, at, newName, pool))) await withBackupLock(() => restoreS3(instance, at, mode, newName, pool));
    return;
  }

  throw new Error(`unsupported restore source: ${source}`);
}
