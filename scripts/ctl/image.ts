import { heading, label, success, value } from "./context";
import { runAllowFailure, runInteractive } from "../lib/common";
import { launchCmd, LaunchOptions } from "./launch";
import { lxcArgs, lxcCommand, readInstance, isInfrastructureInstance } from "../lib/lxd-instance";
import { sanitizeInstanceHostState, quarantineVm, prepareVmGuestIdentity } from "../lib/guest-identity";
import { PREFIX } from "./context";

export type ImageCreateOptions = {
  snapshot?: string;
  live?: boolean;
  reuse?: boolean;
};

export type ImageCreatePlan = {
  instance: string;
  alias: string;
  source: string;
  tempInstance: string;
  snapshotToCreate?: string;
  publishArgs: string[];
};

type ImageCreateIdentity = {
  now?: number;
  pid?: number;
};

function requireName(value: string, labelName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${labelName} is required`);
  }
  return trimmed;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "image"
  );
}

export function buildImageCreatePlan(
  instanceArg: string,
  aliasArg: string,
  options: ImageCreateOptions = {},
  identity: ImageCreateIdentity = {}
): ImageCreatePlan {
  const instance = requireName(instanceArg, "instance");
  const alias = requireName(aliasArg, "image alias");
  const snapshot = options.snapshot?.trim();
  if (snapshot && options.live) {
    throw new Error("use either --snapshot or --live, not both");
  }

  const now = identity.now ?? Date.now();
  const pid = identity.pid ?? process.pid;
  const snapshotToCreate = snapshot || options.live ? undefined : `terrarium-golden-${now}`;
  const source = snapshot ? `${instance}/${snapshot}` : options.live ? instance : `${instance}/${snapshotToCreate}`;
  const tempInstance = `terrarium-image-${slugify(alias)}-${pid}-${now}`;
  const publishArgs = lxcArgs("publish", tempInstance, "--alias", alias);
  if (options.reuse) {
    publishArgs.push("--reuse");
  }

  return {
    instance,
    alias,
    source,
    tempInstance,
    ...(snapshotToCreate ? { snapshotToCreate } : {}),
    publishArgs
  };
}

export async function imageCreateCmd(instance: string, alias: string, options: ImageCreateOptions = {}): Promise<void> {
  const plan = buildImageCreatePlan(instance, alias, options);
  const sourceInstance = await readInstance(instance);
  if (isInfrastructureInstance(sourceInstance)) throw new Error("Ingress helpers cannot be published as workload images");
  let createdTemp = false;
  let createdSnapshot = false;

  try {
    if (plan.snapshotToCreate) {
      await lxcCommand(["snapshot", plan.instance, plan.snapshotToCreate]);
      createdSnapshot = true;
    }

    await lxcCommand(["copy", plan.source, plan.tempInstance], { timeoutMs: 30 * 60_000 });
    createdTemp = true;
    await lxcCommand(["config", "set", plan.tempInstance, "user.terrarium.role=image-staging", "boot.autostart=false", "cluster.evacuate=stop"]);
    await sanitizeInstanceHostState(plan.tempInstance);
    if (sourceInstance.type === "virtual-machine") {
      const cloudId = sourceInstance.config["volatile.cloud-init.instance-id"];
      if (cloudId) await lxcCommand(["config", "set", plan.tempInstance, `volatile.cloud-init.instance-id=${cloudId}`]);
      const saved = await quarantineVm(await readInstance(plan.tempInstance));
      await prepareVmGuestIdentity(plan.tempInstance, true, saved);
    }
    await lxcCommand(plan.publishArgs.slice(3), { timeoutMs: 30 * 60_000 });
  } finally {
    if (createdTemp) {
      const removed = await runAllowFailure(lxcArgs("delete", plan.tempInstance, "--force"));
      if (removed.exitCode !== 0) console.warn(`Could not remove temporary image instance ${plan.tempInstance}: ${removed.stderr.trim()}`);
    }
    if (createdSnapshot && plan.snapshotToCreate) {
      const removed = await runAllowFailure(lxcArgs("delete", `${plan.instance}/${plan.snapshotToCreate}`));
      if (removed.exitCode !== 0) console.warn(`Could not remove temporary image snapshot ${plan.instance}/${plan.snapshotToCreate}: ${removed.stderr.trim()}`);
    }
  }

  console.log(success(`Created golden image ${plan.alias}`));
  console.log(`  ${label("Source:")} ${value(plan.source)}`);
}

export async function imageListCmd(): Promise<void> {
  console.log(heading("LXD images"));
  await runInteractive(lxcArgs("image", "list"), PREFIX);
}

export async function imageLaunchCmd(alias: string, name: string, options: LaunchOptions = {}): Promise<void> {
  await launchCmd(alias, name, options);
}

export async function imageDeleteCmd(aliasArg: string): Promise<void> {
  const alias = requireName(aliasArg, "image alias");
  await runInteractive(lxcArgs("image", "delete", alias), PREFIX);
}
