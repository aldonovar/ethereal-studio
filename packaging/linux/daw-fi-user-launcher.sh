#!/usr/bin/env bash

set -euo pipefail

readonly candidates=(
  "/home/aldonovar/Proyectos/hollow-bpm/dawfi-relaunch"
  "/home/aldonovar/Proyectos/hollow-bpm/hollow-bits"
)

for app_root in "${candidates[@]}"; do
  launcher="${app_root}/scripts/launch-dawfi-desktop.sh"
  if [[ -x "${launcher}" && -f "${app_root}/dist/index.html" ]]; then
    exec "${launcher}" "$@"
  fi
done

command -v notify-send >/dev/null 2>&1 \
  && notify-send 'DAW-fi' 'No se encontró una instalación construida de DAW-fi.'
printf 'DAW-fi: no se encontro una instalacion construida.\n' >&2
exit 1
