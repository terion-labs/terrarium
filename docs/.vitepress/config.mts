import { defineConfig } from "vitepress";

function resolveBase(): string {
  const raw = (process.env.TERRARIUM_DOCS_BASE ?? "/terrarium/").trim();
  if (!raw || raw === "/") {
    return "/";
  }
  if (raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new Error("TERRARIUM_DOCS_BASE must be a root-relative path");
  }
  const withLeadingSlash = raw.startsWith("/") ? `/${raw.replace(/^\/+/, "")}` : `/${raw}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

function resolveGoogleAnalyticsHead() {
  const googleAnalyticsId = process.env.TERRARIUM_DOCS_GA_ID?.trim();
  if (!googleAnalyticsId) {
    return [];
  }

  return [
    [
      "script",
      {
        async: "",
        src: `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(googleAnalyticsId)}`
      }
    ],
    [
      "script",
      {},
      `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag("js", new Date());
gtag("config", ${JSON.stringify(googleAnalyticsId)});`
    ]
  ];
}

const base = resolveBase();

export default defineConfig({
  title: "Terrarium",
  description: "Secure, rewindable VPS environments for agents, dev tools, and isolated apps.",
  base,
  head: [
    [
      "link",
      {
        rel: "alternate",
        type: "text/markdown",
        href: `${base}agents.md`,
        title: "Terrarium guide for AI agents"
      }
    ],
    ...resolveGoogleAnalyticsHead()
  ],
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: "About", link: "/about/" },
      { text: "Getting Started", link: "/getting-started/" },
      { text: "Guides", link: "/guides/" },
      { text: "Operations", link: "/operations/" },
      { text: "Reference", link: "/reference/" },
      { text: "For AI Agents", link: "/agents" },
      { text: "GitHub", link: "https://github.com/terion-labs/terrarium" }
    ],
    sidebar: [
      {
        text: "Overview",
        items: [
          { text: "About", link: "/about" },
          { text: "Security Model", link: "/security" },
          { text: "Architecture", link: "/architecture" },
          { text: "For AI Agents", link: "/agents" }
        ]
      },
      {
        text: "Getting Started",
        items: [
          { text: "Overview", link: "/getting-started/" },
          { text: "Installation", link: "/getting-started/installation" },
          { text: "Creating Your First Instance", link: "/getting-started/creating-first-instance" },
          { text: "Linux Virtual Machines", link: "/getting-started/virtual-machines" },
          { text: "Templating Containers with trm launch", link: "/getting-started/templating" },
          { text: "Storage and Sizing", link: "/getting-started/storage" },
          { text: "Domains and Authentication", link: "/getting-started/domains-and-auth" },
          { text: "Management GUIs", link: "/getting-started/management-guis" },
          { text: "Shared Data Between Containers", link: "/getting-started/shared-data-between-containers" },
          { text: "External Shared Storage", link: "/getting-started/external-shared-storage" }
        ]
      },
      {
        text: "Operations",
        items: [
          { text: "Overview", link: "/operations/" },
          { text: "Reconfiguration", link: "/operations/reconfiguration" },
          { text: "Clustering", link: "/operations/clustering" },
          { text: "Backups and Restore", link: "/operations/backups-and-restore" },
          { text: "Golden Images", link: "/operations/golden-images" }
        ]
      },
      {
        text: "Reference",
        items: [
          { text: "Overview", link: "/reference/" },
          { text: "Services and Endpoints", link: "/reference/services-and-endpoints" },
          { text: "terrariumctl", link: "/reference/terrariumctl" }
        ]
      },
      {
        text: "Guides",
        items: [
          { text: "Overview", link: "/guides/" },
          { text: "OpenClaw", link: "/guides/openclaw" },
          { text: "Hermes", link: "/guides/hermes" },
          { text: "code-server Web IDE", link: "/guides/vscode" },
          { text: "Isolated Docker Compose deployments", link: "/guides/compose" },
          { text: "Dokploy", link: "/guides/dokploy" },
          { text: "Coolify", link: "/guides/coolify" },
          { text: "Protecting published services with OIDC", link: "/guides/auth-protection" }
        ]
      },
      {
        text: "Providers",
        items: [
          { text: "Overview", link: "/providers/" },
          { text: "DigitalOcean", link: "/providers/digitalocean" },
          { text: "Vultr", link: "/providers/vultr" },
          { text: "Hetzner Cloud", link: "/providers/hetzner" },
          { text: "Hostinger", link: "/providers/hostinger" }
        ]
      }
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/terion-labs/terrarium" }
    ],
    search: {
      provider: "local"
    },
    footer: {
      message: "Built with VitePress",
      copyright: "Terrarium"
    }
  }
});
