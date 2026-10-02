# Getting Started

Welcome to Terrarium. Before you install, it helps to understand a few key concepts so you can set up your server exactly how you want it. 

This section covers everything you need to know to get up and running:

- **[Installation](installation.md):** The step-by-step process for getting Terrarium onto your VPS.
- **[Creating Your First Instance](creating-first-instance.md):** How to spin up your first container and publish an app to the web.
- **[Templating Containers with `trm launch`](templating.md):** How to turn repeatable app setup into one launch command with Ansible, Docker Compose, variables, and proxy labels.
- **[Storage and Sizing](storage.md):** How to choose the right hardware and structure your storage for the best performance and snapshot capabilities.
- **[Domains and Authentication](domains-and-auth.md):** Setting up custom domains and choosing how you want to handle Single Sign-On (SSO) for your private apps.
- **[Management GUIs](management-guis.md):** A quick tour of the built-in visual dashboards you get right out of the box.
- **[Shared Data Between Containers](shared-data-between-containers.md):** How to let your isolated environments safely share files.
- **[External Shared Storage](external-shared-storage.md):** Connecting Terrarium to external storage solutions like Hetzner Storage Boxes.

### 🗺️ Recommended Path

To get off to the best start, we recommend following these steps:

1. **Plan your storage:** Decide if your provider allows you to attach a separate block volume (highly recommended for performance and backups). 
2. **Pick a domain:** Decide whether you want to use your own custom domain or rely on Terrarium's automatically generated `traefik.me` domains.
3. **Choose your login method:** Decide if you want to use Terrarium's built-in local identity provider (ZITADEL) or bring your own (like Google, GitHub, or Auth0).
4. **Install:** Run the automated setup script.

*Creating your VPS right now? Check out our [Provider Guides](../providers/README.md) for specific setup instructions for DigitalOcean, Hetzner, Vultr, and others.*

- [Linux virtual machines](./virtual-machines.md) — create and manage VMs through the same Terrarium workflows.
