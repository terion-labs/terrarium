# terrariumctl

`terrariumctl` (or its shortcut alias `trm`) is the primary command-line tool for managing your Terrarium server. It handles installation, status checks, reconfiguration, proxy syncing, IDP syncing, backup exports, and restores.

## Top-Level Commands

| Command | Arguments | Defaults | Meaning |
| --- | --- | --- | --- |
| `terrariumctl install` | optional flags, see below | interactive mode | Installs or bootstraps Terrarium on the current host, including preflight verification for external OIDC and S3 when enabled. |
| `terrariumctl status` | none | n/a | Shows Terrarium service status, management endpoints, IDP mode, admin group, and the oauth2-proxy state. |
| `terrariumctl launch` | required: image and instance name; optional provisioning flags | normal LXD launch with optional generated cloud-init | Launches an LXD container, optionally applying resource limits, generated Ansible/Docker Compose provisioning, and a Terrarium `user.proxy` label. |
| `terrariumctl image create` | required: instance and image alias; optional: `--snapshot`, `--live`, `--reuse` | creates a temporary snapshot and sanitized image | Publishes a reusable golden LXD image from a container or snapshot without carrying published-route proxy config into the image. |
| `terrariumctl image launch` | required: image alias and new instance name; optional launch flags | same as `terrariumctl launch` | Launches a new container from a Terrarium golden image. |
| `terrariumctl image list/delete` | optional image alias for delete | n/a | Lists or removes local LXD images. |
| `terrariumctl exec` | required: instance name; optional command after `--`, `--root`, `--user` | `terrarium` login shell | Opens a shell or runs a command inside a container as the non-root `terrarium` user by default. |
| `terrariumctl backup list` | none | n/a | Lists local ZFS snapshots and, when enabled, S3 manifests. |
| `terrariumctl backup export` | none | n/a | Uploads the current incremental ZFS backup chain to configured S3 storage. |
| `terrariumctl backup restore` | required: `--instance`; optional: `--source`, `--at`, `--as-new` | `--source local`, latest restore point, in-place restore | Restores an instance either in place by default or as a new instance when `--as-new` is provided. |
| `terrariumctl reconfigure` | none | n/a | Re-runs the local Ansible reconciliation using the saved config. |
| `terrariumctl update` | optional: `--ref`, `--skip-reconfigure` | latest release, reconfigure after update | Updates installed Terrarium code/assets, refreshes Ansible collections, and re-runs reconciliation using the saved config. |
| `terrariumctl config import` | none | n/a | Imports `/etc/terrarium/config.yaml` into the LXD dqlite-backed config store. |
| `terrariumctl config export` | none | n/a | Recreates `/etc/terrarium/config.yaml` from the LXD dqlite-backed config store. |
| `terrariumctl cluster status` | none | n/a | Shows LXD cluster state and the Terrarium OVN workload network. |
| `terrariumctl cluster init` | optional: `--member`, `--wireguard-endpoint`, `--wireguard-cidr`, advanced `--address`, `--central-addresses`, `--peer-cidr` | member from hostname, WireGuard endpoint auto-discovered, mesh CIDR `10.255.54.0/24` | Enables LXD clustering on the first member, creates the WireGuard mesh, and reconciles Terrarium cluster networking. |
| `terrariumctl cluster invite` | required: member name; optional: peer IP/CIDR or `--peer-cidr` | member name resolution when possible | Mints a single-use LXD cluster join token, creates a one-time WireGuard join bundle, temporarily opens the joining peer, and prints the join command. |
| `terrariumctl cluster token` | required: member name | n/a | Mints only the single-use LXD cluster join token for another member. |
| `terrariumctl cluster join` | required: `--token`; normally also `--wireguard`; optional: `--yes` | storage pool `terrarium` | Starts the WireGuard mesh, joins this node to an existing LXD cluster, and exports the shared Terrarium config. |
| `terrariumctl cluster evacuate` | required: member name | n/a | Asks LXD to evacuate workloads from a member for maintenance. |
| `terrariumctl cluster restore` | required: member name | n/a | Restores an evacuated member to normal cluster service. |
| `terrariumctl cluster move` | required: workload name, target member | n/a | Moves one workload to another LXD cluster member without renaming it. |
| `terrariumctl cluster remove` | required: member name; optional: `--move`, `--target`, `--force`, `--yes` | prompts before workload moves and removal | Removes a member from the LXD cluster, optionally moving workloads first. |
| `terrariumctl cluster ovn configure` | optional: `--central-addresses`, `--peer-cidr` | discovers LXD member addresses and keeps an odd OVN central set | Updates shared OVN and cluster firewall settings, then reconciles the host. |
| `terrariumctl proxy sync` | none | n/a | Rebuilds Traefik dynamic config, host-loopback LXD proxy backend devices, and Terrarium-managed UFW rules from LXC `user.proxy` labels. |
| `terrariumctl mount add` | required: `protocol`, `hostPath`, `address`, `username`; optional: `-p/--password`, `--password-file`, `--container`, `--seal` | password prompt, host `uid=0`, host `gid=0`, container-aware uid/gid when `--container` is set, `file_mode=0660`, `dir_mode=0770`, `--seal=true` | Creates a managed host SMB/CIFS mount, stores credentials under `/etc/terrarium/mounts`, writes a managed `/etc/fstab` block, and mounts it immediately. |
| `terrariumctl mount remove` | required: `hostPath` | n/a | Unmounts a Terrarium-managed host mount, removes its managed `/etc/fstab` block, and deletes its managed credentials file. |
| `terrariumctl mount list` | none | n/a | Lists Terrarium-managed host mounts, including whether each one is currently mounted. |
| `terrariumctl idp sync` | none | n/a | Reconciles self-hosted ZITADEL or Logto applications, Terrarium management roles/claims, local OIDC settings, and client output files. No-op unless local IDP mode is enabled. |
| `terrariumctl idp status` | none | n/a | Shows the managed `terrarium-idp` instance and provider-specific compose services. |
| `terrariumctl idp logs` | optional: `--lines` | `120` | Prints recent provider-specific compose logs from inside the managed IDP instance. |
| `terrariumctl idp backup` | none | local snapshot; exports to S3 when enabled | Creates a manual recursive snapshot of the managed IDP instance. |
| `terrariumctl idp restore` | optional: `--source`, `--at`, `--as-new` | `--source local`, latest restore point, in-place restore | Restores the managed IDP instance through the normal Terrarium backup/restore flow. |
| `terrariumctl set domains` | optional `rootDomain`, plus override flags | `manage.<rootDomain>`, `lxd.<rootDomain>`, `auth.<rootDomain>` when applicable | Updates the root domain, derived Terrarium subdomains, re-verifies external OIDC when needed, and re-runs reconciliation. |
| `terrariumctl set emails` | optional flags | existing values when omitted | Updates Terrarium contact, ACME, and ZITADEL admin emails. |
| `terrariumctl set idp local|oidc` | mode plus optional flags | n/a | Switches between self-hosted ZITADEL and external OIDC, verifies external OIDC settings when applicable, and reconfigures oauth2-proxy plus LXD management auth together. |
| `terrariumctl set s3` | optional flags | keeps current enable/disable state unless `--enable` or `--disable` is passed | Updates S3 backup settings, verifies the target with a real test operation, and can enable or disable S3 exports. |
| `terrariumctl set syncoid` | optional flags | keeps current enable/disable state unless `--enable` or `--disable` is passed | Updates syncoid replication settings and can enable or disable syncoid. |
| `terrariumctl completion` | `bash`, `zsh`, `fish`, or `all install` | print script unless `install` is used | Prints or installs shell completion. Install/update also refresh completion for detected shells automatically. |

## launch

`trm launch` wraps `lxc launch` and adds Terrarium provisioning shortcuts. Basic LXD-style launches work as expected:

```bash
trm launch ubuntu:24.04 web-01
trm launch ubuntu:24.04 web-01 --profile dev
trm launch ubuntu:24.04 web-01 --disk 40G --memory 4G --cpu 2
```

For a more practical walkthrough with Ansible, Docker Compose, variables, Git assets, and proxy labels, see [Templating Containers with `trm launch`](../getting-started/templating.md).

Provisioning flags generate cloud-init user-data that installs the needed packages and runs inside the new container:

```bash
trm launch ubuntu:24.04 web-01 --playbook ./site.yml
trm launch ubuntu:24.04 web-01 --requirements ./requirements.yml --playbook ./site.yml
trm launch ubuntu:24.04 docker-01 --role geerlingguy.docker
trm launch ubuntu:24.04 app-01 --docker-compose ./docker-compose.yml
```

`--requirements`, `--playbook`, `--role`, and `--docker-compose` can each be passed multiple times and can be combined. Local files are embedded into cloud-init. Git assets use this form:

```bash
trm launch ubuntu:24.04 app-01 \
  --requirements ./requirements.yml \
  --playbook git+https://github.com/org/repo.git//site.yml?ref=v1.0.0 \
  --docker-compose git+https://github.com/org/repo.git//docker-compose.yml?ref=v1.0.0
```

Launch variables can be passed inline or through dotenv files:

```bash
trm launch ubuntu:24.04 app-01 \
  --vars ./app.env \
  --var APP_VERSION=1.2.3 \
  --playbook ./site.yml \
  --docker-compose ./docker-compose.yml
```

Variables are exported to generated provisioning commands, passed to Ansible as extra vars, and supplied to Docker Compose with `--env-file`. Inline `--var KEY=value` entries override the same key from earlier `--vars` files.

To provide your own cloud-init completely, use `--cloud-init`. It cannot be combined with the generated Ansible or Docker Compose shortcuts:

```bash
trm launch ubuntu:24.04 raw-01 --cloud-init ./user-data.yml
```

`--proxy` validates and sets the Terrarium `user.proxy` label at launch time. Repeat it to publish multiple routes:

```bash
trm launch ubuntu:24.04 app-01 \
  --docker-compose ./docker-compose.yml \
  --proxy https://app.example.com:8080 \
  --proxy https://admin.example.com:3000@auth:admins
```

## image

`trm image` creates and manages named golden images. Use it when a container is
configured exactly how you want and you want to launch more containers from that
state later.

Create an image from the current instance state:

```bash
trm image create web-01 golden-web
```

By default, Terrarium creates a temporary LXD snapshot, copies it to a temporary
instance, removes `user.proxy` and LXD proxy devices from that copy, publishes
the image, and then removes the temporary resources. This keeps the image from
accidentally inheriting the source container's public route.

Create an image from an existing snapshot:

```bash
trm image create web-01 golden-web --snapshot known-good
```

Use `--live` when you explicitly want to publish the current instance state
without creating a temporary snapshot first:

```bash
trm image create web-01 golden-web --live
```

If the alias already exists and you intentionally want to replace it, add
`--reuse`:

```bash
trm image create web-01 golden-web --snapshot known-good --reuse
```

Launch from a golden image:

```bash
trm image launch golden-web web-02 --profile dev
```

`image launch` accepts the same basic launch flags as `trm launch`: `--profile`,
`--disk`, `--memory`, `--cpu`, and `--proxy`.

List or remove images:

```bash
trm image list
trm image delete golden-web
```

## install

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--non-interactive` | none | no | interactive mode if omitted | Disables prompts and requires all needed config through flags. |
| `--yes` | none | no | prompt before destructive actions | Auto-confirms destructive or confirmation prompts. |
| `--ref` | git branch or tag | no | `main` when invoking `terrariumctl` directly; release-selected tag when run through `install.sh` | Installs a specific Terrarium release tag, or builds from a branch-like source ref such as `main`. |
| `--email` | email address | yes in non-interactive mode; no in interactive mode | prompted in interactive mode | Sets the Terrarium contact/admin email and the default local-provider bootstrap admin email. |
| `--acme-email` | email address | no | falls back to `--email` | Sets the ACME account identity for Traefik and LXD certificate automation. |
| `--domain` | root domain | no | service domains default to `<service>.<dashed-public-ip>.traefik.me` when omitted | Sets the root domain used to derive service subdomains. |
| `--manage-domain` | domain | no | `manage.<domain>` when `--domain` is set, otherwise `manage.<dashed-public-ip>.traefik.me` | Overrides the Cockpit domain. |
| `--proxy-domain` | domain | no | `proxy.<domain>` when `--domain` is set, otherwise `proxy.<dashed-public-ip>.traefik.me` | Overrides the Traefik dashboard domain. |
| `--lxd-domain` | domain | no | `lxd.<domain>` when `--domain` is set, otherwise `lxd.<dashed-public-ip>.traefik.me` | Overrides the LXD domain. |
| `--idp` | `local` or `oidc` | yes in non-interactive mode; no in interactive mode | prompted in interactive mode | Selects whether Terrarium uses a self-hosted provider or an external OIDC issuer. |
| `--idp-provider` | `zitadel` or `logto` | no | local mode defaults to `zitadel`; external OIDC defaults to generic provider behavior when omitted | Selects provider-specific defaults. `logto` uses the `roles` claim and `openid profile email roles` scopes. |
| `--admin-group` | group name | yes when `--idp=oidc`; no otherwise | `terrarium-admins` when `--idp=local`, otherwise prompted in interactive mode | Sets the management admin group that is allowed into Cockpit and LXD. |
| `--oidc` | issuer URL | yes when `--idp=oidc`; no otherwise | derived from `https://<auth-domain>` when `--idp=local` | Sets the OIDC issuer URL. |
| `--oidc-client` | client ID | yes when `--idp=oidc`; no otherwise | none | Sets the external OIDC client ID used by Cockpit's oauth2-proxy, LXD, and published-route auth. |
| `--oidc-secret` | client secret | yes when `--idp=oidc` and `--oidc-secret-file` is omitted; no otherwise | none | Sets the external OIDC client secret used by Cockpit's oauth2-proxy, LXD, and published-route auth. Prefer `--oidc-secret-file` for automation. |
| `--oidc-secret-file` | path | yes when `--idp=oidc` and `--oidc-secret` is omitted; no otherwise | none | Reads the external OIDC client secret from a root-readable file. |
| `--lxd-oidc-client` | client ID | no | falls back to `--oidc-client` | Uses a separate external OIDC client for LXD. |
| `--lxd-oidc-secret` | client secret | no | falls back to `--oidc-secret` | Sets the separate LXD OIDC client secret. Prefer `--lxd-oidc-secret-file` for automation. |
| `--lxd-oidc-secret-file` | path | no | none | Reads the separate LXD OIDC client secret from a root-readable file. |
| `--auth-domain` | domain | no | `auth.<domain>` when `--domain` is set and local IDP is enabled, otherwise `auth.<dashed-public-ip>.traefik.me` | Overrides the local identity-provider auth domain. |
| `--oidc-groups-claim` | claim name | no | `roles` for Logto, otherwise `groups` | Overrides the management oauth2-proxy groups/roles claim. |
| `--oidc-scopes` | space-separated scopes | no | `openid profile email roles` for Logto, otherwise `openid profile email` | Overrides the management oauth2-proxy OIDC scopes. |
| `--lxd-oidc-groups-claim` | claim name | no | follows provider default unless set | Overrides the LXD OIDC groups/roles claim. |
| `--lxd-oidc-scopes` | space-separated scopes | no | follows provider default unless set | Overrides the LXD OIDC scopes. |
| `--zitadel-admin-email` | email address | no | falls back to `--email` | Sets the initial admin email for self-hosted ZITADEL. |
| `--logto-admin-email` | email address | no | falls back to `--email` for local Logto | Sets the bootstrap admin email for self-hosted Logto. |
| `--logto-admin-username` | username | no | `terrarium_admin` for local Logto | Sets the bootstrap admin username for self-hosted Logto. Whitespace and control characters are rejected. |
| `--generate-root-pwd` | none | yes in non-interactive mode when root has no usable local password unless `--root-pwd-file` is passed; no otherwise | none | Generates a strong Cockpit root password and saves it to `/etc/terrarium/secrets/cockpit_root_password` with root-only permissions. |
| `--root-pwd-file` | path | yes in non-interactive mode when root has no usable local password unless `--generate-root-pwd` is passed; no otherwise | none | Reads the Cockpit root password from a local file. |
| `--storage-mode` | `disk`, `partition`, or `file` | yes in non-interactive mode; no in interactive mode | prompted or auto-selected in interactive mode | Selects how the LXD ZFS pool is created. |
| `--storage-source` | path or `auto` | yes for `disk` and `partition` in non-interactive installs; no in interactive mode | prompted when needed in interactive mode | Sets the source disk or partition for `disk` or `partition` mode, or uses `auto` to pick the largest valid target. |
| `--storage-size` | size string | only for `file` mode when overriding the default | `64G` in interactive prompts and non-interactive fallback | Sets the size of the file-backed ZFS pool for `file` mode. |
| `--enable-s3` | none | no | disabled | Enables S3-backed archive exports. |
| `--s3-endpoint` | URL | only when using a custom S3-compatible provider | `https://s3.amazonaws.com` when omitted | Sets a custom S3-compatible API endpoint. |
| `--s3-bucket` | bucket name | yes if `--enable-s3` is set | none | Sets the destination bucket for S3 exports. |
| `--s3-region` | region name | no | `us-east-1` when omitted | Sets the S3 region. |
| `--s3-prefix` | prefix | no | `terrarium` | Sets the object prefix under the bucket. |
| `--s3-access-key` | access key | yes if `--enable-s3` is set | none | Sets the S3 access key. |
| `--s3-secret-key` | secret key | yes if `--enable-s3` is set and `--s3-secret-key-file` is omitted | none | Sets the S3 secret key. Prefer `--s3-secret-key-file` for automation. |
| `--s3-secret-key-file` | path | yes if `--enable-s3` is set and `--s3-secret-key` is omitted | none | Reads the S3 secret key from a root-readable file. |
| `--enable-syncoid` | none | no | disabled | Enables syncoid replication to a second ZFS host. |
| `--syncoid-target` | host | yes if `--enable-syncoid` is set | none | Sets the remote SSH target for syncoid replication. |
| `--syncoid-target-dataset` | dataset | yes if `--enable-syncoid` is set | `backup/terrarium` in interactive prompts | Sets the remote target dataset for syncoid replication. |
| `--syncoid-ssh-key` | path | yes if `--enable-syncoid` is set | `/root/.ssh/id_ed25519` in interactive prompts | Sets the SSH key used for syncoid replication. |

Install verification notes:

- Interactive password and secret prompts are masked.
- For automation, use `--generate-root-pwd` or `--root-pwd-file` for Cockpit, and prefer `--oidc-secret-file`, `--lxd-oidc-secret-file`, and `--s3-secret-key-file` over argv secrets.
- In interactive mode, external OIDC is not accepted until Terrarium can reach the issuer, confirm the callback flow looks valid, and probe the client credentials. External Logto uses the same checks and does not require Logto Cloud management credentials for runtime configuration.
- In interactive mode, S3 is not accepted until Terrarium can reach the bucket and complete a write/delete verification object cycle.
- In non-interactive mode, the same checks run once and the install exits on failure.

## config import/export

Terrarium keeps its canonical day-2 config in LXD's dqlite-backed project metadata:

- project: `terrarium-system`
- key: `user.terrarium.config_b64`
- value: base64-encoded YAML

`/etc/terrarium/config.yaml` is a root-only YAML export, not the steady-state store. Terrarium creates it only as a transient Ansible input or when you explicitly run `terrariumctl config export`.

Use `terrariumctl config import` to copy a local export into the dqlite-backed store. Terrarium runs this automatically after LXD has been initialized during install and removes the transient export afterwards.

Use `terrariumctl config export` to recreate the local export from the dqlite-backed store for recovery or debugging. `terrariumctl reconfigure` uses a temporary export before invoking Ansible and removes it afterwards.

## update

Use `terrariumctl update` on an existing Terrarium host when you want newer Terrarium code, Ansible roles, managed LXD profiles, systemd units, or package lists without going through the installer again.

```bash
terrariumctl update
terrariumctl update --ref 0.0.38
terrariumctl update --skip-reconfigure
```

The command updates `/opt/terrarium`, refreshes Ansible collections, and then runs `terrariumctl reconfigure` with OS hardening skipped. It reuses the saved configuration from LXD's config store or the legacy `/etc/terrarium/config.yaml` fallback; it does not ask storage, domain, IDP, S3, or syncoid setup questions.

When using the bootstrap installer, pass `--update` to get the same behavior from a release bundle:

```bash
curl -fsSL https://github.com/terion-labs/terrarium/releases/latest/download/install.sh | sudo bash -s -- --update
```

Starting with 0.0.38, release signatures use the `terion-labs/terrarium` repository. Use the bootstrap command above when upgrading an older installation. Its existing updater can also select the new publisher explicitly:

```bash
sudo env TERRARIUM_GITHUB_REPO=terion-labs/terrarium terrariumctl update --ref 0.0.38
```

For a historical release signed under `terion-name/terrarium`, set `TERRARIUM_GITHUB_REPO=terion-name/terrarium` explicitly when selecting that older version.

## proxy labels

Terrarium publishes instance services from the LXD `user.proxy` config key. The value is one route or a comma/newline-separated list of routes.

```bash
lxc config set my-app user.proxy "https://app.example.com:8080"
lxc config set my-app user.proxy "https://app.example.com:8080,https://api.example.com:3000/api"
terrariumctl proxy sync
```

HTTP(S) route format:

```text
https://<public-host>[:container-port][/path][@auth[:group[,group...]][~callback-host]]
http://<public-host>[:container-port][/path][@auth[:group[,group...]][~callback-host]]
```

Use `https://` for normal public routes. It creates a HTTPS router with Let's Encrypt and redirects plain HTTP to HTTPS. Use `http://` only when you intentionally want a plain HTTP public route. The port is the port inside the container; the public listener is still 80/443. If the port is omitted, Terrarium targets container port `80`. A path, when present, is matched as a prefix. Query strings and fragments are not supported.

Wildcard HTTPS hosts such as `https://*.example.com:8080` require DNS-01 ACME. Configure the single Traefik DNS provider with lego environment variable names:

```bash
terrariumctl set dns provider cloudflare CF_DNS_API_TOKEN:your-token
terrariumctl set dns provider route53 AWS_ACCESS_KEY_ID:your-key AWS_SECRET_ACCESS_KEY:your-secret AWS_REGION:us-east-1
terrariumctl set dns provider
```

The last command disables DNS-01 and returns Traefik to HTTP-01. Traefik supports one DNS challenge provider per instance; see the [lego DNS provider list](https://go-acme.github.io/lego/dns/index.html) for provider codes and required environment variables.

Authentication suffixes are supported only on HTTP(S) routes:

```bash
lxc config set grafana user.proxy "https://grafana.example.com:3000@auth"
lxc config set admin-tool user.proxy "https://admin.example.com:8080@auth:admins,devops"
lxc config set wildcard-admin user.proxy "https://*.example.com:8080@auth:admins~auth.example.com"
terrariumctl proxy sync
```

`@auth` allows any authenticated user. `@auth:admins,devops` allows users in any listed group. Group names may contain letters, numbers, dots, underscores, and hyphens. Wildcard auth routes must add `~callback-host`; Terrarium always uses HTTPS and oauth2-proxy's callback path for that host. External OIDC providers must emit a `groups` claim for group-restricted routes.

TCP and UDP route formats:

```text
tcp://<public-port>:<container-port>
udp://<public-port>:<container-port>
```

Examples:

```bash
lxc config set postgres user.proxy "tcp://15432:5432"
lxc config set game user.proxy "udp://25565:25565"
terrariumctl proxy sync
```

TCP/UDP routes are raw transport routes. They do not support `@auth`, hostnames, paths, or TLS termination. Terrarium creates a Traefik entrypoint and opens the matching managed UFW port.

Operational rules:

- The container must have an IPv4 address on the Terrarium network, or a managed host-loopback proxy backend.
- The service inside the container must listen on `0.0.0.0`, not only `127.0.0.1`.
- Run `terrariumctl proxy sync` after changing labels, or wait for the automatic sync timer.
- Duplicate HTTP host/path claims and duplicate TCP/UDP public ports are rejected during sync.

## exec

`terrariumctl exec` is Terrarium's safer wrapper around `lxc exec`.

By default it opens a login shell as the `terrarium` user inside the container:

```bash
trm exec my-stack
```

To run a command, put the container command after `--` so flags are passed to the container command instead of Terrarium:

```bash
trm exec my-stack -- bash -lc 'docker compose ps'
```

For recovery or system administration, use root explicitly:

```bash
trm exec my-stack --root
trm exec my-stack --root -- systemctl status ssh
```

You can also choose another container user:

```bash
trm exec my-stack --user ubuntu
```

## cluster

Terrarium cluster commands wrap LXD's native clustering flow. They do not create
a separate Terrarium consensus layer.

### cluster status

```bash
terrariumctl cluster status
```

Prints `lxc cluster list` and, when present, the Terrarium OVN workload network
definition.

### cluster init

```bash
terrariumctl cluster init
```

Manual override example:

```bash
terrariumctl cluster init \
  --member node1 \
  --wireguard-endpoint 10.0.0.11:51820 \
  --wireguard-cidr 10.255.54.0/24
```

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--member` | name | no | `hostname -s` | Local LXD cluster member name. |
| `--address` | IP/DNS with optional port | no | local WireGuard tunnel IP | Advanced escape hatch for the LXD listener address. Normal clusters should omit this. |
| `--network` | LXD network name | no | `terrarium-ovn` | Terrarium OVN workload network. |
| `--parent` | LXD network name | no | `lxdbr0` | Managed parent/uplink network for OVN. |
| `--central-addresses` | comma-separated IPs | no | local WireGuard tunnel IP | Advanced OVN central member addresses. Use tunnel IPs and an odd-sized set for production. |
| `--peer-cidr` | comma-separated IPs/CIDRs | no | exact local WireGuard tunnel address | Advanced source addresses allowed through UFW for LXD and OVN cluster traffic. Normal clusters should let Terrarium maintain exact tunnel peers. |
| `--wireguard-endpoint` | IP/DNS with optional port | no | auto-discovered host address, port `51820` | Public or provider-private endpoint other members use for WireGuard handshakes. |
| `--wireguard-cidr` | IPv4 CIDR | no | `10.255.54.0/24` | Tunnel subnet for Terrarium cluster members. |
| `--wireguard-port` | UDP port | no | `51820` | WireGuard listen port. |
| `--skip-reconfigure` | none | no | reconfigure after cluster changes | Saves cluster config without reconciling the host. |

### cluster invite

```bash
terrariumctl cluster invite node2
```

Explicit peer example:

```bash
terrariumctl cluster invite node2 10.0.0.12
```

Prints a copy-paste join command:

```bash
terrariumctl cluster join --token '<token-from-existing-member>' --wireguard '<join-bundle>'
```

When `node2` resolves to an IP address, Terrarium pre-opens exact WireGuard
endpoint firewall rules for that joining node and stores the generated
WireGuard peer in the shared config. If the name is not resolvable, Terrarium
asks for the joining node address in interactive terminals. For automation,
pass the joining node
explicitly:

```bash
terrariumctl cluster invite node2 10.0.0.12
```

Invite peer rules are temporary until the LXD token expires. Terrarium
schedules a one-shot systemd cleanup; joined peers are kept, and expired
never-joined WireGuard peers are removed from UFW and the shared config.

Use this for normal operations. Use `cluster token` only when another tool will
consume the raw token.

### cluster token

```bash
terrariumctl cluster token node2
```

Prints the single-use token returned by `lxc cluster add node2`.

### cluster join

```bash
terrariumctl cluster join --token '<token-from-existing-member>' --wireguard '<join-bundle>'
```

Manual override example:

```bash
terrariumctl cluster join \
  --token '<token-from-existing-member>' \
  --wireguard '<join-bundle>' \
  --yes
```

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--token` | token | yes | none | Single-use token created by `terrariumctl cluster invite` or `terrariumctl cluster token`. |
| `--wireguard` | bundle | yes for normal Terrarium clusters | none | Opaque join bundle printed by `terrariumctl cluster invite`; contains this node's temporary WireGuard join secret. |
| `--address` | IP/DNS with optional port | no | WireGuard tunnel IP from the bundle | Advanced LXD listener override. |
| `--storage-pool` | pool name | no | `terrarium` | Member-local storage pool name used in the LXD join preseed. |
| `--peer-cidr` | comma-separated IPs/CIDRs | no | exact existing WireGuard peer from the bundle | Advanced LXD/OVN tunnel peers allowed through UFW before the LXD join runs. |
| `--yes` | none | no | prompt before join | Confirms the destructive LXD cluster join operation. |
| `--skip-export` | none | no | export shared config after join | Leaves `/etc/terrarium/config.yaml` untouched after joining. |
| `--skip-reconfigure` | none | no | reconfigure after join | Joins without running local Terrarium reconciliation. |

### cluster evacuate

```bash
terrariumctl cluster evacuate node2
```

Asks LXD to evacuate workloads from `node2` for planned maintenance.

### cluster restore

```bash
terrariumctl cluster restore node2
```

Restores an evacuated member to normal service. This does not guarantee that
workloads evacuated earlier move back automatically.

### cluster move

```bash
terrariumctl cluster move app1 node2
```

Moves workload `app1` to cluster member `node2` without renaming the workload.
This follows normal LXD move behavior; stop the workload first if your storage
or runtime cannot migrate it while running.

### cluster remove

```bash
terrariumctl cluster remove node2
```

If `node2` still has workloads, Terrarium asks whether to move them first. In
automation:

```bash
terrariumctl cluster remove node2 --move --yes
```

When `--target` is omitted, Terrarium creates a best-effort distribution plan
across the remaining online members. It prefers members with fewer existing
workloads, and uses lower memory pressure as a tie-breaker when LXD reports
resource data. Add `--target node1` when you intentionally want every workload
to land on one member.

Running workloads are stopped before the move and started again on the target
member. Use application-level failover or LXD evacuation policy when a workload
needs stricter availability behavior.

For dead members:

```bash
terrariumctl cluster remove node2 --force
```

Force removal updates cluster metadata only. Workloads that only existed on the
dead member's local storage must be recovered from backups or replicated/shared
storage.

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--move` | none | no | prompt when workloads exist | Moves workloads off the member before removing it. |
| `--target` | member name | no | best-effort distribution across remaining online members | Target member for all moved workloads when you do not want automatic distribution. |
| `--force` | none | no | clean member removal | Force-removes an unreachable member from LXD metadata. |
| `--yes` | none | no | prompt before movement/removal | Confirms prompts for automation. |
| `--skip-reconfigure` | none | no | reconfigure after cluster config changes | Saves shared cluster config without reconciling the host. |

### cluster ovn configure

```bash
terrariumctl cluster ovn configure
```

Updates the shared Terrarium config and reconciles:

- OVN central service membership
- Open vSwitch southbound connection
- LXD OVN northbound connection
- Terrarium-managed OVN CA and per-node TLS certificates
- `terrarium-ovn` workload network
- UFW rules for peer-only cluster traffic

Without flags, Terrarium reads LXD cluster membership, uses an odd number of
online member addresses as OVN central addresses, and adds exact member CIDRs
to the shared peer firewall list. If a larger manually configured central set
already exists, Terrarium keeps it instead of shrinking it because one member is
temporarily unreachable.

Manual override example:

```bash
terrariumctl cluster ovn configure \
  --central-addresses 10.255.54.1,10.255.54.2,10.255.54.3 \
  --peer-cidr 10.255.54.1/32,10.255.54.2/32,10.255.54.3/32
```

Use an odd number of central addresses and prefer WireGuard tunnel IPs. If
there is no LXD cluster membership yet and `--central-addresses` is omitted,
Terrarium keeps the existing local OVN setting.

This command reconciles the node where it runs. If the central set changes
after other members have already joined, run `terrariumctl reconfigure` on
those members so their local OVN services consume the shared config.

OVN database remotes are rendered as `ssl:` endpoints and require certificates
issued by the Terrarium OVN CA. The peer firewall rules remain necessary, but
they are no longer the only control protecting `6641/tcp` and `6642/tcp`.

## backup restore

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--source` | `local` or `s3` | no | `local` | Chooses whether restore data comes from local ZFS snapshots or from S3 manifests and streams. |
| `--instance` | instance name | yes | none | Names the source instance to restore from. |
| `--at` | snapshot fragment or timestamp | no | latest local snapshot or latest S3 manifest chain | Selects the restore point to match. |
| `--as-new` | new instance name | no | in-place restore | Restores into a new dataset and then hands off into interactive `lxd recover`. |

Restore behavior:

- `terrariumctl backup restore --instance NAME` restores from the latest local snapshot in place by default after confirmation.
- `terrariumctl backup restore --source local|s3 --instance NAME [--at ...] --as-new NEWNAME` restores the chosen point and then launches interactive `lxd recover`.

## mount add

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| positional `protocol` | `smb` or `cifs` | yes | none | Chooses the SMB/CIFS mount handler. Both values map to a managed CIFS mount. |
| positional `hostPath` | absolute host path | yes | none | The mount point to create on the Terrarium host. |
| positional `address` | share address | yes | none | The SMB share address, `//server/share`. Hetzner Storage Box main accounts usually use `//u12345.your-storagebox.de/backup`; subaccounts usually use `//u12345-sub1.your-storagebox.de/u12345-sub1`. |
| positional `username` | username | yes | none | The SMB/CIFS username written to the managed credentials file. |
| `-p`, `--password` | password | no | prompt if omitted | The SMB/CIFS password. Omit it to let Terrarium prompt securely instead of putting it in shell history. |
| `--password-file` | path | no | none | Reads the SMB/CIFS password from a root-readable file for non-interactive runs without putting it in shell history or process args. |
| `--container` | container name | no | none | Also attach the mounted share to this LXD container using Terrarium's unprivileged-container-safe disk device settings. |
| `--container-path` | absolute path | no | `/mnt/<mount-name>` | Path where `--container` attaches the share inside the container. |
| `--device` | device name | no | generated | LXD disk device name used by `--container` or `mount attach`. |
| `--uid` | uid | no | `0` | Advanced: UID presented for files on the host-side mount. |
| `--gid` | gid | no | `0` | Advanced: GID presented for files on the host-side mount. |
| `--file-mode` | octal mode | no | `0660` | File permissions presented on the mounted share. |
| `--dir-mode` | octal mode | no | `0770` | Directory permissions presented on the mounted share. |
| `--seal` | `true` or `false` | no | `true` | Enables or disables the SMB encryption option explicitly. |

Example:

```bash
terrariumctl mount add cifs /srv/shared/storage-box //u12345.your-storagebox.de/backup u12345
```

For a Hetzner Storage Box subaccount:

```bash
terrariumctl mount add cifs /srv/shared/storage-box //u12345-sub1.your-storagebox.de/u12345-sub1 u12345-sub1
```

Attach the share to a container in the same step:

```bash
terrariumctl mount add cifs /srv/shared/storage-box //u12345.your-storagebox.de/backup u12345 --container app --container-path /mnt/shared
```

Behavior:

- Terrarium creates the mount point if it does not exist.
- Terrarium writes credentials under `/etc/terrarium/mounts/`.
- Terrarium adds or updates a Terrarium-managed block in `/etc/fstab`.
- If `--container` is set, Terrarium keeps the LXD container unprivileged, maps the host-side CIFS ownership for that container, and attaches the share as a disk device.
- If the path is already mounted, Terrarium remounts it cleanly.

## mount attach

Attach an existing Terrarium-managed host mount to an LXD container:

```bash
terrariumctl mount attach /srv/shared/storage-box app /mnt/shared
```

For Terrarium-managed CIFS mounts, `mount attach` remaps the host-side mount for
the target unprivileged container before attaching the disk device.

## mount remove

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| positional `hostPath` | absolute host path | yes | none | The Terrarium-managed mount point to remove from the host. |

Example:

```bash
terrariumctl mount remove /srv/shared/storage-box
```

Behavior:

- Terrarium unmounts the path if it is currently mounted.
- Terrarium removes the managed block from `/etc/fstab`.
- Terrarium deletes the managed credentials file for that mount.

## mount list

Example:

```bash
terrariumctl mount list
```

Behavior:

- Shows all Terrarium-managed mounts discovered in `/etc/fstab`.
- Reports the share address, host path, protocol, and whether the path is mounted right now.

## set domains

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| positional `rootDomain` | domain | no | prompted when omitted | Sets the new root domain. |
| `--manage-domain` | domain | no | `manage.<rootDomain>` | Overrides the Cockpit domain. |
| `--proxy-domain` | domain | no | `proxy.<rootDomain>` | Overrides the Traefik dashboard domain. |
| `--lxd-domain` | domain | no | `lxd.<rootDomain>` | Overrides the LXD domain. |
| `--auth-domain` | domain | no | `auth.<rootDomain>` when a local IDP is enabled | Overrides the local identity-provider domain. |

## set emails

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--email` | email address | no | existing configured value | Updates the Terrarium contact/admin email. |
| `--acme-email` | email address | no | existing configured value or falls back to `--email` | Updates the ACME account email. |
| `--zitadel-admin-email` | email address | no | existing configured value or falls back to `--email` | Updates the self-hosted ZITADEL bootstrap admin email. |
| `--logto-admin-email` | email address | no | existing configured value or falls back to `--email` when local Logto is selected | Updates the self-hosted Logto bootstrap admin email. |

## set idp

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| positional mode | `local` or `oidc` | yes | none | Switches the Terrarium IDP mode. |
| `--provider` / `--idp-provider` | `zitadel` or `logto` | no | local mode defaults to `zitadel`; external OIDC defaults to generic provider behavior when omitted | Selects provider-specific defaults. `--idp-provider` is an alias for `--provider`. |
| `--auth-domain` | domain | no | derived from the current root domain or IP when mode is `local` | Overrides the self-hosted identity-provider auth domain. |
| `--admin-group` | group name | required when mode is `oidc`; optional otherwise | existing configured value, or `terrarium-admins` when mode is `local` | Sets the management admin group for Cockpit and LXD authorization. |
| `--oidc` | issuer URL | required when mode is `oidc` and no issuer is already configured | existing configured issuer, or derived from `auth-domain` when mode is `local` | Sets the OIDC issuer URL. |
| `--oidc-client` | client ID | required when mode is `oidc` and no client ID is already configured | existing configured value | Sets the external OIDC client ID shared by Cockpit's oauth2-proxy, LXD, and published-route auth. |
| `--oidc-secret` | client secret | required when mode is `oidc` and no client secret is already configured and `--oidc-secret-file` is omitted | existing configured value | Sets the external OIDC client secret shared by Cockpit's oauth2-proxy, LXD, and published-route auth. Prefer `--oidc-secret-file` for automation. |
| `--oidc-secret-file` | path | required when mode is `oidc`, no client secret is already configured, and `--oidc-secret` is omitted | none | Reads the external OIDC client secret from a root-readable file. |
| `--lxd-oidc-client` | client ID | no | falls back to `--oidc-client` | Uses a separate external OIDC client for LXD. |
| `--lxd-oidc-secret` | client secret | no | falls back to `--oidc-secret` | Sets the separate LXD OIDC client secret. Prefer `--lxd-oidc-secret-file` for automation. |
| `--lxd-oidc-secret-file` | path | no | none | Reads the separate LXD OIDC client secret from a root-readable file. |
| `--oidc-groups-claim` | claim name | no | `roles` for Logto, otherwise `groups` | Overrides the management oauth2-proxy groups/roles claim. |
| `--oidc-scopes` | space-separated scopes | no | `openid profile email roles` for Logto, otherwise `openid profile email` | Overrides the management oauth2-proxy OIDC scopes. |
| `--lxd-oidc-groups-claim` | claim name | no | follows provider default unless set | Overrides the LXD OIDC groups/roles claim. |
| `--lxd-oidc-scopes` | space-separated scopes | no | follows provider default unless set | Overrides the LXD OIDC scopes. |
| `--local-idp-outputs-path` | path | no | `/etc/terrarium/zitadel-apps.json` compatibility path | Overrides where local provider client outputs are read/written. |
| `--zitadel-admin-email` | email address | no | existing configured value or `--email` | Updates the ZITADEL bootstrap admin email when mode is `local`. |
| `--logto-admin-email` | email address | no | existing configured value or `--email` when provider is `logto` and mode is `local` | Updates the Logto bootstrap admin email when mode is `local`. |
| `--logto-admin-username` | username | no | existing configured value or `terrarium_admin` when provider is `logto` and mode is `local` | Updates the Logto bootstrap admin username when mode is `local`. Whitespace and control characters are rejected. |

External OIDC notes:

- Terrarium configures both management oauth2-proxy hosts and LXD from the same external issuer and client settings.
- The external client must allow:
  - `https://<manage-domain>/oauth2/callback`
  - `https://<proxy-domain>/oauth2/callback`
  - `https://<lxd-domain>/oidc/callback`
- Published-route auth with `@auth` also requires the external client to allow each route callback. A root route is rendered as `https://<route-host>/oauth2/callback`; a path route like `/admin` is rendered as `https://<route-host>/oauth2/admin/callback`.
- The external provider must emit the configured groups/roles claim that contains the configured admin group as a JSON string array. Generic OIDC and ZITADEL default to `groups`; Logto defaults to `roles` and `openid profile email roles` scopes. For ZITADEL Cloud, a project role assignment is not enough by itself; add a Complement Token Action that copies granted role keys into `groups`. See [Domains and auth](../getting-started/domains-and-auth) for details.
- `terrariumctl set idp oidc ...` verifies the issuer, callback flow, and client credentials before persisting the new settings.
- If your provider needs separate OIDC clients for Cockpit/published routes and LXD, pass `--lxd-oidc-client` plus `--lxd-oidc-secret-file`.

Local provider notes:

- Local ZITADEL remains the default when mode is `local` and no provider is set. External OIDC remains generic when no provider is set.
- Local ZITADEL runs in the `terrarium-idp` LXD system instance, so its data is part of the LXD/ZFS backup set instead of host Docker state.
- Local Logto also runs in the managed `terrarium-idp` system instance. It starts Logto plus Postgres through `terrarium-logto.service`, seeds the database unattended, and provisions Terrarium clients during `terrariumctl idp sync`.
- Local Logto bootstrap defaults use `terrarium_email` for `terrarium_logto_admin_email` and `terrarium_admin` for `terrarium_logto_admin_username`; override them with `--logto-admin-email` and `--logto-admin-username` during install or `terrariumctl set idp local --provider logto`.
- Terrarium auto-provisions a management role named after `terrarium_admin_group`, defaulting to `terrarium-admins`.
- The bootstrap admin is granted that role automatically when the selected provider can resolve that user.
- ZITADEL flattens Terrarium role assignments into a `groups` claim. Logto uses its `roles` claim and `openid profile email roles` scopes by default.

## set s3

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--enable` | none | no | keeps current state | Enables S3 exports. |
| `--disable` | none | no | keeps current state | Disables S3 exports. |
| `--s3-endpoint` | URL | no | existing configured value | Updates the S3 endpoint. |
| `--s3-bucket` | bucket name | required when S3 is enabled | existing configured value | Updates the S3 bucket. |
| `--s3-region` | region name | no | existing configured value | Updates the S3 region. |
| `--s3-prefix` | prefix | no | existing configured value or `terrarium` | Updates the S3 object prefix. |
| `--s3-access-key` | access key | required when S3 is enabled | existing configured value | Updates the S3 access key. |
| `--s3-secret-key` | secret key | required when S3 is enabled and no existing secret is configured and `--s3-secret-key-file` is omitted | existing configured value | Updates the S3 secret key. Prefer `--s3-secret-key-file` for automation. |
| `--s3-secret-key-file` | path | required when S3 is enabled, no existing secret is configured, and `--s3-secret-key` is omitted | none | Reads the S3 secret key from a root-readable file. |

S3 verification notes:

- When S3 is enabled or updated, Terrarium verifies the target bucket with a real write/delete probe.
- This catches wrong endpoint, wrong credentials, wrong bucket, and missing write permissions before backup settings are persisted.

## set syncoid

| Flag | Argument | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--enable` | none | no | keeps current state | Enables syncoid replication. |
| `--disable` | none | no | keeps current state | Disables syncoid replication. |
| `--syncoid-target` | host | required when syncoid is enabled | existing configured value | Updates the remote syncoid SSH target. |
| `--syncoid-target-dataset` | dataset | required when syncoid is enabled | existing configured value | Updates the remote syncoid dataset. |
| `--syncoid-ssh-key` | path | no | existing configured value or `/root/.ssh/id_ed25519` | Updates the SSH key used by syncoid. |

## Linux VM options

`launch` and `image launch` share `--vm`, `--target MEMBER`, `--wait`, and `--timeout SECONDS` (default 300), as well as all existing resource and provisioning options. Explicit VM launches and local golden VM images choose `vm` unless a profile is supplied. `vm-dev` adds passwordless sudo. VM commands discover existing instance types from LXD, so `exec`, image creation, mounts, backups, and cluster movement need no extra type flag.

Use `--instance` and `--instance-path` for mount commands. The historical `--container` and `--container-path` spellings remain aliases and cannot conflict. `backup replicate` runs the configured Syncoid complete-set export now. `backup list` includes both local dataset types and versioned S3 backup IDs; pass a full ID to `--at` when an old name has multiple backup identities.

`status` reports local VM capability, workload counts, ingress helper state, and last backup service results. See the [VM guide](../getting-started/virtual-machines.md) for UI creation, readiness diagnostics, routing, sharing, and recovery.
