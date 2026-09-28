#!/usr/bin/env bash
# Assemble dist/ for the CDN: web/ at the root, i18n/ alongside.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
cp -R web/. dist/
cp -R i18n dist/i18n
rm -rf dist/dev   # the text simulator is local-only
echo "dist/ ready ($(du -sh dist | cut -f1))"
# Live mode: point the app at the API (set by the deploy workflow). Unset = demo mode on fixtures.
if [ -n "${VISTA_API_URL:-}" ]; then
  printf 'window.VISTA_CONFIG = { apiUrl: %s };\n' "\"${VISTA_API_URL%/}\"" > dist/config.js
  echo "dist/config.js -> ${VISTA_API_URL%/}"
fi
