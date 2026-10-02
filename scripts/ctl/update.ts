import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runText } from "../lib/common";
import {
  TERRARIUM_ANSIBLE_GALAXY,
  TERRARIUM_ANSIBLE_PIP_PACKAGES,
  TERRARIUM_ANSIBLE_PYTHON,
  TERRARIUM_ANSIBLE_VENV,
  TERRARIUM_ANSIBLE_WHEELHOUSE
} from "./ansible-runtime";
import { reconfigureCmd } from "./system";

const PREFIX = "terrariumctl update";
const REPO_DIR = process.env.TERRARIUM_REPO_DIR ?? "/opt/terrarium";
const BUNDLE_DIR = process.env.TERRARIUM_BUNDLE_DIR ?? "";
const REPO_URL = process.env.TERRARIUM_REPO_URL ?? "https://github.com/terion-labs/terrarium.git";
const GITHUB_REPO = process.env.TERRARIUM_GITHUB_REPO ?? "terion-labs/terrarium";
const ANSIBLE_GALAXY_ATTEMPTS = 4;
const INSTALLED_CLI = "/usr/local/bin/terrariumctl";
const TRM_ALIAS = "/usr/local/bin/trm";
const RELEASE_SIGNER_WORKFLOW = `${GITHUB_REPO}/.github/workflows/release.yml`;
const RELEASE_ATTESTATION_BUNDLE = "terrarium-release-attestation.sigstore.json";
const GITHUB_CLI_APT_KEYRING = "/etc/apt/keyrings/githubcli-archive-keyring.gpg";
const GITHUB_CLI_APT_SOURCE = "/etc/apt/sources.list.d/github-cli.list";
const GITHUB_CLI_APT_REPO = "https://cli.github.com/packages";

export type UpdateOptions = {
  ref?: string;
  reconfigure?: boolean;
};

function requireRoot(): void {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("run as root");
  }
}

function releaseArch(): string {
  if (process.arch === "x64") {
    return "x64";
  }
  if (process.arch === "arm64") {
    return "arm64";
  }
  throw new Error(`unsupported architecture: ${process.arch}`);
}

function isReleaseRef(ref: string): boolean {
  return /^v?[0-9]+(\.[0-9]+)*([.-][A-Za-z0-9]+)?$/.test(ref);
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

function syncTree(sourceDir: string, targetDir: string): void {
  if (resolve(sourceDir) === resolve(targetDir)) {
    throw new Error(`refusing to sync Terrarium source onto itself: ${sourceDir}`);
  }
  if (!existsSync(join(sourceDir, "ansible", "site.yml"))) {
    throw new Error(`Terrarium bundle is missing ansible/site.yml: ${sourceDir}`);
  }
  if (!existsSync(join(sourceDir, "dist", "terrariumctl"))) {
    throw new Error(`Terrarium bundle is missing dist/terrariumctl: ${sourceDir}`);
  }

  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    filter: (source) => {
      const base = source.split("/").at(-1) ?? "";
      return ![".git", "node_modules"].includes(base);
    }
  });
  chmodSync(join(targetDir, "dist", "terrariumctl"), 0o755);
}

async function resolveLatestReleaseRef(arch: string): Promise<string> {
  const script = `
import json
import os
import sys

asset = os.environ["TERRARIUM_ASSET"]
for release in json.load(sys.stdin):
    if release.get("draft") or release.get("prerelease"):
        continue
    if any(item.get("name") == asset for item in release.get("assets", [])):
        print(release.get("tag_name", ""))
        break
`;
  const releases = await runText(["curl", "-fsSL", `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=50`], PREFIX);
  const resolved = await runText(["python3", "-c", script], PREFIX, {
    stdin: releases,
    env: { TERRARIUM_ASSET: `terrarium-linux-${arch}.zip` }
  });
  const ref = resolved.trim();
  if (!ref) {
    throw new Error("failed to resolve latest Terrarium release tag");
  }
  return ref;
}

export function checksumForReleaseAsset(checksums: string, assetName: string): string {
  for (const line of checksums.split("\n")) {
    const [digest, rawName] = line.trim().split(/\s+/, 2);
    const name = rawName?.replace(/^\*/, "");
    if (name === assetName && /^[a-fA-F0-9]{64}$/.test(digest ?? "")) {
      return digest.toLowerCase();
    }
  }
  throw new Error(`missing checksum for ${assetName}`);
}

function verifyReleaseChecksum(workDir: string, bundleName: string): void {
  const expected = checksumForReleaseAsset(readFileSync(join(workDir, "SHA256SUMS"), "utf8"), bundleName);
  const actual = createHash("sha256").update(readFileSync(join(workDir, bundleName))).digest("hex");
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${bundleName}`);
  }
}

async function verifyReleaseAttestation(workDir: string, bundleName: string): Promise<void> {
  await runText(
    [
      "gh",
      "attestation",
      "verify",
      join(workDir, bundleName),
      "--bundle",
      join(workDir, RELEASE_ATTESTATION_BUNDLE),
      "-R",
      GITHUB_REPO,
      "--signer-workflow",
      RELEASE_SIGNER_WORKFLOW
    ],
    PREFIX
  );
}

async function downloadReleaseBundle(ref: string): Promise<string> {
  const arch = releaseArch();
  const resolvedRef = ref ? ref : await resolveLatestReleaseRef(arch);
  const workDir = mkdtempSync(join(tmpdir(), "terrarium-update-"));
  const bundleName = `terrarium-linux-${arch}.zip`;
  const assetUrl = `https://github.com/${GITHUB_REPO}/releases/download/${resolvedRef}/${bundleName}`;
  const checksumsUrl = `https://github.com/${GITHUB_REPO}/releases/download/${resolvedRef}/SHA256SUMS`;
  const attestationUrl = `https://github.com/${GITHUB_REPO}/releases/download/${resolvedRef}/${RELEASE_ATTESTATION_BUNDLE}`;

  try {
    await runText(["curl", "-fsSL", assetUrl, "-o", join(workDir, bundleName)], PREFIX);
    await runText(["curl", "-fsSL", checksumsUrl, "-o", join(workDir, "SHA256SUMS")], PREFIX);
    await runText(["curl", "-fsSL", attestationUrl, "-o", join(workDir, RELEASE_ATTESTATION_BUNDLE)], PREFIX);
    verifyReleaseChecksum(workDir, bundleName);
    await verifyReleaseAttestation(workDir, bundleName);
    await runText(["unzip", "-q", join(workDir, bundleName), "-d", workDir], PREFIX);
    return workDir;
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

async function syncSourceCheckout(ref: string): Promise<void> {
  if (!existsSync(join(REPO_DIR, ".git"))) {
    throw new Error("source update requires an existing git checkout in /opt/terrarium; use install.sh --update for release-bundle installs");
  }
  await runText(["git", "-C", REPO_DIR, "fetch", "--tags", "origin"], PREFIX);
  await runText(["git", "-C", REPO_DIR, "checkout", ref], PREFIX);
  await runText(["git", "-C", REPO_DIR, "pull", "--ff-only", "origin", ref], PREFIX);
  const bun = existsSync("/opt/bun/bin/bun") ? "/opt/bun/bin/bun" : "bun";
  await runText([bun, "install", "--frozen-lockfile"], PREFIX, { cwd: REPO_DIR });
  await runText([bun, "scripts/build.ts"], PREFIX, { cwd: REPO_DIR });
}

async function installAnsibleCollections(): Promise<void> {
  let lastOutput = "";
  for (let attempt = 1; attempt <= ANSIBLE_GALAXY_ATTEMPTS; attempt += 1) {
    const result = Bun.spawn({
      cmd: [TERRARIUM_ANSIBLE_GALAXY, "collection", "install", "-r", "requirements.yml"],
      cwd: join(REPO_DIR, "ansible"),
      stdout: "pipe",
      stderr: "pipe"
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      result.exited,
      result.stdout ? new Response(result.stdout).text() : Promise.resolve(""),
      result.stderr ? new Response(result.stderr).text() : Promise.resolve("")
    ]);
    if (exitCode === 0) {
      return;
    }

    lastOutput = `${stdout}\n${stderr}`.trim();
    if (attempt < ANSIBLE_GALAXY_ATTEMPTS) {
      console.warn(`${PREFIX}: ansible-galaxy collection install failed on attempt ${attempt}/${ANSIBLE_GALAXY_ATTEMPTS}; retrying`);
      await Bun.sleep(attempt * 5000);
    }
  }

  throw new Error(`ansible-galaxy collection install failed after ${ANSIBLE_GALAXY_ATTEMPTS} attempts${lastOutput ? `\n${lastOutput}` : ""}`);
}

async function ensureUpdateDependencies(): Promise<void> {
  await runText(["apt-get", "-o", "DPkg::Lock::Timeout=900", "update", "-y"], PREFIX);
  await runText(["apt-get", "-o", "DPkg::Lock::Timeout=900", "install", "-y", "ca-certificates", "curl"], PREFIX);
  await runText(["install", "-d", "-m", "0755", "/etc/apt/keyrings"], PREFIX);
  await runText(["curl", "-fsSL", `${GITHUB_CLI_APT_REPO}/githubcli-archive-keyring.gpg`, "-o", GITHUB_CLI_APT_KEYRING], PREFIX);
  await runText(["chown", "root:root", GITHUB_CLI_APT_KEYRING], PREFIX);
  chmodSync(GITHUB_CLI_APT_KEYRING, 0o644);
  const arch = (await runText(["dpkg", "--print-architecture"], PREFIX)).trim();
  writeFileSync(GITHUB_CLI_APT_SOURCE, `deb [arch=${arch} signed-by=${GITHUB_CLI_APT_KEYRING}] ${GITHUB_CLI_APT_REPO} stable main\n`);
  await runText(["chown", "root:root", GITHUB_CLI_APT_SOURCE], PREFIX);
  chmodSync(GITHUB_CLI_APT_SOURCE, 0o644);
  await runText(["apt-get", "-o", "DPkg::Lock::Timeout=900", "update", "-y"], PREFIX);
  await runText(["apt-get", "-o", "DPkg::Lock::Timeout=900", "install", "-y", "git", "gh", "python3", "python3-venv", "jq", "unzip"], PREFIX);
  await runText(["gh", "attestation", "verify", "--help"], PREFIX);
}

async function ensureAnsibleRuntime(): Promise<void> {
  if (!existsSync(TERRARIUM_ANSIBLE_WHEELHOUSE) || !readdirSync(TERRARIUM_ANSIBLE_WHEELHOUSE).some((name) => name.endsWith(".whl"))) {
    throw new Error(`Terrarium release bundle is missing the vendored Ansible wheelhouse: ${TERRARIUM_ANSIBLE_WHEELHOUSE}`);
  }
  await runText(["python3", "-m", "venv", TERRARIUM_ANSIBLE_VENV], PREFIX);
  await runText(
    [TERRARIUM_ANSIBLE_PYTHON, "-m", "pip", "install", "--no-index", "--find-links", TERRARIUM_ANSIBLE_WHEELHOUSE, ...TERRARIUM_ANSIBLE_PIP_PACKAGES],
    PREFIX
  );
}

function trmAliasIsManaged(): boolean {
  if (!existsSync(TRM_ALIAS)) {
    return true;
  }
  try {
    return lstatSync(TRM_ALIAS).isSymbolicLink() && readlinkSync(TRM_ALIAS) === INSTALLED_CLI;
  } catch {
    return false;
  }
}

function installCompiledCli(): void {
  const source = join(REPO_DIR, "dist", "terrariumctl");
  const staged = `${INSTALLED_CLI}.new-${process.pid}`;
  copyFileSync(source, staged);
  chmodSync(staged, 0o755);
  renameSync(staged, INSTALLED_CLI);
  if (trmAliasIsManaged()) {
    rmSync(TRM_ALIAS, { force: true });
    symlinkSync(INSTALLED_CLI, TRM_ALIAS);
  }
}

export async function updateCmd(options: UpdateOptions = {}): Promise<void> {
  requireRoot();
  await ensureUpdateDependencies();

  const requestedRef = options.ref ?? "";
  const sourcePath = localSourcePath(REPO_URL);
  let downloadedBundle = "";

  try {
    if (BUNDLE_DIR && existsSync(join(BUNDLE_DIR, "ansible", "site.yml"))) {
      console.log(`${PREFIX}: installing Terrarium release bundle into ${REPO_DIR}`);
      syncTree(BUNDLE_DIR, REPO_DIR);
    } else if (sourcePath && existsSync(join(sourcePath, "ansible", "site.yml"))) {
      console.log(`${PREFIX}: syncing local Terrarium source from ${sourcePath}`);
      syncTree(sourcePath, REPO_DIR);
    } else if (requestedRef && !isReleaseRef(requestedRef)) {
      await syncSourceCheckout(requestedRef);
    } else {
      downloadedBundle = await downloadReleaseBundle(requestedRef);
      console.log(`${PREFIX}: installing Terrarium release bundle into ${REPO_DIR}`);
      syncTree(downloadedBundle, REPO_DIR);
    }

    await ensureAnsibleRuntime();
    await installAnsibleCollections();

    if (options.reconfigure !== false) {
      await reconfigureCmd({ applyHardening: false });
    } else {
      installCompiledCli();
      await runText([INSTALLED_CLI, "completion", "all", "install"], PREFIX);
    }
  } finally {
    if (downloadedBundle) {
      rmSync(downloadedBundle, { recursive: true, force: true });
    }
  }
}
