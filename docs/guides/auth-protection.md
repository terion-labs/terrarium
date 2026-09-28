# Protecting Published Services with SSO

One of Terrarium's most powerful features is the ability to easily lock your web apps behind a Single Sign-On (SSO) gate. 

You don't need to write custom authentication code, deploy a separate identity proxy, or mess with Nginx configs. You just add a tiny label to your container, and Terrarium handles the rest.

This is perfect for:
- Self-hosted admin dashboards (like Pi-hole or Grafana).
- Internal company tools that shouldn't be public.
- Web IDEs (like code-server) where you want an extra layer of security.
- AI Agent web interfaces (like OpenClaw or Hermes).

---

## How It Works: The Magic `@auth` Tag

To expose an app to the public internet, you normally add a `user.proxy` label like this:
```bash
lxc config set my-app user.proxy "https://app.example.com:3000"
```

**To lock that app behind SSO, just append `@auth` to the end of the URL.**

```bash
lxc config set my-app user.proxy "https://app.example.com:3000@auth"
terrariumctl proxy sync
```

That's literally it. Now, whenever someone visits `app.example.com`, they will be redirected to your Terrarium login page (either ZITADEL or your external provider like Google). Only authenticated users will be allowed through to see the app.

For the full `user.proxy` label grammar, including multiple routes and raw TCP/UDP routes, see [Domains and Authentication](../getting-started/domains-and-auth.md#published-app-route-labels).

---

## Restricting Access to Specific Groups

What if you have a team of people, but you only want your developers to access a specific app?

You can restrict access to specific groups by appending `:groupname` to the auth tag.

```bash
lxc config set admin-tool user.proxy "https://admin.example.com:8080@auth:admins,devops"
terrariumctl proxy sync
```
In this example, a user must successfully log in **AND** belong to either the `admins` or `devops` group to gain access. 

With Terrarium's built-in ZITADEL, these are project roles that Terrarium emits as the OIDC `groups` claim. With local or external Logto, Terrarium defaults route auth to the OIDC `roles` claim and the `openid profile email roles` scopes. With a generic external provider, make sure the provider emits the configured claim (by default, a flat `groups` claim) containing the same names.

---

## Important Rules for External OIDC

If you installed Terrarium using `--idp local`, everything above works with the local provider wiring. Terrarium manages the local OIDC clients for ZITADEL or Logto, including published-route callback URLs in the local ZITADEL app when you run `terrariumctl proxy sync`.

However, if you configured Terrarium to use an **External Identity Provider** (like ZITADEL Cloud, Logto Cloud, Auth0, Google, or GitHub), there is one extra step you must do manually.

When Terrarium creates a protected route, your identity provider must allow that route's callback URL.

For a root route:
```bash
lxc config set my-app user.proxy "https://app.example.com:3000@auth"
```

Add this callback to the external provider:
```text
https://app.example.com/oauth2/callback
```

For a path route:
```bash
lxc config set my-app user.proxy "https://app.example.com:3000/admin@auth:admins"
```

Add this callback to the external provider:
```text
https://app.example.com/oauth2/admin/callback
```

If you are using the `@auth:groupname` feature, you must also ensure your external provider is configured to send the claim Terrarium reads. Generic OIDC and ZITADEL default to `groups`; Logto defaults to `roles`. Without that claim in the token or userinfo response, Terrarium won't know which groups or roles the user belongs to.

---

## Troubleshooting

If you add an `@auth` tag and the site stops loading, check these common culprits:
1. **Did you run the sync command?** Always run `terrariumctl proxy sync` after changing a proxy label.
2. **Is your app listening on `0.0.0.0`?** The app inside your container must listen on all interfaces, not just `127.0.0.1`, so Terrarium's proxy can reach it.
3. **Are you using a custom domain?** Route protection currently only works for URLs that match your Terrarium root domain (e.g., if your server is `example.com`, you can protect `app.example.com`, but not `totally-different-domain.com`).
