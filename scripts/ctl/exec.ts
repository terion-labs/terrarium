import { runInteractive, shellEscape } from "../lib/common";
import { PREFIX } from "./context";
import { lxcArgs, readInstance, waitForInstanceReady } from "../lib/lxd-instance";

const LXC = process.env.TERRARIUM_LXC_BIN ?? "/snap/bin/lxc";
const DEFAULT_CONTAINER_USER = "terrarium";

export type ExecOptions = {
  root?: boolean;
  user?: string;
};

function normalizedContainerUser(options: ExecOptions): string {
  if (options.root && options.user) {
    throw new Error("pass either --root or --user, not both");
  }
  const user = options.user?.trim() || DEFAULT_CONTAINER_USER;
  if (!user) {
    throw new Error("--user cannot be empty");
  }
  return user;
}

function commandString(command: string[]): string {
  return command.map(shellEscape).join(" ");
}

export function buildExecArgs(instance: string, command: string[], options: ExecOptions = {}): string[] {
  const normalizedInstance = instance.trim();
  if (!normalizedInstance) {
    throw new Error("exec requires an instance name");
  }
  if (options.root && options.user) {
    throw new Error("pass either --root or --user, not both");
  }

  if (options.root) {
    return command.length > 0
      ? lxcArgs("exec", normalizedInstance, "--", ...command)
      : lxcArgs("exec", normalizedInstance, "--", "bash", "-l");
  }

  const user = normalizedContainerUser(options);
  return command.length > 0
    ? lxcArgs("exec", normalizedInstance, "--", "su", "-l", user, "-c", commandString(command))
    : lxcArgs("exec", normalizedInstance, "--", "su", "-l", user);
}

export async function execCmd(instance: string, command: string[], options: ExecOptions = {}): Promise<void> {
  const args = buildExecArgs(instance, command, options);
  const info = await readInstance(instance);
  if (info.type === "virtual-machine") await waitForInstanceReady(instance, { timeoutMs: 60_000 });
  await runInteractive(args, PREFIX);
}
