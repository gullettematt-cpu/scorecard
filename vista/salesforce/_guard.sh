# Sourced by add-vista-type.sh and deploy.sh.
# Default: the DevSandi sandbox. Production only with --prod, and only after typing the org alias back.
command -v sf >/dev/null || { echo "sf CLI not found"; exit 1; }
PROD=false; GO=false
for a in "$@"; do case "$a" in --prod) PROD=true ;; --go) GO=true ;; esac; done
if $PROD; then ORG="${ORG:-myorg}"; else ORG="${ORG:-DevSandi}"; fi
IS_SANDBOX=$(sf data query -o "$ORG" -q "SELECT IsSandbox FROM Organization" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).result.records[0].IsSandbox)}catch{console.log('unknown')}})")
if [ "$IS_SANDBOX" = "unknown" ]; then echo "Could not reach org '$ORG'."; exit 1; fi
if [ "$IS_SANDBOX" != "true" ]; then
  $PROD || { echo "Refusing: '$ORG' is PRODUCTION. Re-run with --prod if that's intended."; exit 1; }
  if $GO; then
    read -r -p "Deploying to PRODUCTION org '$ORG'. Type the alias to continue: " CONFIRM
    [ "$CONFIRM" = "$ORG" ] || { echo "Cancelled."; exit 1; }
  fi
fi
