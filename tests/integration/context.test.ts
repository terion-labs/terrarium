import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationCliOptions } from "./types";
import type { CleanupStep } from "./resources";

const relevantEnvKeys = [
  "TERRARIUM_INTEGRATION_ENV_FILE",
  "TERRARIUM_INTEGRATION_IDP_PROVIDER",
  "TERRARIUM_INTEGRATION_SLUG",
  "TERRARIUM_INTEGRATION_OUTPUT_DIR",
  "HCLOUD_TOKEN",
  "HCLOUD_LOCATION",
  "HCLOUD_SERVER_TYPE",
  "HCLOUD_IMAGE",
  "HCLOUD_SSH_PRIVATE_KEY_FILE",
  "HCLOUD_SSH_PUBLIC_KEY_FILE",
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
  "CIFS_HOST_PATH_BASE"
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

async function importContextModule(): Promise<typeof import("./context")> {
  return (await import(`./context.ts?context-test=${importCounter++}`)) as typeof import("./context");
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
  writeFileSync(privateKeyPath, "placeholder private key\n", { mode: 0o600 });
  writeFileSync(publicKeyPath, "ssh-ed25519 placeholder-public-key\n", { mode: 0o600 });

  return {
    TERRARIUM_INTEGRATION_ENV_FILE: join(tempDir, "does-not-exist.env"),
    TERRARIUM_INTEGRATION_SLUG: "context-test",
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
    CIFS_HOST_PATH_BASE: "/srv/cifs"
  };
}

async function withIntegrationContext<T>(overrides: EnvOverrides, action: (context: import("./context").IntegrationContext) => Promise<T>): Promise<T> {
  const saved = saveAndClearRelevantEnv();
  const tempDir = mkdtempSync(join(tmpdir(), "terrarium-context-test-"));
  try {
    setEnv(baseEnv(tempDir));
    setEnv(overrides);
    const { IntegrationContext } = await importContextModule();
    return await action(new IntegrationContext(defaultOptions));
  } finally {
    restoreRelevantEnv(saved);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function externalOidcUserStep(idpProvider: "zitadel" | "logto"): CleanupStep {
  return {
    provider: "external-oidc",
    idpProvider,
    resourceType: "user",
    fixtureSlug: "fixture-slug",
    resource: {
      kind: "adminUser",
      userId: "user-id",
      email: "admin+fixture-slug@example.net",
      roles: ["terrarium-admins"],
      createdAt: "2026-01-01T00:00:00.000Z"
    }
  };
}

describe("integration context external OIDC provider", () => {
  test("selects ZITADEL from integration config", async () => {
    await withIntegrationContext(
      {
        TERRARIUM_INTEGRATION_IDP_PROVIDER: "zitadel",
        ZITADEL_CLOUD_ISSUER: "https://zitadel.example.test/",
        ZITADEL_CLOUD_PAT: "zitadel-pat"
      },
      async (context) => {
        expect(context.config.idpProvider).toBe("zitadel");
        expect(context.externalOidcProvider).toBe(context.zitadelCloud);
        expect(context.externalOidcProvider.provider).toBe("zitadel");
        expect(context.externalOidcIssuer).toBe("https://zitadel.example.test");
      }
    );
  });

  test("selects Logto from integration config", async () => {
    await withIntegrationContext(
      {
        TERRARIUM_INTEGRATION_IDP_PROVIDER: "logto",
        LOGTO_TENANT_ENDPOINT: "https://logto.example.test/",
        LOGTO_M2M_CLIENT_ID: "logto-client",
        LOGTO_M2M_CLIENT_SECRET: "logto-secret"
      },
      async (context) => {
        expect(context.config.idpProvider).toBe("logto");
        expect(context.externalOidcProvider).toBe(context.logtoCloud);
        expect(context.externalOidcProvider.provider).toBe("logto");
        expect(context.externalOidcIssuer).toBe("https://logto.example.test/oidc");
      }
    );
  });

  test("dispatches external OIDC cleanup through the selected provider", async () => {
    await withIntegrationContext(
      {
        TERRARIUM_INTEGRATION_IDP_PROVIDER: "logto",
        LOGTO_TENANT_ENDPOINT: "https://logto.example.test",
        LOGTO_M2M_CLIENT_ID: "logto-client",
        LOGTO_M2M_CLIENT_SECRET: "logto-secret"
      },
      async (context) => {
        const calls: CleanupStep[] = [];
        context.externalOidcProvider.deleteFixtureResource = async (step) => {
          calls.push(step);
        };

        const step = externalOidcUserStep("logto");
        await (context as unknown as { runCleanupStep(step: CleanupStep): Promise<void> }).runCleanupStep(step);

        expect(calls).toEqual([step]);
      }
    );
  });

  test("rejects cleanup steps for a different provider", async () => {
    await withIntegrationContext(
      {
        TERRARIUM_INTEGRATION_IDP_PROVIDER: "logto",
        LOGTO_TENANT_ENDPOINT: "https://logto.example.test",
        LOGTO_M2M_CLIENT_ID: "logto-client",
        LOGTO_M2M_CLIENT_SECRET: "logto-secret"
      },
      async (context) => {
        await expect(
          (context as unknown as { runCleanupStep(step: CleanupStep): Promise<void> }).runCleanupStep(externalOidcUserStep("zitadel"))
        ).rejects.toThrow("external OIDC cleanup step targets zitadel, but selected provider is logto");
      }
    );
  });
});
