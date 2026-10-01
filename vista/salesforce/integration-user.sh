#!/usr/bin/env bash
# Creates Vista's integration user, its "Vista Integration" permission set (generated from what Vista reads and
# writes, against this org's fields) and its licenses. Without --go it changes nothing: it prints the plan and
# validates the permission set. Safe to re-run; finished steps are skipped.
#   bash salesforce/integration-user.sh                 # DevSandi, dry run
#   bash salesforce/integration-user.sh --go            # DevSandi, for real
#   bash salesforce/integration-user.sh --prod          # production (myorg), dry run
#   bash salesforce/integration-user.sh --prod --go     # asks you to type the alias first
#   Add --license=salesforce to use a full Salesforce license + "Field Service Standard" (orgs without the
#   "Field Service Integration" license; an existing Vista user on another license is renamed, deactivated and replaced).
set -euo pipefail
cd "$(dirname "$0")"
source ./_guard.sh "$@"
LICENSE=""; for a in "$@"; do case "$a" in --license=*) LICENSE="--license ${a#--license=}" ;; esac; done
if $GO; then node ../scripts/sf-integration-user.mjs --org "$ORG" $LICENSE --go; else node ../scripts/sf-integration-user.mjs --org "$ORG" $LICENSE; fi
