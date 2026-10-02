# Linux virtual machines

Terrarium manages LXD containers and Linux cloud-image VMs through the same commands, profiles, routing labels, backups, and management UI. Containers share the host kernel. VMs boot their own kernel and require working hardware virtualization on the member that runs them.

Run `trm status` to check VM availability. A container-only host can still join the cluster and serve ingress. The `kvm` profile passes `/dev/kvm` into a **container**; use `--vm` and a VM profile to create an LXD VM.

## Create and provision

```bash
trm launch ubuntu:24.04 app-vm --vm --wait
trm launch ubuntu:26.04 dev-vm --vm --profile vm-dev --target node2 \
  --cpu 2 --memory 4GiB --disk 40GiB --wait --timeout 600
```

Without `--profile`, a VM receives `vm`: 2 CPUs, 2 GiB RAM, a 20 GiB ZFS root disk, the managed OVN network, and a locked `terrarium` account with a Python virtual environment. `vm-dev` adds passwordless sudo. Existing container profiles keep their meanings and cannot be mixed into a VM launch.

`--requirements`, `--playbook`, `--role`, `--docker-compose`, `--var`, `--vars`, and raw `--cloud-init` work with VMs. Both `launch` and `image launch` expose these options. Raw cloud-init remains an alternative to the provisioning shortcuts.

`--wait` waits for the guest agent and cloud-init. Its default timeout is 300 seconds. A booted VM may still be provisioning; a successful start alone does not mean the application is ready. A failed wait leaves the instance available for inspection.

```bash
trm exec app-vm
trm exec app-vm --root
lxc exec app-vm -- cloud-init status --long
lxc console app-vm
```

`exec` waits briefly for the VM agent, then runs your command once. When the agent is unavailable, use the native serial or VGA console rather than repeatedly submitting a command whose result is unknown.

## Use the LXD UI

Open `lxd.<your-domain>` using the existing management login. Create an instance with type **Virtual machine**, choose an Ubuntu cloud image, remove the container `default` profile, and select `vm` or `vm-dev`. Choose a capable cluster member and any resource overrides. The same profiles work when selected directly in the UI.

Start, stop, restart, delete, snapshot, and console operations use LXD's native controls. Terrarium does not add a second VM manager. Keep guests and published services on the managed OVN network.

## Publish services

```bash
lxc config set app-vm user.proxy 'https://app.example.com:8080@auth:admins,tcp://9001:9001,udp://9002:9002'
trm proxy sync
```

HTTP, HTTPS, path routes, TCP, UDP, and OIDC policies use the existing label syntax. VM services must listen on the guest's managed network address or `0.0.0.0`, rather than only its loopback interface.

Each ingress member creates an internal `terrarium-ingress-*` container when needed. LXD proxy devices on that helper connect through OVN to the guest and listen only on host loopback. Local container routes retain their direct proxy devices; remote container routes use the helper too. Stopped guests lose their routes until they run again. Reconciliation follows IP changes and cluster moves. Helpers are excluded from workload placement, image creation, and backup export.

## Storage, images, and movement

Use the normal [backup commands](../operations/backups-and-restore.md). A VM restore point contains both its metadata filesystem and its block volume. Terrarium accepts only complete pairs from one ZFS snapshot transaction, verifies downloaded streams, and stages reconstruction before replacing disks. VM snapshots capture disk state, not RAM; databases still need application-aware backup or quiescing when crash recovery is insufficient.

```bash
trm backup restore --instance app-vm --as-new app-vm-recovered
trm image create app-vm app-base
trm image launch app-base app-copy --wait
```

A local golden VM image selects VM behavior even without `--vm`. Copies lose published routes and host-bound devices. VM copies prepare new machine and SSH identities under a deny-all OVN policy before joining the network. Golden images also reset cloud-init for the next launch; recovery copies preserve completed provisioning.

```bash
trm mount attach /srv/shared/data app-vm /mnt/data
trm cluster move app-vm node2
```

Host directory sharing uses the VM guest user's UID/GID. Managed CIFS mounts cannot be remapped while another instance consumes them. Host directory disks and other host-bound devices must be detached before moving; attach the appropriate share on the destination afterward. A move checks capability, architecture, storage, and device eligibility before graceful shutdown. A shutdown failure aborts the move without forcing power off.

The supported guest workflow is Linux cloud images with the LXD agent, cloud-init, and the Terrarium account. Windows, custom ISO installation, saved-memory recovery, and guaranteed live migration are outside this feature.
