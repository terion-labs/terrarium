import { runAllowFailure, type CommandOptions } from "./common";

export const LXC = process.env.TERRARIUM_LXC_BIN ?? "/snap/bin/lxc";
export const MANAGED_PROFILES = ["default", "terrarium", "strict", "dev", "kvm", "vm", "vm-dev", "terrarium-ingress"];
export type InstanceType = "container" | "virtual-machine";
export type LxdDevice = Record<string, string>;
export type LxdInstance = {
  name: string;
  type: InstanceType;
  architecture: string;
  location: string;
  status: string;
  config: Record<string, string>;
  expanded_config: Record<string, string>;
  devices: Record<string, LxdDevice>;
  expanded_devices: Record<string, LxdDevice>;
  profiles: string[];
};
export type LxdRunner = typeof runAllowFailure;

/** Terrarium manages the default project, regardless of the operator's current CLI project. */
export function lxcArgs(...args: string[]): string[] {
  // query takes the project in its URL and explicitly rejects the CLI project flag.
  return args[0] === "query" ? [LXC, ...args] : [LXC, "--project", "default", ...args];
}

export async function lxcCommand(args: string[], options: CommandOptions = {}, run: LxdRunner = runAllowFailure): Promise<string> {
  const result = await run(lxcArgs(...args), options);
  if (result.exitCode !== 0) throw new Error(`LXD ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || result.exitCode}`);
  return result.stdout;
}

export function record(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${description}: expected an object`);
  return value as Record<string, unknown>;
}

function stringMap(value: unknown, description: string): Record<string, string> {
  const result = record(value ?? {}, description);
  if (Object.values(result).some((item) => typeof item !== "string")) throw new Error(`Invalid ${description}: expected string values`);
  return result as Record<string, string>;
}

export function instanceType(value: unknown): InstanceType {
  if (value === "container" || value === "virtual-machine") return value;
  throw new Error(`Unsupported or missing LXD instance type: ${String(value)}`);
}

export function parseInstance(value: unknown): LxdInstance {
  const raw = record(value, "LXD instance");
  if (typeof raw.name !== "string" || !raw.name) throw new Error("LXD instance is missing its name");
  const devices = (value: unknown) => Object.fromEntries(Object.entries(record(value ?? {}, "LXD devices"))
    .map(([name, device]) => [name, stringMap(device, `LXD device ${name}`)]));
  return {
    name: raw.name, type: instanceType(raw.type),
    architecture: typeof raw.architecture === "string" ? raw.architecture : "",
    location: typeof raw.location === "string" ? raw.location : "",
    status: typeof raw.status === "string" ? raw.status : "",
    config: stringMap(raw.config, "LXD config"),
    expanded_config: stringMap(raw.expanded_config ?? raw.config, "LXD expanded config"),
    devices: devices(raw.devices), expanded_devices: devices(raw.expanded_devices ?? raw.devices),
    profiles: Array.isArray(raw.profiles) && raw.profiles.every((item) => typeof item === "string") ? raw.profiles : []
  };
}

export async function readInstance(name: string, run: LxdRunner = runAllowFailure, timeoutMs = 15_000): Promise<LxdInstance> {
  return parseInstance(JSON.parse(await lxcCommand(["query", `/1.0/instances/${encodeURIComponent(name)}?project=default`], { timeoutMs }, run)));
}

export async function listInstances(run: LxdRunner = runAllowFailure): Promise<LxdInstance[]> {
  const raw: unknown = JSON.parse(await lxcCommand(["query", "/1.0/instances?recursion=1&project=default"], { timeoutMs: 15_000 }, run));
  if (!Array.isArray(raw)) throw new Error("Invalid LXD instance list");
  return raw.map(parseInstance);
}

export function isInfrastructureInstance(instance: Pick<LxdInstance, "config">): boolean {
  return instance.config["user.terrarium.role"] === "ingress";
}

export type VmCapability = { available: boolean; reason: string; architectures: string[]; member: string; clustered: boolean };

export function parseVmCapability(value: unknown): VmCapability {
  const server = record(value, "LXD server");
  const env = record(server.environment, "LXD server environment");
  const types = Array.isArray(env.instance_types) ? env.instance_types : [];
  const available = types.length > 0 ? types.includes("virtual-machine") : String(env.driver ?? "").split("|").some((driver) => driver.trim() === "qemu");
  return {
    available, reason: available ? "LXD advertises virtual-machine support" : "LXD cannot run virtual machines; check /dev/kvm, hardware virtualization and the LXD QEMU driver",
    architectures: Array.isArray(env.architectures) ? env.architectures.filter((item): item is string => typeof item === "string") : [],
    member: typeof env.server_name === "string" ? env.server_name : "",
    clustered: env.server_clustered === true
  };
}

export async function vmCapability(target?: string, run: LxdRunner = runAllowFailure): Promise<VmCapability> {
  const path = target ? `/1.0?target=${encodeURIComponent(target)}` : "/1.0";
  return parseVmCapability(JSON.parse(await lxcCommand(["query", path], { timeoutMs: 15_000 }, run)));
}

/** Resolve eligibility before creation. LXD still enforces resources and image compatibility. */
export async function vmLaunchTarget(requested?: string, architecture?: string, run: LxdRunner = runAllowFailure): Promise<string | undefined> {
  const local = await vmCapability(undefined, run);
  if (requested || !local.clustered) {
    const host = requested ? await vmCapability(requested, run) : local;
    if (!host.available) throw new Error(`${requested ?? host.member}: ${host.reason}`);
    if (architecture && !host.architectures.includes(architecture)) throw new Error(`${host.member} cannot run ${architecture} VM images`);
    return requested;
  }
  const members: unknown = JSON.parse(await lxcCommand(["query", "/1.0/cluster/members?recursion=1"], { timeoutMs: 15_000 }, run));
  if (!Array.isArray(members)) throw new Error("Invalid LXD cluster member list");
  const online = members.map((item) => record(item, "cluster member")).filter((member) => typeof member.server_name === "string" && String(member.status).toLowerCase() === "online");
  const eligible: string[] = [];
  for (const member of online) {
    const name = member.server_name as string;
    const host = await vmCapability(name, run);
    if (host.available && (!architecture || host.architectures.includes(architecture))) eligible.push(name);
  }
  if (eligible.length && eligible.length === online.length) return undefined; // Keep LXD's normal placement policy.
  if (eligible.length === 1) return eligible[0];
  if (eligible.length) {
    const workloads = (await listInstances(run)).filter((instance) => !isInfrastructureInstance(instance));
    const count = (member: string) => workloads.filter((instance) => instance.location === member).length;
    return eligible.sort((left, right) => count(left) - count(right) || left.localeCompare(right))[0];
  }
  throw new Error(`No online cluster member supports the requested ${architecture ?? ""} virtual machine`);
}

export function readinessTimeout(value: string | number | undefined, fallback = 300): number {
  const seconds = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) throw new Error("--timeout must be between 1 and 86400 seconds");
  return seconds * 1000;
}

/** Only readiness probes are retried. A user's command is never replayed. */
export async function waitForInstanceReady(name: string, options: { timeoutMs?: number; provisioning?: boolean } = {}, run: LxdRunner = runAllowFailure): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  let ready = false;
  while (Date.now() < deadline) {
    const probe = await run(lxcArgs("exec", name, "--", "true"), { timeoutMs: Math.min(10_000, deadline - Date.now()) });
    if (probe.exitCode === 0) { ready = true; break; }
    if (Date.now() >= deadline) break;
    const instance = await readInstance(name, run, Math.max(1, Math.min(10_000, deadline - Date.now())));
    if (instance.status.toLowerCase() !== "running") throw new Error(`${name} is ${instance.status}; start it before waiting for guest readiness`);
    await Bun.sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
  if (!ready) throw new Error(`${name}: guest agent did not become ready; inspect 'lxc console ${name}' and the lxd-agent service`);
  if (!options.provisioning) return;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${name}: timed out before cloud-init completed`);
  const result = await run(lxcArgs("exec", name, "--", "cloud-init", "status", "--wait", "--long"), { timeoutMs: remaining });
  if (result.exitCode !== 0) throw new Error(`${name}: cloud-init ${result.exitCode === 124 ? "timed out" : "failed"}; inspect 'lxc exec ${name} -- cloud-init status --long'`);
}
