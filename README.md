# herdr-pwa

Phone companion for [Herdr](https://github.com/herdrdev/herdr). Lists running
agents, shows what each one is displaying, and replies to them — including the
approval prompts that block an agent mid-run.

Runs on the machine that hosts Herdr, reachable from a phone over Tailscale.

## Prerequisites

- Herdr running on this machine (socket at `~/.config/herdr/herdr.sock`)
- [mise](https://mise.jdx.dev) (`mise install` once in this directory for Node 26)
- Docker, for the production-shaped run
- Tailscale, logged in as the same identity you put in `ALLOWED_LOGIN`

## Configure

    cp .env.example .env

Set `ALLOWED_LOGIN` to your Tailscale login (the value Serve puts in
`Tailscale-User-Login`). `HERDR_UID` / `HERDR_GID` default to 1000; set them
to `id -u` / `id -g` if your user is not uid 1000 — the container must match
the owner of Herdr's 0600 socket.

`.env` is gitignored. Do not commit it.

## Develop

    mise test          # node --test
    mise dev           # 127.0.0.1:8787 with DEV_BYPASS_AUTH=1
    mise smoke         # GET /api/agents (pass DEV_BYPASS_AUTH=1 if using mise dev)

`mise dev` skips the Tailscale identity check so you can hit the adapter from
the host. That flag is never set in `compose.yaml`.

Open `http://127.0.0.1:8787/` in a desktop browser. Do not run `mise dev` and
`mise up` at the same time — they both bind 8787.

## Run on the phone

The phone talks to Tailscale Serve, which proxies to the compose service on
loopback. Auth is the `Tailscale-User-Login` header Serve injects; tagged
devices on the tailnet do not get that header and are refused.

1. Confirm Herdr is up (`ls -l ~/.config/herdr/herdr.sock`).
2. From this repo:

       mise phone

   That builds and starts compose (`127.0.0.1:8787`) and runs
   `tailscale serve --bg 8787`. It prints this node's MagicDNS URL.
3. On the **iPhone**, connect Tailscale.
4. Open **Safari** (Add to Home Screen does not exist in Chrome or Firefox on
   iOS) at the URL `mise phone` printed (`https://<machine>.<tailnet>.ts.net`).
5. Confirm the agent list loads and the colours match Herdr's theme.
6. Share → Add to Home Screen, then launch from the icon. It should open
   without Safari chrome.
7. Open a feed, send a reply, and confirm it lands in Herdr on the host.
8. Get an agent to an approval prompt and answer it from the phone — that is
   the case this exists for.
9. Turn Tailscale off and relaunch: the app shell should open with an error,
   not a Safari DNS page.

HTTPS comes from Tailscale's MagicDNS cert. If Safari warns about the
certificate, enable HTTPS certificates for the tailnet and retry.

Stop when you are done:

    mise down
    mise serve:off

Useful extras: `mise logs`, `mise status`.

`mise smoke` against compose needs no `DEV_BYPASS_AUTH` — it sends
`Tailscale-User-Login` from `ALLOWED_LOGIN` in `.env`.

## Security

- Auth is the `Tailscale-User-Login` header, which Tailscale does not populate
  for tagged devices. A shared tailnet is not a trusted perimeter; only the
  configured login is accepted.
- The adapter emits exactly five Herdr methods and nothing else. It is an
  allowlist, not a proxy: `pane.split`, `layout.apply`, and
  `plugin.action.invoke` all take argv and would make this an RCE endpoint.
- Host publish is loopback (`127.0.0.1:8787`); inside the container
  `BIND_HOST=0.0.0.0` so docker-proxy can reach it. If Herdr is restarted, the
  directory mount should pick up the new socket; `docker compose restart` if
  503s persist.

## Updating themes

Themes are extracted from Herdr's source. After a Herdr upgrade:

    node tools/extract-themes.js /path/to/herdr-checkout > themes.json
