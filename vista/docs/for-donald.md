# Vista: getting it live on AWS

Donald,

This one document has everything you need to get Vista running in AWS and connected to Twilio, in order, with the
commands to paste. I'm handling all of Salesforce. Wherever it says **🏷️ Tag Matt**, add a comment on
[pull request #1](https://github.com/gullettematt-cpu/scorecard/pull/1) that mentions **@gullettematt-cpu**, so I
get notified and the whole setup stays in one thread. Never put a key, token or password in that comment (see the
rules below).

## What Vista is

Vista is the phone app and text line for our installers, measure techs and PMs. Its tagline is *Todo a la vista*
("see the whole job").

- Crews see their dispatched jobs, mark line items done, and submit for pay with a photo for each required shot
  ("no photos, no pay").
- They can report a problem on the job and ask Vi, the built-in assistant, questions about it.
- PMs review the photos and a deliverables checklist, then approve in one step or send it back with what's
  missing. Draws go through the PM.
- It works in English, Spanish or both, by app, text, or both.

**All of it is built and tested:** all five screens (Today, Job, Submit for Pay, Approve, Ask Vi), plus Report a
problem and the text line. What's left is setting it up in our accounts.

- **See it first.** Screenshots of every step, plus a working demo you can click through:
  https://claude.ai/artifact/1p9mbThVcv2rNVm1XXzGJa
- **The code:** https://github.com/gullettematt-cpu/scorecard, pull request #1. Accept my collaborator invite
  first.

## Deploying is safe

- **Nobody sees Vista after the first deploy.** Every location starts switched off. Mike and I turn Augusta on
  later, first for a few pilot crews, and it can be switched back off with one command.
- **Salesforce keeps working the way it does now.** Vista writes the same SA Expense records, and Angie's payable
  invoice process doesn't change. Problem reports become normal Service cases.
- **One thing starts right away: a health check every 2 hours.** It logs in to Salesforce and reads a job, writes
  a test SA Expense (`TEST_SA__c = true`, removed on the next run), and stores a test photo. If any step fails,
  Mike and I get a text.
- **Nothing deploys without approval.** Deploys only run when someone clicks **Run workflow** in GitHub, and you
  approve each one.

## Rules for keys and passwords

- **Never send a key, token or password** by email, text, chat or a GitHub comment, including to me.
- **Secrets go straight into AWS Parameter Store** with the script in step 3. Nothing secret lives in GitHub or in
  the code.

## The plan at a glance

| Step | Who | What | Time |
|---|---|---|---|
| 0 | You | Answer four questions; start the Twilio registration | 30 min, then carriers take days |
| 1 | You | Get set up: tools, repo, the two items from me | 15 min |
| 2 | You | Let GitHub deploy to AWS (identity provider and deploy role) | 15 min |
| 3 | You | Load the secrets | 10 min |
| 4 | You | 🏷️ **Tag Matt** with five values | 2 min |
| 5 | Me | Merge, set up the GitHub environment, 🏷️ tag you back | — |
| 6 | You | First deploy | 15 min (about 10 of it waiting) |
| 7 | You | Connect Twilio, run the checks, set a cost alarm | 15 min |
| 8 | You | 🏷️ **Tag Matt**: done | 2 min |

---

## Step 0: questions and Twilio (do this first)

### Four questions for you

Answer these in your first comment on the pull request:

1. **AWS account:** should Vista go in our existing account or a separate one? Which region? Everything below
   assumes `us-east-1`.
2. **Twilio:** what's registered today? I need the brand and campaign names, and their use cases. If the current
   campaign already covers job and pay notices, we may be able to reuse it.
3. **Web address:** Vista launches on an AWS default address (`…cloudfront.net`). Do you want
   `vista.southernindustries.com` instead? It's a small follow-up once DNS is sorted.
4. **Alerts:** who besides Mike and me should get a text if the health check fails?

🏷️ **Tag Matt** with the answers. You don't need to wait for me before starting the Twilio setup.

### Twilio setup (in our existing account)

Carriers take several days to approve texting campaigns, so start this now.

1. **A number for Vista.** Use a new local number with SMS and MMS, or a spare one. Don't use a number that already
   handles incoming texts for something else, because Vista takes over where its incoming texts go.
2. **An A2P 10DLC campaign** under our existing brand, for Vista's messages:
   - **Use case:** "Account notifications" (or "Mixed").
   - **Sample messages:** use the ones in `vista/docs/sms-examples.md`.
   - **Opt-in wording:** "Subcontractors and employees give their mobile number to Southern Industries for job
     dispatch and pay notifications; reply STOP to opt out."
3. **A Messaging Service named *Vista*.** Add the number to it and attach the campaign.

🏷️ **Tag Matt** when the campaign is approved, or if the carriers reject it. Texting to crews can't start until
it's approved; everything else can go ahead.

---

## Step 1: get set up

You need:
- **Admin access to the AWS account** Vista will live in.
- **The AWS CLI v2, logged in to that account.** `aws sts get-caller-identity` should show the right account
  number.
- **git, Node.js 22 and `openssl`** on your computer.
- **Collaborator access to the GitHub repo.** Accept my invite.
- **The Salesforce key pair, generated by you.** The private key never leaves your machine. You keep
  `vista-sf.key` and send me only the certificate `vista-sf.crt`; it's public, so email is fine. I upload the
  certificate to the Vista connected app in Salesforce. If you ever need to make a new pair:
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes -days 730 -subj "/CN=vista-integration" \
    -keyout vista-sf.key -out vista-sf.crt
  ```
- **From me, by one-time link:** the Anthropic API key `vista-prod`, for Vi, which runs on Anthropic's Claude.
  - It lives in a separate Vista workspace with a monthly spend cap as a backstop.
  - It comes as a 1Password share or Bitwarden Send, good for 1 view and expiring in 1 day. Never by text or
    email.
- **From Twilio:** the account's **Auth Token**. You type it into a hidden prompt, so nobody else sees it.

Get the code:

```bash
git clone https://github.com/gullettematt-cpu/scorecard.git
cd scorecard/vista
git checkout claude/vista-pwa-setup-x8gov3   # until I merge it into main in step 5
```

## Step 2: let GitHub deploy without storing AWS keys

GitHub signs in to AWS with a short-lived token (OIDC), so there are no access keys to leak or rotate.

**Add GitHub as an identity provider.** You only do this once per AWS account; skip it if the provider is already
there.

1. In the AWS console, open **IAM**, then **Identity providers**, and click **Add provider**.
2. Choose **OpenID Connect**.
3. Enter these two values, then click **Add provider**:
   - Provider URL: `https://token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`

**Create the deploy role** (run from `scorecard/vista`):

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" deploy/github-oidc-trust.json  > /tmp/vista-trust.json
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" deploy/github-deploy-policy.json > /tmp/vista-policy.json

aws iam create-role --role-name vista-github-deploy \
  --assume-role-policy-document file:///tmp/vista-trust.json \
  --description "GitHub Actions deploys the Vista stack"
aws iam put-role-policy --role-name vista-github-deploy \
  --policy-name vista-deploy --policy-document file:///tmp/vista-policy.json

aws iam get-role --role-name vista-github-deploy --query Role.Arn --output text   # you'll send me this in step 4
```

What the role allows:
- **Who can use it:** only the `vista-prod` deploy environment of `gullettematt-cpu/scorecard`. If the repo ever
  moves to a GitHub organization, update the `sub` line in the trust policy.
- **What it can manage:** the services Vista uses (CloudFormation, Lambda, API Gateway, DynamoDB, S3, CloudFront,
  EventBridge Scheduler, CloudWatch and X-Ray).
- **IAM:** it can only create IAM roles named `vista-*`.

Review `/tmp/vista-policy.json` before you apply it, and tighten it if you like.

## Step 3: load the secrets

```bash
export AWS_REGION=us-east-1          # the region you picked
bash scripts/aws-secrets.sh /vista/prod
```

The script:
- **Asks for** the path to `vista-sf.key`.
- **Asks for** the Twilio Auth Token and the Anthropic key at a hidden prompt, so they never appear on screen or in
  shell history.
- **Generates two secrets itself:** `APP_JWT_SECRET` (for app sign-in) and `ADMIN_TOKEN` (for admin commands).

Everything is stored as SecureString under `/vista/prod`. Check that all five are there:

```bash
aws ssm get-parameters-by-path --path /vista/prod --query "Parameters[].Name" --output text
# /vista/prod/ADMIN_TOKEN  /vista/prod/ANTHROPIC_API_KEY  /vista/prod/APP_JWT_SECRET  /vista/prod/SF_PRIVATE_KEY  /vista/prod/TWILIO_AUTH_TOKEN
```

**All five must be there before the first deploy, or its health check fails.**

- **If the Anthropic key arrives after the others:** open my one-time link and rerun the script. Press Enter at
  every prompt except the Anthropic key; Enter keeps the value already stored. Then tell me it's loaded, so I can
  delete the share.
- **Once `vista-sf.key` is in Parameter Store,** keep it only in your password manager, or delete it.
- **The certificate expires in 2 years** (September 2028). To renew, generate a new pair with the command in
  step 1, load the new key, and send me the new certificate.

## Step 4: 🏷️ Tag Matt with these values

None of these are secret. Post them in the comment.

| What | Where to find it |
|---|---|
| AWS region | the one you used in step 3 |
| Deploy role ARN | the last command in step 2 |
| Twilio Account SID (`AC…`) | Twilio console home page |
| *Vista* Messaging Service SID (`MG…`) | Twilio → Messaging → Services |
| The Vista phone number | Twilio → Phone Numbers |

## Step 5: my turn (wait for my tag)

I'll:
1. merge pull request #1 into `main`, since deploys run from `main`;
2. create the `vista-prod` environment in GitHub with you as the required approver;
3. fill in its settings with your values and my Salesforce ones.

I'll tag you on the pull request when it's ready.

## Step 6: first deploy

1. In GitHub, open **Actions**, then **Vista**, and click **Run workflow**.
2. Set **Use workflow from** to `main` and the environment to `vista-prod`, then run it.
3. When it pauses on **Review deployments**, approve it.

The tests run first, and the deploy only starts if they pass. The first deploy takes about 10 minutes, mostly
while CloudFront sets up.

When it finishes, the run summary lists:
- the **App URL** (where crews will open Vista);
- the **API URL**;
- the **Twilio webhook**.

The workflow's last step checks the API's health, which proves all five secrets load.

To see everything the stack created:

```bash
aws cloudformation describe-stacks --stack-name vista --query "Stacks[0].Outputs" --output table
```

## Step 7: connect Twilio, run the checks, set a cost alarm

**Connect Twilio.**
1. In Twilio, open **Messaging**, then **Services**, then *Vista*, then **Integration**, and choose **Send a
   webhook**.
2. Paste the Twilio webhook address into **Request URL**, with method **HTTP POST**.
3. Test it: text `today` to the Vista number from a phone that isn't in Salesforce. You should get a bilingual
   reply asking you to have your PM add you. Twilio answers HELP and STOP itself, so don't test with those.

If the campaign isn't approved yet, carriers may block the reply. Test again once it's approved.

**Run the health check now** rather than waiting for the 2-hour schedule:

```bash
bash scripts/vista-admin.sh run heartbeat     # expect {"ok":true}
bash scripts/vista-admin.sh rollout           # expect Augusta "off": nobody sees Vista yet
```

**Give Lisa (payroll) her admin access.** Lisa runs the program from Vista's admin screens, and only the admin token
can grant that role. I'll send you Lisa's mobile number.

```bash
bash scripts/vista-admin.sh add '+1XXXXXXXXXX' 'Lisa Lastname' admin en
```

If the heartbeat fails, the reply names the step (`login`, `read`, `write` or `upload`) and the error.
- **`login`, `read` or `write`:** those are Salesforce. 🏷️ **Tag Matt** with the reply.
- **`upload`:** that's AWS. See Troubleshooting below.

**Set a cost alarm.**
1. In the AWS console, open **Billing and Cost Management**, then **Budgets**, and click **Create budget**.
2. Choose a **Monthly cost budget** of about $25, with your email for alerts.

Expected spend at Augusta's volume is a few dollars a month.

## Step 8: 🏷️ Tag Matt: done

Post in the comment:
- the **App URL** from step 6;
- the heartbeat result;
- whether the text test got its reply.

From there, Mike and I pick the pilot crews and switch Augusta to `pilot`.

---

## When else to tag me

- **Anything Salesforce:** a heartbeat that fails at `login`, `read` or `write`; a "Salesforce" error in the logs;
  or questions about the integration user or connected app.
- **Before changing anything by hand** in the Vista stack. The next deploy would undo manual changes, so we add
  them to the template instead. That includes email alerts and a custom web address.
- **A decision that isn't technical:** who gets alerts, turning a location on or off, or pausing scheduled texts.
- **Any time you're stuck for more than 15 minutes.**

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The workflow fails at **Configure AWS credentials** with "Not authorized to perform sts:AssumeRoleWithWebIdentity" | Either the identity provider is missing, the account number in the trust policy is wrong, or the GitHub environment isn't named exactly `vista-prod`. |
| `sam deploy` fails with an IAM "not authorized" error on `role/...` | The stack name isn't `vista`, so the `role/vista-*` rule doesn't match. |
| The health check at the end of the workflow fails | A secret is missing or in the wrong region. Rerun the check in step 3 in the same region. CloudWatch log group `vista-ApiLogs-*` will say `missing secret …`. |
| Texts to the Vista number get no reply | Either the webhook address or method is wrong in Twilio; or the Twilio Auth Token in Parameter Store is wrong (look for `bad signature` in `vista-ApiLogs-*`); or the campaign isn't approved yet. |
| Heartbeat fails at `login` | Salesforce. 🏷️ **Tag Matt**. |

## What's in the stack

One CloudFormation stack named `vista`, defined in `vista/template.yaml`:

| Piece | Service |
|---|---|
| App | S3 (private) + CloudFront |
| API | API Gateway HTTP API + Lambda (Node 22, arm64) |
| Worker (texts and scheduled jobs) | Lambda + EventBridge Scheduler, America/New_York |
| Data | DynamoDB, one table, on-demand, point-in-time recovery |
| Job photos | S3, private, versioned, TLS only; kept if the stack is deleted |
| Secrets | SSM Parameter Store, SecureString, `/vista/prod` |
| Logs and alarm | CloudWatch Logs (90 days), alarm on worker errors |

## What it costs

- **AWS:** a few dollars a month at Augusta's volume. Everything is pay-per-use, including photo storage.
- **Twilio texts:** billed by Twilio per message.
- **Vi:** runs on Anthropic's Claude and is billed per question. Each person is capped at 60 questions a day, so a
  stuck phone can't run up the bill.

## Later, as needed

- **Ship an update:** I merge to `main`, then you run the workflow and approve, the same as step 6.
- **Pause every scheduled job** (heartbeat, morning texts, cutoff notices): I set `SCHEDULES_ENABLED` to `false`
  and you redeploy.
- **Rotate a secret:** rerun `scripts/aws-secrets.sh` (press Enter to keep the others), then redeploy.
- **Try it on your own computer** with stand-ins for Salesforce and Twilio: run `npm run api:local`, then
  `VISTA_API_URL=http://localhost:4174 npm run dev`. Details are in `vista/README.md`.
- **Background on any step:** `vista/docs/deploy-aws.md`.

Thanks,
Matt
