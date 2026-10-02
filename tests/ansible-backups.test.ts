import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("backup role", () => {
  test("replication service uses the complete-set controller", () => {
    const service = readFileSync(join(repoRoot, "ansible/roles/backups/templates/terrarium-syncoid.service.j2"), "utf8");
    expect(service).toContain("ExecStart=/usr/local/bin/terrariumctl backup replicate");
    const sanoid = readFileSync(join(repoRoot, "ansible/roles/backups/templates/sanoid.conf.j2"), "utf8");
    expect(sanoid).toContain("/virtual-machines]");
    expect(sanoid).toContain("recursive = zfs");
    expect(sanoid).toContain("process_children_only = no");
  });

  test("installs AWS CLI fallback from a pinned archive through private staging", () => {
    const defaults = readFileSync(join(repoRoot, "ansible/roles/backups/defaults/main.yml"), "utf8");
    const tasks = readFileSync(join(repoRoot, "ansible/roles/backups/tasks/main.yml"), "utf8");

    expect(defaults).toContain('terrarium_awscli_version: "2.34.41"');
    expect(defaults).toContain("terrarium_awscli_download_dir: /var/lib/terrarium/downloads/awscli");
    expect(defaults).toContain("terrarium_awscli_stage_dir: /var/lib/terrarium/staging/awscli");
    expect(defaults).toContain("terrarium_awscli_sha256:");
    expect(tasks).toContain("Create private AWS CLI fallback work directories");
    expect(tasks).toContain('mode: "0700"');
    expect(tasks).toContain("checksum: \"sha256:{{ terrarium_awscli_archive_checksum }}\"");
    expect(tasks).toContain("Validate AWS CLI v2 fallback archive metadata");
    expect(tasks).toContain("archive member outside aws installer tree");
    expect(tasks).toContain("unzip -Zl \"$archive\" | awk '$1 ~ /^[lbcps]/");
    expect(tasks).toContain("{{ terrarium_awscli_stage_dir }}/aws/install");
    expect(tasks).not.toContain("dest: /tmp");
    expect(tasks).not.toContain("path: /tmp/awscliv2");
    expect(tasks).not.toContain("ansible.builtin.unarchive");
  });
});
