#!/bin/sh
# Entry point for the Herdr plugin actions in herdr-plugin.toml. Herdr runs it
# from the plugin checkout, without a login shell, so this calls docker and
# tailscale directly rather than mise. .env lives in the plugin config dir
# because `herdr plugin update` replaces the checkout.
set -eu

env_file="${HERDR_PLUGIN_CONFIG_DIR:?run this through a herdr plugin action}/.env"
if [ ! -f "$env_file" ]; then
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
  status)
    compose ps
    tailscale serve status
    ;;
  *)
    echo "usage: plugin.sh start|stop|status" >&2
    exit 2
    ;;
esac
