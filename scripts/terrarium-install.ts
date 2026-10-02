import { $ } from "bun";
import { confirm, input, password, select } from "@inquirer/prompts";
import type { CAC } from "cac";
import chalk from "chalk";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { TERRARIUM_SPLASH, TERRARIUM_VERSION } from "./generated/build-info";
import {
  TERRARIUM_ANSIBLE_GALAXY,
  TERRARIUM_ANSIBLE_PIP_PACKAGES,
  TERRARIUM_ANSIBLE_PLAYBOOK,
  TERRARIUM_ANSIBLE_PYTHON,
  TERRARIUM_ANSIBLE_VENV,
  TERRARIUM_ANSIBLE_WHEELHOUSE
} from "./ctl/ansible-runtime";
import { CONFIG_PATH } from "./ctl/context";
import { updateCmd } from "./ctl/update";
import { verifyOidcConfig, verifyS3Config } from "./ctl/verify";
import { normalizeS3Endpoint } from "./lib/common";
import { hasConfigDocument } from "./lib/config-store";
import {
  PUBLIC_IDP_PROVIDERS,
  resolveEffectiveIdpProvider,
  resolveLocalOidcIssuer,
  resolveLxdOidcGroupsClaim,
  resolveLxdOidcScopes,
  resolveOidcGroupsClaim,
  resolveOidcScopes,
  validatePublicIdpProvider
} from "./lib/idp-provider";

const PREFIX = "terrariumctl install";
const REPO_URL = process.env.TERRARIUM_REPO_URL ?? "https://github.com/terion-labs/terrarium.git";
const REPO_DIR = process.env.TERRARIUM_REPO_DIR ?? "/opt/terrarium";
const BUNDLE_DIR = process.env.TERRARIUM_BUNDLE_DIR ?? "";
const GENERATED_ROOT_PASSWORD_PATH = "/etc/terrarium/secrets/cockpit_root_password";
const LOGTO_ADMIN_PASSWORD_PATH = "/etc/terrarium/secrets/logto_admin_password";
const DEFAULT_LOGTO_ADMIN_USERNAME = "terrarium_admin";
const ANSIBLE_GALAXY_ATTEMPTS = 4;
// CAC's string transform runs after numeric coercion; readCliOption recovers exact argv values instead.
const STRING_OPTION = {};

$.throws(true);

type InstallMode = "interactive" | "non-interactive";
type IdpMode = "local" | "oidc";
type StorageMode = "disk" | "partition" | "file";

type DiskCandidate = {
  path: string;
  sizeBytes: number;
  sizeLabel: string;
};

type PartitionCandidate =
  | {
      kind: "partition";
      source: string;
      sizeBytes: number;
      sizeLabel: string;
      description: string;
    }
  | {
      kind: "free-space";
      source: string;
      sizeBytes: number;
      sizeLabel: string;
      description: string;
      startMiB: string;
      endMiB: string;
    };

type InstallOptions = {
  ref: string;
  mode: InstallMode;
  assumeYes: boolean;
  publicIp: string;
  email: string;
  acmeEmail: string;
  domain: string;
  manageDomain: string;
  proxyDomain: string;
  lxdDomain: string;
  idpMode: IdpMode | "";
  adminGroup: string;
  authDomain: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  lxdOidcClientId: string;
  lxdOidcClientSecret: string;
  idpProvider: string;
  oidcGroupsClaim: string;
  oidcScopes: string;
  lxdOidcGroupsClaim: string;
  lxdOidcScopes: string;
  localIdpOutputsPath: string;
  zitadelAdminEmail: string;
  logtoAdminEmail: string;
  logtoAdminUsername: string;
  rootPassword: string;
  generateRootPassword: boolean;
  generatedRootPasswordPath: string;
  storageMode: string;
  storageSource: string;
  storageSize: string;
  storagePartitionStart: string;
  storagePartitionEnd: string;
  enableS3: boolean;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3Prefix: string;
  s3AccessKey: string;
  s3SecretKey: string;
  enableSyncoid: boolean;
  syncoidTarget: string;
  syncoidTargetDataset: string;
  syncoidSshKey: string;
};

function fail(message: string): never {
  console.error(chalk.red(`${PREFIX}: ${message}`));
  process.exit(1);
}

const RESERVED_EMAIL_DOMAINS = new Set(["example.com", "example.org", "example.net"]);

function info(message: string): void {
  console.log(chalk.cyan(`${PREFIX}: ${message}`));
}

function success(message: string): void {
  console.log(chalk.green(`${PREFIX}: ${message}`));
}

function warn(message: string): void {
  console.log(chalk.yellow(`${PREFIX}: ${message}`));
}

function printSplash(): void {
  console.log(chalk.magenta(TERRARIUM_SPLASH));
  console.log(chalk.dim(`terrariumctl install ${TERRARIUM_VERSION}`));
  console.log("");
}

async function handleExistingInteractiveInstall(options: InstallOptions): Promise<boolean> {
  if (options.mode !== "interactive" || !hasConfigDocument(CONFIG_PATH, PREFIX)) {
    return false;
  }

  const action = await select({
    message: "Existing Terrarium configuration found. What do you want to do?",
    choices: [
      { name: "Update existing installation", value: "update" },
      { name: "Reinstall / reconfigure from scratch", value: "reinstall" },
      { name: "Cancel", value: "cancel" }
    ]
  });

  if (action === "update") {
    await updateCmd({ ref: options.ref });
    return true;
  }
  if (action === "cancel") {
    fail("operation cancelled");
  }
  return false;
}

export function validateEmail(email: string, fieldName: string): string {
  const normalized = email.trim();
  const match = normalized.match(/^[^@\s]+@([^@\s]+)$/);
  if (!match) {
    fail(`${fieldName} must be a valid email address`);
  }
  const domain = match[1].toLowerCase();
  if (RESERVED_EMAIL_DOMAINS.has(domain)) {
    fail(`${fieldName} must not use reserved example.* domains because ACME rejects them`);
  }
  return normalized;
}

export function validateLogtoAdminUsername(username: string, fieldName: string): string {
  const normalized = username.trim();
  if (!normalized) {
    fail(`${fieldName} must not be empty`);
  }
  if (/[\s\x00-\x1f\x7f]/.test(normalized)) {
    fail(`${fieldName} must not contain whitespace or control characters`);
  }
  return normalized;
}

function rootPasswordState(): "usable" | "missing" {
  const rootShadow = readFileSync("/etc/shadow", "utf8")
    .split("\n")
    .find((line) => line.startsWith("root:"));
  if (!rootShadow) {
    return "missing";
  }
  const passwordField = rootShadow.split(":")[1] ?? "";
  if (!passwordField || passwordField === "*" || passwordField === "!" || passwordField === "!!" || passwordField.startsWith("!")) {
    return "missing";
  }
  return "usable";
}

async function promptPasswordWithConfirmation(message: string): Promise<string> {
  const first = await password({
    message,
    mask: "*",
    validate: (value) => (value.length > 0 ? true : "Password must not be empty")
  });
  const second = await password({
    message: "Confirm password",
    mask: "*",
    validate: (value) => (value.length > 0 ? true : "Password must not be empty")
  });
  if (first !== second) {
    fail("password confirmation does not match");
  }
  return first;
}

export function generateRootPassword(): string {
  return `trm-${randomBytes(32).toString("base64url")}`;
}

function persistGeneratedRootPassword(passwordValue: string): void {
  const secretDir = dirname(GENERATED_ROOT_PASSWORD_PATH);
  mkdirSync(secretDir, { recursive: true, mode: 0o700 });
  chmodSync(secretDir, 0o700);
  writeFileSync(GENERATED_ROOT_PASSWORD_PATH, `${passwordValue}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(GENERATED_ROOT_PASSWORD_PATH, 0o600);
}

function applyGeneratedRootPassword(options: InstallOptions): void {
  if (!options.generateRootPassword) {
    return;
  }
  if (options.rootPassword) {
    fail("use only one of --generate-root-pwd or --root-pwd-file");
  }
  options.rootPassword = generateRootPassword();
  options.generatedRootPasswordPath = GENERATED_ROOT_PASSWORD_PATH;
  persistGeneratedRootPassword(options.rootPassword);
}

export function normalizeOidcIssuer(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    fail(`${fieldName} must not be empty`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    fail(`${fieldName} must be a valid URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    fail(`${fieldName} must use http or https`);
  }
  if (parsed.search || parsed.hash) {
    fail(`${fieldName} must not include query parameters or a fragment`);
  }
  const normalized = parsed.toString();
  if (parsed.pathname === "/" && !trimmed.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function requireRoot(): void {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    fail("run as root");
  }
}

function parseOsRelease(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync("/etc/os-release", "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    values[key] = rawValue.replace(/^"/, "").replace(/"$/, "");
  }
  return values;
}

function ensureOs(): void {
  const os = parseOsRelease();
  if (os.ID !== "ubuntu") {
    fail("Ubuntu is required");
  }
  if (os.VERSION_ID !== "24.04" && os.VERSION_ID !== "26.04") {
    fail("Ubuntu 24.04 or 26.04 is required");
  }
}

async function ensureDeps(): Promise<void> {
  await $`apt-get -o DPkg::Lock::Timeout=900 update -y`;
  await $`apt-get -o DPkg::Lock::Timeout=900 install -y ca-certificates curl git python3 python3-venv jq unzip`;
}

async function ensureAnsibleRuntime(): Promise<void> {
  if (!existsSync(TERRARIUM_ANSIBLE_WHEELHOUSE) || !readdirSync(TERRARIUM_ANSIBLE_WHEELHOUSE).some((name) => name.endsWith(".whl"))) {
    fail(`Terrarium release bundle is missing the vendored Ansible wheelhouse: ${TERRARIUM_ANSIBLE_WHEELHOUSE}`);
  }
  await $`python3 -m venv ${TERRARIUM_ANSIBLE_VENV}`;
  await $`${TERRARIUM_ANSIBLE_PYTHON} -m pip install --no-index --find-links ${TERRARIUM_ANSIBLE_WHEELHOUSE} ${TERRARIUM_ANSIBLE_PIP_PACKAGES}`;
}

function syncBundleArtifacts(bundleDir: string, repoDir: string): void {
  if (!bundleDir) {
    return;
  }
  const sourceDir = existsSync(join(bundleDir, "dist")) ? join(bundleDir, "dist") : bundleDir;
  mkdirSync(join(repoDir, "dist"), { recursive: true });
  cpSync(sourceDir, join(repoDir, "dist"), { recursive: true, force: true });
}

function stageRunningBinary(repoDir: string): void {
  if (!process.execPath || !existsSync(process.execPath)) {
    return;
  }
  const targetDir = join(repoDir, "dist");
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(process.execPath, join(targetDir, "terrariumctl"));
}

function localSourcePath(repoUrl: string): string {
  if (repoUrl.startsWith("file://")) {
    return repoUrl.slice("file://".length);
  }
  if (repoUrl.startsWith("/")) {
    return repoUrl;
  }
  return "";
}

function syncLocalSourceRepo(sourcePath: string, repoDir: string): void {
  rmSync(repoDir, { recursive: true, force: true });
  mkdirSync(repoDir, { recursive: true });
  cpSync(sourcePath, repoDir, {
    recursive: true,
    force: true,
    filter: (source) => {
      const base = source.split("/").at(-1) ?? "";
      return ![".git", "node_modules", "dist"].includes(base);
    }
  });
}

function syncInstallBundle(bundleDir: string, repoDir: string): void {
  rmSync(repoDir, { recursive: true, force: true });
  mkdirSync(repoDir, { recursive: true });
  cpSync(bundleDir, repoDir, {
    recursive: true,
    force: true,
    filter: (source) => {
      const base = source.split("/").at(-1) ?? "";
      return ![".git", "node_modules"].includes(base);
    }
  });
}

async function installAnsibleCollections(): Promise<void> {
  let lastOutput = "";
  for (let attempt = 1; attempt <= ANSIBLE_GALAXY_ATTEMPTS; attempt += 1) {
    const result = await $`cd ${join(REPO_DIR, "ansible")}; ${TERRARIUM_ANSIBLE_GALAXY} collection install -r requirements.yml`.nothrow();
    if (result.exitCode === 0) {
      return;
    }

    lastOutput = `${result.stdout.toString()}\n${result.stderr.toString()}`.trim();
    if (attempt < ANSIBLE_GALAXY_ATTEMPTS) {
      warn(`ansible-galaxy collection install failed on attempt ${attempt}/${ANSIBLE_GALAXY_ATTEMPTS}; retrying`);
      await Bun.sleep(attempt * 5000);
    }
  }

  fail(`ansible-galaxy collection install failed after ${ANSIBLE_GALAXY_ATTEMPTS} attempts${lastOutput ? `\n${lastOutput}` : ""}`);
}

async function prepareRepo(ref: string): Promise<void> {
  const sourcePath = localSourcePath(REPO_URL);
  if (BUNDLE_DIR && existsSync(join(BUNDLE_DIR, "ansible", "site.yml"))) {
    info(`installing Terrarium release bundle into ${REPO_DIR}`);
    syncInstallBundle(BUNDLE_DIR, REPO_DIR);
  } else if (sourcePath && existsSync(join(sourcePath, "ansible", "site.yml"))) {
    info(`syncing local Terrarium source from ${sourcePath}`);
    syncLocalSourceRepo(sourcePath, REPO_DIR);
  } else if (existsSync(join(REPO_DIR, ".git"))) {
    info(`updating existing checkout in ${REPO_DIR}`);
    await $`git -C ${REPO_DIR} fetch --tags origin`;
    await $`git -C ${REPO_DIR} checkout ${ref}`;
    await $`git -C ${REPO_DIR} pull --ff-only origin ${ref}`.nothrow().quiet();
  } else {
    rmSync(REPO_DIR, { recursive: true, force: true });
    await $`git clone --depth 1 --branch ${ref} ${REPO_URL} ${REPO_DIR}`;
  }

  syncBundleArtifacts(BUNDLE_DIR, REPO_DIR);
  if (!existsSync(join(REPO_DIR, "dist", "terrariumctl"))) {
    stageRunningBinary(REPO_DIR);
  }
  if (!existsSync(join(REPO_DIR, "dist", "terrariumctl"))) {
    fail("compiled Terrarium binaries are missing from the installed bundle");
  }

  await ensureAnsibleRuntime();
  await installAnsibleCollections();
}

function dashedIp(ip: string): string {
  return ip.replaceAll(".", "-");
}

async function detectPublicIp(current = ""): Promise<string> {
  if (current) {
    return current;
  }
  const direct = await $`curl -4fsSL https://api.ipify.org`.nothrow().quiet();
  const directValue = direct.stdout.toString().trim();
  if (direct.exitCode === 0 && directValue) {
    return directValue;
  }
  const fallback = (await $`hostname -I`.text()).trim();
  const first = fallback.split(/\s+/).find(Boolean) ?? "";
  if (!first) {
    fail("failed to detect public IP");
  }
  return first;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0B";
  }
  const units = ["B", "K", "M", "G", "T", "P"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unitIndex]}`;
}

async function detectRootDiskPath(): Promise<string> {
  const rootSource = await $`findmnt -n -o SOURCE /`.nothrow().quiet();
  const rootValue = rootSource.stdout.toString().trim();
  const rootDisk = rootValue ? (await $`lsblk -no PKNAME ${rootValue}`.nothrow().quiet()).stdout.toString().trim() : "";
  return rootDisk ? `/dev/${rootDisk}` : "";
}

async function listCandidateDisks(): Promise<DiskCandidate[]> {
  const rootPath = await detectRootDiskPath();
  const lsblk = (await $`lsblk -dpno NAME,TYPE,SIZE,MOUNTPOINT`.text()).trim();
  const diskRows = lsblk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[1] === "disk" && parts[0] !== rootPath)
    .map((parts) => ({ path: parts[0] ?? "", sizeLabel: parts[2] ?? "" }))
    .filter((item) => item.path);

  const result: DiskCandidate[] = [];
  for (const row of diskRows) {
    const sizeBytes = Number((await $`lsblk -dbno SIZE ${row.path}`.text()).trim() || "0");
    result.push({ path: row.path, sizeBytes, sizeLabel: row.sizeLabel || formatBytes(sizeBytes) });
  }
  return result;
}

async function listPartitionCandidates(disks: DiskCandidate[]): Promise<PartitionCandidate[]> {
  const candidates: PartitionCandidate[] = [];

  for (const disk of disks) {
    const partsRaw = (await $`lsblk -rnbpo NAME,TYPE,SIZE,MOUNTPOINT ${disk.path}`.text()).trim();
    if (partsRaw) {
      for (const line of partsRaw.split("\n")) {
        const [path = "", type = "", sizeRaw = "0", ...rest] = line.trim().split(/\s+/);
        const mountpoint = rest.join(" ");
        if (type !== "part" || !path || mountpoint) {
          continue;
        }
        const sizeBytes = Number(sizeRaw) || 0;
        candidates.push({
          kind: "partition",
          source: path,
          sizeBytes,
          sizeLabel: formatBytes(sizeBytes),
          description: `${path} existing partition (${formatBytes(sizeBytes)})`
        });
      }
    }

    const parted = await $`parted -sm ${disk.path} unit MiB print free`.nothrow().quiet();
    if (parted.exitCode !== 0) {
      continue;
    }
    for (const line of parted.stdout.toString().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes(":free;")) {
        continue;
      }
      const fields = trimmed.split(":");
      if (fields.length < 5) {
        continue;
      }
      const startField = fields[1]?.replace("MiB", "") ?? "";
      const endField = fields[2]?.replace("MiB", "") ?? "";
      const sizeField = fields[3]?.replace("MiB", "") ?? "";
      const startMiB = Number(startField);
      const endMiB = Number(endField);
      const sizeMiB = Number(sizeField);
      if (!Number.isFinite(startMiB) || !Number.isFinite(endMiB) || !Number.isFinite(sizeMiB) || sizeMiB < 256) {
        continue;
      }
      candidates.push({
        kind: "free-space",
        source: disk.path,
        sizeBytes: Math.round(sizeMiB * 1024 * 1024),
        sizeLabel: `${sizeMiB >= 1024 ? `${(sizeMiB / 1024).toFixed(sizeMiB / 1024 >= 10 ? 0 : 1)}G` : `${Math.round(sizeMiB)}M`}`,
        description: `${disk.path} free space ${startField}-${endField}MiB (${formatBytes(Math.round(sizeMiB * 1024 * 1024))})`,
        startMiB: `${startField}MiB`,
        endMiB: `${endField}MiB`
      });
    }
  }

  return candidates.sort((left, right) => right.sizeBytes - left.sizeBytes);
}

function selectLargestDisk(disks: DiskCandidate[]): DiskCandidate | null {
  return disks.sort((left, right) => right.sizeBytes - left.sizeBytes)[0] ?? null;
}

function selectLargestPartitionCandidate(candidates: PartitionCandidate[]): PartitionCandidate | null {
  return candidates.sort((left, right) => right.sizeBytes - left.sizeBytes)[0] ?? null;
}

async function promptText(message: string, defaultValue = ""): Promise<string> {
  return await input({
    message,
    default: defaultValue
  });
}

async function promptSecret(message: string, defaultValue = ""): Promise<string> {
  const entered = await password({
    message: defaultValue ? `${message} (leave empty to keep current value)` : message,
    mask: "*"
  });
  return entered || defaultValue;
}

async function promptEmail(message: string, defaultValue = "", fieldName = "email"): Promise<string> {
  return await input({
    message,
    default: defaultValue,
    validate: (value) => {
      const normalized = value.trim();
      const match = normalized.match(/^[^@\s]+@([^@\s]+)$/);
      if (!match) {
        return "Enter a valid email address";
      }
      if (RESERVED_EMAIL_DOMAINS.has(match[1].toLowerCase())) {
        return "Reserved example.* domains are not accepted";
      }
      return true;
    }
  }).then((value) => validateEmail(value, fieldName));
}

async function promptLogtoAdminUsername(defaultValue = DEFAULT_LOGTO_ADMIN_USERNAME): Promise<string> {
  return await input({
    message: "Logto bootstrap admin username",
    default: defaultValue,
    validate: (value) => {
      const normalized = value.trim();
      if (!normalized) {
        return "Enter a username";
      }
      if (/[\s\x00-\x1f\x7f]/.test(normalized)) {
        return "Username must not contain whitespace or control characters";
      }
      return true;
    }
  }).then((value) => validateLogtoAdminUsername(value, "--logto-admin-username"));
}

async function promptConfirm(message: string, defaultValue: boolean, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) {
    return true;
  }
  return await confirm({ message, default: defaultValue });
}

export function externalOidcSetupInstructions(options: {
  adminGroup: string;
  idpProvider?: string;
  lxdDomain: string;
  lxdOidcGroupsClaim?: string;
  lxdOidcScopes?: string;
  manageDomain: string;
  oidcGroupsClaim?: string;
  oidcIssuer?: string;
  oidcScopes?: string;
  proxyDomain: string;
}): string {
  const effectiveProvider = resolveEffectiveIdpProvider("oidc", options.idpProvider);
  const providerConfig = {
    terrarium_oidc_groups_claim: options.oidcGroupsClaim,
    terrarium_oidc_scopes: options.oidcScopes,
    terrarium_lxd_oidc_groups_claim: options.lxdOidcGroupsClaim,
    terrarium_lxd_oidc_scopes: options.lxdOidcScopes
  };
  const oidcGroupsClaim = resolveOidcGroupsClaim(providerConfig, effectiveProvider);
  const oidcScopes = resolveOidcScopes(providerConfig, effectiveProvider);
  const lxdOidcGroupsClaim = resolveLxdOidcGroupsClaim(providerConfig, effectiveProvider);
  const lxdOidcScopes = resolveLxdOidcScopes(providerConfig, effectiveProvider);
  const zitadelGroupsClaimAction = externalZitadelGroupsClaimActionScript("replace-with-your-terrarium-project-id")
    .split("\n")
    .map((line) => `  ${line}`);
  return [
    "",
    "Before continuing, configure an OIDC application/client in your provider:",
    "",
    "  Redirect URLs:",
    `    Cockpit / oauth2-proxy: https://${options.manageDomain}/oauth2/callback`,
    `    Traefik dashboard:      https://${options.proxyDomain}/oauth2/callback`,
    `    LXD:                    https://${options.lxdDomain}/oidc/callback`,
    "",
    "  Grant/flow: authorization code",
    `  Scopes:     ${oidcScopes}`,
    `  Claim:      ${oidcGroupsClaim} must be a JSON string array containing "${options.adminGroup}"`,
    "              A provider role assignment is not enough unless it is emitted in this claim.",
    `  LXD scopes: ${lxdOidcScopes}`,
    `  LXD claim:  ${lxdOidcGroupsClaim} must be a JSON string array containing "${options.adminGroup}"`,
    ...(effectiveProvider === "zitadel"
      ? [
          "",
          "ZITADEL Cloud note:",
          "  Project role assignments are not emitted as a flat groups claim by default.",
          "  Copy the Project ID from the ZITADEL project that contains your Terrarium app.",
          "  Create an Action named groupsClaim and attach it to the Complement Token flow",
          "  for both Pre Userinfo creation and Pre access token creation:",
          "",
          ...zitadelGroupsClaimAction
        ]
      : []),
    "",
    "If your provider will not allow the LXD and web callbacks on one client,",
    "create a separate LXD client and enter it at the optional LXD prompts.",
    "",
    "Published @auth routes add route callbacks later when you create protected routes.",
    "Use https://<route-host>/oauth2/callback for a root route, or",
    "https://<route-host>/oauth2/<path>/callback for a path route such as /admin.",
    ""
  ].join("\n");
}

export function externalZitadelGroupsClaimActionScript(projectId: string): string {
  return `function groupsClaim(ctx, api) {
  var groups = [];
  var terrariumProjectId = ${JSON.stringify(projectId)};
  if (!ctx || !ctx.v1 || !ctx.v1.user || !ctx.v1.user.grants || !ctx.v1.user.grants.grants) {
    api.v1.claims.setClaim('groups', groups);
    return;
  }
  for (var i = 0; i < ctx.v1.user.grants.grants.length; i++) {
    var grant = ctx.v1.user.grants.grants[i];
    var grantProjectId = grant && (grant.projectId || grant.projectID || grant.project_id);
    if (grantProjectId !== terrariumProjectId) {
      continue;
    }
    if (!grant || !grant.roles) {
      continue;
    }
    for (var j = 0; j < grant.roles.length; j++) {
      var role = grant.roles[j];
      if (groups.indexOf(role) === -1) {
        groups.push(role);
      }
    }
  }
  api.v1.claims.setClaim('groups', groups);
}`;
}

/**
 * Collects external OIDC settings and verifies them before install continues.
 *
 * Interactive installs loop here until the issuer, client, and callback
 * registration look valid. Non-interactive installs fail earlier in validation
 * and then use the same verifier without a retry loop.
 */
async function promptAndVerifyExternalOidc(options: InstallOptions): Promise<void> {
  validateIdpProviderOption(options);
  let printedSetupInstructions = false;
  while (true) {
    options.adminGroup = await promptText("Management admin group", options.adminGroup);
    if (!options.adminGroup) {
      warn("Management admin group is required for external OIDC mode.");
      continue;
    }

    options.authDomain = "";
    options.oidcIssuer = normalizeOidcIssuer(
      await promptText("External OIDC issuer URL", options.oidcIssuer),
      "--oidc"
    );
    if (!printedSetupInstructions) {
      console.log(externalOidcSetupInstructions(options));
      printedSetupInstructions = true;
    }
    options.oidcClientId = await promptText("External OIDC client ID", options.oidcClientId);
    options.oidcClientSecret = await promptSecret("External OIDC client secret", options.oidcClientSecret);
    options.lxdOidcClientId = await promptText("Optional separate LXD OIDC client ID", options.lxdOidcClientId);
    options.lxdOidcClientSecret = options.lxdOidcClientId
      ? await promptSecret("Optional separate LXD OIDC client secret", options.lxdOidcClientSecret)
      : "";

    if (!options.oidcClientId) {
      warn("OIDC client ID is required for external OIDC mode.");
      continue;
    }
    if (!options.oidcClientSecret) {
      warn("OIDC client secret is required for external OIDC mode.");
      continue;
    }

    try {
      const verification = await verifyOidcConfig({
        issuer: options.oidcIssuer,
        clientId: options.oidcClientId,
        clientSecret: options.oidcClientSecret,
        lxdClientId: options.lxdOidcClientId || options.oidcClientId,
        lxdClientSecret: options.lxdOidcClientId ? options.lxdOidcClientSecret : options.oidcClientSecret,
        manageDomain: options.manageDomain,
        proxyDomain: options.proxyDomain,
        lxdDomain: options.lxdDomain
      });
      options.oidcIssuer = verification.issuer;
      info("OIDC verification passed.");
      return;
    } catch (error) {
      warn(`OIDC verification failed: ${String(error).replace(/^Error: /, "")}`);
      if (!(await promptConfirm("Update the OIDC settings and try again?", true, false))) {
        fail("aborted");
      }
    }
  }
}

/**
 * Collects S3 settings and verifies them with a real write/delete probe.
 *
 * This loop is intentionally strict because backup destinations are easy to
 * misconfigure in ways that only show up when a restore is already urgent.
 */
async function promptAndVerifyS3(options: InstallOptions): Promise<void> {
  while (true) {
    options.s3Endpoint = normalizeS3Endpoint(await promptText("S3 endpoint", options.s3Endpoint || "https://s3.amazonaws.com"));
    options.s3Bucket = await promptText("S3 bucket", options.s3Bucket);
    options.s3Region = await promptText("S3 region", options.s3Region || "us-east-1");
    options.s3Prefix = await promptText("S3 prefix", options.s3Prefix || "terrarium");
    options.s3AccessKey = await promptText("S3 access key", options.s3AccessKey);
    options.s3SecretKey = await promptSecret("S3 secret key", options.s3SecretKey);

    if (!options.s3Bucket || !options.s3AccessKey || !options.s3SecretKey) {
      warn("S3 bucket, access key, and secret key are all required.");
      continue;
    }

    try {
      await verifyS3Config({
        endpoint: options.s3Endpoint,
        bucket: options.s3Bucket,
        region: options.s3Region || "us-east-1",
        prefix: options.s3Prefix || "terrarium",
        accessKey: options.s3AccessKey,
        secretKey: options.s3SecretKey
      });
      info("S3 verification passed.");
      return;
    } catch (error) {
      warn(`S3 verification failed: ${String(error).replace(/^Error: /, "")}`);
      if (!(await promptConfirm("Update the S3 settings and try again?", true, false))) {
        fail("aborted");
      }
    }
  }
}

async function enableAndVerifyS3(options: InstallOptions): Promise<void> {
  options.enableS3 = true;
  await promptAndVerifyS3(options);
}

function disableS3(options: InstallOptions): void {
  options.enableS3 = false;
  options.s3Endpoint = "";
  options.s3Bucket = "";
  options.s3Region = "";
  options.s3AccessKey = "";
  options.s3SecretKey = "";
}

async function enableSyncoid(options: InstallOptions): Promise<void> {
  options.enableSyncoid = true;
  options.syncoidTarget = await promptText("syncoid SSH target (user@host)", options.syncoidTarget);
  options.syncoidTargetDataset = await promptText("Remote dataset", options.syncoidTargetDataset || "backup/terrarium");
  options.syncoidSshKey = await promptText("SSH private key path", options.syncoidSshKey || "/root/.ssh/id_ed25519");
}

function disableSyncoid(options: InstallOptions): void {
  options.enableSyncoid = false;
  options.syncoidTarget = "";
  options.syncoidTargetDataset = "";
  options.syncoidSshKey = "";
}

export function installReviewSummary(options: Pick<
  InstallOptions,
  | "enableS3"
  | "enableSyncoid"
  | "s3Bucket"
  | "s3Endpoint"
  | "s3Prefix"
  | "syncoidTarget"
  | "syncoidTargetDataset"
>): string {
  return [
    "",
    "Review optional integrations before install:",
    `  S3 archive backups: ${options.enableS3 ? `enabled (${options.s3Bucket || "bucket not set"} at ${options.s3Endpoint || "endpoint not set"}, prefix ${options.s3Prefix || "terrarium"})` : "disabled"}`,
    `  syncoid replication: ${options.enableSyncoid ? `enabled (${options.syncoidTarget || "target not set"}:${options.syncoidTargetDataset || "dataset not set"})` : "disabled"}`,
    ""
  ].join("\n");
}

async function reviewOptionalIntegrations(options: InstallOptions): Promise<void> {
  while (true) {
    console.log(installReviewSummary(options));
    const action = await select({
      message: "Continue with these optional integrations?",
      choices: [
        { name: "Continue install", value: "continue" },
        { name: options.enableS3 ? "Edit S3 archive backups" : "Configure S3 archive backups", value: "edit-s3" },
        ...(options.enableS3 ? [{ name: "Disable S3 archive backups", value: "disable-s3" }] : []),
        { name: options.enableSyncoid ? "Edit syncoid replication" : "Configure syncoid replication", value: "edit-syncoid" },
        ...(options.enableSyncoid ? [{ name: "Disable syncoid replication", value: "disable-syncoid" }] : []),
        { name: "Cancel install", value: "cancel" }
      ]
    });

    switch (action) {
      case "continue":
        return;
      case "edit-s3":
        await enableAndVerifyS3(options);
        break;
      case "disable-s3":
        disableS3(options);
        break;
      case "edit-syncoid":
        await enableSyncoid(options);
        break;
      case "disable-syncoid":
        disableSyncoid(options);
        break;
      case "cancel":
        fail("aborted");
        break;
    }
  }
}

/** Runs non-interactive preflight checks for integrations that commonly fail from configuration drift. */
async function verifyConfiguredIntegrations(options: InstallOptions): Promise<void> {
  if (options.idpMode === "oidc") {
    const verification = await verifyOidcConfig({
      issuer: options.oidcIssuer,
      clientId: options.oidcClientId,
      clientSecret: options.oidcClientSecret,
      lxdClientId: options.lxdOidcClientId || options.oidcClientId,
      lxdClientSecret: options.lxdOidcClientId ? options.lxdOidcClientSecret : options.oidcClientSecret,
      manageDomain: options.manageDomain,
      proxyDomain: options.proxyDomain,
      lxdDomain: options.lxdDomain
    });
    options.oidcIssuer = verification.issuer;
  }

  if (options.enableS3) {
    await verifyS3Config({
      endpoint: options.s3Endpoint,
      bucket: options.s3Bucket,
      region: options.s3Region || "us-east-1",
      prefix: options.s3Prefix || "terrarium",
      accessKey: options.s3AccessKey,
      secretKey: options.s3SecretKey
    });
  }
}

function applyPartitionCandidate(options: InstallOptions, candidate: PartitionCandidate): void {
  options.storageSource = candidate.source;
  if (candidate.kind === "free-space") {
    options.storagePartitionStart = candidate.startMiB;
    options.storagePartitionEnd = partitionEndForCandidate(candidate, options.storageSize);
  } else {
    options.storagePartitionStart = "";
    options.storagePartitionEnd = "";
  }
}

export function partitionEndForCandidate(candidate: Extract<PartitionCandidate, { kind: "free-space" }>, storageSize: string): string {
  const requestedMiB = parseStorageSizeMiB(storageSize);
  if (!requestedMiB) {
    return candidate.endMiB;
  }

  const startMiB = Number(candidate.startMiB.replace(/MiB$/i, ""));
  const candidateEndMiB = Number(candidate.endMiB.replace(/MiB$/i, ""));
  if (!Number.isFinite(startMiB) || !Number.isFinite(candidateEndMiB)) {
    return candidate.endMiB;
  }

  const requestedEndMiB = startMiB + requestedMiB;
  if (requestedEndMiB > candidateEndMiB) {
    fail(`--storage-size ${storageSize} does not fit in discovered free space ${candidate.startMiB}-${candidate.endMiB}`);
  }

  return `${Math.round(requestedEndMiB)}MiB`;
}

function parseStorageSizeMiB(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  const match = normalized.match(/^(\d+(?:\.\d+)?)([kmgt]?i?b?)?$/i);
  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }

  const unit = (match[2] || "mib").toLowerCase();
  const multiplier =
    unit.startsWith("t") ? 1024 * 1024 :
    unit.startsWith("g") ? 1024 :
    unit.startsWith("k") ? 1 / 1024 :
    1;
  return Math.ceil(amount * multiplier);
}

async function resolveAutoStorageSource(options: InstallOptions, disks: DiskCandidate[], partitions: PartitionCandidate[]): Promise<void> {
  if (options.storageSource !== "auto") {
    return;
  }
  if (options.storageMode === "disk") {
    const disk = selectLargestDisk(disks);
    if (!disk) {
      fail("no allocatable non-root disk found for --storage-source=auto");
    }
    options.storageSource = disk.path;
    return;
  }
  if (options.storageMode === "partition") {
    const candidate = selectLargestPartitionCandidate(partitions);
    if (!candidate) {
      fail("no allocatable partition target found for --storage-source=auto");
    }
    applyPartitionCandidate(options, candidate);
  }
}

async function interactiveConfig(options: InstallOptions): Promise<void> {
  options.publicIp = await detectPublicIp(options.publicIp);
  const dashed = dashedIp(options.publicIp);

  options.email = options.email || (await promptEmail("Terrarium contact/admin email", `admin@${options.publicIp}.nip.io`, "--email"));
  options.acmeEmail = options.acmeEmail || (await promptEmail("ACME account email", options.email, "--acme-email"));
  options.zitadelAdminEmail = options.zitadelAdminEmail || options.email;
  if (!options.rootPassword && rootPasswordState() !== "usable") {
    info("Root has no usable local password. Cockpit requires one for login.");
    options.rootPassword = await promptPasswordWithConfirmation("Set a root password for Cockpit");
  }

  if (!options.domain && !options.manageDomain) {
    options.manageDomain = `manage.${dashed}.traefik.me`;
  }
  if (!options.domain && !options.proxyDomain) {
    options.proxyDomain = `proxy.${dashed}.traefik.me`;
  }
  if (!options.domain && !options.lxdDomain) {
    options.lxdDomain = `lxd.${dashed}.traefik.me`;
  }

  if (options.domain) {
    options.manageDomain = options.manageDomain || `manage.${options.domain}`;
    options.proxyDomain = options.proxyDomain || `proxy.${options.domain}`;
    options.lxdDomain = options.lxdDomain || `lxd.${options.domain}`;
  } else {
    options.manageDomain = await promptText("Cockpit domain", options.manageDomain);
    options.proxyDomain = await promptText("Traefik dashboard domain", options.proxyDomain);
    options.lxdDomain = await promptText("LXD domain", options.lxdDomain);
  }

  if (!options.idpMode) {
    options.idpMode = (await select({
      message: "Identity provider mode",
      choices: [
        { name: "local", value: "local" },
        { name: "oidc", value: "oidc" }
      ]
    })) as IdpMode;
  }

  validateIdpProviderOption(options);

  if (options.idpMode === "local") {
    options.adminGroup = options.adminGroup || "terrarium-admins";
    options.authDomain =
      options.authDomain ||
      (options.domain ? `auth.${options.domain}` : `auth.${dashed}.traefik.me`);
    const localProvider = resolveEffectiveIdpProvider("local", options.idpProvider);
    const authDomainPrompt = localProvider === "logto" ? "Logto auth domain" : "ZITADEL auth domain";
    options.authDomain = await promptText(authDomainPrompt, options.authDomain);
    options.oidcIssuer = normalizeOidcIssuer(resolveLocalOidcIssuer(options.authDomain, localProvider), "--oidc");
    if (localProvider === "zitadel") {
      options.zitadelAdminEmail = await promptEmail(
        "ZITADEL bootstrap admin email",
        options.zitadelAdminEmail || options.email,
        "--zitadel-admin-email"
      );
    } else {
      options.logtoAdminEmail = await promptEmail(
        "Logto bootstrap admin email",
        options.logtoAdminEmail || options.email,
        "--logto-admin-email"
      );
      options.logtoAdminUsername = await promptLogtoAdminUsername(options.logtoAdminUsername || DEFAULT_LOGTO_ADMIN_USERNAME);
    }
  } else {
    await promptAndVerifyExternalOidc(options);
  }

  const disks = await listCandidateDisks();
  const partitionCandidates = await listPartitionCandidates(disks);
  if (disks.length > 0) {
    for (const disk of disks) {
      info(`detected extra disk: ${disk.path} ${disk.sizeLabel}`.trim());
    }
    if (!options.storageMode) {
      options.storageMode = (await select({
        message: "Choose storage mode",
        choices: [
          { name: "disk", value: "disk" },
          { name: "partition", value: "partition" },
          { name: "file", value: "file" }
        ]
      })) as StorageMode;
    }
  } else {
    info("No extra block volume detected.");
    info("Recommended production setup: attach block storage to the VPS and re-run Terrarium.");
    info("Falling back to file mode keeps everything on the root filesystem.");
    options.storageMode = options.storageMode || "file";
  }

  switch (options.storageMode) {
    case "disk": {
      await resolveAutoStorageSource(options, disks, partitionCandidates);
      if (!options.storageSource) {
        const suggested = selectLargestDisk(disks);
        if (!suggested) {
          fail("disk mode requires a non-root disk, but none were detected");
        }
        info(`Suggested disk target: ${suggested.path} (${suggested.sizeLabel})`);
        if (!(await promptConfirm(`Use ${suggested.path} for whole-disk ZFS storage?`, true, options.assumeYes))) {
          options.storageSource = await promptText("Storage source disk", suggested.path);
        } else {
          options.storageSource = suggested.path;
        }
      }
      if (!options.storageSource) {
        fail("storage source is required for disk mode");
      }
      break;
    }
    case "partition": {
      await resolveAutoStorageSource(options, disks, partitionCandidates);
      if (!options.storageSource) {
        const suggested = selectLargestPartitionCandidate(partitionCandidates);
        if (!suggested) {
          fail("partition mode requires allocatable free space or an unused partition, but none were found");
        }
        info(`Suggested partition target: ${suggested.description}`);
        if (!(await promptConfirm(`Use ${suggested.description}?`, true, options.assumeYes))) {
          const chosen = (await select({
            message: "Choose allocatable partition target",
            choices: partitionCandidates.map((candidate) => ({
              name: candidate.description,
              value: JSON.stringify(candidate)
            }))
          })) as string;
          applyPartitionCandidate(options, JSON.parse(chosen) as PartitionCandidate);
        } else {
          applyPartitionCandidate(options, suggested);
        }
      }
      if (!options.storageSource) {
        fail("storage source is required for partition mode");
      }
      break;
    }
    case "file":
      options.storageSize = options.storageSize || (await promptText("File-backed ZFS pool size", "64G"));
      options.storagePartitionStart = "";
      options.storagePartitionEnd = "";
      break;
    default:
      fail(`unsupported storage mode: ${options.storageMode}`);
  }

  if (await promptConfirm("Configure S3 archive backups?", false, options.assumeYes)) {
    await enableAndVerifyS3(options);
  }

  if (await promptConfirm("Configure syncoid replication to another ZFS host?", false, options.assumeYes)) {
    await enableSyncoid(options);
  }

  await reviewOptionalIntegrations(options);
}

function validateIdpProviderOption(options: InstallOptions): void {
  const explicitProvider = options.idpProvider.trim();
  if (!explicitProvider) {
    return;
  }
  try {
    options.idpProvider = validatePublicIdpProvider(explicitProvider);
  } catch (error) {
    fail(String(error).replace(/^Error: /, ""));
  }
}

function validateNonInteractive(options: InstallOptions): void {
  validateIdpProviderOption(options);
  if (!options.idpMode) {
    fail("--idp must be either local or oidc");
  }
  if (!["local", "oidc"].includes(options.idpMode)) {
    fail(`invalid --idp value: ${options.idpMode}`);
  }
  const dashed = dashedIp(options.publicIp);
  options.manageDomain = options.manageDomain || (options.domain ? `manage.${options.domain}` : `manage.${dashed}.traefik.me`);
  options.proxyDomain = options.proxyDomain || (options.domain ? `proxy.${options.domain}` : `proxy.${dashed}.traefik.me`);
  options.lxdDomain = options.lxdDomain || (options.domain ? `lxd.${options.domain}` : `lxd.${dashed}.traefik.me`);

  if (!options.email) {
    fail("--email is required in non-interactive mode");
  }
  options.email = validateEmail(options.email, "--email");
  options.acmeEmail = validateEmail(options.acmeEmail || options.email, "--acme-email");
  if (!options.rootPassword && rootPasswordState() !== "usable") {
    fail("--generate-root-pwd or --root-pwd-file is required in non-interactive mode when root has no usable local password");
  }

  if (options.idpMode === "local") {
    const localProvider = resolveEffectiveIdpProvider("local", options.idpProvider);
    options.adminGroup = options.adminGroup || "terrarium-admins";
    options.authDomain = options.authDomain || (options.domain ? `auth.${options.domain}` : `auth.${dashed}.traefik.me`);
    options.oidcIssuer = normalizeOidcIssuer(resolveLocalOidcIssuer(options.authDomain, localProvider), "--oidc");
    if (localProvider === "zitadel") {
      options.zitadelAdminEmail = options.zitadelAdminEmail || options.email;
      options.zitadelAdminEmail = validateEmail(options.zitadelAdminEmail, "--zitadel-admin-email");
    } else {
      options.logtoAdminEmail = options.logtoAdminEmail || options.email;
      options.logtoAdminEmail = validateEmail(options.logtoAdminEmail, "--logto-admin-email");
      options.logtoAdminUsername = validateLogtoAdminUsername(
        options.logtoAdminUsername || DEFAULT_LOGTO_ADMIN_USERNAME,
        "--logto-admin-username"
      );
    }
    options.oidcClientId = "";
    options.oidcClientSecret = "";
    options.lxdOidcClientId = "";
    options.lxdOidcClientSecret = "";
  } else {
    if (!options.adminGroup) {
      fail("--admin-group is required when --idp=oidc");
    }
    options.authDomain = "";
    if (!options.oidcIssuer) {
      fail("--oidc is required when --idp=oidc");
    }
    options.oidcIssuer = normalizeOidcIssuer(options.oidcIssuer, "--oidc");
    if (!options.oidcClientId) {
      fail("--oidc-client is required when --idp=oidc");
    }
    if (!options.oidcClientSecret) {
      fail("--oidc-secret is required when --idp=oidc");
    }
    if (options.lxdOidcClientSecret && !options.lxdOidcClientId) {
      fail("--lxd-oidc-client is required when --lxd-oidc-secret or --lxd-oidc-secret-file is used");
    }
  }

  if (!options.storageMode) {
    fail("--storage-mode is required in non-interactive mode");
  }

  switch (options.storageMode) {
    case "disk":
    case "partition":
      if (!options.storageSource) {
        fail(`--storage-source is required for ${options.storageMode}`);
      }
      if (options.storageSource === "auto") {
        fail(`--storage-source=auto must be resolved before validation for ${options.storageMode}`);
      }
      break;
    case "file":
      options.storageSize = options.storageSize || "64G";
      options.storagePartitionStart = "";
      options.storagePartitionEnd = "";
      break;
    default:
      fail(`invalid --storage-mode value: ${options.storageMode}`);
  }

  if (options.enableS3) {
    if (!options.s3Bucket) {
      fail("--s3-bucket is required when S3 is enabled");
    }
    if (!options.s3AccessKey) {
      fail("--s3-access-key is required when S3 is enabled");
    }
    if (!options.s3SecretKey) {
      fail("--s3-secret-key is required when S3 is enabled");
    }
    options.s3Endpoint = normalizeS3Endpoint(options.s3Endpoint || "https://s3.amazonaws.com");
    options.s3Region = options.s3Region || "us-east-1";
  }

  if (options.enableSyncoid) {
    if (!options.syncoidTarget) {
      fail("--syncoid-target is required when syncoid is enabled");
    }
    if (!options.syncoidTargetDataset) {
      fail("--syncoid-target-dataset is required when syncoid is enabled");
    }
    options.syncoidSshKey = options.syncoidSshKey || "/root/.ssh/id_ed25519";
  }
}

async function resolveNonInteractiveStorage(options: InstallOptions): Promise<void> {
  const disks = await listCandidateDisks();
  const partitionCandidates = await listPartitionCandidates(disks);
  await resolveAutoStorageSource(options, disks, partitionCandidates);
}

async function confirmDestructiveActions(options: InstallOptions): Promise<void> {
  switch (options.storageMode) {
    case "disk":
      if (!(await promptConfirm(`Terrarium will WIPE ${options.storageSource}. Continue?`, false, options.assumeYes))) {
        fail("aborted");
      }
      break;
    case "partition":
      if (
        options.storageSource &&
        existsSync(options.storageSource) &&
        !(await promptConfirm(
          options.storagePartitionStart && options.storagePartitionEnd
            ? `Terrarium will create a partition on ${options.storageSource} in free space ${options.storagePartitionStart}-${options.storagePartitionEnd}. Continue?`
            : `Terrarium may repartition ${options.storageSource}. Continue?`,
          false,
          options.assumeYes
        ))
      ) {
        fail("aborted");
      }
      break;
  }
}

export function buildConfig(options: InstallOptions): string {
  const config: Record<string, unknown> = {
    terrarium_repo_dir: REPO_DIR,
    terrarium_public_ip: options.publicIp,
    terrarium_root_domain: options.domain,
    terrarium_email: options.email,
    terrarium_acme_email: options.acmeEmail,
    terrarium_manage_domain: options.manageDomain,
    terrarium_proxy_domain: options.proxyDomain,
    terrarium_lxd_domain: options.lxdDomain,
    terrarium_idp_mode: options.idpMode,
    terrarium_admin_group: options.adminGroup,
    terrarium_auth_domain: options.authDomain,
    terrarium_oidc_issuer: options.oidcIssuer,
    terrarium_oidc_client_id: options.oidcClientId,
    terrarium_oidc_client_secret: options.oidcClientSecret,
    terrarium_lxd_oidc_client_id: options.lxdOidcClientId,
    terrarium_lxd_oidc_client_secret: options.lxdOidcClientSecret,
    terrarium_zitadel_admin_email: options.zitadelAdminEmail,
    terrarium_logto_admin_email: options.logtoAdminEmail,
    terrarium_logto_admin_username: options.logtoAdminUsername,
    terrarium_storage_mode: options.storageMode,
    terrarium_storage_source: options.storageSource,
    terrarium_storage_size: options.storageSize,
    terrarium_storage_partition_start: options.storagePartitionStart,
    terrarium_storage_partition_end: options.storagePartitionEnd,
    terrarium_enable_s3: options.enableS3,
    terrarium_s3_endpoint: options.s3Endpoint,
    terrarium_s3_bucket: options.s3Bucket,
    terrarium_s3_region: options.s3Region,
    terrarium_s3_prefix: options.s3Prefix,
    terrarium_s3_access_key: options.s3AccessKey,
    terrarium_s3_secret_key: options.s3SecretKey,
    terrarium_enable_syncoid: options.enableSyncoid,
    terrarium_syncoid_target: options.syncoidTarget,
    terrarium_syncoid_target_dataset: options.syncoidTargetDataset,
    terrarium_syncoid_ssh_key: options.syncoidSshKey
  };

  for (const [key, value] of Object.entries({
    terrarium_idp_provider: options.idpProvider,
    terrarium_oidc_groups_claim: options.oidcGroupsClaim,
    terrarium_oidc_scopes: options.oidcScopes,
    terrarium_lxd_oidc_groups_claim: options.lxdOidcGroupsClaim,
    terrarium_lxd_oidc_scopes: options.lxdOidcScopes,
    terrarium_local_idp_outputs_path: options.localIdpOutputsPath
  })) {
    const trimmed = value.trim();
    if (trimmed) {
      config[key] = trimmed;
    }
  }

  return stringify(config);
}

function buildSecretConfig(options: InstallOptions): string {
  return stringify({
    terrarium_root_password_plaintext: options.rootPassword
  });
}

async function runPlaybook(configPath: string, secretConfigPath: string): Promise<void> {
  await $`cd ${join(REPO_DIR, "ansible")}; ${TERRARIUM_ANSIBLE_PLAYBOOK} -i inventory.ini site.yml -e @${configPath} -e @${secretConfigPath}`;
}

function printDnsGuidance(options: InstallOptions): void {
  const dashed = dashedIp(options.publicIp);
  const defaultManage = `manage.${dashed}.traefik.me`;
  const defaultProxy = `proxy.${dashed}.traefik.me`;
  const defaultLxd = `lxd.${dashed}.traefik.me`;
  const defaultAuth = `auth.${dashed}.traefik.me`;

  if (
    options.domain ||
    options.manageDomain !== defaultManage ||
    options.proxyDomain !== defaultProxy ||
    options.lxdDomain !== defaultLxd ||
    (options.idpMode === "local" && options.authDomain !== defaultAuth)
  ) {
    info("DNS records to create if you are using custom domains:");
    info(`  A ${options.manageDomain} -> ${options.publicIp}`);
    info(`  A ${options.proxyDomain} -> ${options.publicIp}`);
    info(`  A ${options.lxdDomain} -> ${options.publicIp}`);
    if (options.idpMode === "local") {
      info(`  A ${options.authDomain} -> ${options.publicIp}`);
    }
  }
}

export function defaultOptions(): InstallOptions {
  return {
    ref: "main",
    mode: "interactive",
    assumeYes: false,
    publicIp: "",
    email: "",
    acmeEmail: "",
    domain: "",
    manageDomain: "",
    proxyDomain: "",
    lxdDomain: "",
    idpMode: "",
    adminGroup: "",
    authDomain: "",
    oidcIssuer: "",
    oidcClientId: "",
    oidcClientSecret: "",
    lxdOidcClientId: "",
    lxdOidcClientSecret: "",
    idpProvider: "",
    oidcGroupsClaim: "",
    oidcScopes: "",
    lxdOidcGroupsClaim: "",
    lxdOidcScopes: "",
    localIdpOutputsPath: "",
    zitadelAdminEmail: "",
    logtoAdminEmail: "",
    logtoAdminUsername: "",
    rootPassword: "",
    generateRootPassword: false,
    generatedRootPasswordPath: "",
    storageMode: "",
    storageSource: "",
    storageSize: "",
    storagePartitionStart: "",
    storagePartitionEnd: "",
    enableS3: false,
    s3Endpoint: "",
    s3Bucket: "",
    s3Region: "",
    s3Prefix: "terrarium",
    s3AccessKey: "",
    s3SecretKey: "",
    enableSyncoid: false,
    syncoidTarget: "",
    syncoidTargetDataset: "",
    syncoidSshKey: ""
  };
}

export function readCliOption(rawOptions: Record<string, unknown>, key: string, aliases: string[] = []): string {
  const candidates = [key, ...aliases];
  for (const candidate of candidates) {
    const value = rawOptions[candidate];
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number") {
      return rawCliOption(candidates) ?? String(value);
    }
  }
  return "";
}

function rawCliOption(names: string[]): string | undefined {
  const longNames = new Set(names.map((name) => `--${name}`));
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (longNames.has(arg)) {
      return process.argv[index + 1];
    }
    for (const longName of longNames) {
      if (arg.startsWith(`${longName}=`)) {
        return arg.slice(longName.length + 1);
      }
    }
  }
  return undefined;
}

function readSecretCliOption(
  rawOptions: Record<string, unknown>,
  key: string,
  fileKey: string,
  aliases: string[] = [],
  fileAliases: string[] = []
): string {
  const inlineValue = readCliOption(rawOptions, key, aliases);
  const filePath = readCliOption(rawOptions, fileKey, fileAliases);
  if (inlineValue && filePath) {
    fail(`use only one of --${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} or --${fileKey.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`);
  }
  if (!filePath) {
    return inlineValue;
  }
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch (error) {
    fail(`failed to read secret file ${filePath}: ${String(error).replace(/^Error: /, "")}`);
  }
}

function readSecretFileCliOption(rawOptions: Record<string, unknown>, fileKey: string, fileAliases: string[] = []): string {
  const filePath = readCliOption(rawOptions, fileKey, fileAliases);
  if (!filePath) {
    return "";
  }
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch (error) {
    fail(`failed to read secret file ${filePath}: ${String(error).replace(/^Error: /, "")}`);
  }
}

async function installTerrarium(options: InstallOptions): Promise<void> {
  printSplash();
  requireRoot();
  ensureOs();

  if (await handleExistingInteractiveInstall(options)) {
    success("Terrarium update finished.");
    return;
  }

  await ensureDeps();
  await prepareRepo(options.ref);

  options.publicIp = await detectPublicIp(options.publicIp);
  applyGeneratedRootPassword(options);
  if (options.mode === "interactive") {
    await interactiveConfig(options);
  } else {
    await resolveNonInteractiveStorage(options);
    validateNonInteractive(options);
    await verifyConfiguredIntegrations(options);
  }

  validateIdpProviderOption(options);

  await confirmDestructiveActions(options);

  const tempDir = mkdtempSync(join(tmpdir(), "terrarium-config-"));
  const configPath = join(tempDir, "config.yml");
  const secretConfigPath = join(tempDir, "secrets.yml");
  writeFileSync(configPath, buildConfig(options), { encoding: "utf8", mode: 0o600 });
  writeFileSync(secretConfigPath, buildSecretConfig(options), { encoding: "utf8", mode: 0o600 });

  try {
    printDnsGuidance(options);
    await runPlaybook(configPath, secretConfigPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  success("Terrarium installation finished.");
  console.log(`${chalk.cyan("Cockpit:")} ${chalk.white(`https://${options.manageDomain}`)}`);
  console.log(`${chalk.cyan("Traefik dashboard:")} ${chalk.white(`https://${options.proxyDomain}`)}`);
  console.log(`${chalk.cyan("LXD UI/API:")} ${chalk.white(`https://${options.lxdDomain}`)}`);
  if (options.idpMode === "local") {
    const localProvider = resolveEffectiveIdpProvider("local", options.idpProvider);
    const providerLabel = localProvider === "logto" ? "Logto" : "ZITADEL";
    const passwordPath = localProvider === "logto" ? LOGTO_ADMIN_PASSWORD_PATH : "/etc/terrarium/secrets/zitadel_admin_password";
    console.log(`${chalk.cyan(`${providerLabel}:`)} ${chalk.white(`https://${options.authDomain}`)}`);
    console.log(`${chalk.cyan(`${providerLabel} bootstrap password:`)} ${chalk.white(`lxc exec terrarium-idp -- cat ${passwordPath}`)}`);
  }
  console.log(`${chalk.cyan("OIDC issuer:")} ${chalk.white(options.oidcIssuer)}`);
  console.log(`${chalk.cyan("Management admin group:")} ${chalk.white(options.adminGroup)}`);
  console.log(`${chalk.cyan("Saved config:")} ${chalk.white("LXD dqlite store (run terrariumctl config export for a YAML copy)")}`);
  if (options.generatedRootPasswordPath) {
    console.log(`${chalk.cyan("Cockpit login:")} ${chalk.white(`generated root password saved to ${options.generatedRootPasswordPath}`)}`);
  } else if (options.rootPassword) {
    console.log(`${chalk.cyan("Cockpit login:")} ${chalk.white("root password was set during install")}`);
  }
}

export function registerInstallCommand(cli: CAC): void {
  cli
    .command("install", "Install Terrarium on the current host")
    .option("--non-interactive", "Disable prompts and require full configuration through flags")
    .option("--yes", "Assume yes for confirmation prompts")
    .option("--ref <ref>", "Git branch or tag to checkout for the Terrarium repo", STRING_OPTION)
    .option("--email <email>", "Terrarium contact/admin email", STRING_OPTION)
    .option("--acme-email <email>", "ACME account email for Traefik and LXD", STRING_OPTION)
    .option("--domain <domain>", "Root domain used to derive service subdomains", STRING_OPTION)
    .option("--manage-domain <domain>", "Cockpit domain", STRING_OPTION)
    .option("--proxy-domain <domain>", "Traefik dashboard domain", STRING_OPTION)
    .option("--lxd-domain <domain>", "LXD domain", STRING_OPTION)
    .option("--idp <mode>", "Identity provider mode: local or oidc", STRING_OPTION)
    .option("--idp-provider <provider>", `External IDP provider defaults: ${PUBLIC_IDP_PROVIDERS.join(" or ")}`, STRING_OPTION)
    .option("--oidc-groups-claim <claim>", "Management OIDC groups claim override", STRING_OPTION)
    .option("--oidc-scopes <scopes>", "Management OIDC scopes override", STRING_OPTION)
    .option("--lxd-oidc-groups-claim <claim>", "LXD OIDC groups claim override", STRING_OPTION)
    .option("--lxd-oidc-scopes <scopes>", "LXD OIDC scopes override", STRING_OPTION)
    .option("--local-idp-outputs-path <path>", "Path to local IDP generated app outputs", STRING_OPTION)
    .option("--admin-group <group>", "Management admin group; required when --idp=oidc", STRING_OPTION)
    .option("--oidc <issuer>", "OIDC issuer URL; required when --idp=oidc", STRING_OPTION)
    .option("--oidc-client <clientId>", "OIDC client ID; required when --idp=oidc", STRING_OPTION)
    .option("--oidc-secret <clientSecret>", "OIDC client secret; required when --idp=oidc", STRING_OPTION)
    .option("--oidc-secret-file <path>", "Read the OIDC client secret from a root-readable file", STRING_OPTION)
    .option("--lxd-oidc-client <clientId>", "Optional separate OIDC client ID for LXD", STRING_OPTION)
    .option("--lxd-oidc-secret <clientSecret>", "Optional separate OIDC client secret for LXD", STRING_OPTION)
    .option("--lxd-oidc-secret-file <path>", "Read the optional LXD OIDC client secret from a root-readable file", STRING_OPTION)
    .option("--auth-domain <domain>", "Local identity-provider auth domain", STRING_OPTION)
    .option("--zitadel-admin-email <email>", "Bootstrap admin email for self-hosted ZITADEL", STRING_OPTION)
    .option("--logto-admin-email <email>", "Bootstrap admin email for self-hosted Logto", STRING_OPTION)
    .option("--logto-admin-username <username>", "Bootstrap admin username for self-hosted Logto", STRING_OPTION)
    .option("--generate-root-pwd", "Generate the Cockpit root password and save it under /etc/terrarium/secrets")
    .option("--root-pwd-file <path>", "Read the root password used for Cockpit login from a root-readable file", STRING_OPTION)
    .option("--storage-mode <mode>", "Storage mode: disk, partition, or file", STRING_OPTION)
    .option("--storage-source <pathOrAuto>", "Disk or partition path for disk/partition mode, or auto", STRING_OPTION)
    .option("--storage-size <size>", "File-backed pool size", STRING_OPTION)
    .option("--enable-s3", "Enable S3 archive backups")
    .option("--s3-endpoint <url>", "S3 endpoint URL", STRING_OPTION)
    .option("--s3-bucket <name>", "S3 bucket name", STRING_OPTION)
    .option("--s3-region <name>", "S3 region", STRING_OPTION)
    .option("--s3-prefix <prefix>", "S3 object prefix", STRING_OPTION)
    .option("--s3-access-key <key>", "S3 access key", STRING_OPTION)
    .option("--s3-secret-key <secret>", "S3 secret key", STRING_OPTION)
    .option("--s3-secret-key-file <path>", "Read the S3 secret key from a root-readable file", STRING_OPTION)
    .option("--enable-syncoid", "Enable syncoid replication")
    .option("--syncoid-target <host>", "Remote syncoid SSH target", STRING_OPTION)
    .option("--syncoid-target-dataset <dataset>", "Remote syncoid dataset", STRING_OPTION)
    .option("--syncoid-ssh-key <path>", "SSH key path for syncoid", STRING_OPTION)
    .action(async (rawOptions) => {
      const cliOptions = rawOptions as Record<string, unknown>;
      const options = defaultOptions();
      options.ref = readCliOption(cliOptions, "ref") || options.ref;
      options.mode = Boolean(cliOptions.nonInteractive) ? "non-interactive" : "interactive";
      options.assumeYes = Boolean(cliOptions.yes);
      options.email = readCliOption(cliOptions, "email");
      options.acmeEmail = readCliOption(cliOptions, "acmeEmail", ["acme-email"]);
      options.domain = readCliOption(cliOptions, "domain");
      options.manageDomain = readCliOption(cliOptions, "manageDomain", ["manage-domain"]);
      options.proxyDomain = readCliOption(cliOptions, "proxyDomain", ["proxy-domain"]);
      options.lxdDomain = readCliOption(cliOptions, "lxdDomain", ["lxd-domain"]);
      options.idpMode = readCliOption(cliOptions, "idp").trim().toLowerCase() as IdpMode | "";
      options.idpProvider = readCliOption(cliOptions, "idpProvider", ["idp-provider"]);
      options.oidcGroupsClaim = readCliOption(cliOptions, "oidcGroupsClaim", ["oidc-groups-claim"]);
      options.oidcScopes = readCliOption(cliOptions, "oidcScopes", ["oidc-scopes"]);
      options.lxdOidcGroupsClaim = readCliOption(cliOptions, "lxdOidcGroupsClaim", ["lxd-oidc-groups-claim"]);
      options.lxdOidcScopes = readCliOption(cliOptions, "lxdOidcScopes", ["lxd-oidc-scopes"]);
      options.localIdpOutputsPath = readCliOption(cliOptions, "localIdpOutputsPath", ["local-idp-outputs-path"]);
      options.adminGroup = readCliOption(cliOptions, "adminGroup", ["admin-group"]);
      options.oidcIssuer = readCliOption(cliOptions, "oidc");
      options.oidcClientId = readCliOption(cliOptions, "oidcClient", ["oidc-client"]);
      options.oidcClientSecret = readSecretCliOption(
        cliOptions,
        "oidcSecret",
        "oidcSecretFile",
        ["oidc-secret"],
        ["oidc-secret-file"]
      );
      options.lxdOidcClientId = readCliOption(cliOptions, "lxdOidcClient", ["lxd-oidc-client"]);
      options.lxdOidcClientSecret = readSecretCliOption(
        cliOptions,
        "lxdOidcSecret",
        "lxdOidcSecretFile",
        ["lxd-oidc-secret"],
        ["lxd-oidc-secret-file"]
      );
      options.authDomain = readCliOption(cliOptions, "authDomain", ["auth-domain"]);
      options.zitadelAdminEmail = readCliOption(cliOptions, "zitadelAdminEmail", ["zitadel-admin-email"]);
      options.logtoAdminEmail = readCliOption(cliOptions, "logtoAdminEmail", ["logto-admin-email"]);
      options.logtoAdminUsername = readCliOption(cliOptions, "logtoAdminUsername", ["logto-admin-username"]);
      options.generateRootPassword = Boolean(cliOptions.generateRootPwd || cliOptions["generate-root-pwd"]);
      if (options.generateRootPassword && readCliOption(cliOptions, "rootPwdFile", ["root-pwd-file"])) {
        fail("use only one of --generate-root-pwd or --root-pwd-file");
      }
      options.rootPassword = readSecretFileCliOption(cliOptions, "rootPwdFile", ["root-pwd-file"]);
      options.storageMode = readCliOption(cliOptions, "storageMode", ["storage-mode"]).replace("loop", "file");
      options.storageSource = readCliOption(cliOptions, "storageSource", ["storage-source"]);
      options.storageSize = readCliOption(cliOptions, "storageSize", ["storage-size"]);
      options.enableS3 = Boolean(cliOptions.enableS3 || cliOptions["enable-s3"]);
      options.s3Endpoint = normalizeS3Endpoint(readCliOption(cliOptions, "s3Endpoint", ["s3-endpoint"]));
      options.s3Bucket = readCliOption(cliOptions, "s3Bucket", ["s3-bucket"]);
      options.s3Region = readCliOption(cliOptions, "s3Region", ["s3-region"]);
      options.s3Prefix = readCliOption(cliOptions, "s3Prefix", ["s3-prefix"]) || options.s3Prefix;
      options.s3AccessKey = readCliOption(cliOptions, "s3AccessKey", ["s3-accessKey", "s3-access-key"]);
      options.s3SecretKey = readSecretCliOption(
        cliOptions,
        "s3SecretKey",
        "s3SecretKeyFile",
        ["s3-secretKey", "s3-secret-key"],
        ["s3-secretKeyFile", "s3-secret-key-file"]
      );
      options.enableSyncoid = Boolean(cliOptions.enableSyncoid || cliOptions["enable-syncoid"]);
      options.syncoidTarget = readCliOption(cliOptions, "syncoidTarget", ["syncoid-target"]);
      options.syncoidTargetDataset = readCliOption(cliOptions, "syncoidTargetDataset", ["syncoid-target-dataset"]);
      options.syncoidSshKey = readCliOption(cliOptions, "syncoidSshKey", ["syncoid-ssh-key"]);
      await installTerrarium(options);
    });
}
