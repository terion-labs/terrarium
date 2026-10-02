import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CompletionShell = "bash" | "zsh" | "fish";
export type CompletionInstallShell = CompletionShell | "all";

type CompletionInstallResult = {
  shell: CompletionShell;
  installed: boolean;
  path?: string;
  reason?: string;
};

const DEFAULT_BASH_COMPLETION_DIR = "/usr/share/bash-completion/completions";
const DEFAULT_ZSH_COMPLETION_DIR = "/usr/local/share/zsh/site-functions";
const DEFAULT_FISH_COMPLETION_DIR = "/usr/share/fish/vendor_completions.d";
const DEFAULT_PROFILE_D_DIR = "/etc/profile.d";
const DEFAULT_BIN_DIR = "/usr/local/bin";

const commands = [
  "install",
  "status",
  "backup",
  "reconfigure",
  "update",
  "launch",
  "image",
  "exec",
  "config",
  "cluster",
  "proxy",
  "mount",
  "idp",
  "set",
  "completion"
];

const actions: Record<string, string[]> = {
  backup: ["list", "export", "replicate", "restore"],
  image: ["create", "list", "launch", "delete"],
  config: ["import", "export"],
  cluster: ["status", "init", "invite", "token", "join", "evacuate", "restore", "move", "remove", "ovn"],
  proxy: ["sync"],
  mount: ["add", "attach", "remove", "list"],
  idp: ["sync", "status", "logs", "backup", "restore"],
  set: ["domains", "emails", "idp", "dns", "s3", "syncoid"],
  completion: ["bash", "zsh", "fish", "all"]
};

const optionGroups: Record<string, string[]> = {
  install: [
    "--non-interactive",
    "--yes",
    "--ref",
    "--email",
    "--acme-email",
    "--domain",
    "--manage-domain",
    "--proxy-domain",
    "--lxd-domain",
    "--idp",
    "--idp-provider",
    "--admin-group",
    "--oidc",
    "--oidc-client",
    "--oidc-secret",
    "--oidc-secret-file",
    "--lxd-oidc-client",
    "--lxd-oidc-secret",
    "--lxd-oidc-secret-file",
    "--auth-domain",
    "--zitadel-admin-email",
    "--logto-admin-email",
    "--logto-admin-username",
    "--generate-root-pwd",
    "--root-pwd-file",
    "--storage-mode",
    "--storage-source",
    "--storage-size",
    "--enable-s3",
    "--s3-endpoint",
    "--s3-bucket",
    "--s3-region",
    "--s3-prefix",
    "--s3-access-key",
    "--s3-secret-key",
    "--s3-secret-key-file",
    "--enable-syncoid",
    "--syncoid-target",
    "--syncoid-target-dataset",
    "--syncoid-ssh-key"
  ],
  backup: ["--source", "--instance", "--at", "--as-new"],
  update: ["--ref", "--skip-reconfigure", "--non-interactive"],
  launch: [
    "--vm", "--target", "--wait", "--timeout", "--var", "--vars",
    "--profile",
    "--disk",
    "--memory",
    "--cpu",
    "--requirements",
    "--playbook",
    "--role",
    "--docker-compose",
    "--cloud-init",
    "--proxy"
  ],
  image: ["--snapshot", "--live", "--reuse", "--vm", "--target", "--wait", "--timeout", "--profile", "--disk", "--memory", "--cpu", "--proxy", "--requirements", "--playbook", "--role", "--docker-compose", "--cloud-init", "--var", "--vars"],
  exec: ["--root", "--user"],
  cluster: [
    "--member",
    "--address",
    "--token",
    "--storage-pool",
    "--network",
    "--parent",
    "--central-addresses",
    "--peer-cidr",
    "--wireguard",
    "--wireguard-cidr",
    "--wireguard-port",
    "--wireguard-endpoint",
    "--expires-at",
    "--target",
    "--move",
    "--force",
    "--yes",
    "--skip-export",
    "--skip-reconfigure"
  ],
  mount: [
    "-p",
    "--password",
    "--password-file",
    "--uid",
    "--gid",
    "--file-mode",
    "--dir-mode",
    "--seal",
    "--container",
    "--instance",
    "--container-path",
    "--instance-path",
    "--device"
  ],
  idp: ["--source", "--at", "--as-new", "--lines"],
  set: [
    "--manage-domain",
    "--proxy-domain",
    "--lxd-domain",
    "--auth-domain",
    "--email",
    "--acme-email",
    "--zitadel-admin-email",
    "--logto-admin-email",
    "--logto-admin-username",
    "--provider",
    "--idp-provider",
    "--admin-group",
    "--oidc",
    "--oidc-client",
    "--oidc-secret",
    "--oidc-secret-file",
    "--lxd-oidc-client",
    "--lxd-oidc-secret",
    "--lxd-oidc-secret-file",
    "--s3-endpoint",
    "--s3-bucket",
    "--s3-region",
    "--s3-prefix",
    "--s3-access-key",
    "--s3-secret-key",
    "--s3-secret-key-file",
    "--syncoid-target",
    "--syncoid-target-dataset",
    "--syncoid-ssh-key",
    "--enable",
    "--disable"
  ]
};

export function commandCompletionCandidates(prefix: string): string[] {
  return commands.filter((command) => command.startsWith(prefix));
}

function words(values: string[]): string {
  return values.join(" ");
}

export function completionScript(shell: CompletionShell): string {
  if (shell === "bash") {
    return bashCompletion();
  }
  if (shell === "zsh") {
    return zshCompletion();
  }
  return fishCompletion();
}

function pathEnv(): string[] {
  return (process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
    .split(":")
    .filter(Boolean);
}

function executableExists(name: string): boolean {
  return pathEnv().some((directory) => {
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function shellListed(name: string): boolean {
  try {
    return readFileSync("/etc/shells", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .some((line) => line === name || line.endsWith(`/${name}`));
  } catch {
    return false;
  }
}

function forcedCompletionShells(): Set<CompletionShell> | undefined {
  const raw = process.env.TERRARIUM_COMPLETION_SHELLS?.trim();
  if (!raw) {
    return undefined;
  }
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((shell) => shell.trim())
      .filter((shell): shell is CompletionShell => ["bash", "zsh", "fish"].includes(shell))
  );
}

function shellIsAvailable(shell: CompletionShell): boolean {
  const forced = forcedCompletionShells();
  if (forced) {
    return forced.has(shell);
  }
  return executableExists(shell) || shellListed(shell);
}

function bashCompletionDir(): string {
  return process.env.TERRARIUM_BASH_COMPLETION_DIR || DEFAULT_BASH_COMPLETION_DIR;
}

function zshCompletionDir(): string {
  return process.env.TERRARIUM_ZSH_COMPLETION_DIR || DEFAULT_ZSH_COMPLETION_DIR;
}

function fishCompletionDir(): string {
  return process.env.TERRARIUM_FISH_COMPLETION_DIR || DEFAULT_FISH_COMPLETION_DIR;
}

function profileDDir(): string {
  return process.env.TERRARIUM_PROFILE_D_DIR || DEFAULT_PROFILE_D_DIR;
}

function binDir(): string {
  return process.env.TERRARIUM_BIN_DIR || DEFAULT_BIN_DIR;
}

function completionPath(shell: CompletionShell, command: "terrariumctl" | "trm"): string {
  if (shell === "bash") {
    return join(bashCompletionDir(), command);
  }
  if (shell === "zsh") {
    return join(zshCompletionDir(), `_${command}`);
  }
  return join(fishCompletionDir(), `${command}.fish`);
}

function bashProfileLoaderPath(): string {
  return join(profileDDir(), "terrariumctl-completion.sh");
}

function bashProfileLoader(): string {
  return `# Terrarium shell completion bootstrap.

# bash-completion normally lazy-loads /usr/share/bash-completion/completions
# entries, but freshly updated hosts and minimal root shells do not always have
# that machinery active. Load Terrarium completion explicitly for interactive
# Bash shells while keeping non-interactive shell startup untouched.
if [ -n "\${BASH_VERSION:-}" ]; then
  case "$-" in *i*)
    if ! complete -p terrariumctl >/dev/null 2>&1 && [ -r ${completionPath("bash", "terrariumctl")} ]; then
      . ${completionPath("bash", "terrariumctl")}
    fi
  ;; esac
fi
`;
}

function managedTrmAliasExists(): boolean {
  const trmPath = join(binDir(), "trm");
  if (!existsSync(trmPath)) {
    return false;
  }
  try {
    const stat = lstatSync(trmPath);
    if (!stat.isSymbolicLink()) {
      return false;
    }
    const target = readlinkSync(trmPath);
    return target === join(binDir(), "terrariumctl") || target === "/usr/local/bin/terrariumctl";
  } catch {
    return false;
  }
}

function writeFile(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function replaceSymlink(path: string, target: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  rmSync(path, { force: true });
  symlinkSync(target, path);
}

function installCompletionScript(shell: CompletionShell): CompletionInstallResult {
  const primaryPath = completionPath(shell, "terrariumctl");
  writeFile(primaryPath, completionScript(shell));

  if (managedTrmAliasExists()) {
    replaceSymlink(completionPath(shell, "trm"), primaryPath);
  }

  if (shell === "bash") {
    writeFile(bashProfileLoaderPath(), bashProfileLoader());
  }

  return { shell, installed: true, path: primaryPath };
}

export function installCompletionScripts(shell: CompletionInstallShell): CompletionInstallResult[] {
  const shells: CompletionShell[] = shell === "all" ? ["bash", "zsh", "fish"] : [shell];
  return shells.map((candidate) => {
    if (shell === "all" && !shellIsAvailable(candidate)) {
      return { shell: candidate, installed: false, reason: `${candidate} is not installed` };
    }
    return installCompletionScript(candidate);
  });
}

function bashCompletion(): string {
  return `# terrariumctl bash completion
_terrariumctl_complete() {
  local cur command
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  command="\${COMP_WORDS[1]}"

  if [[ "\${cur}" == -* ]]; then
    case "\${command}" in
      install) COMPREPLY=( $(compgen -W "${words(optionGroups.install)} --help" -- "\${cur}") ) ;;
      backup) COMPREPLY=( $(compgen -W "${words(optionGroups.backup)} --help" -- "\${cur}") ) ;;
      update) COMPREPLY=( $(compgen -W "${words(optionGroups.update)} --help" -- "\${cur}") ) ;;
      launch) COMPREPLY=( $(compgen -W "${words(optionGroups.launch)} --help" -- "\${cur}") ) ;;
      image) COMPREPLY=( $(compgen -W "${words(optionGroups.image)} --help" -- "\${cur}") ) ;;
      exec) COMPREPLY=( $(compgen -W "${words(optionGroups.exec)} --help" -- "\${cur}") ) ;;
      cluster) COMPREPLY=( $(compgen -W "${words(optionGroups.cluster)} --help" -- "\${cur}") ) ;;
      mount) COMPREPLY=( $(compgen -W "${words(optionGroups.mount)} --help" -- "\${cur}") ) ;;
      idp) COMPREPLY=( $(compgen -W "${words(optionGroups.idp)} --help" -- "\${cur}") ) ;;
      set) COMPREPLY=( $(compgen -W "${words(optionGroups.set)} --help" -- "\${cur}") ) ;;
      *) COMPREPLY=( $(compgen -W "--help --version" -- "\${cur}") ) ;;
    esac
    return 0
  fi

  case "\${COMP_CWORD}" in
    1)
      COMPREPLY=( $(compgen -W "${words(commands)}" -- "\${cur}") )
      ;;
    2)
      case "\${command}" in
        backup) COMPREPLY=( $(compgen -W "${words(actions.backup)}" -- "\${cur}") ) ;;
        image) COMPREPLY=( $(compgen -W "${words(actions.image)}" -- "\${cur}") ) ;;
        config) COMPREPLY=( $(compgen -W "${words(actions.config)}" -- "\${cur}") ) ;;
        cluster) COMPREPLY=( $(compgen -W "${words(actions.cluster)}" -- "\${cur}") ) ;;
        proxy) COMPREPLY=( $(compgen -W "${words(actions.proxy)}" -- "\${cur}") ) ;;
        mount) COMPREPLY=( $(compgen -W "${words(actions.mount)}" -- "\${cur}") ) ;;
        idp) COMPREPLY=( $(compgen -W "${words(actions.idp)}" -- "\${cur}") ) ;;
        set) COMPREPLY=( $(compgen -W "${words(actions.set)}" -- "\${cur}") ) ;;
        completion) COMPREPLY=( $(compgen -W "${words(actions.completion)}" -- "\${cur}") ) ;;
      esac
      ;;
    3)
      if [[ "\${command}" == "set" && "\${COMP_WORDS[2]}" == "idp" ]]; then
        COMPREPLY=( $(compgen -W "local oidc" -- "\${cur}") )
      elif [[ "\${command}" == "set" && "\${COMP_WORDS[2]}" == "dns" ]]; then
        COMPREPLY=( $(compgen -W "provider" -- "\${cur}") )
      elif [[ "\${command}" == "mount" && "\${COMP_WORDS[2]}" == "add" ]]; then
        COMPREPLY=( $(compgen -W "smb cifs" -- "\${cur}") )
      elif [[ "\${command}" == "cluster" && "\${COMP_WORDS[2]}" == "ovn" ]]; then
        COMPREPLY=( $(compgen -W "configure" -- "\${cur}") )
      elif [[ "\${command}" == "completion" ]]; then
        COMPREPLY=( $(compgen -W "install" -- "\${cur}") )
      fi
      ;;
  esac
}

complete -F _terrariumctl_complete terrariumctl
complete -F _terrariumctl_complete trm
`;
}

function zshCompletion(): string {
  return `#compdef terrariumctl trm

_terrariumctl() {
  local -a commands actions opts
  commands=(${words(commands)})

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  case "$words[2]" in
    backup) actions=(${words(actions.backup)}); opts=(${words(optionGroups.backup)}) ;;
    image) actions=(${words(actions.image)}); opts=(${words(optionGroups.image)}) ;;
    config) actions=(${words(actions.config)}) ;;
    cluster) actions=(${words(actions.cluster)}); opts=(${words(optionGroups.cluster)}) ;;
    proxy) actions=(${words(actions.proxy)}) ;;
    mount) actions=(${words(actions.mount)}); opts=(${words(optionGroups.mount)}) ;;
    idp) actions=(${words(actions.idp)}); opts=(${words(optionGroups.idp)}) ;;
    set) actions=(${words(actions.set)}); opts=(${words(optionGroups.set)}) ;;
    completion) actions=(${words(actions.completion)}) ;;
    install) opts=(${words(optionGroups.install)}) ;;
    update) opts=(${words(optionGroups.update)}) ;;
    launch) opts=(${words(optionGroups.launch)}) ;;
    exec) opts=(${words(optionGroups.exec)}) ;;
  esac

  if [[ "$PREFIX" == -* ]]; then
    _describe 'option' opts
    return
  fi

  if (( CURRENT == 3 )); then
    _describe 'action' actions
    return
  fi

  if [[ "$words[2]" == "set" && "$words[3]" == "idp" ]]; then
    compadd local oidc
  elif [[ "$words[2]" == "set" && "$words[3]" == "dns" ]]; then
    compadd provider
  elif [[ "$words[2]" == "mount" && "$words[3]" == "add" ]]; then
    compadd smb cifs
  elif [[ "$words[2]" == "cluster" && "$words[3]" == "ovn" ]]; then
    compadd configure
  elif [[ "$words[2]" == "completion" ]]; then
    compadd install
  fi
}

_terrariumctl "$@"
`;
}

function fishCompletion(): string {
  const lines = ["# terrariumctl fish completion"];
  for (const command of ["terrariumctl", "trm"]) {
    lines.push(`complete -c ${command} -f -n "__fish_use_subcommand" -a "${words(commands)}"`);
    for (const [rootCommand, rootActions] of Object.entries(actions)) {
      lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from ${rootCommand}" -a "${words(rootActions)}"`);
    }
    for (const [rootCommand, options] of Object.entries(optionGroups)) {
      for (const option of options) {
        if (option.startsWith("--")) {
          lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from ${rootCommand}" -l ${option.replace(/^--/, "")}`);
        } else if (option.startsWith("-")) {
          lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from ${rootCommand}" -s ${option.replace(/^-/, "")}`);
        }
      }
    }
    lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from set; and __fish_seen_subcommand_from idp" -a "local oidc"`);
    lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from set; and __fish_seen_subcommand_from dns" -a "provider"`);
    lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from mount; and __fish_seen_subcommand_from add" -a "smb cifs"`);
    lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from cluster; and __fish_seen_subcommand_from ovn" -a "configure"`);
    lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from completion; and __fish_seen_subcommand_from bash zsh fish all" -a "install"`);
  }
  return `${lines.join("\n")}\n`;
}
