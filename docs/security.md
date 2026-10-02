# Security Model

Terrarium is designed to make the safe path feel natural. It's built for people who want powerful environments without having to become full-time infrastructure and security engineers.

The short version of how Terrarium keeps you safe:
- **Containers are private by default.**
- **Workloads are unprivileged.**
- **The host machine is heavily hardened.**
- **Public exposure is always explicitly chosen.**
- **A built-in time machine catches your mistakes.**

## 🛡️ Private By Default Networking

This is one of Terrarium's most important properties.

When you create an LXC container, it lives on Terrarium's private internal network. Your containers **do not** sit on the public internet, and their internal services are not reachable from the outside.

This means:
- Random internet scans and bots cannot hit your container services directly.
- If a database or app is listening on `0.0.0.0` inside a container, it is still completely private.
- You can run databases, Redis caches, dev servers, and internal APIs inside the container without instantly exposing them to the world.

A service only becomes public when you *explicitly* choose to expose it through Terrarium's Traefik proxy.

### Why This Matters
For AI agents and development stacks, this is a game-changer. An autonomous agent can install packages, run background services, and open local ports inside its container without turning your whole VPS into a public attack surface. You can test your apps safely in the dark before turning on the lights.

## 🔒 Host Hardening

Terrarium doesn't just secure the containers; it locks down the host server itself:
- **SSH is Key-Only:** Password-based SSH logins are completely disabled to stop brute-force attacks.
- **Firewall (UFW):** Defaults to denying all incoming traffic.
- **Dashboard Protection:** Your management UIs (Cockpit, LXD, Traefik) are hidden behind a secure Single Sign-On (OIDC) gate.

You won't find management ports left open to the internet. Everything is routed and controlled through Terrarium's secure proxy layer.

## 🐳 Docker inside LXC

Terrarium sets up your containers to be "Docker-friendly" by default, but it does it safely. 

Terrarium workload containers are **unprivileged LXC containers**. This means the "root" user inside your container is not the real "root" user of the host machine. 

When you install Docker inside one of these containers, that Docker daemon and all of its nested containers sit behind an extra security boundary. This keeps complex app stacks completely isolated from your host, preventing your server from becoming one messy, vulnerable shared Docker environment.

*(Want strict isolation without Docker support? Terrarium provides a `strict` profile you can apply to containers that don't need nested virtualization.)*

## 👤 Container Users and Dev Mode

Terrarium's managed LXD profiles create a normal `terrarium` user inside new cloud-init based containers. That user is locked by default and does **not** receive passwordless sudo in the base `default`, `terrarium`, or `strict` profiles.

For development containers and AI-agent sandboxes that need to install packages, use the standalone `dev` profile:

```bash
lxc launch ubuntu:24.04 devbox --profile dev
trm exec devbox
```

The `dev` profile includes Terrarium's Docker-friendly defaults and adds passwordless sudo for the `terrarium` user, so package installation is explicit:

```bash
sudo apt-get update
sudo apt-get install -y git curl
```

Root is still available through LXD for recovery and system administration, but day-to-day work should happen under `/home/terrarium`.

## ⏪ The Time Machine As Security

Security isn't just about blocking hackers. It's also about recovering from mistakes.

Terrarium's built-in ZFS snapshots act as an automated time machine. If an AI agent runs a bad command, a software update breaks your app, or you accidentally delete the wrong file, you don't have to rebuild everything. You just step the environment backward in time.

If you enable S3 exports, this protection extends beyond the server itself. Even if the entire VPS is deleted, your data survives in the cloud.

## ⚠️ What Terrarium Does Not Do

Terrarium provides an incredibly secure foundation, but it isn't magic. You still need to:
- Keep your software updated.
- Think carefully before publishing apps to the internet.
- Use Terrarium's built-in OIDC protection for sensitive internal dashboards.

**The Golden Rule:** Treat containers as private first. If a service doesn't *need* to be on the internet, don't publish it. 

## Linux virtual machines

VMs use the same private OVN network and explicit `user.proxy` publication as containers. They run a separate guest kernel and require working KVM on the host. The base `vm` profile creates a locked `terrarium` account without passwordless sudo; `vm-dev` grants it for development workloads.

VM ingress uses per-member helper containers with host loopback listeners. Apps must listen on the VM’s private address or `0.0.0.0`. HTTP authentication rules are unchanged; TCP and UDP publication does not add browser authentication. For golden images and restore-as-new, Terrarium blocks guest network traffic while replacing copied machine and SSH identities, then removes the temporary block after clean shutdown.
