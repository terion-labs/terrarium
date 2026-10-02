import { password } from "@inquirer/prompts";
import { chmodSync, existsSync, statSync, realpathSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { FSTAB_PATH, heading, label, ManagedMount, MOUNTS_DIR, MOUNT_MARKER_PREFIX, success, value } from "./context";
import { runAllowFailure, runText } from "../lib/common";
import { lxcArgs, lxcCommand, readInstance, listInstances, vmCapability, waitForInstanceReady, type LxdInstance } from "../lib/lxd-instance";
import { PREFIX } from "./context";

/** Options that control how a host SMB/CIFS mount is presented on the Terrarium host. */
export type MountAddOptions = {
  passwordFile?: string;
  uid?: string;
  gid?: string;
  fileMode?: string;
  dirMode?: string;
  seal?: boolean;
  instance?: string;
  instancePath?: string;
  device?: string;
};

export const DEFAULT_CIFS_UID = "0";
export const DEFAULT_CIFS_GID = "0";
export const DEFAULT_CIFS_FILE_MODE = "0660";
export const DEFAULT_CIFS_DIR_MODE = "0770";
export const DEFAULT_INSTANCE_MOUNT_ROOT = "/mnt";

type MountAttachOptions = {
  instancePath?: string;
  device?: string;
  remapManagedMount?: boolean;
};

type LxdIdmapEntry = Record<string, unknown>;

type InstanceRootIdmap = {
  uid: string;
  gid: string;
};

/** Normalizes supported mount protocol aliases down to the real Linux fstype. */
function normalizeMountProtocol(protocol: string): "cifs" {
  const normalized = protocol.trim().toLowerCase();
  if (normalized === "cifs" || normalized === "smb") {
    return "cifs";
  }
  throw new Error("mount protocol must be smb or cifs");
}

/** Ensures SMB share addresses always use the canonical `//server/share` format. */
function normalizeShareAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) {
    throw new Error("share address is required");
  }
  const normalized = trimmed.startsWith("//") ? trimmed : `//${trimmed.replace(/^\/+/, "")}`;
  const [, server = "", share = ""] = normalized.match(/^\/\/([^/]+)\/([^/]+)/) ?? [];
  if (!server || !share) {
    throw new Error("share address must include a server and share name, for example //server/share");
  }
  return normalized;
}

/** Prevents users from accidentally creating relative mount points on the host. */
function requireAbsoluteHostPath(hostPath: string): string {
  const trimmed = hostPath.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error("host path must be absolute");
  }
  return trimmed;
}

function normalizeInstanceName(instance: string): string {
  const trimmed = instance.trim();
  if (!trimmed) {
    throw new Error("LXD instance name is required");
  }
  return trimmed;
}

function requireAbsoluteInstancePath(instancePath: string): string {
  const trimmed = instancePath.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error("instance mount path must be absolute");
  }
  return trimmed;
}

function normalizeNumericMountOption(value: string | undefined, fallback: string, label: string): string {
  const normalized = (value || fallback).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${label} must be numeric`);
  }
  return normalized;
}

function normalizeModeOption(value: string | undefined, fallback: string, label: string): string {
  const normalized = (value || fallback).trim();
  if (!/^[0-7]{3,4}$/.test(normalized)) {
    throw new Error(`${label} must be an octal mode such as ${fallback}`);
  }
  return normalized;
}

/** Creates a stable mount identifier from host path and share address. */
function slugifyMountName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "mount";
}

function defaultInstancePath(hostPath: string): string {
  const name = slugifyMountName(basename(hostPath) || "shared");
  return `${DEFAULT_INSTANCE_MOUNT_ROOT}/${name}`;
}

function defaultDeviceName(hostPath: string): string {
  return `terrarium-${slugifyMountName(hostPath).slice(0, 54)}`;
}

function normalizeDeviceName(device: string | undefined, hostPath: string): string {
  const normalized = slugifyMountName(device || defaultDeviceName(hostPath)).slice(0, 63);
  if (!normalized) {
    throw new Error("LXD disk device name is required");
  }
  return normalized;
}

function idmapBool(entry: LxdIdmapEntry, key: "Isuid" | "Isgid"): boolean {
  const lowerKey = key.toLowerCase();
  return Boolean(entry[key] ?? entry[lowerKey]);
}

function idmapNumber(entry: LxdIdmapEntry, key: "Hostid" | "Nsid" | "Maprange"): number | undefined {
  const lowerKey = key.toLowerCase();
  const value = entry[key] ?? entry[lowerKey];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function rootHostIdFromIdmap(entries: LxdIdmapEntry[], kind: "uid" | "gid"): string | undefined {
  for (const entry of entries) {
    if (!idmapBool(entry, kind === "uid" ? "Isuid" : "Isgid")) {
      continue;
    }
    const hostId = idmapNumber(entry, "Hostid");
    const nsId = idmapNumber(entry, "Nsid");
    const mapRange = idmapNumber(entry, "Maprange");
    if (hostId === undefined || nsId === undefined || mapRange === undefined) {
      continue;
    }
    if (nsId <= 0 && nsId + mapRange > 0) {
      return String(hostId - nsId);
    }
  }
  return undefined;
}

async function lookupInstanceRootIdmap(instance: string): Promise<InstanceRootIdmap> {
  const info = await readInstance(instance);
  await assertLocalMountTarget(info);
  if (info.type === "virtual-machine") {
    await waitForInstanceReady(instance, { timeoutMs: 60_000 });
    const uid = (await lxcCommand(["exec", instance, "--", "id", "-u", "terrarium"], { timeoutMs: 15_000 })).trim();
    const gid = (await lxcCommand(["exec", instance, "--", "id", "-g", "terrarium"], { timeoutMs: 15_000 })).trim();
    if (!/^\d+$/.test(uid) || !/^\d+$/.test(gid)) throw new Error(`${instance}: could not resolve the terrarium guest user's UID/GID`);
    return { uid, gid };
  }
  const rawValues = [
    await lxcCommand(["config", "get", instance, "volatile.idmap.current"]),
    await lxcCommand(["config", "get", instance, "volatile.idmap.next"])
  ];

  for (const raw of rawValues) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) {
      continue;
    }

    const entries = parsed.filter((entry): entry is LxdIdmapEntry => typeof entry === "object" && entry !== null && !Array.isArray(entry));
    const uid = rootHostIdFromIdmap(entries, "uid");
    const gid = rootHostIdFromIdmap(entries, "gid");
    if (uid && gid) {
      return { uid, gid };
    }
  }

  throw new Error(`failed to resolve unprivileged uid/gid mapping for LXD container ${instance}`);
}

async function assertLocalMountTarget(instance: LxdInstance): Promise<void> {
  const host = await vmCapability();
  if (host.clustered && instance.location !== host.member) throw new Error(`${instance.name} is on ${instance.location}; run mount commands on that member`);
}

export function mountConsumers(instances: LxdInstance[], hostPath: string, except?: string): string[] {
  const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : path).replace(/\/+$/, "");
  const path = canonical(hostPath);
  return instances.filter((instance) => instance.name !== except && Object.values(instance.expanded_devices).some((device) => {
    const source = device.source?.startsWith("/") ? canonical(device.source) : undefined;
    return device.type === "disk" && source && (source === path || source.startsWith(`${path}/`) || path.startsWith(`${source}/`));
  })).map((instance) => instance.name);
}

async function assertMountUnused(hostPath: string, except?: string): Promise<void> {
  const host = await vmCapability();
  const instances = (await listInstances()).filter((instance) => !host.clustered || instance.location === host.member);
  const consumers = mountConsumers(instances, hostPath, except);
  if (consumers.length) throw new Error(`${hostPath} is used by ${consumers.join(", ")}; detach those disks before changing mount ownership or unmounting it`);
}

async function requiredHostCommand(args: string[]): Promise<void> {
  const result = await runAllowFailure(args, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

async function applyManagedMount(hostPath: string, current: string, next: string, restoreCredentials?: () => void): Promise<void> {
  const mounted = await runAllowFailure(["mountpoint", "-q", hostPath]);
  if (mounted.exitCode === 0) await requiredHostCommand(["umount", hostPath]);
  writeFileSync(FSTAB_PATH, next, "utf8");
  try {
    await requiredHostCommand(["mount", hostPath]);
  } catch (error) {
    writeFileSync(FSTAB_PATH, current, "utf8");
    restoreCredentials?.();
    if (mounted.exitCode === 0) {
      const restored = await runAllowFailure(["mount", hostPath], { timeoutMs: 60_000 });
      if (restored.exitCode !== 0) throw new Error(`${error}; previous fstab restored but remount failed: ${restored.stderr.trim()}`);
    }
    throw error;
  }
}

/** Escapes arbitrary text so it can be embedded safely into a dynamic regular expression. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces a Terrarium-managed fstab block while leaving other entries untouched. */
function replaceManagedBlock(current: string, marker: string, block: string): string {
  const pattern = new RegExp(`# BEGIN ${escapeRegex(marker)}\\n[\\s\\S]*?# END ${escapeRegex(marker)}\\n?`, "g");
  const cleaned = current.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trimEnd();
  return `${cleaned ? `${cleaned}\n\n` : ""}${block}\n`;
}

/** Removes a Terrarium-managed fstab block while preserving unrelated entries. */
function stripManagedBlock(current: string, marker: string): string {
  const pattern = new RegExp(`# BEGIN ${escapeRegex(marker)}\\n[\\s\\S]*?# END ${escapeRegex(marker)}\\n?`, "g");
  return current.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Parses all Terrarium-managed host mounts from `/etc/fstab`.
 *
 * Terrarium owns only blocks wrapped with its marker comments, which lets list
 * and remove operate safely without interfering with user-managed fstab lines.
 */
function parseManagedMounts(current: string): ManagedMount[] {
  const mounts: ManagedMount[] = [];
  const pattern = new RegExp(`# BEGIN (${escapeRegex(MOUNT_MARKER_PREFIX)}[^\\n]+)\\n([^\\n]+)\\n# END \\1`, "g");

  for (const match of current.matchAll(pattern)) {
    const marker = match[1]?.trim() ?? "";
    const entry = match[2]?.trim() ?? "";
    if (!marker || !entry) {
      continue;
    }

    const [address = "", hostPath = "", protocol = "", rawOptions = ""] = entry.split(/\s+/, 4);
    if (!address || !hostPath || !protocol) {
      continue;
    }

    const options = rawOptions.split(",").filter(Boolean);
    const credentialsPath = options.find((option) => option.startsWith("credentials="))?.slice("credentials=".length) ?? "";

    mounts.push({
      marker,
      address,
      hostPath,
      protocol,
      options,
      credentialsPath
    });
  }

  return mounts;
}

function renderManagedMountBlock(mount: ManagedMount, optionsList: string[]): string {
  const entry = `${mount.address} ${mount.hostPath} ${mount.protocol} ${optionsList.join(",")} 0 0`;
  return `# BEGIN ${mount.marker}\n${entry}\n# END ${mount.marker}`;
}

function upsertMountOption(optionsList: string[], key: string, value: string): string[] {
  let replaced = false;
  const updated = optionsList.map((option) => {
    if (!option.startsWith(`${key}=`)) {
      return option;
    }
    replaced = true;
    return `${key}=${value}`;
  });
  return replaced ? updated : [...updated, `${key}=${value}`];
}

function ensureFlagOption(optionsList: string[], flag: string): string[] {
  return optionsList.includes(flag) ? optionsList : [...optionsList, flag];
}

async function remapManagedCifsMountForInstance(hostPath: string, instance: string): Promise<void> {
  const fstabCurrent = existsSync(FSTAB_PATH) ? readFileSync(FSTAB_PATH, "utf8") : "";
  const mount = parseManagedMounts(fstabCurrent).filter((candidate) => hostPath === candidate.hostPath || hostPath.startsWith(`${candidate.hostPath}/`)).sort((a, b) => b.hostPath.length - a.hostPath.length)[0];
  if (!mount || mount.protocol !== "cifs") {
    return;
  }

  if ((await runAllowFailure(["mountpoint", "-q", mount.hostPath])).exitCode !== 0) throw new Error(`${mount.hostPath} is configured but not mounted; mount the share before attaching it`);
  const idmap = await lookupInstanceRootIdmap(instance);
  const optionsList = upsertMountOption(
    upsertMountOption(ensureFlagOption(ensureFlagOption(mount.options, "forceuid"), "forcegid"), "uid", idmap.uid),
    "gid",
    idmap.gid
  );
  if (optionsList.join(",") === mount.options.join(",")) {
    return;
  }

  await assertMountUnused(mount.hostPath, instance);
  await applyManagedMount(mount.hostPath, fstabCurrent, replaceManagedBlock(fstabCurrent, mount.marker, renderManagedMountBlock(mount, optionsList)));
}

/**
 * Creates or updates a Terrarium-managed host SMB/CIFS mount.
 *
 * The command writes a root-only credentials file, persists the mount in
 * `/etc/fstab`, and mounts the target immediately so it is ready for use by
 * containers or the host without a reboot.
 */
export async function mountAddCmd(
  protocolArg: string,
  hostPathArg: string,
  addressArg: string,
  usernameArg: string,
  passwordArg?: string,
  options: MountAddOptions = {}
): Promise<void> {
  const protocol = normalizeMountProtocol(protocolArg);
  const hostPath = requireAbsoluteHostPath(hostPathArg);
  const address = normalizeShareAddress(addressArg);
  const username = usernameArg.trim();
  if (!username) {
    throw new Error("username is required");
  }
  if (passwordArg && options.passwordFile) {
    throw new Error("use either --password or --password-file, not both");
  }

  await assertMountUnused(hostPath);
  const instance = options.instance ? normalizeInstanceName(options.instance) : undefined;
  if (instance) await assertLocalMountTarget(await readInstance(instance));
  const instanceRoot = instance && (!options.uid || !options.gid) ? await lookupInstanceRootIdmap(instance) : undefined;

  const secret =
    passwordArg ||
    (options.passwordFile ? readFileSync(options.passwordFile, "utf8").replace(/\n+$/g, "") : undefined) ||
    (await password({
      message: `Password for ${username} (${address})`,
      mask: true,
      validate: (value) => (value.trim().length > 0 ? true : "Password is required")
    }));

  mkdirSync(MOUNTS_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(hostPath, { recursive: true, mode: 0o755 });

  const uid = options.uid ?? instanceRoot?.uid;
  const gid = options.gid ?? instanceRoot?.gid;

  const slug = slugifyMountName(`${hostPath}-${address}`);
  const credentialsPath = `${MOUNTS_DIR}/${slug}.credentials`;
  const marker = `${MOUNT_MARKER_PREFIX}${slug}`;
  const optionsList = [
    "iocharset=utf8",
    "rw",
    "nosuid",
    "nodev",
    "noexec",
    "forceuid",
    "forcegid",
    ...(options.seal === false ? [] : ["seal"]),
    `credentials=${credentialsPath}`,
    `uid=${normalizeNumericMountOption(uid, DEFAULT_CIFS_UID, "--uid")}`,
    `gid=${normalizeNumericMountOption(gid, DEFAULT_CIFS_GID, "--gid")}`,
    `file_mode=${normalizeModeOption(options.fileMode, DEFAULT_CIFS_FILE_MODE, "--file-mode")}`,
    `dir_mode=${normalizeModeOption(options.dirMode, DEFAULT_CIFS_DIR_MODE, "--dir-mode")}`
  ];
  const entry = `${address} ${hostPath} ${protocol} ${optionsList.join(",")} 0 0`;
  const block = `# BEGIN ${marker}\n${entry}\n# END ${marker}`;

  const previousCredentials = existsSync(credentialsPath) ? readFileSync(credentialsPath) : undefined;
  writeFileSync(credentialsPath, `username=${username}\npassword=${secret}\n`, "utf8");
  chmodSync(credentialsPath, 0o600);

  const fstabCurrent = existsSync(FSTAB_PATH) ? readFileSync(FSTAB_PATH, "utf8") : "";
  const withoutPreviousHostPathBlocks = parseManagedMounts(fstabCurrent)
    .filter((mount) => mount.hostPath === hostPath)
    .reduce((current, mount) => stripManagedBlock(current, mount.marker), fstabCurrent);
  try {
    await applyManagedMount(hostPath, fstabCurrent, replaceManagedBlock(withoutPreviousHostPathBlocks, marker, block), () => {
      if (previousCredentials) writeFileSync(credentialsPath, previousCredentials, { mode: 0o600 });
    });
  } catch (error) {
    if (previousCredentials) writeFileSync(credentialsPath, previousCredentials, { mode: 0o600 });
    else unlinkSync(credentialsPath);
    throw error;
  }
  if (instance) {
    await mountAttachCmd(hostPath, instance, {
      instancePath: options.instancePath,
      device: options.device,
      remapManagedMount: false
    });
  }

  console.log(success(`Mounted ${address} at ${hostPath}`));
  console.log(`  ${label("Protocol:")} ${value(protocol)}`);
  console.log(`  ${label("Credentials:")} ${value(credentialsPath)}`);
  console.log(`  ${label("fstab:")} ${value(`managed block ${marker}`)}`);
}

/**
 * Attaches a host mount to an unprivileged LXD container. For Terrarium-managed
 * CIFS mounts, the host mount is remapped to the container root uid/gid first.
 */
export async function mountAttachCmd(hostPathArg: string, instanceArg: string, options: MountAttachOptions = {}): Promise<void> {
  const hostPath = requireAbsoluteHostPath(hostPathArg);
  const instance = normalizeInstanceName(instanceArg);
  const instancePath = requireAbsoluteInstancePath(options.instancePath || defaultInstancePath(hostPath));
  const device = normalizeDeviceName(options.device, hostPath);

  if (!existsSync(hostPath) || !statSync(hostPath).isDirectory()) throw new Error(`${hostPath} must be an existing host directory or mounted share`);
  const info = await readInstance(instance);
  await assertLocalMountTarget(info);
  const existing = info.expanded_devices[device];
  if (existing && (existing.type !== "disk" || existing.source !== hostPath || existing.path !== instancePath || existing.shift === "true")) throw new Error(`Device ${device} already has different settings; choose a new --device name`);
  if (info.type === "virtual-machine") await waitForInstanceReady(instance, { timeoutMs: 60_000 });
  if (options.remapManagedMount !== false) await remapManagedCifsMountForInstance(hostPath, instance);
  if (!existing) await lxcCommand(["config", "device", "add", instance, device, "disk", `source=${hostPath}`, `path=${instancePath}`], { timeoutMs: 60_000 });
  if (info.type === "virtual-machine") {
    const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
    const access = await runAllowFailure(lxcArgs("exec", instance, "--", "su", "-l", "terrarium", "-c", `test -r ${quote(instancePath)} && test -w ${quote(instancePath)}`), { timeoutMs: 15_000 });
    if (access.exitCode !== 0) {
      if (!existing) await lxcCommand(["config", "device", "remove", instance, device]);
      throw new Error(`${instance}: terrarium cannot read and write ${instancePath}; set host directory permissions for the guest UID/GID and retry`);
    }
  }

  console.log(success(`Attached ${hostPath} to ${instance}:${instancePath}`));
  console.log(`  ${label("Device:")} ${value(device)}`);
}

/** Lists every Terrarium-managed host mount currently registered in `/etc/fstab`. */
export async function mountListCmd(): Promise<void> {
  const fstabCurrent = existsSync(FSTAB_PATH) ? readFileSync(FSTAB_PATH, "utf8") : "";
  const mounts = parseManagedMounts(fstabCurrent);

  if (mounts.length === 0) {
    console.log("No Terrarium-managed mounts found.");
    return;
  }

  console.log(heading("Terrarium-managed mounts"));
  for (const mount of mounts) {
    const mounted = await runAllowFailure(["mountpoint", "-q", mount.hostPath]);
    console.log(`\n${label("Path:")} ${value(mount.hostPath)}`);
    console.log(`  ${label("Address:")} ${value(mount.address)}`);
    console.log(`  ${label("Protocol:")} ${value(mount.protocol)}`);
    console.log(`  ${label("Mounted:")} ${value(mounted.exitCode === 0 ? "yes" : "no")}`);
    console.log(`  ${label("Credentials:")} ${value(mount.credentialsPath || "n/a")}`);
  }
}

/**
 * Removes a Terrarium-managed host mount by mount point path.
 *
 * The removal process unmounts the share, removes the managed fstab block, and
 * deletes the corresponding managed credentials file.
 */
export async function mountRemoveCmd(hostPathArg: string, confirmDestructive: (message: string) => Promise<void>): Promise<void> {
  const hostPath = requireAbsoluteHostPath(hostPathArg);
  const fstabCurrent = existsSync(FSTAB_PATH) ? readFileSync(FSTAB_PATH, "utf8") : "";
  const mounts = parseManagedMounts(fstabCurrent);
  const mount = mounts.find((candidate) => candidate.hostPath === hostPath);

  if (!mount) {
    throw new Error(`no Terrarium-managed mount found for ${hostPath}`);
  }

  await assertMountUnused(hostPath);
  await confirmDestructive(`Remove managed mount ${mount.address} at ${hostPath}?`);

  const mounted = await runAllowFailure(["mountpoint", "-q", hostPath]);
  if (mounted.exitCode === 0) {
    await runText(["umount", hostPath], PREFIX);
  }

  writeFileSync(FSTAB_PATH, `${stripManagedBlock(fstabCurrent, mount.marker)}\n`, "utf8");

  if (mount.credentialsPath && existsSync(mount.credentialsPath)) {
    unlinkSync(mount.credentialsPath);
  }

  console.log(success(`Removed managed mount at ${hostPath}`));
}
