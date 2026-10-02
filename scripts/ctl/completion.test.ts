import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandCompletionCandidates, completionScript, installCompletionScripts } from "./completion";

function withCompletionEnv<T>(callback: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "terrarium-completion-test-"));
  const previous = {
    TERRARIUM_BASH_COMPLETION_DIR: process.env.TERRARIUM_BASH_COMPLETION_DIR,
    TERRARIUM_ZSH_COMPLETION_DIR: process.env.TERRARIUM_ZSH_COMPLETION_DIR,
    TERRARIUM_FISH_COMPLETION_DIR: process.env.TERRARIUM_FISH_COMPLETION_DIR,
    TERRARIUM_PROFILE_D_DIR: process.env.TERRARIUM_PROFILE_D_DIR,
    TERRARIUM_BIN_DIR: process.env.TERRARIUM_BIN_DIR,
    TERRARIUM_COMPLETION_SHELLS: process.env.TERRARIUM_COMPLETION_SHELLS
  };
  try {
    process.env.TERRARIUM_BASH_COMPLETION_DIR = join(dir, "bash");
    process.env.TERRARIUM_ZSH_COMPLETION_DIR = join(dir, "zsh");
    process.env.TERRARIUM_FISH_COMPLETION_DIR = join(dir, "fish");
    process.env.TERRARIUM_PROFILE_D_DIR = join(dir, "profile.d");
    process.env.TERRARIUM_BIN_DIR = join(dir, "bin");
    return callback(dir);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("terrariumctl completion", () => {
  test("generates bash completion for terrariumctl and trm", () => {
    const script = completionScript("bash");

    expect(script).toContain("complete -F _terrariumctl_complete terrariumctl");
    expect(script).toContain("complete -F _terrariumctl_complete trm");
    expect(script).toContain("backup) COMPREPLY");
    expect(script).toContain("list export replicate restore");
    expect(script).toContain("update");
    expect(script).toContain("update) COMPREPLY");
    expect(script).toContain("launch) COMPREPLY");
    expect(script).toContain("image) COMPREPLY");
    expect(script).toContain("create list launch delete");
    expect(script).toContain("--snapshot --live --reuse --vm --target --wait --timeout --profile --disk --memory --cpu --proxy --requirements --playbook --role --docker-compose --cloud-init --var --vars");
    expect(script).toContain("--vm --target --wait --timeout --var --vars --profile --disk --memory --cpu --requirements --playbook --role --docker-compose --cloud-init --proxy");
    expect(script).toContain("--ref --skip-reconfigure --non-interactive");
    expect(script).toContain("--skip-reconfigure");
    expect(script).toContain("--logto-admin-email");
    expect(script).toContain("--logto-admin-username");
    expect(script).toContain("--storage-source");
    expect(script).toContain("local oidc");
    expect(script).toContain("provider");
    expect(script).toContain("compgen -W \"install\"");
  });

  test("completes root command prefixes", () => {
    expect(commandCompletionCandidates("st")).toEqual(["status"]);
    expect(commandCompletionCandidates("re")).toEqual(["reconfigure"]);
    expect(commandCompletionCandidates("")).toContain("install");
  });

  test("generates zsh and fish completion for the installed aliases", () => {
    const zsh = completionScript("zsh");
    const fish = completionScript("fish");

    expect(zsh).toContain("#compdef terrariumctl trm");
    expect(zsh).toContain("update) opts=(--ref --skip-reconfigure --non-interactive)");
    expect(zsh).toContain("launch) opts=(--vm --target --wait --timeout --var --vars --profile --disk --memory --cpu --requirements --playbook --role --docker-compose --cloud-init --proxy)");
    expect(zsh).toContain("image) actions=(create list launch delete); opts=(--snapshot --live --reuse --vm --target --wait --timeout --profile --disk --memory --cpu --proxy --requirements --playbook --role --docker-compose --cloud-init --var --vars)");
    expect(zsh).toContain("compadd local oidc");
    expect(zsh).toContain("compadd provider");
    expect(fish).toContain("complete -c terrariumctl");
    expect(fish).toContain("complete -c trm");
    expect(fish).toContain("__fish_seen_subcommand_from dns");
    expect(fish).toContain("__fish_seen_subcommand_from completion");
    expect(fish).toContain("-l oidc-client");
    expect(fish).toContain("-s p");
  });

  test("installs completion files for detected shells and managed trm alias", () => {
    withCompletionEnv((dir) => {
      process.env.TERRARIUM_COMPLETION_SHELLS = "bash fish";
      const bin = join(dir, "bin");
      const terrariumctl = join(bin, "terrariumctl");
      const trm = join(bin, "trm");
      mkdirSync(bin, { recursive: true });
      writeFileSync(terrariumctl, "");
      symlinkSync(terrariumctl, trm);

      const results = installCompletionScripts("all");

      expect(results).toEqual([
        expect.objectContaining({ shell: "bash", installed: true }),
        expect.objectContaining({ shell: "zsh", installed: false }),
        expect.objectContaining({ shell: "fish", installed: true })
      ]);
      expect(existsSync(join(dir, "bash", "terrariumctl"))).toBe(true);
      expect(readlinkSync(join(dir, "bash", "trm"))).toBe(join(dir, "bash", "terrariumctl"));
      expect(existsSync(join(dir, "fish", "terrariumctl.fish"))).toBe(true);
      expect(readlinkSync(join(dir, "fish", "trm.fish"))).toBe(join(dir, "fish", "terrariumctl.fish"));
      expect(existsSync(join(dir, "profile.d", "terrariumctl-completion.sh"))).toBe(true);
      expect(existsSync(join(dir, "zsh", "_terrariumctl"))).toBe(false);
    });
  });

  test("explicit shell installation does not require shell detection", () => {
    withCompletionEnv((dir) => {
      process.env.TERRARIUM_COMPLETION_SHELLS = "";
      const results = installCompletionScripts("zsh");

      expect(results).toEqual([expect.objectContaining({ shell: "zsh", installed: true })]);
      expect(existsSync(join(dir, "zsh", "_terrariumctl"))).toBe(true);
    });
  });
});
