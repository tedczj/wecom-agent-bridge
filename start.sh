#!/usr/bin/env bash
set -euo pipefail

bridge_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -gt 1 || ${1:-} == --help || ${1:-} == -h ]]; then
  echo "Usage: $0 [config.json]"
  echo 'Starts the configured Weixin or local transport; defaults to config.local.json.'
  exit 0
fi
bridge_config="${1:-$bridge_dir/config.local.json}"
[[ "$bridge_config" == /* ]] || bridge_config="$PWD/$bridge_config"
if [[ ! -f "$bridge_config" ]]; then
  echo "Config not found: $bridge_config (see config.example.json)" >&2
  exit 1
fi

cd -- "$bridge_dir"
if [[ ! -d node_modules ]] || ! npm ls --depth=0 --silent >/dev/null 2>&1; then
  npm ci --no-audit --no-fund >&2
fi
npm run build --silent >&2
node dist/scripts/restart-bridge.js "$bridge_config" "$bridge_dir/dist/src/cli.js"
echo 'Bridge starting; Ctrl-C stops the bridge.' >&2
exec node "$bridge_dir/dist/src/cli.js" start --config "$bridge_config"
