import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { waitForDetachedCommand } from "./integration/scenarios/common";
import type { SshHost } from "./integration/remote/ssh";

describe("integration scenario timeout guardrails", () => {
  const commonSource = readFileSync(new URL("./integration/scenarios/common.ts", import.meta.url), "utf8");

  test("logs and bounds LXD API verification after identity-provider switches", () => {
    expect(commonSource).toContain("verify ${host.label} LXD API");
    expect(commonSource).toContain("verified ${host.label} LXD API");
    expect(commonSource).toContain("LXD API verification for ${host.label}");
    expect(commonSource).toContain("Date.now() + (options.timeoutMs ?? LXD_API_POLL_TIMEOUT_MS)");
    expect(commonSource).toContain("assertSafeLxdApiRootResponse(response, host.domains.lxd, host.domains.auth);");
    expect(commonSource).toContain("external OIDC LXD API for ${host.label}");
    expect(commonSource).toContain("local IDP LXD API for ${host.label}");
    expect(commonSource.match(/verifyLxdApi\(host, context\)/g)?.length).toBe(2);
  });

  test("persists bounded detached command tail before cleanup on non-zero exit", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "terrarium-detached-tail-"));
    const localTailPath = join(tempDir, "terrarium-install-replica.log.tail");
    const remoteTail = [
      "TASK [terrarium : run install] ****************************************",
      "api_token=super-secret-token",
      "fatal: [localhost]: FAILED! => ansible stderr"
    ].join("\n");

    const host = {
      execAllowFailure: async (command: string) => {
        if (command.includes("cat '/root/terrarium-install-replica.exit'")) {
          return { exitCode: 0, stdout: "2\n", stderr: "" };
        }
        if (command.includes("tail -n 200 '/root/terrarium-install-replica.log'")) {
          return { exitCode: 0, stdout: remoteTail, stderr: "" };
        }
        throw new Error(`unexpected command: ${command}`);
      },
      waitForSsh: async () => undefined
    } as unknown as SshHost;

    try {
      let errorMessage = "";
      try {
        await waitForDetachedCommand(host, "/root/terrarium-install-replica.exit", "/root/terrarium-install-replica.log", 60_000, {
          localTailPath
        });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toMatch(/remote command failed with exit 2[\s\S]*ansible stderr/);
      expect(errorMessage).toContain("api_token=<redacted>");
      expect(errorMessage).not.toContain("super-secret-token");

      const artifact = readFileSync(localTailPath, "utf8");
      expect(artifact).toContain("remote log: /root/terrarium-install-replica.log");
      expect(artifact).toContain("reason: remote command failed with exit 2");
      expect(artifact).toContain("fatal: [localhost]: FAILED! => ansible stderr");
      expect(artifact).toContain("api_token=<redacted>");
      expect(artifact).not.toContain("super-secret-token");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
