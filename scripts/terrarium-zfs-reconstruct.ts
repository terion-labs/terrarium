import { randomUUID } from "node:crypto";
import { checkedCommand } from "./lib/lxd-storage";
import { promoteBackupSet } from "./lib/s3-backup-sets";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  configString,
  loadConfig,
  makeTempDir,
  normalizeS3Endpoint,
  readJsonFile,
  removePath,
  runAllowFailure,
  runText,
  shellEscape
} from "./lib/common";

const PREFIX = "terrariumctl backup reconstruct";
const DEFAULT_CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";
const S3_RESTORE_ATTEMPTS = 3;
const S3_RESTORE_RETRY_MS = 5000;
const ZFS_DESTROY_ATTEMPTS = 5;
const ZFS_DESTROY_RETRY_MS = 2000;

type Manifest = {
  snapshot: string;
  parent_snapshot?: string;
  object_key: string;
  created_at: string;
};

function s3Env(config: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  const accessKey = configString(config, "terrarium_s3_access_key");
  const secretKey = configString(config, "terrarium_s3_secret_key");
  const region = configString(config, "terrarium_s3_region", "us-east-1");
  if (accessKey) env.AWS_ACCESS_KEY_ID = accessKey;
  if (secretKey) env.AWS_SECRET_ACCESS_KEY = secretKey;
  if (region) env.AWS_DEFAULT_REGION = region;
  env.AWS_EC2_METADATA_DISABLED = "true";
  return env;
}

function selectChain(directory: string, match = ""): Manifest[] {
  const manifests: Manifest[] = [];
  for (const entry of new Bun.Glob("*.json").scanSync(directory)) {
    manifests.push(readJsonFile<Manifest>(join(directory, entry), {} as Manifest));
  }
  return selectLegacyChain(manifests, match);
}

export function selectLegacyChain(manifests: Manifest[], match = ""): Manifest[] {
  const bySnapshot = new Map<string, Manifest>();
  for (const item of manifests) {
    if (typeof item.snapshot !== "string" || !item.snapshot.includes("/containers/") || !item.snapshot.includes("@") || typeof item.object_key !== "string" || !item.object_key || typeof item.created_at !== "string" || !Number.isFinite(Date.parse(item.created_at))) throw new Error("Invalid legacy container backup manifest");
    if (item.parent_snapshot && typeof item.parent_snapshot !== "string") throw new Error("Invalid legacy backup parent");
    if (bySnapshot.has(item.snapshot)) throw new Error(`Duplicate legacy backup snapshot ${item.snapshot}`);
    bySnapshot.set(item.snapshot, item);
  }
  const selected = manifests.filter((item) => !match || item.snapshot.includes(match) || item.created_at.includes(match)).sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
  if (!selected) throw new Error("no matching manifest chain found");
  const chain: Manifest[] = [];
  const seen = new Set<string>();
  let current: Manifest | undefined = selected;
  while (current) {
    if (seen.has(current.snapshot)) throw new Error("Legacy backup chain contains a cycle");
    if (current.snapshot.split("@")[0] !== selected.snapshot.split("@")[0]) throw new Error("Legacy backup chain crosses source datasets");
    seen.add(current.snapshot);
    chain.push(current);
    if (!current.parent_snapshot) break;
    const parent = bySnapshot.get(current.parent_snapshot);
    if (!parent) throw new Error(`Legacy backup chain is missing parent ${current.parent_snapshot}`);
    current = parent;
  }
  return chain.reverse();
}

export function isRetriableS3RestoreError(message: string): boolean {
  const lowered = message.toLowerCase();
  return [
    "incompleteread",
    "incomplete stream",
    "premature end",
    "connection broken",
    "connection reset",
    "read error",
    "broken pipe",
    "timeout",
    "timed out",
    "slowdown",
    "http 503",
    "http 504",
    "service unavailable",
    "gateway timeout"
  ].some((needle) => lowered.includes(needle));
}

export function isRetriableZfsDestroyError(message: string): boolean {
  const lowered = message.toLowerCase();
  return ["dataset is busy", "device or resource busy", "target is busy", "filesystem is busy"].some((needle) => lowered.includes(needle));
}

function formatPipelineFailure(result: Awaited<ReturnType<typeof runAllowFailure>>): string {
  const parts = [`exit code ${result.exitCode}`];
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) {
    parts.push(`stdout:\n${stdout}`);
  }
  if (stderr) {
    parts.push(`stderr:\n${stderr}`);
  }
  return parts.join("\n\n");
}

async function destroyDatasetIfExists(targetDataset: string): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= ZFS_DESTROY_ATTEMPTS; attempt += 1) {
    const datasetCheck = await runAllowFailure(["zfs", "list", "-H", targetDataset]);
    if (datasetCheck.exitCode !== 0) {
      return;
    }

    await unmountDatasetsUnder(targetDataset);
    const destroy = await runAllowFailure(["zfs", "destroy", "-r", "-f", targetDataset]);
    if (destroy.exitCode === 0) {
      return;
    }

    lastError = formatPipelineFailure(destroy);
    if (attempt >= ZFS_DESTROY_ATTEMPTS || !isRetriableZfsDestroyError(lastError)) {
      throw new Error(lastError);
    }
    console.warn(`${PREFIX}: target dataset was busy on destroy attempt ${attempt}; retrying: ${lastError}`);
    await Bun.sleep(ZFS_DESTROY_RETRY_MS);
  }

  throw new Error(lastError || `failed to destroy ${targetDataset}`);
}

async function unmountDatasetsUnder(targetDataset: string): Promise<void> {
  const result = await runAllowFailure(["zfs", "list", "-H", "-r", "-o", "name,mounted", targetDataset]);
  if (result.exitCode !== 0) {
    return;
  }

  const mountedDatasets = result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 2 && columns[1] === "yes")
    .map((columns) => columns[0] as string)
    .sort((left, right) => right.length - left.length);

  for (const dataset of mountedDatasets) {
    await runAllowFailure(["zfs", "unmount", "-f", dataset]);
  }
}

async function receiveS3Chain(
  chain: Manifest[],
  awsBase: string[],
  bucket: string,
  targetDataset: string,
  awsEnv: Record<string, string>
): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= S3_RESTORE_ATTEMPTS; attempt += 1) {
    await destroyDatasetIfExists(targetDataset);

    try {
      for (const manifest of chain) {
        const command = `set -o pipefail; ${awsBase.map(shellEscape).join(" ")} s3 cp ${shellEscape(`s3://${bucket}/${manifest.object_key}`)} - | zstd -d | zfs receive -u -F -o mountpoint=none ${shellEscape(targetDataset)}`;
        const result = await runAllowFailure(["bash", "-lc", command], { env: awsEnv });
        if (result.exitCode !== 0) {
          throw new Error(formatPipelineFailure(result));
        }
      }
      return;
    } catch (error) {
      lastError = String(error).replace(/^Error: /, "");
      if (attempt >= S3_RESTORE_ATTEMPTS || !isRetriableS3RestoreError(lastError)) {
        throw new Error(lastError);
      }
      console.warn(`${PREFIX}: S3 restore stream failed on attempt ${attempt}; retrying: ${lastError}`);
      await Bun.sleep(S3_RESTORE_RETRY_MS);
    }
  }

  throw new Error(lastError || "S3 restore failed");
}

export async function reconstructFromS3(instance: string, at: string, targetDataset: string, configPath = DEFAULT_CONFIG_PATH, beforePromote?: () => Promise<void>): Promise<void> {
  const config = loadConfig(configPath, PREFIX);
  const bucket = configString(config, "terrarium_s3_bucket");
  const endpoint = normalizeS3Endpoint(configString(config, "terrarium_s3_endpoint"));
  const prefix = configString(config, "terrarium_s3_prefix", "terrarium");
  const awsEnv = s3Env(config);
  const awsBase = ["aws"];
  if (endpoint) {
    awsBase.push("--endpoint-url", endpoint);
  }

  const tempDir = makeTempDir("terrarium-restore.");
  try {
    await checkedCommand([...awsBase, "s3", "cp", `s3://${bucket}/${prefix}/manifests/${instance}/`, `${tempDir}/`, "--recursive"], {
      env: awsEnv
    });
    const chain = selectChain(tempDir, at);

    const marker = targetDataset.indexOf("/containers/");
    if (marker < 1) throw new Error("Legacy restore target must be a container dataset");
    const stagingRoot = `${targetDataset.slice(0, marker)}/terrarium-restore-${randomUUID()}`;
    const stagingDataset = `${stagingRoot}/filesystem`;
    await checkedCommand(["zfs", "create", "-o", "mountpoint=none", stagingRoot]);
    try {
      await receiveS3Chain(chain, awsBase, bucket, stagingDataset, awsEnv);
      await beforePromote?.();
      await promoteBackupSet({ stagingRoot, components: [{ role: "filesystem", dataset: stagingDataset }] }, [{ role: "filesystem", dataset: targetDataset }], !!beforePromote);
    } catch (error) {
      throw new Error(`${error}; legacy restore staging retained at ${stagingRoot}`);
    }
  } finally {
    if (existsSync(tempDir)) {
      removePath(tempDir);
    }
  }
}
