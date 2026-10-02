import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { configString, normalizeS3Endpoint, runAllowFailure, shellEscape, writeIfChanged } from "./common";
import { isInfrastructureInstance, listInstances, vmCapability, lxcCommand } from "./lxd-instance";
import { checkedCommand, completeSnapshot, instanceStorage, withSnapshotHolds, withIndependentFullStream, type StorageComponent } from "./lxd-storage";
import { backupChain, parseBackupManifest, selectBackup, type BackupManifest, type BackupComponent } from "./backup-manifest";

const STATE = process.env.TERRARIUM_STATE_DIR ?? "/var/lib/terrarium";

export function s3Connection(config: Record<string, unknown>): { args: string[]; env: Record<string, string>; bucket: string; prefix: string } {
  const endpoint = normalizeS3Endpoint(configString(config, "terrarium_s3_endpoint"));
  const bucket = configString(config, "terrarium_s3_bucket");
  if (!bucket) throw new Error("S3 bucket is not configured");
  const env: Record<string, string> = { AWS_EC2_METADATA_DISABLED: "true", AWS_RETRY_MODE: "standard", AWS_MAX_ATTEMPTS: "5", AWS_DEFAULT_REGION: configString(config, "terrarium_s3_region", "us-east-1") };
  const key = configString(config, "terrarium_s3_access_key");
  const secret = configString(config, "terrarium_s3_secret_key");
  if (key) env.AWS_ACCESS_KEY_ID = key;
  if (secret) env.AWS_SECRET_ACCESS_KEY = secret;
  return { args: ["aws", ...(endpoint ? ["--endpoint-url", endpoint] : [])], env, bucket, prefix: configString(config, "terrarium_s3_prefix", "terrarium").replace(/\/+$/, "") };
}

/** Kernel-owned lock: a killed backup process cannot leave a stale userspace lock behind. */
export async function withBackupLock<T>(work: () => Promise<T>): Promise<T> {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const child = Bun.spawn(["flock", "--nonblock", join(STATE, "backup.lock"), "sh", "-c", "printf 'locked\\n'; cat >/dev/null"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  const acquired = await reader.read();
  reader.releaseLock();
  if (acquired.done || new TextDecoder().decode(acquired.value).trim() !== "locked") {
    child.stdin.end();
    await child.exited;
    throw new Error("Another Terrarium backup or restore is running");
  }
  try { return await work(); } finally { child.stdin.end(); await child.exited; }
}

async function checksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function privateWorkDirectory(): string {
  const root = join(STATE, "backup-spool");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(root, "transfer-"));
}

export async function exportBackupSets(config: Record<string, unknown>): Promise<void> {
  await withBackupLock(async () => {
    const s3 = s3Connection(config);
    const installationPath = join(STATE, "backup-installation-id");
    if (!existsSync(installationPath)) writeFileSync(installationPath, `${randomUUID()}\n`, { mode: 0o600, flag: "wx" });
    const localInstallation = readFileSync(installationPath, "utf8").trim();
    const host = await vmCapability();
    let catalog: BackupManifest[] | undefined;
    const errors: string[] = [];
    for (const instance of await listInstances()) {
      if (isInfrastructureInstance(instance) || instance.config["user.terrarium.role"] === "image-staging" || instance.config["user.terrarium.quarantined-nics"] || host.clustered && instance.location !== host.member) continue;
      try {
        const storage = await instanceStorage(instance);
        const snapshots = await completeSnapshot(storage, "", true);
        if (!snapshots.length) {
          console.warn(`${instance.name}: no complete exportable snapshot set`);
          continue;
        }
        const uuid = instance.config["volatile.uuid"];
        if (!uuid) throw new Error(`${instance.name}: LXD instance UUID is missing; cannot establish backup provenance`);
        // LXD carries this origin with the instance across cluster members.
        const installation = instance.config["user.terrarium.backup-origin"] || localInstallation;
        if (!instance.config["user.terrarium.backup-origin"]) await lxcCommand(["config", "set", instance.name, `user.terrarium.backup-origin=${installation}`]);
        const suffix = snapshots[0]!.snapshot.split("@")[1]!;
        const identity = `${installation}/default/${instance.name}/${uuid}`;
        const id = `${identity}/${suffix}`;
        const statePath = join(STATE, "backup-v2", identity, "last.json");
        let parent = existsSync(statePath) ? parseBackupManifest(JSON.parse(readFileSync(statePath, "utf8"))) : undefined;
        if (!parent) {
          catalog ??= await loadBackupManifests(config);
          parent = selectBackup(catalog.filter((item) => item.installation === installation), instance.name, "", uuid);
        }
        if (parent) {
          const remote = await runAllowFailure([...s3.args, "s3api", "head-object", "--bucket", s3.bucket, "--key", `${s3.prefix}/manifests-v2/${parent.id}.json`], { env: s3.env });
          if (remote.exitCode !== 0) {
            if (/404|Not Found|NoSuchKey/.test(remote.stderr)) parent = undefined;
            else throw new Error(`Could not verify parent manifest: ${remote.stderr.trim()}`);
          }
        }
        if (parent?.id === id) {
          if (snapshots.every((part) => parent!.components.some((previous) => previous.role === part.role && previous.dataset === part.dataset && previous.guid === part.guid))) continue;
          throw new Error(`Snapshot name ${suffix} was reused with different contents; create a uniquely named snapshot before exporting`);
        }
        if (parent) {
          for (const part of parent.components) {
            const guid = await runAllowFailure(["zfs", "get", "-H", "-p", "-o", "value", "guid", part.snapshot]);
            if (guid.exitCode !== 0 || guid.stdout.trim() !== part.guid || !snapshots.some((item) => item.dataset === part.dataset)) { parent = undefined; break; }
          }
        }
        await withSnapshotHolds([...snapshots.map((part) => part.snapshot), ...(parent?.components.map((part) => part.snapshot) ?? [])], async () => {
          const work = privateWorkDirectory();
          try {
            const components: BackupComponent[] = [];
            for (const snapshot of snapshots) {
              const file = join(work, `${snapshot.role}.zfs.zst`);
              const base = parent?.components.find((part) => part.role === snapshot.role);
              const saveStream = async (send: string[]) => { await checkedCommand(["bash", "-c", `set -o pipefail; ${send.map(shellEscape).join(" ")} | zstd -T0 -q > ${shellEscape(file)}`]); };
              if (base) await saveStream(["zfs", "send", instance.type === "virtual-machine" ? "-p" : "-R", "-I", base.snapshot, snapshot.snapshot]);
              else await withIndependentFullStream(snapshot, storage.root, saveStream);
              const part = { ...snapshot, object_key: `${s3.prefix}/streams-v2/${id}/${snapshot.role}.zfs.zst`, sha256: await checksum(file), bytes: statSync(file).size };
              await checkedCommand([...s3.args, "s3", "cp", file, `s3://${s3.bucket}/${part.object_key}`, "--only-show-errors"], { env: s3.env });
              components.push(part);
              rmSync(file);
            }
            const manifest = parseBackupManifest({ version: 2, id, installation, project: "default", instance: instance.name, instance_uuid: uuid, instance_type: instance.type, architecture: instance.architecture, pool: storage.pool, snapshot: suffix, created_at: new Date().toISOString(), parent: parent?.id ?? null, components });
            const manifestFile = join(work, "manifest.json");
            const json = `${JSON.stringify(manifest, null, 2)}\n`;
            writeFileSync(manifestFile, json, { mode: 0o600 });
            await checkedCommand([...s3.args, "s3", "cp", manifestFile, `s3://${s3.bucket}/${s3.prefix}/manifests-v2/${id}.json`, "--only-show-errors"], { env: s3.env });
            writeIfChanged(statePath, json, { mode: 0o600, directoryMode: 0o700 });
            console.log(`Exported ${instance.name} (${instance.type}) at ${suffix}: ${components.length} verified components`);
          } finally { rmSync(work, { recursive: true, force: true }); }
        });
      } catch (error) { errors.push(`${instance.name}: ${String(error).replace(/^Error: /, "")}`); }
    }
    if (errors.length) throw new Error(errors.join("\n"));
  });
}

export async function loadBackupManifests(config: Record<string, unknown>): Promise<BackupManifest[]> {
  const s3 = s3Connection(config);
  const work = privateWorkDirectory();
  try {
    await checkedCommand([...s3.args, "s3", "cp", `s3://${s3.bucket}/${s3.prefix}/manifests-v2/`, `${work}/`, "--recursive", "--only-show-errors"], { env: s3.env });
    return [...new Bun.Glob("**/*.json").scanSync(work)].map((path) => parseBackupManifest(JSON.parse(readFileSync(join(work, path), "utf8"))));
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export type StagedBackup = { manifest: BackupManifest; components: StorageComponent[]; stagingRoot: string };

/** Receive into a private ZFS tree; the live destination is never touched by download/retry failures. */
export async function stageBackupSet(config: Record<string, unknown>, manifests: BackupManifest[], selected: BackupManifest, root: string): Promise<StagedBackup> {
  const chain = backupChain(manifests, selected);
  const s3 = s3Connection(config);
  const work = privateWorkDirectory();
  const stagingRoot = `${root}/terrarium-restore-${randomUUID()}`;
  await checkedCommand(["zfs", "create", "-o", "mountpoint=none", stagingRoot]);
  const components = selected.components.map((part) => ({ role: part.role, dataset: `${stagingRoot}/${part.role}` }));
  try {
    for (const manifest of chain) {
      for (const component of manifest.components) {
        const file = join(work, "stream.zfs.zst");
        await checkedCommand([...s3.args, "s3", "cp", `s3://${s3.bucket}/${component.object_key}`, file, "--only-show-errors"], { env: s3.env });
        if (statSync(file).size !== component.bytes || await checksum(file) !== component.sha256) throw new Error(`${manifest.id}/${component.role}: downloaded stream checksum or size mismatch`);
        const dataset = components.find((part) => part.role === component.role)!.dataset;
        await checkedCommand(["bash", "-c", `set -o pipefail; zstd -d -q -c ${shellEscape(file)} | zfs receive -u -F ${component.role === "filesystem" ? "-o mountpoint=none " : ""}${shellEscape(dataset)}`]);
        const guid = (await checkedCommand(["zfs", "get", "-H", "-p", "-o", "value", "guid", `${dataset}@${manifest.snapshot}`])).trim();
        if (guid !== component.guid) throw new Error(`${dataset}: received snapshot GUID mismatch`);
        await checkedCommand(["zfs", "set", `org.terrarium:source-txg=${component.txg}`, `${dataset}@${manifest.snapshot}`]);
        rmSync(file);
      }
    }
    return { manifest: selected, components, stagingRoot };
  } catch (error) {
    await runAllowFailure(["zfs", "destroy", "-r", stagingRoot]);
    throw error;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** Keep originals until every sibling is installed. Failed promotion reverses completed renames. */
export async function promoteBackupSet(staged: Pick<StagedBackup, "components" | "stagingRoot">, targets: StorageComponent[], replace: boolean): Promise<void> {
  const movedOld: { from: string; to: string; role: StorageComponent["role"] }[] = [];
  const movedNew: { from: string; to: string; role: StorageComponent["role"] }[] = [];
  const token = randomUUID();
  try {
    // ZVOL device names can remain cached across a rename. Let LXD activate the
    // received volume under its final name instead of importing a stale device.
    for (const source of staged.components) if (source.role === "block") await checkedCommand(["zfs", "set", "volmode=none", source.dataset]);
    for (const target of targets) {
      const exists = (await runAllowFailure(["zfs", "list", "-H", target.dataset])).exitCode === 0;
      if (exists && !replace) throw new Error(`Restore target ${target.dataset} already exists`);
      if (exists) {
        if (target.role === "block") await checkedCommand(["zfs", "set", "volmode=none", target.dataset]);
        const previous = `${staged.stagingRoot}/previous-${target.role}-${token}`;
        await checkedCommand(["zfs", "rename", ...(target.role === "filesystem" ? ["-u"] : []), target.dataset, previous]);
        movedOld.push({ from: previous, to: target.dataset, role: target.role });
      }
    }
    for (const target of targets) {
      const source = staged.components.find((part) => part.role === target.role);
      if (!source) throw new Error(`Restore is missing ${target.role}`);
      await checkedCommand(["zfs", "rename", ...(target.role === "filesystem" ? ["-u"] : []), source.dataset, target.dataset]);
      movedNew.push({ from: target.dataset, to: source.dataset, role: target.role });
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const move of [...movedNew.reverse(), ...movedOld.reverse()]) {
      const result = await runAllowFailure(["zfs", "rename", ...(move.role === "filesystem" ? ["-u"] : []), move.from, move.to]);
      if (result.exitCode !== 0) rollbackErrors.push(`${move.from} → ${move.to}: ${result.stderr.trim()}`);
    }
    throw new Error(`${error}${rollbackErrors.length ? `; rollback needs attention: ${rollbackErrors.join("; ")}` : ""}; staging retained at ${staged.stagingRoot}`);
  }
  if (movedOld.length) console.log(`Previous datasets retained at ${staged.stagingRoot}; remove after verifying the restored guest`);
  else await checkedCommand(["zfs", "destroy", staged.stagingRoot]);
}
