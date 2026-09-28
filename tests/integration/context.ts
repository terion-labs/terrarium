import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./lib/process";
import { IntegrationLogger } from "./lib/logger";
import { loadIntegrationConfig } from "./config";
import { TERRARIUM_ANSIBLE_PIP_PACKAGES } from "../../scripts/ctl/ansible-runtime";
import type {
  DomainBundle,
  ExternalOidcFixture,
  IntegrationCliOptions,
  IntegrationConfig,
  ManagedHost,
  ScenarioResult,
  ServerRecord,
  VolumeRecord
} from "./types";
import type { IntegrationOidcFixtureProgress, IntegrationOidcProvider } from "./provider/external-oidc";
import { HetznerCloudProvider } from "./provider/hetzner";
import { IpEncodedDnsProvider } from "./provider/ip-encoded-dns";
import { ZitadelCloudProvider } from "./provider/zitadel-cloud";
import { LogtoCloudProvider } from "./provider/logto-cloud";
import { S3Provider } from "./provider/s3";
import { CifsProvider } from "./provider/cifs";
import { SshHost } from "./remote/ssh";
import { buildCleanupPlan, CleanupManifestStore, type CleanupStep } from "./resources";
import { IntegrationResourceGuard } from "./resource-guard";

type CleanupTask = () => Promise<void>;

function describeCleanupStep(step: CleanupStep): string {
  if (step.provider === "hetzner") {
    return `Hetzner ${step.resourceType} ${step.resource.id}`;
  }
  if (step.resourceType === "user") {
    return `External OIDC ${step.idpProvider} user ${step.resource.userId}`;
  }
  if (step.resourceType === "app") {
    return `External OIDC ${step.idpProvider} app ${step.appId}`;
  }
  if (step.resourceType === "role") {
    return `External OIDC ${step.idpProvider} role ${step.resource.roleId}`;
  }
  if (step.resourceType === "api-resource") {
    return `External OIDC ${step.idpProvider} API resource ${step.resource.apiResourceId}`;
  }
  if (step.resourceType === "container") {
    return `External OIDC ${step.idpProvider} container ${step.containerId}`;
  }
  return `External OIDC ${step.idpProvider} project ${step.projectId}`;
}

function ansibleWheelhousePlatform(binaryTarget: string): string {
  if (binaryTarget === "x64") {
    return "manylinux2014_x86_64";
  }
  if (binaryTarget === "arm64") {
    return "manylinux2014_aarch64";
  }
  throw new Error(`unsupported integration binary target for Ansible wheelhouse: ${binaryTarget}`);
}

/** Global per-run context shared by all integration scenarios. */
export class IntegrationContext {
  readonly config: IntegrationConfig;
  readonly logger: IntegrationLogger;
  readonly hetzner: HetznerCloudProvider;
  readonly publicDns: IpEncodedDnsProvider;
  readonly zitadelCloud: ZitadelCloudProvider;
  readonly logtoCloud: LogtoCloudProvider;
  readonly externalOidcProvider: IntegrationOidcProvider;
  readonly s3: S3Provider;
  readonly cifs: CifsProvider;
  readonly results: ScenarioResult[] = [];
  readonly localArtifactsDir: string;
  readonly linuxBundleDir: string;
  readonly linuxBinaryPath: string;
  readonly sourceArchivePath: string;
  readonly resources: CleanupManifestStore;
  private readonly cleanupTasks: CleanupTask[] = [];
  private readonly sshKeyIdByName = new Map<string, number>();
  private cleanupPromise?: Promise<void>;
  private resourceGuard?: IntegrationResourceGuard;

  constructor(options: IntegrationCliOptions) {
    this.config = loadIntegrationConfig(options);
    this.localArtifactsDir = join(this.config.outputDir, "artifacts");
    this.linuxBundleDir = join(this.config.outputDir, "bundle");
    this.linuxBinaryPath = join(this.linuxBundleDir, "dist", "terrariumctl");
    this.sourceArchivePath = join(this.linuxBundleDir, "terrarium-src.tar.gz");
    this.resources = new CleanupManifestStore(join(this.config.outputDir, "resources.json"), this.config.slug);
    mkdirSync(this.localArtifactsDir, { recursive: true });
    mkdirSync(join(this.linuxBundleDir, "dist"), { recursive: true });

    this.logger = new IntegrationLogger(join(this.config.outputDir, "integration.log"));
    this.hetzner = new HetznerCloudProvider(this.config, this.logger.child("hetzner"));
    this.publicDns = new IpEncodedDnsProvider(this.config, this.logger.child("public-dns"));
    this.zitadelCloud = new ZitadelCloudProvider(this.config, this.logger.child("zitadel-cloud"));
    this.logtoCloud = new LogtoCloudProvider(this.config, this.logger.child("logto-cloud"));
    this.externalOidcProvider = this.config.idpProvider === "logto" ? this.logtoCloud : this.zitadelCloud;
    this.s3 = new S3Provider(this.config, this.logger.child("s3"));
    this.cifs = new CifsProvider(this.config, this.logger.child("cifs"));
  }

  async buildLinuxBundle(): Promise<void> {
    this.logger.info("building linux terrariumctl bundle for remote installation");
    await run(
      [
        "bun",
        "build",
        "--compile",
        `--target=bun-linux-${this.config.hcloudBinaryTarget}`,
        "scripts/terrariumctl.ts",
        "--outfile",
        this.linuxBinaryPath
      ],
      { cwd: this.config.repoRoot }
    );

    const wheelhousePath = join(this.linuxBundleDir, "ansible-wheelhouse");
    rmSync(wheelhousePath, { recursive: true, force: true });
    mkdirSync(wheelhousePath, { recursive: true });
    for (const pythonVersion of ["312", "314"]) {
      await run(
        [
          "python3",
          "-m",
          "pip",
          "download",
          "--dest",
          wheelhousePath,
          "--only-binary=:all:",
          "--implementation",
          "cp",
          "--python-version",
          pythonVersion,
          "--abi",
          `cp${pythonVersion}`,
          "--platform",
          ansibleWheelhousePlatform(this.config.hcloudBinaryTarget),
          ...TERRARIUM_ANSIBLE_PIP_PACKAGES
        ],
        { cwd: this.config.repoRoot }
      );
    }

    const sourceTarPath = join(this.linuxBundleDir, "terrarium-src.tar");
    rmSync(sourceTarPath, { force: true });
    rmSync(this.sourceArchivePath, { force: true });
    await run(
      [
        "tar",
        "-cf",
        sourceTarPath,
        "--exclude=.git",
        "--exclude=node_modules",
        "--exclude=dist",
        "--exclude=ansible-wheelhouse",
        "--exclude=tests/integration/output",
        "-C",
        this.config.repoRoot,
        "."
      ],
      { cwd: this.config.repoRoot }
    );
    await run(
      [
        "tar",
        "-rf",
        sourceTarPath,
        "-C",
        this.linuxBundleDir,
        "ansible-wheelhouse"
      ],
      { cwd: this.config.repoRoot }
    );
    await run(["gzip", "-f", sourceTarPath], { cwd: this.config.repoRoot });
  }

  domainBundle(prefix: string, ip: string): DomainBundle {
    return {
      manage: this.publicDns.serviceHost(`${prefix}-manage`, this.config.slug, ip),
      proxy: this.publicDns.serviceHost(`${prefix}-proxy`, this.config.slug, ip),
      lxd: this.publicDns.serviceHost(`${prefix}-lxd`, this.config.slug, ip),
      auth: this.publicDns.serviceHost(`${prefix}-auth`, this.config.slug, ip)
    };
  }

  get externalOidcIssuer(): string {
    return this.externalOidcProvider.issuer;
  }

  async registerHetznerKey(name: string): Promise<number> {
    const publicKey = readFileSync(this.config.sshPublicKey, "utf8");
    const { id, reused } = await this.hetzner.createSshKey(name, publicKey);
    this.sshKeyIdByName.set(name, id);
    if (!reused) {
      this.resources.recordHetznerSshKey({ id, name });
    }
    return id;
  }

  async createHetznerServer(
    label: string,
    name: string,
    serverType: string,
    location: string,
    sshKeyIds: number[],
    labels: Record<string, string>
  ): Promise<ServerRecord> {
    const server = await this.hetzner.createServer(name, serverType, location, sshKeyIds, labels, (created) => {
      this.resources.recordHetznerServer({ ...created, label });
    });
    this.resources.recordHetznerServer({ ...server, label });
    return server;
  }

  async createHetznerVolume(label: string, name: string, sizeGb: number, location: string, labels: Record<string, string>): Promise<VolumeRecord> {
    const volume = await this.hetzner.createVolume(name, sizeGb, location, labels, (created) => {
      this.resources.recordHetznerVolume({ ...created, label });
    });
    this.resources.recordHetznerVolume({ ...volume, label });
    return volume;
  }

  async attachHetznerVolume(label: string, volumeId: number, serverId: number): Promise<VolumeRecord> {
    const volume = await this.hetzner.attachVolume(volumeId, serverId);
    this.resources.recordHetznerVolume({ ...volume, label, serverId });
    return volume;
  }

  async provisionExternalOidcFixture(
    slug: string,
    domains: DomainBundle,
    adminGroup: string,
    routeCallbackUris: string[] = [],
    extraDomains: DomainBundle[] = []
  ): Promise<ExternalOidcFixture> {
    return await this.externalOidcProvider.provisionFixture(slug, domains, adminGroup, routeCallbackUris, { extraDomains }, (progress) => {
      this.recordExternalOidcFixtureProgress(this.externalOidcProvider.provider, progress);
    });
  }

  async cleanupStaleExternalOidcFixtures(): Promise<void> {
    this.logger.info(`cleanup stale ${this.externalOidcProvider.provider} integration fixtures`);
    await this.externalOidcProvider.cleanupStaleIntegrationFixtures();
  }

  private recordExternalOidcFixtureProgress(
    idpProvider: IntegrationConfig["idpProvider"],
    progress: IntegrationOidcFixtureProgress
  ): void {
    if (progress.type === "project") {
      this.resources.recordExternalOidcFixtureProject({
        idpProvider,
        slug: progress.fixtureSlug,
        projectId: progress.projectId,
        projectName: progress.projectName,
        adminGroup: progress.adminGroup,
        routeGroups: progress.routeGroups
      });
      return;
    }
    if (progress.type === "app") {
      this.resources.recordExternalOidcFixtureApp({
        idpProvider,
        slug: progress.fixtureSlug,
        projectId: progress.projectId,
        appId: progress.appId,
        appName: progress.appName
      });
      return;
    }
    this.resources.recordExternalOidcFixtureUser({
      idpProvider,
      slug: progress.fixtureSlug,
      kind: progress.kind,
      userId: progress.userId,
      email: progress.email,
      roles: progress.roles
    });
  }

  async provisionZitadelFixture(
    slug: string,
    domains: DomainBundle,
    adminGroup: string,
    routeCallbackUris: string[] = [],
    extraDomains: DomainBundle[] = []
  ): Promise<ExternalOidcFixture> {
    return await this.zitadelCloud.provisionFixture(slug, domains, adminGroup, routeCallbackUris, { extraDomains }, (progress) => {
      if (progress.type === "project") {
        this.resources.recordZitadelFixtureProject({
          slug: progress.fixtureSlug,
          projectId: progress.projectId,
          projectName: progress.projectName,
          adminGroup: progress.adminGroup,
          routeGroups: progress.routeGroups
        });
        return;
      }
      if (progress.type === "app") {
        this.resources.recordZitadelFixtureApp({
          slug: progress.fixtureSlug,
          projectId: progress.projectId,
          appId: progress.appId,
          appName: progress.appName
        });
        return;
      }
      this.resources.recordZitadelFixtureUser({
        slug: progress.fixtureSlug,
        kind: progress.kind,
        userId: progress.userId,
        email: progress.email,
        roles: progress.roles
      });
    });
  }

  async cleanupStaleZitadelFixtures(): Promise<void> {
    this.logger.info("cleanup stale ZITADEL integration fixtures");
    await this.zitadelCloud.cleanupStaleIntegrationFixtures();
  }

  host(label: string, server: ServerRecord, domains: DomainBundle, volume?: VolumeRecord): ManagedHost {
    return { label, server, domains, volume };
  }

  ssh(host: ManagedHost): SshHost {
    return new SshHost(host.server.ipv4, this.config.sshUser, this.config.sshPrivateKey, this.logger.child(host.label));
  }

  async releaseHetznerHost(host: ManagedHost): Promise<void> {
    this.logger.info(`release Hetzner host ${host.label} (${host.server.id}) before continuing`);
    await this.withExpectedHetznerServerDeletion(host.server.id, async () => {
      await this.hetzner.deleteServer(host.server.id);
      await this.hetzner.waitForServerDeleted(host.server.id);
      this.resources.removeHetznerServer(host.server.id);
    });

    if (host.volume) {
      this.logger.info(`release Hetzner volume ${host.volume.id} for ${host.label}`);
      await this.hetzner.deleteVolume(host.volume.id);
      this.resources.removeHetznerVolume(host.volume.id);
    }
  }

  registerCleanup(task: CleanupTask): void {
    this.cleanupTasks.unshift(task);
  }

  async runCleanup(): Promise<void> {
    this.stopResourceGuard();
    if (this.cleanupPromise) {
      return await this.cleanupPromise;
    }
    this.cleanupPromise = this.runCleanupOnce();
    return await this.cleanupPromise;
  }

  startResourceGuard(onFatal: (error: Error) => void | Promise<void>, intervalMs?: number): void {
    if (this.resourceGuard) {
      return;
    }
    this.resourceGuard = new IntegrationResourceGuard({
      resources: this.resources,
      hetzner: this.hetzner,
      logger: this.logger,
      intervalMs,
      onFatal
    });
    this.resourceGuard.start();
  }

  stopResourceGuard(): void {
    this.resourceGuard?.stop();
    this.resourceGuard = undefined;
  }

  private async withExpectedHetznerServerDeletion<T>(serverId: number, task: () => Promise<T>): Promise<T> {
    if (!this.resourceGuard) {
      return await task();
    }
    return await this.resourceGuard.allowExpectedServerDeletion(serverId, task);
  }

  private async runCleanupOnce(): Promise<void> {
    const failures: string[] = [];
    const plan = buildCleanupPlan(this.resources.snapshot());
    for (const step of plan) {
      try {
        await this.runCleanupStep(step);
        this.removeCleanupStep(step);
      } catch (error) {
        failures.push(`${describeCleanupStep(step)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const task of this.cleanupTasks) {
      try {
        await task();
      } catch (error) {
        failures.push(String(error));
      }
    }
    if (failures.length > 0) {
      this.logger.warn(`cleanup completed with ${failures.length} failures:\n${failures.join("\n")}`);
    }
  }

  private async runCleanupStep(step: CleanupStep): Promise<void> {
    if (step.provider === "hetzner" && step.resourceType === "server") {
      await this.hetzner.deleteServer(step.resource.id);
      return;
    }
    if (step.provider === "hetzner" && step.resourceType === "volume") {
      await this.hetzner.deleteVolume(step.resource.id);
      return;
    }
    if (step.provider === "hetzner" && step.resourceType === "ssh-key") {
      await this.hetzner.deleteSshKey(step.resource.id);
      return;
    }
    if (step.provider === "external-oidc") {
      if (step.idpProvider !== this.externalOidcProvider.provider) {
        throw new Error(
          `external OIDC cleanup step targets ${step.idpProvider}, but selected provider is ${this.externalOidcProvider.provider}`
        );
      }
      await this.externalOidcProvider.deleteFixtureResource(step);
    }
  }

  private removeCleanupStep(step: CleanupStep): void {
    if (step.provider === "hetzner" && step.resourceType === "server") {
      this.resources.removeHetznerServer(step.resource.id);
      return;
    }
    if (step.provider === "hetzner" && step.resourceType === "volume") {
      this.resources.removeHetznerVolume(step.resource.id);
      return;
    }
    if (step.provider === "hetzner" && step.resourceType === "ssh-key") {
      this.resources.removeHetznerSshKey(step.resource.id);
      return;
    }
    if (step.provider === "external-oidc") {
      if (step.resourceType === "user") {
        if (step.idpProvider === "zitadel") {
          this.resources.removeZitadelFixtureUser(step.fixtureSlug, step.resource.userId);
        } else {
          this.resources.removeExternalOidcFixtureUser(step.idpProvider, step.fixtureSlug, step.resource.userId);
        }
        return;
      }
      if (step.resourceType === "app") {
        if (step.idpProvider === "zitadel") {
          this.resources.removeZitadelFixtureApp(step.fixtureSlug, step.appId);
        } else {
          this.resources.removeExternalOidcFixtureApp(step.idpProvider, step.fixtureSlug, step.appId);
        }
        return;
      }
      if (step.resourceType === "role") {
        this.resources.removeExternalOidcFixtureRole(step.idpProvider, step.fixtureSlug, step.resource.roleId);
        return;
      }
      if (step.resourceType === "api-resource") {
        this.resources.removeExternalOidcFixtureApiResource(step.idpProvider, step.fixtureSlug, step.resource.apiResourceId);
        return;
      }
      if (step.resourceType === "container") {
        this.resources.removeExternalOidcFixtureContainer(step.idpProvider, step.fixtureSlug);
        return;
      }
      if (step.resourceType === "project") {
        if (step.idpProvider === "zitadel") {
          this.resources.removeZitadelFixtureProject(step.fixtureSlug);
        } else {
          this.resources.removeExternalOidcFixtureProject(step.idpProvider, step.fixtureSlug);
        }
      }
    }
  }

  async withScenario(name: string, runScenario: () => Promise<void>): Promise<void> {
    if (this.config.only.size > 0 && !this.config.only.has(name)) {
      this.logger.info(`skip scenario ${name} because it is not in --only`);
      return;
    }

    const result: ScenarioResult = {
      name,
      startedAt: new Date().toISOString(),
      finishedAt: "",
      success: false,
      notes: []
    };
    this.results.push(result);
    try {
      await runScenario();
      result.success = true;
    } catch (error) {
      const rendered = error instanceof Error ? error.stack || error.message : String(error);
      result.notes.push(rendered);
      this.logger.error(`scenario ${name} failed:\n${rendered}`);
      throw error;
    } finally {
      result.finishedAt = new Date().toISOString();
      writeFileSync(join(this.config.outputDir, "results.json"), `${JSON.stringify(this.results, null, 2)}\n`, "utf8");
    }
  }
}

/** Creates the integration context from CLI options. */
export function createContext(options: IntegrationCliOptions): IntegrationContext {
  return new IntegrationContext(options);
}
