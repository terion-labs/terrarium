import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("docs config", () => {
  test("rejects protocol-relative docs base values", () => {
    const source = readRepoFile("docs/.vitepress/config.mts");

    expect(source).toContain('raw.startsWith("//")');
    expect(source).toContain("TERRARIUM_DOCS_BASE must be a root-relative path");
  });

  test("documents the non-root container workflow and trm exec wrapper", () => {
    const security = readRepoFile("docs/security.md");
    const docsConfig = readRepoFile("docs/.vitepress/config.mts");
    const reference = readRepoFile("docs/reference/terrariumctl.md");
    const firstInstance = readRepoFile("docs/getting-started/creating-first-instance.md");
    const templating = readRepoFile("docs/getting-started/templating.md");
    const goldenImages = readRepoFile("docs/operations/golden-images.md");
    const guidePaths = [
      "docs/guides/openclaw.md",
      "docs/guides/hermes.md",
      "docs/guides/vscode.md",
      "docs/guides/compose.md",
      "docs/guides/auth-protection.md",
      "docs/guides/dokploy.md",
      "docs/guides/coolify.md"
    ];
    const guides = guidePaths.map((path) => readRepoFile(path)).join("\n");
    const sharedData = readRepoFile("docs/getting-started/shared-data-between-containers.md");

    expect(security).toContain("base `default`, `terrarium`, or `strict` profiles");
    expect(security).toContain("lxc launch ubuntu:24.04 devbox --profile dev");
    expect(security).toContain("trm exec devbox");
    expect(security).toContain("day-to-day work should happen under `/home/terrarium`");

    expect(reference).toContain("| `terrariumctl exec` |");
    expect(reference).toContain("| `terrariumctl launch` |");
    expect(reference).toContain("| `terrariumctl image create` |");
    expect(reference).toContain("trm image launch golden-web web-02 --profile dev");
    expect(docsConfig).toContain('link: "/operations/golden-images"');
    expect(goldenImages).toContain("trm image create web-01 golden-web");
    expect(goldenImages).toContain("removes published-route proxy config");
    expect(reference).toContain("trm launch ubuntu:24.04 app-01 --docker-compose ./docker-compose.yml");
    expect(reference).toContain("Templating Containers with `trm launch`");
    expect(docsConfig).toContain('link: "/getting-started/templating"');
    expect(templating).toContain("trm launch ubuntu:24.04 customer-portal");
    expect(templating).toContain("--vars ./portal.env");
    expect(templating).toContain("--var APP_ENV=production");
    expect(templating).toContain("git+https://github.com/org/repo.git//path/inside/repo.yml?ref=v1.0.0");
    expect(templating).toContain("As Ansible extra vars through `--extra-vars`");
    expect(templating).toContain("As Docker Compose variables through `--env-file`");
    expect(templating).toContain("Raw cloud-init replaces Terrarium's generated template");
    expect(templating).toContain("trm image create customer-portal golden-customer-portal");
    expect(templating).toContain("../operations/golden-images.md");
    expect(reference).toContain("trm exec my-stack");
    expect(reference).toContain("trm exec my-stack --root");
    expect(firstInstance).toContain("trm launch ubuntu:24.04 my-first-app");
    expect(firstInstance).toContain("trm launch ubuntu:24.04 my-first-app --proxy");

    expect(guides).toContain("--profile dev");
    expect(guides).toContain("trm exec");
    expect(guides).not.toContain("lxc exec openclaw --user 1000");
    expect(guides).not.toContain("lxc exec hermes --user 1000");
    expect(guides).not.toContain("lxc exec devbox --user 1000");
    expect(guides).not.toContain("lxc exec my-stack --user 1000");
    expect(guides).toContain("sudo loginctl enable-linger terrarium");
    expect(guides).toContain("hermes gateway setup");
    expect(guides).toContain("hermes gateway install");
    expect(guides).toContain("journalctl --user -u hermes-gateway -f");
    expect(guides).toContain('HERMES_BIN="$(command -v hermes)"');
    expect(guides).toContain('sudo "$HERMES_BIN" gateway install --system');
    expect(guides).toContain("OpenAI-compatible clients expect API-key style authentication");
    expect(guides).toContain('user.proxy "https://hermes-api.example.com:8642,https://hermes-dashboard.example.com:9119@auth"');
    expect(guides).toContain("With an external provider such as ZITADEL Cloud, add the dashboard callback URL to that provider manually");
    expect(guides).toContain("https://hermes-dashboard.example.com/oauth2/callback");
    expect(guides).not.toContain("https://hermes-api.example.com:8642@auth");
    expect(guides).toContain('user.proxy "https://code.example.com:8080@auth"');
    expect(guides).toContain("https://code.example.com/oauth2/callback");
    expect(guides).not.toContain('user.proxy "https://code.example.com:8080"');
    expect(guides).toContain('user.proxy "https://openclaw.your-domain.com:18789@auth"');
    expect(guides).toContain("https://openclaw.your-domain.com/oauth2/callback");
    expect(guides).not.toContain('user.proxy "https://openclaw.your-domain.com:18789"');
    expect(guides).toContain("https://dokploy.example.com/oauth2/callback");
    expect(guides).toContain("https://coolify-setup.example.com/oauth2/callback");
    expect(guides).toContain("https://coolify.example.com/oauth2/callback");
    expect(guides).toContain("including published-route callback URLs in the local ZITADEL app");
    expect(guides).not.toContain("generates a unique \"Callback URL\"");
    expect(guides).not.toContain("grep -R -E '^(redirect_url)'");
    expect(guides).toContain("hermes-dashboard.service");
    expect(guides).toContain("hermes dashboard --host 0.0.0.0 --port 9119 --no-open --insecure --tui");
    expect(guides).toContain('user.proxy "https://hermes-api.example.com:8642,https://hermes-dashboard.example.com:9119@auth:admins"');
    expect(guides).toContain("/home/terrarium/.hermes/memories");
    expect(sharedData).toContain("/home/terrarium/.codex");
    expect(sharedData).toContain("lxc exec hermes -- chown -R terrarium:terrarium /home/terrarium/.codex");
    expect(sharedData).not.toContain("/root/.codex");
  });

  test("documents deployment tool server-user constraints accurately", () => {
    const dokploy = readRepoFile("docs/guides/dokploy.md");
    const coolify = readRepoFile("docs/guides/coolify.md");

    expect(dokploy).toContain("Dokploy currently requires root access for remote deployment servers");
    expect(dokploy).toContain("trm exec apps-a --root");
    expect(dokploy).toContain("PermitRootLogin .*/PermitRootLogin prohibit-password");
    expect(dokploy).toContain("user `root`");
    expect(dokploy).not.toContain("In Dokploy, go to **Remote Servers** -> **Add Server**. Enter the private IP address, the user `terrarium`");

    expect(coolify).toContain("Coolify supports non-root server users");
    expect(coolify).toContain("mark this as experimental");
    expect(coolify).toContain("lxc launch ubuntu:24.04 apps-server-1 --profile dev");
    expect(coolify).toContain("user `terrarium`");
    expect(coolify).toContain("PermitRootLogin .*/PermitRootLogin no");
  });

  test("documents day-2 Terrarium updates without reinstalling", () => {
    const reference = readRepoFile("docs/reference/terrariumctl.md");
    const reconfiguration = readRepoFile("docs/operations/reconfiguration.md");

    expect(reference).toContain("| `terrariumctl update` |");
    expect(reference).toMatch(/terrariumctl update --ref \d+\.\d+\.\d+/);
    expect(reference).toContain("install.sh | sudo bash -s -- --update");
    expect(reference).toContain("does not ask storage, domain, IDP, S3, or syncoid setup questions");
    expect(reconfiguration).toContain("terrariumctl update");
    expect(reconfiguration).toContain("update the existing installation or intentionally reinstall from scratch");
  });

  test("documents user.proxy label formats in getting started docs", () => {
    const domainsAndAuth = readRepoFile("docs/getting-started/domains-and-auth.md");
    const authProtection = readRepoFile("docs/guides/auth-protection.md");
    const reference = readRepoFile("docs/reference/terrariumctl.md");

    for (const source of [domainsAndAuth, reference]) {
      expect(source).toContain("https://<public-host>[:container-port][/path][@auth[:group[,group...]][~callback-host]]");
      expect(source).toContain("tcp://<public-port>:<container-port>");
      expect(source).toContain("udp://<public-port>:<container-port>");
      expect(source).toContain('lxc config set my-app user.proxy "https://app.example.com:8080');
      expect(source).toContain("must listen on `0.0.0.0`");
      expect(source).toContain("https://go-acme.github.io/lego/dns/index.html");
      expect(source).toContain("terrariumctl set dns provider cloudflare CF_DNS_API_TOKEN:your-token");
    }

    expect(domainsAndAuth).toContain("Published App Route Labels");
    expect(domainsAndAuth).toContain("Keep route-auth callback URLs in the managed ZITADEL app up to date when you run `terrariumctl proxy sync`");
    expect(domainsAndAuth).toContain("For external providers, including ZITADEL Cloud, Terrarium does not mutate your provider app automatically");
    expect(domainsAndAuth).toContain("go to **Configuration**, choose **Edit YAML**");
    expect(domainsAndAuth).toContain('lxc config set admin-ui user.proxy "https://*.example.com:3000@auth:admins~auth.example.com"');
    expect(reference).toContain("Traefik supports one DNS challenge provider per instance");
    expect(authProtection).toContain("../getting-started/domains-and-auth.md#published-app-route-labels");
  });
});
