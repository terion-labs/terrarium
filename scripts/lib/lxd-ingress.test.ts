import { expect, test } from "bun:test";
import { managedInstanceAddress } from "./lxd-ingress";
import { parseInstance } from "./lxd-instance";
import { mountConsumers } from "../ctl/mount";
import { planProxyBackendEntries, findStaleExistingProxyBackendDevices } from "../terrarium-traefik-sync";

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
