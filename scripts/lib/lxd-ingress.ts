import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lxcCommand, listInstances, isInfrastructureInstance, vmCapability, type LxdInstance, type LxdRunner, record } from "./lxd-instance";
import { runAllowFailure } from "./common";

export function ingressInstanceName(member: string): string {
  return `terrarium-ingress-${createHash("sha256").update(member).digest("hex").slice(0, 12)}`;
}

export type InstanceNetworkState = Record<string, { hwaddr?: string; addresses?: { family?: string; scope?: string; address?: string }[] }>;

/** Match the managed NIC by its MAC, never by the first guest address (which may be Docker). */
export function managedInstanceAddress(instance: Pick<LxdInstance, "expanded_devices" | "config" | "expanded_config">, network: string, state: InstanceNetworkState): string | undefined {
  for (const [name, device] of Object.entries(instance.expanded_devices)) {
    if (device.type !== "nic" || device.network !== network) continue;
    const mac = device.hwaddr || instance.config[`volatile.${name}.hwaddr`];
    const nic = mac ? Object.values(state).find((nic) => nic.hwaddr?.toLowerCase() === mac.toLowerCase()) : device.name ? state[device.name] : undefined;
    return nic?.addresses?.find((address) => address.family === "inet" && address.scope === "global" && isIP(address.address ?? "") === 4)?.address;
  }
  return undefined;
}

/** The LXD proxy runs in this container's OVN namespace, but listens only on the local host. */
export async function ensureIngressInstance(member: string, network: string, run: LxdRunner = runAllowFailure): Promise<LxdInstance> {
  const host = await vmCapability(undefined, run);
  if (host.clustered) {
    const state = record(JSON.parse(await lxcCommand(["query", `/1.0/cluster/members/${encodeURIComponent(member)}`], { timeoutMs: 15_000 }, run)), "local cluster member");
    if (String(state.status).toLowerCase() !== "online") throw new Error(`${member} is ${state.status}; ingress helper will remain stopped`);
  }
  const name = ingressInstanceName(member);
  const instances = await listInstances(run);
  let instance = instances.find((instance) => instance.name === name);
  if (instance && (!isInfrastructureInstance(instance) || instance.config["user.terrarium.member"] !== member || instance.type !== "container" || instance.location && instance.location !== member)) {
    throw new Error(`Refusing to replace ${name}: it is not this member's Terrarium ingress helper`);
  }
  if (!instance) {
    await lxcCommand(["init", "ubuntu:24.04", name, "--profile", "terrarium-ingress", "--config", "user.terrarium.role=ingress", "--config", `user.terrarium.member=${member}`, ...(host.clustered ? ["--target", member] : [])], { timeoutMs: 300_000 }, run);
    instance = (await listInstances(run)).find((instance) => instance.name === name);
    if (!instance) throw new Error(`Created ingress helper ${name} was not found`);
  }
  if (!Object.values(instance.expanded_devices).some((device) => device.type === "nic" && device.network === network)) throw new Error(`${name} is not attached to the managed network ${network}`);
  if (instance.status.toLowerCase() !== "running") await lxcCommand(["start", name], { timeoutMs: 60_000 }, run);
  return instance;
}
