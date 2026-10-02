# Terrarium on Hostinger

> [!WARNING]
> We **do not** recommend Hostinger as your primary provider for Terrarium.
>
> Terrarium works best when you can attach a separate block volume for your containers and the ZFS "time machine". Hostinger's VPS plans do not document support for independently attachable block volumes. You are usually forced into installing Terrarium onto your main root disk (`--storage-mode file`), which works, but is not the safest or fastest way to run Terrarium.

If you are using Hostinger because it's popular or affordable, you can still install Terrarium. You just need to follow a slightly different path.

## Recommended Setup

Because you cannot attach a secondary disk:
- **Plan:** Choose a larger VPS plan up front (since the OS, containers, and snapshots must all fit on one drive).
- **Image:** Plain Ubuntu 24.04
- **Boot Disk:** Only use one.
- **Data Disk:** None.
- **Terrarium Mode:** `--storage-mode file`

## Creating the Server (Web Console)

1. Create a VPS in hPanel. (We recommend at least a plan with **150GB+** of storage, as ZFS snapshots will eat into your root disk).
2. Choose a plain Ubuntu 24.04 template.
3. Add your SSH key during onboarding, or later in `VPS -> Manage -> Settings -> SSH keys`.
4. SSH into the VPS as `root`.

## The Install

Because you only have one disk, you **must** select `file` mode during the installer.

```bash
curl -fsSL https://github.com/terion-labs/terrarium/releases/latest/download/install.sh | bash
```

During the interactive prompts, when asked for your storage strategy, choose **`file`**. Terrarium will ask how much of your root disk to carve out for your containers. 

*(If you need more space later, Hostinger documents expanding the existing partition after a plan upgrade.)*

## CLI Note

Hostinger does publish an official CLI, `hapi`, and an official API. Their current support docs cover:

- installing the CLI
- authenticating with an API token
- common VM operations such as `list`, `get`, `start`, and `stop`

Documented commands:

```bash
hapi --help
hapi vps vm list
hapi vps vm get <vm_id>
hapi vps vm start <vm_id>
hapi vps vm stop <vm_id>
```

The current official support article does not document end-to-end VPS creation through `hapi`, so for Terrarium provisioning the most reliable documented path is still hPanel plus SSH.

## Private Network for Clustering

Hostinger's current public VPS docs do not document a VPC/private-network feature for connecting multiple VPS instances on a non-public subnet. That makes Hostinger a poor fit for Terrarium clustering.

You can form a Terrarium cluster over public IP addresses because cluster traffic uses WireGuard, but this is still not the recommended Hostinger path. If you do it anyway:

- pass exact public member IPs to `cluster invite`
- allow WireGuard `51820/udp` only between the cluster member public IPs
- keep LXD `8443/tcp`, OVN `6641/tcp`, OVN `6642/tcp`, and Geneve `6081/udp` closed on public/provider firewalls
- expect less isolation than providers with a real private VPC/network

Example public-only shape:

```bash
terrariumctl cluster init --wireguard-endpoint 203.0.113.11:51820
terrariumctl cluster invite node2 203.0.113.12
```

Then run the printed `terrariumctl cluster join --token ... --wireguard ...` command on `node2`.

For production clustering, prefer a provider that documents private networking, such as Hetzner Cloud Networks, DigitalOcean VPC, or Vultr VPC 2.0.
