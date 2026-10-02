import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { stringify } from "yaml";
import { runInteractive, runText, shellEscape } from "../lib/common";
import { validateProxyLabel } from "../terrarium-traefik-sync";
import { cliOption, PREFIX } from "./context";
import { instanceType, lxcArgs, lxcCommand, readinessTimeout, record, vmLaunchTarget, waitForInstanceReady } from "../lib/lxd-instance";

const LXC = process.env.TERRARIUM_LXC_BIN ?? "/snap/bin/lxc";
const LAUNCH_DIR = "/var/lib/terrarium-launch";

type GitAsset = {
  kind: "git";
  source: string;
  repo: string;
  path: string;
  ref?: string;
};

type LocalAsset = {
  kind: "local";
  source: string;
  targetPath: string;
  content: string;
};

type LaunchAsset = GitAsset | LocalAsset;

type LaunchCloudInitPlan = {
  requirements: LaunchAsset[];
  playbooks: LaunchAsset[];
  roles: string[];
  composeFiles: LaunchAsset[];
  variables: Record<string, string>;
};

export type LaunchOptions = {
  vm?: boolean;
  target?: string;
  wait?: boolean;
  timeout?: string;
  profiles?: string[];
  disk?: string;
  memory?: string;
  cpu?: string;
  requirements?: string[];
  playbooks?: string[];
  roles?: string[];
  dockerCompose?: string[];
  cloudInit?: string;
  proxies?: string[];
  vars?: string[];
  varsFiles?: string[];
};

export type LaunchPlan = {
  args: string[];
  instanceName: string;
  cloudInit?: string;
};

type CloudInitFile = {
  path: string;
  permissions: string;
  content: string;
};

type CloudInit = {
  package_update?: boolean;
  packages?: string[];
  write_files?: CloudInitFile[];
  runcmd?: string[][];
  final_message?: string;
};

export function launchOptionsFromCli(options: Record<string, unknown>): LaunchOptions {
  return {
    vm: options.vm === true ? true : undefined,
    target: cliOption(options, "target"),
    wait: options.wait === true,
    timeout: cliOption(options, "timeout"),
    profiles: multiOption(options, "profile"),
    disk: cliOption(options, "disk"),
    memory: cliOption(options, "memory"),
    cpu: cliOption(options, "cpu"),
    requirements: multiOption(options, "requirements"),
    playbooks: multiOption(options, "playbook"),
    roles: multiOption(options, "role"),
    dockerCompose: multiOption(options, "dockerCompose", ["docker-compose"]),
    cloudInit: cliOption(options, "cloudInit", ["cloud-init"]),
    proxies: multiOption(options, "proxy"),
    vars: multiOption(options, "var"),
    varsFiles: multiOption(options, "vars")
  };
}

function multiOption(options: Record<string, unknown>, key: string, aliases: string[] = []): string[] {
  const candidates = [key, ...aliases];
  const rawValues = rawMultiOption(candidates);
  if (rawValues.length > 0) {
    return uniqueNonEmpty(rawValues);
  }

  const values: string[] = [];
  for (const candidate of candidates) {
    const value = options[candidate];
    if (Array.isArray(value)) {
      values.push(...value.map(String));
    } else if (typeof value === "string" || typeof value === "number") {
      values.push(String(value));
    }
  }

  return uniqueNonEmpty(values);
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function rawMultiOption(names: string[]): string[] {
  const longNames = new Set(names.map((name) => `--${name}`));
  const argv = process.argv;
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (longNames.has(arg)) {
      const value = argv[index + 1];
      if (value && !value.startsWith("--")) {
        values.push(value);
      }
      continue;
    }
    for (const longName of longNames) {
      if (arg.startsWith(`${longName}=`)) {
        values.push(arg.slice(longName.length + 1));
      }
    }
  }
  return values;
}

function validateResourceValue(value: string | undefined, optionName: string): void {
  if (value !== undefined && !/^[0-9][0-9A-Za-z.]*$/.test(value)) {
    throw new Error(`${optionName} must be a simple LXD resource value such as 2, 4G, or 40GiB`);
  }
}

function validateRoleName(role: string): string {
  const normalized = role.trim();
  if (!/^[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)*$/.test(normalized)) {
    throw new Error(`unsupported Galaxy role name: ${role}`);
  }
  return normalized;
}

function parseGitAsset(source: string): GitAsset | null {
  if (!source.startsWith("git+")) {
    return null;
  }
  const withoutScheme = source.slice("git+".length);
  const separator = withoutScheme.indexOf("//", "https://".length);
  if (separator === -1) {
    throw new Error(`git asset must include //path inside the repository: ${source}`);
  }
  const repo = withoutScheme.slice(0, separator);
  const pathAndQuery = withoutScheme.slice(separator + 2);
  const queryIndex = pathAndQuery.indexOf("?");
  const path = queryIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? "" : pathAndQuery.slice(queryIndex + 1));
  const ref = params.get("ref")?.trim() || undefined;
  if (!repo || !path || path.startsWith("/")) {
    throw new Error(`git asset must look like git+https://repo.git//path?ref=tag: ${source}`);
  }
  return { kind: "git", source, repo, path, ...(ref ? { ref } : {}) };
}

function localAsset(source: string, group: string, index: number): LocalAsset {
  if (!existsSync(source)) {
    throw new Error(`missing launch asset: ${source}`);
  }
  return {
    kind: "local",
    source,
    targetPath: `${LAUNCH_DIR}/${group}-${index}-${basename(source) || "asset"}`,
    content: readFileSync(source, "utf8")
  };
}

function unquoteDotEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function parseVariableAssignment(raw: string, source: string): [string, string] {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    throw new Error(`${source} must contain KEY=value assignments`);
  }
  const key = raw.slice(0, separator).trim().replace(/^export\s+/, "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`invalid launch variable name: ${key || "<empty>"}`);
  }
  return [key, unquoteDotEnvValue(raw.slice(separator + 1))];
}

function stripDotEnvComment(line: string): string {
  let quote: "'" | '"' | "" = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && quote === '"' && index + 1 < line.length) {
      index += 1;
      continue;
    }
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = "";
      continue;
    }
    if (char === "#" && !quote && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line;
}

function parseDotEnv(content: string, source: string): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = stripDotEnvComment(line).trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const [key, value] = parseVariableAssignment(trimmed, `${source}:${index + 1}`);
    variables[key] = value;
  }
  return variables;
}

function loadLaunchVariables(options: LaunchOptions): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const varsFile of options.varsFiles ?? []) {
    if (!existsSync(varsFile)) {
      throw new Error(`missing launch vars file: ${varsFile}`);
    }
    Object.assign(variables, parseDotEnv(readFileSync(varsFile, "utf8"), varsFile));
  }
  for (const assignment of options.vars ?? []) {
    const [key, value] = parseVariableAssignment(assignment, "--var");
    variables[key] = value;
  }
  return variables;
}

function renderDotEnv(variables: Record<string, string>): string {
  return Object.entries(variables)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n")
    .concat(Object.keys(variables).length > 0 ? "\n" : "");
}

function renderShellEnv(variables: Record<string, string>): string {
  return Object.entries(variables)
    .map(([key, value]) => `export ${key}=${shellEscape(value)}`)
    .join("\n")
    .concat(Object.keys(variables).length > 0 ? "\n" : "");
}

function launchAsset(source: string, group: string, index: number): LaunchAsset {
  return parseGitAsset(source) ?? localAsset(source, group, index);
}

function buildCloudInitPlan(options: LaunchOptions): LaunchCloudInitPlan {
  return {
    requirements: (options.requirements ?? []).map((source, index) => launchAsset(source, "requirements", index + 1)),
    playbooks: (options.playbooks ?? []).map((source, index) => launchAsset(source, "playbook", index + 1)),
    roles: (options.roles ?? []).map(validateRoleName),
    composeFiles: (options.dockerCompose ?? []).map((source, index) => launchAsset(source, "compose", index + 1)),
    variables: loadLaunchVariables(options)
  };
}

function assetPath(asset: LaunchAsset, gitTargets: Map<GitAsset, string>): string {
  if (asset.kind === "local") {
    return asset.targetPath;
  }
  const target = gitTargets.get(asset);
  if (!target) {
    throw new Error(`missing git checkout for launch asset: ${asset.source}`);
  }
  return `${target}/${asset.path}`;
}

function cloneCommand(asset: GitAsset, target: string): string {
  const commands = [`rm -rf ${shellEscape(target)}`, `git clone --depth 1 ${shellEscape(asset.repo)} ${shellEscape(target)}`];
  if (asset.ref) {
    commands.push(`git -C ${shellEscape(target)} fetch --depth 1 origin ${shellEscape(asset.ref)} || true`);
    commands.push(`git -C ${shellEscape(target)} checkout ${shellEscape(asset.ref)} || git -C ${shellEscape(target)} checkout FETCH_HEAD`);
  }
  return commands.join(" && ");
}

function requirementCommand(path: string): string {
  const escaped = shellEscape(path);
  return [
    `if grep -Eq '^[[:space:]]*collections:' ${escaped}; then ansible-galaxy collection install -r ${escaped}; fi`,
    `if grep -Eq '^[[:space:]]*roles:' ${escaped} || ! grep -Eq '^[[:space:]]*(roles|collections):' ${escaped}; then ansible-galaxy role install -r ${escaped}; fi`
  ].join(" && ");
}

function rolePlaybook(roles: string[]): string {
  return stringify([
    {
      hosts: "localhost",
      connection: "local",
      become: true,
      roles
    }
  ]);
}

function command(value: string, withVariables = false): string[] {
  const prefix = withVariables ? `if [ -f ${shellEscape(`${LAUNCH_DIR}/vars.sh`)} ]; then . ${shellEscape(`${LAUNCH_DIR}/vars.sh`)}; fi; ` : "";
  return ["bash", "-lc", `${prefix}${value}`];
}

function generatedCloudInit(options: LaunchOptions): string {
  const plan = buildCloudInitPlan(options);
  const files: CloudInitFile[] = [];
  const commands: string[][] = [command(`mkdir -p ${shellEscape(LAUNCH_DIR)}`)];
  const gitAssets = [...plan.requirements, ...plan.playbooks, ...plan.composeFiles].filter((asset): asset is GitAsset => asset.kind === "git");
  const localAssets = [...plan.requirements, ...plan.playbooks, ...plan.composeFiles].filter((asset): asset is LocalAsset => asset.kind === "local");
  const gitTargets = new Map(gitAssets.map((asset, index) => [asset, `${LAUNCH_DIR}/git-${index + 1}`] as const));
  const hasVariables = Object.keys(plan.variables).length > 0;
  const varsEnvPath = `${LAUNCH_DIR}/vars.env`;
  const varsJsonPath = `${LAUNCH_DIR}/vars.json`;

  for (const asset of localAssets) {
    files.push({ path: asset.targetPath, permissions: "0600", content: asset.content });
  }
  if (hasVariables) {
    files.push({ path: varsEnvPath, permissions: "0600", content: renderDotEnv(plan.variables) });
    files.push({ path: `${LAUNCH_DIR}/vars.sh`, permissions: "0600", content: renderShellEnv(plan.variables) });
    files.push({ path: varsJsonPath, permissions: "0600", content: `${JSON.stringify(plan.variables, null, 2)}\n` });
  }
  gitAssets.forEach((asset) => commands.push(command(cloneCommand(asset, gitTargets.get(asset) ?? `${LAUNCH_DIR}/git`), hasVariables)));

  const hasCompose = plan.composeFiles.length > 0;
  const cloudInit: CloudInit = {
    package_update: true,
    packages: [
      "ca-certificates",
      "curl",
      "git",
      "python3",
      "python3-apt",
      "ansible",
      ...(hasCompose ? ["docker.io", "docker-compose-v2"] : [])
    ],
    write_files: files,
    runcmd: commands,
    final_message: "Terrarium launch provisioning finished."
  };

  plan.requirements.forEach((asset) => cloudInit.runcmd?.push(command(requirementCommand(assetPath(asset, gitTargets)), hasVariables)));

  if (plan.roles.length > 0) {
    const rolesPath = `${LAUNCH_DIR}/galaxy-roles.yml`;
    cloudInit.write_files?.push({ path: rolesPath, permissions: "0600", content: rolePlaybook(plan.roles) });
    for (const role of plan.roles) {
      cloudInit.runcmd?.push(command(`ansible-galaxy role install ${shellEscape(role)}`, hasVariables));
    }
    cloudInit.runcmd?.push(
      command(`ansible-playbook -i localhost, -c local ${hasVariables ? `--extra-vars @${shellEscape(varsJsonPath)} ` : ""}${shellEscape(rolesPath)}`, hasVariables)
    );
  }

  plan.playbooks.forEach((asset) => {
    cloudInit.runcmd?.push(
      command(
        `ansible-playbook -i localhost, -c local ${hasVariables ? `--extra-vars @${shellEscape(varsJsonPath)} ` : ""}${shellEscape(assetPath(asset, gitTargets))}`,
        hasVariables
      )
    );
  });

  if (hasCompose) {
    cloudInit.runcmd?.push(command("systemctl enable --now docker", hasVariables));
    plan.composeFiles.forEach((asset) => {
      cloudInit.runcmd?.push(
        command(`docker compose ${hasVariables ? `--env-file ${shellEscape(varsEnvPath)} ` : ""}-f ${shellEscape(assetPath(asset, gitTargets))} up -d`, hasVariables)
      );
    });
  }

  if (cloudInit.write_files?.length === 0) {
    delete cloudInit.write_files;
  }
  return `#cloud-config\n${stringify(cloudInit)}`;
}

function explicitCloudInit(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`missing cloud-init file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function needsGeneratedCloudInit(options: LaunchOptions): boolean {
  return (
    (options.requirements?.length ?? 0) > 0 ||
    (options.playbooks?.length ?? 0) > 0 ||
    (options.roles?.length ?? 0) > 0 ||
    (options.dockerCompose?.length ?? 0) > 0 ||
    (options.vars?.length ?? 0) > 0 ||
    (options.varsFiles?.length ?? 0) > 0
  );
}

export function buildLaunchPlan(image: string, name: string, options: LaunchOptions = {}): LaunchPlan {
  const normalizedImage = image.trim();
  const normalizedName = name.trim();
  if (!normalizedImage || !normalizedName) {
    throw new Error("launch requires: <image> <name>");
  }

  validateResourceValue(options.disk, "--disk");
  validateResourceValue(options.memory, "--memory");
  validateResourceValue(options.cpu, "--cpu");
  readinessTimeout(options.timeout);
  if (options.vm && options.profiles?.some((profile) => ["default", "terrarium", "strict", "dev", "kvm"].includes(profile))) {
    throw new Error("Container profiles cannot be used for VMs; choose vm, vm-dev, or a VM-compatible custom profile");
  }

  if (options.cloudInit && needsGeneratedCloudInit(options)) {
    throw new Error("--cloud-init cannot be combined with --requirements, --playbook, --role, --docker-compose, --var, or --vars");
  }

  const cloudInit = options.cloudInit
    ? explicitCloudInit(options.cloudInit)
    : needsGeneratedCloudInit(options)
      ? generatedCloudInit(options)
      : undefined;
  const args = lxcArgs(cloudInit ? "init" : "launch", normalizedImage, normalizedName);
  if (options.vm) args.push("--vm");
  if (options.target) args.push("--target", options.target);
  for (const profile of options.profiles?.length ? options.profiles : options.vm ? ["vm"] : []) {
    args.push("--profile", profile);
  }
  if (options.disk) {
    args.push("--device", `root,size=${options.disk}`);
  }
  if (options.memory) {
    args.push("--config", `limits.memory=${options.memory}`);
  }
  if (options.cpu) {
    args.push("--config", `limits.cpu=${options.cpu}`);
  }
  if ((options.proxies?.length ?? 0) > 0) {
    const proxyLabel = (options.proxies ?? []).join(",");
    validateProxyLabel(proxyLabel);
    args.push("--config", `user.proxy=${proxyLabel}`);
  }

  return cloudInit ? { args, instanceName: normalizedName, cloudInit } : { args, instanceName: normalizedName };
}

export function buildLaunchArgs(image: string, name: string, options: LaunchOptions = {}): string[] {
  return buildLaunchPlan(image, name, options).args;
}

export async function launchCmd(image: string, name: string, options: LaunchOptions): Promise<void> {
  // Validate local files and flags before contacting an image server.
  buildLaunchPlan(image, name, options);
  const info = await lxcCommand(["image", "info", image, ...(options.vm ? ["--vm"] : [])], { timeoutMs: 120_000 });
  const type = instanceType(info.match(/^Type: (.+)$/m)?.[1]?.trim());
  if (options.vm && type !== "virtual-machine") throw new Error(`Image ${image} is a container image, not a VM image`);
  const resolved: LaunchOptions = { ...options, vm: type === "virtual-machine" };
  if (resolved.vm) {
    resolved.target = await vmLaunchTarget(options.target, info.match(/^Architecture: (.+)$/m)?.[1]?.trim());
    for (const profile of resolved.profiles?.length ? resolved.profiles : ["vm"]) {
      const data = record(JSON.parse(await lxcCommand(["query", `/1.0/profiles/${encodeURIComponent(profile)}?project=default`])), "LXD profile");
      const config = record(data.config ?? {}, "profile config");
      const incompatible = Object.keys(config).filter((key) => /^(security\.(nesting|privileged|idmap\.|syscalls\.)|raw\.idmap|limits\.(kernel\.|processes))/.test(key));
      if (incompatible.length) throw new Error(`Profile ${profile} contains container-only settings: ${incompatible.join(", ")}`);
    }
  }
  const plan = buildLaunchPlan(image, name, resolved);
  await runInteractive(plan.args, PREFIX);
  if (plan.cloudInit) {
    await lxcCommand(["config", "set", plan.instanceName, "cloud-init.user-data", "-"], { stdin: plan.cloudInit });
    await runInteractive(lxcArgs("start", plan.instanceName), PREFIX);
  }
  if (resolved.wait) await waitForInstanceReady(plan.instanceName, { provisioning: true, timeoutMs: readinessTimeout(resolved.timeout) });
}
