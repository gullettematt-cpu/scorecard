#!/usr/bin/env bash
# Assemble dist/ for the CDN: web/ at the root, i18n/ alongside.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
cp -R web/. dist/
cp -R i18n dist/i18n
echo "dist/ ready ($(du -sh dist | cut -f1))"
