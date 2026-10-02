import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const root = join(import.meta.dir, "..");
const imageKeys = ["terrarium_oauth2_proxy_image", "terrarium_logto_postgres_image", "terrarium_zitadel_postgres_image"];

describe("Ansible upgrade configuration", () => {
  test("migrates saved image publishers and preserves DNS credentials through reconciliation", () => {
    const [site] = YAML.parse(readFileSync(join(root, "ansible/site.yml"), "utf8"));
    const defaults = site.vars;
    const expected = Object.fromEntries(imageKeys.map((key) => [key, defaults[`${key}_mirror`]]));
    const legacy = {
      ...Object.fromEntries(imageKeys.map((key) => [key, expected[key].replace("terion-labs", "terion-name")])),
      terrarium_acme_dns_provider: "cloudflare",
      terrarium_acme_dns_env: { CF_DNS_API_TOKEN: "regression-test-token" }
    };
    const resolution = site.pre_tasks.find((task: { name: string }) => task.name === "Resolve container image defaults")["ansible.builtin.set_fact"];
    const plays = [{
      hosts: "localhost", gather_facts: false,
      vars: { ...defaults, terrarium_docker_hardened_images_effective: false, terrarium_docker_hardened_image_mirrors_effective: true },
      tasks: [
        { "ansible.builtin.set_fact": Object.fromEntries(imageKeys.map((key) => [`${key}_effective`, resolution[`${key}_effective`]])) },
        // Exercise the expressions persisted to dqlite, not just the rendered image.
        { "ansible.builtin.set_fact": { saved_images: Object.fromEntries(imageKeys.map((key) => [key, site.vars.terrarium_config_bundle[key]])) } },
        { "ansible.builtin.set_fact": { saved_dns: {
          provider: site.vars.terrarium_config_bundle.terrarium_acme_dns_provider ?? "",
          credentials: site.vars.terrarium_config_bundle.terrarium_acme_dns_env ?? {}
        } } },
        { "ansible.builtin.assert": { that: [
          "saved_dns.provider == terrarium_acme_dns_provider",
          "saved_dns.credentials == terrarium_acme_dns_env"
        ] } },
        { "ansible.builtin.assert": { that: imageKeys.flatMap((key) => [
          `${key}_effective == '${expected[key]}'`,
          `saved_images.${key} == '${expected[key]}'`,
          `(${key}_effective | terrarium_image_publisher) == ${key}_effective`
        ]) } }
      ]
    }];

    for (const [role, name, key] of [
      ["oauth2_proxy", "Resolve oauth2-proxy image", imageKeys[0]],
      ["idp_logto", "Resolve Logto Postgres image", imageKeys[1]],
      ["idp_zitadel", "Resolve ZITADEL Postgres image", imageKeys[2]]
    ]) {
      const [block] = YAML.parse(readFileSync(join(root, `ansible/roles/${role}/tasks/main.yml`), "utf8"));
      const task = block.block.find((entry: { name: string }) => entry.name === name);
      plays.push({
        hosts: "localhost", gather_facts: false, vars: defaults,
        tasks: [
          { "ansible.builtin.set_fact": { ...task["ansible.builtin.set_fact"] } },
          { "ansible.builtin.assert": { that: [`${key}_effective == '${expected[key]}'`] } }
        ]
      });
    }

    const unchanged = [
      "registry.example.test/oauth2-proxy:custom", "dhi.io/postgres:17.10", "postgres:17.9",
      "ghcr.io/terion-name/custom-image:1", "ghcr.io/terion-name/terrarium-dhi-postgres-custom:1",
      "ghcr.io/terion-name/terrarium-dhi-postgres/child:1", "ghcr.io/another-owner/terrarium-dhi-postgres:1"
    ];
    plays[0].tasks.push({ "ansible.builtin.assert": { that: unchanged.map((image) => `('${image}' | terrarium_image_publisher) == '${image}'`) } });
    const dir = mkdtempSync(join(tmpdir(), "terrarium-image-migration-"));
    try {
      writeFileSync(join(dir, "playbook.yml"), YAML.stringify(plays));
      writeFileSync(join(dir, "saved-config.json"), JSON.stringify(legacy));
      const result = Bun.spawnSync([
        "ansible-playbook", "-i", "localhost,", "-c", "local", join(dir, "playbook.yml"),
        "-e", `@${join(dir, "saved-config.json")}`
      ], { cwd: join(root, "ansible"), env: { ...process.env, ANSIBLE_FILTER_PLUGINS: join(root, "ansible/filter_plugins") } });
      expect({ exitCode: result.exitCode, output: result.exitCode ? result.stdout.toString() + result.stderr.toString() : "" }).toEqual({ exitCode: 0, output: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
