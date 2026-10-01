#!/usr/bin/env bash
# Creates Vista's integration user, its "Vista Integration" permission set (generated from what Vista reads and
# writes, against this org's fields) and its licenses. Without --go it changes nothing: it prints the plan and
# validates the permission set. Safe to re-run; finished steps are skipped.
#   bash salesforce/integration-user.sh                 # DevSandi, dry run
#   bash salesforce/integration-user.sh --go            # DevSandi, for real
#   bash salesforce/integration-user.sh --prod          # production (myorg), dry run
#   bash salesforce/integration-user.sh --prod --go     # asks you to type the alias first
set -euo pipefail
cd "$(dirname "$0")"
source ./_guard.sh "$@"
if $GO; then node ../scripts/sf-integration-user.mjs --org "$ORG" --go; else node ../scripts/sf-integration-user.mjs --org "$ORG"; fi
