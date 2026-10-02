import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import YAML from "yaml";

const OAUTH2_PROXY_DHI_IMAGE =
  "dhi.io/oauth2-proxy:7.15.2-debian13@sha256:8f4e89762735e7ec7c3f1bbdd5da4dcd55358db8c3278bfbc2e46a7f86ab7d9e";
const OAUTH2_PROXY_MIRROR_IMAGE =
  "ghcr.io/terion-labs/terrarium-dhi-oauth2-proxy:7.15.2-debian13@sha256:e9e04c1aec93e395897ad62625f088bbb8230c440244a4561c76df1305f9b461";
const OAUTH2_PROXY_FALLBACK_IMAGE =
  "quay.io/oauth2-proxy/oauth2-proxy:v7.15.2@sha256:aa0bd8dd5ab0c78e4c91c92755ad573a5f92241f88138b4141b8ec803463b4fd";

function oauth2ProxyTemplate() {
  return readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/templates/oauth2-proxy.cfg.j2"), "utf8");
}

describe("management oauth2-proxy template", () => {
  test("uses host-only cookies for management hosts", () => {
    const template = oauth2ProxyTemplate();

    expect(template).not.toContain('redirect_url = "/oauth2/callback"');
    expect(template).not.toContain("relative_redirect_url = true");
    expect(template).toContain('cookie_name = "__Host-terrarium_admin_oauth2_proxy"');
    expect(template).toContain('cookie_path = "/"');
    expect(template).toContain('whitelist_domains = [ "{{ terrarium_manage_domain }}", "{{ terrarium_proxy_domain }}" ]');
    expect(template).toContain('trusted_proxy_ips = [ "127.0.0.1/32", "::1/128" ]');
    expect(template).toContain("skip_jwt_bearer_tokens = false");
    expect(template).toContain("pass_authorization_header = false");
    expect(template).not.toContain("pass_authorization_header = true");
    expect(template).not.toContain("cookie_domains");
    expect(template).not.toContain("terrarium_oauth2_proxy_cookie_domain");
  });

  test("lets oauth2-proxy derive an absolute callback URL from reverse-proxy headers", () => {
    const template = oauth2ProxyTemplate();

    expect(template).not.toContain('redirect_url = "/oauth2/callback"');
    expect(template).not.toContain("relative_redirect_url = true");
    expect(template).toContain("reverse_proxy = true");
  });

  test("uses provider-aware OIDC claim and scope variables", () => {
    const defaults = readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/defaults/main.yml"), "utf8");
    const tasks = readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/tasks/main.yml"), "utf8");
    const template = readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/templates/oauth2-proxy.cfg.j2"), "utf8");

    expect(defaults).toContain("terrarium_oauth2_proxy_oidc_groups_claim");
    expect(defaults).toContain("terrarium_oidc_groups_claim_effective");
    expect(defaults).toContain("terrarium_oauth2_proxy_oidc_scopes");
    expect(defaults).toContain("terrarium_oidc_scopes_effective");
    expect(template).toContain('oidc_groups_claim = "{{ terrarium_oauth2_proxy_oidc_groups_claim }}"');
    expect(template).toContain('scope = "{{ terrarium_oauth2_proxy_oidc_scopes }}"');
    expect(template).not.toContain('oidc_groups_claim = "groups"');
    expect(template).not.toContain('scope = "openid profile email"');
    expect(tasks).toContain("terrarium_oauth2_proxy_oidc_issuer_effective");
  });

  test("consumes provider-aware local IdP outputs with legacy ZITADEL fallback", () => {
    const defaults = readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/defaults/main.yml"), "utf8");
    const tasks = readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/tasks/main.yml"), "utf8");

    expect(defaults).toContain("terrarium_local_idp_outputs_path_default: /etc/terrarium/idp-apps.json");
    expect(tasks).toContain("Resolve local IdP output path for oauth2-proxy");
    expect(tasks).toContain("terrarium_oauth2_proxy_local_idp_outputs_path_effective");
    expect(tasks).toContain("terrarium_local_idp_outputs_path_effective");
    expect(tasks).toContain("terrarium_local_idp_outputs_path");
    expect(tasks).toContain("terrarium_local_idp_outputs_path_default");
    expect(tasks).toContain("terrarium_idp_provider_effective | default(terrarium_idp_provider");
    expect(tasks).toContain("'/etc/terrarium/idp-apps.json'");
    expect(tasks).toContain("terrarium_zitadel_outputs_path_effective");
    expect(tasks).toContain("terrarium_zitadel_outputs_path");
    expect(tasks).toContain("'/etc/terrarium/zitadel-apps.json'");
    expect(tasks.indexOf("terrarium_local_idp_outputs_path_effective")).toBeLessThan(
      tasks.indexOf("terrarium_local_idp_outputs_path | default")
    );
    expect(tasks.indexOf("terrarium_local_idp_outputs_path | default")).toBeLessThan(
      tasks.indexOf("terrarium_local_idp_outputs_path_default")
    );
    expect(tasks.indexOf("terrarium_local_idp_outputs_path_default")).toBeLessThan(
      tasks.indexOf("terrarium_zitadel_outputs_path_effective")
    );
    expect(tasks.indexOf("terrarium_zitadel_outputs_path_effective")).toBeLessThan(
      tasks.indexOf("terrarium_zitadel_outputs_path | default")
    );
    expect(tasks.indexOf("terrarium_zitadel_outputs_path | default")).toBeLessThan(
      tasks.indexOf("'/etc/terrarium/zitadel-apps.json'")
    );

    expect(tasks).toContain("Read local IdP application outputs for oauth2-proxy");
    expect(tasks).toContain("Parse local IdP application outputs for oauth2-proxy");
    expect(tasks).toContain("terrarium_oauth2_proxy_local_idp_outputs_raw");
    expect(tasks).toContain("terrarium_oauth2_proxy_local_idp_outputs.cockpit_client_id.value");
    expect(tasks).toContain("terrarium_oauth2_proxy_local_idp_outputs.cockpit_client_secret.value");
    expect(tasks).toContain("terrarium_oauth2_proxy_local_idp_outputs.issuer.value");
    expect(tasks).toContain("default(terrarium_oidc_issuer_effective | default('', true), true)");
    expect(tasks).not.toContain("Read ZITADEL application outputs for oauth2-proxy");
    expect(tasks).not.toContain("terrarium_oauth2_proxy_zitadel_outputs");
  });

  test("prefers computed local Logto issuer over stale root output", () => {
    const tasks = readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/tasks/main.yml"), "utf8");
    const parsedTasks = YAML.parse(tasks) as Array<{
      name?: string;
      block?: Array<{
        name?: string;
        "ansible.builtin.assert"?: { that?: string[] };
      }>;
    }>;
    const logtoIssuerAssertion = parsedTasks
      .find((task) => task.name === "Configure Terrarium oauth2-proxy")
      ?.block?.find((task) => task.name === "Assert local Logto oauth2-proxy issuer uses OIDC path");

    expect(logtoIssuerAssertion?.["ansible.builtin.assert"]?.that).toEqual([
      "(terrarium_oauth2_proxy_oidc_issuer_effective | string) is search('/oidc$')",
    ]);
    expect(tasks).toContain("local Logto oauth2-proxy issuer must end with /oidc");
    expect(tasks).toContain("terrarium_idp_provider_effective | default(terrarium_idp_provider");
    expect(tasks).toContain("terrarium_oidc_issuer_effective | default(terrarium_oidc_issuer");
    expect(tasks).not.toContain("terrarium_oauth2_proxy_oidc_issuer_effective | regex_search('/oidc$')");
    expect(tasks.indexOf("terrarium_oidc_issuer_effective | default(terrarium_oidc_issuer")).toBeLessThan(
      tasks.indexOf("terrarium_oauth2_proxy_local_idp_outputs.issuer.value")
    );
  });

  test("runs oauth2-proxy without root while keeping secret config non-world-readable", () => {
    const defaults = readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/defaults/main.yml"), "utf8");
    const compose = readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/templates/docker-compose.yml.j2"), "utf8");
    const tasks = readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/tasks/main.yml"), "utf8");

    expect(defaults).toContain('terrarium_oauth2_proxy_uid: "65532"');
    expect(defaults).toContain("terrarium_oauth2_proxy_group: terrarium-oauth2-proxy");
    expect(defaults).toContain('terrarium_oauth2_proxy_gid: ""');
    expect(defaults).toContain("terrarium_oauth2_proxy_image: \"\"");
    expect(defaults).toContain(`terrarium_oauth2_proxy_image_hardened: "${OAUTH2_PROXY_DHI_IMAGE}"`);
    expect(defaults).toContain(`terrarium_oauth2_proxy_image_mirror: "${OAUTH2_PROXY_MIRROR_IMAGE}"`);
    expect(defaults).toContain(`terrarium_oauth2_proxy_image_fallback: "${OAUTH2_PROXY_FALLBACK_IMAGE}"`);
    expect(compose).toContain("image: {{ terrarium_oauth2_proxy_image_effective }}");
    expect(tasks).toContain("Resolve oauth2-proxy image");
    expect(tasks).toContain("terrarium_oauth2_proxy_image_mirror");
    expect(tasks.indexOf("terrarium_oauth2_proxy_image_hardened")).toBeLessThan(
      tasks.indexOf("terrarium_oauth2_proxy_image_mirror")
    );
    expect(tasks.indexOf("terrarium_oauth2_proxy_image_mirror")).toBeLessThan(
      tasks.indexOf("terrarium_oauth2_proxy_image_fallback")
    );
    expect(compose).toContain('user: "{{ terrarium_oauth2_proxy_uid }}:{{ terrarium_oauth2_proxy_gid_effective }}"');
    expect(tasks).toContain("Ensure oauth2-proxy host group");
    expect(tasks).toContain("terrarium_oauth2_proxy_gid_effective");
    expect(tasks).toContain('group: "{{ terrarium_oauth2_proxy_group }}"');
    expect(tasks).toContain('mode: "0700"');
    expect(tasks).toContain('mode: "0640"');
    expect(defaults).not.toContain('terrarium_oauth2_proxy_gid: "65532"');
    expect(compose).not.toContain('user: "0:0"');
  });
});
