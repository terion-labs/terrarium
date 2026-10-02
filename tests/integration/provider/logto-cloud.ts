import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type { DomainBundle, ExternalOidcFixture, IntegrationConfig, OidcTestUser } from "../types";
import type { IntegrationLogger } from "../lib/logger";
import type {
  ExternalOidcCleanupStep,
  IntegrationOidcFixtureOptions,
  IntegrationOidcFixtureProgress,
  IntegrationOidcFixtureProgressHandler,
  IntegrationOidcProvider
} from "./external-oidc";

export type LogtoFixtureProgress = IntegrationOidcFixtureProgress;
export type LogtoFixtureProgressHandler = IntegrationOidcFixtureProgressHandler;
export type LogtoCleanupStep = ExternalOidcCleanupStep & { idpProvider: "logto" };

export type LogtoCloudProviderDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  generatePassword?: () => string;
};

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
type TokenResponse = { access_token?: string; expires_in?: number };
type LogtoRole = {
  id?: string;
  name?: string;
  description?: string;
  customData?: Record<string, unknown>;
  createdAt?: string;
};
type LogtoApplication = {
  id?: string;
  appId?: string;
  name?: string;
  clientId?: string;
  secret?: string;
  clientSecret?: string;
  customData?: Record<string, unknown>;
  createdAt?: string;
};
type LogtoUser = {
  id?: string;
  userId?: string;
  primaryEmail?: string;
  email?: string;
  customData?: Record<string, unknown>;
  createdAt?: string;
};
type ListResult<T> = T[] | { data?: T[]; results?: T[] };

type CreatedResource = {
  label: string;
  delete: () => Promise<void>;
};

const DENIED_ROUTE_ROLE = "bystanders";
const ROUTE_GROUPS = ["agents", "admins"] as const;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const TERRARIUM_APP_PATTERN = /^terrarium-[a-z0-9-]+-(?:external|lxd)$/;
const TERRARIUM_USER_EMAIL_PATTERN = /^(?:admin|agent|denied)\+[a-z0-9-]+@example\.net$/;

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function normalizeRouteCallbackUri(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (/^https:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}/oauth2/callback`;
}

export function buildLogtoCloudRedirectUris(domains: DomainBundle, routeCallbackUris: string[] = [], extraDomains: DomainBundle[] = []): string[] {
  return [
    ...new Set([
      ...buildLogtoCloudManagementRedirectUris(domains, routeCallbackUris, extraDomains),
      ...buildLogtoCloudLxdRedirectUris(domains, extraDomains)
    ])
  ];
}

export function buildLogtoCloudManagementRedirectUris(
  domains: DomainBundle,
  routeCallbackUris: string[] = [],
  extraDomains: DomainBundle[] = []
): string[] {
  const redirectUris = new Set<string>();
  for (const domainBundle of [domains, ...extraDomains]) {
    redirectUris.add(`https://${domainBundle.manage}/oauth2/callback`);
    redirectUris.add(`https://${domainBundle.proxy}/oauth2/callback`);
    redirectUris.add(`https://${domainBundle.manage}/oauth2/app/callback`);
  }
  for (const callbackUri of routeCallbackUris) {
    const normalized = normalizeRouteCallbackUri(callbackUri);
    if (normalized) {
      redirectUris.add(normalized);
    }
  }
  return [...redirectUris];
}

export function buildLogtoCloudLxdRedirectUris(domains: DomainBundle, extraDomains: DomainBundle[] = []): string[] {
  return [...new Set([domains, ...extraDomains].map((domainBundle) => `https://${domainBundle.lxd}/oidc/callback`))];
}

function generateComplexPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let suffix = "";
  const bytes = randomBytes(12);
  for (const byte of bytes) {
    suffix += alphabet[byte % alphabet.length];
  }
  return `Aa1!${suffix}`;
}

function listItems<T>(result: ListResult<T>): T[] {
  if (Array.isArray(result)) {
    return result;
  }
  return result.data ?? result.results ?? [];
}

function marker(slug: string): Record<string, unknown> {
  return {
    terrarium: {
      owned: true,
      slug
    }
  };
}

function isTerrariumMarked(resource: { customData?: Record<string, unknown> }): boolean {
  const customData = resource.customData ?? {};
  const nested = customData.terrarium;
  return (
    (typeof nested === "object" && nested !== null && (nested as { owned?: unknown }).owned === true) ||
    customData.terrariumOwned === true
  );
}

function createdTime(resource: { createdAt?: string; customData?: Record<string, unknown> }): number {
  const nested = resource.customData?.terrarium;
  const markerCreatedAt = typeof nested === "object" && nested !== null ? (nested as { createdAt?: unknown }).createdAt : undefined;
  const value = typeof markerCreatedAt === "string" ? markerCreatedAt : resource.createdAt;
  return value ? Date.parse(value) : Number.NaN;
}

function isOldTerrariumResource(resource: { createdAt?: string; customData?: Record<string, unknown> }, now: number): boolean {
  if (!isTerrariumMarked(resource)) {
    return false;
  }
  const created = createdTime(resource);
  return Number.isFinite(created) && now - created >= STALE_AFTER_MS;
}

function maybeJsonRedact(value: string): string {
  return value
    .replace(/("(?:access_token|client_secret|clientSecret|secret|password|logtoM2mClientSecret)"\s*:\s*")([^"]+)(")/gi, "$1[REDACTED]$3")
    .replace(/(authorization:\s*(?:bearer|basic)\s+)[^\s,}]+/gi, "$1[REDACTED]")
    .replace(/((?:access_token|client_secret|clientSecret|secret|password)=)[^&\s]+/gi, "$1[REDACTED]");
}

/**
 * Creates Logto fixtures in an existing tenant. Tenant/container/project deletion is intentionally a no-op.
 */
export class LogtoCloudProvider implements IntegrationOidcProvider {
  readonly provider = "logto" as const;
  readonly issuer: string;

  private readonly tenantEndpoint: string;
  private readonly managementApiBase: string;
  private readonly managementApiResource: string;
  private readonly m2mClientId: string;
  private readonly m2mClientSecret: string;
  private readonly logger: IntegrationLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly generatePassword: () => string;
  private readonly requestTimeoutMs = 45000;
  private readonly redactionValues = new Set<string>();
  private cachedToken?: { token: string; expiresAtMs: number };

  constructor(config: IntegrationConfig, logger: IntegrationLogger, deps: LogtoCloudProviderDeps = {}) {
    this.tenantEndpoint = normalizeEndpoint(config.logtoTenantEndpoint);
    this.issuer = `${this.tenantEndpoint}/oidc`;
    this.managementApiBase = `${this.tenantEndpoint}/api`;
    this.managementApiResource = normalizeEndpoint(config.logtoManagementApiResource || `${this.tenantEndpoint}/api`);
    this.m2mClientId = config.logtoM2mClientId;
    this.m2mClientSecret = config.logtoM2mClientSecret;
    this.logger = logger;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.generatePassword = deps.generatePassword ?? generateComplexPassword;
    for (const value of [this.m2mClientId, this.m2mClientSecret]) {
      if (value) {
        this.redactionValues.add(value);
      }
    }
  }

  private redact(value: unknown): string {
    let text = maybeJsonRedact(value instanceof Error ? value.message : String(value));
    for (const secret of this.redactionValues) {
      if (secret) {
        text = text.split(secret).join("[REDACTED]");
      }
    }
    return text;
  }

  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.cachedToken && now < this.cachedToken.expiresAtMs - 60_000) {
      return this.cachedToken.token;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      resource: this.managementApiResource,
      scope: "all"
    });
    const basicAuth = Buffer.from(`${this.m2mClientId}:${this.m2mClientSecret}`, "utf8").toString("base64");
    this.logger.info("logto POST /oidc/token");
    const response = await this.fetchImpl(`${this.tenantEndpoint}/oidc/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basicAuth}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body.toString(),
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    if (!response.ok) {
      throw new Error(`Logto POST /oidc/token failed with HTTP ${response.status}: ${this.redact(await response.text())}`);
    }
    const token = (await response.json()) as TokenResponse;
    if (!token.access_token) {
      throw new Error("Logto token response did not include an access token");
    }
    this.redactionValues.add(token.access_token);
    this.cachedToken = {
      token: token.access_token,
      expiresAtMs: now + Math.max(0, token.expires_in ?? 3600) * 1000
    };
    return token.access_token;
  }

  private async api<T>(method: HttpMethod, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.managementApiBase}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    this.logger.info(`logto ${method} ${url.pathname}`);
    const token = await this.accessToken();
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined || method === "GET" ? {} : { "content-type": "application/json" })
      },
      body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    if (response.status === 204) {
      return {} as T;
    }
    if (!response.ok) {
      throw new Error(`Logto ${method} ${path} failed with HTTP ${response.status}: ${this.redact(await response.text())}`);
    }
    return (await response.json()) as T;
  }

  private async deleteResource(path: string): Promise<void> {
    const url = new URL(`${this.managementApiBase}${path}`);
    this.logger.info(`logto DELETE ${url.pathname}`);
    const token = await this.accessToken();
    const response = await this.fetchImpl(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    if (response.ok || response.status === 404) {
      return;
    }
    throw new Error(`Logto DELETE ${path} failed with HTTP ${response.status}: ${this.redact(await response.text())}`);
  }

  async verifyManagementAccess(): Promise<void> {
    await this.api("GET", "/applications", undefined, { page: "1", page_size: "1" });
  }

  async cleanupStaleIntegrationFixtures(): Promise<void> {
    const now = this.now();
    const users = listItems(await this.api<ListResult<LogtoUser>>("GET", "/users", undefined, { page: "1", page_size: "100" }));
    for (const user of users) {
      const userId = user.id ?? user.userId ?? "";
      const email = user.primaryEmail ?? user.email ?? "";
      if (userId && TERRARIUM_USER_EMAIL_PATTERN.test(email) && isOldTerrariumResource(user, now)) {
        await this.deleteUser(userId);
      }
    }

    const applications = listItems(await this.api<ListResult<LogtoApplication>>("GET", "/applications", undefined, { page: "1", page_size: "100" }));
    for (const app of applications) {
      const appId = app.id ?? app.appId ?? "";
      if (appId && app.name && TERRARIUM_APP_PATTERN.test(app.name) && isOldTerrariumResource(app, now)) {
        await this.deleteApp("", appId);
      }
    }

    const roles = listItems(await this.api<ListResult<LogtoRole>>("GET", "/roles", undefined, { page: "1", page_size: "100" }));
    for (const role of roles) {
      if (role.id && role.name && isOldTerrariumResource(role, now)) {
        await this.deleteRole(role.id);
      }
    }
  }

  private async listRoles(): Promise<LogtoRole[]> {
    return listItems(await this.api<ListResult<LogtoRole>>("GET", "/roles", undefined, { page: "1", page_size: "100" }));
  }

  private async ensureRoles(slug: string, roleNames: string[], created: CreatedResource[]): Promise<Map<string, string>> {
    const existing = await this.listRoles();
    const byName = new Map<string, LogtoRole>();
    for (const role of existing) {
      if (role.name) {
        byName.set(role.name, role);
      }
    }
    const roleIds = new Map<string, string>();
    for (const name of roleNames) {
      const found = byName.get(name);
      if (found?.id) {
        roleIds.set(name, found.id);
        continue;
      }
      const role = await this.api<LogtoRole>("POST", "/roles", {
        name,
        description: `Terrarium integration role ${name}`,
        customData: marker(slug)
      });
      if (!role.id) {
        throw new Error(`failed to create Logto role ${name}`);
      }
      roleIds.set(name, role.id);
      created.push({ label: `role ${role.id}`, delete: () => this.deleteRole(role.id ?? "") });
    }
    return roleIds;
  }

  private async createApplication(
    slug: string,
    name: string,
    type: "Traditional" | "Native",
    redirectUris: string[],
    postLogoutRedirectUris: string[],
    created: CreatedResource[]
  ): Promise<{ appId: string; clientId: string; clientSecret: string }> {
    const app = await this.api<LogtoApplication>("POST", "/applications", {
      name,
      type,
      oidcClientMetadata: {
        redirectUris,
        postLogoutRedirectUris
      },
      customData: marker(slug)
    });
    const appId = app.id ?? app.appId ?? "";
    const clientId = app.clientId ?? appId;
    if (!appId || !clientId) {
      throw new Error("failed to create Logto OIDC application");
    }
    created.push({ label: `app ${appId}`, delete: () => this.deleteApp("", appId) });
    let clientSecret = type === "Native" ? "" : app.secret ?? app.clientSecret ?? "";
    if (type !== "Native" && !clientSecret) {
      const secret = await this.api<{ value?: string }>("POST", `/applications/${encodeURIComponent(appId)}/secrets`, { name: "terrarium-integration" });
      clientSecret = secret.value ?? "";
      if (!clientSecret) throw new Error("Logto application secret response did not include a value");
    }
    if (clientSecret) {
      this.redactionValues.add(clientSecret);
    }
    return { appId, clientId, clientSecret };
  }

  private async createUser(slug: string, kind: "admin" | "agent" | "denied", password: string): Promise<{ userId: string; email: string }> {
    const email = `${kind}+${slug}@example.net`;
    this.redactionValues.add(password);
    const user = await this.api<LogtoUser>("POST", "/users", {
      primaryEmail: email,
      name: email,
      password,
      emailVerified: true,
      customData: marker(slug)
    });
    const userId = user.id ?? user.userId ?? "";
    if (!userId) {
      throw new Error(`failed to create Logto user for ${email}`);
    }
    return { userId, email };
  }

  private async assignRoles(userId: string, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) {
      return;
    }
    await this.api("POST", `/users/${userId}/roles`, { roleIds });
  }

  private async cleanupCreatedResources(created: CreatedResource[]): Promise<string[]> {
    const diagnostics: string[] = [];
    for (const resource of [...created].reverse()) {
      try {
        await resource.delete();
      } catch (error) {
        diagnostics.push(`${resource.label}: ${this.redact(error)}`);
      }
    }
    return diagnostics;
  }

  async provisionFixture(
    slug: string,
    domains: DomainBundle,
    adminGroup: string,
    routeCallbackUris: string[] = [],
    options: IntegrationOidcFixtureOptions = {},
    onProgress?: LogtoFixtureProgressHandler
  ): Promise<ExternalOidcFixture> {
    const created: CreatedResource[] = [];
    try {
      const projectId = `logto:${slug}`;
      const projectName = `terrarium-${slug}`;
      const appName = `terrarium-${slug}-external`;
      const lxdAppName = `terrarium-${slug}-lxd`;
      const routeGroups = [...ROUTE_GROUPS];
      await onProgress?.({ type: "project", fixtureSlug: slug, projectId, projectName, adminGroup, routeGroups });

      const roles = await this.ensureRoles(slug, [adminGroup, ...routeGroups, DENIED_ROUTE_ROLE], created);
      const app = await this.createApplication(
        slug,
        appName,
        "Traditional",
        buildLogtoCloudManagementRedirectUris(domains, routeCallbackUris, options.extraDomains ?? []),
        [`https://${domains.manage}`],
        created
      );
      await onProgress?.({ type: "app", fixtureSlug: slug, projectId, appId: app.appId, appName });

      const lxdApp = await this.createApplication(
        slug,
        lxdAppName,
        "Native",
        buildLogtoCloudLxdRedirectUris(domains, options.extraDomains ?? []),
        [`https://${domains.lxd}`],
        created
      );
      await onProgress?.({ type: "app", fixtureSlug: slug, projectId, appId: lxdApp.appId, appName: lxdAppName });

      const adminPassword = this.generatePassword();
      const admin = await this.createUser(slug, "admin", adminPassword);
      const adminRoles = [adminGroup, "admins"];
      created.push({ label: `user ${admin.userId}`, delete: () => this.deleteUser(admin.userId) });
      await onProgress?.({ type: "user", fixtureSlug: slug, kind: "adminUser", userId: admin.userId, email: admin.email, roles: adminRoles });
      const adminUser: OidcTestUser = { userId: admin.userId, email: admin.email, password: adminPassword, roles: adminRoles };

      const routePassword = this.generatePassword();
      const route = await this.createUser(slug, "agent", routePassword);
      const routeRoles = ["agents"];
      created.push({ label: `user ${route.userId}`, delete: () => this.deleteUser(route.userId) });
      await onProgress?.({ type: "user", fixtureSlug: slug, kind: "routeUser", userId: route.userId, email: route.email, roles: routeRoles });
      const routeUser: OidcTestUser = { userId: route.userId, email: route.email, password: routePassword, roles: routeRoles };

      const deniedPassword = this.generatePassword();
      const denied = await this.createUser(slug, "denied", deniedPassword);
      const deniedRoles = [DENIED_ROUTE_ROLE];
      created.push({ label: `user ${denied.userId}`, delete: () => this.deleteUser(denied.userId) });
      await onProgress?.({ type: "user", fixtureSlug: slug, kind: "deniedUser", userId: denied.userId, email: denied.email, roles: deniedRoles });
      const deniedUser: OidcTestUser = { userId: denied.userId, email: denied.email, password: deniedPassword, roles: deniedRoles };

      await this.assignRoles(
        adminUser.userId,
        adminRoles.map((roleName) => roles.get(roleName)).filter((roleId): roleId is string => Boolean(roleId))
      );
      await this.assignRoles(
        routeUser.userId,
        routeRoles.map((roleName) => roles.get(roleName)).filter((roleId): roleId is string => Boolean(roleId))
      );
      await this.assignRoles(
        deniedUser.userId,
        deniedRoles.map((roleName) => roles.get(roleName)).filter((roleId): roleId is string => Boolean(roleId))
      );

      return {
        projectId,
        projectName,
        appId: app.appId,
        appName,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        lxdAppId: lxdApp.appId,
        lxdAppName,
        lxdClientId: lxdApp.clientId,
        lxdClientSecret: "",
        adminGroup,
        routeGroups,
        adminUser,
        routeUser,
        deniedUser
      };
    } catch (error) {
      const diagnostics = await this.cleanupCreatedResources(created);
      const message = this.redact(error);
      if (diagnostics.length > 0) {
        throw new Error(`${message}; cleanup diagnostics: ${diagnostics.join("; ")}`);
      }
      throw new Error(message);
    }
  }

  async cleanupFixture(fixture: ExternalOidcFixture): Promise<void> {
    for (const user of [fixture.adminUser, fixture.routeUser, fixture.deniedUser]) {
      await this.deleteUser(user.userId);
    }
    await this.deleteApp(fixture.projectId, fixture.lxdAppId);
    await this.deleteApp(fixture.projectId, fixture.appId);
    await this.deleteProject(fixture.projectId);
  }

  async deleteFixtureResource(step: ExternalOidcCleanupStep): Promise<void> {
    if (step.idpProvider !== this.provider) {
      throw new Error(`Logto cleanup received ${step.idpProvider} cleanup step`);
    }
    if (step.resourceType === "user") {
      await this.deleteUser(step.resource.userId);
      return;
    }
    if (step.resourceType === "app") {
      await this.deleteApp(step.projectId ?? step.resource.projectId ?? "", step.appId);
      return;
    }
    if (step.resourceType === "role") {
      await this.deleteRole(step.resource.roleId);
      return;
    }
    if (step.resourceType === "api-resource") {
      await this.deleteApiResource(step.resource.apiResourceId);
      return;
    }
    if (step.resourceType === "project") {
      await this.deleteProject(step.projectId);
      return;
    }
    await this.deleteProject(step.containerId);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.deleteResource(`/users/${userId}`);
  }

  async deleteApp(_projectId: string, appId: string): Promise<void> {
    await this.deleteResource(`/applications/${appId}`);
  }

  async deleteProject(_projectId: string): Promise<void> {
    // Logto mode uses an existing tenant. Never delete tenant/project/container state here.
  }

  async deleteRole(roleId: string): Promise<void> {
    await this.deleteResource(`/roles/${roleId}`);
  }

  async deleteApiResource(apiResourceId: string): Promise<void> {
    await this.deleteResource(`/resources/${apiResourceId}`);
  }
}
