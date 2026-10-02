# Clustering

Terrarium clustering is built directly on LXD clustering. LXD owns the cluster membership, database replication, and instance placement, while Terrarium stores its own configuration inside LXD's database and ensures every node stays perfectly synced.

This gives you a single management plane across your entire network. However, note that it does not magically make every workload highly available: a container still runs on one specific server's hard drive at a time, unless you design your app around shared external storage.

## Recommended Architecture

For a truly resilient cluster, use at least three servers. LXD can form smaller clusters, but three members ensure the internal database maintains "quorum" (consensus) even if one server goes offline. 

Terrarium automatically creates a highly secure WireGuard mesh for all cluster communication. LXD traffic, OVN database traffic, and internal container networking all flow through these encrypted tunnels. This means your sensitive control-plane ports are never exposed to the public internet.

**Networking Best Practices:**
If your hosting provider offers Private Networking or VPCs, use them. It keeps your WireGuard handshakes off the public internet and usually offers lower latency. If you don't have private networking, exact public IPs are perfectly fine.

*Important:* You only need to open WireGuard's UDP port (`51820`) on your firewall between your cluster members. Do not expose LXD (`8443`), OVN (`6641`/`6642`), or Geneve (`6081`) to the internet—Terrarium handles those inside the encrypted tunnel.

## 1. Bootstrapping the First Node

Install Terrarium on your first server normally, then initialize the cluster:

```bash
terrariumctl cluster init
```

Behind the scenes, this command:
- Sets up a WireGuard mesh network (defaulting to `10.255.54.0/24`).
- Automatically selects the best IP address for the WireGuard endpoint (preferring a private VPC address if available).
- Locks down the firewall so cluster ports only accept traffic from the tunnel.
- Creates secure TLS certificates for the internal network database.

If Terrarium auto-selects the wrong IP address, you can manually specify it:

```bash
terrariumctl cluster init --wireguard-endpoint 203.0.113.11:51820
```

## 2. Inviting Additional Nodes

On your existing cluster member, generate an invite for the new server:

```bash
terrariumctl cluster invite node2
```

*(If `node2` isn't a resolvable hostname, Terrarium will ask for its IP address so it can open the firewall securely. For automation, you can pass the IP directly: `terrariumctl cluster invite node2 10.0.0.12`)*

The command will print a copy-paste join command for you:

```bash
terrariumctl cluster join --token '<token-from-existing-member>' --wireguard '<join-bundle>'
```

Log into your **new, fresh Ubuntu server**. Install Terrarium, and then paste that join command. 

The new server will automatically connect to the WireGuard mesh, download the shared configuration, and become an active cluster member.

*(Note: Joining a cluster wipes the new node's local LXD database, so make sure the new node is fresh.)*

## Traefik and Published Routes

One of the best features of Terrarium clustering is how it handles web traffic. 

Traefik runs on every single node. Thanks to the shared OVN network, every healthy node can serve your published apps. If an app is running on `node2`, but a user connects to `node1`, Traefik on `node1` will automatically route the traffic across the secure internal network to the correct container.

**Setting up DNS:**
For simple load balancing, just point your domain name to the IPs of all your servers using round-robin DNS:

```text
app.example.com.  A  203.0.113.10
app.example.com.  A  203.0.113.11
app.example.com.  A  203.0.113.12
```

If one node goes down, some clients might experience a brief connection issue until their DNS cache updates. For strict production-grade failover, you can place a dedicated Load Balancer in front of your Terrarium nodes.

## OVN Networking (Advanced)

Terrarium creates a virtual workload network called `terrarium-ovn`. Your containers attach to this network, allowing them to talk to each other across different physical servers. 

If you ever add or remove servers and need to manually refresh the internal network configuration, run:

```bash
terrariumctl cluster ovn configure
```

This ensures the cluster maintains an odd-numbered set of OVN database managers and updates the firewall rules appropriately.

## Managing Workloads

### Moving a Container
Want to shift an app to a different server?
```bash
terrariumctl cluster move app1 node2
```
*(If your app requires zero downtime, you should architect the app itself for high availability. LXD will briefly stop the container to migrate it if live migration isn't possible.)*

### Server Maintenance (Evacuation)
If you need to reboot a server, tell Terrarium to safely move all its running containers to other nodes:
```bash
terrariumctl cluster evacuate node2 --yes
```
When you're done, let the cluster know it can receive workloads again:
```bash
terrariumctl cluster restore node2 --yes
```

### Removing a Server
To permanently decommission a server:
```bash
terrariumctl cluster remove node2 --move --yes
```
This safely moves all remaining containers to healthy servers and removes the node. Terrarium will try to balance the evacuated containers across your least-busy servers.

If a server completely dies and cannot be recovered, you can force-remove it from the database:
```bash
terrariumctl cluster remove node2 --force
```

## Useful Commands Cheat Sheet

```bash
terrariumctl cluster status
terrariumctl cluster invite node3
terrariumctl cluster move app1 node2
terrariumctl cluster evacuate node2 --yes
terrariumctl cluster restore node2 --yes
terrariumctl cluster remove node2
terrariumctl reconfigure
```

## Virtual machines and ingress helpers

`trm launch IMAGE NAME --vm --target MEMBER` selects a VM-capable member explicitly. Without a target, Terrarium chooses an online member that advertises VM support for the image's architecture. Container-only and VM-capable members can coexist.

`trm cluster move INSTANCE MEMBER` performs a cold move. It checks the destination and host-bound devices before shutting down, preserves stopped instances as stopped, and restarts previously running instances after a successful move. A failed graceful stop aborts; Terrarium does not force power off. Member removal validates every planned destination before moving the first workload.

Internal `terrarium-ingress-*` containers belong to individual members. They are excluded from workload counts and automatic movement, and are removed with their member. Each remaining ingress host reconciles its own loopback devices after a workload moves. Host directory disks must be detached before movement and attached on the destination afterward.
