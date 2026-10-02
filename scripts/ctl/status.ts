import { lxcArgs, parseVmCapability, parseInstance, isInfrastructureInstance } from "../lib/lxd-instance";
import {
  activeConfigStore,
  adminGroup,
  defaultServiceDomain,
  heading,
  idpEnabled,
  idpMode,
  label,
  oidcIssuer,
  requireConfig,
  value,
  type MutableConfig
} from "./context";
import { localIdpRuntimeDescriptor, localIdpServiceStatusCommand } from "./idp-runtime";
import { configString, runAllowFailure } from "../lib/common";

type CommandResult = { exitCode: number; stdout: string; stderr: string };
type StatusCommandDeps = {
  config?: MutableConfig;
  requireConfig?: () => MutableConfig;
  activeConfigStore?: () => string;
  runAllowFailure?: typeof runAllowFailure;
  log?: (message: string) => void;
};

/**
 * Prints a concise operational snapshot of the local Terrarium installation.
 *
 * The status view is intentionally human-oriented: it shows endpoints, auth
 * mode, and the key services users actually care about when checking whether a
 * host is healthy.
 */
export async function statusCmd(deps: StatusCommandDeps = {}): Promise<void> {
  const config = deps.config ?? (deps.requireConfig ?? requireConfig)();
  const run = deps.runAllowFailure ?? runAllowFailure;
  const log = deps.log ?? console.log;
  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
  const publicIp = configString(config, "terrarium_public_ip");
  const rootDomain = configString(config, "terrarium_root_domain");
  const manage = configString(config, "terrarium_manage_domain", defaultServiceDomain(rootDomain, publicIp, "manage"));
  const proxy = configString(config, "terrarium_proxy_domain", defaultServiceDomain(rootDomain, publicIp, "proxy"));
  const lxd = configString(config, "terrarium_lxd_domain", defaultServiceDomain(rootDomain, publicIp, "lxd"));
  const auth = configString(config, "terrarium_auth_domain");
  const oidc = oidcIssuer(config);
  const mode = idpMode(config);
  const idp = idpEnabled(config);
  const adminRole = adminGroup(config);
  const localIdpRuntime = localIdpRuntimeDescriptor(config);

  const traefik = await run(["systemctl", "is-active", "traefik"]);
  const cockpit = await run(["systemctl", "is-active", "cockpit.socket"]);
  const lxdState = await run(["systemctl", "is-active", "snap.lxd.daemon"]);
  const localIdpService = localIdpRuntime ? await run(localIdpServiceStatusCommand(localIdpRuntime)) : null;
  const oauth2Proxy = idp ? await run(["systemctl", "is-active", "terrarium-oauth2-proxy.service"]) : null;
  const s3Timer = await run(["systemctl", "is-active", "terrarium-s3-backup.timer"]);
  const syncoidTimer = await run(["systemctl", "is-active", "terrarium-syncoid.timer"]);
  const traefikSyncTimer = await run(["systemctl", "is-active", "terrarium-traefik-sync.timer"]);

  const capabilities = await run(lxcArgs("query", "/1.0"), { timeoutMs: 15_000 });
  let vmStatus = "unavailable: LXD could not be inspected";
  let member = "";
  let clustered = false;
  if (capabilities.exitCode === 0) {
    try {
      const host = parseVmCapability(JSON.parse(capabilities.stdout));
      vmStatus = host.available ? `available (${host.architectures.join(", ")})` : host.reason;
      member = host.member;
      clustered = host.clustered;
    } catch { vmStatus = "unknown: LXD returned invalid capability information"; }
  }
  const instanceResult = await run(lxcArgs("query", "/1.0/instances?recursion=1&project=default"), { timeoutMs: 15_000 });
  let workloadStatus = "unavailable";
  let ingressStatus = "not needed yet";
  if (instanceResult.exitCode === 0) {
    try {
      const raw: unknown = JSON.parse(instanceResult.stdout);
      if (!Array.isArray(raw)) throw new Error("Invalid instance list");
      const local = raw.map(parseInstance).filter((instance) => !clustered || instance.location === member);
      const workloads = local.filter((instance) => !isInfrastructureInstance(instance));
      workloadStatus = `${workloads.filter((instance) => instance.type === "container").length} containers, ${workloads.filter((instance) => instance.type === "virtual-machine").length} VMs`;
      const helper = local.find(isInfrastructureInstance);
      if (helper) ingressStatus = `${helper.name}: ${helper.status.toLowerCase()}`;
    } catch { workloadStatus = "unknown: invalid LXD instance information"; }
  }
  const backupResult = await run(["systemctl", "show", "terrarium-s3-backup.service", "terrarium-syncoid.service", "--property=Id,Result,ExecMainStartTimestamp", "--no-pager"]);

  log(heading("Terrarium status"));
  log(`  ${label("Config store:")} ${value((deps.activeConfigStore ?? activeConfigStore)())}`);
  log(`  ${label("Config export:")} ${value("/etc/terrarium/config.yaml (run terrariumctl config export)")}`);
  log(`  ${label("Pool:")} ${value(pool)}`);
  log(`  ${label("VM support:")} ${value(vmStatus)}`);
  log(`  ${label("Local workloads:")} ${value(workloadStatus)}`);
  log(`  ${label("OVN ingress:")} ${value(ingressStatus)}`);
  if (backupResult.exitCode === 0 && backupResult.stdout.includes("Result=")) {
    const results = backupResult.stdout.trim().split(/\n\s*\n/).map((block) => Object.fromEntries(block.split("\n").map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; })));
    log(`  ${label("Last backup results:")} ${value(results.map((service) => `${service.Id}: ${service.ExecMainStartTimestamp ? service.Result : "not run"}`).join("; "))}`);
  }
  log(`  ${label("Cockpit:")} ${value(`https://${manage}`)}`);
  log(`  ${label("Traefik dashboard:")} ${value(`https://${proxy}`)}`);
  log(`  ${label("LXD:")} ${value(`https://${lxd}`)}`);
  log(`  ${label("IDP mode:")} ${value(mode)}`);
  if (oidc) {
    log(`  ${label("OIDC issuer:")} ${value(oidc)}`);
  }
  if (adminRole) {
    log(`  ${label("Admin group:")} ${value(adminRole)}`);
  }
  if (localIdpRuntime) {
    log(`  ${label(`${localIdpRuntime.label}:`)} ${value(`https://${auth}`)}`);
    log(`  ${label(`${localIdpRuntime.label} instance:`)} ${value(localIdpRuntime.instanceName)}`);
    if (localIdpRuntime.bootstrapPasswordCommand) {
      log(`  ${label(`${localIdpRuntime.label} bootstrap password:`)} ${value(localIdpRuntime.bootstrapPasswordCommand)}`);
    }
  }
  log(`  ${label("traefik:")} ${value(traefik.stdout.trim())}`);
  log(`  ${label("cockpit.socket:")} ${value(cockpit.stdout.trim())}`);
  log(`  ${label("lxd:")} ${value(lxdState.stdout.trim())}`);
  if (oauth2Proxy) {
    log(`  ${label("terrarium-oauth2-proxy.service:")} ${value(oauth2Proxy.stdout.trim())}`);
  }
  if (localIdpRuntime && localIdpService) {
    log(`  ${label(`${localIdpRuntime.serviceName} in LXD:`)} ${value(localIdpService.stdout.trim())}`);
  }
  log(`  ${label("terrarium-s3-backup.timer:")} ${value(s3Timer.stdout.trim())}`);
  log(`  ${label("terrarium-syncoid.timer:")} ${value(syncoidTimer.stdout.trim())}`);
  log(`  ${label("terrarium-traefik-sync.timer:")} ${value(traefikSyncTimer.stdout.trim())}`);
}
