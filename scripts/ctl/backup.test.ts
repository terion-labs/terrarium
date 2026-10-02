import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNewRestoreTargetIsUnused,
  cloneRootfsSnapshotIfPresent,
  mountRootfsDatasetForLxdRecover,
  prepareRootfsDirectoryForLxdRecover,
  rewriteRecoveredBackupMetadata,
  rollbackSnapshotsForDatasetTree
} from "./backup";
import { chooseLatestExportSnapshot, isRetriableS3ExportError, planS3SnapshotExport, zfsReplicationSendCommand } from "../terrarium-s3-export";

describe("backup restore metadata", () => {
  test("preserves VM firmware and provisioning state without rewriting application or profile data", () => {
    const source = { version: 2, instance: { name: "source", config: { "volatile.uuid": "old", "volatile.cloud-init.instance-id": "provisioned-id", "volatile.eth0.bus": "0000:06:00.0", "user.application": "source" }, devices: {} }, profiles: [{ name: "source", config: { "user.proxy": "keep-profile-value" } }], volumes: [{ name: "source", created_at: "2026-10-02T02:04:06.123456789Z" }] };
    const restored = rewriteRecoveredBackupMetadata(source, "source", "clone");
    expect(restored.instance).toEqual({ name: "clone", config: { "volatile.cloud-init.instance-id": "provisioned-id", "volatile.eth0.bus": "0000:06:00.0", "user.application": "source" }, devices: {} });
    expect(restored.profiles).toEqual(source.profiles);
    expect(restored.volumes).toEqual([{ name: "clone", created_at: "2026-10-02T02:04:06.123456789Z" }]);
    expect(source.instance.name).toBe("source");
  });
  test("classifies transient S3 export errors for retry", () => {
    expect(
      isRetriableS3ExportError(
        "upload failed: - to s3://bucket/key An error occurred (GatewayTimeout) when calling the UploadPart operation"
      )
    ).toBe(true);
    expect(isRetriableS3ExportError("An error occurred (SlowDown) when calling the PutObject operation")).toBe(true);
    expect(isRetriableS3ExportError("An error occurred (InvalidAccessKeyId) when calling the PutObject operation")).toBe(false);
  });

  test("does not export short-lived frequent snapshots as backup chain parents", () => {
    expect(
      chooseLatestExportSnapshot(
        [
          "terrarium/containers/app@autosnap_2026-05-02_12:00:00_hourly",
          "terrarium/containers/app@autosnap_2026-05-02_12:15:00_frequently",
          "terrarium/containers/app@manual-keep",
          "terrarium/containers/other@autosnap_2026-05-02_12:30:00_hourly"
        ],
        "terrarium/containers/app"
      )
    ).toBe("terrarium/containers/app@manual-keep");
  });

  test("exports recursive ZFS replication streams so child rootfs datasets are included", () => {
    expect(zfsReplicationSendCommand("terrarium/containers/app@manual-keep")).toBe("zfs send -R 'terrarium/containers/app@manual-keep'");
    expect(zfsReplicationSendCommand("terrarium/containers/app@manual-keep", "terrarium/containers/app@manual-base")).toBe(
      "zfs send -R -I 'terrarium/containers/app@manual-base' 'terrarium/containers/app@manual-keep'"
    );
  });

  test("forces a full recursive S3 baseline for legacy last-snapshot state", () => {
    expect(planS3SnapshotExport("terrarium/containers/app@s2", "terrarium/containers/app@s1", "", true)).toEqual({
      skip: false,
      parentSnapshot: "",
      full: true
    });
    expect(planS3SnapshotExport("terrarium/containers/app@s2", "terrarium/containers/app@s2", "", true)).toEqual({
      skip: false,
      parentSnapshot: "",
      full: true
    });
  });

  test("uses S3 incremental parents only after recursive state has been recorded", () => {
    expect(planS3SnapshotExport("terrarium/containers/app@s2", "terrarium/containers/app@s1", "zfs-recursive-v1", true)).toEqual({
      skip: false,
      parentSnapshot: "terrarium/containers/app@s1",
      full: false
    });
    expect(planS3SnapshotExport("terrarium/containers/app@s2", "terrarium/containers/app@s2", "zfs-recursive-v1", true)).toEqual({
      skip: true,
      parentSnapshot: "",
      full: false
    });
    expect(planS3SnapshotExport("terrarium/containers/app@s2", "terrarium/containers/app@s1", "zfs-recursive-v1", false)).toEqual({
      skip: false,
      parentSnapshot: "",
      full: true
    });
  });

  test("renames restored LXD metadata and removes generated identity", () => {
    const rewritten = rewriteRecoveredBackupMetadata(
      {
        container: {
          name: "source",
          config: {
            "security.nesting": "true",
            "user.proxy": "https://source.example.com:8080",
            "volatile.eth0.hwaddr": "00:16:3e:53:6a:a5",
            "volatile.uuid": "original-uuid"
          },
          devices: {
            eth0: {
              type: "nic",
              name: "eth0",
              network: "lxdbr0",
              hwaddr: "00:16:3e:53:6a:a5"
            },
            root: {
              type: "disk",
              path: "/",
              pool: "terrarium"
            },
            "terrarium-proxy-http-8080-abcd1234": {
              type: "proxy",
              listen: "tcp:127.0.0.1:18081",
              connect: "tcp:127.0.0.1:8080"
            },
            "manual-host-proxy": {
              type: "proxy",
              listen: "tcp:0.0.0.0:9443",
              connect: "tcp:127.0.0.1:443"
            }
          }
        },
        snapshots: [
          {
            name: "source/snap0",
            config: {
              "user.proxy": "https://source.example.com:8080",
              "volatile.eth0.hwaddr": "00:16:3e:53:6a:a5"
            },
            devices: {
              "terrarium-proxy-http-8080-abcd1234": {
                type: "proxy",
                listen: "tcp:127.0.0.1:18081",
                connect: "tcp:127.0.0.1:8080"
              }
            }
          }
        ]
      },
      "source",
      "restored"
    );

    expect(rewritten.container).toEqual({
      name: "restored",
      config: {
        "security.nesting": "true"
      },
      devices: {
        eth0: {
          type: "nic",
          name: "eth0",
          network: "lxdbr0"
        },
        root: {
          type: "disk",
          path: "/",
          pool: "terrarium"
        }
      }
    });
    expect(rewritten.snapshots).toEqual([
      {
        name: "restored/snap0",
        config: {},
        devices: {}
      }
    ]);
  });
});


describe("backup restore rootfs datasets", () => {
  test("clones a source child rootfs snapshot into the target child dataset", async () => {
    const commands: string[] = [];

    const cloned = await cloneRootfsSnapshotIfPresent(
      "terrarium/containers/source",
      "terrarium/containers/source@manual-keep",
      "terrarium/containers/restored",
      "/var/snap/lxd/common/lxd/storage-pools/terrarium/containers/restored",
      {
        run: async (cmd) => {
          commands.push(cmd.join(" "));
          if (cmd.join(" ") === "zfs list -H -t snapshot terrarium/containers/source/rootfs@manual-keep") {
            return { exitCode: 0, stdout: "terrarium/containers/source/rootfs@manual-keep\n", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: "not found" };
        },
        runRequired: async (cmd) => {
          commands.push(cmd.join(" "));
          return "";
        }
      }
    );

    expect(cloned).toBe(true);
    expect(commands).toEqual([
      "zfs list -H -t snapshot terrarium/containers/source/rootfs@manual-keep",
      "zfs clone -o mountpoint=/var/snap/lxd/common/lxd/storage-pools/terrarium/containers/restored/rootfs terrarium/containers/source/rootfs@manual-keep terrarium/containers/restored/rootfs"
    ]);
    expect(commands.some((cmd) => cmd.includes("rsync"))).toBe(false);
    expect(commands).not.toContain("zfs destroy -r terrarium/containers/restored/rootfs");
  });

  test("leaves legacy flattened local restores to the directory fallback when no rootfs snapshot exists", async () => {
    const commands: string[] = [];

    const cloned = await cloneRootfsSnapshotIfPresent(
      "terrarium/containers/source",
      "terrarium/containers/source@manual-keep",
      "terrarium/containers/restored",
      "/var/snap/lxd/common/lxd/storage-pools/terrarium/containers/restored",
      {
        run: async (cmd) => {
          commands.push(cmd.join(" "));
          return { exitCode: 1, stdout: "", stderr: "not found" };
        },
        runRequired: async (cmd) => {
          commands.push(cmd.join(" "));
          return "";
        }
      }
    );

    expect(cloned).toBe(false);
    expect(commands).toEqual(["zfs list -H -t snapshot terrarium/containers/source/rootfs@manual-keep"]);
  });

  test("mounts an existing recovered child rootfs dataset instead of materializing it", async () => {
    const commands: string[] = [];

    await mountRootfsDatasetForLxdRecover(
      "terrarium/containers/restored/rootfs",
      "/var/snap/lxd/common/lxd/storage-pools/terrarium/containers/restored/rootfs",
      {
        run: async (cmd) => {
          commands.push(cmd.join(" "));
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        runRequired: async (cmd) => {
          commands.push(cmd.join(" "));
          return "";
        },
        directoryHasEntries: () => true
      }
    );

    expect(commands).toEqual([
      "mkdir -p /var/snap/lxd/common/lxd/storage-pools/terrarium/containers/restored/rootfs",
      "zfs unmount terrarium/containers/restored/rootfs",
      "zfs set mountpoint=/var/snap/lxd/common/lxd/storage-pools/terrarium/containers/restored/rootfs terrarium/containers/restored/rootfs",
      "zfs mount terrarium/containers/restored/rootfs"
    ]);
    expect(commands.some((cmd) => cmd.includes("rsync"))).toBe(false);
    expect(commands).not.toContain("zfs destroy -r terrarium/containers/restored/rootfs");
  });

  test("moves legacy flattened rootfs contents only when rootfs is not already populated", () => {
    const mountPath = mkdtempSync(join(tmpdir(), "terrarium-legacy-rootfs-"));
    try {
      writeFileSync(join(mountPath, "backup.yaml"), "container: {}\n");
      mkdirSync(join(mountPath, "etc"));
      writeFileSync(join(mountPath, "etc", "os-release"), "NAME=test\n");

      prepareRootfsDirectoryForLxdRecover(mountPath);

      expect(existsSync(join(mountPath, "backup.yaml"))).toBe(true);
      expect(existsSync(join(mountPath, "rootfs", "etc", "os-release"))).toBe(true);
      expect(readdirSync(join(mountPath, "rootfs"))).toEqual(["etc"]);
    } finally {
      rmSync(mountPath, { recursive: true, force: true });
    }
  });

  test("does not move parent dataset files when rootfs is already populated", () => {
    const mountPath = mkdtempSync(join(tmpdir(), "terrarium-child-rootfs-"));
    try {
      writeFileSync(join(mountPath, "backup.yaml"), "container: {}\n");
      mkdirSync(join(mountPath, "etc"));
      writeFileSync(join(mountPath, "etc", "parent-owned"), "kept in parent\n");
      mkdirSync(join(mountPath, "rootfs"));
      writeFileSync(join(mountPath, "rootfs", "child-owned"), "kept in child\n");

      prepareRootfsDirectoryForLxdRecover(mountPath);

      expect(existsSync(join(mountPath, "etc", "parent-owned"))).toBe(true);
      expect(existsSync(join(mountPath, "rootfs", "child-owned"))).toBe(true);
    } finally {
      rmSync(mountPath, { recursive: true, force: true });
    }
  });
});

describe("backup restore target safety", () => {
  test("rolls back descendant snapshots before the parent container dataset", () => {
    expect(
      rollbackSnapshotsForDatasetTree("terrarium/containers/app@manual-keep", [
        "terrarium/containers/app@manual-keep",
        "terrarium/containers/app/rootfs@manual-keep",
        "terrarium/containers/app/rootfs/nested@manual-keep",
        "terrarium/containers/app/rootfs@other",
        "terrarium/containers/other/rootfs@manual-keep"
      ])
    ).toEqual([
      "terrarium/containers/app/rootfs/nested@manual-keep",
      "terrarium/containers/app/rootfs@manual-keep",
      "terrarium/containers/app@manual-keep"
    ]);
  });

  test("rejects restore-as-new when the target LXD instance already exists", async () => {
    await expect(
      assertNewRestoreTargetIsUnused("victim", "terrarium/containers/victim", async (cmd) => {
        if (cmd.join(" ") === "lxc info victim") {
          return { exitCode: 0, stdout: "Name: victim\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "not found" };
      })
    ).rejects.toThrow("target instance 'victim' already exists");
  });

  test("rejects restore-as-new when the target ZFS dataset already exists", async () => {
    const commands: string[] = [];

    await expect(
      assertNewRestoreTargetIsUnused("victim", "terrarium/containers/victim", async (cmd) => {
        commands.push(cmd.join(" "));
        if (cmd.join(" ") === "zfs list -H terrarium/containers/victim") {
          return { exitCode: 0, stdout: "terrarium/containers/victim\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "not found" };
      })
    ).rejects.toThrow("target dataset 'terrarium/containers/victim' already exists");

    expect(commands).toEqual(["lxc info victim", "zfs list -H terrarium/containers/victim"]);
  });
});
