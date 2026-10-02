# Terrarium on Hetzner Cloud

Hetzner Cloud is a fantastic choice for Terrarium. Their servers are extremely powerful and affordable, and attaching dedicated NVMe Volumes for your ZFS time machine is seamless.

## Recommended Setup

To give your containers and time machine the best performance:
- **Image:** Ubuntu 24.04
- **Boot Disk:** Keep the default server disk for the OS.
- **Data Disk:** Add a separate **Volume** for Terrarium to use.
- **Terrarium Mode:** `--storage-mode disk`

## Creating the Server (Web Console)

1. Add your SSH key to the Hetzner Cloud project.
2. Create a new Ubuntu 24.04 server and select that SSH key.
3. Create a Volume in the same location as the server.
4. Attach the Volume to the server.
5. SSH into the server and install Terrarium.

Example install:

```bash
curl -fsSL https://github.com/terion-labs/terrarium/releases/latest/download/install.sh | bash
```

## Creating the Server (CLI / hcloud)

If you prefer the terminal, you can spin up the perfect Terrarium server using the official `hcloud` CLI.

Create the SSH key:
```bash
hcloud ssh-key create --name terrarium --public-key-from-file ~/.ssh/id_ed25519.pub
```

Create the Volume:
```bash
hcloud volume create \
  --name terrarium-data \
  --size 200 \
  --location nbg1
```

Create the server:
```bash
hcloud server create \
  --name terrarium-1 \
  --type cpx31 \
  --image ubuntu-24.04 \
  --location nbg1 \
  --ssh-key terrarium
```

Attach the Volume:
```bash
hcloud volume attach --server terrarium-1 terrarium-data
```

Finally, SSH into your new server and run the automated installer.

## Private Network for Clustering

For clustered Terrarium, create a Hetzner Cloud Network first and attach every Terrarium node to it. Hetzner Networks give servers private IP addresses that are not on the public internet, which is the best endpoint for Terrarium's WireGuard cluster mesh.

Example private network:

```bash
hcloud network create \
  --name terrarium-cluster \
  --ip-range 10.42.0.0/16

hcloud network add-subnet terrarium-cluster \
  --type server \
  --network-zone eu-central \
  --ip-range 10.42.0.0/24
```

Create each node in the same location and attach it to the network:

```bash
hcloud server create \
  --name terrarium-1 \
  --type cpx31 \
  --image ubuntu-24.04 \
  --location nbg1 \
  --ssh-key terrarium \
  --network terrarium-cluster
```

If you already created the server, attach it afterward:

```bash
hcloud server attach-to-network terrarium-1 --network terrarium-cluster
```

After installing Terrarium on each node, run the normal cluster flow:

```bash
terrariumctl cluster init
terrariumctl cluster invite node2
```

Then run the printed `terrariumctl cluster join --token ... --wireguard ...` command on the new node. Terrarium should auto-select the Hetzner private address as the WireGuard endpoint. If it does not, pass the private endpoint explicitly and invite peers by their private address:

```bash
terrariumctl cluster init --wireguard-endpoint 10.42.0.11:51820
terrariumctl cluster invite node2 10.42.0.12
```

Provider firewalls only need WireGuard `51820/udp` between exact Hetzner Network member addresses. Do not expose LXD `8443/tcp`, OVN `6641/tcp`, OVN `6642/tcp`, or Geneve `6081/udp`; Terrarium carries those inside WireGuard.

## Notes

- Hetzner’s current CLI uses `--location`; `--datacenter` is deprecated in the current `hcloud server create` manual.
- `hcloud server create` can also pre-attach a volume with `--volume`, but keeping the steps separate is easier to reason about when you want Terrarium to claim exactly one dedicated data disk.
