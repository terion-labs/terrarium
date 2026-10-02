import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImageCreatePlan } from "./image";

const lxc = process.env.TERRARIUM_LXC_BIN ?? "/snap/bin/lxc";
const repoRoot = join(import.meta.dir, "../..");

function writeFakeLxc(path: string): void {
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$TERRARIUM_LXC_LOG"
if [ "$1" = --project ]; then shift 2; fi
if [ "$1" = query ] && [ "$2" = "/1.0/instances/web-01?project=default" ]; then printf '{"name":"web-01","type":"container","config":{},"devices":{}}\\n'; exit 0; fi
if [ "$1" = "snapshot" ] || [ "$1" = "copy" ] || [ "$1" = "delete" ]; then
  exit 0
fi
if [ "$1" = "publish" ]; then
  printf 'publish reached\\n' >> "$TERRARIUM_LXC_LOG"
  exit 0
fi
if [ "$1" = "query" ]; then
  if [ "$TERRARIUM_LXC_MODE" = inherited-profile ]; then
    case "$2" in
      /1.0/profiles/route*) printf '{"config":{"user.proxy":"https://leaked.example.test"}}'; exit 0 ;;
      /1.0/profiles/*) printf '{"config":{}}'; exit 0 ;;
    esac
    if [ -f "$TERRARIUM_LXC_LOG.state" ]; then cat "$TERRARIUM_LXC_LOG.state"; exit 0; fi
    printf '{"name":"temporary","type":"container","config":{},"expanded_config":{"user.proxy":"https://leaked.example.test","limits.cpu":"2"},"devices":{},"profiles":["vm","route"]}'
    exit 0
  fi
  case "$TERRARIUM_LXC_MODE" in
    show-fails)
      echo "cannot read config" >&2
      exit 17
      ;;
    bad-json)
      printf '{bad-json'
      exit 0
      ;;
    sticky-label)
      printf '{"name":"temporary","type":"container","config":{"user.proxy":"https://leaked.example.test:8443"},"devices":{}}\\n'
      exit 0
      ;;
    remove-fails)
      printf '{"name":"temporary","type":"container","config":{},"devices":{"public-http":{"type":"proxy"}}}\\n'
      exit 0
      ;;
    *)
      printf '{"name":"temporary","type":"container","config":{},"devices":{}}\\n'
      exit 0
      ;;
  esac
fi
if [ "$1" = "config" ] && { [ "$2" = "set" ] || [ "$2" = "unset" ]; }; then
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "edit" ]; then
  cat > "$TERRARIUM_LXC_LOG.state"
  # Simulate LXD recalculating expanded config after editing local config.
  sed 's/"expanded_config"/"ignored_previous_expansion"/' "$TERRARIUM_LXC_LOG.state" > "$TERRARIUM_LXC_LOG.next"
  mv "$TERRARIUM_LXC_LOG.next" "$TERRARIUM_LXC_LOG.state"
  cat "$TERRARIUM_LXC_LOG.state" >> "$TERRARIUM_LXC_LOG"
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "device" ] && [ "$3" = "remove" ]; then
  if [ "$TERRARIUM_LXC_MODE" = "remove-fails" ]; then
    echo "cannot remove proxy device" >&2
    exit 18
  fi
  exit 0
fi
echo "unexpected lxc command: $*" >&2
exit 99
`,
    { mode: 0o755 }
  );
}

function runImageCreateWithFakeLxc(mode: string): { exitCode: number | null; stderr: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "terrarium-image-test-"));
  try {
    const fakeLxc = join(dir, "lxc");
    const log = join(dir, "lxc.log");
    writeFakeLxc(fakeLxc);
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", join(repoRoot, "scripts/terrariumctl.ts"), "image", "create", "web-01", "golden-web", "--live"],
      cwd: repoRoot,
      env: { ...process.env, TERRARIUM_LXC_BIN: fakeLxc, TERRARIUM_LXC_LOG: log, TERRARIUM_LXC_MODE: mode },
      stdout: "pipe",
      stderr: "pipe"
    });
    return {
      exitCode: result.exitCode,
      stderr: new TextDecoder().decode(result.stderr),
      log: readFileSync(log, "utf8")
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("terrariumctl image", () => {
  test("detaches inherited route profiles while preserving their other effective settings", () => {
    const result = runImageCreateWithFakeLxc("inherited-profile");
    expect(result.exitCode).toBe(0);
    expect(result.log).toContain('"config":{"limits.cpu":"2"}');
    expect(result.log).toContain('"profiles":["vm"]');
    expect(result.log).toContain("publish reached");
  });
  test("creates a temporary snapshot-backed sanitized image plan by default", () => {
    expect(buildImageCreatePlan("web-01", "golden-web", {}, { now: 123, pid: 456 })).toEqual({
      instance: "web-01",
      alias: "golden-web",
      source: "web-01/terrarium-golden-123",
      tempInstance: "terrarium-image-golden-web-456-123",
      snapshotToCreate: "terrarium-golden-123",
      publishArgs: [lxc, "--project", "default", "publish", "terrarium-image-golden-web-456-123", "--alias", "golden-web"]
    });
  });

  test("can publish an existing snapshot or live instance", () => {
    expect(buildImageCreatePlan("web-01", "golden-web", { snapshot: "known-good", reuse: true }, { now: 123, pid: 456 })).toMatchObject({
      source: "web-01/known-good",
      publishArgs: [lxc, "--project", "default", "publish", "terrarium-image-golden-web-456-123", "--alias", "golden-web", "--reuse"]
    });
    const livePlan = buildImageCreatePlan("web-01", "golden-web", { live: true }, { now: 123, pid: 456 });
    expect(livePlan).toMatchObject({ source: "web-01" });
    expect(livePlan).not.toHaveProperty("snapshotToCreate");
  });

  test("rejects ambiguous or missing image create inputs", () => {
    expect(() => buildImageCreatePlan("", "golden-web")).toThrow("instance is required");
    expect(() => buildImageCreatePlan("web-01", "")).toThrow("image alias is required");
    expect(() => buildImageCreatePlan("web-01", "golden-web", { snapshot: "known-good", live: true })).toThrow("use either --snapshot or --live");
  });

  test("fails closed when proxy sanitization cannot read image source config", () => {
    const result = runImageCreateWithFakeLxc("show-fails");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("LXD query failed: cannot read config");
    expect(result.log).not.toContain("publish reached");
  });

  test("fails closed when proxy sanitization cannot parse image source config", () => {
    const result = runImageCreateWithFakeLxc("bad-json");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("JSON Parse error");
    expect(result.log).not.toContain("publish reached");
  });

  test("fails closed when inherited proxy config remains after sanitization", () => {
    const result = runImageCreateWithFakeLxc("sticky-label");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("still has user.proxy after sanitization");
    expect(result.log).not.toContain("publish reached");
  });

  test("fails closed when inherited proxy devices cannot be removed", () => {
    const result = runImageCreateWithFakeLxc("remove-fails");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("LXD config failed: cannot remove proxy device");
    expect(result.log).not.toContain("publish reached");
  });
});
