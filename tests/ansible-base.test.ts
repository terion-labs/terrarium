import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("base role packages", () => {
  test("installs required storage and network packages through the fatal base package list", () => {
    const defaults = readFileSync(join(repoRoot, "ansible/roles/base/defaults/main.yml"), "utf8");

    expect(defaults).toContain("- cifs-utils");
    expect(defaults).toContain("- wireguard-tools");
    expect(defaults).not.toMatch(/terrarium_base_packages:[\s\S]*-\s+"?linux-modules-extra-\{\{ ansible_kernel \}\}"?/);
    expect(defaults).toContain('terrarium_kernel_modules_extra_package: "linux-modules-extra-{{ ansible_kernel }}"');
  });

  test("installs linux-modules-extra only when apt exposes an installable candidate", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/base/tasks/main.yml"), "utf8");

    expect(tasks).toContain("Check optional kernel modules extra package candidate");
    expect(tasks).toContain("apt-cache policy {{ terrarium_kernel_modules_extra_package | quote }}");
    expect(tasks).toContain("END { exit(found ? 0 : 1) }");
    expect(tasks).toContain("Install optional kernel modules extra package");
    expect(tasks).toContain("when: terrarium_kernel_modules_extra_policy.rc == 0");
  });

  test("keeps linux-modules-extra install non-fatal when apt cannot resolve the optional package", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/base/tasks/main.yml"), "utf8");

    expect(tasks).toContain("register: terrarium_kernel_modules_extra_install");
    expect(tasks).toContain("terrarium_kernel_modules_extra_install is failed");
    expect(tasks).toContain("No package matching '");
    expect(tasks).toContain("' is available");
    expect(tasks).toContain("Unable to locate package");
    expect(tasks).toContain("terrarium_kernel_modules_extra_package");
  });
});

describe("cluster firewall", () => {
  test("opens WireGuard publicly only for invited endpoints and LXD/OVN only for tunnel peers", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/base/tasks/main.yml"), "utf8");

    expect(tasks).toContain("Allow WireGuard mesh from configured peer endpoints");
    expect(tasks).toContain("terrarium_cluster_wireguard_endpoint_cidrs");
    expect(tasks).toContain("terrarium_cluster_wireguard_port");
    expect(tasks).toContain("Allow LXD cluster API from configured peer networks");
    expect(tasks).toContain("terrarium_cluster_peer_cidrs");
    expect(tasks).toContain("'6081'");
    expect(tasks).toContain("'6641'");
    expect(tasks).toContain("'6642'");
  });

  test("renders WireGuard from local private key and registered cluster members", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/base/tasks/main.yml"), "utf8");
    const template = readFileSync(join(repoRoot, "ansible/roles/base/templates/wireguard.conf.j2"), "utf8");
    const site = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");

    expect(site).toContain("terrarium_cluster_wireguard_enabled");
    expect(site).toContain("terrarium_cluster_wireguard_members");
    expect(tasks).toContain("Resolve local WireGuard public key");
    expect(tasks).toContain("Use WireGuard tunnel address for clustered LXD and OVN");
    expect(tasks).toContain("wg-quick@{{ terrarium_cluster_wireguard_interface }}");
    expect(template).toContain("PrivateKey = {{ terrarium_cluster_wireguard_private_key_plain }}");
    expect(template).toContain("AllowedIPs = {{ peer.tunnel_ip }}/32");
    expect(template).toContain("PersistentKeepalive = 25");
  });
});

describe("config store reconciliation", () => {
  test("imports and removes the local config export before proxy sync", () => {
    const site = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");
    const importIndex = site.indexOf("terrariumctl config import");
    const removeIndex = site.indexOf("Remove transient local config export after dqlite import");
    const proxyIndex = site.indexOf("terrariumctl proxy sync");

    expect(importIndex).toBeGreaterThan(0);
    expect(removeIndex).toBeGreaterThan(importIndex);
    expect(proxyIndex).toBeGreaterThan(removeIndex);
  });

  test("keeps timer-driven proxy sync independent of the transient config export", () => {
    const service = readFileSync(join(repoRoot, "ansible/roles/traefik/templates/terrarium-traefik-sync.service.j2"), "utf8");

    expect(service).toContain("ConditionPathExists=/usr/local/bin/terrariumctl");
    expect(service).not.toContain("ConditionPathExists={{ terrarium_config_path }}");
    expect(service).toContain("ExecStart=/usr/local/bin/terrariumctl proxy sync");
  });
});

describe("partition-mode storage", () => {
  test("uses the partition created at the selected free-space offset", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/zfs/tasks/main.yml"), "utf8");

    expect(tasks).toContain("Locate partition created in discovered free space");
    expect(tasks).toContain('awk -F: -v start="{{ terrarium_storage_partition_start }}"');
    expect(tasks).toContain("terrarium_created_partition_source.stdout");
    expect(tasks).toContain("if terrarium_storage_partition_start | length > 0");
    expect(tasks).toContain("if terrarium_storage_source | regex_search('[0-9]+$')");
  });
});

describe("terrariumctl install alias", () => {
  test("installs trm as a shorthand symlink to the installed CLI", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/base/tasks/main.yml"), "utf8");

    expect(tasks).toContain("Inspect existing terrariumctl shorthand alias");
    expect(tasks).toContain("Install terrariumctl shorthand alias");
    expect(tasks).toContain("src: /usr/local/bin/terrariumctl");
    expect(tasks).toContain("dest: /usr/local/bin/trm");
    expect(tasks).toContain("state: link");
    expect(tasks).toContain("leaving it untouched");
  });

  test("registers shell completions for terrariumctl and trm", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/base/tasks/main.yml"), "utf8");

    expect(tasks).toContain("Install Terrarium shell completions for available shells");
    expect(tasks).toContain("/usr/local/bin/terrariumctl completion all install");
  });

  test("loads bash completion explicitly for interactive shells", () => {
    const completion = readFileSync(join(repoRoot, "scripts/ctl/completion.ts"), "utf8");

    expect(completion).toContain('${BASH_VERSION:-}');
    expect(completion).toContain('case "$-" in *i*)');
    expect(completion).toContain("complete -p terrariumctl");
    expect(completion).toContain("terrariumctl-completion.sh");
  });
});

describe("terrariumctl mount defaults", () => {
  test("keeps local CIFS permission checks and applies host hardening flags", () => {
    const mount = readFileSync(join(repoRoot, "scripts/ctl/mount.ts"), "utf8");

    expect(mount).not.toContain('"noperm"');
    expect(mount).toContain('"nosuid"');
    expect(mount).toContain('"nodev"');
    expect(mount).toContain('"noexec"');
    expect(mount).toContain('"forceuid"');
    expect(mount).toContain('"forcegid"');
  });

  test("keeps host CIFS mounts root-owned by default", () => {
    const ctl = readFileSync(join(repoRoot, "scripts/terrariumctl.ts"), "utf8");
    const mount = readFileSync(join(repoRoot, "scripts/ctl/mount.ts"), "utf8");

    expect(mount).toContain('export const DEFAULT_CIFS_UID = "0"');
    expect(mount).toContain('export const DEFAULT_CIFS_GID = "0"');
    expect(ctl).toContain('.option("--uid <uid>", "UID to present for mounted files", STRING_OPTION)');
    expect(ctl).toContain('.option("--gid <gid>", "GID to present for mounted files", STRING_OPTION)');
  });

  test("can attach managed mounts to unprivileged LXD containers without exposing idmaps", () => {
    const ctl = readFileSync(join(repoRoot, "scripts/terrariumctl.ts"), "utf8");
    const mount = readFileSync(join(repoRoot, "scripts/ctl/mount.ts"), "utf8");
    const full = readFileSync(join(repoRoot, "tests/integration/scenarios/full.ts"), "utf8");
    const ctlDocs = readFileSync(join(repoRoot, "docs/reference/terrariumctl.md"), "utf8");
    const storageDocs = readFileSync(join(repoRoot, "docs/getting-started/external-shared-storage.md"), "utf8");

    expect(ctl).toContain("--container <name>");
    expect(ctl).toContain("mount attach /host/path INSTANCE");
    expect(ctl).toContain("mountAttachCmd(hostPath, instance");
    expect(mount).toContain("lookupInstanceRootIdmap");
    expect(mount).toContain("volatile.idmap.current");
    expect(mount).not.toContain('"shift=true"');
    expect(full).toContain("--container ${shellArg(sharedContainer)} --container-path /mnt/shared");
    expect(ctlDocs).not.toMatch(/idmap/i);
    expect(storageDocs).not.toMatch(/idmap/i);
  });

  test("recovers dashed CIFS mode options from the CLI parser", () => {
    const ctl = readFileSync(join(repoRoot, "scripts/terrariumctl.ts"), "utf8");

    expect(ctl).toContain('cliOption(rawOptions, "fileMode", ["file-mode"])');
    expect(ctl).toContain('cliOption(rawOptions, "dirMode", ["dir-mode"])');
  });

  test("supports file-based CIFS password input", () => {
    const ctl = readFileSync(join(repoRoot, "scripts/terrariumctl.ts"), "utf8");
    const mount = readFileSync(join(repoRoot, "scripts/ctl/mount.ts"), "utf8");

    expect(ctl).toContain("--password-file <path>");
    expect(mount).toContain("passwordFile?: string");
    expect(mount).toContain("readFileSync(options.passwordFile");
  });

  test("rejects malformed CIFS shares and replaces stale host-path blocks", () => {
    const mount = readFileSync(join(repoRoot, "scripts/ctl/mount.ts"), "utf8");

    expect(mount).toContain("share address must include a server and share name");
    expect(mount).toContain("//server/share");
    expect(mount).toContain(".filter((mount) => mount.hostPath === hostPath)");
    expect(mount).toContain(".reduce((current, mount) => stripManagedBlock(current, mount.marker), fstabCurrent)");
  });
});
