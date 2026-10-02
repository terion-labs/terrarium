import { exportBackupSets } from "./lib/s3-backup-sets";
import { configBoolean, configString, loadConfig, shellEscape } from "./lib/common";

const PREFIX = "terrariumctl backup export";
const DEFAULT_CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";
const S3_SNAPSHOT_STATE_FORMAT = "zfs-recursive-v1";
export function chooseLatestExportSnapshot(snapshotNames: string[], dataset: string): string {
  let latest = "";
  for (const snapshot of snapshotNames) {
    const trimmed = snapshot.trim();
    if (!trimmed.startsWith(`${dataset}@`)) {
      continue;
    }
    const snapshotName = trimmed.split("@").at(-1) ?? "";
    if (/(^|_)frequently$/.test(snapshotName)) {
      continue;
    }
    latest = trimmed;
  }
  return latest;
}

export function zfsReplicationSendCommand(latestSnapshot: string, parentSnapshot = ""): string {
  if (parentSnapshot) {
    return `zfs send -R -I ${shellEscape(parentSnapshot)} ${shellEscape(latestSnapshot)}`;
  }
  return `zfs send -R ${shellEscape(latestSnapshot)}`;
}

export function planS3SnapshotExport(
  latestSnapshot: string,
  lastSnapshot: string,
  stateFormat: string,
  parentSnapshotExists: boolean
): { skip: boolean; parentSnapshot: string; full: boolean } {
  const recursiveState = stateFormat === S3_SNAPSHOT_STATE_FORMAT;
  if (recursiveState && lastSnapshot === latestSnapshot) {
    return { skip: true, parentSnapshot: "", full: false };
  }

  const parentSnapshot = recursiveState && lastSnapshot && parentSnapshotExists ? lastSnapshot : "";
  return { skip: false, parentSnapshot, full: !parentSnapshot };
}

export function isRetriableS3ExportError(message: string): boolean {
  const lowered = message.toLowerCase();
  return [
    "gatewaytimeout",
    "gateway timeout",
    "uploadpart",
    "requesttimeout",
    "request timeout",
    "slowdown",
    "service unavailable",
    "connection reset",
    "connection broken",
    "connection aborted",
    "timeout",
    "timed out",
    "503",
    "504"
  ].some((needle) => lowered.includes(needle));
}

export async function backupExportCmd(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const config = loadConfig(configPath, PREFIX);
  if (!configBoolean(config, "terrarium_enable_s3")) {
    return;
  }

  const bucket = configString(config, "terrarium_s3_bucket");
  if (!bucket) {
    return;
  }

  await exportBackupSets(config);
}
