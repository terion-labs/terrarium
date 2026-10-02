# Real-Infra Integration Suite

This directory contains Terrarium’s real-infrastructure integration harness.

It provisions ephemeral Hetzner Cloud servers and volumes, uses public IP-encoded DNS,
OIDC, S3, and SMB dependencies, installs Terrarium on those hosts, and then
exercises the shipped CLI and runtime features end to end.

The suite is intentionally closer to a release gate than a unit test. It should
exercise Terrarium the way a real operator would:

- install from the built Linux bundle, then use `/usr/local/bin/terrariumctl`
  for post-install work
- use public HTTPS endpoints with normal certificate validation
- drive Cockpit, Traefik, LXD, the selected external OIDC provider, and protected routes through browser or
  HTTP flows instead of bypassing them through internal files
- pass secrets through temporary root-readable files where the product supports
  file-based secret input
- clean all Hetzner, selected provider, and local artifact resources after successful
  runs

## Entry points

```bash
bun run integration:smoke
bun run integration:full
```

Or directly:

```bash
bun run tests/integration/index.ts --suite smoke
bun run tests/integration/index.ts --suite full
```

Useful flags:

```bash
bun run tests/integration/index.ts --suite full --only full
bun run tests/integration/index.ts --suite smoke --keep-on-failure
bun run tests/integration/index.ts --cleanup-only
```

Flags:

- `--suite smoke|full` selects the smoke or full suite.
- `--only <scenario>` narrows execution to the named scenario. The full suite
  registers `smoke` first and `full` second, so `--suite full --only full`
  runs only the slower after-smoke coverage.
- `--keep-on-failure` leaves infrastructure in place after a failure so you can
  inspect the host directly.
- `--reuse-infra` enables reuse hooks where a provider supports them.
- `--release-preflight` marks the run as a release-preflight invocation.
- `--cleanup-only` reads the existing output manifest and tears down resources
  without provisioning a new run.

## Smoke vs Full

`smoke` is the high-signal end-to-end release gate. It provisions a replica and
a primary host, installs local ZITADEL, verifies management login surfaces,
checks LXD API/UI access, publishes plain and OIDC-protected routes, verifies
the OVN-backed default LXD workload network, verifies local restore, S3 restore,
syncoid replication, switches to external OIDC,
checks protected-route allow/deny behavior, switches back to local ZITADEL, and
exercises day-2 reconfiguration commands.

`full` starts by running the complete smoke suite, then adds slower and broader
coverage: external-OIDC install from scratch, CIFS host mount usage from an LXD
container, partition-mode install, restore-as-new with `lxd recover`, and
negative verification for bad S3 and OIDC credentials. It also builds a real
two-member LXD/Terrarium cluster, verifies `cluster init`/`token`/`join`,
checks OVN workload reachability across members, and removes a member after
moving a workload away.

## Required environment

By default the harness loads `tests/integration/.env` before reading the process
environment. Set `TERRARIUM_INTEGRATION_ENV_FILE` to point at another env file.

Required:

- `HCLOUD_TOKEN`
- `HCLOUD_LOCATION`
- `HCLOUD_SERVER_TYPE`
- `HCLOUD_SSH_PRIVATE_KEY`
- `HCLOUD_SSH_PUBLIC_KEY`
- `S3_ENDPOINT`
- `S3_BUCKET`
- `S3_REGION`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `CIFS_ADDRESS`
- `CIFS_USERNAME`
- `CIFS_PASSWORD`
- `CIFS_HOST_PATH_BASE`

External OIDC provider selection:

- `TERRARIUM_INTEGRATION_IDP_PROVIDER=zitadel|logto` selects which external
  OIDC identity provider fixture the harness uses.
- When `TERRARIUM_INTEGRATION_IDP_PROVIDER` is unset, the harness uses Logto if
  the required Logto existing-tenant variables are complete; otherwise it falls
  back to ZITADEL.
- For ZITADEL, keep using the existing variables:
  - `ZITADEL_CLOUD_ISSUER`
  - `ZITADEL_CLOUD_PAT`
- For Logto, the harness targets an existing tenant. Set:
  - `LOGTO_TENANT_ENDPOINT`
  - `LOGTO_M2M_CLIENT_ID`
  - `LOGTO_M2M_CLIENT_SECRET`
  - `LOGTO_MANAGEMENT_API_RESOURCE` optionally overrides the Management API
    resource and defaults to `${LOGTO_TENANT_ENDPOINT}/api`.
- The Logto M2M application must have Logto Management API access with `all`
  permissions. Running a local Logto runtime is out of scope for this harness.

GitHub Actions release preflight sets `TERRARIUM_INTEGRATION_IDP_PROVIDER=logto`,
so repository secrets must include the three required `LOGTO_*` variables above.

Optional:

- `HCLOUD_IMAGE` selects `ubuntu-24.04` or `ubuntu-26.04`, defaulting to `ubuntu-24.04`. CI runs both host images.
- `HCLOUD_BINARY_TARGET` defaults to `x64`.
- `HCLOUD_VOLUME_SIZE_GB` defaults to `40`.
- `HCLOUD_SSH_USER` defaults to `root`.
- `HCLOUD_SSH_PRIVATE_KEY_FILE` and `HCLOUD_SSH_PUBLIC_KEY_FILE` can replace
  the inline SSH key variables.
- `TERRARIUM_INTEGRATION_IP_DNS_DOMAIN` defaults to `nip.io`. GitHub
  workflows read `vars.TERRARIUM_INTEGRATION_IP_DNS_DOMAIN` when it is set, so
  CI can move to another IP-encoded DNS provider if a shared domain hits ACME
  rate limits.
- `ZITADEL_CLOUD_ORG_ID` can be omitted when the PAT has enough scope without it.
- `TERRARIUM_INTEGRATION_SLUG` overrides the generated run slug.
- `TERRARIUM_INTEGRATION_OUTPUT_DIR` overrides the artifact directory.
- `KEEP_ON_FAILURE=true`, `REUSE_INFRA=true`, and `RELEASE_PREFLIGHT=true`
  mirror their CLI flags.

The CIFS fixture must be writable. The full suite writes a file through the host
mount and reads it from an LXD container.

## Output

Each run writes logs, screenshots, and collected host artifacts to:

```text
tests/integration/output/<run-slug>/
```

The resource manifest in that directory is also what `--cleanup-only` uses.
Successful runs clean resources automatically. Failed runs also try to collect
host artifacts before teardown unless `--keep-on-failure` is set.

## Linux VM integration

Use `bun run integration:vm` for the native VM suite on an existing KVM-capable two-member lab. It supports direct SSH hosts and Incus VMs reached through an SSH host. See [VM integration setup and coverage](./vm/README.md).
