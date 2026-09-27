#!/usr/bin/env bash
# Deploys the Vista flow (as Draft) and list views to the DevSandi sandbox.
#   bash salesforce/deploy.sh          # validate only (dry run)
#   bash salesforce/deploy.sh --go     # deploy
# Refuses any org that isn't a sandbox. Activate the flow in Setup after reviewing AUTOMATION.md.
set -euo pipefail
cd "$(dirname "$0")"
source ./_guard.sh
if [ "${1:-}" = "--go" ]; then
  sf project deploy start -o "$ORG" -d force-app
  echo "Deployed. The flow 'Vista - Pay Request Submitted' is Draft: activate it in Setup > Flows when ready."
else
  sf project deploy start -o "$ORG" -d force-app --dry-run
  echo "Validation passed. Re-run with --go to deploy."
fi
