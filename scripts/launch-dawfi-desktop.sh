#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_root="$(cd -- "${script_dir}/.." && pwd)"
dist_entry="${app_root}/dist/index.html"
state_dir="${XDG_STATE_HOME:-${HOME}/.local/state}/daw-fi"
log_file="${state_dir}/desktop.log"

mkdir -p "${state_dir}"

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
