import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runAllowFailure } from "./common";
import { checkedCommand } from "./lxd-storage";

export type CommandRunner = typeof runAllowFailure;
type RunRequiredCommand = (cmd: string[]) => Promise<string>;
export type RestoreCommandRunners = {
  run?: CommandRunner;
  runRequired?: RunRequiredCommand;
  directoryHasEntries?: (path: string) => boolean;
};

export function restoreCommandRunners(runners: RestoreCommandRunners): {
  run: CommandRunner;
  runRequired: RunRequiredCommand;
  directoryHasEntries: (path: string) => boolean;
} {
  return {
    run: runners.run ?? runAllowFailure,
    runRequired: runners.runRequired ?? checkedCommand,
    directoryHasEntries: runners.directoryHasEntries ?? directoryHasEntries
  };
}

export function directoryHasEntries(path: string): boolean {
  return existsSync(path) && readdirSync(path).length > 0;
}

export function prepareRootfsDirectoryForLxdRecover(mountPath: string): void {
  const rootfsPath = join(mountPath, "rootfs");
  if (directoryHasEntries(rootfsPath)) {
    return;
  }

  const stagingPath = join(mountPath, ".terrarium-rootfs.tmp");
  if (existsSync(stagingPath)) {
    throw new Error(`temporary LXD rootfs staging path already exists: ${stagingPath}`);
  }

  mkdirSync(stagingPath);
  for (const entry of readdirSync(mountPath)) {
    if (entry === "backup.yaml" || entry === "rootfs" || entry === ".terrarium-rootfs.tmp") {
      continue;
    }
    renameSync(join(mountPath, entry), join(stagingPath, entry));
  }
  if (!existsSync(rootfsPath)) {
    renameSync(stagingPath, rootfsPath);
  } else {
    for (const entry of readdirSync(stagingPath)) {
      renameSync(join(stagingPath, entry), join(rootfsPath, entry));
    }
    rmSync(stagingPath, { recursive: true, force: true });
  }

  if (!directoryHasEntries(rootfsPath)) {
    throw new Error(`recovered LXD dataset is missing rootfs contents at ${rootfsPath}`);
  }
}

export async function mountRootfsDatasetForLxdRecover(
  rootfsDataset: string,
  rootfsPath: string,
  runners: RestoreCommandRunners = {}
): Promise<void> {
  const { run, runRequired, directoryHasEntries: hasEntries } = restoreCommandRunners(runners);
  await runRequired(["mkdir", "-p", rootfsPath]);
  await run(["zfs", "unmount", rootfsDataset]);
  await runRequired(["zfs", "set", `mountpoint=${rootfsPath}`, rootfsDataset]);
  const rootfsMount = await run(["zfs", "mount", rootfsDataset]);
  if (rootfsMount.exitCode !== 0 && !`${rootfsMount.stderr}\n${rootfsMount.stdout}`.toLowerCase().includes("already mounted")) {
    throw new Error(`failed to mount recovered rootfs dataset at ${rootfsPath}: ${rootfsMount.stderr.trim() || rootfsMount.stdout.trim()}`);
  }

  if (!hasEntries(rootfsPath)) {
    const datasetState = await run(["zfs", "get", "-H", "-o", "property,value", "mounted,mountpoint,canmount", rootfsDataset]);
    throw new Error(
      [
        `recovered LXD rootfs dataset is mounted but missing contents at ${rootfsPath}`,
        datasetState.stdout.trim() ? `zfs state:\n${datasetState.stdout.trim()}` : "",
        datasetState.stderr.trim() ? `zfs stderr:\n${datasetState.stderr.trim()}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }
}
