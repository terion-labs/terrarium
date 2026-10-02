# Terrarium: Guide for AI Agents

> This file is for AI agents that install, operate, or build on a Terrarium host.
> Human docs: https://terrarium.terion.name/ · Source: https://github.com/terion-labs/terrarium
> Terrarium is beta software (current release line `0.0.0-betaN`). If this file and `terrariumctl --help` disagree, trust `--help` on the host.

## What Terrarium is

Terrarium turns a fresh Ubuntu Server 24.04 or 26.04 VPS into a hardened host for isolated LXD system containers (LXC) on ZFS. It installs and configures:

- **LXD** with its web UI. It runs unprivileged system containers; Terrarium targets containers, not VMs.
- **OpenZFS**, with the `terrarium` storage pool holding all containers.
- **sanoid / syncoid** for automatic ZFS snapshots and optional replication to another ZFS host.
- **S3 export** of ZFS snapshot streams for disaster recovery (optional).
- **Traefik** on the host as the only ingress: Let's Encrypt TLS, with routes generated from container labels.
- **oauth2-proxy** as an OIDC gate for the management UIs and for any published route you mark `@auth`.
- **Identity provider**: a local ZITADEL (default) or local Logto running in the managed `terrarium-idp` instance, or any external OIDC issuer.
- **Cockpit** for host administration, with ZFS and S3 browser plugins.
- **UFW** firewall, key-only SSH, and `devsec.hardening` host hardening.
- **Clustering** (optional): LXD clustering over a WireGuard mesh, with an OVN overlay network shared by all nodes.

The CLI is `terrariumctl`. `trm` is a symlink to the same binary. Both are in `/usr/local/bin`.

## Core model (read this first)

1. **Containers are private by default.** Every container sits on the `terrarium-ovn` private network. A service listening on `0.0.0.0:5432` inside a container cannot be reached from the internet.
2. **Publishing is explicit.** A service goes public only when the LXD config key `user.proxy` is set on its container. A host timer turns labels into Traefik routes every 60 seconds. `terrariumctl proxy sync` applies them immediately.
3. **Backends must listen on `0.0.0.0`** inside the container. Traefik cannot reach a service bound only to `127.0.0.1`.
4. **The time machine is automatic.** sanoid snapshots every container: 4 × 15-minute, 24 hourly, 14 daily, and 3 monthly snapshots are kept.
5. **Containers are unprivileged**, with `security.idmap.isolated=true`. Root inside a container is not root on the host. Docker can run inside containers that use the default, `terrarium`, or `dev` profile.
6. **Config lives in LXD's database**: dqlite, project `terrarium-system`, key `user.terrarium.config_b64`. `/etc/terrarium/config.yaml` is only a transient or on-demand export. Never edit it by hand. Change settings with `terrariumctl set ...`.
7. **Work as the non-root `terrarium` user** inside containers. `trm exec` defaults to that user. Only the `dev` profile gives it passwordless sudo.

## Where each command runs

Commands in this file run in one of three places. Get this right before running anything.

| Context | Examples | Who |
| --- | --- | --- |
| **Host shell** (SSH to the VPS as root) | `terrariumctl ...`, `trm ...`, `lxc ...` | root on the Terrarium host |
| **Inside a container** | `apt-get`, `docker compose`, your app | reach it with `trm exec NAME -- CMD` from the host |
| **Your workstation** | `ssh`, provider CLIs (`hcloud`, `doctl`), DNS | wherever the agent runs |

If you run without a TTY, always pass a command: `trm exec NAME -- bash -lc '...'`. Plain `trm exec NAME` opens an interactive login shell.

## Requirements and sizing

- Ubuntu Server 24.04 or 26.04 LTS, x86_64 or arm64. Root access and key-based SSH.
- Strongly recommended: a **second, empty block volume** for ZFS (`--storage-mode disk`). Without one, use `--storage-mode file`, which puts a file-backed pool on the root disk (default size `64G`).
- Minimum: 2 vCPU, 4 GB RAM, 30–40 GB boot disk, 80–120 GB ZFS disk.
- Recommended: 4 vCPU, 8–16 GB RAM, 150–300 GB ZFS disk.
- ZFS sizing rule: 2–3× the live data you expect, to leave room for snapshot history.
- Provider fit: DigitalOcean, Hetzner Cloud, and Vultr support attachable volumes and private networks (use `disk` mode). Hostinger has no attachable volumes (use `file` mode).
- On 26.04, the first install builds the Cockpit ZFS Python binding from pinned source. This needs GitHub and PyPI access and takes longer.

## Install

Run as root on the fresh host.

### Interactive (for a human at the keyboard)

```bash
curl -fsSL https://github.com/terion-labs/terrarium/releases/latest/download/install.sh | bash
```

`install.sh` is a thin bootstrap. It downloads the release bundle, which contains the compiled `terrariumctl` and the Ansible assets, into `/opt/terrarium` and runs `terrariumctl install`. It accepts `--ref TAG` (a tag-like ref downloads that release, a branch-like ref such as `main` builds from source) and `--update`. It forwards every other flag to `terrariumctl install`. To pin a release:

```bash
curl -fsSL https://github.com/terion-labs/terrarium/releases/download/0.0.39/install.sh | bash
```

### Non-interactive (for agents and automation)

```bash
curl -fsSL https://github.com/terion-labs/terrarium/releases/latest/download/install.sh | bash -s -- \
  --non-interactive --yes \
  --email admin@example.com \
  --acme-email certs@example.com \
  --domain example.com \
  --idp local --idp-provider zitadel \
  --generate-root-pwd \
  --storage-mode disk --storage-source auto
```

Required in non-interactive mode: `--email`, `--idp`, and `--storage-mode`. You also need `--storage-source` for `disk` and `partition` modes. If root has no local password, you also need `--generate-root-pwd` or `--root-pwd-file`, because Cockpit uses a PAM login.

Pass secrets as files, not argv: `--root-pwd-file`, `--oidc-secret-file`, `--lxd-oidc-secret-file`, `--s3-secret-key-file`. Create them with `install -m 600 /dev/null /root/secret && printf '%s\n' 'value' > /root/secret`.

The installer checks integrations before it saves anything. It probes external OIDC (issuer, callback flow, client credentials) and runs a real write/delete against S3. In non-interactive mode, a failed check stops the install with an error.

### Install flags

| Area | Flags |
| --- | --- |
| Identity | `--email`, `--acme-email` (defaults to `--email`) |
| Domains | `--domain ROOT` (derives `manage.`, `proxy.`, `lxd.`, and `auth.` hosts from it); overrides: `--manage-domain`, `--proxy-domain`, `--lxd-domain`, `--auth-domain`. Without `--domain`, hosts default to `<svc>.<dashed-public-ip>.traefik.me` |
| IDP | `--idp local\|oidc`, `--idp-provider zitadel\|logto`, `--admin-group` (default `terrarium-admins`; required for `oidc`), `--oidc ISSUER`, `--oidc-client`, `--oidc-secret[-file]`, `--lxd-oidc-client`, `--lxd-oidc-secret[-file]`, `--oidc-groups-claim`, `--oidc-scopes`, `--lxd-oidc-groups-claim`, `--lxd-oidc-scopes`, `--zitadel-admin-email`, `--logto-admin-email`, `--logto-admin-username` (default `terrarium_admin`) |
| Cockpit root | `--generate-root-pwd` (writes `/etc/terrarium/secrets/cockpit_root_password`) or `--root-pwd-file PATH` |
| Storage | `--storage-mode disk\|partition\|file`, `--storage-source PATH\|auto`, `--storage-size 64G` (file mode) |
| S3 | `--enable-s3`, `--s3-endpoint` (default `https://s3.amazonaws.com`), `--s3-bucket`, `--s3-region` (default `us-east-1`), `--s3-prefix` (default `terrarium`), `--s3-access-key`, `--s3-secret-key[-file]` |
| Syncoid | `--enable-syncoid`, `--syncoid-target root@host`, `--syncoid-target-dataset backup/terrarium`, `--syncoid-ssh-key /root/.ssh/id_ed25519` |
| Control | `--non-interactive`, `--yes`, `--ref` |

Storage modes:

- `disk`: Terrarium takes over an entire empty non-root disk. Recommended.
- `partition`: an unused partition or free space on a non-root disk.
- `file`: a file-backed pool on the root filesystem.

Terrarium never shrinks the root filesystem. `--storage-source auto` picks the largest valid non-root target.

### Choosing the IDP

- `--idp local --idp-provider zitadel` is the default and uses fewer resources.
- `--idp local --idp-provider logto` is heavier but has a more polished admin and user UI. It runs Logto and Postgres inside `terrarium-idp`.
- `--idp oidc` points Terrarium at an external issuer (Google Workspace, Auth0, ZITADEL Cloud, Logto Cloud, ...). Add `--idp-provider logto` for Logto or Logto Cloud issuers.

### After install

The installer prints the endpoints and where to find the credentials:

- Cockpit `https://manage.<domain>`, Traefik dashboard `https://proxy.<domain>`, LXD UI/API `https://lxd.<domain>`, local IDP `https://auth.<domain>`.
- Local IDP bootstrap admin password:
  - ZITADEL: `lxc exec terrarium-idp -- cat /etc/terrarium/secrets/zitadel_admin_password`
  - Logto: `lxc exec terrarium-idp -- cat /etc/terrarium/secrets/logto_admin_password`
- Generated Cockpit root password: `/etc/terrarium/secrets/cockpit_root_password`.
- With custom domains, create A records for `manage.`, `proxy.`, `lxd.`, and `auth.` (local IDP only) pointing at the host's public IP. With the default `traefik.me` hosts, no DNS setup is needed.

Health check: `terrariumctl status` shows services, endpoints, IDP mode, admin group, and the oauth2-proxy state.

Access model: SSH is key-only. Cockpit requires OIDC login, then a PAM login as root. The Traefik dashboard requires OIDC login. LXD uses native OIDC. Management access is limited to members of the admin group, which is separate from per-app route groups.

## Containers

### Launching

`trm launch` wraps `lxc launch`. A plain `lxc launch` also works, and both get the Terrarium profiles.

```bash
trm launch ubuntu:24.04 web-01                                   # default profile
trm launch ubuntu:24.04 devbox --profile dev                     # dev sandbox with sudo
trm launch ubuntu:24.04 web-01 --disk 40G --memory 4G --cpu 2    # resource limits
trm launch ubuntu:24.04 app --proxy https://app.example.com:8080 # publish at launch
```

### Managed profiles

Each profile is a complete, standalone profile: it includes the network and root disk. Pass one of them. Repeating `--profile` layers profiles, as LXD does.

| Profile | Nesting / Docker | `terrarium` user sudo | Use for |
| --- | --- | --- | --- |
| `default` | yes | none | normal app containers |
| `terrarium` | yes | none | explicit alias of `default` |
| `strict` | no | none | workloads that don't need Docker or nesting |
| `dev` | yes | passwordless | agent sandboxes, dev boxes, anything that installs packages |
| `kvm` | adds `/dev/kvm` | n/a | **layered** on top of another profile (`--profile dev --profile kvm`); created only when the host exposes `/dev/kvm` |

All cloud-init images get a locked `terrarium` user (home `/home/terrarium`) with a Python venv at `~/.venvs/default` on its `PATH`.

### Running commands

```bash
trm exec NAME                               # login shell as terrarium
trm exec NAME -- bash -lc 'docker ps'       # run a command (always use "--")
trm exec NAME --root -- systemctl status x  # as root, for recovery or admin work
trm exec NAME --user ubuntu                 # another container user
```

Other useful commands: `lxc list`, `lxc list NAME -c n4` (private IPv4), `lxc stop|start|restart|delete NAME`, `lxc config show NAME`.

## Templating containers with `trm launch`

Provisioning flags generate cloud-init that runs inside the new container on first boot:

| Flag (all repeatable except `--cloud-init`) | Effect |
| --- | --- |
| `--playbook PATH\|GIT` | installs Ansible and runs `ansible-playbook -i localhost, -c local` |
| `--requirements PATH\|GIT` | runs `ansible-galaxy install` with roles and/or collections first |
| `--role NAME` | installs and runs a Galaxy role, e.g. `geerlingguy.docker` |
| `--docker-compose PATH\|GIT` | installs Docker and runs `docker compose -f FILE up -d` |
| `--var KEY=value` / `--vars file.env` | variables exported to provisioning shell, Ansible `--extra-vars`, and Compose `--env-file`. Inline `--var` overrides dotenv values |
| `--cloud-init PATH` | raw user-data that **replaces** the generated template. Cannot be combined with the flags above |
| `--proxy ROUTE` | validated and written to `user.proxy` |

Local files are embedded in the cloud-init. Git assets are cloned inside the container, using this format: `git+https://github.com/org/repo.git//path/in/repo.yml?ref=v1.0.0`. Pin `ref` to a tag or commit.

Execution order: packages, git clones, Galaxy requirements, Galaxy roles, playbooks, Docker Compose.

```bash
trm launch ubuntu:24.04 portal \
  --profile dev --disk 80G --memory 6G --cpu 4 \
  --vars ./portal.env --var APP_ENV=production \
  --requirements ./ansible/requirements.yml \
  --playbook ./ansible/base.yml \
  --docker-compose ./compose/portal.yml \
  --proxy https://portal.example.com:8080@auth:admins
```

Compose `ports:` publish inside the container only. Point `--proxy` at the container port.

Debugging (inside the container): `sudo cloud-init status --long`, `sudo tail -n 200 /var/log/cloud-init-output.log`, `sudo docker compose ps`, `sudo docker compose logs --tail=100`.

## Publishing services: the `user.proxy` label

Set the label from the host, then sync:

```bash
lxc config set NAME user.proxy "https://app.example.com:8080"
terrariumctl proxy sync
```

To edit it in the LXD UI: instance → Configuration → Edit YAML → `config: { user.proxy: ... }`.

### HTTP(S) grammar

```text
https://<public-host>[:container-port][/path][@auth[:group[,group...]][~callback-host]]
http://<public-host>[:container-port][/path][@auth...]      # plain HTTP only when intended
```

- `https://` gets a Let's Encrypt certificate and redirects HTTP to HTTPS. Public listeners are always 80/443.
- `:port` is the port inside the container. The default is `80`.
- `/path` is matched as a prefix. Query strings and fragments are not allowed.
- `@auth` requires an OIDC login. `@auth:g1,g2` also requires membership in any listed group. Group names may contain letters, digits, `.`, `_`, and `-`.
- `~callback-host` is required only for wildcard hosts with `@auth`. It gives the concrete oauth2-proxy callback host.
- You can put several routes in one label, separated by commas or newlines. `user.proxy` is a single key, so **set all of a container's routes in one value**. Setting it again replaces the previous routes.

```bash
lxc config set app user.proxy "https://app.example.com:8080,https://api.example.com:3000/api"
lxc config set tool user.proxy "https://tool.example.com:3000@auth:admins,devops"
lxc config set hermes user.proxy "https://hermes-api.example.com:8642,https://hermes-dash.example.com:9119@auth"
```

### TCP / UDP

```text
tcp://<public-port>:<container-port>
udp://<public-port>:<container-port>
```

```bash
lxc config set postgres user.proxy "tcp://15432:5432"
```

Raw transport has no hostnames, paths, TLS, or `@auth`. Terrarium creates a Traefik entrypoint and opens the managed UFW port.

### Wildcards (DNS-01)

```bash
terrariumctl set dns provider cloudflare CF_DNS_API_TOKEN:token
terrariumctl set dns provider route53 AWS_ACCESS_KEY_ID:k AWS_SECRET_ACCESS_KEY:s AWS_REGION:us-east-1
lxc config set app user.proxy "https://*.example.com:8080"
lxc config set ui user.proxy "https://*.example.com:3000@auth:admins~auth.example.com"
terrariumctl set dns provider        # no args: disable DNS-01, return to HTTP-01
```

Provider codes and variable names are lego's: https://go-acme.github.io/lego/dns/index.html. Traefik supports one DNS provider at a time.

### Route rules and gotchas

- The container must be in the default LXD project and have an IPv4 address on the Terrarium network.
- Duplicate host/path claims and duplicate TCP/UDP public ports are rejected during sync. `proxy sync` exits non-zero on errors, so read its output.
- `@auth` routes must be under the Terrarium root domain. For example, with root `example.com` you can protect `app.example.com` but not `other.com`. With the default `traefik.me` setup, use `app.<dashed-ip>.traefik.me`. It resolves with no DNS work.
- Non-wildcard custom hosts need a DNS A record pointing at the host (or at every node in a cluster).
- **API endpoints that clients call with API keys should not use `@auth`.** OAuth redirects break non-browser clients. Protect them with the app's own auth instead.
- Keep the app's own password or token enabled even behind `@auth`, as defense in depth.

## Authentication and the IDP

Terrarium uses one OIDC client for Cockpit's oauth2-proxy, LXD, and `@auth` routes. LXD can use a separate client (`--lxd-oidc-client` plus `--lxd-oidc-secret-file`).

**Local IDP (ZITADEL or Logto):** Terrarium provisions the clients, creates the admin role (named after the admin group, default `terrarium-admins`), grants it to the bootstrap admin, and emits the claim. ZITADEL emits a flat `groups` claim. Logto uses `roles` with scopes `openid profile email roles`. With local ZITADEL, `proxy sync` also registers each `@auth` route's callback URL. `terrariumctl idp sync` reconciles local IDP apps, roles, and claims. Create users and assign roles in the IDP's admin UI at `https://auth.<domain>`.

**External OIDC:** Terrarium never changes your provider. You must configure:

- Callbacks: `https://<manage-domain>/oauth2/callback`, `https://<proxy-domain>/oauth2/callback`, `https://<lxd-domain>/oidc/callback`.
- A callback for every `@auth` route: `https://<host>/oauth2/callback` for root routes, or `https://<host>/oauth2/<path>/callback` for path routes (e.g. `/admin` → `/oauth2/admin/callback`). Add these whenever you create a protected route.
- The groups/roles claim as a JSON string array containing the admin group. Generic OIDC and ZITADEL default to `groups`. Logto defaults to `roles`. A role assignment on the provider side is not enough unless the token or userinfo actually carries the claim.
- ZITADEL Cloud also needs "Return user roles during authentication" and "User roles inside ID Token" enabled, plus a Complement Token Action that copies project roles into `groups`. The script is at https://terrarium.terion.name/getting-started/domains-and-auth.

## Sharing data between containers

**Local shared volume** (fast, on ZFS, stays on this VPS):

```bash
lxc storage volume create terrarium agent-memory
lxc storage volume attach terrarium agent-memory openclaw agent-memory /srv/shared-memory
lxc storage volume attach terrarium agent-memory hermes   agent-memory /srv/shared-memory
lxc exec openclaw -- chown -R terrarium:terrarium /srv/shared-memory
```

For example, mount one volume at `/home/terrarium/.codex` in several containers to share a CLI login.

**External SMB/CIFS storage** (e.g. a Hetzner Storage Box; survives VPS loss, can also be mounted from a laptop, slower):

```bash
terrariumctl mount add cifs /srv/shared/storage-box //u12345.your-storagebox.de/backup u12345 --password-file /root/sb-pass
terrariumctl mount add cifs /srv/shared/storage-box //u12345.your-storagebox.de/backup u12345 --container app --container-path /mnt/shared
terrariumctl mount attach /srv/shared/storage-box app /mnt/shared
terrariumctl mount list
terrariumctl mount remove /srv/shared/storage-box
```

Subaccounts use `//u12345-sub1.your-storagebox.de/u12345-sub1 u12345-sub1`. Credentials are stored under `/etc/terrarium/mounts/`, and the mount is written as a managed `/etc/fstab` block. SMB encryption is on by default (`--seal true`). Prefer `mount add --container` or `mount attach` over a raw `lxc config device add ... disk source=...`, because they remap ownership for unprivileged containers. Don't put databases or active git repositories on SMB.

## Backups and restore

Automatic layers:

- sanoid ZFS snapshots every 15 minutes, with the retention described above.
- Optional S3 export, hourly timer: compressed incremental ZFS streams.
- Optional syncoid replication, hourly, to another ZFS host over SSH.

```bash
terrariumctl backup list                                   # local snapshots + S3 manifests
terrariumctl backup export                                 # push to S3 now
terrariumctl backup restore --instance app                 # in place, latest snapshot (OVERWRITES)
terrariumctl backup restore --instance app --at autosnap_2026-04-19_10:00:00_hourly
terrariumctl backup restore --instance app --as-new app-restored
terrariumctl backup restore --source s3 --instance app     # from S3
```

- In-place restore stops the container, rolls it back, and **destroys newer state**. It asks for confirmation.
- `--as-new` restores to a separate dataset and then hands off to the upstream **interactive** `lxd recover`. The restored copy has its `user.proxy` removed, so it can't take over live traffic.
- Both restore paths need a TTY and a human confirmation. An agent without a TTY should prepare the exact command and ask the user to run it.
- Before a risky change, a quick non-interactive checkpoint with plain LXD works too: `lxc snapshot app pre-change`, then roll back with `lxc restore app pre-change`.

Local IDP data lives in `terrarium-idp` and is covered by the same machinery: `terrariumctl idp status|logs [--lines N]|backup|restore [--source local|s3] [--at ...] [--as-new NAME]`.

## Golden images

A golden image turns a configured container into a reusable template:

```bash
trm image create web-01 golden-web                      # temporary snapshot, sanitized, published
trm image create web-01 golden-web --snapshot known-good
trm image create web-01 golden-web --live               # no temporary snapshot
trm image create web-01 golden-web --snapshot known-good --reuse   # replace existing alias
trm image launch golden-web web-02 --profile dev --disk 40G --proxy https://web-02.example.com:8080
trm image list
trm image delete golden-web
```

Images are stripped of `user.proxy` and LXD proxy devices. `image launch` accepts `--profile`, `--disk`, `--memory`, `--cpu`, and `--proxy`.

## Reconfiguration and updates

Each `set` command saves to the dqlite store, re-runs Ansible (skipping OS hardening), and re-syncs the proxy and IDP:

```bash
terrariumctl set domains example.com [--manage-domain ...] [--proxy-domain ...] [--lxd-domain ...] [--auth-domain ...]
terrariumctl set emails --email ops@example.com --acme-email certs@example.com
terrariumctl set idp local --provider zitadel|logto
terrariumctl set idp oidc [--provider logto] --oidc https://issuer --oidc-client terrarium \
  --oidc-secret-file /root/oidc-secret --admin-group terrarium-admins
terrariumctl set s3 --enable --s3-endpoint https://... --s3-bucket b --s3-region r \
  --s3-access-key AK --s3-secret-key-file /root/s3-secret      # also: --disable
terrariumctl set syncoid --enable --syncoid-target root@backup --syncoid-target-dataset backup/terrarium \
  --syncoid-ssh-key /root/.ssh/id_ed25519                      # also: --disable
terrariumctl set dns provider [code] [KEY:VALUE...]
terrariumctl reconfigure                  # full re-apply from saved config
terrariumctl update [--ref TAG] [--skip-reconfigure]
terrariumctl config export | import       # YAML copy at /etc/terrarium/config.yaml (root-only)
terrariumctl completion bash|zsh|fish [install]   # or: completion all install
```

- `set idp oidc` and `set s3` run the same live checks as the installer before saving.
- Switching between local providers reuses `terrarium-idp` and disables the other provider's services. Take an IDP backup first.
- Running the installer again on an existing host offers to update. `install.sh --update` behaves the same as `terrariumctl update`.

## Clustering (optional)

This is native LXD clustering over a WireGuard mesh (default `10.255.54.0/24`, UDP `51820`), with the `terrarium-ovn` overlay spanning all nodes. Use at least 3 nodes for quorum. Put them in the same region, on a provider private network if one is available.

```bash
# node1 (Terrarium installed):
terrariumctl cluster init [--wireguard-endpoint 10.42.0.11:51820]
terrariumctl cluster invite node2 [10.42.0.12]     # prints the join command
# node2 (fresh host, Terrarium installed):
terrariumctl cluster join --token '<token>' --wireguard '<bundle>' --yes
```

- Joining **wipes the joining node's local LXD state**. Join only fresh nodes.
- Provider firewalls should allow only `51820/udp` between member IPs. Never expose `8443`, `6641`, `6642`, or `6081`; they travel inside WireGuard, and OVN also uses mTLS.
- Traefik runs on every node, and any node can serve any published route. Use round-robin A records or a load balancer.
- A container still lives on one node's disk. Clustering gives you one management plane, not automatic HA.

Operations:

```bash
terrariumctl cluster status
terrariumctl cluster move app1 node2
terrariumctl cluster evacuate node2 --yes
terrariumctl cluster restore node2 --yes
terrariumctl cluster remove node2 --move [--target node1] --yes
terrariumctl cluster remove node2 --force          # dead node; metadata only
terrariumctl cluster ovn configure                 # then `terrariumctl reconfigure` on other members
terrariumctl cluster token node3                   # raw LXD token only
```

## Recipes

Each recipe is condensed. Full guides are at https://terrarium.terion.name/guides/.

**AI agent sandbox (OpenClaw, Hermes, Codex/Claude CLIs, ...)**

```bash
trm launch ubuntu:24.04 agent --profile dev --disk 40G --memory 4G
trm exec agent -- bash -lc 'sudo apt-get update && sudo apt-get install -y git curl'
# install the agent as the terrarium user; keep its UI private (SSH tunnel / Tailscale inside the container),
# or bind it to 0.0.0.0 with its own password and publish behind SSO:
lxc config set agent user.proxy "https://agent.example.com:18789@auth"
terrariumctl proxy sync
```

- OpenClaw: gateway on port `18789`. For public access set `"bind": "lan"` and password auth in `~/.openclaw/openclaw.json`.
- Hermes: API on `8642`. Publish it without `@auth` and protect it with `API_SERVER_KEY`. Dashboard on `9119`, run with `--insecure`, and **only** publish it with `@auth`.
- To keep an agent's memory outside the VPS, attach an external mount at the memory path (`~/.openclaw/workspace`, `~/.hermes/memories`).

**Browser IDE (code-server):** in a `dev` container, install with `curl -fsSL https://code-server.dev/install.sh | sh`. Write `~/.config/code-server/config.yaml` with `bind-addr: 0.0.0.0:8080`, `auth: password`, a random `password:`, and `cert: false` (Traefik terminates TLS). Then run `sudo systemctl enable --now code-server@terrarium` and publish with `https://code.example.com:8080@auth`.

**Docker Compose stack:** `trm launch ubuntu:24.04 stack --profile dev --docker-compose ./compose.yml --proxy https://app.example.com:8080`. Publish only the frontend port and leave the database without `ports:`.

**Dokploy / Coolify:** run the control plane in one `dev` container behind `@auth` (Dokploy on `:3000`; Coolify on `:8000` for setup, then `:80`). Deployment servers are separate containers that the control plane reaches over SSH on their private IP (`lxc list NAME -c n4`). Coolify can use `terrarium` with sudo; Dokploy needs root with key-only SSH. Terrarium owns ingress, so add each app domain to the app server's `user.proxy` pointing at `:80`. Traffic flows: Terrarium Traefik → app-server container → platform proxy → app.

## Troubleshooting checklist

1. Route not responding: is the service bound to `0.0.0.0` inside the container (`trm exec NAME -- ss -ltnp`)? Did `terrariumctl proxy sync` exit 0? Does DNS resolve to the host? Check the Traefik dashboard at `proxy.<domain>`.
2. `@auth` loop or 403: with an external IDP, is the route callback registered? Does the token carry the configured claim (`groups` or `roles`) with the required group? Is the host under the root domain?
3. Launch looks stuck: cloud-init is still running. Check `cloud-init status --long` and `/var/log/cloud-init-output.log`.
4. Docker fails in a container: the container is on `strict`. Use `default` or `dev`.
5. `sudo` denied for `terrarium`: expected outside the `dev` profile. Use `trm exec NAME --root` or relaunch with `--profile dev`.
6. Host state: `terrariumctl status`, `terrariumctl idp status`, `journalctl -u traefik`, `systemctl list-timers 'terrarium*'`.

## Reference: paths and ports

| Path | Contents |
| --- | --- |
| `/opt/terrarium/` | installed bundle (`terrariumctl` binary and Ansible assets) |
| `/usr/local/bin/terrariumctl`, `/usr/local/bin/trm` | CLI |
| `/etc/terrarium/secrets/` | generated secrets (root-only) |
| `/etc/terrarium/mounts/` | managed SMB credentials |
| `/etc/terrarium/config.yaml` | optional export only; do not edit |
| `/var/lib/terrarium/` | state, S3 manifests, oauth2-proxy config |

Public ports: `22/tcp` (key-only SSH), `80/tcp`, `443/tcp`, plus any `tcp://` or `udp://` route ports you publish. In a cluster, add `51820/udp` between members only.

## Rules for agents operating a Terrarium host

- Keep services private unless the user asks to publish them. Default to `@auth` for anything with an admin UI.
- Never put secrets on the command line when a `*-file` flag exists. Never print secret files into logs or chat unless the user asks.
- Change config with `terrariumctl set ...`, not by editing `/etc/terrarium/config.yaml` or the dqlite key.
- Confirm with the user before any of these: in-place `backup restore`, `cluster join` (wipes LXD on that node), `cluster remove --force`, `mount remove`, `lxc delete`, `set idp` (can lock users out of management UIs), `set domains` (changes every management URL).
- Take an `lxc snapshot NAME pre-<change>` before risky work inside a container. Automatic snapshots only run every 15 minutes.
- Work inside containers as `terrarium`. Use `--root` only when needed.
- Each `lxc config set NAME user.proxy` replaces the previous value. Read the current value with `lxc config get NAME user.proxy` before you change it.

## Human documentation index

- Installation: https://terrarium.terion.name/getting-started/installation
- First instance: https://terrarium.terion.name/getting-started/creating-first-instance
- Templating (`trm launch`): https://terrarium.terion.name/getting-started/templating
- Storage and sizing: https://terrarium.terion.name/getting-started/storage
- Domains, routes, auth: https://terrarium.terion.name/getting-started/domains-and-auth
- Management GUIs: https://terrarium.terion.name/getting-started/management-guis
- Shared data: https://terrarium.terion.name/getting-started/shared-data-between-containers
- External storage: https://terrarium.terion.name/getting-started/external-shared-storage
- Reconfiguration: https://terrarium.terion.name/operations/reconfiguration
- Backups and restore: https://terrarium.terion.name/operations/backups-and-restore
- Golden images: https://terrarium.terion.name/operations/golden-images
- Clustering: https://terrarium.terion.name/operations/clustering
- CLI reference: https://terrarium.terion.name/reference/terrariumctl
- Services and endpoints: https://terrarium.terion.name/reference/services-and-endpoints
- Security model: https://terrarium.terion.name/security
- Architecture: https://terrarium.terion.name/architecture
- Guides (OpenClaw, Hermes, code-server, Compose, Dokploy, Coolify, OIDC): https://terrarium.terion.name/guides/
- Providers (DigitalOcean, Hetzner, Vultr, Hostinger): https://terrarium.terion.name/providers/

## Native Linux VMs

Use `trm launch ubuntu:24.04 NAME --vm --wait` or Ubuntu 26.04. `--target MEMBER` chooses placement; the member must advertise VM support for the image architecture. `--timeout SECONDS` bounds agent/cloud-init readiness (default 300). VM defaults are 2 CPUs, 2 GiB RAM, and 20 GiB root storage. Select `vm-dev` for passwordless sudo; container profiles, including `kvm`, are incompatible with `--vm`.

Both launch entry points accept the same provisioning, variable, resource, and route options. Local golden VM images infer type without `--vm`. Use `trm exec NAME` for the terrarium user and `--root` explicitly. If the agent cannot connect, inspect `lxc console NAME` and cloud-init; never replay an ambiguous user command automatically.

VM service listeners must bind to a guest network interface, not only loopback. Existing `user.proxy` HTTP/HTTPS/TCP/UDP/auth labels work unchanged. Host-local `terrarium-ingress-*` helper containers provide the OVN path; leave these infrastructure instances out of workload operations.

A VM backup is a metadata filesystem plus a block volume from one atomic snapshot. Use `trm backup restore` for reconstruction, `--as-new` for a separate copy, and `--source s3` for off-host restore. Versioned S3 chains carry checksums and source identity; retain every referenced parent and component. In-place restore retains previous disks and asks before replacement. LXD recovery remains interactive. New VM copies prepare guest identities in network quarantine before normal use.

`trm mount attach HOST_PATH VM /guest/path` supports directories and CIFS through LXD, using the terrarium guest UID/GID. Ownership changes cannot disrupt existing share consumers. Prefer `--instance`/`--instance-path`; old container flag names remain aliases. Detach host-bound devices before `trm cluster move VM MEMBER`. Movement preflights capability, architecture and storage, then uses bounded graceful shutdown; a stop failure does not authorize forced power off.

See https://terrarium.terion.name/getting-started/virtual-machines for the full operator workflow.
