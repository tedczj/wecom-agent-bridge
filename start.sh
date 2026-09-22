#!/usr/bin/env bash
set -euo pipefail

bridge_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bridge_backend=''
bridge_config=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      echo "Usage: $0 [--backend codex|pi] [config.json]"
      echo 'Defaults: config.local.json; --backend pi selects config.pi.weixin.local.json.'
      echo 'Searches the repository first, then ${XDG_CONFIG_HOME:-$HOME/.config}/wecom-agent-bridge/.'
      exit 0 ;;
    --backend)
      if [[ -n "$bridge_backend" || $# -lt 2 || ( "$2" != codex && "$2" != pi ) ]]; then
        echo 'Expected one --backend codex|pi.' >&2; exit 1
      fi
      bridge_backend="$2"; shift 2 ;;
    --*) echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -n "$bridge_config" ]]; then echo 'Expected one configuration file.' >&2; exit 1; fi
      bridge_config="$1"; shift ;;
  esac
done
if [[ -z "$bridge_config" ]]; then
  bridge_config_name='config.local.json'
  if [[ "$bridge_backend" == pi ]]; then bridge_config_name='config.pi.weixin.local.json'; fi
  bridge_config="$bridge_dir/$bridge_config_name"
  if [[ ! -f "$bridge_config" ]]; then
    bridge_config="${XDG_CONFIG_HOME:-$HOME/.config}/wecom-agent-bridge/$bridge_config_name"
  fi
fi
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
node dist/scripts/restart-bridge.js "$bridge_config" "$bridge_dir/dist/src/cli.js" "$bridge_backend"
echo 'Bridge starting; Ctrl-C stops the bridge.' >&2
exec node "$bridge_dir/dist/src/cli.js" start --config "$bridge_config"
