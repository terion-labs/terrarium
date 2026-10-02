# Terrarium on Vultr

Vultr is an excellent provider for Terrarium. Their Cloud Compute instances are highly capable, and attaching secondary Block Storage for your ZFS time machine is fast and intuitive.

## Recommended Setup

To give your containers and time machine the best performance:
- **Image:** Ubuntu 24.04 LTS x64
- **Boot Disk:** Keep the default instance disk for the OS.
- **Data Disk:** Add separate **Block Storage** in the same region.
- **Terrarium Mode:** `--storage-mode disk`

## Creating the Server (Web Console)

1. Add your SSH key to Vultr.
2. Create a new Cloud Compute instance with Ubuntu 24.04 and that SSH key.
3. Create a Block Storage volume in the same region.
4. Attach the Block Storage volume to the instance.
5. SSH into the server and install Terrarium.

Example install:

```bash
curl -fsSL https://github.com/terion-labs/terrarium/releases/latest/download/install.sh | bash
```

## Creating the Server (CLI / vultr-cli)

If you prefer the terminal, you can easily deploy your Terrarium server using `vultr-cli`.

Create the SSH key:
```bash
vultr-cli ssh-key create --name terrarium --key "$(cat ~/.ssh/id_ed25519.pub)"
```

Create the Instance:
```bash
vultr-cli instance create \
  --region=fra \
  --plan=vc2-4c-8gb \
  --os=2284 \
  --label=terrarium-1 \
  --host=terrarium-1 \
  --ssh-keys="<ssh-key-id>"
```

Create the Block Storage Volume:
```bash
vultr-cli block-storage create \
  --region=fra \
  --size=200 \
  --label=terrarium-data
```

Attach the Volume:
```bash
vultr-cli block-storage attach <block-storage-id> --instance=<instance-id>
```

Finally, SSH into your new server and run the automated installer.

## Private Network for Clustering

For clustered Terrarium, create one Vultr VPC 2.0 network and attach every Terrarium instance to it. Use the VPC 2.0 subnet as the endpoint for Terrarium's WireGuard cluster mesh.

Create a VPC 2.0 network:

```bash
vultr-cli vpc2 create \
  --region=fra \
  --description=terrarium-cluster \
  --ip-type=v4 \
  --ip-block=10.42.0.0 \
  --prefix-length=24
```

Create each instance in that VPC:

```bash
vultr-cli instance create \
  --region=fra \
  --plan=vc2-4c-8gb \
  --os=2284 \
  --label=terrarium-1 \
  --host=terrarium-1 \
  --ssh-keys="<ssh-key-id>" \
  --vpc-ids="<vpc2-id>"
```

If you already created the instance, attach it afterward:

```bash
vultr-cli instance vpc2 attach <instance-id> --vpc-id="<vpc2-id>"
```

After installing Terrarium on each node, run:

```bash
terrariumctl cluster init
terrariumctl cluster invite node2
```

Then run the printed `terrariumctl cluster join --token ... --wireguard ...` command on the new node. Terrarium should auto-select the VPC private address as the WireGuard endpoint. If it does not, pass the private endpoint explicitly and invite peers by their private address:

```bash
terrariumctl cluster init --wireguard-endpoint 10.42.0.11:51820
terrariumctl cluster invite node2 10.42.0.12
```

Provider firewalls only need WireGuard `51820/udp` between exact VPC 2.0 member addresses. Do not expose LXD `8443/tcp`, OVN `6641/tcp`, OVN `6642/tcp`, or Geneve `6081/udp`; Terrarium carries those inside WireGuard.

## Notes

- Vultr documents that Block Storage and the instance must be in the same region.
- Vultr’s Linux mount guide is useful if you want to inspect the device before handing it to Terrarium, but Terrarium will wipe the selected data disk for ZFS.
