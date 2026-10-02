import { describe, expect, test } from "bun:test";
import { buildExecArgs } from "./exec";

const lxc = process.env.TERRARIUM_LXC_BIN ?? "/snap/bin/lxc";

describe("terrariumctl exec", () => {
  test("opens a login shell as the terrarium user by default", () => {
    expect(buildExecArgs("app", [])).toEqual([lxc, "--project", "default", "exec", "app", "--", "su", "-l", "terrarium"]);
  });

  test("runs passthrough commands as the terrarium user with shell-safe quoting", () => {
    expect(buildExecArgs("app", ["bash", "-lc", "printf '%s\\n' hello"])).toEqual([
      lxc, "--project", "default",
      "exec",
      "app",
      "--",
      "su",
      "-l",
      "terrarium",
      "-c",
      `'bash' '-lc' 'printf '\"'\"'%s\\n'\"'\"' hello'`
    ]);
  });

  test("keeps root explicit for recovery shells and commands", () => {
    expect(buildExecArgs("app", [], { root: true })).toEqual([lxc, "--project", "default", "exec", "app", "--", "bash", "-l"]);
    expect(buildExecArgs("app", ["id"], { root: true })).toEqual([lxc, "--project", "default", "exec", "app", "--", "id"]);
  });

  test("supports an explicit non-root container user", () => {
    expect(buildExecArgs("app", [], { user: "ubuntu" })).toEqual([lxc, "--project", "default", "exec", "app", "--", "su", "-l", "ubuntu"]);
  });

  test("rejects ambiguous user selection", () => {
    expect(() => buildExecArgs("app", [], { root: true, user: "terrarium" })).toThrow("pass either --root or --user");
  });
});
