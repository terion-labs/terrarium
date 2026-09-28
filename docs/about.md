# About Terrarium

Terrarium transforms a standard Ubuntu 24.04 or 26.04 VPS into a much friendlier, safer, and incredibly forgiving home for your applications and isolated environments.

It was built to solve a very modern problem: today's AI agents, development tools, and complex self-hosted apps often need more freedom than standard Docker containers can comfortably provide. But giving them unlimited access to your host operating system is a recipe for disaster. 

Terrarium sits perfectly in the middle. It gives every workload its own fully isolated LXC container powered by a robust ZFS file system. Your host machine stays clean and secure, while you get the convenience of built-in web dashboards, automatic SSL routing, and an automated time machine to undo any mistakes.

## What Is It For?

Terrarium shines when you need to run:

- **AI Agents (like OpenClaw or Hermes):** Give them a realistic playground where they can install packages and run shell commands without risking your main server.
- **Browser-Based Workspaces:** Host cloud IDEs like VSCodium Web for seamless, anywhere access to your code.
- **Experimental Sandboxes:** Spin up temporary environments for client work or trying out new tech, then easily tear them down.
- **Complex Docker Compose Stacks:** Run multi-service apps (like a web app, database, and Redis cache) completely isolated from one another.

The goal isn't just to "run containers." It's to give your software the breathing room it needs to be useful, while ensuring your server and other apps stay completely out of the blast radius.

## Why You'll Love It

Terrarium brings enterprise-grade infrastructure features down to earth, combining them into a simple, cohesive experience:

- **True Isolation**
  Every workload lives in its own container with its own processes, packages, and filesystem. What happens in the container, stays in the container.
- **Private-by-Default Security**
  By default, containers sit behind a private network. Just because a database is running doesn't mean it's exposed to the internet. You explicitly choose what to publish.
- **The Built-In Time Machine**
  Terrarium takes automated ZFS snapshots of your environments. If an update breaks or an agent deletes something important, you don't have to rebuild. Just rewind.
- **Disaster Recovery Ready**
  Go beyond the local machine. With built-in S3 exports, you can back up your snapshots off-site so your data is safe even if the entire VPS is destroyed.
- **Visual Management**
  Say goodbye to memorizing endless command-line arguments. Terrarium includes beautiful web UIs (Cockpit, the LXD dashboard, and Traefik) so you can manage your server visually.

Terrarium is designed for tech enthusiasts who want the flexibility of a full server without having to become full-time DevOps engineers just to keep things secure and recoverable.

## Technical details in short

Terrarium sets up and orchestrates LXD, Traefik, Firewall, Virtual Networking, clustering, ZFS and backups. 

LXD is a systen that runs LXC containers and VMs (we are focused on containers). LXC containers are Linux system containers that sit conceptually between Docker-style application containers and traditional VMs. Like Docker containers, they are lightweight and share the host kernel using Linux namespaces and cgroups. Unlike typical Docker usage, LXC is often used to run a full OS-like userspace with init, package management, services, users, and networking, giving a VM-like administration experience without hardware virtualization overhead. They can also run inside ordinary cloud VMs because they do not require nested virtualization, though their isolation is not as strong as a true VM because the kernel is shared with the host. 

Using ZFS brings to the mix cheap hot snapshots that give "time machine" like experience with ability to "rewind" containers state in small increments together with exportable backups. 

Traefik is a reverse proxy that lives on host and can pass traffic in containers (in case of Terrarium - autoconfigurated via labels on containers). All this works on single node or in a cluster, that is built upon OVN and secure wireguard internal connections.

## Where to Go Next

**If you're ready to get started:**
1. Head over to [Getting Started](./getting-started/).
2. Read up on [Storage & Sizing](./getting-started/storage) before you buy a server.
3. Check our [Provider Guides](./providers/) for tips on launching a VPS on DigitalOcean, Hetzner, and others.

**If you want to understand how it works:**
1. Dive into the [Security Model](./security).
2. Read the [Architecture Overview](./architecture).
3. Check out the [Management GUIs](./getting-started/management-guis) to see the visual control plane.

**If you know what you want to build:**
1. Browse the [Guides](./guides/).
2. Learn how to deploy [OpenClaw](./guides/openclaw), [Hermes](./guides/hermes), [VSCodium Web](./guides/vscode), or [Compose stacks](./guides/compose).

**If you're planning for the worst:**
1. Read up on [Backups and Restore](./operations/backups-and-restore).
2. Keep the [terrariumctl Reference](./reference/terrariumctl) handy for operational commands.
