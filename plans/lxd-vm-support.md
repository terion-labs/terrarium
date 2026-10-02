# Native LXD VM support

Original assessment and agreed implementation contract, updated 2026-10-02. Repository baseline: `2cd4abb`.

The agreed feature covers Linux cloud images with full Terrarium integration. Certify Ubuntu 24.04 and 26.04 guests, since the existing provisioning recipes use Ubuntu packages. Other systemd Linux cloud images can use LXD and raw cloud-init, but should enter the fully tested matrix before receiving the same support claim. Windows, ISO installation, GPU passthrough, nested VMs inside VMs, memory-state backups, and guaranteed live migration are outside this agreed scope.

The implementation is on `codex/lxd-vm-support`. See [the validation record](./lxd-vm-validation.md) for current code and test results. The assessment and design experiments below are retained as the decision record. The assessment used repository code, upstream documentation/source, an OrbStack capability check, and executed experiments in an isolated two-host LXD lab on `note`. VM boot, cross-host ingress, cold movement, directory/CIFS sharing, atomic snapshots, full/incremental reconstruction, and recovery from a Syncoid replica were exercised. See the experiment record at the end for results and limits.

**Release contract:** ship the entire agreed feature together. Every surface and verification requirement below is mandatory. There is no partial release, experimental lifecycle-only release, or follow-up release to finish networking, recovery, mounts, clustering, UI, or documentation. Implementation dependencies describe how to finish the work, not permission to ship an incomplete feature.

**Recommendation:** extend Terrarium's existing instance workflows with LXD's `container` and `virtual-machine` types. Preserve container behavior, profiles, route syntax, and historical backups. The largest work is ingress and recovery, followed by shared mounts and cluster placement. Adding `--vm` alone is a small part of the feature.

## Proposed user contract

```bash
# Existing behavior stays the default.
trm launch ubuntu:24.04 app

# A VM gets the managed vm profile when no profile is supplied.
trm launch ubuntu:24.04 app-vm --vm --cpu 2 --memory 4GiB --disk 40GiB

# Profiles are literal LXD profile names in both CLI and UI.
trm launch ubuntu:24.04 dev-vm --vm --profile vm-dev

# Existing provisioning and publication syntax applies to both types.
trm launch ubuntu:24.04 app-vm --vm --wait \
  --docker-compose ./compose.yml \
  --proxy https://app.example.com:8080@auth:admins

trm exec app-vm
trm image create app-vm app-vm-base
trm image launch app-vm-base app-vm-copy --vm
trm mount attach /srv/shared/data app-vm /mnt/data
trm backup restore --instance app-vm --as-new app-vm-recovered
trm cluster move app-vm node2
```

These commands are implemented on the feature branch. Publishing a release is separate from this working-tree change.

- Keep one command family. Add `--vm` to `launch` and `image launch`; carry it through both `lxc init` and `lxc launch` paths. Resolve the image's type and architecture before selecting a default profile. A local VM golden image must select VM semantics even without `--vm`; reject explicit type mismatches. Ambiguous remote aliases remain containers unless `--vm` is supplied.
- Add `--target MEMBER` for launch and image launch so callers can select a VM-capable cluster member. Use LXD placement when no target is given, with documented eligibility checks and a useful failure if no member can run the requested image.
- Add optional `--wait` and a bounded `--timeout`. Ordinary launch reports that the instance started; `--wait` reports readiness only after the agent and cloud-init finish. Distinguish boot, agent, and provisioning failures. Never rerun a user command after an ambiguous execution failure.
- `exec`, images, backups, mounts, proxy sync, and cluster operations discover the existing instance type. They do not require users to repeat `--vm`.
- Make `--instance` and `--instance-path` the documented mount flags. Keep `--container` and `--container-path` as compatibility aliases, and reject conflicting alias values.
- Use LXD UI and native `lxc` for ordinary start/stop/delete and serial/VGA console recovery. The VM feature does not need a second lifecycle CLI or a libvirt stack.

## Assessment by surface

Paths below are relative to the repository root.

| Surface | Current evidence | Required result |
| --- | --- | --- |
| Launch and images | `scripts/terrariumctl.ts`, `scripts/ctl/launch.ts`, `scripts/ctl/image.ts`: no VM option; the golden-image launch registration also exposes fewer provisioning flags than launch | Shared launch semantics, image type checks, target selection, resources and readiness |
| Installation and profiles | `ansible/roles/lxd/templates/*profile.yml.j2`: container security keys in every baseline; `kvm` passes a character device into containers | Separate usable VM profiles, host capability diagnostics, repeatable install/update/reconfigure |
| Execution and provisioning | `scripts/ctl/exec.ts`: assumes a Unix guest with `su`, `bash`, and a `terrarium` user; launch ends after start | Preserve the user contract; detect guest-agent readiness and cloud-init failure |
| HTTP, TCP, UDP and auth | `scripts/terrarium-traefik-sync.ts`: creates non-NAT proxy devices; instance model lacks type/location; IP fallback picks the first global IPv4 | VM-compatible private backend transport, correct NIC/member selection, unchanged route/auth rules |
| Local snapshots | `ansible/roles/backups/defaults/main.yml` selects only `pool/containers`; Sanoid template uses `recursive = yes` | Complete and consistent VM restore points, with existing retention tiers |
| S3 | `scripts/terrarium-s3-export.ts` skips non-containers; manifest contains one dataset/stream; `scripts/terrarium-zfs-reconstruct.ts` restores one chain | Versioned complete backup sets, incremental streams, old manifest support, recoverable failures |
| Local/S3 recovery | `scripts/ctl/backup.ts` hardcodes container paths, mounts rootfs, rewrites recovery metadata | VM filesystem and block-volume recovery, type-aware metadata, boot verification |
| Syncoid | `ansible/roles/backups/templates/terrarium-syncoid.service.j2` replicates only `pool/containers` | Replicate all components of VM restore points without colliding with existing destinations |
| Shared mounts | `scripts/ctl/mount.ts` always resolves an unprivileged container idmap and may remount CIFS with new ownership | VM directory sharing and guest ownership checks without disturbing existing consumers |
| Clustering | `scripts/ctl/cluster.ts` keeps name/status/location but drops type/architecture; placement counts workloads; join cleanup hardcodes profile names | Reject incompatible destinations before stopping a VM; move all storage and reconcile routes |
| Management/status | LXD UI already installed; `scripts/ctl/status.ts` reports service activity | VM profiles and console work through existing auth; report capability and backup failures accurately |
| Docs/completion/CI | Public docs and agent guide describe containers; completion lists are maintained separately; integration provisioning is Hetzner-specific | Document both types consistently and run VM tests on verified KVM-capable infrastructure |

The local identity provider is intentionally a managed container. Its container-specific runtime and backup commands should remain explicit rather than being mechanically renamed or moved into a VM.

## Design decisions

### 1. Use LXD as the source of instance identity

Introduce a small `scripts/lib/lxd-instance.ts` module used by launch, ingress, backup, mounts, and cluster operations. Parse LXD responses once into an explicit instance type, project, name, architecture, location, expanded config/devices, and status. Query additional state only when an operation needs it. Keep command execution in the existing modules.

Do not infer type from a profile name or store a second authoritative VM flag in Terrarium config. Fail on an unknown live instance type. Legacy backup manifests may default to container only through their documented legacy decoder.

Make the project's current default-project scope explicit when invoking LXD. Scope keys for new persisted artifacts to installation/project/instance identity so different hosts sharing an S3 prefix cannot overwrite each other. Multi-project management remains separate from this feature; report out-of-scope instances rather than accidentally managing them.

Add a focused `scripts/lib/lxd-storage.ts` boundary for mapping an instance root volume to its physical backup components. This is shared knowledge needed by listing, export, recovery, and replication. It must inspect the configured LXD pool and actual ZFS layout, not assume the pool label equals its physical ZFS source. No provider framework or generic hypervisor interface is needed.

### 2. Host capability and profiles

Use the LXD server's advertised instance types and architecture as the primary VM capability check, supplemented by `/dev/kvm` diagnostics. Check each relevant cluster member. Lack of virtualization should leave a container-only host healthy and produce an actionable VM-launch error. Do not require nested virtualization for ordinary Terrarium installation.

LXD requires hardware virtualization for VMs. Use the packaged LXD runtime rather than installing a second hypervisor manager. Record the tested snap revision, API extensions, QEMU and ZFS versions in integration artifacts; `latest/stable` in the current defaults is not a reproducible test target. [LXD requirements](https://canonical.com/lxd/docs/latest/requirements/), [capability inspection](https://documentation.ubuntu.com/lxd/default/tutorial/first_steps/).

Create two complete profiles usable directly in the LXD UI:

| Profile | Intended behavior |
| --- | --- |
| `vm` | OVN NIC, ZFS root disk, locked `terrarium` user, Python environment, no passwordless sudo |
| `vm-dev` | Same VM baseline, with explicit passwordless sudo for `terrarium` |

Keep existing `default`, `terrarium`, `strict`, `dev`, and container `kvm` meanings. Do not put container idmaps, syscall interception, nesting, or the `kvm` unix-character device into VM profiles. Reject known incompatible profile combinations before creation. Custom profiles remain literal and are validated by LXD.

Proposed VM defaults are 2 vCPUs, 2 GiB memory, and a 20 GiB root disk, overridable with existing resource flags. These passed the Ubuntu 24.04 lab; Ubuntu 26.04 remains a required certification case. Leave Secure Boot at LXD's supported default.

Keep account/sudo setup in profile vendor-data so generated or explicit user-data does not erase it. The current `dev` profile puts sudo setup in user-data, which launch can replace; add a regression case while implementing the equivalent VM behavior. Share a small cloud-init template fragment only where it removes actual repeated policy.

Install/update/reconfigure and cluster join must all know the same managed profile inventory, including the infrastructure-only ingress helper profile. VM profiles may exist cluster-wide even when some members cannot boot VMs; readiness is a member capability, not a profile-presence test. Updates must not change the type or profile of an existing workload.

### 3. Provisioning, exec, and golden images

Continue using the existing generated cloud-init for requirements, roles, playbooks, Git assets, variables, Docker Compose, and explicit user-data. Preserve secret delivery through stdin. Test every option through VM `init`, not just plain `launch`.

Official LXD VM images load the guest agent; command execution, file transfer, and detailed guest information depend on it. Managed guests need systemd, cloud-init, and the existing Unix user tools. Wait for the agent separately from process-running status, and offer a native console command when the agent cannot be reached. [LXD guest-agent behavior](https://canonical.com/lxd/docs/latest/howto/instances_create/#install-the-lxd-agent-into-virtual-machine-instances).

Reuse LXD snapshot/copy/publish for golden images, which already operate on instance types. The lab published and booted a VM image, and launch without `--vm` correctly inferred its type. Native publish/relaunch did **not** reset the guest machine ID. Sanitize a temporary copy before publication, including a tested guest identity/SSH-key reset; preserve the source. Clear route labels, managed ingress allocations, conflicting static addresses, and local host devices, while retaining required VM boot metadata. For golden-image preparation, `cloud-init clean --machine-id` is a supported guest primitive, but its provisioning/cache semantics must be tested on the temporary copy. Define `--live` as copying current disk state, not capturing RAM, and document its consistency limits.

Give `image launch` the same provisioning/resource/readiness options as `launch`. Avoid a second cloud-init implementation.

### 4. Ingress uses LXD proxies through a managed helper container

The existing `ensureLxdProxyDevice()` creates `bind=host` proxy devices without `nat=true`, with host-loopback listeners. LXD supports this mode for containers; VM proxy devices require NAT mode, static NIC addresses, and a host that acts as the instance gateway. Terrarium's managed workloads use OVN, so simply adding `nat=true` is not a supported design. [LXD proxy restrictions](https://canonical.com/lxd/docs/latest/reference/devices_proxy/).

**Selected transport:** one small managed container attached to OVN on each ingress host. Attach ordinary non-NAT LXD proxy devices to that helper, with `listen=tcp:127.0.0.1:PORT` (or UDP) and `connect=tcp:VM_OVN_IP:PORT`. LXD connects from the helper's network namespace to the VM. The helper runs no custom relay daemon; LXD owns the proxy processes. Traefik keeps its existing loopback backend contract.

This passed HTTP, TCP, and UDP from both lab members, after OVN gateway relocation, and after moving the VM to the other member. The experiment used Ubuntu helper containers limited to one CPU and 256 MiB; production should pin a suitable image and certify the chosen limits.

Reject external OVN forwards for the current topology. The experiment configured a private allowed range in uplink `ipv4.routes`; the resulting link route could not reach its forwards. Adding a route through the OVN gateway made all three protocols work only on the active gateway member. The other member's separate `lxdbr0` could not resolve that gateway. Moving the gateway reversed which member worked. Fixing this requires shared uplinks or gateway-aware routing/failover machinery that the helper design avoids. [LXD network forwards](https://canonical.com/lxd/docs/latest/howto/network_forwards/), [OVN router placement](https://canonical.com/lxd/docs/latest/reference/network_ovn/).

LXD 6.9 also rejected forward creation with Terrarium's `ipv6.address=none` uplink setting (`invalid CIDR address: none/32`). Unsetting that key allowed the experiment to proceed without assigning an IPv6 address. This was a lab workaround, not a proposed production networking change. The selected helper transport does not need network forwards or that workaround.

Manage helpers as infrastructure: deterministic member-scoped identity and ownership labels, a dedicated profile, autostart, health reporting, and idempotent creation/recovery. Create them on ingress members even if a member cannot run VMs. Exclude helpers from workload placement, ordinary image workflows, and user backup catalogs. Include their lifecycle in install/update/reconfigure/join and member removal. Reject name collisions with unrelated instances. Keep helpers on their assigned member; fail their VM routes visibly if unavailable.

Regardless of transport, the implementation must:

- Separate route parsing/auth from backend resolution, retaining HTTP/HTTPS, wildcard/path routing, TCP, UDP, and existing `user.proxy` syntax.
- Match the configured managed NIC using LXD devices/leases and observed state. Do not choose a Docker bridge or assume the guest calls its NIC `eth0`.
- Distinguish a stopped/booting guest from malformed routing configuration. Skip or withdraw its backend predictably, report the reason, and continue reconciling unrelated healthy routes. Never reuse an old address after reassignment to another instance.
- Keep UFW and OVN ACL behavior consistent with private defaults. Probe for direct public/backend access that could bypass HTTP auth; TCP/UDP keep their current protocol semantics.
- Preserve known-good config on discovery failure and avoid publishing a VM route without a usable backend. Reconcile cleanup on label removal, deletion, restore, image cloning, and movement.
- Each host owns its helper and proxy devices, using the existing local reconciliation lock. Include instance identity in device ownership, allocate ports against all local managed listeners, and remove stale devices. There is no cluster-wide forward allocation to coordinate.
- Keep existing container proxy devices working. Change container transport only if necessary for this design; any such migration and its compatibility tests must be complete in the same release.

### 5. Backups are complete instance sets

Extend the existing ZFS/Sanoid/Syncoid/S3 model to preserve incremental backups and retention behavior. Do not implement VM restore by changing `containers/` to `virtual-machines/`.

The tested LXD 6.9 layout is `labpool/virtual-machines/NAME` (filesystem) and `labpool/virtual-machines/NAME.block` (zvol). These are siblings, not a rootfs tree. The LXD pool label was `terrarium`, while its physical ZFS source was `labpool`, confirming that the two names cannot be assumed equal. Keep layout discovery isolated and version-tested. [LXD dataset naming](https://github.com/canonical/lxd/blob/main/lxd/storage/drivers/driver_zfs_utils.go), [LXD VM volume operations](https://github.com/canonical/lxd/blob/main/lxd/storage/drivers/driver_zfs_volumes.go).

Use a restore-point record containing type, origin identity, pool/storage metadata, capture time, consistency level, and all required components. A VM restore point is valid only when both disk and companion filesystem are present at the same capture boundary. Preserve the matching LXD recovery metadata and profile/network dependencies, and detect configuration changes during capture rather than pairing an old disk snapshot with current metadata.

For automatic VM snapshots, add a dedicated VM-root Sanoid stanza with `recursive = zfs` and `process_children_only = no`. Sanoid 2.2.0 captured the parent, companion filesystem, and block volume at the same `createtxg`; pruning removed an expired marker from all three while preserving the current set. Pruning removes components separately, so holds and complete-set validation remain necessary. Keep existing container policy intact. `recursive = yes` snapshots descendants independently and is unsuitable for the VM pair. [Sanoid configuration](https://github.com/jimsalterjrs/sanoid/blob/master/sanoid.conf), [OpenZFS snapshot semantics](https://openzfs.github.io/openzfs-docs/Basic%20Concepts/Datasets/Snapshots%20and%20Clones.html).

Record running-guest captures as crash-consistent disk backups. Do not claim application consistency or memory-state recovery. Use a stopped guest for a reproducible recovery test; if future quiescing is added, it requires bounded freeze/thaw handling. Hold selected snapshots during export/replication and release holds on every completion path.

S3 changes:

- Add a versioned manifest format describing a component set with filesystem/block kind, snapshot identity/GUID, parent, stream key, and integrity metadata. Scope new catalogs to a stable backup origin and instance identity, independent of cluster member location.
- Upload every component successfully before publishing the manifest and advancing the checkpoint. A partial set must never appear as a valid restore point. If an incremental base is missing, create a complete new full set.
- Validate manifest versions, complete parent chains, cycles, identity/type mismatches, and target pool mapping before modifying storage. Constrain manifest-derived names to the intended pool and instance.
- Keep the current manifest reader and old object keys usable for containers. New-format writers must not corrupt an old checkpoint. Historical backups must remain selectable after the source instance is deleted or its name is reused.
- Only export storage owned by the local member; `lxc list` can contain remote instances. Persist cluster-stable backup identity so moving a VM continues its history without two members uploading it concurrently.

Recovery changes:

- Resolve source type from backup metadata, including when there is no surviving LXD instance. Check name collisions against both instance types and every destination component.
- Preflight the entire recovery before stopping a workload. For S3, reconstruct into staging datasets and validate the full set before replacing in-place storage. Retain an explicit rollback path until the recovered guest is verified; avoid destroying the only current copy before a download succeeds.
- Give VM recovery its own concrete filesystem/block preparation path. Never mount a zvol as a container rootfs, move its files into `rootfs/`, or recursively rewrite arbitrary metadata strings. Decode the installed LXD recovery-metadata version explicitly; LXD 6.9 writes version 2 with `instance`, `pools`, `profiles`, and `volumes`. Preserve RFC3339 timestamp strings and precision. Generic YAML timestamp coercion broke the tested recovery.
- Prefer native LXD copy/restore when restoring an LXD-registered snapshot. Raw Sanoid recovery uses the verified storage adapter and the existing `lxd recover` handoff where needed. Report clearly that the handoff is interactive; do not claim unattended import.
- Restore-as-new must clear published routes and conflicting identities while preserving boot configuration, disks, and firmware metadata. The replica experiment booted after changing the instance/volume names and selectively removing UUID, vsock, MAC, host-interface and cloud-init identity fields; bus-placement fields were retained. New LXD UUID/MAC/IP did **not** reset the guest's `/etc/machine-id`. Implement and test a separate guest identity step, with network access withheld until identity is safe. Preserve completed application provisioning rather than unexpectedly rerunning old user-data. Boot, readiness, distinct identity, and a known data marker are the completion test.
- Exclude external CIFS/NFS shares and unrelated attached custom volumes from an instance-root backup claim. Show those exclusions when present. Additional-volume backup is a separately specified consistency group, not an implicit promise.

Use `syncoid --recursive --no-sync-snap` for the VM replication job: the experiment preserved both components' snapshot GUIDs and a guest recovered from that replica booted with the incremental data marker. Retain matched markers across interrupted runs and hold the selected pair during transfer; successful replication alone does not establish completeness. Preserve the current container destination mapping. Add an explicitly separate VM destination, with collision validation, rather than changing an existing target into a new common root while `--force-delete` is enabled. The experiment replicated locally; transport over SSH and interruption handling remain release tests.

Raw Sanoid restore points are not automatically LXD UI snapshots. Document the distinction and show both kinds accurately in `trm backup list`; keep native LXD snapshots usable through the UI. Cockpit's ZFS view remains a dataset view, not proof that a complete VM backup is recoverable.

The identity probe provides a concrete primitive: on the disposable clone, regenerate `/etc/machine-id` and the D-Bus link using `systemd-machine-id-setup`, regenerate SSH host keys, and reboot. The new machine ID matched the new VM UUID; the guest's cloud-init instance ID and completed-module semaphore timestamps stayed unchanged. An OVN NIC ACL blocked the three tested application protocols while the guest agent remained usable. Do not use the unimplemented `connected=false` NIC option: this LXD/OVN combination rejected it. Production recovery must apply quarantine before first boot, preserve any existing ACL policy, and release it only after identity/readiness checks. ACL changes require bounded dataplane convergence checks: the first HTTP attempt after removal timed out, then all protocols passed from both members. The lab tested these primitives, not the complete transactional workflow.

Retain the existing incremental S3 model using the verified component-set design. Native LXD export/import remains available as an independent user operation; it is not a replacement for Terrarium's incremental backup contract. [Native LXD backup formats](https://canonical.com/lxd/docs/latest/howto/instances_backup/).

### 6. Shared mounts and cluster movement

Branch mount handling on the actual instance type before looking up idmaps. VM directory shares use LXD's virtiofs/9p path and guest support, not unprivileged-container ownership translation. VM host-side IDs pass through rather than being shifted as container IDs are. [LXD disk devices](https://canonical.com/lxd/docs/latest/reference/devices_disk/).

For managed CIFS, track or discover existing attachments before changing ownership. Do not remount a share with VM-oriented IDs while a container relies on its old IDs. Reject incompatible reuse and explain how to create a separate managed host mount with suitable ownership. Test root and `terrarium` access, reboot persistence, unsupported guest filesystem support, and mount failure before success is printed.

Carry type, architecture, and expanded device constraints into cluster move planning. Before stopping any workload, check every destination for VM capability, compatible architecture, usable storage/network/profiles, and required host paths/devices. A host path existing does not prove its contents are the same shared storage; require an explicit verified mapping or block automatic placement for that attachment.

The feature includes a tested cold move. Preserve the prior running state, report partial failures, keep data on the source when movement fails, and reconcile ingress and backup ownership after completion. Evacuation remains LXD-managed, with its own compatibility checks and documented limits. Include VM profiles in join cleanup and cluster reconciliation. Do not advertise zero downtime based on LXD merely exposing live migration.

### 7. Management, compatibility, and documentation

- Extend `trm status` with LXD VM capability and an actionable reason when unavailable, plus last backup/export failure where available. For instance diagnostics, distinguish running, agent-ready, and provisioned. Avoid an unbounded agent probe for every instance in ordinary host status.
- Exercise LXD UI creation with the VM type, a VM image, and `vm`/`vm-dev` replacing the container default. Verify serial/VGA console, exec, snapshots, and device editing through Terrarium's existing HTTPS/OIDC path. VM instances created in the UI must be discovered by routing and backups without a CLI-only registration step.
- Keep Cockpit for host/ZFS operations and LXD UI for both instance types. Update UI names and links in documentation; a new cockpit-machines/libvirt installation is unnecessary.
- Update command help, examples, bash/zsh/fish completions, installer completion output, and image-launch option parity together. Preserve existing state filenames and service names unless a versioned migration is necessary.
- Update `README.md`, `docs/index.md`, `docs/about.md`, `docs/architecture.md`, `docs/security.md`, getting-started installation/first-instance/templating/storage/shared-storage/management guides, operations backups/images/clustering/reconfiguration, CLI/services references, applicable app guides, provider guidance, `docs/.vitepress/config.mts`, `docs/public/agents.md`, and `docs/public/llms.txt`. `docs/agents.md` includes the public guide, so edit the source once.
- Provider guidance must describe checking actual virtualization capability. Do not promise nested KVM solely from a provider or plan name. Keep screenshots and examples consistent with the certified image matrix.
- Explain guest-kernel isolation, VM memory/disk costs, Docker running inside a VM without container nesting flags, agent requirements, backup consistency, and cold-move behavior. Restrict claims to demonstrated behavior.

## Simplification choices

These choices guided the implementation. The notes below record the original assessment.

- **S1, recommended:** keep native LXD lifecycle and image operations in `imageCreateCmd()` and `moveWorkload()`; avoid adding a VM provider interface, libvirt integration, or another management UI.
- **S2:** share parsed LXD identity across proxy sync, `backupActionCmd()`, `mountAttachCmd()`, and cluster discovery; remove repeated guesses from names, profiles, and missing type fields.
- **S3:** isolate physical backup-component discovery in one storage module; remove scattered hardcoded container paths from new export/list/restore logic while retaining the legacy decoder.
- **S4:** keep `--profile` literal and add two complete VM profiles; avoid a hidden profile-name translation layer or changing existing defaults during upgrade.
- **S5, selected by experiment:** have `ensureLxdProxyDevice()` target a per-member OVN helper for VM routes; retain LXD-owned loopback proxies. This removes the proposed private-forward allocator, gateway-route tracking, and custom relay daemon. Container routes keep their current devices.

## Complete feature acceptance

Every row must be satisfied before shipping. These are parts of one feature, not separate deliveries.

| Required area | Work | Acceptance evidence |
| --- | --- | --- |
| Verified architecture | KVM host/pair; captured LXD/ZFS versions; VM boot, OVN ingress, backup-set recovery, CIFS sharing experiments | Same/cross-member private HTTP/TCP/UDP works; complete recovered VM boots with expected data; ingress transport and backup strategy settled |
| Shared instance contract | Parsed instance model, host capability checks, storage discovery, managed profile inventory; characterize existing behavior | Container behavior preserved; missing/unknown types fail explicitly; mixed member capabilities covered |
| Lifecycle and provisioning | VM profiles; launch/image-launch flags; cloud-init, readiness, exec and golden-image parity; help/completion | CLI- and UI-created guests boot, provision, execute, and relaunch from a golden image |
| Ingress | Chosen transport; typed backend resolution; auth/firewall/cleanup; safe stopped-instance handling | HTTPS/auth allow/deny, wildcard/path routes, TCP/UDP, boot delay, deletion and movement pass without route regressions |
| Full recovery | Atomic VM snapshots, v2 manifests, S3 sets, staging recovery, Syncoid VM target, historical reads | Local/S3/replica restores boot; in-place and as-new work; incomplete sets cannot overwrite a valid target |
| Operational parity | VM mount path, compatible placement/moves, status, update/reconfigure/join behavior | Mixed containers/VMs and incompatible hosts/mounts produce correct outcomes before mutation |
| Certification and documentation | Dedicated VM integration lane; UI checks; docs and agent-guide updates; release checklist | All promised behavior passes against the certified host/guest/LXD matrix |

Build against the measured ingress and paired-storage decisions below. Guest identity handling, failure paths, and full product integration remain mandatory work. Reviewable commits can separate internal changes, but do not change the single complete-release requirement.

## Verification matrix

Use behavior tests and executed integration paths. Many existing Ansible tests assert source strings; extend those only for structural checks, not as evidence that a VM boots or restores.

| Area | Required cases |
| --- | --- |
| Compatibility | Existing container launch/exec/profiles/routes/images/backups; old S3 manifests; repeated update/reconfigure; mixed instances; no-KVM host remains operational |
| Launch/provisioning | Plain and generated-cloud-init VM creation; raw cloud-init; all resource flags; image mismatch; custom/invalid profiles; target capability; agent delay/missing agent; cloud-init failure; timeout; no secret leakage |
| Ingress | HTTP/HTTPS plus auth allow/deny and redirects; TCP/UDP; correct NIC with Docker bridges present; stopped/missing guest; lease changes; duplicate routes; external bypass probes; another healthy route still reconciles |
| Backup/recovery | Paired snapshots at one boundary; no partial manifests; full plus incremental chain; missing parent/component; corruption; retry interruption; expired base; wrong origin/type; name reuse; unknown version; source deleted; fresh-host recovery with missing profile/network dependencies; local/S3/as-new/in-place and Syncoid boot/data verification |
| Mounts | VM directory/CIFS access as the normal user; reboot; bad ownership; existing container consumer; no idmap calls for VMs; missing guest support; conflicting reuse leaves original mount intact |
| Cluster | Two VM-capable members; container-only destination; different architecture; insufficient resources; missing/local-only mount; stopped/running cold moves; source retained on failure; route and backup ownership reconcile; concurrent controllers do not race |
| UI and operation | VM creation with managed profile; OIDC login; console WebSocket path; exec; snapshots; golden images; manually created VM discovery; service and backup diagnostics |

Keep the existing Hetzner container suite. Add a VM test lane backed by explicitly verified KVM-capable hosts, with two hosts for cluster certification. The current harness assumes Hetzner credentials and provider creation; add a narrow existing-host inventory adapter or dedicated runner path so VM coverage does not depend on unproven nested virtualization. Required VM jobs must fail when capability is missing rather than pass with all cases skipped. Reuse the existing cleanup manifest, logs, and artifact collection; do not duplicate the whole harness.

Run unit tests, `bun run typecheck`, binary build, docs build, and Ansible syntax checks. Add explicit unit/typecheck CI steps where absent. Boot certification should cover Ubuntu 24.04/26.04 hosts and guests on each architecture that the release claims to support, with selected expensive cross-member/S3 cases rather than an unnecessary full Cartesian product.

## Completion criteria and remaining uncertainty

Support is complete when a user can create a VM through either CLI or LXD UI, provision and publish it with the same Terrarium conventions, attach supported shared storage, create/reuse its image, recover it from every advertised backup source, and cold-move it between eligible members. Existing containers and their historical recovery paths must continue to work.

The `note` experiments settle the basic ingress transport, installed storage layout, paired-stream recovery, Sanoid settings, and usable KVM lab infrastructure. Remaining uncertainties concern safe guest identity handling and production failure behavior, not product scope. The original design lab did not certify Terrarium's then-unimplemented VM integration, authenticated UI/Traefik path, S3 transport, SSH replication, interruption safety, or the full OS/architecture matrix. Current implementation checks are recorded separately in [validation](./lxd-vm-validation.md).

## OrbStack experiment feasibility, 2026-10-02

Checked the installed environment directly, as requested:

| Item | Observed result |
| --- | --- |
| Mac | Apple M4 Max, macOS 27.0, build `26A428` |
| OrbStack | `2.2.3 (2020300)`, commit `c83556b0ef8f1ba9a33abbb194622b6b7a1c0307` |
| Inspected machine | Existing running `ubuntu`, Ubuntu 25.10, arm64 |
| Linux kernel | `7.0.14-orbstack-00380-ga7e0a2dc9535` |
| KVM device | `/dev/kvm` absent; no KVM device registered in `/sys/class/misc/kvm` or `/proc/misc` |
| Kernel diagnostic | `kvm [1]: HYP mode not available` |
| ZFS | `/dev/zfs` and `/sys/module/zfs` absent |

Reproduction commands:

```bash
orbctl version
orbctl list
orb -m ubuntu -u root uname -a
orb -m ubuntu -u root ls -l /dev/kvm
orb -m ubuntu -u root bash -lc 'dmesg | grep -i "HYP mode"'
```

**Result:** this OrbStack environment cannot run the required hardware-accelerated LXD VM boot and boot-after-recovery experiments. The kernel diagnostic establishes that the missing device is not just a Unix permission issue. Installing LXD or changing the Ubuntu release inside OrbStack cannot supply the missing guest hypervisor mode. OrbStack machines share its Linux kernel. [OrbStack architecture](https://docs.orbstack.dev/architecture).

OrbStack's current nested-virtualization documentation also lists nested KVM as unsupported on Apple Silicon, though its explanation attributing that to Apple is dated; the local kernel result is the decisive evidence for this installation. [OrbStack nested virtualization](https://docs.orbstack.dev/machines/#nested-virtualization).

A container-only OVN test would not validate VM ingress, guest-agent behavior, VM storage layout, or recovered VM boot. Those experiments were subsequently run on `note`, as recorded below. Existing OrbStack machines were not modified, and no packages or replacement virtualization software were installed there.

## Executed lab on `note`, 2026-10-02

The user authorized experiments over `ssh root@note`. Runs occurred on October 2 in Europe/Kyiv (October 1, 21:18–21:39 UTC in the logs). No Terrarium production implementation was changed.

### Environment and isolation

| Layer | Observed configuration |
| --- | --- |
| Physical host | Ubuntu 24.04.5, x86_64, kernel `7.0.0-31-generic`, usable `/dev/kvm`, Intel nested virtualization enabled |
| Existing workload | Incus container `browsercity-runner`; not used or modified by the experiments |
| Outer isolation | Incus 6.0.6 project `trm-vm-lab-20261002`, bridge `trmlabbr0`, two disposable Ubuntu 24.04 VMs |
| LXD hosts | `node1` and `node2`, each 4 vCPUs / 6 GiB / 45 GiB root; kernel `6.8.0-146-generic` |
| Actual VM manager under test | LXD `6.9-bf243da`, snap revision `40916`, QEMU `10.2.1` |
| Storage | ZFS `2.2.2-0ubuntu9.5`; separate 32 GiB sparse-file pools; LXD label `terrarium`, ZFS source `labpool` |
| Network | Open vSwitch `3.3.9`, OVN `24.03.8`; two-member LXD cluster; local `lxdbr0` on each host, OVN workload network |
| Backup tools | Sanoid/Syncoid `2.2.0` |
| Inner guest | Official `ubuntu:24.04` VM, image serial `20260926`, 2 vCPUs / 2 GiB / 20 GiB disk, stock Secure Boot settings |

The lab used plain OVN database connections on its private underlay; it did not install Terrarium's WireGuard, TLS, Traefik, OIDC, or UI stack. Incus supplied outer isolation only: the tested inner VMs, networks, moves, images, and recovery all used LXD.

Docker's host forwarding policy initially blocked the new bridge. Two temporary `DOCKER-USER` rules allowed traffic from `trmlabbr0` and established replies to it. No global firewall policy or pre-existing workload rule was changed.

### Results

| Experiment | Measured result | Design consequence |
| --- | --- | --- |
| VM boot and provisioning | Guest agent, cloud-init, `terrarium` account, and `exec` worked | Existing cloud-init/user conventions are usable with VM-specific profiles |
| Existing proxy style attached directly to VM | Rejected: `Only NAT mode is supported for proxies on VM instances` | VM routes need a different attachment point |
| OVN forward with production IPv4-only uplink | LXD rejected `none/32`; unsetting `ipv6.address` let creation succeed | Record upstream compatibility issue; do not make this workaround part of VM support |
| Forward through local uplinks | Automatic link route failed on both hosts; explicit route via OVN gateway worked only on its active member | Reject forwards without a broader routing redesign |
| Gateway relocation | Moving active chassis reversed the working member | The failure is tied to uplink topology, not guest location |
| Helper container proxies | HTTP/TCP/UDP passed on both hosts, through gateway relocation and VM movement | Select native LXD proxies attached to one helper per ingress member |
| Original uplink settings restored | All three helper protocols passed on both hosts with `ipv6.address=none` and no forward/range | Selected transport works without the forward workaround |
| Listener exposure | `ss` showed loopback-only TCP/UDP listeners; the outer host could not connect to either member's underlay address on port 18080 | Preserves private host-side backend binding; full Terrarium firewall/auth tests still required |
| Directory and CIFS sharing | LXD exposed both as virtiofs; UID/GID 1001 could write/read; markers survived reboot | VM ownership must use guest numeric IDs, without container idmap translation |
| Cold move | VM moved from `node1` to `node2`, booted, and retained marker/address; both hosts' proxies still worked | Native LXD cold movement is usable |
| VM ZFS layout | Filesystem `virtual-machines/vm1` plus sibling zvol `virtual-machines/vm1.block` | Back up and recover a pair |
| Atomic Sanoid capture | Parent/filesystem/zvol shared `createtxg=169` | Use `recursive=zfs`, `process_children_only=no` |
| Sanoid pruning | Expired marker removed from all three; current marker retained with common transaction ID | Configuration works; separately pruned components still need holds and completeness checks |
| Full/incremental reconstruction | Sent both components, received into staging, verified matching GUIDs, removed disposable source, imported via `lxd recover`, booted | Raw paired-stream recovery is viable; returned `incremental` marker and active guest service |
| Syncoid replica recovery | `--recursive --no-sync-snap` preserved GUIDs; cloned both replicated components, renamed metadata, imported and booted `vm-replica` | Existing incremental replication model can support VMs |
| Native recovery metadata | Version 2 YAML; generic YAML timestamp rewriting caused import failure, RFC3339 preservation repaired it | Use a versioned, field-aware metadata adapter |
| Restored clone identity | Fresh LXD UUID/MAC/IP; guest machine ID still duplicated | LXD metadata cleanup alone is insufficient |
| Golden image | Snapshot → publish → launch on other member succeeded; no `--vm` needed for local VM image; account/data retained | Use native image operations and infer type; sanitize guest identity explicitly |
| Guest identity reset | Fresh machine ID and SSH host keys survived reboot; cloud-init instance ID and completed-module timestamps unchanged | A narrow guest identity step can avoid a blanket provisioning reset |
| Quarantine | OVN ACL blocked HTTP/TCP/UDP while agent commands worked; protocols returned after removal/convergence | Use tested ACL isolation, not unsupported NIC `connected=false` |

The full block stream was about 1.9 GiB; its incremental stream was about 13 MiB. The companion filesystem streams were about 16 MiB and 184 KiB. These are measurements from a small lab guest, not capacity estimates. The CIFS test used a Samba share and CIFS mount inside one lab host; it validates sharing/ownership/reboot behavior, not production SMB credentials or concurrent container consumers.

One shutdown requested just after agent readiness stalled; powering off through the guest completed it. Later stops after cloud-init completion and the cold move succeeded. This does not establish an upstream cause. Use bounded waits and keep boot/agent/provisioning/shutdown states distinct.

### Reproduction anchors and evidence

Representative tested commands, with the names used in this disposable lab:

```bash
# Proxy process connects from the helper container's OVN namespace.
lxc config device add relay-node1 http proxy \
  listen=tcp:127.0.0.1:18080 connect=tcp:10.251.0.2:8080 bind=host

# Atomic pair boundary and separate full/incremental component streams.
zfs snapshot -r labpool/virtual-machines@lab-full
zfs send -R labpool/virtual-machines/vm1@lab-full > full.zfs
zfs send -R labpool/virtual-machines/vm1.block@lab-full > full.block.zfs
zfs send -R -I labpool/virtual-machines/vm1@lab-full \
  labpool/virtual-machines/vm1@lab-incremental > incremental.zfs
zfs send -R -I labpool/virtual-machines/vm1.block@lab-full \
  labpool/virtual-machines/vm1.block@lab-incremental > incremental.block.zfs

syncoid --recursive --no-sync-snap \
  labpool/virtual-machines labpool/replica/virtual-machines
```

Scripts, setup logs, baseline inventory, and compressed per-node result logs are retained on `note` under `/root/terrarium-vm-lab-20261002/` (root-only). `node1-results.tar.gz` contains ingress, mounts, identity, pruning, and version evidence; `node2-results.tar.gz` contains capture, stream reconstruction, replica recovery, and image evidence. Failed attempts are retained alongside corrected runs. No join token is needed to replay the experiments; create a new one for a new lab.

Cleanup completed: both outer VMs and all nested resources, the lab image reference, project, bridge, temporary firewall rules, and consumed join token were removed. The original `browsercity-runner` status, type, configuration, devices, and profiles matched the saved baseline exactly. The existing `work` pool and `runnerbr0` remain in place. `cleanup-verification.txt` records the checks; only the root-only evidence directory remains from the lab on `note`.

These are architecture experiments, not release certification. S3 upload/download, remote Syncoid over SSH, fault injection, full guest/application consistency, Ubuntu 26.04, arm64, managed UI creation/console, HTTPS/OIDC authorization, installer upgrades, and the production helper lifecycle still require implementation and the release checks above. None is deferred to another release.
