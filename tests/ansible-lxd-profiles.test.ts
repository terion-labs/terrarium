import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

const defaultPathExport = 'export PATH="$HOME/.venvs/default/bin:$PATH"';

function expectTerrariumUserProfile(
  content: string,
  options: { allowsPasswordlessSudo?: boolean } = {},
): void {
  expect(content).toContain("cloud-init.vendor-data: |");
  expect(content).toContain("name: terrarium");
  expect(content).toContain("gecos: Terrarium Container User");
  expect(content).toContain("lock_passwd: true");
  expect(content).toContain("shell: /bin/bash");
  expect(content).toContain(options.allowsPasswordlessSudo ? 'sudo: ["ALL=(ALL) NOPASSWD:ALL"]' : "sudo: []");
  if (options.allowsPasswordlessSudo) {
    expect(content).toContain("NOPASSWD");
  } else {
    expect(content).not.toContain("NOPASSWD");
  }

  expect(content).toContain("packages:");
  expect(content).toContain("- python3-full");
  expect(content).toContain("- python3-venv");
  expect(content).toContain("runcmd:");
  expect(content).toContain("mkdir -p /home/terrarium/.venvs");
  expect(content).toContain(
    "test -x /home/terrarium/.venvs/default/bin/python || python3 -m venv /home/terrarium/.venvs/default",
  );
  expect(content).toContain("chown -R terrarium:terrarium /home/terrarium/.venvs");
  expect(content).toContain(defaultPathExport);
  expect(content).toContain(
    `grep -qxF '${defaultPathExport}' /home/terrarium/.profile`,
  );
  expect(content).toContain(
    `grep -qxF '${defaultPathExport}' /home/terrarium/.bashrc`,
  );
}

describe("LXD profiles", () => {
  test("makes the Docker-friendly Terrarium profile the LXD default on OVN", () => {
    const preseed = readRepoFile("ansible/roles/lxd/templates/lxd-preseed.yml.j2");
    const defaultProfile = readRepoFile("ansible/roles/lxd/templates/default-profile.yml.j2");
    const terrariumProfile = readRepoFile("ansible/roles/lxd/templates/terrarium-profile.yml.j2");
    const tasks = readRepoFile("ansible/roles/lxd/tasks/main.yml");

    expect(preseed).toContain("ipv4.ovn.ranges: {{ terrarium_lxd_parent_ovn_range }}");
    expect(preseed).toContain("network: {{ terrarium_lxd_network_parent }}");
    expectTerrariumUserProfile(preseed);

    for (const content of [defaultProfile, terrariumProfile]) {
      expectTerrariumUserProfile(content);
      expect(content).toContain('security.idmap.isolated: "true"');
      expect(content).toContain('security.nesting: "true"');
      expect(content).toContain('security.syscalls.intercept.mknod: "true"');
      expect(content).toContain('security.syscalls.intercept.setxattr: "true"');
      expect(content).toContain("network: {{ terrarium_lxd_network_name }}");
      expect(content).toContain("pool: {{ terrarium_lxd_pool_name }}");
    }

    expect(defaultProfile).toContain("name: default");
    expect(terrariumProfile).toContain("name: terrarium");
    expect(tasks).toContain("Install OVN networking packages");
    expect(tasks).toContain("Create Terrarium OVN workload network");
    expect(tasks).toContain("Apply Terrarium-managed LXD profiles");
    expect(tasks).toContain('name: "default"');
    expect(tasks).toContain('name: "terrarium"');
  });

  test("pre-creates strict, dev, and KVM profiles for explicit workload choices", () => {
    const strictProfile = readRepoFile("ansible/roles/lxd/templates/strict-profile.yml.j2");
    const devProfile = readRepoFile("ansible/roles/lxd/templates/dev-profile.yml.j2");
    const kvmProfile = readRepoFile("ansible/roles/lxd/templates/kvm-profile.yml.j2");
    const tasks = readRepoFile("ansible/roles/lxd/tasks/main.yml");

    expect(strictProfile).toContain("name: strict");
    expectTerrariumUserProfile(strictProfile);
    expect(strictProfile).toContain('security.idmap.isolated: "true"');
    expect(strictProfile).not.toContain("security.nesting");
    expect(strictProfile).not.toContain("security.syscalls.intercept");
    expect(strictProfile).toContain("network: {{ terrarium_lxd_network_name }}");
    expect(strictProfile).toContain("pool: {{ terrarium_lxd_pool_name }}");

    expectTerrariumUserProfile(devProfile, { allowsPasswordlessSudo: true });
    expect(devProfile).toContain("name: dev");
    expect(devProfile).toContain("cloud-init.vendor-data: |");
    expect(devProfile).not.toContain("cloud-init.user-data:");
    expect(devProfile).not.toContain("write_files:");
    expect(devProfile).toContain('security.idmap.isolated: "true"');
    expect(devProfile).toContain('security.nesting: "true"');
    expect(devProfile).toContain('security.syscalls.intercept.mknod: "true"');
    expect(devProfile).toContain('security.syscalls.intercept.setxattr: "true"');
    expect(devProfile).toContain("network: {{ terrarium_lxd_network_name }}");
    expect(devProfile).toContain("pool: {{ terrarium_lxd_pool_name }}");
    expect(devProfile).toContain("  root:");
    expect(devProfile).toContain("  eth0:");

    expect(kvmProfile).toContain("name: kvm");
    expect(kvmProfile).toContain('security.nesting: "true"');
    expect(kvmProfile).toContain("source: /dev/kvm");
    expect(kvmProfile).toContain("type: unix-char");

    expect(tasks).toContain('name: "strict"');
    expect(tasks).toContain('name: "dev"');
    expect(tasks).toContain("Check whether host exposes KVM");
    expect(tasks).toContain("path: /dev/kvm");
    expect(tasks).toContain("when: terrarium_lxd_kvm_device.stat.exists");
  });

  test("refreshes or installs snapd snap before installing LXD", () => {
    const tasks = readRepoFile("ansible/roles/lxd/tasks/main.yml");
    const prerequisiteBlock =
      tasks.match(
        /- name: Check whether snapd snap is installed\n[\s\S]*?\n- name: Check whether LXD snap is already installed/,
      )?.[0] ?? "";

    expect(prerequisiteBlock).not.toBe("");
    expect(prerequisiteBlock).toContain("snap list snapd");
    expect(prerequisiteBlock).toContain("snap refresh snapd");
    expect(prerequisiteBlock).toContain("when: terrarium_snapd_snap_list.rc == 0");
    expect(prerequisiteBlock).toContain("snap install snapd");
    expect(prerequisiteBlock).toContain("when: terrarium_snapd_snap_list.rc != 0");
    expect(prerequisiteBlock).toContain("has no updates available");
    expect(prerequisiteBlock).toContain("already installed");
    expect(prerequisiteBlock).toContain("snap changes --no-legend");
    expect(prerequisiteBlock).toContain("snap watch");
    expect(tasks.indexOf("snap refresh snapd")).toBeLessThan(
      tasks.indexOf("snap install lxd --channel={{ terrarium_lxd_snap_channel }}"),
    );
    expect(tasks.indexOf("snap install snapd")).toBeLessThan(
      tasks.indexOf("snap install lxd --channel={{ terrarium_lxd_snap_channel }}"),
    );
  });

  test("waits out snap install change races before accepting LXD install", () => {
    const tasks = readRepoFile("ansible/roles/lxd/tasks/main.yml");
    const installTask =
      tasks.match(
        /- name: Install LXD snap when missing\n[\s\S]*?\n- name: Wait for active snap changes to settle after LXD install/,
      )?.[0] ?? "";

    expect(installTask).not.toBe("");
    expect(installTask).toContain("ansible.builtin.shell");
    expect(installTask).toContain(
      "snap install lxd --channel={{ terrarium_lxd_snap_channel }}",
    );
    expect(installTask).toContain("already installed");
    expect(installTask).toContain("change in progress|install-snap");
    expect(installTask).toContain("snap changes --no-legend");
    expect(installTask).toContain("snap watch");
    expect(installTask).toContain("snap list lxd");
    expect(installTask).toContain('exit "$install_rc"');
  });

  test("requires LXD daemon and client readiness before LXD operations", () => {
    const tasks = readRepoFile("ansible/roles/lxd/tasks/main.yml");
    const readinessTask =
      tasks.match(
        /- name: Require LXD snap readiness after install\n[\s\S]*?\n- name: Enable LXD UI/,
      )?.[0] ?? "";

    expect(readinessTask).not.toBe("");
    expect(readinessTask).toContain("ansible.builtin.shell");
    expect(readinessTask).toContain("/usr/bin/timeout --kill-after=5s 30s /snap/bin/lxd waitready");
    expect(readinessTask).toContain("/usr/bin/timeout --kill-after=5s 30s /snap/bin/lxc info");
    expect(readinessTask).toContain("Installing LXD snap, please be patient.");
    expect(readinessTask).toContain("grep -Fq");
    expect(readinessTask).toContain("LXD did not become ready after snap installation.");
    expect(readinessTask).toContain("Last /snap/bin/lxd waitready rc=");
    expect(readinessTask).toContain("Last /snap/bin/lxc info rc=");
    expect(readinessTask).toContain("snap changes");
    expect(readinessTask).toContain("snap services lxd");
    expect(readinessTask).toContain("exit 1");
    expect(readinessTask).toContain("changed_when: false");
    expect(readinessTask).not.toContain("snap list lxd");
  });
});

describe("OVN TLS", () => {
  test("uses authenticated OVN database remotes in cluster mode", () => {
    const tasks = readRepoFile("ansible/roles/lxd/tasks/main.yml");
    const central = readRepoFile("ansible/roles/lxd/templates/ovn-central.j2");
    const site = readRepoFile("ansible/site.yml");

    expect(site).toContain("terrarium_ovn_ca_cert");
    expect(site).toContain("terrarium_ovn_ca_key");

    expect(central).not.toContain("create-insecure-remote=yes");
    expect(central).toContain("--db-nb-create-insecure-remote=no");
    expect(central).toContain("--db-sb-create-insecure-remote=no");
    expect(central).toContain("--ovn-nb-db-ssl-key={{ terrarium_ovn_node_key_path }}");
    expect(central).toContain("--ovn-sb-db-ssl-key={{ terrarium_ovn_node_key_path }}");
    expect(central).toContain("--db-nb-cluster-local-proto=ssl");
    expect(central).toContain("--db-sb-cluster-local-proto=ssl");

    expect(tasks).toContain("Assert OVN CA material exists for cluster mode");
    expect(tasks).toContain("Configure OVN northbound SSL listener");
    expect(tasks).toContain("Configure OVN southbound SSL listener");
    expect(tasks).toContain("pssl:6641");
    expect(tasks).toContain("pssl:6642");
    expect(tasks).toContain("Configure Open vSwitch SSL identity for OVN");
    expect(tasks).toContain("network.ovn.ca_cert");
    expect(tasks).toContain("network.ovn.client_cert");
    expect(tasks).toContain("network.ovn.client_key");
    expect(tasks).toContain("network.ovn.northbound_connection");
    expect(tasks).toContain("Pin clustered LXD API to the WireGuard tunnel address");
    expect(tasks).toContain("core.https_address {{ terrarium_ovn_local_address }}:8443");
    expect(tasks).toContain("'ssl:' ~ host ~ ':6641'");
    expect(tasks).toContain("'ssl:' ~ host ~ ':6642'");
  });
});
