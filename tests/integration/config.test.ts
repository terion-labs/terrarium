import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationCliOptions, IntegrationConfig } from "./types";

const relevantEnvKeys = [
  "TERRARIUM_INTEGRATION_ENV_FILE",
  "TERRARIUM_INTEGRATION_IDP_PROVIDER",
  "TERRARIUM_INTEGRATION_SLUG",
  "TERRARIUM_INTEGRATION_OUTPUT_DIR",
  "KEEP_ON_FAILURE",
  "REUSE_INFRA",
  "RELEASE_PREFLIGHT",
  "GITHUB_RUN_ID",
  "GITHUB_SHA",
  "HCLOUD_TOKEN",
  "HCLOUD_LOCATION",
  "HCLOUD_SERVER_TYPE",
  "HCLOUD_IMAGE",
  "HCLOUD_BINARY_TARGET",
  "HCLOUD_VOLUME_SIZE_GB",
  "HCLOUD_SSH_PRIVATE_KEY",
  "HCLOUD_SSH_PUBLIC_KEY",
  "HCLOUD_SSH_PRIVATE_KEY_FILE",
  "HCLOUD_SSH_PUBLIC_KEY_FILE",
  "HCLOUD_SSH_USER",
  "TERRARIUM_INTEGRATION_IP_DNS_DOMAIN",
  "ZITADEL_CLOUD_ISSUER",
  "ZITADEL_CLOUD_PAT",
  "ZITADEL_CLOUD_ORG_ID",
  "LOGTO_TENANT_ENDPOINT",
  "LOGTO_M2M_CLIENT_ID",
  "LOGTO_M2M_CLIENT_SECRET",
  "LOGTO_MANAGEMENT_API_RESOURCE",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "CIFS_ADDRESS",
  "CIFS_USERNAME",
  "CIFS_PASSWORD",
  "CIFS_HOST_PATH_BASE",
  "TAILSCALE_OAUTH_CLIENT_ID",
  "TAILSCALE_OAUTH_CLIENT_SECRET",
  "TAILSCALE_TAG"
] as const;

type RelevantEnvKey = (typeof relevantEnvKeys)[number];
type EnvOverrides = Partial<Record<RelevantEnvKey, string | undefined>>;

const defaultOptions = {
  suite: "smoke",
  only: [],
  keepOnFailure: false,
  reuseInfra: false,
  releasePreflight: false,
  cleanupOnly: false
} satisfies IntegrationCliOptions;

let importCounter = 0;

async function importConfigModule(): Promise<typeof import("./config")> {
  return (await import(`./config.ts?config-test=${importCounter++}`)) as typeof import("./config");
}

function saveAndClearRelevantEnv(): Map<RelevantEnvKey, string | undefined> {
  const saved = new Map<RelevantEnvKey, string | undefined>();
  for (const key of relevantEnvKeys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  return saved;
}

function restoreRelevantEnv(saved: Map<RelevantEnvKey, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setEnv(values: EnvOverrides): void {
  for (const [key, value] of Object.entries(values) as [RelevantEnvKey, string | undefined][]) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function baseEnv(tempDir: string): EnvOverrides {
  const privateKeyPath = join(tempDir, "id_ed25519");
  const publicKeyPath = join(tempDir, "id_ed25519.pub");
  writeFileSync(privateKeyPath, "dummy private key\n", { mode: 0o600 });
  writeFileSync(publicKeyPath, "ssh-ed25519 dummy-public-key\n", { mode: 0o600 });

  return {
    TERRARIUM_INTEGRATION_ENV_FILE: join(tempDir, "does-not-exist.env"),
    TERRARIUM_INTEGRATION_SLUG: "config-test",
    TERRARIUM_INTEGRATION_OUTPUT_DIR: join(tempDir, "output"),
    HCLOUD_TOKEN: "hcloud-token",
    HCLOUD_LOCATION: "fsn1",
    HCLOUD_SERVER_TYPE: "cx22",
    HCLOUD_SSH_PRIVATE_KEY_FILE: privateKeyPath,
    HCLOUD_SSH_PUBLIC_KEY_FILE: publicKeyPath,
    S3_ENDPOINT: "https://s3.example.test",
    S3_BUCKET: "terrarium-test",
    S3_REGION: "test-region",
    S3_ACCESS_KEY: "s3-access-key",
    S3_SECRET_KEY: "s3-secret-key",
    CIFS_ADDRESS: "10.0.0.5",
    CIFS_USERNAME: "cifs-user",
    CIFS_PASSWORD: "cifs-password",
    CIFS_HOST_PATH_BASE: "/srv/cifs",
    TAILSCALE_OAUTH_CLIENT_ID: "tailscale-client-id",
    TAILSCALE_OAUTH_CLIENT_SECRET: "tailscale-client-secret"
  };
}

async function withIntegrationEnv<T>(overrides: EnvOverrides, action: () => Promise<T>): Promise<T> {
  const saved = saveAndClearRelevantEnv();
  const tempDir = mkdtempSync(join(tmpdir(), "terrarium-config-test-"));
  try {
    setEnv(baseEnv(tempDir));
    setEnv(overrides);
    return await action();
  } finally {
    restoreRelevantEnv(saved);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function loadConfig(overrides: EnvOverrides): Promise<IntegrationConfig> {
  return withIntegrationEnv(overrides, async () => {
    const { loadIntegrationConfig } = await importConfigModule();
    return loadIntegrationConfig(defaultOptions);
  });
}

describe("integration config", () => {
  test.each(["ubuntu-24.04", "ubuntu-26.04"])("selects %s hosts", async (image) => {
    const config = await loadConfig({
      HCLOUD_IMAGE: image,
      ZITADEL_CLOUD_ISSUER: "https://zitadel.example.test",
      ZITADEL_CLOUD_PAT: "zitadel-pat"
    });
    expect(config.hcloudImage).toBe(image);
  });

  test("rejects unsupported host images", async () => {
    await expect(loadConfig({ HCLOUD_IMAGE: "ubuntu-25.10" })).rejects.toThrow("invalid HCLOUD_IMAGE");
  });

  test("normalizes matrix versions in resource names", async () => {
    const config = await loadConfig({
      TERRARIUM_INTEGRATION_SLUG: "gha-123-1-smoke-26.04",
      ZITADEL_CLOUD_ISSUER: "https://zitadel.example.test",
      ZITADEL_CLOUD_PAT: "zitadel-pat"
    });
    expect(config.slug).toBe("gha-123-1-smoke-26-04");
  });

  test("uses explicit ZITADEL provider selection", async () => {
    const config = await loadConfig({
      TERRARIUM_INTEGRATION_IDP_PROVIDER: "zitadel",
      ZITADEL_CLOUD_ISSUER: "https://zitadel.example.test",
      ZITADEL_CLOUD_PAT: "zitadel-pat",
      ZITADEL_CLOUD_ORG_ID: "zitadel-org",
      LOGTO_TENANT_ENDPOINT: "https://logto.example.test",
      LOGTO_M2M_CLIENT_ID: "logto-client",
      LOGTO_M2M_CLIENT_SECRET: "logto-secret"
    });

    expect(config.idpProvider).toBe("zitadel");
    expect(config.externalOidcIssuer).toBe("https://zitadel.example.test");
    expect(config.zitadelCloudIssuer).toBe("https://zitadel.example.test");
    expect(config.zitadelCloudPat).toBe("zitadel-pat");
    expect(config.zitadelCloudOrgId).toBe("zitadel-org");
  });

  test("uses explicit Logto provider selection without requiring ZITADEL vars", async () => {
    const config = await loadConfig({
      TERRARIUM_INTEGRATION_IDP_PROVIDER: "logto",
      LOGTO_TENANT_ENDPOINT: "https://logto.example.test/",
      LOGTO_M2M_CLIENT_ID: "logto-client",
      LOGTO_M2M_CLIENT_SECRET: "logto-secret",
      LOGTO_MANAGEMENT_API_RESOURCE: "https://management.example.test/"
    });

    expect(config.idpProvider).toBe("logto");
    expect(config.externalOidcIssuer).toBe("https://logto.example.test/oidc");
    expect(config.zitadelCloudIssuer).toBe("");
    expect(config.zitadelCloudPat).toBe("");
    expect(config.logtoTenantEndpoint).toBe("https://logto.example.test");
    expect(config.logtoM2mClientId).toBe("logto-client");
    expect(config.logtoM2mClientSecret).toBe("logto-secret");
    expect(config.logtoManagementApiResource).toBe("https://management.example.test");
  });

  test("rejects invalid explicit provider selectors", async () => {
    await expect(
      loadConfig({
        TERRARIUM_INTEGRATION_IDP_PROVIDER: "auth0",
        ZITADEL_CLOUD_ISSUER: "https://zitadel.example.test",
        ZITADEL_CLOUD_PAT: "zitadel-pat"
      })
    ).rejects.toThrow('invalid TERRARIUM_INTEGRATION_IDP_PROVIDER "auth0"; expected one of: zitadel, logto');
  });

  test("chooses Logto by default when all required Logto vars are present", async () => {
    const config = await loadConfig({
      LOGTO_TENANT_ENDPOINT: "https://logto.example.test",
      LOGTO_M2M_CLIENT_ID: "logto-client",
      LOGTO_M2M_CLIENT_SECRET: "logto-secret"
    });

    expect(config.idpProvider).toBe("logto");
    expect(config.externalOidcIssuer).toBe("https://logto.example.test/oidc");
  });

  test("falls back to ZITADEL by default when required Logto vars are incomplete", async () => {
    const config = await loadConfig({
      LOGTO_TENANT_ENDPOINT: "https://logto.example.test",
      LOGTO_M2M_CLIENT_ID: "logto-client",
      ZITADEL_CLOUD_ISSUER: "https://zitadel.example.test",
      ZITADEL_CLOUD_PAT: "zitadel-pat"
    });

    expect(config.idpProvider).toBe("zitadel");
    expect(config.externalOidcIssuer).toBe("https://zitadel.example.test");
  });

  test("requires ZITADEL issuer in ZITADEL mode", async () => {
    await expect(
      loadConfig({
        TERRARIUM_INTEGRATION_IDP_PROVIDER: "zitadel",
        ZITADEL_CLOUD_PAT: "zitadel-pat"
      })
    ).rejects.toThrow("missing required environment variable: ZITADEL_CLOUD_ISSUER");
  });

  test("requires ZITADEL PAT in ZITADEL mode", async () => {
    await expect(
      loadConfig({
        TERRARIUM_INTEGRATION_IDP_PROVIDER: "zitadel",
        ZITADEL_CLOUD_ISSUER: "https://zitadel.example.test"
      })
    ).rejects.toThrow("missing required environment variable: ZITADEL_CLOUD_PAT");
  });

  test("requires Logto tenant endpoint in Logto mode", async () => {
    await expect(
      loadConfig({
        TERRARIUM_INTEGRATION_IDP_PROVIDER: "logto",
        LOGTO_M2M_CLIENT_ID: "logto-client",
        LOGTO_M2M_CLIENT_SECRET: "logto-secret"
      })
    ).rejects.toThrow("missing required environment variable: LOGTO_TENANT_ENDPOINT");
  });

  test("requires Logto M2M client ID in Logto mode", async () => {
    await expect(
      loadConfig({
        TERRARIUM_INTEGRATION_IDP_PROVIDER: "logto",
        LOGTO_TENANT_ENDPOINT: "https://logto.example.test",
        LOGTO_M2M_CLIENT_SECRET: "logto-secret"
      })
    ).rejects.toThrow("missing required environment variable: LOGTO_M2M_CLIENT_ID");
  });

  test("requires Logto M2M client secret in Logto mode", async () => {
    await expect(
      loadConfig({
        TERRARIUM_INTEGRATION_IDP_PROVIDER: "logto",
        LOGTO_TENANT_ENDPOINT: "https://logto.example.test",
        LOGTO_M2M_CLIENT_ID: "logto-client"
      })
    ).rejects.toThrow("missing required environment variable: LOGTO_M2M_CLIENT_SECRET");
  });

  test("defaults Logto management API resource to the tenant API", async () => {
    const config = await loadConfig({
      TERRARIUM_INTEGRATION_IDP_PROVIDER: "logto",
      LOGTO_TENANT_ENDPOINT: "https://logto.example.test/",
      LOGTO_M2M_CLIENT_ID: "logto-client",
      LOGTO_M2M_CLIENT_SECRET: "logto-secret"
    });

    expect(config.logtoTenantEndpoint).toBe("https://logto.example.test");
    expect(config.logtoManagementApiResource).toBe("https://logto.example.test/api");
  });
});
