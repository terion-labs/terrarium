# code-server Web IDE on Terrarium

Imagine having a full, powerful coding environment running in the cloud that you can access from any web browser. That's what [code-server](https://github.com/coder/code-server) offers: VS Code running on a server and served to your browser.

code-server is open source, installs as a single package with its own systemd service, and uses the Open VSX extension marketplace by default.

Running your cloud IDE in Terrarium is the ultimate developer flex:
- **Total Isolation:** Your code, extensions, and terminal commands live inside a secure container.
- **The Time Machine:** Accidentally wipe your project or install a broken package? Just rewind the container to an hour ago.
- **Access Anywhere:** Terrarium securely publishes the editor to your custom domain.

---

## 1. Create the Devbox

Let's spin up a fresh container just for coding.

**From the CLI:**
```bash
lxc launch ubuntu:24.04 devbox --profile dev
```

*(You can also use the **LXD UI** at `lxd.<your-domain>`; choose the `dev` profile.)*

The `dev` profile gives the normal `terrarium` user passwordless sudo, so the editor terminal can install packages without working directly as root.

## 2. Install code-server

Jump into your new container:
```bash
trm exec devbox
```

Run the official install script. On Ubuntu it installs the code-server `.deb` package:
```bash
sudo apt-get update
sudo apt-get install -y curl openssl
curl -fsSL https://code-server.dev/install.sh | sh
```

## 3. Configure and Start the Editor

By default, code-server only listens on `127.0.0.1`, which Terrarium's proxy cannot reach. Write its config before the first start so it listens on all interfaces and uses a strong random password.

Still inside the container, run:
```bash
mkdir -p ~/.config/code-server
cat > ~/.config/code-server/config.yaml <<EOF
bind-addr: 0.0.0.0:8080
auth: password
password: $(openssl rand -hex 32)
cert: false
EOF
chmod 600 ~/.config/code-server/config.yaml
```

`cert: false` is intentional. Terrarium's Traefik terminates TLS in front of the editor.

Now start code-server as a systemd service for the `terrarium` user, so it comes back automatically after a container reboot:
```bash
sudo systemctl enable --now code-server@terrarium
systemctl status code-server@terrarium --no-pager
exit
```

## 4. Publish the IDE

Your editor is now running privately on port `8080` inside the container. Let's publish it to the web.

On the Terrarium host, run:
```bash
lxc config set devbox user.proxy "https://code.example.com:8080@auth"
terrariumctl proxy sync
```

Terrarium will automatically grab an SSL certificate, require SSO, and route `code.example.com` to your new web IDE.

If your Terrarium install uses the local managed ZITADEL, `terrariumctl proxy sync` also updates the route-auth callback URL in ZITADEL automatically. With an external provider such as ZITADEL Cloud, add this callback URL to that provider manually:

```text
https://code.example.com/oauth2/callback
```

## 5. How to Log In

After SSO, code-server will ask for its password.

To view the password, run this command on your Terrarium host:
```bash
trm exec devbox -- grep '^password:' /home/terrarium/.config/code-server/config.yaml
```

Copy the value, paste it into the browser, and log into your new cloud development environment.

*(Tip: To change the password, edit `password:` in `~/.config/code-server/config.yaml` inside the container and run `sudo systemctl restart code-server@terrarium`.)*
