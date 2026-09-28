#!/usr/bin/env bash
# Put Vista's secrets into AWS SSM Parameter Store (SecureString). Run by whoever holds the values (Donald).
# Values are typed at a hidden prompt or read from a file: never on the command line, never in shell history,
# never in the repo. Re-run any time to rotate one value (press Enter to keep the current one).
#   bash scripts/aws-secrets.sh [/vista/prod]
set -euo pipefail
P="${1:-/vista/prod}"
REGION="${AWS_REGION:-$(aws configure get region)}"
echo "Writing SecureStrings under $P in $REGION (account $(aws sts get-caller-identity --query Account --output text))"

put() { aws ssm put-parameter --region "$REGION" --name "$P/$1" --type SecureString --overwrite --value "$2" >/dev/null && echo "  saved $P/$1"; }
exists() { aws ssm get-parameter --region "$REGION" --name "$P/$1" --query Parameter.Name --output text >/dev/null 2>&1; }
ask() { local v; read -rsp "  $1 ($2; Enter keeps current): " v; echo; [ -n "$v" ] && put "$1" "$v" || echo "  kept $1"; }

# Salesforce: the private key that matches the certificate on the Vista connected app.
read -rp "  Path to the Salesforce private key file (e.g. vista-sf.key; Enter keeps current): " KEY
if [ -n "$KEY" ]; then put SF_PRIVATE_KEY "$(cat "$KEY")"; else echo "  kept SF_PRIVATE_KEY"; fi

ask TWILIO_AUTH_TOKEN "Twilio console > Account > API keys & tokens"
ask ANTHROPIC_API_KEY "console.anthropic.com > API keys"

# Generated here, never typed: the app sign-in token key and the admin token.
for k in APP_JWT_SECRET ADMIN_TOKEN; do
  if exists "$k"; then echo "  kept $k (delete the parameter and re-run to rotate)"; else put "$k" "$(openssl rand -hex 32)"; fi
done
echo "Done. Deploy (or redeploy) so the functions pick up changes; warm functions cache secrets until they recycle."
