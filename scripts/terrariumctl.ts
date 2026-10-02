import { cac, type Command } from "cac";
import chalk from "chalk";
import { registerInstallCommand } from "./terrarium-install";
import { proxySyncCmd as syncProxyConfig } from "./terrarium-traefik-sync";
import { idpSyncCmd as syncIdpConfig } from "./terrarium-idp-sync";
import { TERRARIUM_VERSION } from "./generated/build-info";
import { backupActionCmd } from "./ctl/backup";
import {
  clusterEvacuateCmd,
  clusterInviteCmd,
  clusterInviteCleanupCmd,
  clusterInitCmd,
  clusterJoinCmd,
  clusterMoveCmd,
  clusterOvnConfigureCmd,
  clusterRemoveCmd,
  clusterRestoreCmd,
  clusterStatusCmd,
  clusterTokenCmd
} from "./ctl/cluster";
import { cliOption, normalizedArgv, parseBooleanOption, PREFIX } from "./ctl/context";
import {
  configExportCmd,
  configImportCmd,
  parseSetCommandOptions,
  setDnsProviderCmd,
  setDomainsCmd,
  setEmailsCmd,
  setIdpCmd,
  setS3Cmd,
  setSyncoidCmd
} from "./ctl/config";
import {
  DEFAULT_CIFS_DIR_MODE,
  DEFAULT_CIFS_FILE_MODE,
  mountAddCmd,
  mountAttachCmd,
  mountListCmd,
  mountRemoveCmd
} from "./ctl/mount";
import { execCmd } from "./ctl/exec";
import { imageCreateCmd, imageDeleteCmd, imageLaunchCmd, imageListCmd } from "./ctl/image";
import { idpBackupCmd, idpLogsCmd, idpRestoreCmd, idpStatusCmd } from "./ctl/idp";
import { launchCmd, launchOptionsFromCli } from "./ctl/launch";
import { statusCmd } from "./ctl/status";
import { reconfigureCmd } from "./ctl/system";
import { updateCmd } from "./ctl/update";
import { completionScript, installCompletionScripts, type CompletionInstallShell, type CompletionShell } from "./ctl/completion";

/**
 * Prompts before destructive operations that alter persisted or mounted state.
 *
 * Keeping the prompt here allows command modules to stay focused on their
 * domain logic while the CLI shell owns the human interaction policy.
 */
async function confirmDestructive(message: string): Promise<void> {
  const { confirm } = await import("@inquirer/prompts");
  const approved = await confirm({ message, default: false });
  if (!approved) {
    throw new Error("operation cancelled");
  }
}

/** Shared callback bundle used by all `set ...` commands after config changes. */
const reconcileActions = {
  reconfigure: () => reconfigureCmd({ applyHardening: false }),
  syncProxy: syncProxyConfig,
  syncIdp: syncIdpConfig
};

/** Main CLI definition for the compiled Terrarium binary. */
const cli = cac("terrariumctl");
// CAC's string transform runs after numeric coercion; cliOption recovers exact argv values instead.
const STRING_OPTION = {};
cli.version(TERRARIUM_VERSION);

registerInstallCommand(cli);

cli.command("status", "Show Terrarium service and endpoint status").action(async () => {
  await statusCmd();
});

cli
  .command("backup <action>", "Backup operations: list, export, replicate, restore")
  .option("--source <source>", "Restore source: local or s3")
  .option("--instance <name>", "Instance name")
  .option("--at <snapshotOrTimestamp>", "Snapshot name fragment or timestamp")
  .option("--as-new <name>", "Restore as a new instance")
  .usage("backup list | backup export | backup replicate | backup restore [--source local|s3] --instance NAME [--at SNAPSHOT|TIMESTAMP] [--as-new NEWNAME]")
  .action(async (action, options) => {
    await backupActionCmd(action, {
      source: options.source as string | undefined,
      instance: options.instance as string | undefined,
      at: options.at as string | undefined,
      asNew: options.asNew as string | undefined
    });
  });

cli.command("reconfigure", "Re-run the Ansible reconciliation with the installed binary").action(async () => {
  await reconfigureCmd();
});

cli
  .command("update", "Update installed Terrarium code/assets and re-run reconciliation")
  .option("--ref <ref>", "Release tag or source branch to update to", STRING_OPTION)
  .option("--skip-reconfigure", "Update code/assets without running Ansible reconciliation")
  .option("--non-interactive", "Accepted for install.sh --update compatibility")
  .action(async (options) => {
    const rawOptions = options as Record<string, unknown>;
    await updateCmd({
      ref: cliOption(rawOptions, "ref"),
      reconfigure: !Boolean(rawOptions.skipReconfigure)
    });
  });

cli
  .command("completion <shell> [action]", "Print or install shell completion: bash, zsh, fish, or all")
  .usage("completion bash|zsh|fish\n  completion bash|zsh|fish|all install")
  .action((shell, action) => {
    if (!["bash", "zsh", "fish", "all"].includes(shell)) {
      throw new Error(`unsupported completion shell: ${shell}`);
    }
    if (action) {
      if (action !== "install") {
        throw new Error(`unsupported completion action: ${action}`);
      }
      const results = installCompletionScripts(shell as CompletionInstallShell);
      for (const result of results) {
        if (result.installed) {
          console.log(`installed ${result.shell} completion at ${result.path}`);
        } else {
          console.log(`skipped ${result.shell} completion: ${result.reason}`);
        }
      }
      return;
    }
    if (shell === "all") {
      throw new Error("completion all is only supported with the install action");
    }
    process.stdout.write(completionScript(shell as CompletionShell));
  });

/** Both entry points expose the same provisioning and instance options. */
function withLaunchOptions(command: Command): Command {
  return command
  .option("--vm", "Create an LXD virtual machine")
  .option("--target <member>", "Cluster member for the new instance", STRING_OPTION)
  .option("--wait", "Wait for the guest agent and cloud-init to finish")
  .option("--timeout <seconds>", "Readiness timeout in seconds, default 300", STRING_OPTION)
  .option("--profile <profile>", "LXD profile to apply; can be repeated", STRING_OPTION)
  .option("--disk <size>", "Root disk size, for example 40G", STRING_OPTION)
  .option("--memory <size>", "Memory limit, for example 4G", STRING_OPTION)
  .option("--cpu <count>", "CPU limit", STRING_OPTION)
  .option("--requirements <pathOrGit>", "Ansible Galaxy requirements file; can be repeated", STRING_OPTION)
  .option("--playbook <pathOrGit>", "Ansible playbook file; can be repeated", STRING_OPTION)
  .option("--role <role>", "Ansible Galaxy role to install and run; can be repeated", STRING_OPTION)
  .option("--docker-compose <pathOrGit>", "Docker Compose file to launch; can be repeated", STRING_OPTION)
  .option("--var <keyValue>", "Launch variable KEY=value; exported to provisioning commands, Ansible, and Compose; can be repeated", STRING_OPTION)
  .option("--vars <path>", "Dotenv file with launch variables; can be repeated", STRING_OPTION)
  .option("--cloud-init <path>", "Raw cloud-init user-data file; cannot be combined with provisioning shortcuts", STRING_OPTION)
  .option("--proxy <route>", "Set the Terrarium user.proxy label; can be repeated", STRING_OPTION);
}

withLaunchOptions(cli.command("launch <image> <name>", "Launch an LXD container or VM with Terrarium provisioning"))
  .usage(
    "launch IMAGE NAME [--vm] [--target MEMBER] [--wait] [--timeout SECONDS] [--profile PROFILE] [--disk 40G] [--memory 4G] [--cpu 2]\n  terrariumctl launch ubuntu:24.04 web-01 --playbook ./site.yml\n  terrariumctl launch ubuntu:24.04 app-01 --docker-compose ./docker-compose.yml --proxy https://app.example.com:8080"
  )
  .action(async (image, name, options) => {
    await launchCmd(image as string, name as string, launchOptionsFromCli(options as Record<string, unknown>));
  });

withLaunchOptions(cli.command("image <action> [...args]", "Golden image operations: create, list, launch, delete"))
  .option("--snapshot <name>", "Publish an existing instance snapshot", STRING_OPTION)
  .option("--live", "Publish current disk state without creating a temporary snapshot")
  .option("--reuse", "Replace an existing image alias when creating")
  .usage(
    "image create INSTANCE ALIAS [--snapshot SNAPSHOT|--live] [--reuse]\n  terrariumctl image list\n  terrariumctl image launch ALIAS NAME [--profile dev] [--proxy https://app.example.com:8080]\n  terrariumctl image delete ALIAS"
  )
  .action(async (action, args, options) => {
    const commandArgs = (args as string[]) ?? [];
    const rawOptions = options as Record<string, unknown>;
    const normalizedAction = action.trim().toLowerCase();

    if (normalizedAction === "create") {
      const [instance, alias] = commandArgs;
      if (!instance || !alias) {
        throw new Error("image create requires: <instance> <alias>");
      }
      await imageCreateCmd(instance, alias, {
        snapshot: cliOption(rawOptions, "snapshot"),
        live: Boolean(rawOptions.live),
        reuse: Boolean(rawOptions.reuse)
      });
      return;
    }

    if (normalizedAction === "list") {
      await imageListCmd();
      return;
    }

    if (normalizedAction === "launch") {
      const [alias, name] = commandArgs;
      if (!alias || !name) {
        throw new Error("image launch requires: <alias> <name>");
      }
      await imageLaunchCmd(alias, name, launchOptionsFromCli(rawOptions));
      return;
    }

    if (normalizedAction === "delete") {
      const [alias] = commandArgs;
      if (!alias) {
        throw new Error("image delete requires: <alias>");
      }
      await imageDeleteCmd(alias);
      return;
    }

    throw new Error(`unsupported image action: ${action}`);
  });

cli
  .command("exec <instance> [...command]", "Run a command or shell inside a Terrarium instance as the terrarium user")
  .option("--root", "Run as root inside the instance")
  .option("--user <user>", "Guest user for the command", STRING_OPTION)
  .allowUnknownOptions()
  .usage("exec INSTANCE [-- COMMAND...]\n  terrariumctl exec INSTANCE\n  terrariumctl exec INSTANCE -- bash -lc 'echo hello'\n  terrariumctl exec INSTANCE --root")
  .action(async (instance, command, options) => {
    const rawOptions = options as Record<string, unknown>;
    const passthrough = Array.isArray(rawOptions["--"]) ? (rawOptions["--"] as string[]) : [];
    await execCmd(instance as string, passthrough.length > 0 ? passthrough : ((command as string[]) ?? []), {
      root: Boolean(rawOptions.root),
      user: cliOption(rawOptions, "user")
    });
  });

cli
  .command("config <action>", "Config storage operations")
  .usage("config import | config export")
  .action((action) => {
    if (action === "import") {
      configImportCmd();
      return;
    }
    if (action === "export") {
      configExportCmd();
      return;
    }
    throw new Error(`unsupported config action: ${action}`);
  });

cli
  .command("cluster <action> [...args]", "Cluster operations")
  .option("--member <name>", "Local cluster member name for cluster init; defaults to hostname", STRING_OPTION)
  .option("--address <ipOrHostPort>", "Reachable LXD cluster address for this node; auto-discovered when omitted", STRING_OPTION)
  .option("--token <token>", "Single-use LXD cluster join token", STRING_OPTION)
  .option("--storage-pool <name>", "Local storage pool name for cluster join", { ...STRING_OPTION, default: "terrarium" })
  .option("--network <name>", "Terrarium OVN workload network name", { ...STRING_OPTION, default: "terrarium-ovn" })
  .option("--parent <name>", "LXD parent/uplink network for the OVN network", { ...STRING_OPTION, default: "lxdbr0" })
  .option("--central-addresses <csv>", "Comma-separated OVN central member IPs; auto-discovered when omitted", STRING_OPTION)
  .option("--peer-cidr <csv>", "Comma-separated source IPs/CIDRs allowed to reach LXD and OVN cluster ports; defaults to exact peers", STRING_OPTION)
  .option("--wireguard <bundle>", "Internal WireGuard join bundle emitted by cluster invite", STRING_OPTION)
  .option("--wireguard-cidr <cidr>", "WireGuard mesh CIDR for cluster init; defaults to 10.255.54.0/24", STRING_OPTION)
  .option("--wireguard-port <port>", "WireGuard UDP listen port for cluster init; defaults to 51820", STRING_OPTION)
  .option("--wireguard-endpoint <ipOrHostPort>", "Reachable WireGuard endpoint for this node; auto-discovered when omitted", STRING_OPTION)
  .option("--expires-at <iso>", "Internal invite cleanup deadline", STRING_OPTION)
  .option("--target <member>", "Target member for cluster remove workload moves; omit to distribute", STRING_OPTION)
  .option("--move", "Move workloads off a member before cluster remove")
  .option("--force", "Force-remove an unreachable cluster member")
  .option("--yes", "Confirm destructive cluster prompts")
  .option("--skip-export", "Do not export Terrarium config from the cluster store after join")
  .option("--skip-reconfigure", "Do not run Terrarium reconfigure after cluster changes")
  .usage(
    "cluster status\n  terrariumctl cluster init [--member NAME] [--address IP[:8443]] [--wireguard-endpoint IP[:51820]]\n  terrariumctl cluster invite MEMBER [PEER_IP_OR_CIDR]\n  terrariumctl cluster token MEMBER\n  terrariumctl cluster join --token TOKEN --wireguard BUNDLE [--yes]\n  terrariumctl cluster evacuate MEMBER [--yes]\n  terrariumctl cluster restore MEMBER [--yes]\n  terrariumctl cluster move WORKLOAD MEMBER\n  terrariumctl cluster remove MEMBER [--move] [--target MEMBER] [--force] [--yes]\n  terrariumctl cluster ovn configure [--central-addresses IP1,IP2,IP3] [--peer-cidr CIDR]"
  )
  .action(async (action, args, options) => {
    const commandArgs = (args as string[]) ?? [];
    const rawOptions = options as Record<string, unknown>;
    const normalizedAction = action.trim().toLowerCase();

    if (normalizedAction === "status") {
      await clusterStatusCmd();
      return;
    }
    if (normalizedAction === "init") {
      await clusterInitCmd({
        member: rawOptions.member as string | undefined,
        address: rawOptions.address as string | undefined,
        network: rawOptions.network as string | undefined,
        parent: rawOptions.parent as string | undefined,
        centralAddresses: rawOptions.centralAddresses as string | undefined,
        peerCidr: rawOptions.peerCidr as string | undefined,
        wireguardCidr: rawOptions.wireguardCidr as string | undefined,
        wireguardPort: rawOptions.wireguardPort as string | undefined,
        wireguardEndpoint: rawOptions.wireguardEndpoint as string | undefined,
        skipReconfigure: Boolean(rawOptions.skipReconfigure)
      });
      return;
    }
    if (normalizedAction === "token") {
      await clusterTokenCmd(commandArgs[0] ?? "");
      return;
    }
    if (normalizedAction === "invite") {
      if (commandArgs[1] !== undefined && rawOptions.peerCidr !== undefined) {
        throw new Error("pass the joining peer either as a positional argument or --peer-cidr, not both");
      }
      await clusterInviteCmd(commandArgs[0] ?? "", {
        peerCidr: (commandArgs[1] as string | undefined) ?? (rawOptions.peerCidr as string | undefined)
      });
      return;
    }
    if (normalizedAction === "invite-cleanup") {
      await clusterInviteCleanupCmd({
        peerCidr: rawOptions.peerCidr as string | undefined,
        expiresAt: rawOptions.expiresAt as string | undefined
      });
      return;
    }
    if (normalizedAction === "join") {
      await clusterJoinCmd({
        token: rawOptions.token as string | undefined,
        wireguard: rawOptions.wireguard as string | undefined,
        address: rawOptions.address as string | undefined,
        storagePool: rawOptions.storagePool as string | undefined,
        peerCidr: rawOptions.peerCidr as string | undefined,
        yes: Boolean(rawOptions.yes),
        skipExport: Boolean(rawOptions.skipExport),
        skipReconfigure: Boolean(rawOptions.skipReconfigure)
      });
      return;
    }
    if (normalizedAction === "evacuate") {
      await clusterEvacuateCmd(commandArgs[0] ?? "", { yes: Boolean(rawOptions.yes) });
      return;
    }
    if (normalizedAction === "restore") {
      await clusterRestoreCmd(commandArgs[0] ?? "", { yes: Boolean(rawOptions.yes) });
      return;
    }
    if (normalizedAction === "move") {
      await clusterMoveCmd(commandArgs[0] ?? "", commandArgs[1] ?? "");
      return;
    }
    if (normalizedAction === "remove") {
      await clusterRemoveCmd(commandArgs[0] ?? "", {
        move: Boolean(rawOptions.move),
        target: rawOptions.target as string | undefined,
        force: Boolean(rawOptions.force),
        yes: Boolean(rawOptions.yes),
        skipReconfigure: Boolean(rawOptions.skipReconfigure)
      });
      return;
    }
    if (normalizedAction === "ovn" && commandArgs[0] === "configure") {
      await clusterOvnConfigureCmd({
        network: rawOptions.network as string | undefined,
        parent: rawOptions.parent as string | undefined,
        centralAddresses: rawOptions.centralAddresses as string | undefined,
        peerCidr: rawOptions.peerCidr as string | undefined,
        skipReconfigure: Boolean(rawOptions.skipReconfigure)
      });
      return;
    }

    throw new Error(`unsupported cluster action: ${[action, ...commandArgs].join(" ")}`);
  });

cli
  .command("proxy <action>", "Proxy operations")
  .usage("proxy sync")
  .action(async (action) => {
    if (action !== "sync") {
      throw new Error(`unsupported proxy action: ${action}`);
    }
    await syncProxyConfig();
  });

function mountAlias(options: Record<string, unknown>, current: string, legacy: string, currentFlag = current, legacyFlag = legacy): string | undefined {
  const preferred = cliOption(options, current, [currentFlag]);
  const old = cliOption(options, legacy, [legacyFlag]);
  if (preferred && old && preferred !== old) throw new Error(`Conflicting --${currentFlag} and --${legacyFlag} values`);
  return preferred ?? old;
}

cli
  .command("mount <action> [...args]", "Manage host SMB/CIFS mounts")
  .option("-p, --password <password>", "SMB/CIFS password for non-interactive automation", STRING_OPTION)
  .option("--password-file <path>", "Read SMB/CIFS password from a root-readable file", STRING_OPTION)
  .option("--uid <uid>", "UID to present for mounted files", STRING_OPTION)
  .option("--gid <gid>", "GID to present for mounted files", STRING_OPTION)
  .option("--file-mode <mode>", "File mode for mounted files", { ...STRING_OPTION, default: DEFAULT_CIFS_FILE_MODE })
  .option("--dir-mode <mode>", "Directory mode for mounted directories", { ...STRING_OPTION, default: DEFAULT_CIFS_DIR_MODE })
  .option("--seal <value>", "Enable SMB encryption: true or false", { ...STRING_OPTION, default: "true" })
  .option("--container <name>", "Attach the mount to an LXD container with container-aware ownership", STRING_OPTION)
  .option("--instance <name>", "Attach to an LXD instance with matching ownership", STRING_OPTION)
  .option("--instance-path <path>", "Path inside the instance", STRING_OPTION)
  .option("--container-path <path>", "Path inside the attached LXD container", STRING_OPTION)
  .option("--device <name>", "LXD disk device name for --instance or mount attach", STRING_OPTION)
  .usage(
    "mount add smb|cifs /host/path //server/share username [-p PASSWORD|--password-file PATH] [--instance NAME]\n  terrariumctl mount attach /host/path INSTANCE [/instance/path]\n  terrariumctl mount remove /host/path\n  terrariumctl mount list"
  )
  .action(async (action, args, options) => {
    const normalizedAction = action.trim().toLowerCase();
    const commandArgs = (args as string[]) ?? [];
    const rawOptions = options as Record<string, unknown>;

    if (normalizedAction === "add") {
      const [protocol, hostPath, address, username] = commandArgs;
      if (!protocol || !hostPath || !address || !username) {
        throw new Error("mount add requires: <protocol> <hostPath> <address> <username>");
      }
      await mountAddCmd(protocol, hostPath, address, username, rawOptions.password as string | undefined, {
        passwordFile: cliOption(rawOptions, "passwordFile", ["password-file"]),
        uid: cliOption(rawOptions, "uid"),
        gid: cliOption(rawOptions, "gid"),
        fileMode: cliOption(rawOptions, "fileMode", ["file-mode"]),
        dirMode: cliOption(rawOptions, "dirMode", ["dir-mode"]),
        seal: parseBooleanOption(rawOptions.seal as string | undefined, "--seal", true),
        instance: mountAlias(rawOptions, "instance", "container"),
        instancePath: mountAlias(rawOptions, "instancePath", "containerPath", "instance-path", "container-path"),
        device: cliOption(rawOptions, "device")
      });
      return;
    }

    if (normalizedAction === "attach") {
      const [hostPath, instance, instancePath] = commandArgs;
      if (!hostPath || !instance) {
        throw new Error("mount attach requires: <hostPath> <instance> [/instance/path]");
      }
      const flagPath = mountAlias(rawOptions, "instancePath", "containerPath", "instance-path", "container-path");
      if (instancePath && flagPath && instancePath !== flagPath) throw new Error("Positional instance path conflicts with --instance-path/--container-path");
      await mountAttachCmd(hostPath, instance, {
        instancePath: instancePath || flagPath,
        device: cliOption(rawOptions, "device")
      });
      return;
    }

    if (normalizedAction === "remove") {
      const [hostPath] = commandArgs;
      if (!hostPath) {
        throw new Error("mount remove requires: <hostPath>");
      }
      await mountRemoveCmd(hostPath, confirmDestructive);
      return;
    }

    if (normalizedAction === "list") {
      await mountListCmd();
      return;
    }

    throw new Error(`unsupported mount action: ${action}`);
  });

cli
  .command("idp <action>", "Identity provider operations")
  .option("--source <source>", "Restore source: local or s3")
  .option("--at <snapshotOrTimestamp>", "Snapshot name fragment or timestamp")
  .option("--as-new <name>", "Restore as a new instance")
  .option("--lines <count>", "Log lines to show", { ...STRING_OPTION, default: "120" })
  .usage("idp sync | idp status | idp logs [--lines N] | idp backup | idp restore [--source local|s3] [--at SNAPSHOT|TIMESTAMP] [--as-new NAME]")
  .action(async (action, options) => {
    const rawOptions = options as Record<string, unknown>;
    if (action === "sync") {
      await syncIdpConfig();
      return;
    }
    if (action === "status") {
      await idpStatusCmd();
      return;
    }
    if (action === "logs") {
      await idpLogsCmd(cliOption(rawOptions, "lines"));
      return;
    }
    if (action === "backup") {
      await idpBackupCmd();
      return;
    }
    if (action === "restore") {
      await idpRestoreCmd({
        source: cliOption(rawOptions, "source"),
        at: cliOption(rawOptions, "at"),
        asNew: cliOption(rawOptions, "asNew", ["as-new"])
      });
      return;
    }
    throw new Error(`unsupported idp action: ${action}`);
  });

cli
  .command("set <section> [...args]", "Update saved Terrarium configuration")
  .option("--manage-domain <domain>", "Override the Cockpit domain", STRING_OPTION)
  .option("--proxy-domain <domain>", "Override the Traefik dashboard domain", STRING_OPTION)
  .option("--lxd-domain <domain>", "Override the LXD domain", STRING_OPTION)
  .option("--auth-domain <domain>", "Override the local identity-provider domain", STRING_OPTION)
  .option("--email <email>", "Terrarium contact/admin email", STRING_OPTION)
  .option("--acme-email <email>", "ACME account email", STRING_OPTION)
  .option("--zitadel-admin-email <email>", "ZITADEL bootstrap admin email", STRING_OPTION)
  .option("--logto-admin-email <email>", "Logto bootstrap admin email", STRING_OPTION)
  .option("--logto-admin-username <username>", "Logto bootstrap admin username", STRING_OPTION)
  .option("--provider <provider>", "IDP provider: zitadel|logto", STRING_OPTION)
  .option("--idp-provider <provider>", "Alias for --provider", STRING_OPTION)
  .option("--admin-group <group>", "Management admin group", STRING_OPTION)
  .option("--oidc <issuer>", "External OIDC issuer URL", STRING_OPTION)
  .option("--oidc-client <clientId>", "External OIDC client ID", STRING_OPTION)
  .option("--oidc-secret <clientSecret>", "External OIDC client secret", STRING_OPTION)
  .option("--oidc-secret-file <path>", "Read the external OIDC client secret from a root-readable file", STRING_OPTION)
  .option("--lxd-oidc-client <clientId>", "Optional separate external OIDC client ID for LXD", STRING_OPTION)
  .option("--lxd-oidc-secret <clientSecret>", "Optional separate external OIDC client secret for LXD", STRING_OPTION)
  .option("--lxd-oidc-secret-file <path>", "Read the optional LXD OIDC client secret from a root-readable file", STRING_OPTION)
  .option("--oidc-groups-claim <claim>", "Management OIDC groups claim", STRING_OPTION)
  .option("--oidc-scopes <scopes>", "Management OIDC scopes", STRING_OPTION)
  .option("--lxd-oidc-groups-claim <claim>", "LXD OIDC groups claim", STRING_OPTION)
  .option("--lxd-oidc-scopes <scopes>", "LXD OIDC scopes", STRING_OPTION)
  .option("--local-idp-outputs-path <path>", "Local IDP application outputs JSON path", STRING_OPTION)
  .option("--s3-endpoint <url>", "S3 endpoint URL", STRING_OPTION)
  .option("--s3-bucket <name>", "S3 bucket name", STRING_OPTION)
  .option("--s3-region <name>", "S3 region", STRING_OPTION)
  .option("--s3-prefix <prefix>", "S3 object prefix", STRING_OPTION)
  .option("--s3-access-key <key>", "S3 access key", STRING_OPTION)
  .option("--s3-secret-key <secret>", "S3 secret key", STRING_OPTION)
  .option("--s3-secret-key-file <path>", "Read the S3 secret key from a root-readable file", STRING_OPTION)
  .option("--syncoid-target <host>", "Remote syncoid SSH target", STRING_OPTION)
  .option("--syncoid-target-dataset <dataset>", "Remote syncoid dataset", STRING_OPTION)
  .option("--syncoid-ssh-key <path>", "SSH key path for syncoid", STRING_OPTION)
  .option("--enable", "Enable the selected integration")
  .option("--disable", "Disable the selected integration")
  .usage("set domains [rootDomain] | set emails | set idp local|oidc | set dns provider [provider] [KEY:VALUE...] | set s3 | set syncoid")
  .action(async (section, args, options) => {
    const values = (args as string[] | undefined) ?? [];
    const value = values[0];
    const rawOptions = options as Record<string, unknown>;
    const parsed = parseSetCommandOptions(rawOptions);

    if (section === "dns") {
      if (value !== "provider") {
        throw new Error("set dns requires: provider [provider] [KEY:VALUE...]");
      }
      await setDnsProviderCmd({ provider: values[1], credentials: values.slice(2) }, reconcileActions);
      return;
    }

    if (section === "domains") {
      await setDomainsCmd((value as string | undefined) || "", parsed.domains, reconcileActions, confirmDestructive);
      return;
    }
    if (section === "emails") {
      await setEmailsCmd(parsed.emails, reconcileActions);
      return;
    }
    if (section === "idp") {
      await setIdpCmd({ mode: value as string, ...parsed.idp }, reconcileActions);
      return;
    }
    if (section === "s3") {
      await setS3Cmd(parsed.s3, reconcileActions);
      return;
    }
    if (section === "syncoid") {
      await setSyncoidCmd(parsed.syncoid, reconcileActions);
      return;
    }

    throw new Error(`unsupported set section: ${section}`);
  });

cli.help();

async function main(): Promise<void> {
  try {
    const argv = normalizedArgv(process.argv);
    const userArgs = argv.slice(2);
    if (userArgs.length === 0 || (userArgs.length === 1 && userArgs[0] === "help")) {
      cli.outputHelp();
      return;
    }
    cli.parse(argv, { run: false });
    await cli.runMatchedCommand();
  } catch (error) {
    console.error(chalk.red(`${PREFIX}: ${String(error).replace(/^Error: /, "")}`));
    process.exit(1);
  }
}

void main();
