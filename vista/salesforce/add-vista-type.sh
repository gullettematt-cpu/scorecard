#!/usr/bin/env bash
# Adds the picklist value "Vista" to SA_Expense__c.Type__c without touching anything else on the field:
# retrieves the field as it is in the target org, appends the value, deploys it back.
#   bash salesforce/add-vista-type.sh            # DevSandi, dry run
#   bash salesforce/add-vista-type.sh --go       # DevSandi, for real
set -euo pipefail
cd "$(dirname "$0")"
source ./_guard.sh
GO="${1:-}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp sfdx-project.json "$TMP/"; mkdir -p "$TMP/force-app"
( cd "$TMP" && sf project retrieve start -o "$ORG" -m "CustomField:SA_Expense__c.Type__c" >/dev/null )
F="$TMP/force-app/main/default/objects/SA_Expense__c/fields/Type__c.field-meta.xml"
[ -f "$F" ] || { echo "Could not retrieve Type__c"; exit 1; }
rc=0
node - "$F" <<'NODE' || rc=$?
const fs = require('fs'); const f = process.argv[2]; let x = fs.readFileSync(f, 'utf8');
if (/<valueSetName>/.test(x)) { console.error('Type__c uses a global value set; add "Vista" to that set in Setup instead.'); process.exit(2); }
if (/<fullName>Vista<\/fullName>/.test(x)) { console.log('Vista already present. Nothing to do.'); process.exit(3); }
const i = x.lastIndexOf('</value>');
if (i < 0) { console.error('No picklist values found in Type__c.'); process.exit(2); }
const add = '\n            <value>\n                <fullName>Vista</fullName>\n                <default>false</default>\n                <label>Vista</label>\n            </value>';
x = x.slice(0, i + 8) + add + x.slice(i + 8);
fs.writeFileSync(f, x); console.log('Appended "Vista" to Type__c.');
NODE
[ $rc -eq 3 ] && exit 0
[ $rc -ne 0 ] && exit $rc
if [ "$GO" = "--go" ]; then
  ( cd "$TMP" && sf project deploy start -o "$ORG" -d force-app )
else
  ( cd "$TMP" && sf project deploy start -o "$ORG" -d force-app --dry-run ) && echo "Dry run OK. Re-run with --go to add it."
fi
