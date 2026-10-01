#!/usr/bin/env bash
# Deploys the Vista flow (as Draft) and list views to the DevSandi sandbox.
#   bash salesforce/deploy.sh          # validate only (dry run)
#   bash salesforce/deploy.sh --go     # deploy
#   bash salesforce/deploy.sh --prod   # production (myorg), validate only
#   bash salesforce/deploy.sh --prod --go
# DevSandi by default; production only with --prod (asks you to type the alias before a real deploy). Activate the flow in Setup after reviewing AUTOMATION.md.
set -euo pipefail
cd "$(dirname "$0")"
source ./_guard.sh "$@"
if $GO; then
  sf project deploy start -o "$ORG" -d force-app
  echo "Deployed to $ORG. Both Vista flows are Draft: activate them in Setup > Flows when ready. They only act on Type = Vista records."
else
  sf project deploy start -o "$ORG" -d force-app --dry-run
  echo "Validation passed against $ORG. Re-run with --go to deploy."
fi
