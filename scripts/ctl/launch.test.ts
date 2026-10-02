import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { buildLaunchArgs, buildLaunchPlan, launchOptionsFromCli } from "./launch";

const lxc = process.env.TERRARIUM_LXC_BIN ?? "/snap/bin/lxc";
const repoRoot = join(import.meta.dir, "../..");

function cloudInitFromPlan(plan: { cloudInit?: string }): Record<string, unknown> {
  if (!plan.cloudInit) {
    throw new Error("missing cloud-init launch config");
  }
  return parse(plan.cloudInit.replace(/^#cloud-config\n/, "")) as Record<string, unknown>;
}

describe("terrariumctl launch", () => {
  test("wraps basic LXD launch resource options", () => {
    expect(buildLaunchArgs("ubuntu:24.04", "web-01", { profiles: ["small"], disk: "40G", memory: "4G", cpu: "2" })).toEqual([
      lxc, "--project", "default",
      "launch",
      "ubuntu:24.04",
      "web-01",
      "--profile",
      "small",
      "--device",
      "root,size=40G",
      "--config",
      "limits.memory=4G",
      "--config",
      "limits.cpu=2"
    ]);
  });

  test("validates and writes proxy labels at launch time", () => {
    expect(buildLaunchArgs("ubuntu:24.04", "app", { proxies: ["https://app.example.com:8080@auth:admins"] })).toContain(
      "user.proxy=https://app.example.com:8080@auth:admins"
    );
    expect(() => buildLaunchArgs("ubuntu:24.04", "app", { proxies: ["https://app.example.com:8080@auth:bad!"] })).toThrow(
      "unsupported auth suffix"
    );
  });

  test("builds cloud-init for local requirements, roles, playbooks, and compose files", () => {
    const dir = mkdtempSync(join(tmpdir(), "terrarium-launch-test-"));
    try {
      const requirements = join(dir, "requirements.yml");
      const playbook = join(dir, "site.yml");
      const compose = join(dir, "docker-compose.yml");
      writeFileSync(requirements, "roles:\n  - name: geerlingguy.docker\n");
      writeFileSync(playbook, "- hosts: localhost\n  tasks: []\n");
      writeFileSync(compose, "services:\n  app:\n    image: nginx\n");

      const plan = buildLaunchPlan("ubuntu:24.04", "docker-01", {
        requirements: [requirements],
        roles: ["geerlingguy.docker"],
        playbooks: [playbook],
        dockerCompose: [compose]
      });
      const cloudInit = cloudInitFromPlan(plan);

      expect(plan.args).not.toContain(`cloud-init.user-data=${plan.cloudInit}`);
      expect(plan.args).toContain("init");
      expect(cloudInit.packages).toEqual(
        expect.arrayContaining(["ansible", "docker.io", "docker-compose-v2"])
      );
      expect(JSON.stringify(cloudInit.write_files)).toContain("geerlingguy.docker");
      expect(JSON.stringify(cloudInit.write_files)).toContain("image: nginx");
      expect(JSON.stringify(cloudInit.runcmd)).toContain("ansible-galaxy role install");
      expect(JSON.stringify(cloudInit.runcmd)).toContain("ansible-playbook -i localhost, -c local");
      expect(JSON.stringify(cloudInit.runcmd)).toContain("docker compose -f");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("maps launch variables into shell, Ansible, and Compose provisioning", () => {
    const dir = mkdtempSync(join(tmpdir(), "terrarium-launch-test-"));
    try {
      const varsFile = join(dir, "vars.env");
      const playbook = join(dir, "site.yml");
      const compose = join(dir, "docker-compose.yml");
      writeFileSync(varsFile, "APP_NAME=from-file\nAPP_PORT=8080\nQUOTED=\"hello world\"\n");
      writeFileSync(playbook, "- hosts: localhost\n  tasks: []\n");
      writeFileSync(compose, "services:\n  app:\n    image: nginx:${APP_VERSION}\n");

      const cloudInit = cloudInitFromPlan(
        buildLaunchPlan("ubuntu:24.04", "app", {
          varsFiles: [varsFile],
          vars: ["APP_NAME=from-cli", "APP_VERSION=1.27"],
          playbooks: [playbook],
          dockerCompose: [compose]
        })
      );

      const renderedFiles = JSON.stringify(cloudInit.write_files);
      const renderedCommands = JSON.stringify(cloudInit.runcmd);
      expect(renderedFiles).toContain("/var/lib/terrarium-launch/vars.env");
      expect(renderedFiles).toContain('APP_NAME=\\"from-cli\\"');
      expect(renderedFiles).toContain('\\"APP_VERSION\\": \\"1.27\\"');
      expect(renderedCommands).toContain(". '/var/lib/terrarium-launch/vars.sh'");
      expect(renderedCommands).toContain("--extra-vars @'/var/lib/terrarium-launch/vars.json'");
      expect(renderedCommands).toContain("docker compose --env-file '/var/lib/terrarium-launch/vars.env'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("builds cloud-init commands for git assets with refs", () => {
    const cloudInit = cloudInitFromPlan(
      buildLaunchPlan("ubuntu:24.04", "app", {
        playbooks: ["git+https://github.com/org/repo.git//site.yml?ref=v1.0.0"],
        dockerCompose: ["git+https://github.com/org/repo.git//compose/docker-compose.yml?ref=v1.0.0"]
      })
    );

    const rendered = JSON.stringify(cloudInit.runcmd);
    expect(rendered).toContain("git clone --depth 1 'https://github.com/org/repo.git'");
    expect(rendered).toContain("checkout 'v1.0.0'");
    expect(rendered).toContain("/var/lib/terrarium-launch/git-1/site.yml");
    expect(rendered).toContain("/var/lib/terrarium-launch/git-2/compose/docker-compose.yml");
  });

  test("passes raw cloud-init and rejects provisioning shortcut combinations", () => {
    const dir = mkdtempSync(join(tmpdir(), "terrarium-launch-test-"));
    try {
      const userData = join(dir, "user-data.yml");
      writeFileSync(userData, "#cloud-config\nhostname: raw-01\n");

      const plan = buildLaunchPlan("ubuntu:24.04", "raw-01", { cloudInit: userData });
      expect(plan.args).toEqual([lxc, "--project", "default", "init", "ubuntu:24.04", "raw-01"]);
      expect(plan.cloudInit).toBe("#cloud-config\nhostname: raw-01\n");
      expect(() => buildLaunchArgs("ubuntu:24.04", "raw-01", { cloudInit: userData, playbooks: ["site.yml"] })).toThrow(
        "--cloud-init cannot be combined"
      );
      expect(() => buildLaunchArgs("ubuntu:24.04", "raw-01", { cloudInit: userData, vars: ["FOO=bar"] })).toThrow(
        "--cloud-init cannot be combined"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recovers repeated options from argv when CAC keeps only the last value", () => {
    const originalArgv = process.argv;
    process.argv = [
      "terrariumctl",
      "launch",
      "ubuntu:24.04",
      "app",
      "--playbook",
      "one.yml",
      "--playbook",
      "two.yml",
      "--docker-compose=compose.yml",
      "--var",
      "FOO=bar",
      "--vars=vars.env"
    ];
    try {
      expect(launchOptionsFromCli({ playbook: "two.yml" })).toMatchObject({
        playbooks: ["one.yml", "two.yml"],
        dockerCompose: ["compose.yml"],
        vars: ["FOO=bar"],
        varsFiles: ["vars.env"]
      });
    } finally {
      process.argv = originalArgv;
    }
  });

  test("keeps cloud-init secrets out of lxc process arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terrarium-launch-test-"));
    try {
      const fakeLxc = join(dir, "lxc");
      const playbook = join(dir, "site.yml");
      const argsLog = join(dir, "args.log");
      const stdinLog = join(dir, "stdin.log");
      const secret = "launch-secret-not-in-argv";
      writeFileSync(playbook, "- hosts: localhost\n  tasks: []\n");
      writeFileSync(
        fakeLxc,
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$TERRARIUM_LXC_ARGS_LOG\"\nshift 2\nif [ \"$1\" = image ]; then printf 'Type: container\\nArchitecture: x86_64\\n'; exit 0; fi\nif [ \"$1\" = config ] && [ \"$2\" = set ]; then cat > \"$TERRARIUM_LXC_STDIN_LOG\"; fi\nexit 0\n",
        { mode: 0o755 }
      );

      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "run",
          join(repoRoot, "scripts/terrariumctl.ts"),
          "launch",
          "ubuntu:24.04",
          "secret-test",
          "--playbook",
          playbook,
          "--var",
          `API_TOKEN=${secret}`
        ],
        cwd: repoRoot,
        env: {
          ...process.env,
          TERRARIUM_LXC_BIN: fakeLxc,
          TERRARIUM_LXC_ARGS_LOG: argsLog,
          TERRARIUM_LXC_STDIN_LOG: stdinLog
        },
        stdout: "pipe",
        stderr: "pipe"
      });

      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).not.toContain(secret);
      expect(new TextDecoder().decode(result.stderr)).not.toContain(secret);
      await expect(Bun.file(argsLog).text()).resolves.not.toContain(secret);
      await expect(Bun.file(stdinLog).text()).resolves.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not print cloud-init payload when lxc init fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "terrarium-launch-test-"));
    try {
      const fakeLxc = join(dir, "lxc");
      const playbook = join(dir, "site.yml");
      const secret = "launch-secret-not-in-error";
      writeFileSync(playbook, "- hosts: localhost\n  tasks: []\n");
      writeFileSync(fakeLxc, "#!/bin/sh\nshift 2\nif [ \"$1\" = image ]; then printf 'Type: container\\nArchitecture: x86_64\\n'; exit 0; fi\nexit 42\n", { mode: 0o755 });

      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "run",
          join(repoRoot, "scripts/terrariumctl.ts"),
          "launch",
          "ubuntu:24.04",
          "secret-fail",
          "--playbook",
          playbook,
          "--var",
          `API_TOKEN=${secret}`
        ],
        cwd: repoRoot,
        env: { ...process.env, TERRARIUM_LXC_BIN: fakeLxc },
        stdout: "pipe",
        stderr: "pipe"
      });

      const stderr = new TextDecoder().decode(result.stderr);
      expect(result.exitCode).toBe(1);
      expect(stderr).toContain("command failed");
      expect(stderr).toContain("lxc --project default init ubuntu:24.04 secret-fail");
      expect(stderr).not.toContain(secret);
      expect(stderr).not.toContain("cloud-init.user-data");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
