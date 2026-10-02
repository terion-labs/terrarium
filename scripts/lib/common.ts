import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { spawn } from "node:child_process";
import { readConfigYaml } from "./config-store";

export type JsonRecord = Record<string, unknown>;

/** Prints a prefixed fatal error and exits the current process immediately. */
export function fail(prefix: string, message: string): never {
  console.error(`${prefix}: ${message}`);
  process.exit(1);
}

/** Verifies that a required external command is available on the current PATH. */
export function ensureCommand(name: string, prefix: string): void {
  if (!Bun.which(name)) {
    fail(prefix, `missing required command: ${name}`);
  }
}

/** Reads a YAML file and parses it into the requested object shape. */
export function readYamlFile<T>(path: string, prefix: string): T {
  if (!existsSync(path)) {
    fail(prefix, `missing file: ${path}`);
  }
  return (parse(readFileSync(path, "utf8")) ?? {}) as T;
}

/**
 * Atomically writes a file only when the content actually changed.
 *
 * This keeps configuration updates idempotent and avoids unnecessary service
 * restarts triggered by no-op file rewrites.
 */
type WriteIfChangedOptions = {
  mode?: number;
  directoryMode?: number;
};

function applyMode(path: string, mode: number | undefined): void {
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
}

export function writeIfChanged(path: string, content: string, options: WriteIfChangedOptions = {}): boolean {
  const targetDir = dirname(path);
  if (options.directoryMode !== undefined) {
    mkdirSync(targetDir, { recursive: true, mode: options.directoryMode });
    applyMode(targetDir, options.directoryMode);
  }

  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === content) {
    applyMode(path, options.mode);
    return false;
  }
  mkdirSync(targetDir, { recursive: true, mode: options.directoryMode });
  applyMode(targetDir, options.directoryMode);

  // Write into a sibling temp directory outside the watched target directory so
  // file watchers such as Traefik do not try to parse half-written temp files.
  const parentDir = dirname(targetDir);
  const tempRoot = join(parentDir === targetDir ? targetDir : parentDir, ".terrarium-tmp");
  mkdirSync(tempRoot, { recursive: true, mode: options.directoryMode });
  applyMode(tempRoot, options.directoryMode);
  const tempPath = join(tempRoot, `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tempPath, content, options.mode === undefined ? "utf8" : { encoding: "utf8", mode: options.mode });
  renameSync(tempPath, path);
  applyMode(path, options.mode);
  return true;
}

/** Writes a pretty-printed JSON file with a trailing newline. */
export function writeJsonFile(path: string, value: unknown): void {
  writeIfChanged(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Reads JSON from disk or returns a caller-provided fallback value. */
export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    return fallback;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Stringifies arbitrary values into YAML using the repo’s standard serializer. */
export function yamlStringify(value: unknown): string {
  return stringify(value);
}

export type CommandOptions = { cwd?: string; stdin?: string | Uint8Array; env?: Record<string, string>; timeoutMs?: number };
type CommandResult = { exitCode: number; stdout: string; stderr: string };

function commandEnv(extra: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!extra) {
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return "";
  }
  return await new Response(stream).text();
}

/**
 * Runs a command with consistent quiet/no-throw semantics.
 *
 * Higher-level helpers build on this so the rest of the codebase can choose
 * between fail-fast behavior and explicit exit-code handling.
 */
async function shellCommand(cmd: string[], options: CommandOptions = {}): Promise<CommandResult> {
  if (options.timeoutMs !== undefined) return boundedCommand(cmd, options);
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd,
    env: commandEnv(options.env),
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });
  const stdout = readStream(proc.stdout);
  const stderr = readStream(proc.stderr);
  try {
    if (options.stdin !== undefined) {
      const stdin = proc.stdin as { write(input: string | Uint8Array): unknown; end(): unknown } | undefined;
      if (!stdin) throw new Error(`failed to open stdin pipe for command: ${cmd[0]}`);
      await stdin.write(options.stdin);
      await stdin.end();
    }

    const [exitCode, stdoutText, stderrText] = await Promise.all([proc.exited, stdout, stderr]);
    return { exitCode, stdout: stdoutText, stderr: stderrText };
  } catch (error) {
    proc.kill("SIGKILL");
    await Promise.allSettled([proc.exited, stdout, stderr]);
    throw error;
  }
}

/** Kill the whole probe process group so a child holding stdout cannot defeat the deadline. */
function boundedCommand(cmd: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    const grouped = process.platform !== "win32";
    const proc = spawn(cmd[0]!, cmd.slice(1), {
      cwd: options.cwd, env: commandEnv(options.env), detached: grouped,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let settled = false;
    const finish = (exitCode: number, detail?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout: Buffer.concat(output).toString(), stderr: [Buffer.concat(errors).toString(), detail].filter(Boolean).join("\n") });
    };
    const timer = setTimeout(() => {
      if (grouped && proc.pid) {
        try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
      } else proc.kill("SIGKILL");
      proc.stdin?.destroy();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      finish(124, `command timed out after ${options.timeoutMs}ms`);
    }, options.timeoutMs);
    proc.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
    proc.on("error", (error) => finish(127, error.message));
    proc.on("close", (code) => finish(code ?? 1));
    // A command may exit without reading its input. Its exit status is authoritative.
    proc.stdin?.on("error", () => {});
    if (options.stdin !== undefined) proc.stdin?.end(options.stdin);
  });
}

/** Runs a command and returns stdout, failing the process if it exits non-zero. */
export async function runText(cmd: string[], prefix: string, options: CommandOptions = {}): Promise<string> {
  const proc = await shellCommand(cmd, options);
  if (proc.exitCode !== 0) {
    const stdout = proc.stdout.trim();
    const stderr = proc.stderr.trim();
    const details = [
      `command failed (${proc.exitCode}): ${cmd.join(" ")}`,
      stdout ? `stdout:\n${stdout}` : "",
      stderr ? `stderr:\n${stderr}` : ""
    ].filter(Boolean);
    const rendered = details.join("\n\n");
    fail(prefix, rendered);
  }
  return proc.stdout;
}

/** Runs a command and parses its stdout as JSON. */
export async function runJson<T>(cmd: string[], prefix: string, options: { cwd?: string; env?: Record<string, string> } = {}): Promise<T> {
  const stdout = await runText(cmd, prefix, options);
  return JSON.parse(stdout || "null") as T;
}

/** Runs a command and returns stdout, stderr, and exit code without failing automatically. */
export async function runAllowFailure(
  cmd: string[],
  options: CommandOptions = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = await shellCommand(cmd, options);
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr
  };
}

/** Executes a full shell command string through `bash -lc`. */
export async function runShell(command: string, prefix: string, options: { cwd?: string; env?: Record<string, string> } = {}): Promise<void> {
  await runText(["bash", "-lc", command], prefix, options);
}

/** Runs a subprocess with inherited stdio for fully interactive flows. */
export async function runInteractive(cmd: string[], prefix: string, options: { cwd?: string } = {}): Promise<void> {
  try {
    await runInteractiveChecked(cmd, options);
  } catch (error) {
    fail(prefix, error instanceof Error ? error.message : String(error));
  }
}

/** Interactive execution that preserves a caller's cleanup and recovery error handling. */
export async function runInteractiveChecked(cmd: string[], options: { cwd?: string } = {}): Promise<void> {
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`command failed: ${cmd.join(" ")}`);
  }
}

/** Escapes a shell argument for safe interpolation into ad-hoc shell strings. */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/** Loads the canonical Terrarium YAML config file. */
export function loadConfig(path: string, prefix: string): Record<string, unknown> {
  return readConfigYaml<Record<string, unknown>>(path, prefix);
}

/** Resolves a dotted configuration path from a YAML-backed config object. */
export function configValue(config: Record<string, unknown>, key: string): unknown {
  let value: unknown = config;
  for (const part of key.split(".")) {
    if (typeof value !== "object" || value === null || !(part in value)) {
      return "";
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value ?? "";
}

/** Resolves a config value as a string with a fallback for empty or missing values. */
export function configString(config: Record<string, unknown>, key: string, fallback = ""): string {
  const value = configValue(config, key);
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

/** Resolves a config value as a boolean using Terrarium’s accepted truthy spellings. */
export function configBoolean(config: Record<string, unknown>, key: string): boolean {
  const value = configValue(config, key);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

/** Normalizes S3-compatible endpoints so bare hostnames default to HTTPS. */
export function normalizeS3Endpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return "";
  }
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Creates a new temporary directory using the OS temp root and a caller prefix. */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Removes a path recursively and ignores missing-path errors. */
export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
