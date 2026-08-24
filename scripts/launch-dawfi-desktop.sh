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
# explicitly allowlisted Supabase URL and publishable/anon key; never source
# arbitrary shell content or any service-role credential.
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

if [[ -z "${DAWFI_SUPABASE_PUBLISHABLE_KEY:-}" ]]; then
  DAWFI_SUPABASE_PUBLISHABLE_KEY="$(read_public_env_value 'DAWFI_SUPABASE_PUBLISHABLE_KEY' || true)"
  if [[ -z "${DAWFI_SUPABASE_PUBLISHABLE_KEY}" ]]; then
    DAWFI_SUPABASE_PUBLISHABLE_KEY="$(read_public_env_value 'VITE_SUPABASE_ANON_KEY' || true)"
  fi
  [[ -z "${DAWFI_SUPABASE_PUBLISHABLE_KEY}" ]] || export DAWFI_SUPABASE_PUBLISHABLE_KEY
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

electron_args=()
if [[ "$(uname -s)" == "Linux" ]] \
  && [[ "${XDG_SESSION_TYPE:-}" == "wayland" || -n "${WAYLAND_DISPLAY:-}" ]]; then
  # Electron/Chromium can still probe Vulkan on native Wayland even when the
  # compositor cannot provide a compatible surface. Keep accelerated raster
  # rendering, but disable only Vulkan so a failed probe cannot leave a black
  # DAW window on Hyprland.
  electron_args+=(--disable-features=Vulkan)
fi

if [[ "$(uname -s)" == "Linux" ]] \
  && command -v busctl >/dev/null 2>&1 \
  && busctl --user status org.freedesktop.secrets >/dev/null 2>&1; then
  # Chromium cannot infer a secure password store from every Wayland compositor
  # (notably Hyprland). Select the active Secret Service explicitly so Electron
  # safeStorage persists OAuth sessions instead of falling back to basic_text.
  electron_args+=(--password-store=gnome-libsecret)
fi

cd "${app_root}"
exec "${electron_bin}" "${electron_args[@]}" "${app_root}/electron/main.cjs" "$@" >>"${log_file}" 2>&1
