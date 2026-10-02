# Terrarium

> [!IMPORTANT]
> Turn any VPS into a secure, forgiving home for your AI agents and apps. Full freedom for them. Convenience, security and a time machine for you.

<p align="center">
    <picture>
        <img src="https://raw.githubusercontent.com/terion-labs/terrarium/main/assets/banner.webp" alt="Terrarium" width="100%" style="max-width: 800px">
    </picture>
</p>

Managing secure, isolated infrastructure usually requires a lot of specialized knowledge. Terrarium changes that. It transforms a standard Ubuntu 24.04 or 26.04 VPS into a friendly, secure home for your applications, development environments, and AI agents—complete with a built-in time machine for undoing mistakes.

Whether you're running complex Docker Compose stacks, giving AI agents room to experiment, or hosting your own web-based IDEs, Terrarium brings simplicity to operations that used to be complicated. It isolates your workloads in LXD containers or Linux virtual machines, keeping your host system pristine and secure. If an experiment goes wrong or a service breaks, you don't have to rebuild everything from scratch. You can simply roll back in time using automated ZFS snapshots.

With Terrarium, you get the freedom of a full VPS without the fear of turning your server into a shared blast radius. It makes advanced infrastructure management accessible, safe, and surprisingly forgiving.

> [!TIP]
> ### Technical details in short
>
> This tool sets up and orchestrates LXD, Traefik, Firewall, Virtual Networking, clustering, ZFS and backups.
>
> LXD runs LXC containers and virtual machines. Terrarium supports both, using Linux cloud images for VMs. LXC containers are Linux system containers that sit conceptually between Docker-style application containers and traditional VMs. Like Docker containers, they are lightweight and share the host kernel using Linux namespaces and cgroups. Unlike typical Docker usage, LXC is often used to run a full OS-like userspace with init, package management, services, users, and networking, giving a VM-like administration experience without hardware virtualization overhead. They can also run inside ordinary cloud VMs because they do not require nested virtualization, though their isolation is not as strong as a true VM because the kernel is shared with the host.
>
> Using ZFS brings to the mix cheap hot snapshots that give "time machine" like experience with ability to "rewind" containers state in small increments together with exportable backups.
>
> Traefik is a reverse proxy that lives on host and can pass traffic in containers (in case of Terrarium - autoconfigurated via labels on containers). All this works on single node or in a cluster, that is built upon OVN and secure wireguard internal connections.

## 📚 Documentation

- **Live Site:** [terrarium.terion.name](https://terrarium.terion.name/)
- [Docs Home](docs/README.md)
- [Getting Started](docs/getting-started/README.md)
- [Provider Guides](docs/providers/README.md)
- [Operations & Backups](docs/operations/README.md)
- [terrariumctl Reference](docs/reference/terrariumctl.md)
- 🤖 **For AI agents:** [agents.md](https://terrarium.terion.name/agents.md), a single-file guide to installing, operating, and building on Terrarium ([source](docs/public/agents.md))

## 🚀 Quick Install

To get started on a fresh Ubuntu 24.04 or 26.04 server, simply run:

```bash
curl -fsSL https://github.com/terion-labs/terrarium/releases/latest/download/install.sh | bash
```

Terrarium automatically provisions your host with everything you need for a modern, secure setup:
- **LXD & OpenZFS:** For isolated container environments and instant snapshots.
- **Traefik:** For effortless public routing with automatic SSL certificates.
- **Cockpit:** A sleek web UI to manage your server, storage, and networking.
- **Single Sign-On (SSO):** Built-in authentication (via ZITADEL or your own OIDC provider) to keep your private apps secure.
- **System Hardening:** Out-of-the-box OS and SSH security configurations.

## 💡 Why Use Terrarium?

### Security & Isolation Made Simple
Your containers are never exposed directly to the internet. They live in a private network, meaning that random scans and probes won't reach them. You decide exactly what to publish to the web—and you can lock it all down with automatic Single Sign-On.

### Built-in Time Machine
Mistakes happen. Terrarium automatically takes snapshots of your environments. If an AI agent deletes the wrong folder or an update breaks your app, you can rewind to a working state in seconds. For disaster recovery, Terrarium can even export these snapshots securely to S3.

### Visual Management
You don't have to memorize a hundred command-line flags. Terrarium provides beautiful web interfaces: Cockpit for the host system, the LXD UI for your containers and VMs, and the Traefik dashboard for your network traffic.

## 🖥️ Recommended Hardware

Terrarium is designed to be lightweight, but giving your environments a bit of breathing room is always a good idea.

- **Minimum:** `2 vCPU`, `4 GB RAM`, and a separate `80 GB` disk for containers.
- **Recommended:** `4 vCPU`, `8-16 GB RAM`, and a separate `150+ GB` disk.

*Tip: For the best experience and performance, attach a dedicated block storage volume to your VPS during creation. Terrarium will automatically format and use it for your containers and snapshots.*

## 📖 Popular Guides

Want to see what you can build? Check out our guides:
- [Host an Isolated code-server Web IDE](docs/guides/vscode.md)
- [Run AI Agents like OpenClaw](docs/guides/openclaw.md)
- [Deploy Multi-Service Docker Compose Stacks](docs/guides/compose.md)
- [Protect Published Services with OIDC](docs/guides/auth-protection.md)

---
*Ready to dive deeper? Check out the [full documentation](https://terrarium.terion.name/) to learn about storage strategies, custom domains, automated backups, and more.*

### Linux virtual machines

Run `trm launch ubuntu:24.04 app-vm --vm --wait` on a host with hardware virtualization. VM profiles, provisioning, HTTP/TCP/UDP routing, shared directories, snapshots, S3/Syncoid backups, recovery, golden images, and cold cluster moves use the same Terrarium workflows. See the [VM guide](docs/getting-started/virtual-machines.md).
