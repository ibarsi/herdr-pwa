#!/bin/sh
# Entry point for the Herdr plugin actions in herdr-plugin.toml. Herdr runs it
# from the plugin checkout, without a login shell, so this calls docker and
# tailscale directly rather than mise. .env lives in the plugin config dir
# because `herdr plugin update` replaces the checkout.
set -eu

# [[build]] runs with HERDR_PLUGIN_* scrubbed. config-dir is a path lookup and
# needs no running server.
config_dir="${HERDR_PLUGIN_CONFIG_DIR:-$(herdr plugin config-dir ibarsi.herdr-pwa 2>/dev/null || true)}"
env_file="$config_dir/.env"
if [ ! -f "$env_file" ]; then
  # A fresh install has no .env yet, and a failed build aborts the install.
  [ "${1:-}" = refresh ] && exit 0
  echo "Copy .env.example to $env_file and set ALLOWED_LOGIN" >&2
  exit 1
fi
set -a
. "$env_file"
set +a
export HERDR_UID="${HERDR_UID:-$(id -u)}"
export HERDR_GID="${HERDR_GID:-$(id -g)}"
port="${PORT:-8787}"

# Same project name as a clone run with `mise up`, so the two drive one container.
compose() { docker compose -p herdr-pwa -f compose.yaml "$@"; }

case "${1:-}" in
  start)
    compose pull
    compose up -d
    tailscale serve --bg "$port"
    ;;
  stop)
    compose down
    # Only the handler `start` added. `mise serve:off` resets everything.
    tailscale serve --https=443 off
    ;;
  refresh)
    # [[build]]: Herdr runs it on install and on each `herdr plugin update`
    # that moves the commit. Only a running adapter is recreated, so a stopped
    # one stays stopped. A failure warns instead of aborting the update.
    if [ -n "$(compose ps -q --status running)" ]; then
      { compose pull && compose up -d; } || echo "warning: image refresh failed. Run the start action." >&2
    fi
    ;;
  status)
    compose ps
    tailscale serve status
    ;;
  *)
    echo "usage: plugin.sh start|stop|status|refresh" >&2
    exit 2
    ;;
esac
