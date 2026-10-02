# Templating Containers with `trm launch`

`trm launch` is the fastest way to turn a fresh LXD instance into a real application environment.

It wraps `lxc launch`, so simple instances still feel familiar. When you add provisioning flags, Terrarium generates a small cloud-init template for the container, embeds or fetches the files you asked for, and runs the setup inside the new instance.

Use it when you want a container to come up already shaped like an app server, agent sandbox, Docker Compose stack, or Ansible-managed machine.

For Linux VMs, add `--vm`; the default profile becomes `vm`. Use `--profile vm-dev` for passwordless sudo. All playbook, role, Compose, variable, cloud-init and proxy options below also apply to VMs. Add `--wait --timeout 600` to wait for the agent and successful provisioning. See [virtual machines](./virtual-machines.md).

## 1. Start with a Normal Container

The simplest form launches an Ubuntu container with Terrarium's default profile:

```bash
trm launch ubuntu:24.04 web-01
```

You can still pass normal LXD sizing options:

```bash
trm launch ubuntu:24.04 web-01 --disk 40G --memory 4G --cpu 2
```

For development containers, use the `dev` profile. It includes Terrarium's Docker-friendly defaults and passwordless sudo for the normal `terrarium` user:

```bash
trm launch ubuntu:24.04 devbox --profile dev
```

## 2. Run an Ansible Playbook

If you already have an Ansible playbook, pass it directly:

```bash
trm launch ubuntu:24.04 web-01 --playbook ./site.yml
```

Terrarium embeds the local playbook into generated cloud-init, installs Ansible inside the container, and runs:

```bash
ansible-playbook -i localhost, -c local site.yml
```

A small real-world playbook might install Nginx and publish a static page:

```yaml
---
- hosts: localhost
  connection: local
  become: true
  tasks:
    - name: Install Nginx
      ansible.builtin.apt:
        name: nginx
        state: present
        update_cache: true

    - name: Write landing page
      ansible.builtin.copy:
        dest: /var/www/html/index.html
        content: "{{ app_name }} is live\n"
```

Launch it with a variable and a public route:

```bash
trm launch ubuntu:24.04 landing-01 \
  --playbook ./site.yml \
  --var app_name=Landing \
  --proxy https://landing.example.com:80
```

## 3. Add Galaxy Requirements

If your playbook depends on Galaxy roles or collections, pass the requirements file too:

```bash
trm launch ubuntu:24.04 app-01 \
  --requirements ./requirements.yml \
  --playbook ./site.yml
```

Requirements can contain `roles:`, `collections:`, or both. Terrarium installs them before running the playbook.

For a quick role-only container, use `--role`:

```bash
trm launch ubuntu:24.04 docker-01 --role geerlingguy.docker
```

You can repeat `--role` when you want several roles:

```bash
trm launch ubuntu:24.04 ops-01 \
  --role geerlingguy.security \
  --role geerlingguy.nginx
```

## 4. Run Docker Compose

For Compose apps, pass one or more Compose files:

```bash
trm launch ubuntu:24.04 my-stack \
  --profile dev \
  --docker-compose ./docker-compose.yml
```

Terrarium installs Docker inside the container, starts the Docker service, and runs:

```bash
docker compose -f docker-compose.yml up -d
```

Here is a simple app stack:

```yaml
services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
```

Publish it during launch:

```bash
trm launch ubuntu:24.04 nginx-stack \
  --profile dev \
  --docker-compose ./docker-compose.yml \
  --proxy https://nginx.example.com:8080
```

Remember that Compose ports are still inside the LXD container. Terrarium routes public traffic to the container port you put in the `--proxy` route.

## 5. Use Variables

Variables keep the same template reusable across staging, production, and one-off test containers.

Pass variables inline:

```bash
trm launch ubuntu:24.04 app-01 \
  --playbook ./site.yml \
  --var APP_NAME=hello \
  --var APP_PORT=8080
```

Or keep them in a dotenv file:

```dotenv
APP_NAME=hello
APP_PORT=8080
POSTGRES_DB=app
```

Then launch with:

```bash
trm launch ubuntu:24.04 app-01 \
  --vars ./app.env \
  --playbook ./site.yml \
  --docker-compose ./docker-compose.yml
```

Variables are made available in three places:

- As shell environment variables for generated provisioning commands.
- As Ansible extra vars through `--extra-vars`.
- As Docker Compose variables through `--env-file`.

Inline values override dotenv files:

```bash
trm launch ubuntu:24.04 app-staging \
  --vars ./app.env \
  --var APP_NAME=staging \
  --docker-compose ./docker-compose.yml
```

The dotenv parser supports normal `KEY=value` lines, quoted values, `export KEY=value`, blank lines, and comments. Variable names must use shell-safe names such as `APP_NAME`, `POSTGRES_DB`, or `PORT_8080`.

## 6. Fetch Templates from Git

Local files are embedded into cloud-init. Git assets are cloned by the new container during first boot.

Use this format:

```text
git+https://github.com/org/repo.git//path/inside/repo.yml?ref=v1.0.0
```

For example:

```bash
trm launch ubuntu:24.04 app-01 \
  --requirements git+https://github.com/example/infra.git//ansible/requirements.yml?ref=v1.2.0 \
  --playbook git+https://github.com/example/infra.git//ansible/site.yml?ref=v1.2.0
```

Compose files work the same way:

```bash
trm launch ubuntu:24.04 plausible \
  --profile dev \
  --vars ./plausible.env \
  --docker-compose git+https://github.com/example/stacks.git//plausible/docker-compose.yml?ref=main \
  --proxy https://analytics.example.com:8000@auth:admins
```

Pin `ref` to a tag or commit when you want repeatable launches.

## 7. Combine Multiple Templates

You can combine the provisioning shortcuts. Terrarium runs them in this order:

1. Install packages needed for provisioning.
2. Clone Git assets.
3. Install Galaxy requirements.
4. Install and run Galaxy roles.
5. Run Ansible playbooks.
6. Start Docker and run Compose stacks.

A practical full launch might look like this:

```bash
trm launch ubuntu:24.04 customer-portal \
  --profile dev \
  --disk 80G \
  --memory 6G \
  --cpu 4 \
  --vars ./portal.env \
  --var APP_ENV=production \
  --requirements ./ansible/requirements.yml \
  --playbook ./ansible/base.yml \
  --playbook ./ansible/hardening.yml \
  --docker-compose ./compose/portal.yml \
  --docker-compose ./compose/worker.yml \
  --proxy https://portal.example.com:8080@auth:admins \
  --proxy https://api.example.com:8081@auth:admins
```

This creates one isolated container, prepares it with Ansible, starts two Compose stacks, and publishes two authenticated HTTPS routes.

## 8. Save a Reusable Golden Image

When a templated launch produces a container you want to reuse, turn it into a
golden image:

```bash
trm image create customer-portal golden-customer-portal
```

Then launch more containers from that prepared state:

```bash
trm image launch golden-customer-portal customer-portal-02 --profile dev
```

Golden images are useful when provisioning is expensive or when you want a
known-good starting point before a risky experiment. Terrarium strips published
route config from the image source, so new containers do not accidentally
inherit the old container's public hostname. See [Golden Images](../operations/golden-images.md)
for the full workflow.

## 9. Use Raw Cloud-Init When You Need Full Control

If you already have a complete cloud-init file, pass it directly:

```bash
trm launch ubuntu:24.04 raw-01 --cloud-init ./user-data.yml
```

Raw cloud-init replaces Terrarium's generated template. Because of that, it cannot be combined with `--requirements`, `--playbook`, `--role`, `--docker-compose`, `--var`, or `--vars`.

You can still combine it with normal launch options and proxy labels:

```bash
trm launch ubuntu:24.04 raw-01 \
  --cloud-init ./user-data.yml \
  --disk 40G \
  --proxy https://raw.example.com:8080
```

## 10. Debugging a Launch

Cloud-init runs after LXD reports that the container was created. If the instance exists but your app is not ready yet, open a shell:

```bash
trm exec app-01
```

Useful logs inside the container:

```bash
sudo cloud-init status --long
sudo tail -n 200 /var/log/cloud-init-output.log
sudo journalctl -u docker --no-pager -n 100
```

For Compose apps:

```bash
sudo docker compose ps
sudo docker compose logs --tail=100
```

If the app is running but the public route does not respond, check that the service listens on `0.0.0.0` inside the container and then sync the proxy from the host:

```bash
terrariumctl proxy sync
```

For the full route label grammar, including authenticated routes and wildcard domains, see [Domains and Authentication](domains-and-auth.md#published-app-route-labels).
