import { Buffer } from "node:buffer";
import { afterEach, describe, expect, test } from "bun:test";
import type { IntegrationLogger } from "../lib/logger";
import type { ExternalOidcFixture, IntegrationConfig } from "../types";
import type { IntegrationOidcProvider } from "./external-oidc";
import {
  buildLogtoCloudLxdRedirectUris,
  buildLogtoCloudManagementRedirectUris,
  LogtoCloudProvider,
  type LogtoCleanupStep,
  type LogtoFixtureProgress
} from "./logto-cloud";

const originalFetch = globalThis.fetch;

type FetchCall = {
  input: Parameters<typeof fetch>[0];
  init?: Parameters<typeof fetch>[1];
};

const logger = {
  path: "",
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  }
} as unknown as IntegrationLogger;

function createConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    logtoTenantEndpoint: "https://tenant.logto.test/",
    logtoM2mClientId: "m2m-client",
    logtoM2mClientSecret: "m2m-secret",
    logtoManagementApiResource: "https://tenant.logto.test/api/",
    ...overrides
  } as IntegrationConfig;
}

function createProvider(overrides: Partial<IntegrationConfig> = {}, deps: ConstructorParameters<typeof LogtoCloudProvider>[2] = {}): LogtoCloudProvider {
  return new LogtoCloudProvider(createConfig(overrides), logger, deps);
}

function installFetchMock(respond: (call: FetchCall, index: number) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const call = { input, init };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

function callUrl(call: FetchCall): URL {
  return new URL(String(call.input));
}

function callPath(call: FetchCall): string {
  return callUrl(call).pathname;
}

function jsonBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body ?? "{}")) as Record<string, unknown>;
}

function formBody(call: FetchCall): URLSearchParams {
  return new URLSearchParams(String(call.init?.body ?? ""));
}

function managementCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => callPath(call) !== "/oidc/token");
}

function successfulLogtoResponse(call: FetchCall): Response {
  const path = callPath(call);
  const method = call.init?.method ?? "GET";
  if (path === "/oidc/token") {
    return Response.json({ access_token: "token-1", expires_in: 3600 });
  }
  if (method === "GET" && path === "/api/roles") {
    return Response.json({ data: [] });
  }
  if (method === "POST" && path === "/api/roles") {
    const body = jsonBody(call);
    return Response.json({ id: `role-${body.name}`, name: body.name });
  }
  if (method === "POST" && path === "/api/applications") {
    const body = jsonBody(call);
    return body.type === "Native"
      ? Response.json({ id: "lxd-app-1", clientId: "lxd-client-1" })
      : Response.json({ id: "app-1", clientId: "client-1", secret: "client-secret-1" });
  }
  if (method === "POST" && path === "/api/users") {
    const email = String(jsonBody(call).primaryEmail);
    if (email.startsWith("admin+")) return Response.json({ id: "admin-user" });
    if (email.startsWith("agent+")) return Response.json({ id: "route-user" });
    return Response.json({ id: "denied-user" });
  }
  if (method === "POST" && path.endsWith("/roles")) {
    return Response.json({});
  }
  if (method === "DELETE") {
    return new Response(null, { status: 204 });
  }
  throw new Error(`unexpected ${method} ${path}`);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Logto Cloud provider", () => {
  test("normalizes provider identity and is assignable to the external OIDC interface", () => {
    const provider: IntegrationOidcProvider = createProvider({ logtoTenantEndpoint: "https://tenant.logto.test///", logtoManagementApiResource: "" });

    expect(provider.provider).toBe("logto");
    expect(provider.issuer).toBe("https://tenant.logto.test/oidc");
  });

  test("requests client-credentials tokens with Basic auth and reuses them until near expiry", async () => {
    let now = 1_000;
    let tokenNumber = 0;
    const calls = installFetchMock((call) => {
      if (callPath(call) === "/oidc/token") {
        tokenNumber += 1;
        return Response.json({ access_token: `token-${tokenNumber}`, expires_in: 120 });
      }
      return Response.json({ data: [] });
    });
    const provider = createProvider({ logtoManagementApiResource: "" }, { now: () => now });

    await provider.verifyManagementAccess();
    now = 50_000;
    await provider.verifyManagementAccess();
    now = 70_000;
    await provider.verifyManagementAccess();

    const tokenCalls = calls.filter((call) => callPath(call) === "/oidc/token");
    expect(tokenCalls).toHaveLength(2);
    expect(String(tokenCalls[0].input)).toBe("https://tenant.logto.test/oidc/token");
    const tokenHeaders = new Headers(tokenCalls[0].init?.headers);
    expect(tokenCalls[0].init?.method).toBe("POST");
    expect(Buffer.from(tokenHeaders.get("authorization")!.replace("Basic ", ""), "base64").toString("utf8")).toBe("m2m-client:m2m-secret");
    expect(tokenHeaders.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(formBody(tokenCalls[0]).get("grant_type")).toBe("client_credentials");
    expect(formBody(tokenCalls[0]).get("resource")).toBe("https://tenant.logto.test/api");
    expect(formBody(tokenCalls[0]).get("scope")).toBe("all");

    const bearerHeaders = managementCalls(calls).map((call) => new Headers(call.init?.headers).get("authorization"));
    expect(bearerHeaders).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-2"]);
  });

  test("management preflight performs an authenticated low-impact application list", async () => {
    const calls = installFetchMock((call) => (callPath(call) === "/oidc/token" ? Response.json({ access_token: "token-1" }) : Response.json({ data: [] })));

    await createProvider().verifyManagementAccess();

    expect(calls.map(callPath)).toEqual(["/oidc/token", "/api/applications"]);
    expect(callUrl(calls[1]).searchParams.get("page")).toBe("1");
    expect(callUrl(calls[1]).searchParams.get("page_size")).toBe("1");
    expect(calls[1].init?.method).toBe("GET");
    expect(String(calls[1].input)).toBe("https://tenant.logto.test/api/applications?page=1&page_size=1");
    expect(new Headers(calls[1].init?.headers).get("authorization")).toBe("Bearer token-1");
  });

  test("builds management and LXD redirect URIs for seed, extra domains, and bare route hosts", () => {
    const domains = { manage: "manage.example.test", proxy: "proxy.example.test", lxd: "lxd.example.test", auth: "auth.example.test" };
    const extraDomains = [{ manage: "manage2.example.test", proxy: "proxy2.example.test", lxd: "lxd2.example.test", auth: "auth2.example.test" }];

    expect(buildLogtoCloudManagementRedirectUris(domains, ["route.example.test", "https://custom.example.test/oauth2/callback"], extraDomains)).toEqual([
      "https://manage.example.test/oauth2/callback",
      "https://proxy.example.test/oauth2/callback",
      "https://manage.example.test/oauth2/app/callback",
      "https://manage2.example.test/oauth2/callback",
      "https://proxy2.example.test/oauth2/callback",
      "https://manage2.example.test/oauth2/app/callback",
      "https://route.example.test/oauth2/callback",
      "https://custom.example.test/oauth2/callback"
    ]);
    expect(buildLogtoCloudLxdRedirectUris(domains, extraDomains)).toEqual([
      "https://lxd.example.test/oidc/callback",
      "https://lxd2.example.test/oidc/callback"
    ]);
  });

  test("provisions roles, applications, users, role assignments, and progress events", async () => {
    const calls = installFetchMock(successfulLogtoResponse);
    const progress: LogtoFixtureProgress[] = [];
    const provider = createProvider({}, { generatePassword: (() => {
      const passwords = ["AdminPass1!", "RoutePass1!", "DeniedPass1!"];
      return () => passwords.shift() ?? "FallbackPass1!";
    })() });

    const fixture = await provider.provisionFixture(
      "run-d",
      { manage: "manage.example.test", proxy: "proxy.example.test", lxd: "lxd.example.test", auth: "auth.example.test" },
      "terrarium-admins",
      ["route.example.test"],
      { extraDomains: [{ manage: "manage2.example.test", proxy: "proxy2.example.test", lxd: "lxd2.example.test", auth: "auth2.example.test" }] },
      (event) => {
        progress.push(event);
      }
    );

    expect(managementCalls(calls).map(callPath)).toEqual([
      "/api/roles",
      "/api/roles",
      "/api/roles",
      "/api/roles",
      "/api/roles",
      "/api/applications",
      "/api/applications",
      "/api/users",
      "/api/users",
      "/api/users",
      "/api/users/admin-user/roles",
      "/api/users/route-user/roles",
      "/api/users/denied-user/roles"
    ]);
    const createdRoleNames = managementCalls(calls)
      .filter((call) => call.init?.method === "POST" && callPath(call) === "/api/roles")
      .map((call) => jsonBody(call).name);
    expect(createdRoleNames).toEqual(["terrarium-admins", "agents", "admins", "bystanders"]);

    const appBodies = managementCalls(calls).filter((call) => callPath(call) === "/api/applications").map(jsonBody);
    expect(appBodies[0].type).toBe("Traditional");
    expect((appBodies[0].oidcClientMetadata as { redirectUris: string[] }).redirectUris).toContain("https://route.example.test/oauth2/callback");
    expect((appBodies[0].oidcClientMetadata as { redirectUris: string[] }).redirectUris).toContain("https://manage2.example.test/oauth2/callback");
    expect(appBodies[1].type).toBe("Native");
    expect((appBodies[1].oidcClientMetadata as { redirectUris: string[] }).redirectUris).toEqual([
      "https://lxd.example.test/oidc/callback",
      "https://lxd2.example.test/oidc/callback"
    ]);

    const userBodies = managementCalls(calls).filter((call) => callPath(call) === "/api/users").map(jsonBody);
    expect(userBodies.map((body) => body.primaryEmail)).toEqual([
      "admin+run-d@example.net",
      "agent+run-d@example.net",
      "denied+run-d@example.net"
    ]);
    expect(userBodies.map((body) => body.password)).toEqual(["AdminPass1!", "RoutePass1!", "DeniedPass1!"]);
    const assignments = managementCalls(calls).filter((call) => callPath(call).endsWith("/roles") && callPath(call) !== "/api/roles").map(jsonBody);
    expect(assignments).toEqual([
      { roleIds: ["role-terrarium-admins", "role-admins"] },
      { roleIds: ["role-agents"] },
      { roleIds: ["role-bystanders"] }
    ]);

    expect(progress.map((event) => event.type)).toEqual(["project", "app", "app", "user", "user", "user"]);
    expect(fixture).toMatchObject({
      projectId: "logto:run-d",
      projectName: "terrarium-run-d",
      appId: "app-1",
      appName: "terrarium-run-d-external",
      clientId: "client-1",
      clientSecret: "client-secret-1",
      lxdAppId: "lxd-app-1",
      lxdAppName: "terrarium-run-d-lxd",
      lxdClientId: "lxd-client-1",
      lxdClientSecret: "",
      adminGroup: "terrarium-admins",
      routeGroups: ["agents", "admins"],
      adminUser: { userId: "admin-user", email: "admin+run-d@example.net", password: "AdminPass1!", roles: ["terrarium-admins", "admins"] },
      routeUser: { userId: "route-user", email: "agent+run-d@example.net", password: "RoutePass1!", roles: ["agents"] },
      deniedUser: { userId: "denied-user", email: "denied+run-d@example.net", password: "DeniedPass1!", roles: ["bystanders"] }
    });
  });

  test("creates a dedicated secret when the application response omits the legacy secret", async () => {
    const calls = installFetchMock((call) => {
      if (call.init?.method === "POST" && callPath(call) === "/api/applications" && jsonBody(call).type === "Traditional") return Response.json({ id: "app-1" });
      if (callPath(call) === "/api/applications/app-1/secrets") return Response.json({ name: "terrarium-integration", value: "current-client-secret" });
      return successfulLogtoResponse(call);
    });
    const fixture = await createProvider().provisionFixture("current-api", { manage: "manage.test", proxy: "proxy.test", lxd: "lxd.test", auth: "auth.test" }, "terrarium-admins");
    expect(fixture.clientId).toBe("app-1");
    expect(fixture.clientSecret).toBe("current-client-secret");
    expect(fixture.lxdClientSecret).toBe("");
    const secrets = calls.filter((call) => callPath(call).endsWith("/secrets"));
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.init?.method).toBe("POST");
    expect(jsonBody(secrets[0]!)).toEqual({ name: "terrarium-integration" });
  });

  test("removes a newly created application when secret creation fails", async () => {
    const calls = installFetchMock((call) => {
      if (call.init?.method === "POST" && callPath(call) === "/api/applications") return Response.json({ id: "app-1" });
      if (callPath(call) === "/api/applications/app-1/secrets") return new Response("unavailable", { status: 503 });
      return successfulLogtoResponse(call);
    });
    await expect(createProvider().provisionFixture("secret-failure", { manage: "manage.test", proxy: "proxy.test", lxd: "lxd.test", auth: "auth.test" }, "terrarium-admins")).rejects.toThrow("HTTP 503");
    expect(calls.filter((call) => call.init?.method === "DELETE").map(callPath)).toEqual([
      "/api/applications/app-1", "/api/roles/role-bystanders", "/api/roles/role-admins", "/api/roles/role-agents", "/api/roles/role-terrarium-admins"
    ]);
  });

  test("cleans up partial provisioning in reverse order and redacts secrets in the thrown error", async () => {
    const calls = installFetchMock((call) => {
      const method = call.init?.method ?? "GET";
      const path = callPath(call);
      if (path === "/oidc/token") return Response.json({ access_token: "token-secret" });
      if (method === "GET" && path === "/api/roles") return Response.json({ data: [] });
      if (method === "POST" && path === "/api/roles") return Response.json({ id: `role-${jsonBody(call).name}` });
      if (method === "POST" && path === "/api/applications") {
        return jsonBody(call).type === "Native"
          ? Response.json({ id: "lxd-app-1", clientId: "lxd-client-1" })
          : Response.json({ id: "app-1", clientId: "client-1", secret: "client-secret-1" });
      }
      if (method === "POST" && path === "/api/users") {
        const email = String(jsonBody(call).primaryEmail);
        if (email.startsWith("admin+")) return Response.json({ id: "admin-user" });
        return new Response('{"error":"RoutePass1! client-secret-1 token-secret m2m-secret"}', { status: 500 });
      }
      if (method === "DELETE" && path === "/api/applications/lxd-app-1") {
        return new Response('{"secret":"client-secret-1","access_token":"token-secret"}', { status: 500 });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`unexpected ${method} ${path}`);
    });
    const provider = createProvider({}, { generatePassword: (() => {
      const passwords = ["AdminPass1!", "RoutePass1!"];
      return () => passwords.shift() ?? "FallbackPass1!";
    })() });

    let message = "";
    try {
      await provider.provisionFixture(
        "run-d",
        { manage: "manage.example.test", proxy: "proxy.example.test", lxd: "lxd.example.test", auth: "auth.example.test" },
        "terrarium-admins"
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Logto POST /users failed with HTTP 500");
    expect(message).toContain("cleanup diagnostics");
    for (const secret of ["RoutePass1!", "client-secret-1", "token-secret", "m2m-secret"]) {
      expect(message).not.toContain(secret);
    }
    expect(managementCalls(calls).filter((call) => call.init?.method === "DELETE").map(callPath)).toEqual([
      "/api/users/admin-user",
      "/api/applications/lxd-app-1",
      "/api/applications/app-1",
      "/api/roles/role-bystanders",
      "/api/roles/role-admins",
      "/api/roles/role-agents",
      "/api/roles/role-terrarium-admins"
    ]);
  });

  test("explicit fixture cleanup and resource cleanup delete concrete resources, treat 404 as success, and never delete tenants", async () => {
    const calls = installFetchMock((call) => {
      if (callPath(call) === "/oidc/token") return Response.json({ access_token: "token-1" });
      return new Response(null, { status: callPath(call).includes("missing") ? 404 : 204 });
    });
    const provider = createProvider();
    const fixture = {
      projectId: "logto:run-d",
      appId: "app-1",
      lxdAppId: "missing-lxd-app",
      adminUser: { userId: "admin-user" },
      routeUser: { userId: "route-user" },
      deniedUser: { userId: "denied-user" }
    } as ExternalOidcFixture;

    await provider.cleanupFixture(fixture);
    await provider.deleteFixtureResource({
      provider: "external-oidc",
      idpProvider: "logto",
      resourceType: "role",
      fixtureSlug: "run-d",
      resource: { roleId: "role-1", createdAt: "2026-01-01T00:00:00.000Z" }
    } satisfies LogtoCleanupStep);
    await provider.deleteFixtureResource({
      provider: "external-oidc",
      idpProvider: "logto",
      resourceType: "api-resource",
      fixtureSlug: "run-d",
      resource: { apiResourceId: "resource-1", createdAt: "2026-01-01T00:00:00.000Z" }
    } satisfies LogtoCleanupStep);
    await provider.deleteFixtureResource({
      provider: "external-oidc",
      idpProvider: "logto",
      resourceType: "project",
      fixtureSlug: "run-d",
      projectId: "logto:run-d"
    } satisfies LogtoCleanupStep);

    expect(managementCalls(calls).map(callPath)).toEqual([
      "/api/users/admin-user",
      "/api/users/route-user",
      "/api/users/denied-user",
      "/api/applications/missing-lxd-app",
      "/api/applications/app-1",
      "/api/roles/role-1",
      "/api/resources/resource-1"
    ]);
  });

  test("stale cleanup removes only old Terrarium-marked resources and preserves unmarked fixed roles", async () => {
    const calls = installFetchMock((call) => {
      const method = call.init?.method ?? "GET";
      const path = callPath(call);
      if (path === "/oidc/token") return Response.json({ access_token: "token-1" });
      if (method === "GET" && path === "/api/users") {
        return Response.json({
          data: [
            { id: "user-old", primaryEmail: "admin+run-old@example.net", createdAt: "2026-01-01T00:00:00.000Z", customData: { terrarium: { owned: true } } },
            { id: "user-unmarked", primaryEmail: "agent+run-old@example.net", createdAt: "2026-01-01T00:00:00.000Z" },
            { id: "user-fresh", primaryEmail: "denied+run-new@example.net", createdAt: "2026-01-02T10:00:00.000Z", customData: { terrarium: { owned: true } } }
          ]
        });
      }
      if (method === "GET" && path === "/api/applications") {
        return Response.json({
          data: [
            { id: "app-old", name: "terrarium-run-old-external", createdAt: "2026-01-01T00:00:00.000Z", customData: { terrariumOwned: true } },
            { id: "app-prod", name: "production", createdAt: "2026-01-01T00:00:00.000Z", customData: { terrariumOwned: true } }
          ]
        });
      }
      if (method === "GET" && path === "/api/roles") {
        return Response.json({
          data: [
            { id: "role-old", name: "agents", createdAt: "2026-01-01T00:00:00.000Z", customData: { terrarium: { owned: true } } },
            { id: "role-unmarked", name: "admins", createdAt: "2026-01-01T00:00:00.000Z" }
          ]
        });
      }
      return new Response(null, { status: 204 });
    });
    const provider = createProvider({}, { now: () => Date.parse("2026-01-02T12:00:00.000Z") });

    await provider.cleanupStaleIntegrationFixtures();

    expect(managementCalls(calls).filter((call) => call.init?.method === "DELETE").map(callPath)).toEqual([
      "/api/users/user-old",
      "/api/applications/app-old",
      "/api/roles/role-old"
    ]);
  });

  test("thrown management errors redact tokens, client secrets, passwords, and configured secrets", async () => {
    installFetchMock((call) => {
      if (callPath(call) === "/oidc/token") return Response.json({ access_token: "token-secret" });
      return new Response(
        '{"access_token":"token-secret","clientSecret":"client-secret-1","password":"Password1!","message":"m2m-secret"}',
        { status: 500 }
      );
    });

    let message = "";
    try {
      await createProvider().verifyManagementAccess();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[REDACTED]");
    for (const secret of ["token-secret", "client-secret-1", "Password1!", "m2m-secret"]) {
      expect(message).not.toContain(secret);
    }
  });
});
