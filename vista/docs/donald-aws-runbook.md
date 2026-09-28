# Vista on AWS: Donald's runbook

Donald, this is everything on the AWS side, in order, with the commands to paste. Matt handles all of Salesforce.
Plan on about an hour of hands-on time, split across two sittings: part 1 before the first deploy and part 3 after
it. Part 2 is on Matt, in between.

The full reference guide is `vista/docs/deploy-aws.md`, if you want the background on anything below.

**Deploying on its own changes nothing for crews.** Every location starts switched off, and Matt turns Augusta on
later. The one thing that starts right away is a health check every 2 hours:
- it logs in to Salesforce and reads a job;
- it writes a test SA Expense (`TEST_SA__c = true`, removed on the next run);
- it stores a test photo.

If any step fails, Matt and Mike get a text.

## What you need before you start

- **Admin access to the AWS account** Vista will live in. Tell Matt which account, and which region
  (`us-east-1` unless you prefer another).
- **The AWS CLI v2, logged in to that account.** `aws sts get-caller-identity` should show the right account
  number.
- **git, Node.js 22 and `openssl`** on your computer.
- **Collaborator access to https://github.com/gullettematt-cpu/scorecard.** Accept Matt's invite.
- **From Matt, in person or through the password manager (never email or chat):** the Salesforce private key file
  `vista-sf.key`, and the Anthropic API key. Matt can create the Anthropic key, or you can create one in the
  Claude Console under a workspace named "Vista".
- **From Twilio** (you manage our account): the **Auth Token**. You'll type it into a hidden prompt; nobody else
  needs to see it.

Get the code:

```bash
git clone https://github.com/gullettematt-cpu/scorecard.git
cd scorecard/vista
```

---

## Part 1: before the first deploy (you, ~25 minutes)

### 1a. Let GitHub deploy without storing AWS keys

GitHub Actions signs in to AWS with a short-lived token (OIDC), so there are no access keys to leak or rotate.

**Add GitHub as an identity provider.** You only do this once per AWS account; skip it if it's already there.
1. In the AWS console, go to **IAM**, then **Identity providers**, and click **Add provider**.
2. Choose **OpenID Connect**.
3. Enter these two values, then click **Add provider**:
   - Provider URL: `https://token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`

**Create the deploy role** (from `scorecard/vista`):

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" deploy/github-oidc-trust.json  > /tmp/vista-trust.json
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" deploy/github-deploy-policy.json > /tmp/vista-policy.json

aws iam create-role --role-name vista-github-deploy \
  --assume-role-policy-document file:///tmp/vista-trust.json \
  --description "GitHub Actions deploys the Vista stack"
aws iam put-role-policy --role-name vista-github-deploy \
  --policy-name vista-deploy --policy-document file:///tmp/vista-policy.json

aws iam get-role --role-name vista-github-deploy --query Role.Arn --output text   # send this ARN to Matt
```

**What that role can and can't do:**
- **Who can use it:** only the `vista-prod` deploy environment of `gullettematt-cpu/scorecard`. If the repo ever
  moves to a GitHub organization, update the `sub` line in the trust policy.
- **What it can manage:** the services the stack uses (CloudFormation, Lambda, API Gateway, DynamoDB, S3,
  CloudFront, EventBridge Scheduler, CloudWatch and X-Ray).
- **IAM:** it can only create IAM roles named `vista-*`.

Review `/tmp/vista-policy.json` before you apply it, and tighten it if you like.

### 1b. Load the secrets into Parameter Store

```bash
export AWS_REGION=us-east-1          # the region you picked
bash scripts/aws-secrets.sh /vista/prod
```

**What the script asks for:**
- the path to `vista-sf.key`;
- the Twilio Auth Token and the Anthropic key, typed at a hidden prompt, so they never appear on screen or in
  shell history.

It also generates two secrets itself: `APP_JWT_SECRET` (app sign-in) and `ADMIN_TOKEN` (the admin commands).
Everything is stored as SecureString under `/vista/prod`.

Check that all five are there:

```bash
aws ssm get-parameters-by-path --path /vista/prod --query "Parameters[].Name" --output text
# /vista/prod/ADMIN_TOKEN  /vista/prod/ANTHROPIC_API_KEY  /vista/prod/APP_JWT_SECRET  /vista/prod/SF_PRIVATE_KEY  /vista/prod/TWILIO_AUTH_TOKEN
```

All five must be in place before the first deploy, or its health check fails. Then delete your copy of
`vista-sf.key`.

### 1c. Send Matt these values

None of them are secret.

| What | Where to find it |
|---|---|
| AWS region | the one you used above |
| Deploy role ARN | the last command in 1a |
| Twilio Account SID (`AC…`) | Twilio console home page |
| *Vista* Messaging Service SID (`MG…`) | Twilio → Messaging → Services |
| The Vista phone number | Twilio → Phone Numbers |

---

## Part 2: Matt's turn (no action for you)

Matt will:
1. merge pull request #1 into `main` (deploys run from `main`);
2. create the `vista-prod` environment in GitHub with you as the required approver;
3. fill in its settings with your values and his Salesforce ones.

He'll tell you when it's ready.

---

## Part 3: first deploy and checks (you, ~30 minutes)

### 3a. Deploy

1. In GitHub, open **Actions**, then **Vista**, and click **Run workflow**.
2. Set **Use workflow from** to `main` and the environment to `vista-prod`, then click **Run workflow**.
3. When the run pauses on **Review deployments**, approve it.

The tests run first, and the deploy only starts if they pass. It takes about 10 minutes the first time, mostly
while CloudFront sets up.

When it finishes, the run summary lists:
- the **App URL** (where crews will open Vista);
- the **API URL**;
- the **Twilio webhook**.

The last step of the workflow checks the API's health, which proves all five secrets load.

You can also see everything the stack created:

```bash
aws cloudformation describe-stacks --stack-name vista --query "Stacks[0].Outputs" --output table
```

### 3b. Connect Twilio to Vista

Paste the webhook address into Twilio:
1. Go to **Messaging**, then **Services**, then *Vista*, then **Integration**, and choose **Send a webhook**.
2. Paste the address into **Request URL** and set the method to **HTTP POST**.

To test it, text `today` to the Vista number from a phone that isn't in Salesforce. You should get a bilingual
reply asking you to have your PM add you. Twilio answers HELP and STOP itself, so don't test with those.

### 3c. Run the health check now

The health check runs every 2 hours on its own, but you don't have to wait:

```bash
bash scripts/vista-admin.sh run heartbeat     # expect {"ok":true,...}
bash scripts/vista-admin.sh rollout           # expect Augusta "off" (nobody sees Vista yet)
```

If the heartbeat isn't `ok`, the reply names the step that failed. Salesforce login problems are Matt's (the
connected app or integration user); anything else, see Troubleshooting below.

### 3d. Set a cost alarm (recommended)

1. In the AWS console, go to **Billing and Cost Management**, then **Budgets**, and click **Create budget**.
2. Choose a **Monthly cost budget**, with an amount of about $25 and your email for alerts.

Expected spend at Augusta's volume is a few dollars a month.

Tell Matt when 3a–3c are done. He and Mike will pick the pilot crews and switch Augusta to `pilot`.

---

## What's in the stack

One CloudFormation stack named `vista`, defined in `vista/template.yaml`. Nothing here is secret.

| Piece | Service |
|---|---|
| App | S3 (private) + CloudFront |
| API | API Gateway HTTP API + Lambda (Node 22, arm64) |
| Worker (texts and scheduled jobs) | Lambda + EventBridge Scheduler, America/New_York |
| Data | DynamoDB, one table, on-demand, point-in-time recovery |
| Job photos | S3, private, versioned, TLS only; kept if the stack is deleted |
| Secrets | SSM Parameter Store, SecureString, `/vista/prod` |
| Logs and alarm | CloudWatch Logs (90 days); alarm on worker errors |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Workflow fails at **Configure AWS credentials** with "Not authorized to perform sts:AssumeRoleWithWebIdentity" | The identity provider is missing; the account number in the trust policy is wrong; or the GitHub environment isn't named exactly `vista-prod`. |
| `sam deploy` fails with an IAM "not authorized" error on `role/...` | The stack name isn't `vista`, so the `role/vista-*` rule doesn't match. |
| The health check at the end of the workflow fails | A secret is missing or in the wrong region. Rerun the check in 1b in the same region as `AWS_REGION`. CloudWatch log group `vista-ApiLogs-*` will say `missing secret …`. |
| Texts to the Vista number get no reply | The webhook address or method is wrong in Twilio; or the Twilio Auth Token in Parameter Store is wrong (look for `bad signature` in `vista-ApiLogs-*`). |
| Heartbeat fails at "login" | Salesforce: connected app, certificate or integration user. That's Matt's. |

## Later, as needed

- **Ship an update:** Matt merges to `main`, then you run the workflow and approve, the same as 3a.
- **Pause every scheduled job** (heartbeat, morning texts, cutoff notices): Matt sets `SCHEDULES_ENABLED` to
  `false`, and you redeploy.
- **Rotate a secret:** rerun `scripts/aws-secrets.sh`. Press Enter to keep the others. Then redeploy.
- **Email alerts on worker errors, or a custom web address:** tell Matt and we'll add it to the template, so a
  deploy doesn't undo a manual change.

Thanks!
