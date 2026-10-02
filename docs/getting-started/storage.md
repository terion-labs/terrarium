# Storage and Sizing

Choosing the right hardware and storage setup is the most important decision you'll make before installing Terrarium. 

Because Terrarium relies heavily on ZFS to power its "time machine" snapshots, it treats storage a bit differently than a standard server setup.

## The Golden Rule: Two Disks Are Better Than One

For the best performance and safety, you should create a VPS with **two separate drives**:
1. **A small boot disk:** Just for the Ubuntu operating system and Terrarium's core control plane.
2. **A larger attached volume:** Dedicated entirely to your LXD containers, VM disks and their snapshots.

If you have two disks, you will choose **`--storage-mode disk`** during installation. Terrarium will automatically format the second drive and use it exclusively for your isolated environments.

### What if I only have one disk?
No problem. If your hosting provider doesn't support attachable volumes, you can use **`--storage-mode file`**. Terrarium will carve out space on your main drive. You'll just want to make sure you purchase a server with a much larger primary disk to hold both the OS and your containers.

## How the Time Machine Uses Space

Terrarium keeps a running history of your environments. If you break something, you can instantly rewind to a working state. 

By default, Terrarium keeps:
- The last 4 snapshots taken every 15 minutes.
- The last 24 hourly snapshots.
- The last 14 daily snapshots.
- The last 3 monthly snapshots.

These snapshots are incredibly efficient. They don't make full copies of your data; they only save the blocks of data that have *changed*. 

However, if your applications are constantly writing and deleting massive files, or you frequently rebuild large databases, those changed blocks will add up. 

## Sizing Recommendations

Here is a good starting point based on how you plan to use Terrarium:

### 1. The Tinkerer (Minimum Practical Host)
Great for personal use, a few web apps, or light AI agent testing.
- **CPU / RAM:** `2 vCPU` / `4 GB RAM`
- **Boot Disk:** `30 - 40 GB`
- **ZFS Container Disk:** `80 - 120 GB`

### 2. The Builder (Recommended General Purpose)
Great for hosting a self-hosted browser IDE, a complex Compose stack, and a few active AI agents.
- **CPU / RAM:** `4 vCPU` / `8 - 16 GB RAM`
- **Boot Disk:** `40 - 60 GB`
- **ZFS Container Disk:** `150 - 300 GB`

### 3. The Power User (Heavy Workloads)
Great for data-heavy apps, active databases, and running many environments at once.
- **CPU / RAM:** `8+ vCPU` / `16+ GB RAM`
- **Boot Disk:** `50 - 80 GB`
- **ZFS Container Disk:** `300+ GB`

### A Rule of Thumb for ZFS
Estimate how much space the actual data inside your containers will use, and then **multiply that by 2x or 3x** to account for the snapshot history. 

For example, if you think your apps will use 50 GB of data, attach a 150 GB volume for your ZFS disk to ensure your time machine always has plenty of room to breathe.

---
*Ready to launch your server? Check our [Provider Guides](../providers/README.md) to see exactly how to attach these storage volumes on providers like DigitalOcean and Hetzner.*

## VM disk space

The VM profiles allocate a 20 GiB root disk and 2 GiB of memory by default. The guest OS, Docker images and application data all use that disk. ZFS snapshot retention needs additional host capacity as blocks change. The companion metadata filesystem and root block volume must be backed up together. Attached host directories and CIFS shares are separate storage and are not included in the instance root backup.
