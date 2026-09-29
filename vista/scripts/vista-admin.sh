#!/usr/bin/env bash
# Admin tasks against the live Vista API. Reads the admin token from SSM, so it never needs to be copied around.
#   bash scripts/vista-admin.sh people                                   # list enrolled people
#   bash scripts/vista-admin.sh add '+17065550112' 'Dwayne Tucker' installer [en|es|bi] [ServiceResourceId]
#   bash scripts/vista-admin.sh add '+17065550100' 'Mike Duncan' pm en [UserId]
#   bash scripts/vista-admin.sh add '+17065550150' 'Lisa Lastname' admin en    # payroll/program admin: gets the admin screens
#   (Most people need no enrolling: Vista finds them in Salesforce by the mobile number on their User or ServiceResource.)
#   bash scripts/vista-admin.sh rollout                                  # show the live rollout switch
#   bash scripts/vista-admin.sh set-location Augusta off|pilot|on        # flip a location
#   bash scripts/vista-admin.sh opt-out Augusta 'Tucker Installs LLC'    # keep one account on the old process
#   bash scripts/vista-admin.sh pilot Augusta 'Hernández Siding'         # add an account to a pilot
#   bash scripts/vista-admin.sh language-requests
#   bash scripts/vista-admin.sh run heartbeat|morning|pmDigest|cutoff|dispatchPoll
# Env: STACK (default vista), SECRETS_PATH (default /vista/prod), AWS_REGION.
set -euo pipefail
STACK="${STACK:-vista}"; P="${SECRETS_PATH:-/vista/prod}"
API=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
TOKEN=$(aws ssm get-parameter --name "$P/ADMIN_TOKEN" --with-decryption --query Parameter.Value --output text)
call() { curl -fsS -X "$1" "$API$2" -H "x-admin-token: $TOKEN" -H 'content-type: application/json' ${3:+--data "$3"}; echo; }
json() { node -e 'console.log(JSON.stringify(JSON.parse(process.argv[1])))' "$1"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  people) call GET /admin/people ;;
  add)
    [ $# -ge 3 ] || { echo "usage: add PHONE 'NAME' installer|measure|pm|admin [lang] [ServiceResourceId, or UserId for a pm]"; exit 1; }
    body=$(node -e 'const [phone,name,role,lang,sfid]=process.argv.slice(1);
      const link = !sfid ? {} : role === "pm" ? { userId: sfid, id: "user:" + sfid } : { serviceResourceIds: [sfid], id: "res:" + sfid };
      console.log(JSON.stringify({ phone, name, role, lang: lang || "en", ...link }))' "$@")
    call POST /admin/people "$body" ;;
  rollout) call GET /admin/rollout ;;
  set-location|opt-out|pilot)
    [ $# -ge 2 ] || { echo "usage: $cmd LOCATION VALUE"; exit 1; }
    current=$(call GET /admin/rollout)
    body=$(node -e '
      const [cmd, loc, val, cur] = process.argv.slice(1); const r = JSON.parse(cur).rollout;
      r.locations ||= {}; const l = r.locations[loc] ||= { mode: "off", pilotAccounts: [], optOutAccounts: [] };
      if (cmd === "set-location") l.mode = val;
      if (cmd === "opt-out") (l.optOutAccounts ||= []).includes(val) || l.optOutAccounts.push(val);
      if (cmd === "pilot") (l.pilotAccounts ||= []).includes(val) || l.pilotAccounts.push(val);
      console.log(JSON.stringify(r));' "$cmd" "$1" "$2" "$current")
    call PUT /admin/rollout "$body" ;;
  language-requests) call GET /admin/language-requests ;;
  run) call POST /admin/run "$(json "{\"job\":\"${1:?job}\"}")" ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
