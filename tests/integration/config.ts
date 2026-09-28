import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { IntegrationCliOptions, IntegrationConfig, IntegrationIdpProvider } from "./types";

function loadDotEnvFile(): void {
  const explicitPath = process.env.TERRARIUM_INTEGRATION_ENV_FILE?.trim();
  const defaultPath = resolve(process.cwd(), "tests/integration/.env");
  const envPath = explicitPath ? resolve(explicitPath) : defaultPath;
  if (!existsSync(envPath)) {
    return;
  }

  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1);
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
  }
}

loadDotEnvFile();

const INTEGRATION_IDP_PROVIDERS = ["zitadel", "logto"] as const satisfies readonly IntegrationIdpProvider[];

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function hasRequiredLogtoEnv(): boolean {
  return ["LOGTO_TENANT_ENDPOINT", "LOGTO_M2M_CLIENT_ID", "LOGTO_M2M_CLIENT_SECRET"].every(name => Boolean(process.env[name]?.trim()));
}

function selectIntegrationIdpProvider(): IntegrationIdpProvider {
  const explicitProvider = optionalEnv("TERRARIUM_INTEGRATION_IDP_PROVIDER");
  if (!explicitProvider) {
    return hasRequiredLogtoEnv() ? "logto" : "zitadel";
  }
  if (explicitProvider === "zitadel" || explicitProvider === "logto") {
    return explicitProvider;
  }
  throw new Error(
    `invalid TERRARIUM_INTEGRATION_IDP_PROVIDER "${explicitProvider}"; expected one of: ${INTEGRATION_IDP_PROVIDERS.join(", ")}`
  );
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
}

function computeSlug(): string {
  const runId = optionalEnv("GITHUB_RUN_ID");
  const sha = optionalEnv("GITHUB_SHA").slice(0, 7);
  const base = runId ? `gha-${runId}-${sha || "local"}` : `local-${Date.now().toString(36)}-${sha || "dev"}`;
  return slugify(base);
}

function ensureTempKey(pathHint: string, content: string): string {
  const target = join(tmpdir(), pathHint);
  writeFileSync(target, `${content.trim()}\n`, { encoding: "utf8", mode: 0o600 });
  return target;
}

/**
 * Normalizes SSH key material passed through environment variables.
 *
 * This lets local `.env` files carry a private key as a single line with
 * escaped newlines, for example `-----BEGIN...-----\\n...\\n-----END...-----`.
 */
function normalizeKeyContent(content: string): string {
  const trimmed = content.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.includes("\\n") ? trimmed.replace(/\\n/g, "\n") : trimmed;
}

/** Loads the harness configuration from CLI options plus environment secrets. */
export function loadIntegrationConfig(options: IntegrationCliOptions): IntegrationConfig {
  const hcloudImage = optionalEnv("HCLOUD_IMAGE", "ubuntu-24.04");
  if (!["ubuntu-24.04", "ubuntu-26.04"].includes(hcloudImage)) {
    throw new Error(`invalid HCLOUD_IMAGE "${hcloudImage}"; expected ubuntu-24.04 or ubuntu-26.04`);
  }
  const repoRoot = resolve(process.cwd());
  // Dots in the Ubuntu matrix value must not turn server names into shared hostnames.
  const slug = slugify(optionalEnv("TERRARIUM_INTEGRATION_SLUG", computeSlug()));
  const outputDir = resolve(optionalEnv("TERRARIUM_INTEGRATION_OUTPUT_DIR", join(repoRoot, "tests/integration/output", slug)));
  mkdirSync(outputDir, { recursive: true });

  const privateKeyPath = optionalEnv("HCLOUD_SSH_PRIVATE_KEY_FILE");
  const publicKeyPath = optionalEnv("HCLOUD_SSH_PUBLIC_KEY_FILE");
  const publicKey =
    publicKeyPath && existsSync(publicKeyPath)
      ? publicKeyPath
      : ensureTempKey(`terrarium-${slug}-id_ed25519.pub`, normalizeKeyContent(requiredEnv("HCLOUD_SSH_PUBLIC_KEY")));

  const normalizedPrivateKey =
    privateKeyPath && existsSync(privateKeyPath)
      ? privateKeyPath
      : ensureTempKey(`terrarium-${slug}-id_ed25519`, normalizeKeyContent(requiredEnv("HCLOUD_SSH_PRIVATE_KEY")));

  const idpProvider = selectIntegrationIdpProvider();
  const zitadelCloudIssuer = idpProvider === "zitadel" ? requiredEnv("ZITADEL_CLOUD_ISSUER") : optionalEnv("ZITADEL_CLOUD_ISSUER");
  const zitadelCloudPat = idpProvider === "zitadel" ? requiredEnv("ZITADEL_CLOUD_PAT") : optionalEnv("ZITADEL_CLOUD_PAT");
  const logtoTenantEndpoint = normalizeEndpoint(
    idpProvider === "logto" ? requiredEnv("LOGTO_TENANT_ENDPOINT") : optionalEnv("LOGTO_TENANT_ENDPOINT")
  );
  const logtoManagementApiResource = normalizeEndpoint(
    optionalEnv("LOGTO_MANAGEMENT_API_RESOURCE", logtoTenantEndpoint ? `${logtoTenantEndpoint}/api` : "")
  );

  return {
    suite: options.suite,
    only: new Set(options.only),
    keepOnFailure: options.keepOnFailure || optionalEnv("KEEP_ON_FAILURE") === "true",
    reuseInfra: options.reuseInfra || optionalEnv("REUSE_INFRA") === "true",
    releasePreflight: options.releasePreflight || optionalEnv("RELEASE_PREFLIGHT") === "true",
    slug,
    repoRoot,
    outputDir,
    hcloudToken: requiredEnv("HCLOUD_TOKEN"),
    hcloudLocation: requiredEnv("HCLOUD_LOCATION"),
    hcloudServerType: requiredEnv("HCLOUD_SERVER_TYPE").toLowerCase(),
    hcloudImage,
    hcloudBinaryTarget: optionalEnv("HCLOUD_BINARY_TARGET", "x64"),
    hcloudVolumeSizeGb: Number(optionalEnv("HCLOUD_VOLUME_SIZE_GB", "40")),
    sshPrivateKey: normalizedPrivateKey,
    sshPublicKey: publicKey,
    sshUser: optionalEnv("HCLOUD_SSH_USER", "root"),
    ipDnsDomain: optionalEnv("TERRARIUM_INTEGRATION_IP_DNS_DOMAIN", "nip.io"),
    idpProvider,
    externalOidcIssuer: idpProvider === "zitadel" ? zitadelCloudIssuer : `${logtoTenantEndpoint}/oidc`,
    zitadelCloudIssuer,
    zitadelCloudPat,
    zitadelCloudOrgId: optionalEnv("ZITADEL_CLOUD_ORG_ID"),
    logtoTenantEndpoint,
    logtoM2mClientId: idpProvider === "logto" ? requiredEnv("LOGTO_M2M_CLIENT_ID") : optionalEnv("LOGTO_M2M_CLIENT_ID"),
    logtoM2mClientSecret: idpProvider === "logto" ? requiredEnv("LOGTO_M2M_CLIENT_SECRET") : optionalEnv("LOGTO_M2M_CLIENT_SECRET"),
    logtoManagementApiResource,
    s3Endpoint: requiredEnv("S3_ENDPOINT"),
    s3Bucket: requiredEnv("S3_BUCKET"),
    s3Region: requiredEnv("S3_REGION"),
    s3AccessKey: requiredEnv("S3_ACCESS_KEY"),
    s3SecretKey: requiredEnv("S3_SECRET_KEY"),
    cifsAddress: requiredEnv("CIFS_ADDRESS"),
    cifsUsername: requiredEnv("CIFS_USERNAME"),
    cifsPassword: requiredEnv("CIFS_PASSWORD"),
    cifsHostPathBase: requiredEnv("CIFS_HOST_PATH_BASE")
  };
}
