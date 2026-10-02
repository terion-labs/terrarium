# Terrarium on DigitalOcean

DigitalOcean is one of the best places to run Terrarium. Droplets are fast, and attaching a secondary Block Storage Volume for your containers takes only a few clicks.

## Recommended Setup

To give your containers and time machine the best performance:
- **Image:** Ubuntu 24.04 (LTS) x64
- **Boot Disk:** Keep the default Droplet disk for the OS.
- **Data Disk:** Add a separate **Volume** for Terrarium to use.
- **Terrarium Mode:** `--storage-mode disk`

## Creating the Server (Web Console)

1. Create or upload your SSH key in DigitalOcean.
2. Create a new Droplet with Ubuntu 24.04 and select that SSH key.
3. Create a separate Volume in the same region as the Droplet.
4. Attach the volume to the Droplet.
5. Make sure the volume is not left auto-formatted and auto-mounted for normal filesystem use before handing it to Terrarium.
6. SSH into the Droplet as `root`.

Once your Droplet is online, run the installer:

```bash
curl -fsSL https://github.com/terion-labs/terrarium/releases/latest/download/install.sh | bash
```

## Creating the Server (CLI / doctl)

If you prefer the terminal, you can spin up the perfect Terrarium Droplet using `doctl`.

Create or import the SSH key:
```bash
doctl compute ssh-key import terrarium --public-key-file ~/.ssh/id_ed25519.pub
```

Create the Volume:
```bash
doctl compute volume create terrarium-data \
  --region fra1 \
  --size 200
```

Create the Droplet with Ubuntu 24.04:
```bash
doctl compute droplet create terrarium-1 \
  --region fra1 \
  --size s-4vcpu-8gb \
  --image ubuntu-24-04-x64 \
  --ssh-keys <ssh-key-id-or-fingerprint>
```

Attach the Volume:
```bash
doctl compute volume-action attach <volume-id> <droplet-id> --wait
```

Finally, SSH into your new Droplet and run the automated installer.

## Private Network for Clustering

For clustered Terrarium, put every Droplet in the same DigitalOcean VPC in the same region. DigitalOcean VPC networks are private to your account and are not reachable from the public internet.

Create a VPC:

```bash
doctl vpcs create \
  --name terrarium-cluster \
  --region fra1 \
  --ip-range 10.42.0.0/24
```

Capture the VPC UUID:

```bash
doctl vpcs list
```

Create each Terrarium Droplet in that VPC:

```bash
doctl compute droplet create terrarium-1 \
  --region fra1 \
  --size s-4vcpu-8gb \
  --image ubuntu-24-04-x64 \
  --ssh-keys <ssh-key-id-or-fingerprint> \
  --vpc-uuid <vpc-uuid>
```

After installing Terrarium on each node, run:

```bash
terrariumctl cluster init
terrariumctl cluster invite node2
```

Then run the printed `terrariumctl cluster join --token ... --wireguard ...` command on the new node. Terrarium should auto-select the VPC address as the WireGuard endpoint. If it does not, pass the private endpoint explicitly and invite peers by their private address:

```bash
terrariumctl cluster init --wireguard-endpoint 10.42.0.11:51820
terrariumctl cluster invite node2 10.42.0.12
```

Provider firewalls only need WireGuard `51820/udp` between exact VPC member addresses. Do not expose LXD `8443/tcp`, OVN `6641/tcp`, OVN `6642/tcp`, or Geneve `6081/udp`; Terrarium carries those inside WireGuard. 

## Notes

- DigitalOcean volumes must live in the same region as the Droplet.
- DigitalOcean documents that control-panel-created volumes can auto-format and auto-mount on newer Ubuntu Droplets. Terrarium will wipe the selected data disk for ZFS anyway, so treat the attached volume as dedicated Terrarium storage and remove any normal filesystem mount config before handing it to Terrarium.
