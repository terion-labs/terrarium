import { expect, test } from "bun:test";
import { ensureIngressInstance, ingressInstanceName, managedInstanceAddress } from "./lxd-ingress";
import { parseInstance, type LxdRunner } from "./lxd-instance";
import { mountConsumers } from "../ctl/mount";
import { planProxyBackendEntries, findStaleExistingProxyBackendDevices } from "../terrarium-traefik-sync";

test.each([
  { clustered: false, location: "none", accepted: true },
  { clustered: false, location: "", accepted: true },
  { clustered: true, location: "node1", accepted: true },
  { clustered: true, location: "", accepted: false },
  { clustered: true, location: "node2", accepted: false }
])("ingress helper reuse with clustered=$clustered and location=$location", async ({ clustered, location, accepted }) => {
  const name = ingressInstanceName("node1");
  const helper = parseInstance({
    name, type: "container", status: "Running", location,
    config: { "user.terrarium.role": "ingress", "user.terrarium.member": "node1" },
    devices: { eth0: { type: "nic", network: "ovn" } }
  });
  const run: LxdRunner = async (args) => {
    // An existing, running helper must be reused without any LXD mutation.
    expect(args[1]).toBe("query");
    const path = args.at(-1);
    const data = path === "/1.0" ? { environment: { server_clustered: clustered, server_name: "node1" } }
      : path === "/1.0/cluster/members/node1" ? { status: "Online" }
      : path === "/1.0/instances?recursion=1&project=default" ? [helper]
      : undefined;
    expect(data).toBeDefined();
    return { exitCode: 0, stdout: JSON.stringify(data), stderr: "" };
  };
  if (!accepted) {
    await expect(ensureIngressInstance("node1", "ovn", run)).rejects.toThrow("Refusing to replace");
    return;
  }
  for (let sync = 0; sync < 2; sync++) {
    expect(await ensureIngressInstance("node1", "ovn", run)).toEqual(helper);
  }
  helper.config["user.terrarium.member"] = "another-owner";
  await expect(ensureIngressInstance("node1", "ovn", run)).rejects.toThrow("Refusing to replace");
});

test("VM ingress uses the managed NIC's MAC, not Docker's first IPv4", () => {
  const instance = parseInstance({ name: "vm", type: "virtual-machine", config: { "volatile.eth0.hwaddr": "00:11:22:33:44:55" }, devices: { eth0: { type: "nic", network: "ovn" } } });
  const state = {
    docker0: { hwaddr: "00:aa:bb:cc:dd:ee", addresses: [{ family: "inet", scope: "global", address: "172.17.0.1" }] },
    enp5s0: { hwaddr: "00:11:22:33:44:55", addresses: [{ family: "inet", scope: "global", address: "10.1.0.2" }] }
  };
  expect(managedInstanceAddress(instance, "ovn", state)).toBe("10.1.0.2");
  expect(managedInstanceAddress(instance, "another-network", state)).toBeUndefined();
  expect(managedInstanceAddress(instance, "ovn", { docker0: state.docker0 })).toBeUndefined();
});

test("VM backend allocation tracks the helper as device owner across a placement change", () => {
  const spec = { key: "vm:tcp:8080", containerName: "vm", proto: "tcp" as const, targetPort: 8080, deviceName: "terrarium-proxy-test", deviceInstance: "helper", targetAddress: "10.1.0.2" };
  const previous = [{ ...spec, deviceInstance: undefined, hostPort: 18081 }];
  const existing = [{ containerName: "helper", deviceName: spec.deviceName, hostPort: 18082 }];
  const plan = planProxyBackendEntries([spec], previous, existing);
  expect(plan.entries[0]?.deviceInstance).toBe("helper");
  expect(plan.errors).toEqual([]);
  expect(findStaleExistingProxyBackendDevices(existing, [spec])).toEqual([]);
  expect(findStaleExistingProxyBackendDevices(existing, [])).toEqual(existing);
});

test("share ownership changes detect container and VM consumers, including subdirectories", () => {
  const instances = [
    parseInstance({ name: "container", type: "container", devices: { share: { type: "disk", source: "/srv/shared/sub", path: "/mnt" } } }),
    parseInstance({ name: "vm", type: "virtual-machine", devices: { share: { type: "disk", source: "/srv/shared", path: "/mnt" } } }),
    parseInstance({ name: "unrelated", type: "container", devices: { share: { type: "disk", source: "/srv/shared-other", path: "/mnt" } } })
  ];
  expect(mountConsumers(instances, "/srv/shared")).toEqual(["container", "vm"]);
  expect(mountConsumers(instances, "/srv/shared", "vm")).toEqual(["container"]);
});
