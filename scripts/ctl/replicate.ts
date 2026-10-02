import { configString, shellEscape, runAllowFailure } from "../lib/common";
import { isInfrastructureInstance, listInstances, vmCapability } from "../lib/lxd-instance";
import { checkedCommand, instanceStorage, selectCompleteSnapshot, withSnapshotHolds } from "../lib/lxd-storage";
import { withBackupLock } from "../lib/s3-backup-sets";

export async function replicateBackupSets(config: Record<string, unknown>): Promise<void> {
  const target = configString(config, "terrarium_syncoid_target");
  const containerRoot = configString(config, "terrarium_syncoid_target_dataset");
  const vmRoot = `${containerRoot}-virtual-machines`;
  const key = configString(config, "terrarium_syncoid_ssh_key");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/.test(target) || !/^[a-zA-Z][a-zA-Z0-9_./-]*$/.test(containerRoot) || !key) throw new Error("Configure a valid Syncoid host, target dataset and SSH key first");
  const remote = (args: string[]) => checkedCommand(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-i", key, target, args.map(shellEscape).join(" ")]);
  await withBackupLock(async () => {
    const host = await vmCapability();
    const rows = await checkedCommand(["zfs", "list", "-H", "-p", "-t", "snapshot", "-o", "name,guid,createtxg,org.terrarium:source-txg", "-s", "creation"]);
    const errors: string[] = [];
    for (const instance of await listInstances()) {
      if (isInfrastructureInstance(instance) || instance.config["user.terrarium.role"] === "image-staging" || instance.config["user.terrarium.quarantined-nics"] || host.clustered && instance.location !== host.member) continue;
      try {
        const storage = await instanceStorage(instance);
        const suffixes = rows.split("\n").map((line) => line.split(/\s+/)[0]!).filter((snapshot) => snapshot.startsWith(`${storage.components[0]!.dataset}@`)).map((snapshot) => snapshot.split("@")[1]!);
        const sets = suffixes.map((suffix) => selectCompleteSnapshot(storage.components, rows, `@${suffix}`)).filter((set) => set.length);
        if (!sets.length) continue;
        const latest = sets.at(-1)!;
        const root = instance.type === "virtual-machine" ? vmRoot : containerRoot;
        await remote(["sh", "-ec", `zfs list -H ${shellEscape(root)} >/dev/null 2>&1 || zfs create -p -o mountpoint=none ${shellEscape(root)}`]);
        await withSnapshotHolds(sets.flatMap((set) => set.map((part) => part.snapshot)), async () => {
          for (const component of storage.components) {
            const destination = `${root}/${instance.name}${component.role === "block" ? ".block" : ""}`;
            const existing = await runAllowFailure(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-i", key, target, ["zfs", "list", "-H", destination].map(shellEscape).join(" ")]);
            if (existing.exitCode === 0) {
              const remoteGuids = new Set((await remote(["zfs", "list", "-H", "-p", "-t", "snapshot", "-o", "guid", "-r", destination])).trim().split("\n"));
              if (!sets.some((set) => set.some((part) => part.role === component.role && remoteGuids.has(part.guid)))) throw new Error(`${destination}: existing replica has no common snapshot; refusing to replace unrelated history`);
            } else if (!/dataset does not exist/.test(existing.stderr)) throw new Error(`Could not inspect ${destination}: ${existing.stderr.trim()}`);
            // Packaged Syncoid 2.2 has no snapshot-name filter. Transfer existing
            // history, then mark only verified atomic pairs as recoverable sets.
            await checkedCommand(["syncoid", "--recursive", "--no-sync-snap", "--no-clone-handling", "--no-rollback", "--recvoptions=u", `--sshkey=${key}`, component.dataset, `${target}:${destination}`]);
            const snapshot = latest.find((part) => part.role === component.role)!;
            const guid = (await remote(["zfs", "get", "-H", "-p", "-o", "value", "guid", `${destination}@${snapshot.snapshot.split("@")[1]}`])).trim();
            if (guid !== snapshot.guid) throw new Error(`${destination}: replica GUID does not match the source`);
          }
          for (const set of sets) {
            for (const snapshot of set) {
              const destination = `${root}/${instance.name}${snapshot.role === "block" ? ".block" : ""}@${snapshot.snapshot.split("@")[1]}`;
              const guid = (await remote(["zfs", "get", "-H", "-p", "-o", "value", "guid", destination])).trim();
              if (guid !== snapshot.guid) throw new Error(`${destination}: replica snapshot identity mismatch`);
            }
            for (const snapshot of set) await remote(["zfs", "set", `org.terrarium:source-txg=${snapshot.txg}`, `${root}/${instance.name}${snapshot.role === "block" ? ".block" : ""}@${snapshot.snapshot.split("@")[1]}`]);
          }
        });
        console.log(`Replicated ${instance.name} (${instance.type}): complete set ${latest[0]!.snapshot.split("@")[1]}`);
      } catch (error) { errors.push(`${instance.name}: ${error}`); }
    }
    if (errors.length) throw new Error(errors.join("\n"));
  });
}
