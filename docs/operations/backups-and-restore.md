# Backups and restore

Terrarium backs up containers and Linux VMs through local ZFS snapshots, S3 exports, and optional Syncoid replication. These capture disk state, not a VM's running memory. Applications must tolerate crash recovery or arrange their own quiescing/application backups.

## Local restore points

Sanoid retains four 15-minute snapshots, 24 hourly snapshots, 14 daily snapshots, and three monthly snapshots. A VM's metadata filesystem and block volume are sibling datasets. One recursive ZFS snapshot operation captures them in the same transaction; Terrarium skips incomplete or mismatched pairs.

```bash
trm backup list
trm backup restore --instance app
trm backup restore --instance app --at autosnap_2026-10-02_08:00:00_hourly
trm backup restore --instance app --as-new app-recovered
```

Local recovery reconstructs the selected set into separate storage and verifies snapshot identities. In-place recovery then asks for confirmation, gracefully stops the guest, and replaces its disks. Previous disks remain in the reported staging dataset until you verify the result and remove them. Allow enough free space for reconstruction and the retained original. Current LXD configuration is retained for in-place recovery.

A restore-as-new leaves the source intact. Terrarium prepares recovery metadata, opens the native `lxd recover` dialog, and verifies that the selected instance was imported. Select the indicated pool and import the recovered instance. LXD's recovery dialog remains interactive.

Copies lose route labels, static NIC identities, proxies, and host-bound data disks. VM copies boot under an OVN deny-all policy while machine and SSH identities are replaced. Completed cloud-init provisioning is preserved. If identity preparation fails, the copy remains quarantined for inspection. Successful recovery leaves the guest stopped; start it with `lxc start NAME`.

Run a local restore on the cluster member that owns the source datasets. Terrarium discovers the physical ZFS root from LXD; the LXD pool label and ZFS pool name may differ.

## S3 export and recovery

Configure S3 during installation or with `trm set s3`. The hourly service exports complete snapshot sets. You can also run:

```bash
trm backup export
trm backup list
trm backup restore --source s3 --instance app --as-new app-recovered
```

New exports use version 2 manifests. Each records instance type, architecture, installation/project/instance identity, parent manifest, and every component's snapshot GUID, compressed size, and SHA-256 checksum. Streams are uploaded before the manifest is published. A failed component leaves the last successful backup state unchanged. Recursive snapshot holds protect the transfer from Sanoid pruning. Frequent snapshots are excluded from S3 export to avoid using short-lived incremental parents.

A valid retained parent produces an incremental export; a pruned or unavailable parent starts a new full baseline. Deleting an instance and reusing its name creates a separate backup identity. When several identities share a name, use `--at` with the full backup ID printed by `backup list`.

Restore validates the complete parent chain, downloads and verifies each stream, and receives into staging before replacing any live disk. Missing parents, cycles, checksum failures, and incomplete VM sets are errors. Previously written single-dataset container manifests remain readable through the legacy restore path.

The host needs temporary space for a compressed component during export/download and ZFS staging space for full streams and restore reconstruction. Full streams preserve native LXD snapshot history and child filesystems while removing dependencies on cached image origins. S3 service results are shown by `trm status`; inspect `journalctl -u terrarium-s3-backup.service` for failures. The existing instance stays available when reconstruction fails before the replacement step.

## Syncoid replication

Configure a destination with `trm set syncoid`. The hourly service and manual command use the same complete-set controller:

```bash
trm backup replicate
```

Container replicas keep the existing `TARGET_DATASET/INSTANCE` layout. VM replicas use `TARGET_DATASET-virtual-machines/INSTANCE` and `INSTANCE.block`, avoiding collisions with historical container destinations. The controller excludes ingress helpers, holds complete source snapshots, sends existing snapshots without independently creating new ones, and verifies both destination GUIDs before reporting success.

A failed transfer may leave one newer component at the destination. Select a snapshot suffix that exists in both siblings with matching source transaction identity; do not treat one received component as a complete VM backup. Syncoid does not force-delete an unrelated destination history. Resolve a source-identity conflict by retaining the old replica and choosing a fresh destination.

Replica recovery requires both datasets, recovery metadata, and an LXD import before a VM can boot. Replication does not make an unregistered replica immediately runnable.

## Identity provider backups

The local identity provider remains a managed container and uses the same backup machinery:

```bash
trm idp status
trm idp backup
trm idp restore
```

This applies to the configured local provider, including ZITADEL and Logto. An external provider's data is backed up by its operator.
