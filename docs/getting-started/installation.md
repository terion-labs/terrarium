# Installation

Ready to turn your plain Ubuntu VPS into a hardened, LXD-powered container and VM host? The Terrarium installer makes it quick and easy.

## Requirements

- Ubuntu Server 24.04 or 26.04 LTS
- root access on the host
- SSH key-based access
- Optional Docker Hardened Images registry access. Terrarium first uses the upstream DHI registry when `/root/.docker/config.json` is present, then uses Terrarium's public GHCR mirror of the same pinned DHI image indexes, and only uses pinned upstream public fallbacks when hardened image use or mirrors are disabled. Set `terrarium_docker_hardened_images: true` or explicit image variables when you want installation to fail closed unless the upstream DHI images are available.
- either:
  - a dedicated extra disk for the LXD ZFS pool, which is the recommended setup
  - or enough root-disk space to use `--storage-mode file`

On Ubuntu 26.04, installation builds the Cockpit ZFS Python binding from a pinned, checksum-verified source revision against the host’s Python 3.14 and ZFS libraries. This requires access to GitHub and PyPI and takes additional time on the first install. Reconciliation rebuilds it when the binding source, build recipe, Python ABI, or ZFS development package changes. Ubuntu 24.04 continues to use its distribution package and Python 3.12.

If you still need to create the VPS itself, start with the provider setup guides:

- [DigitalOcean](../providers/digitalocean.md)
- [Vultr](../providers/vultr.md)
- [Hetzner Cloud](../providers/hetzner.md)
- [Hostinger](../providers/hostinger.md)

Or browse the full [Provider Guides](../providers/README.md) section first.

## Recommended Install

Most users should use the interactive installer. Just run this single command:

```bash
curl -fsSL https://github.com/terion-labs/terrarium/releases/latest/download/install.sh | bash
```

The published `install.sh` is intentionally thin. It downloads the matching release bundle from GitHub Releases, unpacks the compiled `terrariumctl` binary plus the Ansible provisioning assets into `/opt/terrarium`, and runs the real installer there. Default and tag-like release installs fail closed if the release cannot be resolved or downloaded; source builds require an explicit branch-like `--ref`, for example `main`.

If you want to pin a specific release instead of `latest`, use the tagged asset directly:

```bash
curl -fsSL https://github.com/terion-labs/terrarium/releases/download/0.0.38/install.sh | bash
```

## Install Modes

Interactive mode is the default and is the best fit for most first installs. It guides you through the process, asking a few simple questions.

```bash
curl -fsSL https://github.com/terion-labs/terrarium/releases/latest/download/install.sh | bash
```

Non-interactive mode is for automation, templates, or repeated installs:

```bash
curl -fsSL https://github.com/terion-labs/terrarium/releases/latest/download/install.sh | bash -s -- \
  --non-interactive \
  --email admin@your-domain.tld \
  --acme-email certs@your-domain.tld \
  --idp local \
  --idp-provider zitadel \
  --generate-root-pwd \
  --storage-mode file \
  --yes
```

### Identity Provider Examples

Use the compatibility default local ZITADEL:

```bash
terrariumctl install --idp local --idp-provider zitadel
```

Use local Logto instead:

```bash
terrariumctl install --idp local --idp-provider logto
```

Choose local ZITADEL when you want the lower-resource local IDP. Choose local Logto when you prefer richer identity functionality and a more polished admin/user experience; it is the heavier local option because it provides more of that product surface. With local Logto, Terrarium runs Logto and Postgres in the managed IDP system instance, seeds Logto unattended, and provisions the Terrarium OIDC clients during `terrariumctl idp sync`. The bootstrap admin email defaults to your Terrarium contact email and the username defaults to `terrarium_admin`; override them with `--logto-admin-email` and `--logto-admin-username`.

Use external generic OIDC, preserving the existing `groups` claim and `openid profile email` scope defaults:

```bash
terrariumctl install --idp oidc \
  --oidc https://issuer.example.com \
  --oidc-client terrarium \
  --oidc-secret-file /root/terrarium-oidc-secret \
  --admin-group terrarium-admins
```

Use external Logto or Logto Cloud, which defaults to the `roles` claim and `openid profile email roles` scopes:

```bash
terrariumctl install --idp oidc --idp-provider logto \
  --oidc https://tenant.logto.app/oidc \
  --oidc-client terrarium \
  --oidc-secret-file /root/terrarium-oidc-secret \
  --admin-group terrarium-admins
```

## Storage Modes

Terrarium supports three storage modes:

- `disk`
  Use a dedicated non-root disk for the ZFS pool. This is the recommended production setup.
- `partition`
  Use an existing unused partition or allocatable free space on a non-root disk.
- `file`
  Create a file-backed ZFS pool on the root filesystem. This is the fallback when there is no extra disk.

Important notes:

- Terrarium does not shrink the mounted root filesystem.
- In interactive mode, `partition` mode discovers allocatable targets, suggests the largest one, and asks for confirmation.
- In non-interactive mode, `--storage-source` is required for `disk` and `partition`.
- You can use `--storage-source auto` to let Terrarium pick the largest valid non-root target automatically.

## First Decisions During Install

The installer will guide you through:

- Contact email and ACME email for SSL certificates.
- Root password setup for Cockpit when the host does not already have a usable local root password.
- Domain setup (custom domain or default `traefik.me`).
- IDP mode:
  - `local` for a self-hosted provider
  - `oidc` for an external OIDC provider
- IDP provider:
  - `zitadel` is the compatibility default for local installs
  - `logto` selects local Logto or external Logto/Logto Cloud defaults
- Local Logto bootstrap email and username when `--idp-provider logto` is selected.
- Storage mode and storage source.
- Optional S3 archive backups.
- Optional syncoid replication.

Terrarium also verifies the most failure-prone integrations while you configure them:

- Password and secret prompts are masked in interactive mode.
- External OIDC settings are probed against the issuer, callback flow, and client credentials before install continues. External Logto uses the same verification path; no Logto Cloud management credential is required for normal Terrarium runtime config.
- S3 settings are tested with a real write/delete probe against the configured bucket.

## Container Image Sources

Terrarium pins the upstream oauth2-proxy and local identity-provider Postgres image sources by digest where Terrarium manages those images. The default source order is:

- upstream Docker Hardened Images from `dhi.io` when Docker registry credentials exist on the host.
- Terrarium's GHCR mirror of those same DHI multi-arch indexes when upstream DHI credentials are not present.
- the pinned public upstream images when `terrarium_docker_hardened_images` or `terrarium_docker_hardened_image_mirrors` is disabled.

The GHCR mirror is refreshed by CI with Docker Hub credentials, copies every platform in the pinned index, and verifies the copied index and required `linux/amd64` and `linux/arm64` manifests before publishing.

In interactive mode, failed verification sends you back to the relevant prompts. In non-interactive mode, install exits with an error instead of persisting broken settings.

For non-interactive automation, use generated or file-based secret inputs so secrets do not travel through shell history or process arguments:

- `--generate-root-pwd`
- `--root-pwd-file`
- `--oidc-secret-file`
- `--lxd-oidc-secret-file` when using a separate LXD OIDC client
- `--s3-secret-key-file`

## After Install

Terrarium keeps:

- the installed Terrarium bundle at `/opt/terrarium`
- the canonical config in LXD's dqlite-backed `terrarium-system` project after LXD is initialized
- canonical config in LXD's dqlite-backed store, with an optional root-only YAML export available through `terrariumctl config export`

From there, the main commands you will use are:

- `terrariumctl status`
- `terrariumctl set ...`
- `terrariumctl proxy sync`
- `terrariumctl backup ...`

For full command details, see [terrariumctl Reference](../reference/terrariumctl.md).

## VM host requirements

Installing Terrarium does not require VM support. To run Linux VMs, the host must expose hardware virtualization to LXD, including `/dev/kvm`. On a cloud VM this requires nested virtualization from the provider. Check `trm status` on the actual host; a provider or instance-family name alone does not prove support. Managed profiles `vm` and `vm-dev` are installed and updated alongside the container profiles. See [virtual machines](./virtual-machines.md).
