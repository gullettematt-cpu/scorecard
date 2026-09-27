# Sourced by the scripts below. Refuses anything but a sandbox.
ORG="${ORG:-DevSandi}"
command -v sf >/dev/null || { echo "sf CLI not found"; exit 1; }
IS_SANDBOX=$(sf data query -o "$ORG" -q "SELECT IsSandbox FROM Organization" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).result.records[0].IsSandbox)}catch{console.log('unknown')}})")
if [ "$IS_SANDBOX" != "true" ]; then
  echo "Refusing: org '$ORG' is not a sandbox (IsSandbox=$IS_SANDBOX). Vista automation goes to DevSandi first."
  exit 1
fi
