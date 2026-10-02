import { lxcCommand, readInstance, record, waitForInstanceReady, type LxdInstance } from "./lxd-instance";
import { runAllowFailure } from "./common";
import { lxcArgs } from "./lxd-instance";

const QUARANTINE = "terrarium-clone-quarantine";
const DESCRIPTION = "Terrarium guest identity preparation; keep empty";

export async function sanitizeInstanceHostState(name: string): Promise<void> {
  let instance = await readInstance(name);
  const routeProfiles: string[] = [];
  for (const profile of instance.profiles) {
    const data = record(JSON.parse(await lxcCommand(["query", `/1.0/profiles/${encodeURIComponent(profile)}?project=default`])), "instance profile");
    if (record(data.config ?? {}, "profile config")["user.proxy"]) routeProfiles.push(profile);
  }
  if (routeProfiles.length) {
    // LXD removes empty config values; they cannot mask an inherited route.
    // Detach route-bearing profiles while preserving their other effective settings.
    const original = record(JSON.parse(await lxcCommand(["query", `/1.0/instances/${encodeURIComponent(name)}?project=default`])), "instance config");
    const config = { ...instance.expanded_config };
    delete config["user.proxy"];
    await lxcCommand(["config", "edit", name], { stdin: JSON.stringify({ ...original, config, devices: instance.expanded_devices, profiles: instance.profiles.filter((profile) => !routeProfiles.includes(profile)) }) });
    instance = await readInstance(name);
  } else if (instance.config["user.proxy"] !== undefined) {
    await lxcCommand(["config", "unset", name, "user.proxy"]);
  }
  for (const [key, device] of Object.entries(instance.expanded_devices)) {
    const hostBound = device.type === "proxy" || device.type === "disk" && device.path !== "/" || !["disk", "nic", "none"].includes(device.type ?? "");
    if (hostBound) {
      if (instance.devices[key]) await lxcCommand(["config", "device", "remove", name, key]);
      if (!instance.devices[key] || (await readInstance(name)).expanded_devices[key]) await lxcCommand(["config", "device", "add", name, key, "none"]);
    }
  }
  const after = await readInstance(name);
  if (after.expanded_config["user.proxy"]?.trim()) throw new Error(`temporary image source ${name} still has user.proxy after sanitization`);
  if (Object.values(after.expanded_devices).some((device) => device.type === "proxy")) throw new Error(`${name} still has proxy devices after sanitization`);
}

export async function ensureQuarantineAcl(): Promise<void> {
  const path = `/1.0/network-acls/${QUARANTINE}?project=default`;
  const existing = await runAllowFailure(lxcArgs("query", path), { timeoutMs: 15_000 });
  if (existing.exitCode !== 0) {
    if (!/not found|404/i.test(existing.stderr + existing.stdout)) throw new Error(`Could not inspect guest quarantine ACL: ${existing.stderr.trim()}`);
    await lxcCommand(["network", "acl", "create", QUARANTINE]);
    await lxcCommand(["network", "acl", "edit", QUARANTINE], { stdin: JSON.stringify({ name: QUARANTINE, description: DESCRIPTION, ingress: [], egress: [], config: {} }) });
  }
  const acl = record(JSON.parse(await lxcCommand(["query", path])), "quarantine ACL");
  if (acl.description !== DESCRIPTION || !Array.isArray(acl.ingress) || acl.ingress.length || !Array.isArray(acl.egress) || acl.egress.length) throw new Error(`${QUARANTINE} has unexpected rules or ownership; refusing to boot a clone`);
}

export type QuarantinedNic = { name: string; original: Record<string, string> | undefined };

/** Apply a deny-all ACL before the first boot; the VM agent remains reachable over vsock. */
export async function quarantineVm(instance: LxdInstance): Promise<QuarantinedNic[]> {
  if (instance.status.toLowerCase() !== "stopped") throw new Error(`${instance.name} must be stopped before preparing guest identity`);
  const nics = Object.entries(instance.expanded_devices).filter(([, device]) => device.type === "nic");
  for (const [key, device] of nics) {
    if (!device.network) throw new Error(`${instance.name}/${key}: clone identity preparation requires an OVN NIC`);
    const network = record(JSON.parse(await lxcCommand(["query", `/1.0/networks/${encodeURIComponent(device.network)}?project=default`])), "clone network");
    if (network.type !== "ovn") throw new Error(`${instance.name}/${key}: clone identity preparation requires OVN quarantine support`);
  }
  await ensureQuarantineAcl();
  const pending: QuarantinedNic[] = instance.config["user.terrarium.quarantined-nics"] ? JSON.parse(instance.config["user.terrarium.quarantined-nics"]) : [];
  const saved: QuarantinedNic[] = [];
  for (const [name, device] of nics) {
    saved.push(pending.find((nic) => nic.name === name) ?? { name, original: { ...device } });
    if (!instance.devices[name]) await lxcCommand(["config", "device", "override", instance.name, name]);
    await lxcCommand(["config", "device", "set", instance.name, name, `security.acls=${QUARANTINE}`, "security.acls.default.ingress.action=drop", "security.acls.default.egress.action=drop"]);
    for (const key of ["hwaddr", "ipv4.address", "ipv6.address"]) {
      if (device[key]) await lxcCommand(["config", "device", "unset", instance.name, name, key]);
    }
  }
  return saved;
}

export async function releaseVmQuarantine(name: string, saved: QuarantinedNic[]): Promise<void> {
  for (const nic of saved) {
    const current = (await readInstance(name)).devices[nic.name];
    if (!current || current["security.acls"] !== QUARANTINE) throw new Error(`${name}/${nic.name}: quarantine changed during identity preparation`);
    // Preserve pre-existing ACL policy while deliberately dropping copied static IPs and MACs.
    for (const key of ["security.acls", "security.acls.default.ingress.action", "security.acls.default.egress.action"]) {
      const previous = nic.original?.[key];
      await lxcCommand(["config", "device", previous === undefined ? "unset" : "set", name, nic.name, key, ...(previous === undefined ? [] : [previous])]);
    }
  }
}

export async function prepareVmGuestIdentity(name: string, golden: boolean, saved: QuarantinedNic[]): Promise<void> {
  await lxcCommand(["start", name], { timeoutMs: 90_000 });
  try {
    await waitForInstanceReady(name, { timeoutMs: 180_000 });
    const before = (await lxcCommand(["exec", name, "--", "cat", "/etc/machine-id"])).trim();
    await lxcCommand(["exec", name, "--", "sh", "-ec", "rm -f /etc/machine-id /var/lib/dbus/machine-id; systemd-machine-id-setup; ln -s /etc/machine-id /var/lib/dbus/machine-id; rm -f /etc/ssh/ssh_host_*key /etc/ssh/ssh_host_*key.pub; ssh-keygen -A"], { timeoutMs: 30_000 });
    const after = (await lxcCommand(["exec", name, "--", "cat", "/etc/machine-id"])).trim();
    if (!/^[a-f0-9]{32}$/.test(after) || after === before) throw new Error(`${name}: guest machine identity did not change`);
    if (golden) await lxcCommand(["exec", name, "--", "cloud-init", "clean", "--logs", "--seed", "--machine-id"], { timeoutMs: 30_000 });
    // Some cloud images do not process an ACPI shutdown until late in boot.
    // Ask systemd through the agent once, then observe shutdown without forcing it.
    const poweroff = await runAllowFailure(lxcArgs("exec", name, "--", "systemctl", "poweroff", "--no-block"), { timeoutMs: 15_000 });
    const deadline = Date.now() + 90_000;
    let stopped = false;
    while (Date.now() < deadline) {
      if ((await readInstance(name)).status.toLowerCase() === "stopped") { stopped = true; break; }
      await Bun.sleep(1000);
    }
    if (!stopped) throw new Error(`${name}: guest did not shut down after identity preparation${poweroff.exitCode ? ` (${poweroff.stderr.trim()})` : ""}`);
    await releaseVmQuarantine(name, saved);
    if ((await readInstance(name)).config["user.terrarium.quarantined-nics"]) await lxcCommand(["config", "unset", name, "user.terrarium.quarantined-nics"]);
  } catch (error) {
    throw new Error(`${error}; identity preparation for ${name} did not finish and its quarantine was not released`);
  }
}
