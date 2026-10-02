import { describe, expect, test } from "bun:test";
import { instanceType, lxcArgs, parseInstance, parseVmCapability, readinessTimeout, vmLaunchTarget, waitForInstanceReady, type LxdRunner } from "./lxd-instance";

describe("LXD instance identity and readiness", () => {
  test("scopes commands without passing the unsupported project flag to raw queries", () => {
    expect(lxcArgs("exec", "app", "--", "true").slice(1)).toEqual(["--project", "default", "exec", "app", "--", "true"]);
    expect(lxcArgs("query", "/1.0/instances?project=default").slice(1)).toEqual(["query", "/1.0/instances?project=default"]);
  });
  test("never silently treats an unknown live type as a container", () => {
    expect(() => instanceType(undefined)).toThrow("missing");
    expect(() => instanceType("future-type")).toThrow("Unsupported");
    expect(parseInstance({ name: "app", type: "virtual-machine", config: {}, devices: {} }).type).toBe("virtual-machine");
    expect(() => parseInstance({ name: "app", type: "container", config: { flag: true } })).toThrow("string values");
  });

  test("uses advertised instance types rather than profile names or architecture", () => {
    expect(parseVmCapability({ environment: { instance_types: ["container"], driver: "lxc", architectures: ["x86_64"] } }).available).toBe(false);
    expect(parseVmCapability({ environment: { instance_types: ["container", "virtual-machine"], architectures: ["aarch64"] } }).available).toBe(true);
  });

  test("selects a capable member in a mixed cluster", async () => {
    const run: LxdRunner = async (args) => {
      const path = args.at(-1)!;
      const data = path.includes("/cluster/members")
        ? [{ server_name: "cpu-only", status: "Online" }, { server_name: "arm", status: "Online" }, { server_name: "vm", status: "Online" }]
        : { environment: { server_clustered: true, server_name: path, instance_types: path.includes("cpu-only") ? ["container"] : ["virtual-machine"], architectures: path.includes("arm") ? ["aarch64"] : ["x86_64"] } };
      return { exitCode: 0, stdout: JSON.stringify(data), stderr: "" };
    };
    expect(await vmLaunchTarget(undefined, "x86_64", run)).toBe("vm");
    await expect(vmLaunchTarget("cpu-only", "x86_64", run)).rejects.toThrow("cannot run virtual machines");
    await expect(vmLaunchTarget("arm", "x86_64", run)).rejects.toThrow("cannot run x86_64");
  });

  test("preserves native LXD placement when every online member is eligible", async () => {
    const run: LxdRunner = async (args) => ({ exitCode: 0, stderr: "", stdout: JSON.stringify(args.at(-1)!.includes("/cluster/members") ? [{ server_name: "node1", status: "Online" }, { server_name: "node2", status: "Online" }] : { environment: { server_clustered: true, server_name: "node1", instance_types: ["container", "virtual-machine"], architectures: ["x86_64"] } }) });
    expect(await vmLaunchTarget(undefined, "x86_64", run)).toBeUndefined();
  });

  test("reports provisioning failure without retrying cloud-init or user commands", async () => {
    const calls: string[][] = [];
    const run: LxdRunner = async (args) => {
      calls.push(args);
      return { exitCode: args.includes("cloud-init") ? 1 : 0, stdout: "", stderr: "" };
    };
    await expect(waitForInstanceReady("vm", { provisioning: true, timeoutMs: 100 }, run)).rejects.toThrow("cloud-init failed");
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(-2)).toEqual(["--", "true"]);
  });

  test("fails clearly for a stopped guest and validates timeout bounds", async () => {
    const run: LxdRunner = async (args) => args.includes("exec")
      ? { exitCode: 1, stdout: "", stderr: "agent unavailable" }
      : { exitCode: 0, stdout: JSON.stringify({ name: "vm", type: "virtual-machine", status: "Stopped" }), stderr: "" };
    await expect(waitForInstanceReady("vm", { timeoutMs: 100 }, run)).rejects.toThrow("Stopped");
    expect(readinessTimeout("45")).toBe(45000);
    for (const value of ["0", "-1", "NaN", "Infinity", "999999"]) expect(() => readinessTimeout(value)).toThrow("--timeout");
  });
});
