import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
  addressCandidatesFromIpJson,
  applyClusterConfig,
  bestPeerCidrForAddress,
  buildWorkloadMovePlan,
  buildJoinPreseed,
  clusterMemberAddressesFromJson,
  clusterMembersFromJson,
  decodeWireGuardJoinBundle,
  decodeLxdJoinToken,
  endpointHost,
  extractLxdJoinToken,
  instanceNamesFromLxcListJson,
  instancesFromLxcListJson,
  memoryLoadFromResourcesJson,
  normalizeClusterEndpoint,
  nextWireGuardTunnelIp,
  ovnDbEndpoints,
  partitionDeviceForStorageSource,
  parseCsv,
  parsePeerCidrs,
  peerCidrsFromHostsOutput,
  peerCidrsFromJoinToken,
  selectClusterAddressCandidate,
  selectOvnCentralAddresses,
  resolveJoinStorageConfig,
  renderWireGuardConfig,
  secondsUntilInviteCleanup,
  unjoinedExactInvitePeerCidrs
} from "./cluster";

function encodeWireGuardBundle(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

describe("terrariumctl cluster", () => {
  test("normalizes cluster listener endpoints", () => {
    expect(normalizeClusterEndpoint("10.0.0.10")).toBe("10.0.0.10:8443");
    expect(normalizeClusterEndpoint("10.0.0.10:9443")).toBe("10.0.0.10:9443");
    expect(normalizeClusterEndpoint("[2001:db8::10]:8443")).toBe("[2001:db8::10]:8443");
  });

  test("renders a deterministic LXD join preseed", () => {
    const preseed = parse(
      buildJoinPreseed({
        serverAddress: "10.0.0.20:8443",
        clusterToken: "token-123",
        storagePool: "terrarium"
      })
    ) as Record<string, any>;

    expect(preseed.cluster.enabled).toBe(true);
    expect(preseed.cluster.server_address).toBe("10.0.0.20:8443");
    expect(preseed.cluster.cluster_token).toBe("token-123");
    expect(preseed.cluster.member_config).toContainEqual({
      entity: "storage-pool",
      name: "terrarium",
      key: "source",
      value: "terrarium"
    });
  });

  test("extracts the machine-usable join token from LXD output", () => {
    const token = "eyJzZXJ2ZXJfbmFtZSI6ImNsdXN0ZXItam9pbiJ9";

    expect(extractLxdJoinToken(`Member cluster-join join token:\n${token}\n`)).toBe(token);
    expect(extractLxdJoinToken(`${token}\n`)).toBe(token);
  });

  test("decodes LXD join tokens for address auto-discovery", () => {
    const token = Buffer.from(
      JSON.stringify({
        server_name: "node2",
        addresses: ["10.0.0.11:8443", "[2001:db8::11]:8443"],
        expires_at: "2026-05-02T12:00:00Z"
      }),
      "utf8"
    ).toString("base64");

    expect(decodeLxdJoinToken(token)).toEqual({
      serverName: "node2",
      addresses: ["10.0.0.11:8443", "[2001:db8::11]:8443"],
      expiresAt: "2026-05-02T12:00:00Z"
    });
    expect(peerCidrsFromJoinToken(token)).toEqual(["10.0.0.11/32", "2001:db8::11/128"]);
  });

  test("derives exact peer CIDRs from resolved host records", () => {
    expect(
      peerCidrsFromHostsOutput(`
        10.0.0.12 node2
        10.0.0.12 node2.local
        2001:db8::12 node2
      `)
    ).toEqual(["10.0.0.12/32", "2001:db8::12/128"]);
  });

  test("extracts hosts from cluster endpoints", () => {
    expect(endpointHost("10.0.0.11:8443")).toBe("10.0.0.11");
    expect(endpointHost("cluster.example.test")).toBe("cluster.example.test");
    expect(endpointHost("https://10.0.0.11:8443")).toBe("10.0.0.11");
    expect(endpointHost("[2001:db8::11]:8443")).toBe("2001:db8::11");
  });

  test("normalizes peer IP input to exact CIDRs", () => {
    expect(parsePeerCidrs("10.0.0.12, [2001:db8::12]:8443, 10.0.0.0/24")).toEqual([
      "10.0.0.12/32",
      "2001:db8::12/128",
      "10.0.0.0/24"
    ]);
  });

  test("plans temporary invite cleanup from token expiry and joined members", () => {
    expect(secondsUntilInviteCleanup("2026-05-02T12:10:00Z", Date.parse("2026-05-02T12:00:00Z"))).toBe(600);
    expect(secondsUntilInviteCleanup("not-a-date", Date.parse("2026-05-02T12:00:00Z"))).toBeNull();
    expect(unjoinedExactInvitePeerCidrs(["10.0.0.12/32", "10.0.0.0/24", "2001:db8::12/128"], ["10.0.0.13", "2001:db8::12"])).toEqual([
      "10.0.0.12/32"
    ]);
  });

  test("derives safe OVN central defaults from LXD cluster JSON", () => {
    const clusterJson = JSON.stringify([
      { server_name: "node1", status: "Online", url: "https://10.0.0.11:8443" },
      { server_name: "node2", status: "Online", url: "https://10.0.0.12:8443" },
      { server_name: "node3", status: "Online", url: "https://10.0.0.13:8443" },
      { server_name: "node4", status: "Offline", url: "https://10.0.0.14:8443" }
    ]);
    const addresses = clusterMemberAddressesFromJson(clusterJson);

    expect(addresses).toEqual(["10.0.0.11", "10.0.0.12", "10.0.0.13"]);
    expect(clusterMembersFromJson(clusterJson, { onlineOnly: false }).map((member) => member.name)).toEqual(["node1", "node2", "node3", "node4"]);
    expect(selectOvnCentralAddresses(addresses)).toEqual(["10.0.0.11", "10.0.0.12", "10.0.0.13"]);
    expect(selectOvnCentralAddresses([...addresses, "10.0.0.15"])).toEqual(["10.0.0.11", "10.0.0.12", "10.0.0.13"]);
  });

  test("derives workload movement defaults", () => {
    expect(
      instanceNamesFromLxcListJson(
        JSON.stringify([
          { name: "app-a", status: "Running" },
          { name: "app-b", status: "Stopped" },
          { status: "Broken" }
        ])
      )
    ).toEqual(["app-a", "app-b"]);
    expect(
      instancesFromLxcListJson(
        JSON.stringify([
          { name: "app-a", status: "Running", location: "node1" },
          { name: "app-b", status: "Stopped", location: "node2" }
        ])
      )
    ).toEqual([
      { name: "app-a", status: "Running", location: "node1" },
      { name: "app-b", status: "Stopped", location: "node2" }
    ]);
    expect(
      buildWorkloadMovePlan(
        [
          { name: "app-a", status: "Running" },
          { name: "app-b", status: "Stopped" },
          { name: "app-c", status: "Running" }
        ],
        [
          { member: "node1", workloadCount: 1, plannedWorkloadCount: 1, memoryUsed: 2, memoryTotal: 8 },
          { member: "node3", workloadCount: 3, plannedWorkloadCount: 3, memoryUsed: 1, memoryTotal: 8 }
        ]
      )
    ).toEqual([
      { workload: { name: "app-a", status: "Running" }, target: "node1" },
      { workload: { name: "app-b", status: "Stopped" }, target: "node1" },
      { workload: { name: "app-c", status: "Running" }, target: "node3" }
    ]);
    expect(memoryLoadFromResourcesJson(JSON.stringify({ memory: { used: 512, total: 1024 } }))).toEqual({ used: 512, total: 1024 });
  });

  test("never plans a VM move to a container-only member or another architecture", () => {
    const workload = { name: "vm", type: "virtual-machine" as const, architecture: "x86_64" };
    const candidates = [
      { member: "container-only", workloadCount: 0, plannedWorkloadCount: 0, vmAvailable: false, architectures: ["x86_64"] },
      { member: "arm", workloadCount: 0, plannedWorkloadCount: 0, vmAvailable: true, architectures: ["aarch64"] },
      { member: "compatible", workloadCount: 5, plannedWorkloadCount: 5, vmAvailable: true, architectures: ["x86_64"] }
    ];
    expect(buildWorkloadMovePlan([workload], candidates)[0]?.target).toBe("compatible");
    expect(() => buildWorkloadMovePlan([workload], candidates.slice(0, 2))).toThrow("No eligible");
  });

  test("selects private non-LXD host addresses for cluster defaults", () => {
    const candidates = addressCandidatesFromIpJson(
      JSON.stringify([
        {
          ifname: "lxdbr0",
          addr_info: [{ family: "inet", local: "10.154.0.1", prefixlen: 24, scope: "global" }]
        },
        {
          ifname: "eth0",
          addr_info: [{ family: "inet", local: "46.0.0.5", prefixlen: 32, scope: "global" }]
        },
        {
          ifname: "ens10",
          addr_info: [{ family: "inet", local: "10.0.0.12", prefixlen: 32, scope: "global" }]
        }
      ])
    );
    const selected = selectClusterAddressCandidate(candidates);

    expect(selected?.address).toBe("10.0.0.12");
    expect(selected && bestPeerCidrForAddress(selected)).toBe("10.0.0.12/32");
  });

  test("resolves file-backed join storage from Terrarium config", () => {
    expect(
      resolveJoinStorageConfig(
        {
          terrarium_storage_mode: "file",
          terrarium_storage_size: "40G"
        },
        "terrarium"
      )
    ).toEqual({
      pool: "terrarium",
      mode: "file",
      source: "/var/lib/terrarium/storage/terrarium.img",
      size: "40G"
    });
  });

  test("resolves disk and partition join storage sources", () => {
    expect(resolveJoinStorageConfig({ terrarium_storage_mode: "disk", terrarium_storage_source: "/dev/sdb" }, "terrarium").source).toBe(
      "/dev/sdb"
    );
    expect(
      resolveJoinStorageConfig(
        {
          terrarium_storage_mode: "partition",
          terrarium_storage_source: "/dev/nvme1n1",
          terrarium_storage_partition_start: "1MiB",
          terrarium_storage_partition_end: "64GiB"
        },
        "terrarium"
      ).source
    ).toBe("/dev/nvme1n1p1");
    expect(partitionDeviceForStorageSource("/dev/sdb")).toBe("/dev/sdb1");
  });

  test("stores only global cluster networking settings in Terrarium config", () => {
    const config: Record<string, unknown> = {};

    applyClusterConfig(config, {
      network: "terrarium-ovn",
      parent: "lxdbr0",
      centralAddresses: ["10.0.0.10", "10.0.0.11", "10.0.0.12"],
      peerCidrs: ["10.0.0.0/24"]
    });

    expect(config).toEqual({
      terrarium_cluster_enabled: true,
      terrarium_lxd_network_name: "terrarium-ovn",
      terrarium_lxd_network_parent: "lxdbr0",
      terrarium_ovn_central_addresses: ["10.0.0.10", "10.0.0.11", "10.0.0.12"],
      terrarium_cluster_peer_cidrs: ["10.0.0.0/24"]
    });
  });

  test("formats TLS OVN database endpoints from central member IPs", () => {
    const addresses = parseCsv("10.0.0.10, 10.0.0.11,,10.0.0.12,2001:db8::12");

    expect(addresses).toEqual(["10.0.0.10", "10.0.0.11", "10.0.0.12", "2001:db8::12"]);
    expect(ovnDbEndpoints(addresses, "6641")).toBe(
      "ssl:10.0.0.10:6641,ssl:10.0.0.11:6641,ssl:10.0.0.12:6641,ssl:[2001:db8::12]:6641"
    );
    expect(ovnDbEndpoints(addresses, "6642")).toBe(
      "ssl:10.0.0.10:6642,ssl:10.0.0.11:6642,ssl:10.0.0.12:6642,ssl:[2001:db8::12]:6642"
    );
  });

  test("allocates and renders WireGuard mesh peers", () => {
    expect(
      nextWireGuardTunnelIp({
        terrarium_cluster_wireguard_members: [
          { name: "node1", public_key: "pub1", tunnel_ip: "10.255.54.1" },
          { name: "node2", public_key: "pub2", tunnel_ip: "10.255.54.2" }
        ]
      })
    ).toBe("10.255.54.3");

    const config = renderWireGuardConfig({
      address: "10.255.54.1",
      privateKey: "private",
      listenPort: "51820",
      peers: [
        {
          name: "node2",
          public_key: "pub2",
          tunnel_ip: "10.255.54.2",
          endpoint: "203.0.113.12:51820"
        }
      ]
    });

    expect(config).toContain("Address = 10.255.54.1/32");
    expect(config).toContain("ListenPort = 51820");
    expect(config).toContain("AllowedIPs = 10.255.54.2/32");
    expect(config).toContain("Endpoint = 203.0.113.12:51820");
    expect(config).toContain("PersistentKeepalive = 25");
  });

  test("validates WireGuard join bundle fields before writing local config", () => {
    const validBundle = {
      version: 1 as const,
      interface: "terrarium-wg0",
      cidr: "10.255.54.0/24",
      port: "51820",
      privateKey: `${"A".repeat(43)}=`,
      tunnelIp: "10.255.54.2",
      peer: {
        publicKey: `${"B".repeat(43)}=`,
        tunnelIp: "10.255.54.1",
        endpoint: "203.0.113.10:51820"
      }
    };

    expect(decodeWireGuardJoinBundle(encodeWireGuardBundle(validBundle))).toEqual(validBundle);
    expect(() => decodeWireGuardJoinBundle(encodeWireGuardBundle({ ...validBundle, interface: "../../etc/systemd/system/pwn" }))).toThrow(
      "interface is invalid"
    );
  });

  test("rejects WireGuard join bundle config-injection fields", () => {
    const validBundle = {
      version: 1 as const,
      interface: "terrarium-wg0",
      cidr: "10.255.54.0/24",
      port: "51820",
      privateKey: `${"A".repeat(43)}=`,
      tunnelIp: "10.255.54.2",
      peer: {
        publicKey: `${"B".repeat(43)}=`,
        tunnelIp: "10.255.54.1",
        endpoint: "203.0.113.10:51820"
      }
    };

    expect(() => decodeWireGuardJoinBundle(encodeWireGuardBundle({ ...validBundle, privateKey: `${"A".repeat(43)}=\nPostUp = touch /root/pwn` }))).toThrow(
      "private key is invalid"
    );
    expect(() =>
      decodeWireGuardJoinBundle(encodeWireGuardBundle({ ...validBundle, peer: { ...validBundle.peer, endpoint: "203.0.113.10\nAllowedIPs = 0.0.0.0/0" } }))
    ).toThrow("peer endpoint is invalid");
  });
});
