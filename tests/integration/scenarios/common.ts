import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { IntegrationContext } from "../context";
import type { ExternalOidcFixture, IntegrationIdpProvider, ManagedHost, VolumeRecord } from "../types";
import { SshHost } from "../remote/ssh";
import { expectHttpBodyContains, readHttpsResponse, waitForHttpStatusResolved, type HttpsResponse } from "../assertions/http";
import { expectLxdUi, expectManagementSurfaces, expectManagementUi, expectProtectedRouteMatrix } from "../assertions/browser";
import { expectRemoteContains, expectSystemdActive } from "../assertions/host";
import { collectHostArtifacts } from "../cleanup";

type HostProvisionOptions = {
  label: string;
  withVolume: boolean;
};

type InstallOptions = {
  idpMode: "local" | "oidc";
  storageMode: "disk" | "partition" | "file";
  storageSource?: string;
  storageSize?: string;
  manageDomain?: string;
  proxyDomain?: string;
  lxdDomain?: string;
  authDomain?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  lxdOidcClientId?: string;
  lxdOidcClientSecret?: string;
  adminGroup?: string;
  enableS3?: boolean;
  enableSyncoid?: boolean;
  syncoidTarget?: string;
  syncoidTargetDataset?: string;
  syncoidSshKey?: string;
  email?: string;
  acmeEmail?: string;
  zitadelAdminEmail?: string;
};

const LXD_API_POLL_TIMEOUT_MS = 90 * 1000;
const LXD_API_VERIFY_TIMEOUT_MS = 2 * 60 * 1000;

const DETACHED_COMMAND_LOG_TAIL_LINES = 200;
const DETACHED_COMMAND_LOG_TAIL_MAX_CHARS = 64 * 1024;
const DETACHED_COMMAND_LOG_TAIL_REFRESH_MS = 30 * 1000;

type DetachedCommandWaitOptions = {
  localTailPath?: string;
};

function baseEmail(ctx: IntegrationContext): string {
  return `terrarium+${ctx.config.slug}@${ctx.config.ipDnsDomain}`;
}

function localInstallRootPassword(ctx: IntegrationContext): string {
  return `Terrarium!${ctx.config.slug}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repoArchiveRemotePath(localArchivePath: string): string {
  return `/root/${basename(localArchivePath)}`;
}

function binaryRemotePath(): string {
  return "/root/terrarium-bundle/dist/terrariumctl";
}

function remoteCtl(command: string): string {
  return `/usr/local/bin/terrariumctl ${command}`;
}

export async function uploadSecretFile(ssh: SshHost, remotePath: string, secret: string): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "terrarium-secret-"));
  const localPath = join(tempDir, "secret");
  try {
    writeFileSync(localPath, `${secret.replace(/\n+$/g, "")}\n`, { encoding: "utf8", mode: 0o600 });
    await ssh.copyTo(localPath, remotePath);
    await ssh.exec(`chmod 600 ${shellArg(remotePath)}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function expectedRouteAuthRedirectUris(routeLabels: string[]): string[] {
  const profiles = new Set<string>();
  const redirectUris: string[] = [];
  for (const label of routeLabels) {
    const authIndex = label.lastIndexOf("@auth");
    if (authIndex === -1) {
      continue;
    }

    const route = label.slice(0, authIndex);
    const suffix = label.slice(authIndex);
    if (!/^@auth(?::[A-Za-z0-9._,-]+)?(?:~[A-Za-z0-9.-]+)?$/.test(suffix)) {
      throw new Error(`unsupported auth suffix: ${suffix}`);
    }

    const parsed = new URL(route);
    const callbackIndex = suffix.indexOf("~");
    const callbackHost = callbackIndex === -1 ? parsed.hostname : suffix.slice(callbackIndex + 1);
    const routePath = normalizedRouteAuthPath(parsed.pathname);
    const key = `${parsed.hostname}\n${callbackHost}\n${routePath}`;
    if (profiles.has(key)) {
      continue;
    }
    profiles.add(key);

    const proxyPrefix = routePath === "/" ? "/oauth2" : `/oauth2${routePath}`;
    redirectUris.push(`https://${callbackHost}${proxyPrefix}/callback`);
  }
  return redirectUris.sort();
}

function normalizedRouteAuthPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** Creates a Hetzner host and optionally attaches a raw block volume for Terrarium. */
export async function provisionHost(context: IntegrationContext, options: HostProvisionOptions, sshKeyId: number): Promise<ManagedHost> {
  const labels = { terrarium: "integration", run: context.config.slug, role: options.label };
  const server = await context.createHetznerServer(
    options.label,
    `terrarium-${context.config.slug}-${options.label}`,
    context.config.hcloudServerType,
    context.config.hcloudLocation,
    [sshKeyId],
    labels
  );

  let volume: VolumeRecord | undefined;
  if (options.withVolume) {
    volume = await context.createHetznerVolume(
      options.label,
      `terrarium-${context.config.slug}-${options.label}`,
      context.config.hcloudVolumeSizeGb,
      context.config.hcloudLocation,
      labels
    );
    volume = await context.attachHetznerVolume(options.label, volume.id, server.id);
  }

  const host = context.host(options.label, server, context.domainBundle(options.label, server.ipv4), volume);
  const ssh = context.ssh(host);
  await ssh.waitForSsh();
  return host;
}

/** Uploads the current working tree and the Linux test binary to a remote host. */
export async function stageBundleOnHost(context: IntegrationContext, ssh: SshHost): Promise<void> {
  await ssh.exec("mkdir -p /root/terrarium-bundle/dist /root/terrarium-src");
  await ssh.copyTo(context.linuxBinaryPath, binaryRemotePath());
  await ssh.copyTo(context.sourceArchivePath, repoArchiveRemotePath(context.sourceArchivePath));
  await ssh.exec(`rm -rf /root/terrarium-src/* && tar -xzf ${repoArchiveRemotePath(context.sourceArchivePath)} -C /root/terrarium-src`);
  await ssh.exec(`chmod 755 ${binaryRemotePath()}`);
}

/** Runs the Terrarium installer non-interactively on a remote host. */
export async function installTerrarium(context: IntegrationContext, host: ManagedHost, options: InstallOptions): Promise<void> {
  const ssh = context.ssh(host);
  await stageBundleOnHost(context, ssh);
  const secretFiles: string[] = [];
  let storageSource = options.storageSource;
  if (!storageSource && options.storageMode === "disk") {
    storageSource = (
      await ssh.exec(
        "root_source=$(findmnt -n -o SOURCE /); root_disk=$(lsblk -no PKNAME \"$root_source\" 2>/dev/null | sed 's|^|/dev/|'); lsblk -dpno NAME,TYPE | awk '$2 == \"disk\" { print $1 }' | grep -v \"^${root_disk}$\" | head -n 1"
      )
    ).trim();
  }

  const args = [
    `${binaryRemotePath()} install --non-interactive --yes`,
    `--domain ${shellArg(context.publicDns.rootDomain(host.server.ipv4))}`,
    `--email ${shellArg(options.email || baseEmail(context))}`,
    `--acme-email ${shellArg(options.acmeEmail || baseEmail(context))}`,
    `--idp ${options.idpMode}`,
    `--idp-provider ${shellArg(context.config.idpProvider)}`,
    `--storage-mode ${options.storageMode}`
  ];
  const rootPasswordPath = `/root/terrarium-install-${host.label}-root-password`;
  await uploadSecretFile(ssh, rootPasswordPath, localInstallRootPassword(context));
  secretFiles.push(rootPasswordPath);
  args.push(`--root-pwd-file ${shellArg(rootPasswordPath)}`);

  args.push(`--manage-domain ${shellArg(options.manageDomain || host.domains.manage)}`);
  args.push(`--proxy-domain ${shellArg(options.proxyDomain || host.domains.proxy)}`);
  args.push(`--lxd-domain ${shellArg(options.lxdDomain || host.domains.lxd)}`);

  if (storageSource) {
    args.push(`--storage-source ${shellArg(storageSource)}`);
  }
  if (options.storageSize) {
    args.push(`--storage-size ${shellArg(options.storageSize)}`);
  }
  if (options.idpMode === "local") {
    args.push(`--auth-domain ${shellArg(options.authDomain || host.domains.auth)}`);
    args.push(`--zitadel-admin-email ${shellArg(options.zitadelAdminEmail || baseEmail(context))}`);
    args.push(`--admin-group ${shellArg(options.adminGroup || "terrarium-admins")}`);
  } else {
    args.push(`--admin-group ${shellArg(options.adminGroup || "terrarium-admins")}`);
    args.push(`--oidc ${shellArg(options.oidcIssuer || "")}`);
    args.push(`--oidc-client ${shellArg(options.oidcClientId || "")}`);
    const oidcSecretPath = `/root/terrarium-install-${host.label}-oidc-secret`;
    await uploadSecretFile(ssh, oidcSecretPath, options.oidcClientSecret || "");
    secretFiles.push(oidcSecretPath);
    args.push(`--oidc-secret-file ${shellArg(oidcSecretPath)}`);
    if (options.lxdOidcClientId) {
      args.push(`--lxd-oidc-client ${shellArg(options.lxdOidcClientId)}`);
      if (options.lxdOidcClientSecret) {
        const lxdOidcSecretPath = `/root/terrarium-install-${host.label}-lxd-oidc-secret`;
        await uploadSecretFile(ssh, lxdOidcSecretPath, options.lxdOidcClientSecret);
        secretFiles.push(lxdOidcSecretPath);
        args.push(`--lxd-oidc-secret-file ${shellArg(lxdOidcSecretPath)}`);
      }
    }
  }
  if (options.enableS3) {
    args.push("--enable-s3");
    args.push(`--s3-endpoint ${shellArg(context.config.s3Endpoint)}`);
    args.push(`--s3-bucket ${shellArg(context.config.s3Bucket)}`);
    args.push(`--s3-region ${shellArg(context.config.s3Region)}`);
    args.push(`--s3-prefix ${shellArg(`terrarium/${context.config.slug}/${host.label}`)}`);
    args.push(`--s3-access-key ${shellArg(context.config.s3AccessKey)}`);
    const s3SecretPath = `/root/terrarium-install-${host.label}-s3-secret-key`;
    await uploadSecretFile(ssh, s3SecretPath, context.config.s3SecretKey);
    secretFiles.push(s3SecretPath);
    args.push(`--s3-secret-key-file ${shellArg(s3SecretPath)}`);
  }
  if (options.enableSyncoid) {
    args.push("--enable-syncoid");
    args.push(`--syncoid-target ${shellArg(options.syncoidTarget || "")}`);
    args.push(`--syncoid-target-dataset ${shellArg(options.syncoidTargetDataset || "")}`);
    args.push(`--syncoid-ssh-key ${shellArg(options.syncoidSshKey || "/root/.ssh/id_ed25519")}`);
  }

  const remoteScriptPath = `/root/terrarium-install-${host.label}.sh`;
  const remoteStatusPath = `/root/terrarium-install-${host.label}.exit`;
  const remoteLogPath = `/root/terrarium-install-${host.label}.log`;
  await ssh.exec(`rm -f ${shellArg(remoteScriptPath)} ${shellArg(remoteStatusPath)} ${shellArg(remoteLogPath)}`);
  const installCommand = [
    ...(secretFiles.length > 0 ? [`trap "rm -f ${secretFiles.map(shellArg).join(" ")}" EXIT`] : []),
    `export TERRARIUM_REPO_URL=${shellArg("file:///root/terrarium-src")}`,
    `export TERRARIUM_BUNDLE_DIR=${shellArg("/root/terrarium-bundle")}`,
    args.join(" ")
  ].join(" && ");
  await ssh.execDetached(installCommand, remoteScriptPath, remoteStatusPath, remoteLogPath);
  await waitForDetachedCommand(ssh, remoteStatusPath, remoteLogPath, 45 * 60 * 1000, {
    localTailPath: join(context.localArtifactsDir, `${basename(remoteLogPath)}.tail`)
  });
  await ssh.exec("test -L /usr/local/bin/trm && /usr/local/bin/trm status >/dev/null");
}

function terrariumConfigValue(config: string, key: string): string | undefined {
  const match = config.match(new RegExp(`^${key}:\\s*(.+)\\s*$`, "m"));
  const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
  return value || undefined;
}

/** Returns the local ZITADEL bootstrap credentials from an installed Terrarium host. */
export async function readLocalZitadelAdmin(host: SshHost): Promise<{ email: string; password: string }> {
  const configExport = await host.execAllowFailure(
    "terrariumctl config export >/dev/null && cat /etc/terrarium/config.yaml; rc=$?; rm -f /etc/terrarium/config.yaml; exit $rc"
  );
  if (configExport.exitCode !== 0) {
    throw new Error(`failed to export Terrarium config: ${(configExport.stderr || configExport.stdout).trim()}`);
  }
  const config = configExport.stdout;
  const emailMatch = config.match(/terrarium_zitadel_admin_email:\s*(.+)/);
  const instanceMatch = config.match(/terrarium_zitadel_instance_name:\s*(.+)/);
  const instance = (instanceMatch?.[1] || "terrarium-idp").trim().replace(/^["']|["']$/g, "");
  const passwordResult = await host.execAllowFailure(
    `if lxc info ${shellArg(instance)} >/dev/null 2>&1; then lxc exec ${shellArg(
      instance
    )} -- cat /etc/terrarium/secrets/zitadel_admin_password; else cat /etc/terrarium/secrets/zitadel_admin_password; fi`
  );
  const password = passwordResult.stdout.trim();
  if (!emailMatch?.[1] || !password) {
    throw new Error("failed to read local ZITADEL bootstrap credentials");
  }
  return {
    email: emailMatch[1].trim().replace(/^["']|["']$/g, ""),
    password
  };
}

/** Returns the local Logto bootstrap credentials from an installed Terrarium host. */
export async function readLocalLogtoAdmin(
  context: IntegrationContext,
  host: SshHost
): Promise<{ email: string; password: string }> {
  const configExport = await host.execAllowFailure(
    "terrariumctl config export >/dev/null && cat /etc/terrarium/config.yaml; rc=$?; rm -f /etc/terrarium/config.yaml; exit $rc"
  );
  if (configExport.exitCode !== 0) {
    throw new Error(`failed to export Terrarium config: ${(configExport.stderr || configExport.stdout).trim()}`);
  }
  const config = configExport.stdout;
  const email = terrariumConfigValue(config, "terrarium_logto_admin_email") || terrariumConfigValue(config, "terrarium_email") || baseEmail(context);
  const instance = terrariumConfigValue(config, "terrarium_logto_instance_name") || "terrarium-idp";
  const passwordResult = await host.execAllowFailure(
    `if lxc info ${shellArg(instance)} >/dev/null 2>&1; then lxc exec ${shellArg(
      instance
    )} -- cat /etc/terrarium/secrets/logto_admin_password; else cat /etc/terrarium/secrets/logto_admin_password; fi`
  );
  const password = passwordResult.stdout.trim();
  if (!password) {
    throw new Error("failed to read local Logto bootstrap credentials");
  }
  return { email, password };
}

/** Returns the local management admin credentials for the configured local IDP provider. */
export async function readLocalAdmin(context: IntegrationContext, host: SshHost): Promise<{ email: string; password: string }> {
  if (context.config.idpProvider === "zitadel") {
    return await readLocalZitadelAdmin(host);
  }

  return await readLocalLogtoAdmin(context, host);
}

export function localAuthDiscoveryUrl(authDomain: string, provider: IntegrationIdpProvider): string {
  const discoveryPath = provider === "logto" ? "/oidc/.well-known/openid-configuration" : "/.well-known/openid-configuration";
  return `https://${authDomain}${discoveryPath}`;
}

/** Waits for the primary Terrarium public endpoints to be online. */
export async function waitForTerrariumPublicEndpoints(
  host: ManagedHost,
  includeAuth: boolean,
  localIdpProvider: IntegrationIdpProvider
): Promise<void> {
  if (includeAuth) {
    // Surface local IdP discovery/TLS readiness before oauth2-proxy turns those failures into 500s.
    await waitForHttpStatusResolved(localAuthDiscoveryUrl(host.domains.auth, localIdpProvider), [200], {
      timeoutMs: 300000,
      resolveIp: host.server.ipv4
    });
  }
  await waitForHttpStatusResolved(`https://${host.domains.manage}`, [302, 303], { timeoutMs: 300000, resolveIp: host.server.ipv4 });
  await waitForHttpStatusResolved(`https://${host.domains.proxy}`, [302, 303], { timeoutMs: 300000, resolveIp: host.server.ipv4 });
  await waitForHttpStatusResolved(`https://${host.domains.lxd}`, [200, 302], { timeoutMs: 300000, resolveIp: host.server.ipv4 });
}

/** Verifies the UI endpoints and auth gates for a Terrarium management surface. */
export async function verifyManagementUi(
  context: IntegrationContext,
  host: ManagedHost,
  user: { email: string; password: string; userId?: string; roles?: string[] }
): Promise<void> {
  const outputDir = join(context.localArtifactsDir, host.label, "browser");
  mkdirSync(outputDir, { recursive: true });
  context.logger.info(`verify ${host.label} management UI as ${user.email}`);
  await expectManagementUi(`https://${host.domains.manage}`, `https://${host.domains.proxy}`, user as never, outputDir, {
    resolveIp: host.server.ipv4,
    resolveHosts: {
      [host.domains.auth]: host.server.ipv4
    }
  });
  context.logger.info(`verified ${host.label} management UI`);
}

/** Verifies the browser-facing management surfaces without relaunching Chromium between apps. */
export async function verifyManagementSurfaces(
  context: IntegrationContext,
  host: ManagedHost,
  user: { email: string; password: string; userId?: string; roles?: string[] }
): Promise<void> {
  const outputDir = join(context.localArtifactsDir, host.label, "browser");
  mkdirSync(outputDir, { recursive: true });
  context.logger.info(`verify ${host.label} management surfaces as ${user.email}`);
  await expectManagementSurfaces(
    `https://${host.domains.manage}`,
    `https://${host.domains.proxy}`,
    `https://${host.domains.lxd}`,
    user as never,
    outputDir,
    {
      resolveIp: host.server.ipv4,
      resolveHosts: {
        [host.domains.auth]: host.server.ipv4
      }
    }
  );
  context.logger.info(`verified ${host.label} management surfaces`);
}

/** Verifies the public LXD endpoint serves the real API over trusted TLS and does not expose trusted anonymous access. */
export async function verifyLxdApi(host: ManagedHost, context?: IntegrationContext): Promise<void> {
  await withStepTimeout(`LXD API verification for ${host.label}`, LXD_API_VERIFY_TIMEOUT_MS, async () => {
    context?.logger.info(`verify ${host.label} LXD API`);
    const response = await waitForLxdApiRootResponse(host);
    assertSafeLxdApiRootResponse(response, host.domains.lxd, host.domains.auth);
    context?.logger.info(`verified ${host.label} LXD API`);
  });
}

type LxdApiRootWaitOptions = {
  readResponse?: typeof readHttpsResponse;
  sleep?: typeof Bun.sleep;
  timeoutMs?: number;
};

export async function waitForLxdApiRootResponse(host: ManagedHost, options: LxdApiRootWaitOptions = {}): Promise<HttpsResponse> {
  const readResponse = options.readResponse ?? readHttpsResponse;
  const sleep = options.sleep ?? Bun.sleep;
  const deadline = Date.now() + (options.timeoutMs ?? LXD_API_POLL_TIMEOUT_MS);
  let lastError = "";
  while (Date.now() < deadline) {
    let response: HttpsResponse;
    try {
      response = await readResponse(`https://${host.domains.lxd}/1.0`, {
        resolveIp: host.server.ipv4,
        headers: ["Accept: application/json"]
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(5000);
      continue;
    }

    if (isTransientLxdApiRootResponse(response)) {
      lastError = `LXD API root returned transient HTTP status ${response.status}`;
      await sleep(5000);
      continue;
    }

    assertSafeLxdApiRootResponse(response, host.domains.lxd, host.domains.auth);
    return response;
  }

  throw new Error(`timed out waiting for LXD API root; last error=${lastError || "none"}`);
}

function isTransientLxdApiRootResponse(response: HttpsResponse): boolean {
  return [404, 408, 425, 429, 500, 502, 503, 504].includes(response.status);
}

export function assertSafeLxdApiRootResponse(response: HttpsResponse, lxdHost: string, authHost?: string): void {
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.match(/^location:\s*(.+)$/im)?.[1]?.trim() ?? "";
    if (isExpectedLxdAuthRedirect(location, lxdHost, authHost)) {
      return;
    }
    throw new Error(`LXD API root redirected to unexpected location: ${location || "<missing>"}`);
  }

  if ([401, 403].includes(response.status)) {
    return;
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`LXD API root returned unexpected HTTP status ${response.status}`);
  }

  let body: unknown;
  try {
    body = JSON.parse(response.body) as unknown;
  } catch {
    throw new Error(`LXD API root did not return JSON; body=${response.body.replace(/\s+/g, " ").trim().slice(0, 400) || "<empty>"}`);
  }

  if (!isObject(body)) {
    throw new Error("LXD API root did not return an object");
  }

  const metadata = body.metadata;
  if (!isObject(metadata)) {
    throw new Error("LXD API root did not include metadata");
  }

  if (!Array.isArray(metadata.api_extensions)) {
    throw new Error("LXD API root did not include api_extensions");
  }

  const auth = typeof metadata.auth === "string" ? metadata.auth.toLowerCase() : "";
  if (!auth) {
    throw new Error("LXD API root did not include auth state");
  }
  if (auth === "trusted") {
    throw new Error("LXD API root allowed trusted anonymous access");
  }
}

function isExpectedLxdAuthRedirect(location: string, lxdHost: string, authHost?: string): boolean {
  if (!location) {
    return false;
  }

  let target: URL;
  try {
    target = new URL(location, `https://${lxdHost}`);
  } catch {
    return false;
  }

  if (target.host === lxdHost) {
    return target.pathname.startsWith("/oidc/") || target.pathname.startsWith("/ui/");
  }

  return Boolean(authHost && target.host === authHost);
}

/** Verifies a real browser login through LXD's public OIDC flow. */
export async function verifyLxdUi(
  context: IntegrationContext,
  host: ManagedHost,
  user: { email: string; password: string; userId?: string; roles?: string[] }
): Promise<void> {
  const outputDir = join(context.localArtifactsDir, host.label, "lxd-browser");
  mkdirSync(outputDir, { recursive: true });
  context.logger.info(`verify ${host.label} LXD UI as ${user.email}`);
  await expectLxdUi(`https://${host.domains.lxd}`, user as never, outputDir, {
    resolveIp: host.server.ipv4,
    resolveHosts: {
      [host.domains.auth]: host.server.ipv4
    }
  });
  context.logger.info(`verified ${host.label} LXD UI`);
}

/** Creates a small HTTP server inside an LXC and publishes the requested proxy labels. */
export async function createHttpFixtureContainer(
  host: SshHost,
  containerName: string,
  labels: string[],
  bodyText: string
): Promise<void> {
  const setupId = randomUUID();
  const setupLogPath = `/root/${containerName}-setup-${setupId}.log`;
  const setupScriptPath = `/root/${containerName}-setup-${setupId}.sh`;
  const setupRunnerPath = `/root/${containerName}-setup-runner-${setupId}.sh`;
  const setupStatusPath = `/root/${containerName}-setup-${setupId}.exit`;
  const setupCommand = [
    `echo '[fixture] launch ${containerName}'`,
    `timeout 300s lxc launch ubuntu:24.04 ${shellArg(containerName)}`,
    `echo '[fixture] wait-running ${containerName}'`,
    `timeout 300s bash -lc ${shellArg(
      `until lxc info ${shellArg(containerName)} | grep -F 'Status: RUNNING' >/dev/null 2>&1; do sleep 2; done`
    )}`,
    `echo '[fixture] wait-ipv4 ${containerName}'`,
    `timeout 300s bash -lc ${shellArg(
      `until lxc query /1.0/instances/${containerName}/state | jq -e '(.network // {} | to_entries | any((.value.addresses // []) | any(.family == "inet" and .scope == "global" and (.address | length > 0))))' >/dev/null 2>&1; do sleep 2; done`
    )}`,
    `echo '[fixture] install-httpd ${containerName}'`,
    `timeout 600s lxc exec ${shellArg(containerName)} -- bash -lc ${shellArg(
      `export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get install -y python3 && mkdir -p /srv/www && printf '%s\\n' ${shellArg(
        bodyText
      )} > /srv/www/index.html && cat >/etc/systemd/system/terrarium-fixture-http.service <<'EOF'
[Unit]
Description=Terrarium integration HTTP fixture
After=network-online.target

[Service]
WorkingDirectory=/srv/www
ExecStart=/usr/bin/python3 -m http.server 8080 --directory /srv/www
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now terrarium-fixture-http.service`
    )}`,
    `echo '[fixture] set-proxy-labels ${containerName}'`,
    `lxc config set ${shellArg(containerName)} user.proxy ${shellArg(labels.join(","))}`,
    `echo '[fixture] proxy-sync ${containerName}'`,
    `timeout 300s ${remoteCtl("proxy sync")}`,
    `echo '[fixture] done ${containerName}'`
  ].join(" && ");

  await deleteContainerIfPresent(host, containerName);
  await host.write(
    setupScriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
${setupCommand}
`,
    "700"
  );
  await host.execDetached(shellArg(setupScriptPath), setupRunnerPath, setupStatusPath, setupLogPath);
  await waitForDetachedCommand(host, setupStatusPath, setupLogPath, 20 * 60 * 1000);
}

/** Launches a small HTTP fixture through `trm launch` to verify generated cloud-init and launch-time proxy labels. */
export async function createLaunchFixtureContainer(host: SshHost, containerName: string, label: string, bodyText: string): Promise<void> {
  const setupId = randomUUID();
  const playbookPath = `/root/${containerName}-launch-${setupId}.yml`;
  const varsPath = `/root/${containerName}-launch-${setupId}.env`;
  const setupLogPath = `/root/${containerName}-launch-${setupId}.log`;
  const setupScriptPath = `/root/${containerName}-launch-${setupId}.sh`;
  const setupRunnerPath = `/root/${containerName}-launch-runner-${setupId}.sh`;
  const setupStatusPath = `/root/${containerName}-launch-${setupId}.exit`;
  const playbook = `---
- hosts: localhost
  connection: local
  become: true
  tasks:
    - name: Install Python HTTP fixture runtime
      ansible.builtin.apt:
        name: python3
        update_cache: true
        state: present
    - name: Create fixture document root
      ansible.builtin.file:
        path: /srv/www
        state: directory
        mode: "0755"
    - name: Write fixture body
      ansible.builtin.copy:
        dest: /srv/www/index.html
        mode: "0644"
        content: "{{ launch_body_text }}\n"
    - name: Install fixture HTTP service
      ansible.builtin.copy:
        dest: /etc/systemd/system/terrarium-launch-fixture.service
        mode: "0644"
        content: |
          [Unit]
          Description=Terrarium launch integration HTTP fixture
          After=network-online.target

          [Service]
          WorkingDirectory=/srv/www
          ExecStart=/usr/bin/python3 -m http.server 8080 --directory /srv/www
          Restart=always

          [Install]
          WantedBy=multi-user.target
    - name: Start fixture HTTP service
      ansible.builtin.systemd:
        name: terrarium-launch-fixture.service
        daemon_reload: true
        enabled: true
        state: started
`;

  await deleteContainerIfPresent(host, containerName);
  await host.write(
    setupScriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
trap 'lxc exec ${shellArg(containerName)} -- tail -n 200 /var/log/cloud-init-output.log 2>/dev/null || true' ERR
echo '[launch-fixture] write-playbook ${containerName}'
cat > ${shellArg(playbookPath)} <<'EOF'
${playbook}EOF
cat > ${shellArg(varsPath)} <<'EOF'
launch_body_text=from-vars-file
EOF
echo '[launch-fixture] launch ${containerName}'
timeout 600s /usr/local/bin/trm launch ubuntu:24.04 ${shellArg(containerName)} --playbook ${shellArg(playbookPath)} --vars ${shellArg(varsPath)} --var ${shellArg(`launch_body_text=${bodyText}`)} --proxy ${shellArg(label)}
echo '[launch-fixture] wait-cloud-init ${containerName}'
timeout 900s lxc exec ${shellArg(containerName)} -- cloud-init status --wait
echo '[launch-fixture] fixture-state ${containerName}'
timeout 60s lxc exec ${shellArg(containerName)} -- systemctl is-active terrarium-launch-fixture.service
timeout 60s lxc exec ${shellArg(containerName)} -- cat /srv/www/index.html
echo '[launch-fixture] proxy-sync ${containerName}'
timeout 300s ${remoteCtl("proxy sync")}
echo '[launch-fixture] done ${containerName}'
`,
    "700"
  );
  await host.execDetached(shellArg(setupScriptPath), setupRunnerPath, setupStatusPath, setupLogPath);
  await waitForDetachedCommand(host, setupStatusPath, setupLogPath, 25 * 60 * 1000);
}

/** Forces local snapshots, mutates container state, and verifies in-place restore. */
export async function verifyLocalBackupRestore(host: SshHost, containerName: string): Promise<void> {
  const dataset = `terrarium/containers/${containerName}`;
  const snapshotName = `smoke-local-restore-${Date.now()}`;
  await host.exec(`lxc exec ${shellArg(containerName)} -- bash -lc "echo v1 > /srv/www/state.txt"`);
  await host.exec(`zfs snapshot -r ${shellArg(`${dataset}@${snapshotName}`)}`);
  await host.exec(`lxc exec ${shellArg(containerName)} -- bash -lc "echo v2 > /srv/www/state.txt"`);
  await host.exec(`printf 'y\\n' | ${remoteCtl(`backup restore --instance ${shellArg(containerName)} --at ${shellArg(snapshotName)}`)}`);
  await host.exec(`lxc start ${shellArg(containerName)} || true`);
  await expectRemoteContains(host, readContainerFileCommand(containerName, "/srv/www/state.txt"), "v1");
}

/** Verifies the S3 export and restore path against the configured real bucket. */
export async function verifyS3BackupRestore(host: SshHost, containerName: string): Promise<void> {
  await host.exec(remoteCtl("backup export"));
  await host.exec(`lxc exec ${shellArg(containerName)} -- bash -lc "echo v3 > /srv/www/state.txt"`);
  await host.exec(`printf 'y\\n' | ${remoteCtl(`backup restore --source s3 --instance ${shellArg(containerName)}`)}`);
  await host.exec(`lxc start ${shellArg(containerName)} || true`);
  await expectRemoteContains(host, readContainerFileCommand(containerName, "/srv/www/state.txt"), "v1");
}

function readContainerFileCommand(containerName: string, path: string): string {
  return [
    "tmp=$(mktemp)",
    `timeout 60s lxc file pull ${shellArg(`${containerName}${path}`)} "$tmp"`,
    "cat \"$tmp\"",
    "rm -f \"$tmp\""
  ].join(" && ");
}

/** Verifies syncoid pushed the Terrarium dataset to the replica host. */
export async function verifySyncoid(primary: SshHost, replica: SshHost, dataset: string): Promise<void> {
  await primary.exec("systemctl start terrarium-syncoid.service");
  await expectRemoteContains(replica, `zfs list -H -o name | grep -F ${shellArg(dataset)}`, dataset);
}

/** Reconfigures the primary host to external OIDC and validates the management UIs. */
export async function switchToExternalOidc(
  context: IntegrationContext,
  host: ManagedHost,
  fixture: ExternalOidcFixture
): Promise<void> {
  const ssh = context.ssh(host);
  const secretPath = `/root/terrarium-switch-oidc-${randomUUID()}-secret`;
  await uploadSecretFile(ssh, secretPath, fixture.clientSecret);
  await runDetachedRemoteCommand(
    ssh,
    "switch-oidc",
    `trap "rm -f ${shellArg(secretPath)}" EXIT
${remoteCtl("set idp oidc")} \\
  --provider ${shellArg(context.config.idpProvider)} \\
  --oidc ${shellArg(context.externalOidcIssuer)} \\
  --oidc-client ${shellArg(fixture.clientId)} \\
  --oidc-secret-file ${shellArg(secretPath)} \\
  --lxd-oidc-client ${shellArg(fixture.lxdClientId)} \\
  --admin-group ${shellArg(fixture.adminGroup)}`
  );
  await withStepTimeout(`external OIDC management surfaces for ${host.label}`, 15 * 60 * 1000, () =>
    verifyManagementSurfaces(context, host, fixture.adminUser)
  );
  await withStepTimeout(`external OIDC LXD API for ${host.label}`, 6 * 60 * 1000, () => verifyLxdApi(host, context));
}

/** Reconfigures the primary host back to the configured local IDP and validates its management UIs. */
export async function switchBackToLocalIdp(context: IntegrationContext, host: ManagedHost): Promise<void> {
  const ssh = context.ssh(host);
  await runDetachedRemoteCommand(ssh, "switch-local-idp", remoteCtl("set idp local"));
  const admin = await readLocalAdmin(context, ssh);
  await withStepTimeout(`local IDP management surfaces for ${host.label}`, 15 * 60 * 1000, () => verifyManagementSurfaces(context, host, admin));
  await withStepTimeout(`local IDP LXD API for ${host.label}`, 6 * 60 * 1000, () => verifyLxdApi(host, context));
}

/** Runs a small route-auth matrix against the currently configured OIDC provider. */
export async function verifyProtectedRoutes(
  context: IntegrationContext,
  host: ManagedHost,
  fixture: ExternalOidcFixture,
  plainHost: string,
  authHost: string,
  groupedHost: string,
  bodyText: string
): Promise<void> {
  const readiness = { timeoutMs: 300000, resolveIp: host.server.ipv4 };
  context.logger.info(`verify ${host.label} route matrix readiness`);
  await withStepTimeout(`plain route readiness for ${plainHost}`, 6 * 60 * 1000, () => waitForHttpStatusResolved(`https://${plainHost}`, [200, 302], readiness));
  await withStepTimeout(`auth route readiness for ${authHost}`, 6 * 60 * 1000, () => waitForHttpStatusResolved(`https://${authHost}`, [302, 303], readiness));
  await withStepTimeout(`group route readiness for ${groupedHost}`, 6 * 60 * 1000, () =>
    waitForHttpStatusResolved(`https://${groupedHost}`, [302, 303], readiness)
  );

  const outputDir = join(context.localArtifactsDir, host.label, "routes");
  mkdirSync(outputDir, { recursive: true });
  context.logger.info(`verify ${host.label} plain route body`);
  await withStepTimeout(`plain route body for ${plainHost}`, 6 * 60 * 1000, () => expectHttpBodyContains(`https://${plainHost}`, bodyText, readiness));
  context.logger.info(`verify ${host.label} auth route allows ${fixture.routeUser.email}`);
  context.logger.info(`verify ${host.label} grouped route allows ${fixture.routeUser.email}`);
  context.logger.info(`verify ${host.label} grouped route denies ${fixture.deniedUser.email}`);
  await expectProtectedRouteMatrix(
    [
      { url: `https://${authHost}`, user: fixture.routeUser, expected: "allow", bodyNeedle: bodyText },
      { url: `https://${groupedHost}`, user: fixture.routeUser, expected: "allow", bodyNeedle: bodyText },
      { url: `https://${groupedHost}`, user: fixture.deniedUser, expected: "deny" }
    ],
    outputDir,
    { resolveIp: host.server.ipv4 }
  );
  context.logger.info(`verified ${host.label} route matrix`);
}

/** Applies a handful of `terrariumctl set ...` operations and validates convergence. */
export async function exerciseReconfiguration(context: IntegrationContext, host: ManagedHost): Promise<void> {
  const ssh = context.ssh(host);
  const rootDomain = context.publicDns.rootDomain(host.server.ipv4);
  const altManage = context.publicDns.serviceHost("manage-alt", context.config.slug, host.server.ipv4);
  const altProxy = context.publicDns.serviceHost("proxy-alt", context.config.slug, host.server.ipv4);
  const altLxd = context.publicDns.serviceHost("lxd-alt", context.config.slug, host.server.ipv4);
  const altAuth = context.publicDns.serviceHost("auth-alt", context.config.slug, host.server.ipv4);
  await runDetachedRemoteCommand(
    ssh,
    "reconfigure-domains",
    `printf 'y\\n' | ${remoteCtl(`set domains ${shellArg(rootDomain)}`)} --manage-domain ${shellArg(altManage)} --proxy-domain ${shellArg(
      altProxy
    )} --lxd-domain ${shellArg(altLxd)} --auth-domain ${shellArg(altAuth)}`
  );
  await runDetachedRemoteCommand(
    ssh,
    "reconfigure-emails",
    `${remoteCtl("set emails")} --email ${shellArg(baseEmail(context))} --acme-email ${shellArg(baseEmail(context))}`
  );
  const s3SecretPath = "/root/terrarium-reconfigure-s3-secret";
  await uploadSecretFile(ssh, s3SecretPath, context.config.s3SecretKey);
  await runDetachedRemoteCommand(
    ssh,
    "reconfigure-s3",
    `trap "rm -f ${shellArg(s3SecretPath)}" EXIT && ${remoteCtl("set s3")} --enable --s3-endpoint ${shellArg(context.config.s3Endpoint)} --s3-bucket ${shellArg(
      context.config.s3Bucket
    )} --s3-region ${shellArg(context.config.s3Region)} --s3-prefix ${shellArg(`terrarium/${context.config.slug}/reconfigured`)} --s3-access-key ${shellArg(
      context.config.s3AccessKey
    )} --s3-secret-key-file ${shellArg(s3SecretPath)}`
  );
  await runDetachedRemoteCommand(ssh, "reconfigure-syncoid-disable", remoteCtl("set syncoid --disable"));
  await runDetachedRemoteCommand(
    ssh,
    "reconfigure-syncoid-enable",
    `${remoteCtl("set syncoid --enable")} --syncoid-target root@127.0.0.1 --syncoid-target-dataset terrarium/containers --syncoid-ssh-key /root/.ssh/id_ed25519`
  ).catch(() => {
    // The loopback re-enable intentionally only exercises validation/wiring and is allowed to fail remotely.
  });
}

/** Collects high-value artifacts from a managed host after a scenario failure. */
export async function captureFailureArtifacts(context: IntegrationContext, hosts: ManagedHost[]): Promise<void> {
  for (const host of hosts) {
    try {
      await collectHostArtifacts(context, host);
    } catch (error) {
      context.logger.warn(`artifact collection failed for ${host.label}: ${String(error)}`);
    }
  }
}

/** Verifies the installed host’s service/timer health via CLI and systemd. */
export async function assertInstalledHost(host: SshHost): Promise<void> {
  // Exercise the native binding against the real ZFS pool, not just an import.
  await host.exec(`/usr/bin/python3 -c 'import libzfs
with libzfs.ZFS() as z:
    assert any(p.name == "terrarium" for p in z.pools)'`);
  await expectRemoteContains(host, remoteCtl("status"), "terrarium-oauth2-proxy.service");
  await expectSystemdActive(host, "traefik");
  await expectSystemdActive(host, "terrarium-traefik-sync.timer");
  await expectRemoteContains(host, "lxc network show terrarium-ovn", "type: ovn");
  await expectRemoteContains(host, "lxc profile show default", "network: terrarium-ovn");
}

/** Creates a partitioned disk layout with a large free extent for partition-mode install tests. */
export async function preparePartitionTarget(host: SshHost, devicePath: string): Promise<void> {
  await host.exec(`parted -s ${shellArg(devicePath)} mklabel gpt`);
  await host.exec(`parted -s ${shellArg(devicePath)} unit MiB mkpart primary ext4 1 2048`);
}

/** Uploads the runner SSH key onto the primary host so syncoid can reach the replica. */
export async function installSyncoidKey(
  primary: SshHost,
  privateKeyPath: string,
  publicKeyPath: string,
  replicaHost: string
): Promise<void> {
  await primary.exec("mkdir -p /root/.ssh");
  await primary.uploadKeypair(privateKeyPath, publicKeyPath, "/root/.ssh/id_ed25519");
  await primary.exec("touch /root/.ssh/known_hosts && chmod 600 /root/.ssh/known_hosts");
  await primary.exec(
    `ssh-keygen -R ${shellArg(replicaHost)} -f /root/.ssh/known_hosts >/dev/null 2>&1 || true && ssh-keyscan -H ${shellArg(
      replicaHost
    )} >> /root/.ssh/known_hosts`
  );
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function redactDetachedLogTail(log: string): string {
  return log
    .replace(/((?:password|passwd|secret|token|client_secret|access_key|secret_key)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>")
    .replace(/(--(?:root-pwd|oidc-secret|lxd-oidc-secret|s3-secret-key)(?:-file)?\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>");
}

function boundDetachedLogTail(log: string): string {
  if (log.length <= DETACHED_COMMAND_LOG_TAIL_MAX_CHARS) {
    return log;
  }
  return `...[truncated to last ${DETACHED_COMMAND_LOG_TAIL_MAX_CHARS} chars]\n${log.slice(-DETACHED_COMMAND_LOG_TAIL_MAX_CHARS)}`;
}

function normalizeDetachedLogTail(log: string): string {
  return boundDetachedLogTail(redactDetachedLogTail(log));
}

async function readDetachedLogTail(host: SshHost, logPath: string): Promise<string> {
  const log = await host.execAllowFailure(`tail -n ${DETACHED_COMMAND_LOG_TAIL_LINES} ${shellArg(logPath)} 2>&1 || true`, { timeoutMs: 20000 });
  return normalizeDetachedLogTail(log.stdout || log.stderr);
}

async function persistDetachedLogTail(localTailPath: string | undefined, logPath: string, reason: string, tail: string): Promise<void> {
  if (!localTailPath) {
    return;
  }

  mkdirSync(dirname(localTailPath), { recursive: true });
  const body = [
    `remote log: ${logPath}`,
    `reason: ${reason}`,
    `capturedAt: ${new Date().toISOString()}`,
    "",
    tail.trim() || "<empty>",
    ""
  ].join("\n");
  await Bun.write(localTailPath, body);
}

export async function waitForDetachedCommand(
  host: SshHost,
  statusPath: string,
  logPath: string,
  timeoutMs: number,
  options: DetachedCommandWaitOptions = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let cachedTail = "";
  let nextTailRefreshAt = 0;
  while (Date.now() < deadline) {
    const result = await host.execAllowFailure(`test -f ${shellArg(statusPath)} && cat ${shellArg(statusPath)}`, { timeoutMs: 20000 });
    if (result.exitCode === 0) {
      const exitCode = Number(result.stdout.trim() || "1");
      if (exitCode !== 0) {
        const tail = await readDetachedLogTail(host, logPath).catch(() => cachedTail);
        await persistDetachedLogTail(options.localTailPath, logPath, `remote command failed with exit ${exitCode}`, tail);
        throw new Error(`remote command failed with exit ${exitCode}\n${tail}`);
      }
      return;
    }

    try {
      await host.waitForSsh(15000);
      if (Date.now() >= nextTailRefreshAt) {
        cachedTail = await readDetachedLogTail(host, logPath).catch(() => cachedTail);
        nextTailRefreshAt = Date.now() + DETACHED_COMMAND_LOG_TAIL_REFRESH_MS;
      }
    } catch {
      // Host may be briefly unavailable while Terrarium hardens SSH or restarts services.
    }
    await Bun.sleep(5000);
  }

  const tail = await readDetachedLogTail(host, logPath).catch(() => cachedTail);
  await persistDetachedLogTail(options.localTailPath, logPath, "timed out waiting for remote command to finish", tail);
  throw new Error(`timed out waiting for remote command to finish\n${tail}`);
}

async function runDetachedRemoteCommand(host: SshHost, label: string, command: string, timeoutMs = 20 * 60 * 1000): Promise<void> {
  const id = randomUUID();
  const remoteBase = `/root/terrarium-${label}-${id}`;
  const scriptPath = `${remoteBase}.sh`;
  const statusPath = `${remoteBase}.exit`;
  const logPath = `${remoteBase}.log`;
  await host.execDetached(command, scriptPath, statusPath, logPath);
  await waitForDetachedCommand(host, statusPath, logPath, timeoutMs);
}

async function withStepTimeout<T>(label: string, timeoutMs: number, task: () => Promise<T>): Promise<T> {
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForRemoteCommandSuccess(
  host: SshHost,
  command: string,
  description: string,
  timeoutMs: number,
  attemptTimeoutMs = 30000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await host.execAllowFailure(command, { timeoutMs: attemptTimeoutMs });
    if (result.exitCode === 0) {
      return;
    }
    await Bun.sleep(5000);
  }

  throw new Error(`timed out waiting for ${description}`);
}

async function deleteContainerIfPresent(host: SshHost, containerName: string): Promise<void> {
  const exists = await host.execAllowFailure(`timeout 30s lxc info ${shellArg(containerName)} >/dev/null 2>&1`, { timeoutMs: 60000 });
  if (exists.exitCode !== 0) {
    return;
  }

  const deletion = await host.execAllowFailure(`timeout 120s lxc delete ${shellArg(containerName)} --force`, { timeoutMs: 180000 });
  if (deletion.exitCode !== 0 && deletion.exitCode !== 124) {
    throw new Error(deletion.stderr.trim() || deletion.stdout.trim() || `failed to delete existing container ${containerName}`);
  }

  await waitForRemoteCommandSuccess(
    host,
    `! lxc info ${shellArg(containerName)} >/dev/null 2>&1`,
    `container ${containerName} to be deleted`,
    2 * 60 * 1000
  );
}
