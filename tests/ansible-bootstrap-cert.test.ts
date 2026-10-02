import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "..");
const POSTGRES_DHI_IMAGE =
  "dhi.io/postgres:17.10-alpine3.22@sha256:a8da88e1ff62d2764fc63b0f1b0f912ff06fc629d964a260d876be615bd0857b";
const POSTGRES_MIRROR_IMAGE =
  "ghcr.io/terion-labs/terrarium-dhi-postgres:17.10-alpine3.22@sha256:9de93f210670e25bad3dd650ac435067c7628700cc7485fa0d4fe72b8e9d765d";
const POSTGRES_FALLBACK_IMAGE =
  "postgres:17.9-alpine3.22@sha256:034839bd88128360cda25496ebdb1471e24a4aa09b937160c73df2bb51126308";

describe("Traefik bootstrap certificate template", () => {
  test("marks the self-signed bootstrap certificate as a CA trusted for server auth", () => {
    const template = readFileSync(join(repoRoot, "ansible/roles/traefik/templates/bootstrap-cert-openssl.cnf.j2"), "utf8");

    expect(template).toContain("CN = terrarium-bootstrap");
    expect(template).not.toContain("CN = {{ terrarium_bootstrap_tls_domains[0] }}");
    expect(template).toContain("basicConstraints = critical, CA:true");
    expect(template).toContain("keyCertSign");
    expect(template).toContain("extendedKeyUsage = serverAuth");
    expect(template).toContain("subjectAltName = @alt_names");
  });

  test("limits bootstrap TLS to local-IDP auth and removes it when unused", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/traefik/tasks/main.yml"), "utf8");
    const playbook = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");
    const traefikConfig = readFileSync(join(repoRoot, "ansible/roles/traefik/templates/traefik.yml.j2"), "utf8");
    const certConfig = readFileSync(join(repoRoot, "ansible/roles/traefik/templates/bootstrap-cert.yml.j2"), "utf8");
    const dynamicConfig = readFileSync(join(repoRoot, "ansible/roles/traefik/templates/terrarium-dynamic.yml.j2"), "utf8");
    const bootstrapRoutes = readFileSync(join(repoRoot, "ansible/roles/traefik/templates/bootstrap-routes.yml.j2"), "utf8");

    expect(tasks).toContain("[terrarium_auth_domain] if terrarium_bootstrap_tls_enabled else []");
    expect(tasks).not.toContain("'*.' ~ terrarium_bootstrap_tls_root_domain");
    expect(traefikConfig).toContain("httpChallenge:");
    expect(traefikConfig).toContain("entryPoint: web");
    expect(traefikConfig).not.toContain("tlsChallenge:");
    expect(certConfig).toContain("certificates:");
    expect(certConfig).not.toContain("defaultCertificate");
    expect(dynamicConfig).not.toContain("zitadel-root-bootstrap");
    expect(dynamicConfig).not.toContain("terrarium_management_tls_hosts");
    expect(dynamicConfig).toContain("macro terrarium_host_tls(domain)");
    expect(dynamicConfig).toContain("terrarium_host_tls(terrarium_manage_domain)");
    expect(dynamicConfig).toContain("terrarium_host_tls(terrarium_proxy_domain)");
    expect(dynamicConfig).toContain("terrarium_host_tls(terrarium_lxd_domain)");
    expect(dynamicConfig).toContain("terrarium_host_tls(terrarium_auth_domain)");
    expect(dynamicConfig).toContain('main: "{{ domain }}"');
    expect(dynamicConfig).not.toContain("sans:");
    expect(bootstrapRoutes).toContain("zitadel-root-bootstrap");
    expect(tasks).toContain("Remove Traefik bootstrap certificate config when bootstrap TLS is not required");
    expect(tasks).toContain("Remove temporary Traefik bootstrap routes when bootstrap TLS is not required");
    expect(playbook).toContain("Retire local auth bootstrap TLS before verifying public TLS");
    expect(playbook).toContain("dynamic/bootstrap-routes.yml");
    expect(playbook).toContain('"{{ terrarium_traefik_config_dir }}/dynamic/bootstrap-cert.yml"');
    expect(playbook).toContain('"{{ terrarium_traefik_config_dir }}/bootstrap-certs"');
    expect(playbook).toContain("/usr/local/share/ca-certificates/terrarium-bootstrap.crt");
    expect(playbook).toContain("Refresh system CA certificates after retiring bootstrap TLS");
    expect(playbook).not.toContain("Restart LXD after retiring bootstrap TLS trust");
    expect(playbook).not.toContain("systemctl try-restart snap.lxd.daemon.service");
    expect(playbook).not.toContain("lxc config device remove");
    expect(playbook).not.toContain("lxc config device add");
    expect(playbook).not.toContain("Wait for ZITADEL login loopback proxy after LXD restart");
    expect(playbook).toContain("Restart Traefik after retiring bootstrap TLS");
    expect(playbook).toContain("Wait for local auth domain to serve public TLS");
    expect(playbook).toContain("Restart Traefik to retry local auth ACME after public TLS wait failure");
    expect(playbook).toContain("Wait again for local auth domain to serve public TLS after ACME retry");
    expect(playbook).toContain("Select local auth public TLS wait result");
    expect(playbook).not.toContain("Verify local auth domain serves public TLS after waits");
    expect(playbook).toContain("- -fsS");
    expect(playbook).toContain("Show local auth TLS diagnostics after public TLS failure");
    expect(playbook).toContain('TERRARIUM_AUTH_DOMAIN: "{{ terrarium_auth_domain }}"');
    expect(playbook).toContain('TERRARIUM_TRAEFIK_CONFIG_DIR: "{{ terrarium_traefik_config_dir }}"');
    expect(playbook).toContain('-servername "$TERRARIUM_AUTH_DOMAIN"');
    expect(playbook).toContain('"$TERRARIUM_TRAEFIK_CONFIG_DIR/traefik.yml"');
    expect(playbook).not.toContain('-servername "{{ terrarium_auth_domain }}"');
    expect(playbook).not.toContain('"{{ terrarium_traefik_config_dir }}/traefik.yml"');
    expect(playbook).toContain("Warn when local auth domain still does not serve public TLS");
    expect(playbook).toContain("terrarium_auth_public_tls_effective.rc");
    expect(playbook).toContain("journalctl -u traefik");
    expect(playbook).toContain("terrarium_bootstrap_tls_retired is changed");
    expect(playbook.indexOf("Retire local auth bootstrap TLS before verifying public TLS")).toBeLessThan(
      playbook.indexOf("Wait for local auth domain to serve public TLS")
    );
  });

  test("terminates public TLS for LXD at Traefik instead of passing through LXD self-signed TLS", () => {
    const dynamicConfig = readFileSync(join(repoRoot, "ansible/roles/traefik/templates/terrarium-dynamic.yml.j2"), "utf8");
    const lxdTasks = readFileSync(join(repoRoot, "ansible/roles/lxd/tasks/main.yml"), "utf8");

    expect(dynamicConfig).toContain("rule: Host(`{{ terrarium_lxd_domain }}`)");
    expect(dynamicConfig).toContain("certResolver: letsencrypt");
    expect(dynamicConfig).toContain("management-security-headers:");
    expect(dynamicConfig).toContain("frameDeny: true");
    expect(dynamicConfig).toContain("contentTypeNosniff: true");
    expect(dynamicConfig).toContain("Content-Security-Policy");
    expect(dynamicConfig).toContain("frame-ancestors 'none'");
    expect(dynamicConfig).toContain("url: https://127.0.0.1:8443");
    expect(dynamicConfig).toContain("serversTransport: lxd-loopback");
    expect(dynamicConfig).toContain("insecureSkipVerify: true");
    expect(dynamicConfig).not.toContain("HostSNI(`{{ terrarium_lxd_domain }}`)");
    expect(dynamicConfig).not.toContain("passthrough: true");
    expect(lxdTasks).toContain("Disable LXD ACME certificate management");
    expect(lxdTasks).toContain("terrarium_lxd_oidc_issuer_effective");
    expect(lxdTasks).not.toContain("lxc config set acme.domain");
  });

  test("defers local LXD OIDC wiring until ZITADEL sync has a live issuer", () => {
    const lxdTasks = readFileSync(join(repoRoot, "ansible/roles/lxd/tasks/main.yml"), "utf8");
    const zitadelSync = readFileSync(join(repoRoot, "scripts/terrarium-zitadel-sync.ts"), "utf8");

    expect(lxdTasks).toContain("terrarium_idp_mode == 'oidc'");
    expect(lxdTasks).toContain("terrarium_lxd_oidc_issuer_config");
    expect(zitadelSync).toContain('["/snap/bin/lxc", "config", "set", "oidc.issuer", discoveredIssuer]');
    expect(zitadelSync).toContain('["/snap/bin/lxc", "config", "set", "oidc.client.id", lxdClientId]');
  });

  test("retries local ZITADEL reconciliation after service restarts", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/idp_zitadel/tasks/main.yml"), "utf8");

    expect(tasks).toContain("register: terrarium_zitadel_sync");
    expect(tasks).toContain("until: terrarium_zitadel_sync.rc == 0");
    expect(tasks).toContain("retries: 6");
  });

  test("runs local ZITADEL as a protected LXD system instance", () => {
    const site = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");
    const tasks = readFileSync(join(repoRoot, "ansible/roles/idp_zitadel/tasks/main.yml"), "utf8");
    const defaults = readFileSync(join(repoRoot, "ansible/roles/idp_zitadel/defaults/main.yml"), "utf8");

    expect(site.indexOf("- role: lxd")).toBeLessThan(site.indexOf("- role: idp_zitadel"));
    expect(site.indexOf("- role: idp_zitadel")).toBeLessThan(site.indexOf("- role: idp_logto"));
    expect(site.indexOf("- role: idp_logto")).toBeLessThan(site.indexOf("- role: oauth2_proxy"));
    expect(site).toContain("terrarium_zitadel_instance_name: terrarium-idp");
    expect(site).toContain('terrarium_zitadel_instance_name: "{{ terrarium_zitadel_instance_name }}"');
    expect(defaults).toContain("terrarium_zitadel_instance_name: terrarium-idp");
    expect(defaults).toContain("terrarium_zitadel_instance_image: ubuntu:24.04");
    expect(tasks).toContain("Launch ZITADEL system instance");
    expect(tasks).toContain("Resolve local LXD member for first ZITADEL placement");
    expect(tasks).toContain("--target {{ terrarium_zitadel_instance_target | default(ansible_hostname) }}");
    expect(tasks).toContain("user.terrarium.system");
    expect(tasks).toContain("lxc exec {{ terrarium_zitadel_instance_name }} -- bash -lc");
    expect(tasks).toContain("Migrate legacy host ZITADEL data into system instance when present");
    expect(tasks).toContain("Ensure host loopback proxies reach the ZITADEL system instance");
    expect(tasks).toContain("systemctl enable terrarium-zitadel.service");
    expect(tasks).toContain("Start or restart ZITADEL compose service inside system instance");
    expect(tasks).not.toContain("systemctl enable --now terrarium-zitadel.service");
    expect(tasks).not.toContain("- name: Install ZITADEL runtime packages");
  });

  test("keeps local ZITADEL secret material out of world-readable paths and logs", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/idp_zitadel/tasks/main.yml"), "utf8");
    const playbook = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");

    expect(tasks).toContain('mode: "0700"');
    expect(tasks).toContain("Read ZITADEL master key from system instance");
    expect(tasks.match(/no_log: true/g)?.length).toBeGreaterThanOrEqual(4);
    expect(playbook).toContain("Refresh config bundle with resolved admin group");
    expect(playbook).toContain("no_log: true");
  });

  test("prefers Docker Hardened Images for local ZITADEL Postgres when credentials are available", () => {
    const defaults = readFileSync(join(repoRoot, "ansible/roles/idp_zitadel/defaults/main.yml"), "utf8");
    const tasks = readFileSync(join(repoRoot, "ansible/roles/idp_zitadel/tasks/main.yml"), "utf8");
    const compose = readFileSync(join(repoRoot, "ansible/roles/idp_zitadel/templates/docker-compose.yml.j2"), "utf8");
    const playbook = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");

    expect(defaults).toContain("terrarium_zitadel_postgres_image: \"\"");
    expect(defaults).toContain("terrarium_zitadel_postgres_uid: 70");
    expect(defaults).toContain("terrarium_zitadel_postgres_gid: 70");
    expect(defaults).toContain(`terrarium_zitadel_postgres_image_hardened: "${POSTGRES_DHI_IMAGE}"`);
    expect(defaults).toContain(`terrarium_zitadel_postgres_image_mirror: "${POSTGRES_MIRROR_IMAGE}"`);
    expect(defaults).toContain(`terrarium_zitadel_postgres_image_fallback: "${POSTGRES_FALLBACK_IMAGE}"`);
    expect(tasks).toContain("Resolve ZITADEL Postgres image");
    expect(tasks).toContain("Create ZITADEL Postgres data directory inside system instance");
    expect(tasks).toContain("-o {{ terrarium_zitadel_postgres_uid }}");
    expect(tasks).toContain("-g {{ terrarium_zitadel_postgres_gid }}");
    expect(tasks).toContain("terrarium_zitadel_postgres_image_mirror");
    expect(tasks.indexOf("terrarium_zitadel_postgres_image_hardened")).toBeLessThan(
      tasks.indexOf("terrarium_zitadel_postgres_image_mirror")
    );
    expect(tasks.indexOf("terrarium_zitadel_postgres_image_mirror")).toBeLessThan(
      tasks.indexOf("terrarium_zitadel_postgres_image_fallback")
    );
    expect(compose).toContain("image: {{ terrarium_zitadel_postgres_image_effective }}");
    expect(compose).toContain("PGDATA: /var/lib/postgresql/data");
    expect(playbook).toContain("Check Docker registry credentials for hardened images");
    expect(playbook).toContain("'terrarium_zitadel_postgres_image': terrarium_zitadel_postgres_image_effective");
    expect(defaults).not.toContain("postgres:17.2-alpine");
  });

  test("retries transient Traefik release download failures", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/traefik/tasks/main.yml"), "utf8");

    expect(tasks).toContain("register: terrarium_traefik_download");
    expect(tasks).toContain("until: terrarium_traefik_download is succeeded");
    expect(tasks).toContain("retries: 5");
  });

  test("installs Traefik from a pinned archive through private staging", () => {
    const defaults = readFileSync(join(repoRoot, "ansible/roles/traefik/defaults/main.yml"), "utf8");
    const tasks = readFileSync(join(repoRoot, "ansible/roles/traefik/tasks/main.yml"), "utf8");

    expect(defaults).toContain("terrarium_traefik_download_dir: /var/lib/terrarium/downloads/traefik");
    expect(defaults).toContain("terrarium_traefik_stage_dir: /var/lib/terrarium/staging/traefik");
    expect(defaults).toContain("terrarium_traefik_sha256:");
    expect(tasks).toContain("Create private Traefik release work directories");
    expect(tasks).toContain('mode: "0700"');
    expect(tasks).toContain("checksum: \"sha256:{{ terrarium_traefik_archive_checksum }}\"");
    expect(tasks).toContain("Validate Traefik release archive metadata");
    expect(tasks).toContain("unexpected Traefik archive member");
    expect(tasks).toContain("tar -tvzf \"$archive\" | awk '$1 ~ /^[hlbcps]/");
    expect(tasks).toContain("install -o root -g root -m 0755");
    expect(tasks).not.toContain("dest: /tmp");
    expect(tasks).not.toContain("src: /tmp/traefik");
    expect(tasks).not.toContain("ansible.builtin.unarchive");
  });
});
