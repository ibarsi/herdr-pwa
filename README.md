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

   That pulls the released image, starts compose (`127.0.0.1:8787`), and runs
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

## Releases

Versions are `0.x` and come from [conventional commits](https://www.conventionalcommits.org).
`fix:` is a patch, `feat:` is a minor, and while we are pre-1.0 a breaking
change (`feat!:` or a `BREAKING CHANGE:` footer) is also only a minor —
reaching `1.0.0` will be a deliberate decision.

PRs are squash-merged, so **the PR title becomes the commit message** and has
to be a conventional commit. CI rejects titles that are not.

### Running a release (teammates)

`mise up` pulls the newest release. To pin or roll back, set the version in
`.env` and run it again:

    HERDR_PWA_VERSION=0.1.0

Images are at `ghcr.io/ibarsi/herdr-pwa`. A release is not usable until that
package page lists the tag — the git tag is created first, and the image
build can still fail after it.

### Cutting a release

Merging to `main` cuts the release when the new commits include a `feat`, a
`fix`, or a breaking change. The workflow writes `CHANGELOG.md` from those
commits, tags, and pushes with the release deploy key. That tag push builds
the image and opens the GitHub Release. A `docs` or `chore` merge publishes
nothing. Follow the build with `gh run watch`.

`mise release:preview` prints what the next merge would cut.

Commits the parser rejects are listed in a warning and **do not** appear in
the changelog.

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
