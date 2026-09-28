# Guides

Welcome to the runbooks. These guides are meant to be concrete, step-by-step instructions—not just high-level ideas.

Each guide explains exactly how to run a specific app or AI agent inside Terrarium. You'll learn:
- **What to install:** The exact commands to run inside your LXC container.
- **How to create the container:** Step-by-step using either the sleek LXD web UI or the terminal.
- **How to configure it:** A humane, interactive path for setting up the software.
- **How to publish it:** Whether the app should stay completely private, or be exposed to the internet using Terrarium's `user.proxy` labels.
- **How to secure it:** The best way to handle authentication (like locking a web app behind Single Sign-On).

### The Golden Rule
Remember: **Everything inside a Terrarium container is completely private by default.** 

You can run databases, internal APIs, and experimental AI agents without worrying about accidentally exposing them to the public internet. Only the routes you explicitly tag with a `user.proxy` label will become internet-facing.

### Choose Your Guide:

- **[code-server Web IDE](vscode.md):** The absolute best way to code in the cloud. Spin up a browser-based editor that is completely isolated and secured by SSO.
- **[OpenClaw](openclaw.md):** Give the powerful autonomous AI agent a safe, disposable sandbox to execute code in.
- **[Hermes](hermes.md):** Run agent-driven background services and expose only the user interface to the web.
- **[Docker Compose Stacks](compose.md):** The cleanest way to run multi-container apps (like a web server + Postgres + Redis) without making a mess of your host machine.
- **[Dokploy](dokploy.md):** Turn your Terrarium containers into an automated, UI-driven deployment platform (like Heroku or Vercel).
- **[Coolify](coolify.md):** Another excellent, self-hosted Heroku alternative that runs perfectly inside a single Terrarium LXC.
- **[Protecting Services with OIDC](auth-protection.md):** The magic label that forces users to log in before they can see your published web apps.
