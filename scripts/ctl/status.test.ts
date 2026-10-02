import { describe, expect, test } from "bun:test";
import { statusCmd } from "./status";

type CommandResult = { exitCode: number; stdout: string; stderr: string };

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function active(stdout = "active\n"): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

describe("terrariumctl status local IDP runtime", () => {
  test("distinguishes a failed backup from a service that never ran", async () => {
    const lines: string[] = [];
    await statusCmd({ config: { terrarium_idp_mode: "oidc" }, activeConfigStore: () => "test", log: (message) => lines.push(stripAnsi(message)), runAllowFailure: async (cmd) => active(cmd.includes("show") ? "Id=terrarium-s3-backup.service\nResult=exit-code\nExecMainStartTimestamp=Fri 2026-10-02 07:00:00 UTC\n\nId=terrarium-syncoid.service\nResult=success\nExecMainStartTimestamp=\n" : "") });
    expect(lines.join("\n")).toContain("terrarium-s3-backup.service: exit-code; terrarium-syncoid.service: not run");
  });
  test("prints local ZITADEL labels, bootstrap command, and service status", async () => {
    const commands: string[][] = [];
    const lines: string[] = [];

    await statusCmd({
      config: {
        terrarium_idp_mode: "local",
        terrarium_auth_domain: "auth.example.test",
        terrarium_zitadel_instance_name: "custom-zitadel"
      },
      activeConfigStore: () => "test-store",
      runAllowFailure: async (cmd) => {
        commands.push(cmd);
        return active();
      },
      log: (message) => lines.push(stripAnsi(message))
    });

    const output = lines.join("\n");
    expect(output).toContain("ZITADEL: https://auth.example.test");
    expect(output).toContain("ZITADEL instance: custom-zitadel");
    expect(output).toContain(
      "ZITADEL bootstrap password: lxc exec custom-zitadel -- cat /etc/terrarium/secrets/zitadel_admin_password"
    );
    expect(output).toContain("terrarium-zitadel.service in LXD: active");
    expect(commands).toContainEqual([
      "lxc",
      "exec",
      "custom-zitadel",
      "--",
      "systemctl",
      "is-active",
      "terrarium-zitadel.service"
    ]);
  });

  test("prints local Logto labels, bootstrap command, and service status without a ZITADEL bootstrap command", async () => {
    const commands: string[][] = [];
    const lines: string[] = [];

    await statusCmd({
      config: {
        terrarium_idp_mode: "local",
        terrarium_idp_provider: "logto",
        terrarium_auth_domain: "auth.example.test"
      },
      activeConfigStore: () => "test-store",
      runAllowFailure: async (cmd) => {
        commands.push(cmd);
        return active();
      },
      log: (message) => lines.push(stripAnsi(message))
    });

    const output = lines.join("\n");
    expect(output).toContain("Logto: https://auth.example.test");
    expect(output).toContain("Logto instance: terrarium-idp");
    expect(output).toContain(
      "Logto bootstrap password: lxc exec terrarium-idp -- cat /etc/terrarium/secrets/logto_admin_password"
    );
    expect(output).toContain("terrarium-logto.service in LXD: active");
    expect(output).not.toContain("ZITADEL bootstrap password");
    expect(output).not.toContain("terrarium-zitadel.service in LXD");
    expect(commands).toContainEqual([
      "lxc",
      "exec",
      "terrarium-idp",
      "--",
      "systemctl",
      "is-active",
      "terrarium-logto.service"
    ]);
  });

  test("does not check a local IDP service for external generic IDP mode", async () => {
    const commands: string[][] = [];
    const lines: string[] = [];

    await statusCmd({
      config: {
        terrarium_idp_mode: "oidc",
        terrarium_auth_domain: "auth.example.test"
      },
      activeConfigStore: () => "test-store",
      runAllowFailure: async (cmd) => {
        commands.push(cmd);
        return active();
      },
      log: (message) => lines.push(stripAnsi(message))
    });

    const output = lines.join("\n");
    expect(commands.some((cmd) => cmd[0] === "lxc")).toBe(false);
    expect(output).not.toContain("ZITADEL:");
    expect(output).not.toContain("Logto:");
    expect(output).not.toContain("bootstrap password");
    expect(output).not.toContain("service in LXD");
  });
});
