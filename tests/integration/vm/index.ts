import { cac } from "cac";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { runAllowFailure } from "../lib/process";
import { shellEscape } from "../../../scripts/lib/common";

/** Exercise installed Terrarium hosts without provisioning a cloud server or touching unrelated guests. */
const cli = cac("terrarium-vm-integration")
  .option("--host <sshHost>", "First existing SSH host, for example root@server")
  .option("--peer <sshHost>", "Second existing SSH host; defaults to --host for Incus transport")
  .option("--incus-project <project>", "Run inside existing Incus VMs reached through the SSH host")
  .option("--members <names>", "Two LXD member names; also the Incus VM names with Incus transport", { default: "node1,node2" })
  .option("--output <path>", "Local evidence directory", { default: "/tmp/terrarium-vm-integration" })
  .option("--keep-on-failure", "Keep this run's guests after a failure")
  .help();

const options = cli.parse().options;
if (options.help) process.exit(0);
if (!options.host) throw new Error("--host is required; both hosts must already run this Terrarium build with VM profiles, OVN, Traefik, and S3 configured");
const members = String(options.members).split(",");
if (members.length !== 2 || members.some((member) => !/^[a-zA-Z0-9-]+$/.test(member))) throw new Error("--members must contain two member names");
const output = resolve(String(options.output));
mkdirSync(output, { recursive: true, mode: 0o700 });
const prefix = `trm-it-${Date.now().toString(36)}`;
const vm24 = `${prefix}-24`;
const vm26 = `${prefix}-26`;
const golden = `${prefix}-golden`;
const guestNames = [vm24, vm26, `${prefix}-image`, `${prefix}-local`, `${prefix}-s3`, `${prefix}-s3-remote`];
const port = 40000 + Math.floor(Math.random() * 10000);
const evidence: Record<string, unknown> = { prefix, members, started_at: new Date().toISOString(), checks: [] };
let succeeded = false;

function host(index: number) {
  const ssh = index === 0 ? String(options.host) : String(options.peer || options.host);
  return async (command: string[], settings: { stdin?: string; timeoutMs?: number; allowFailure?: boolean } = {}) => {
    const commandText = command.map(shellEscape).join(" ");
    const remote = options.incusProject
      ? ["incus", "exec", "--project", String(options.incusProject), members[index]!, "--", "bash", "-lc", commandText].map(shellEscape).join(" ")
      : commandText;
    const result = await runAllowFailure(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ssh, remote], { stdin: settings.stdin, timeoutMs: settings.timeoutMs ?? 120_000 });
    if (result.exitCode !== 0 && !settings.allowFailure) throw new Error(`${members[index]}: ${command[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  };
}
const first = host(0);
const second = host(1);
const ctl = (args: string[]) => ["terrariumctl", ...args];
const lxc = (args: string[]) => ["/snap/bin/lxc", ...args];
const write = async (run: ReturnType<typeof host>, path: string, content: string) => run(["sh", "-ec", `umask 077; cat > ${shellEscape(path)}`], { stdin: content });
const check = (name: string) => { (evidence.checks as string[]).push(name); writeFileSync(join(output, "results.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log(`Passed: ${name}`); };
const text = async (run: ReturnType<typeof host>, args: string[]) => (await run(args)).stdout.trim();
async function waitHttp(run: ReturnType<typeof host>, hostname: string, expected: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastSync = Date.now();
  while (Date.now() < deadline) {
    const result = await run(["curl", "-fsS", "--max-time", "5", "-H", `Host: ${hostname}`, "http://127.0.0.1/"], { allowFailure: true });
    if (result.exitCode === 0 && result.stdout.includes(expected)) return;
    if (Date.now() - lastSync > 10_000) { await run(ctl(["proxy", "sync"])); lastSync = Date.now(); }
    await Bun.sleep(1000);
  }
  throw new Error(`HTTP route ${hostname} did not return ${expected}`);
}

try {
  for (const [index, run] of [first, second].entries()) {
    const server = JSON.parse(await text(run, lxc(["query", "/1.0"])));
    if (!server.environment.instance_types?.includes("virtual-machine")) throw new Error(`${members[index]} does not advertise VM support`);
    evidence[`host_${index}`] = { environment: server.environment, api_extensions: server.api_extensions };
  }
  check("both existing hosts advertise native VM capability");
  const userData = `#cloud-config\n${stringify({ write_files: [{ path: "/root/guest-endpoints.py", content: readFileSync(join(import.meta.dir, "guest-endpoints.py"), "utf8") }, { path: "/etc/systemd/system/integration-http.service", content: "[Unit]\nAfter=network-online.target\n[Service]\nExecStart=/usr/bin/python3 /root/guest-endpoints.py\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n" }], runcmd: [["systemctl", "enable", "--now", "integration-http"], ["sh", "-c", "echo base > /root/restore-marker"]] })}`;
  const userDataPath = `/root/${prefix}-cloud-init.yaml`;
  await write(first, userDataPath, userData);
  await first(ctl(["launch", "ubuntu:24.04", vm24, "--vm", "--target", members[0]!, "--wait", "--timeout", "900", "--cloud-init", userDataPath, "--proxy", `http://${vm24}.test:8080,tcp://${port}:9001,udp://${port + 1}:9002`]), { timeoutMs: 1_000_000 });
  const playbook = `/root/${prefix}-playbook.yaml`;
  const compose = `/root/${prefix}-compose.yaml`;
  await write(second, playbook, "- hosts: localhost\n  tasks:\n    - ansible.builtin.copy:\n        dest: /root/provision-marker\n        content: '{{ TEST_VALUE }}'\n        mode: '0600'\n");
  await write(second, compose, "services:\n  web:\n    image: nginx:1.27-alpine\n    ports: ['8080:80']\n");
  await second(ctl(["launch", "ubuntu:26.04", vm26, "--vm", "--target", members[1]!, "--profile", "vm-dev", "--playbook", playbook, "--docker-compose", compose, "--var", "TEST_VALUE=variables-ok", "--wait", "--timeout", "900", "--proxy", `http://${vm26}.test:8080`]), { timeoutMs: 1_000_000 });
  for (const name of [vm24, vm26]) await first(ctl(["exec", name, "--", "test", "-x", "/home/terrarium/.venvs/default/bin/python"]));
  await first(ctl(["exec", vm26, "--", "sudo", "-n", "true"]));
  if (await text(first, lxc(["exec", vm26, "--", "cat", "/root/provision-marker"])) !== "variables-ok") throw new Error("Launch variables were not applied");
  check("Ubuntu 24.04/raw cloud-init and 26.04/Ansible/Compose, guest account, Python and sudo");
  for (const run of [first, second]) {
    await run(ctl(["proxy", "sync"]), { timeoutMs: 600_000 });
    await waitHttp(run, `${vm24}.test`, "terrarium-vm-integration");
    await waitHttp(run, `${vm26}.test`, "nginx");
    await run(["python3", "-c", `import socket
s=socket.create_connection(("127.0.0.1",${port}),timeout=5)
s.sendall(b"probe")
assert s.recv(512)==b"terrarium-vm-tcp:probe"
s.close()
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
s.settimeout(5)
s.sendto(b"probe",("127.0.0.1",${port + 1}))
assert s.recv(512)==b"terrarium-vm-udp:probe"
`]);
  }
  check("HTTP, TCP and UDP reach VM backends through both ingress members");
  const share = `/srv/${prefix}`;
  await first(["mkdir", "-p", share]);
  await first(["chmod", "777", share]);
  await first(ctl(["mount", "attach", share, vm24, "/mnt/integration"]));
  await first(ctl(["exec", vm24, "--", "sh", "-c", "echo guest-write > /mnt/integration/probe"]));
  if (await text(first, ["cat", `${share}/probe`]) !== "guest-write") throw new Error("VM shared directory write was lost");
  await first(lxc(["config", "device", "remove", vm24, `terrarium-${share.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 54)}`]));
  check("host directory sharing uses the guest account");
  const pool = JSON.parse(await text(first, lxc(["query", `/1.0/instances/${vm24}?project=default`]))).expanded_devices.root.pool;
  const root = await text(first, lxc(["storage", "get", pool, "zfs.pool_name", "--target", members[0]!]));
  await first(lxc(["snapshot", vm24, "native-point"]));
  await first(["zfs", "snapshot", "-r", `${root}/virtual-machines/${vm24}@${prefix}-base`, `${root}/virtual-machines/${vm24}.block@${prefix}-base`]);
  await first(ctl(["backup", "export"]), { timeoutMs: 1_800_000 });
  await first(lxc(["exec", vm24, "--", "sh", "-c", "echo incremental > /root/restore-marker; sync"]));
  await first(["zfs", "snapshot", "-r", `${root}/virtual-machines/${vm24}@${prefix}-next`, `${root}/virtual-machines/${vm24}.block@${prefix}-next`]);
  await first(ctl(["backup", "export"]), { timeoutMs: 1_800_000 });
  check("full and incremental complete-set S3 export");
  for (const [source, suffix, restoreHost] of [["local", "local", first], ["s3", "s3", first], ["s3", "s3-remote", second]] as const) {
    const name = `${prefix}-${suffix}`;
    await restoreHost(ctl(["backup", "restore", "--source", source, "--instance", vm24, "--at", `${prefix}-next`, "--as-new", name]), { stdin: "yes\nyes\n", timeoutMs: 1_800_000 });
    const snapshots = JSON.parse(await text(first, lxc(["query", `/1.0/instances/${name}/snapshots?recursion=1&project=default`])));
    if (!snapshots.some((snapshot: { name: string }) => snapshot.name.split("/").at(-1) === "native-point")) throw new Error(`${suffix} restore lost native LXD snapshot history`);
    await first(lxc(["start", name]));
    const marker = await text(first, ctl(["exec", name, "--root", "--", "cat", "/root/restore-marker"]));
    if (marker !== "incremental") throw new Error(`${source} restore lost the incremental marker`);
    const sourceId = await text(first, lxc(["exec", vm24, "--", "cat", "/etc/machine-id"]));
    const cloneId = await text(first, lxc(["exec", name, "--", "cat", "/etc/machine-id"]));
    if (sourceId === cloneId) throw new Error(`${source} clone retained the source identity`);
    await first(lxc(["exec", name, "--", "cloud-init", "status", "--wait", "--long"]), { timeoutMs: 600_000 });
    if (await text(first, lxc(["exec", name, "--", "cat", "/root/restore-marker"])) !== "incremental") throw new Error("Restored application provisioning was replayed");
    const semaphore = ["stat", "-c", "%Y", "/var/lib/cloud/instance/sem/config_scripts_user"];
    if (await text(first, lxc(["exec", vm24, "--", ...semaphore])) !== await text(first, lxc(["exec", name, "--", ...semaphore]))) throw new Error("Restored cloud-init completion state changed");
    await first(lxc(["stop", name, "--timeout", "60"]));
    check(`${suffix} restore-as-new boots with restored data, new identity and preserved provisioning`);
  }
  await first(ctl(["image", "create", vm24, golden]), { timeoutMs: 1_800_000 });
  await first(ctl(["image", "launch", golden, `${prefix}-image`, "--wait", "--timeout", "600"]), { timeoutMs: 700_000 });
  const imageGuest = JSON.parse(await text(first, lxc(["query", `/1.0/instances/${prefix}-image?project=default`])));
  if (imageGuest.type !== "virtual-machine" || imageGuest.expanded_config["user.proxy"]) throw new Error("Golden image type or route sanitization failed");
  check("golden image launches with inferred VM type and no copied routes");
  const origin = await text(first, lxc(["config", "get", vm24, "user.terrarium.backup-origin"]));
  await first(ctl(["cluster", "move", vm24, members[1]!]), { timeoutMs: 1_800_000 });
  await first(ctl(["exec", vm24, "--", "true"]));
  for (const run of [first, second]) {
    await run(ctl(["proxy", "sync"]), { timeoutMs: 600_000 });
    await waitHttp(run, `${vm24}.test`, "terrarium-vm-integration");
  }
  check("cold cluster movement restores traffic on both ingress hosts");
  if (await text(second, lxc(["config", "get", vm24, "user.terrarium.backup-origin"])) !== origin) throw new Error("Movement changed backup provenance");
  evidence.finished_at = new Date().toISOString();
  succeeded = true;
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  if (succeeded || !options.keepOnFailure) {
    for (const name of guestNames) await first(lxc(["delete", name, "--force"]), { allowFailure: true });
    await first(lxc(["image", "delete", golden]), { allowFailure: true });
    for (const run of [first, second]) await run(ctl(["proxy", "sync"]), { allowFailure: true, timeoutMs: 600_000 });
    await first(["rm", "-rf", `/srv/${prefix}`, `/root/${prefix}-cloud-init.yaml`], { allowFailure: true });
    await second(["rm", "-f", `/root/${prefix}-playbook.yaml`, `/root/${prefix}-compose.yaml`], { allowFailure: true });
    evidence.retained = "S3 backup objects and backup controller checkpoints remain available under this run's unique instance names for inspection; no shared catalog is removed.";
  }
  writeFileSync(join(output, "results.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
}
