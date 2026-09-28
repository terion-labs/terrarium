export type SuiteName = "smoke" | "full";

export type IntegrationIdpProvider = "zitadel" | "logto";

export type IntegrationCliOptions = {
  suite: SuiteName;
  only: string[];
  keepOnFailure: boolean;
  reuseInfra: boolean;
  releasePreflight: boolean;
  cleanupOnly: boolean;
};

export type IntegrationConfig = {
  suite: SuiteName;
  only: Set<string>;
  keepOnFailure: boolean;
  reuseInfra: boolean;
  releasePreflight: boolean;
  slug: string;
  repoRoot: string;
  outputDir: string;
  hcloudToken: string;
  hcloudLocation: string;
  hcloudServerType: string;
  hcloudImage: string;
  hcloudBinaryTarget: string;
  hcloudVolumeSizeGb: number;
  sshPrivateKey: string;
  sshPublicKey: string;
  sshUser: string;
  ipDnsDomain: string;
  idpProvider: IntegrationIdpProvider;
  externalOidcIssuer: string;
  zitadelCloudIssuer: string;
  zitadelCloudPat: string;
  zitadelCloudOrgId: string;
  logtoTenantEndpoint: string;
  logtoM2mClientId: string;
  logtoM2mClientSecret: string;
  logtoManagementApiResource: string;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  cifsAddress: string;
  cifsUsername: string;
  cifsPassword: string;
  cifsHostPathBase: string;
};

export type DomainBundle = {
  manage: string;
  proxy: string;
  lxd: string;
  auth: string;
};

export type ServerRecord = {
  id: number;
  name: string;
  ipv4: string;
};

export type VolumeRecord = {
  id: number;
  name: string;
  linuxDevice?: string;
};

export type ManagedHost = {
  label: string;
  server: ServerRecord;
  volume?: VolumeRecord;
  domains: DomainBundle;
};

export type OidcTestUser = {
  userId: string;
  email: string;
  password: string;
  roles: string[];
};

export type ExternalOidcFixture = {
  projectId: string;
  projectName: string;
  appId: string;
  appName: string;
  clientId: string;
  clientSecret: string;
  lxdAppId: string;
  lxdAppName: string;
  lxdClientId: string;
  lxdClientSecret: string;
  adminGroup: string;
  routeGroups: string[];
  adminUser: OidcTestUser;
  routeUser: OidcTestUser;
  deniedUser: OidcTestUser;
};

export type ScenarioResult = {
  name: string;
  startedAt: string;
  finishedAt: string;
  success: boolean;
  notes: string[];
};
