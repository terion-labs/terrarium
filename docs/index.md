---
layout: home

hero:
  name: Terrarium
  text: Complex infrastructure made incredibly simple. Turn any VPS into a secure, forgiving home for your apps and AI agents.
  tagline: Give each workload its own isolated container, keep everything private by default, and publish only what you need. With built-in web dashboards, automated SSL, single sign-on, and a time machine to undo mistakes, managing your server has never been simpler.
  image:
    src: ./banner.webp
    alt: Terrarium
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/
    - theme: alt
      text: See Guides
      link: /guides/
    - theme: alt
      text: Security Model
      link: /security

features:
  - title: 🔐 Security Made Simple
    details: Terrarium hardens your VPS automatically. Your apps sit in a private network, safe from internet noise and random scans. You only expose what you explicitly choose to publish.
  - title: ⏪ The Built-In Time Machine
    details: Never fear a broken update again. ZFS snapshots let you roll your environments backward in small steps. Made a mistake? Just rewind. Off-site S3 backups offer total peace of mind.
  - title: 🌐 Effortless Publishing
    details: Route your apps to the web through Traefik with automatic SSL certificates. Lock down private dashboards and tools with built-in Single Sign-On (OIDC).
  - title: 🖥️ Visual Dashboards
    details: You don't have to live in the terminal. Manage your server, containers, and network traffic through beautiful, built-in web interfaces like Cockpit and the LXD UI.
  - title: 🤖 Perfect for AI Agents
    details: Give autonomous agents like OpenClaw or Hermes a real environment to work in. If they make a mess, your host stays safe, and you can instantly reset their sandbox.
  - title: 🐳 Beyond Basic Docker
    details: Run multi-service Compose stacks, databases, and background workers in isolated LXC containers instead of tangling everything together on your host OS.
---

<div class="terrarium-home-grid">
  <section class="terrarium-panel terrarium-panel-accent">
    <p class="terrarium-eyebrow">Why you'll love it</p>
    <h2>One server. Total isolation. Zero stress.</h2>
    <p>
      Managing a server shouldn't require a PhD in systems engineering. Terrarium is built for tech enthusiasts who want the power of a dedicated VPS without the anxiety of breaking it. Every app, AI agent, or development environment gets its own isolated container. The host stays pristine, and recovery is as easy as clicking "undo".
    </p>
  </section>

  <section class="terrarium-panel">
    <p class="terrarium-eyebrow">The Terrarium Difference</p>
    <ul class="terrarium-checklist">
      <li><strong>Mistake-proof:</strong> If an agent breaks an environment, step back through automated snapshots instead of starting over.</li>
      <li><strong>Clean organization:</strong> Keep complex databases, Redis caches, and web workers neatly bundled inside a single private container.</li>
      <li><strong>Secure access:</strong> Host a browser-based IDE or internal dashboard and protect it with enterprise-grade Single Sign-On with just a label.</li>
    </ul>
  </section>
</div>

## Safety by Default

The best part of Terrarium isn't just what it can do—it's how safe it feels to use.

By default, your containers are not exposed to the internet. They live on a private network managed by Terrarium. This means:
- Random internet bots can't scan or poke at your internal services.
- A database listening on `0.0.0.0` inside a container is still entirely private.
- You can run complex, multi-tier applications and only expose the specific web frontend you want people to see.

It's advanced security without the complex configuration. You get to move fast and experiment, knowing your infrastructure is guarding your back.

## What Can You Run?

<div class="terrarium-cards">
  <a class="terrarium-card" href="./guides/vscode">
    <strong>code-server Web IDE</strong>
    <span>Spin up browser-based coding environments with their own filesystems, completely isolated and protected by SSO.</span>
  </a>
  <a class="terrarium-card" href="./guides/openclaw">
    <strong>AI Agents (OpenClaw)</strong>
    <span>Give agents a real, capable sandbox to explore and execute tasks, while keeping your host OS totally off-limits.</span>
  </a>
  <a class="terrarium-card" href="./guides/compose">
    <strong>Docker Compose Stacks</strong>
    <span>Deploy complex apps with databases and workers inside a single time-machine-enabled container.</span>
  </a>
  <a class="terrarium-card" href="./guides/hermes">
    <strong>Hermes</strong>
    <span>Run background agent services privately and expose only the user interface to the web.</span>
  </a>
</div>

---

<div class="terrarium-home-grid terrarium-home-grid-equal terrarium-home-grid-sections">
  <section class="terrarium-panel">
    <p class="terrarium-eyebrow">Visual Management</p>
    <h2>See everything at a glance.</h2>
    <p>
      While Terrarium is incredibly friendly to the command line, it's also built for people who prefer a visual approach to server management.
    </p>
    <ul class="terrarium-checklist">
      <li><strong>Cockpit:</strong> Your mission control for host administration, system logs, and storage health.</li>
      <li><strong>LXD UI:</strong> A sleek interface to create containers, manage networks, and instantly restore snapshots.</li>
      <li><strong>Traefik Dashboard:</strong> Watch your live network routing and ensure your traffic is flowing exactly where it should.</li>
    </ul>
    <p>Take the visual tour in our <a href="./getting-started/management-guis">Management GUIs guide</a>.</p>
  </section>

  <section class="terrarium-panel">
    <p class="terrarium-eyebrow">What's Under the Hood?</p>
    <h2>Powerful open-source tools, orchestrated beautifully.</h2>
    <ul class="terrarium-checklist">
      <li><a href="https://github.com/canonical/lxd">LXD</a> for lightweight, lightning-fast containers</li>
      <li><a href="https://github.com/openzfs/zfs">OpenZFS</a> for instant snapshots and data integrity</li>
      <li><a href="https://github.com/traefik/traefik">Traefik</a> for dynamic routing and automated SSL</li>
      <li><a href="https://github.com/cockpit-project/cockpit">Cockpit</a> for host-level visual administration</li>
      <li><a href="https://github.com/oauth2-proxy/oauth2-proxy">OAuth2-Proxy</a> & <a href="https://github.com/zitadel/zitadel">ZITADEL</a> for seamless Single Sign-On</li>
      <li><a href="https://github.com/jimsalterjrs/sanoid">Sanoid</a> for automated backup retention</li>
    </ul>
  </section>
</div>

## Ready to Start?

<div class="terrarium-cards terrarium-cards-tight">
  <a class="terrarium-card" href="./getting-started/">
    <strong>Getting Started</strong>
    <span>Step-by-step installation, storage setup, and domain configuration.</span>
  </a>
  <a class="terrarium-card" href="./getting-started/storage">
    <strong>Storage Strategy</strong>
    <span>How to size your VPS and use block storage for the best experience.</span>
  </a>
  <a class="terrarium-card" href="./providers/">
    <strong>Provider Guides</strong>
    <span>Launch the perfect VPS on DigitalOcean, Vultr, Hetzner, or Hostinger.</span>
  </a>
  <a class="terrarium-card" href="./security">
    <strong>Security Model</strong>
    <span>Understand how Terrarium's private-by-default architecture protects you.</span>
  </a>
  <a class="terrarium-card" href="./reference/terrariumctl">
    <strong>Command Reference</strong>
    <span>Explore the CLI tool for backups, restores, and system reconfiguration.</span>
  </a>
  <a class="terrarium-card" href="./agents">
    <strong>For AI Agents</strong>
    <span>A single-file guide your agent can read to install, operate, and build on Terrarium.</span>
  </a>
</div>
