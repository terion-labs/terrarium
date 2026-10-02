# VM integration on existing hosts

Run this suite against two disposable, installed Terrarium members with working KVM, ZFS, OVN, Traefik and a shared S3 bucket. Both members need the build under test at `/usr/local/bin/terrariumctl`. The runner verifies the installed CLI, rather than importing command implementations.

```bash
bun run integration:vm --host root@node1 --peer root@node2 --members node1,node2
```

For an isolated Incus lab reached through another SSH host:

```bash
bun run integration:vm --host root@lab-host --incus-project vm-test --members node1,node2
```

The runner creates uniquely named Ubuntu 24.04 and 26.04 VMs and checks raw cloud-init, Ansible variables, Compose, the guest account and Python environment, HTTP/TCP/UDP through both members, directory sharing, full and incremental S3 exports, local and cross-host recovery with native snapshot history, independent guest identities, preserved provisioning, golden images, cold movement and backup provenance.

Results and host versions are written to `--output`, which defaults to `/tmp/terrarium-vm-integration`. Guests, the golden image and temporary input files are removed after success. `--keep-on-failure` preserves them for debugging. S3 objects and controller checkpoints remain under the run's unique instance names for inspection. Backup export scans all local workloads, as it does in production; use disposable hosts and a test bucket.

The separate real-infrastructure smoke/full suites cover installer reconciliation, external OIDC login and management dashboards. This runner does not provision hosts or identity providers and does not require a particular cloud provider. See [the implementation validation record](../../../plans/lxd-vm-validation.md) for the additional CIFS, Syncoid and failure checks used during development.
