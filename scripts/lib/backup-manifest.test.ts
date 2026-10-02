import { describe, expect, test } from "bun:test";
import { backupChain, parseBackupManifest, selectBackup, type BackupManifest } from "./backup-manifest";
import { instanceComponents, selectCompleteSnapshot } from "./lxd-storage";

function manifest(snapshot: string, parent: string | null = null): BackupManifest {
  const id = `install/default/app/uuid/${snapshot}`;
  return parseBackupManifest({
    version: 2, id, installation: "install", project: "default", instance: "app", instance_uuid: "uuid",
    instance_type: "virtual-machine", architecture: "x86_64", pool: "terrarium", snapshot,
    created_at: snapshot === "base" ? "2026-10-01T00:00:00Z" : "2026-10-02T00:00:00Z", parent,
    components: instanceComponents("physical/pool", "virtual-machine", "app").map((part, i) => ({ ...part, snapshot: `${part.dataset}@${snapshot}`, guid: String(123 + i), txg: "40", object_key: `prefix/streams-v2/${id}/${part.role}.zfs.zst`, sha256: "a".repeat(64), bytes: 1024 }))
  });
}

describe("complete VM backup sets", () => {
  test("selects the newest atomic pair, skipping missing and mismatched siblings", () => {
    const parts = instanceComponents("tank/lxd", "virtual-machine", "app");
    const rows = [
      "tank/lxd/virtual-machines/app@one 1 10", "tank/lxd/virtual-machines/app.block@one 2 10",
      "tank/lxd/virtual-machines/app@two 3 20", "tank/lxd/virtual-machines/app.block@two 4 21",
      "tank/lxd/virtual-machines/app@three 5 30"
    ].join("\n");
    expect(selectCompleteSnapshot(parts, rows).map((part) => part.guid)).toEqual(["1", "2"]);
    expect(selectCompleteSnapshot(parts, rows, "@two")).toEqual([]);
  });

  test("rejects incomplete manifests before reconstruction", () => {
    const good = manifest("base");
    expect(() => parseBackupManifest({ ...good, components: good.components.slice(0, 1) })).toThrow("Incomplete");
    expect(() => parseBackupManifest({ ...good, components: good.components.map((part, i) => ({ ...part, txg: String(i) })) })).toThrow("different snapshot");
    expect(() => parseBackupManifest({ ...good, instance_type: "mystery" })).toThrow("Unsupported");
    expect(() => parseBackupManifest({ ...good, components: good.components.map((part) => ({ ...part, object_key: "prefix/streams-v2/unrelated.zfs.zst" })) })).toThrow("stream key");
    expect(() => parseBackupManifest({ ...good, components: good.components.map((part) => ({ ...part, dataset: part.dataset.replace("/app", "/victim"), snapshot: part.snapshot.replace("/app", "/victim") })) })).toThrow("does not belong");
  });

  test("matches exact markers and recognizes received pairs using source transactions", () => {
    const parts = instanceComponents("tank", "virtual-machine", "app");
    const rows = "tank/virtual-machines/app@one 1 10 5\ntank/virtual-machines/app.block@one 2 11 5\ntank/virtual-machines/app@one-more 3 20 -\ntank/virtual-machines/app.block@one-more 4 20 -";
    expect(selectCompleteSnapshot(parts, rows, "@one").map((part) => part.guid)).toEqual(["1", "2"]);
  });

  test("requires a full, acyclic chain from one source identity", () => {
    const base = manifest("base");
    const next = manifest("next", base.id);
    expect(backupChain([next, base], next)).toEqual([base, next]);
    expect(() => backupChain([next], next)).toThrow("missing parent");
    expect(() => backupChain([base, base], base)).toThrow("Duplicate");
    expect(() => backupChain([{ ...base, instance_uuid: "different" }, next], next)).toThrow("crosses instance identities");
    expect(() => backupChain([{ ...base, parent: next.id }, next], next)).toThrow();
  });

  test("does not silently select a different incarnation of a reused name", () => {
    const base = manifest("base");
    const other = { ...manifest("next"), instance_uuid: "new-uuid", id: "install/default/app/new-uuid/next" };
    expect(() => selectBackup([base, other], "app")).toThrow("Multiple backup identities");
    expect(selectBackup([base, other], "app", other.id)).toBe(other);
    expect(selectBackup([base, other], "app", "", "uuid")).toBe(base);
  });
});
