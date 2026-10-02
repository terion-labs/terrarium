# Native VM implementation and validation

Implemented on `codex/lxd-vm-support`, based on `2cd4abb`. This record distinguishes executed checks from coverage that needs other infrastructure. The agreed feature remains Linux cloud images with full Terrarium integration.

## Implementation

- One CLI for containers and VMs: image/type discovery, VM-capable placement, `vm` and `vm-dev`, resource flags, bounded readiness, provisioning and image-launch option parity.
- Actual LXD instance identity is shared by exec, routing, storage, images, placement and status. Commands explicitly manage the default project.
- Per-member OVN ingress helpers support VM HTTP, TCP and UDP backends. Existing HTTP auth policies apply to the same routes. Helpers and quarantined image/recovery copies are excluded from publication and workload backup jobs.
- VM backups treat metadata and block storage as one snapshot set. Sanoid captures one transaction; S3 verifies and publishes complete manifests; Syncoid transfers and verifies both components. Physical ZFS roots are discovered independently of LXD pool labels.
- Local and S3 recovery stage data before replacement. Previous in-place disks remain available. Restore-as-new resets guest identities under a network quarantine while preserving completed provisioning. Golden images additionally reset cloud-init. Inherited route profiles are detached from sanitized copies while preserving their other settings.
- Directory and CIFS sharing use the guest account's IDs. Conflicting existing mount consumers block remapping. Cluster movement checks eligibility and host-bound devices before graceful shutdown.
- CLI help, completions, status, installer profiles, documentation and CI unit/type checks are updated. `integration:vm` exercises installed hosts using direct SSH or Incus transport.

## Executed environment

Two disposable x86_64 Ubuntu 24.04 VMs on the authorized `note` host, each with nested KVM, four CPUs and 8 GiB RAM. They formed a real two-member LXD cluster with OVN and separate ZFS pools. LXD pool label `terrarium` mapped to physical root `labpool` on each member.

| Component | Tested version |
| --- | --- |
| Host guest kernel | 6.8.0-146-generic |
| LXD | 6.9, snap revision 40916 |
| LXD UI | 6.9-ui-0.22 |
| OpenZFS | 2.2.2 |
| Open vSwitch / OVN | 3.3.9 / 24.03.8 |
| Sanoid / Syncoid | 2.2.0 |
| Traefik | 3.6.7 |
| AWS CLI / S3 fixture | 2.34.41 / Moto 5.1.14 |
| Bun | 1.3.9 |
| Workload guests | Ubuntu cloud images 24.04 and 26.04, x86_64 |

The final two-host run used a compiled Linux binary, not imported command functions. Both Linux x86_64 and arm64 binaries compile.

## Executed checks

- Ubuntu 24.04 raw cloud-init and Ubuntu 26.04 Ansible, variables and Docker Compose. Verified the `terrarium` account, Python environment and opt-in sudo.
- Native LXD UI creation using a cached cloud image, automatic member placement and the `vm` profile. The graphic console displayed the guest login prompt, the terminal executed a command, and native snapshot creation succeeded. Terrarium's CLI discovered the UI-created VM and used its managed guest account without registration.
- HTTP, TCP and UDP reached VM services through both ingress members. A cold cluster move restored HTTP traffic through both members and preserved backup origin identity.
- Directory sharing worked for the guest account. Encrypted CIFS worked across a VM reboot. A container consuming the same mount prevented VM ownership remapping; its existing mount options and access remained intact.
- Full and incremental S3 exports, local restore-as-new, same-host S3 restore and cross-host S3 restore all preserved native LXD snapshot history and booted with the incremental data marker, distinct machine identities and unchanged cloud-init application completion timestamps. Cross-host recovery did not require the source image origin.
- Full and incremental Syncoid replication over SSH verified snapshot GUIDs. The replicated VM booted on the second host with its incremental marker. Its absent external host directory was deliberately detached for the recovery test; that directory is outside the root-volume backup.
- In-place recovery replaced changed data with the chosen restore point and retained the previous datasets. A container recovery regression test against the final shared backup code also booted with its saved marker and retained a native snapshot.
- Golden images launched with VM type inferred, without copied routes. Publishing a VM whose route came from an inherited profile also succeeded after sanitization.
- Corrupted S3 stream data and a missing parent manifest were rejected before stopping or replacing the original running VM.
- A deliberately failing cloud-init run returned a provisioning error. Stopping the guest agent produced a bounded failure and did not execute the requested user command.
- The Ansible backup role resolved `labpool` and rendered the VM Sanoid policy. Managed profiles rendered through Ansible. A second run reported `changed=0`, `failed=0`. Running Sanoid produced matching metadata/block snapshot pairs in the same transaction group.
- Unit/regression suite: 454 passed. Typecheck, docs build and Ansible syntax check passed. CI now explicitly runs unit tests and typechecking.

The reusable run writes evidence to its `--output` directory. Development evidence is under `/tmp/terrarium-vm-e2e-native`, `/tmp/terrarium-vm-e2e-final`, `/tmp/terrarium-vm-ui`, `/tmp/terrarium-vm-validation-evidence`, and the accompanying `/tmp/terrarium-vm-*.log` files on the development machine. The final run resumed after correcting its assertion to accept LXD's short snapshot names; the recovered snapshot was present, and no product code changed between the original and resumed checks.

## Bugs caught by real execution

LXD raw queries reject the global project flag. Received zvols need deactivation before rename to avoid cached device names. LXD must mount recovery filesystems inside its own mount namespace. Guest ACPI shutdown needs completed boot; identity preparation uses the guest's systemd shutdown path. Empty route values do not mask profile labels. Packaged Syncoid lacks newer snapshot-filter options. Full recursive VM streams can depend on an external image origin; full exports now flatten that dependency in temporary storage while preserving properties and native snapshot history.

## Cleanup

Removed both disposable host VMs, their Incus project, the lab bridge, its two firewall rules, the unused cached test image, and the remote lab directory containing fixture credentials and binaries. Closed the browser SSH tunnel and removed its temporary client private key. The original host workload's configuration, devices, profiles, running status and last start time matched the pre-experiment baseline before and after cleanup. Evidence remains on the development machine.

## Coverage limits

The lab exercised x86_64 guest boots on Ubuntu 24.04 hosts. Arm64 and Ubuntu 26.04 host boot certification require corresponding KVM hosts; cross-compilation is not a hardware test. S3 transport used a real AWS CLI against a disposable S3-compatible fixture, without an external cloud account. The lab used private OVN networking rather than the production WireGuard/TLS cluster topology. Browser checks used a temporary client certificate over an SSH tunnel to LXD. External OIDC login and the full installer/update matrix belong to the existing real-infrastructure suite and were not rerun here. VM group-auth routing has a regression test using the unchanged auth compiler.

Windows, ISO workflows, additional data-volume consistency groups, saved-memory recovery and guaranteed live migration are outside the agreed feature scope.
