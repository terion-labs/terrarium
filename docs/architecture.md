# Terrarium Architecture

If you're curious about how Terrarium works under the hood, you're in the right place.

Terrarium takes a single Ubuntu 24.04 host and turns it into a hardened control plane for LXD containers and Linux virtual machines. It handles the networking, the ZFS-backed time machine, and the automated off-site backups so you don't have to.

## The Core Layers

Terrarium is built on four main layers:

1. **`install.sh`**  
   A lightweight bootstrap script. It safely downloads the correct compiled version of Terrarium for your system and kicks off the setup.
2. **`terrariumctl`**  
   The brains of the operation. This single binary handles the interactive installer, renders your configuration, manages backups and restores, and syncs your web proxy routing.
3. **Ansible**  
   The builder. `terrariumctl` generates a state file, and Ansible securely provisions your host to match that exact state (setting up ZFS, installing Traefik, hardening SSH, etc.).
4. **Host Helpers**  
   Systemd timers running quietly in the background. They trigger `terrariumctl` to periodically sync your network routes, take ZFS snapshots, and export backups to S3.

## Configuration & Storage

### Where Does the Config Live?
Terrarium is smart about not reinventing the wheel. Instead of running a complex secondary database just to store your settings, it uses LXD's built-in, highly available database (`dqlite`).
- The canonical config lives in LXD's dqlite-backed project store. You can create a root-only YAML export at `/etc/terrarium/config.yaml` with `terrariumctl config export` when you need a recovery/debug copy.
- Whenever you make changes using commands like `terrariumctl set domains`, Terrarium updates the LXD database and tells Ansible to seamlessly apply the changes.

### The ZFS Storage Engine
Terrarium relies heavily on OpenZFS to provide its magic time machine and fast containers. Depending on your VPS, it provisions ZFS in one of three ways:
- **`disk` (Recommended):** Terrarium takes full ownership of an empty attached volume.
- **`partition`:** Uses an empty partition on a non-root drive.
- **`file`:** Carves out a virtual disk file on your primary root drive (great for cheap, single-disk servers).

## The Network Model

Terrarium's networking is designed around a single principle: **Private by Default**.

- Your instances live on an isolated virtual network (`terrarium-ovn`).
- They have zero direct exposure to the public internet.
- Guest services are accessible on the private network. Publication through Traefik is explicit.

### How Traffic Gets In (The Proxy Model)
To expose an app to the web, you add a simple label to the instance (e.g., `user.proxy="https://myapp.domain.com"`).

Every minute, Terrarium scans your instances. When it sees that label, it automatically:
1. Creates a loopback proxy device. VM routes use a small managed container on each ingress member to reach the VM over OVN.
2. Tells Traefik to route internet traffic from `myapp.domain.com` through that private backend.
3. Provisions a Let's Encrypt SSL certificate.
4. *(Optional)* Wraps the whole route in a Single Sign-On (OIDC) authentication gate if you added the `@auth` tag.

## The Security Model

Terrarium doesn't just isolate your apps; it hardens the host itself.
- **SSH:** Locked down to key-based access only.
- **Firewall:** Blocks all incoming traffic by default.
- **Unprivileged Containers:** Even if an attacker breaks out of a Docker instance inside your container, they are still trapped in an unprivileged LXC namespace, completely separated from the host's actual root user.
- **Non-root Container Workflow:** New cloud-init based containers get a normal `terrarium` user. The base profiles do not grant passwordless sudo; opt into that only for development and agent sandboxes by layering the `dev` profile.

### Authentication (IDP)
Terrarium secures all of your management dashboards (Cockpit, LXD, Traefik). It either:
- Runs a local instance of **ZITADEL** to manage your users and groups.
- Connects to your existing external identity provider (like Google or Auth0) using **OIDC**.

## The Time Machine (Backups)

Terrarium gives you three layers of safety:

1. **The Local Time Machine (ZFS Snapshots)**
   Managed automatically by a tool called `sanoid`. It takes fast, incremental snapshots of your containers every 15 minutes. Perfect for undoing a bad `rm -rf` or a broken `apt upgrade`.
2. **Off-Host Replication (Syncoid)**
   *(Optional)* If you have a second server, Terrarium can constantly mirror your ZFS state to it.
3. **Disaster Recovery (S3 Exports)**
   *(Optional)* Terrarium can compress your snapshots and stream them directly to an S3 bucket (like AWS or Cloudflare R2). If your server catches on fire, you can restore your exact environments onto a brand new machine.

## Native virtual machines

VMs run their own Linux kernel through LXD’s QEMU driver and require working hardware virtualization. The `vm` and `vm-dev` profiles provide the same `terrarium` account, Python environment, cloud-init provisioning and OVN network as container workflows. `vm-dev` grants passwordless sudo. Docker runs inside the guest without container nesting options.

A VM root backup contains a ZFS filesystem and a sibling block volume captured in one snapshot transaction. S3 manifests publish only complete, verified sets; Syncoid transfers both components. See [VMs](./getting-started/virtual-machines.md) and [backup recovery](./operations/backups-and-restore.md).
