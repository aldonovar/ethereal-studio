#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_root="$(cd -- "${script_dir}/.." && pwd)"
dist_entry="${app_root}/dist/index.html"
state_dir="${XDG_STATE_HOME:-${HOME}/.local/state}/daw-fi"
log_file="${state_dir}/desktop.log"
env_file="${app_root}/.env.local"

mkdir -p "${state_dir}"

# Electron's main process does not read Vite env files. Import only the public,
# explicitly allowlisted Desktop OAuth settings; never source arbitrary shell
# content or load the browser publishable key into the privileged process.
read_public_env_value() {
  local key="$1"
  local line
  local value

  [[ -f "${env_file}" ]] || return 1
  line="$(grep -m1 -E "^${key}=" "${env_file}" || true)"
  [[ -n "${line}" ]] || return 1
  value="${line#*=}"
  value="${value%$'\r'}"

  if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi

  printf '%s' "${value}"
}

if [[ -z "${DAWFI_SUPABASE_URL:-}" ]]; then
  DAWFI_SUPABASE_URL="$(read_public_env_value 'DAWFI_SUPABASE_URL' || true)"
  if [[ -z "${DAWFI_SUPABASE_URL}" ]]; then
    DAWFI_SUPABASE_URL="$(read_public_env_value 'VITE_SUPABASE_URL' || true)"
  fi
  [[ -z "${DAWFI_SUPABASE_URL}" ]] || export DAWFI_SUPABASE_URL
fi

if [[ -z "${DAWFI_DESKTOP_OAUTH_CLIENT_ID:-}" ]]; then
  DAWFI_DESKTOP_OAUTH_CLIENT_ID="$(read_public_env_value 'DAWFI_DESKTOP_OAUTH_CLIENT_ID' || true)"
  [[ -z "${DAWFI_DESKTOP_OAUTH_CLIENT_ID}" ]] || export DAWFI_DESKTOP_OAUTH_CLIENT_ID
fi

if [[ ! -f "${dist_entry}" ]]; then
  printf 'DAW-fi: falta el build %s. Ejecuta npm run build.\n' "${dist_entry}" >>"${log_file}"
  command -v notify-send >/dev/null 2>&1 \
    && notify-send 'DAW-fi' 'Falta el build local. Ejecuta npm run build.'
  exit 1
fi

if [[ -x "${app_root}/node_modules/electron/dist/electron" ]]; then
  electron_bin="${app_root}/node_modules/electron/dist/electron"
elif [[ -x /usr/bin/electron42 ]]; then
  electron_bin=/usr/bin/electron42
else
  printf 'DAW-fi: no se encontro un runtime Electron compatible.\n' >>"${log_file}"
  command -v notify-send >/dev/null 2>&1 \
    && notify-send 'DAW-fi' 'No se encontró un runtime Electron compatible.'
  exit 1
fi

cd "${app_root}"
exec "${electron_bin}" "${app_root}/electron/main.cjs" >>"${log_file}" 2>&1
