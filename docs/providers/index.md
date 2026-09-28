# Provider Guides

Terrarium works beautifully across many cloud providers, but the absolute best experience comes from following one simple pattern:

1. Create a fresh **Ubuntu 24.04 or 26.04 VPS**.
2. Add your **SSH key** during creation (so you don't need a password).
3. Attach a **separate block storage volume** (if your provider offers it).
4. Run the Terrarium installer in **`disk`** mode.

By putting your containers on their own dedicated volume, you keep your system clean and give your ZFS time machine plenty of room to operate.

## Recommended Cloud Providers

Here are step-by-step guides for creating the perfect VPS on popular cloud platforms:

| Provider | Supports Extra Storage? | Clustering Network? | Best Terrarium Mode | Setup Guide |
| --- | --- | --- | --- | --- |
| **DigitalOcean** | Yes | Yes (VPC) | `disk` | [Read Guide](./digitalocean) |
| **Hetzner Cloud** | Yes | Yes (Networks) | `disk` | [Read Guide](./hetzner) |
| **Vultr** | Yes | Yes (VPC 2.0) | `disk` | [Read Guide](./vultr) |
| **Hostinger** | No | No | `file` | [Read Guide](./hostinger) |

*Note: Hostinger is included because it's popular for low-cost setups. However, because it lacks attachable block storage, we highly recommend DigitalOcean, Hetzner, or Vultr for the best Terrarium experience.*

## A Note on Clustering (Advanced)

If you plan to link multiple Terrarium servers together into a cluster:
- **Use Private Networks:** Always put your servers in the same provider-level VPC or Private Network. 
- **Stay Regional:** Keep your servers in the same physical region to ensure low latency and compatibility.
- **Let Terrarium Handle the Mesh:** Terrarium uses WireGuard to securely connect your servers. You only need to allow WireGuard traffic (`51820/udp`) through your provider's firewall between the specific IP addresses of your servers. Terrarium handles all the complex container networking inside that secure tunnel.

*Ready to cluster? Check out the [Clustering Guide](../operations/clustering) once your servers are up.*
