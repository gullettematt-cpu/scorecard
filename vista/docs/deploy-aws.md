# Deploying Vista on AWS

This guide is for Donald: the one-time setup, then the routine of shipping a change. Everything Vista
runs in AWS is defined in [`template.yaml`](../template.yaml), a single AWS SAM stack. Deploys run from GitHub
Actions ([`.github/workflows/vista.yml`](../../.github/workflows/vista.yml)), and each one needs a person to click
**Run workflow**, plus approval if you set that up.

Deploying on its own changes nothing for installers. The rollout switch starts **off** for every location
(`config/rollout.json`), so nobody sees Vista until you turn a location on (step 8).

## What gets created

| Piece | AWS service | Notes |
|---|---|---|
| The app | S3 (private) + CloudFront | Static PWA. `config.js` holds the API address and is written at deploy time. |
| The API | API Gateway (HTTP API) + Lambda `ApiFunction` (Node 22, arm64) | Sign-in by text code, snapshot, sync, photo upload URLs, Vi, the Twilio webhook, admin. |
| Worker | Lambda `WorkerFunction` | Incoming texts (the API hands them off so Twilio gets an instant answer) and the scheduled jobs. |
| Schedules | EventBridge Scheduler (America/New_York) | Heartbeat every 2 h · morning texts 6:30 AM Mon–Sat · PM digests 7:30 and 9:30 AM Mon–Fri · 10:00 AM cutoff Mon–Fri · dispatch check every 5 min. |
| Data | DynamoDB, one table (on-demand, point-in-time recovery, TTL) | People index, sign-in codes, text conversations, sync receipts, the translation cache, the live rollout switch, heartbeat state. **No Salesforce data is stored here**: Salesforce stays the record. |
| Photos | S3 (private, versioned, TLS only) | `vista/<WorkOrder>/<ServiceAppointment>/<time>-<kind>-<n>.jpg`. Phones upload with 15-minute signed URLs. Kept on stack delete. |
| Secrets | SSM Parameter Store (SecureString) under `/vista/prod` | Not in the template, the repo, GitHub or Lambda environment variables. |
| Logs | CloudWatch, 90 days | Access logs leave out bodies and query strings, so phone numbers and codes never land in them. |

Rough cost at Augusta volume: a few dollars a month for AWS. Twilio texts and Claude usage are billed
separately by those providers.

## One-time setup

### 1. Salesforce: integration user and connected app (Matt or the Salesforce admin)

1. **Donald generates the key pair** on his own computer, so the private key never leaves it:
   ```bash
   openssl req -x509 -newkey rsa:2048 -nodes -days 730 -subj "/CN=vista-integration" \
     -keyout vista-sf.key -out vista-sf.crt
   ```
   - He keeps `vista-sf.key` and loads it into Parameter Store in step 6. It never goes into chat, email or the
     repo.
   - He sends Matt `vista-sf.crt`, the public certificate. Email is fine for that.
   - The certificate lasts 2 years. To renew, repeat this step, load the new key, and upload the new certificate.
2. Create an **integration user**. `bash salesforce/integration-user.sh --prod` (then `--prod --go`) does all of this
   from the sf CLI and builds the permission set from Vista's own queries; by hand: (license *Salesforce Integration*, permission set license *Salesforce API
   Integration*, plus *Field Service Integration* for the FSL objects). Username, for example,
   `vista@southernindustries.com.prod`. Give it a permission set with:
   - **Read:** WorkOrder, WorkOrderLineItem, ServiceAppointment, AssignedResource, ServiceResource, User, Account,
     Job__c (and its Office lookup).
   - **Edit:** ServiceAppointment (Status, ActualStartTime, ActualEndTime), WorkOrderLineItem (Status).
   - **Create and edit:** SA_Expense__c, including every field in `docs/data-contract.md`.
   - **Delete:** SA_Expense__c. The heartbeat deletes its own `TEST_SA__c = true` records.
   - **Create:** Case (problem reports).
3. Create an **External Client App** (or a Connected App, if your org still allows new ones) called *Vista*:
   - OAuth enabled.
   - Scope: `api`.
   - Enable **JWT Bearer Flow** and upload `vista-sf.crt`.
   - Set Permitted Users to *Admin approved users are pre-authorized*.
   - Add the integration user's permission set to the app.
4. Note the **Consumer Key**. It is not secret and goes in GitHub variables (step 5).
5. Deploy the Vista Salesforce pieces if you haven't: the **Vista** picklist value, the two flows and the list
   views. See `salesforce/README.md`.

### 2. Twilio (Donald, in the Twilio account you already use)

Vista works with your existing Twilio account; nothing new to sign up for.

1. **A number for Vista.** Use a new local number with SMS and MMS, or a spare one. Don't use a number that
   already handles incoming texts for something else: Vista takes over its incoming webhook.
2. **A2P 10DLC.** Southern Industries' brand is probably already registered. Vista still needs a campaign
   whose use case covers its messages. If the existing campaign covers different messages (marketing or
   review requests, for example), register a new campaign under the same brand:
   - use case "Account notifications" (or "Mixed");
   - sample messages from `docs/sms-examples.md`;
   - opt-in: "Subcontractors and employees give their mobile number to Southern Industries for job
     dispatch and pay notifications; reply STOP to opt out."

   Carriers filter unregistered traffic, so start this first. Approval can take a few days.
3. **Messaging Service (recommended).** Create one called *Vista*, add the number to it and attach the
   campaign. Note its `MG…` SID for GitHub variables (step 5). Without a Messaging Service, Vista sends
   from the number in `TWILIO_FROM`.
4. **Keys.** Vista needs the account's Account SID, which is not secret, and its **Auth Token**. The Auth
   Token is required, not an API key, because Twilio signs incoming webhooks with it. You type it only
   into `scripts/aws-secrets.sh` (step 6).
5. **The webhook URL** is set after the first deploy (step 7).

### 3. Anthropic

Matt creates the key in the Claude Console (https://console.anthropic.com):
1. Create a workspace named **Vista**, so Vi's usage and cost are separate.
2. Give the workspace a monthly spend limit as a backstop. Vista already caps each person at 60 questions a day.
3. In that workspace, create an API key named **`vista-prod`**.
4. Send it to Donald by one-time link: a 1Password share or Bitwarden Send, good for 1 view and expiring in 1 day.
   Never by text or email.
5. Once Donald has loaded it in step 6, delete the share.

### 4. AWS: GitHub deploy role (Donald)

1. Add GitHub as an identity provider (once per account). In IAM, open **Identity providers**, click **Add**,
   choose **OpenID Connect**, and enter:
   - URL: `https://token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`
2. Create the role `vista-github-deploy`:
   - Trust policy: [`deploy/github-oidc-trust.json`](../deploy/github-oidc-trust.json).
   - Permissions: [`deploy/github-deploy-policy.json`](../deploy/github-deploy-policy.json).
   - In both files, replace `ACCOUNT_ID`. If you name the stack something other than `vista`, change the
     `role/vista-*` pattern too.

   The trust policy only accepts the `vista-prod` environment of `gullettematt-cpu/scorecard`. No AWS keys are
   stored in GitHub.

### 5. GitHub: the `vista-prod` environment (Matt, as repo owner)

Open the repo's **Settings**, then **Environments**, and click **New environment**. Name it `vista-prod`.

- **Required reviewers:** Donald (and Matt). Every production deploy then waits for one of you.
- **Deployment branches:** `main` only.
- **Environment variables.** These are settings, not secrets; the secrets are in SSM.

| Variable | Example |
|---|---|
| `AWS_REGION` | `us-east-1` |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::123456789012:role/vista-github-deploy` |
| `SF_CLIENT_ID` | the Consumer Key from step 1 |
| `SF_USERNAME` | `vista@southernindustries.com.prod` |
| `SF_LOGIN_URL` | `https://login.salesforce.com` (sandbox: `https://test.salesforce.com`) |
| `TWILIO_ACCOUNT_SID` | `AC…` |
| `TWILIO_MESSAGING_SERVICE_SID` | `MG…` (recommended; step 2) |
| `TWILIO_FROM` | `+17065550100` (only if no Messaging Service) |
| `ALERT_PHONES` | Matt's and Mike's mobiles, comma-separated, `+1…`. Each must text START to the Vista number to receive alerts. |
| `ADMIN_PHONES` | program owners (Matt): sign in to Vista as admins with no enrolling, can grant admin access (Lisa), and hear about language requests |
| `VISTA_STACK_NAME` | optional, default `vista` |
| `VISTA_SECRETS_PATH` | optional, default `/vista/prod` |
| `SCHEDULES_ENABLED` | optional, `false` to pause every scheduled job |

For a sandbox stack, make a `vista-sandbox` environment with its own role (its trust policy uses
`environment:vista-sandbox`) and set `VISTA_STACK_NAME=vista-sandbox`, `VISTA_SECRETS_PATH=/vista/sandbox` and
`VISTA_STAGE=sandbox`.

### 6. Secrets into SSM (Donald, on your computer with AWS access)

```bash
cd vista
AWS_REGION=us-east-1 bash scripts/aws-secrets.sh /vista/prod
```

The script:
- asks for the path to `vista-sf.key`;
- asks for the Twilio auth token and the Anthropic key at a hidden prompt, so nothing is echoed or saved in
  shell history;
- generates `APP_JWT_SECRET` and `ADMIN_TOKEN` itself.

Run it again any time to rotate a value.

### 7. First deploy

1. In GitHub, open **Actions**, then **Vista**, click **Run workflow**, and pick `vista-prod`. Approve it when
   asked.
2. The run's summary shows the **App URL**, the **API URL** and the **Twilio webhook**.
3. In Twilio, paste the webhook URL, method **HTTP POST**:
   - **With a Messaging Service:** open **Messaging**, then **Services**, then *Vista*, then **Integration**,
     and choose **Send a webhook**. Paste the URL in *Request URL*.
   - **Without one:** open the number's **Messaging configuration** and paste it into "A message comes in".

   Then text `today` to the Vista number from a phone that isn't in Salesforce. You should get the bilingual
   "ask your PM to add you" reply. (Twilio answers `HELP` and `STOP` itself, so don't test with those.)
4. Within 2 hours the heartbeat runs for the first time. If any step fails (log in, read a job, write a test SA
   Expense, store a photo), Matt and Mike get a text. To run it now:
   ```bash
   bash scripts/vista-admin.sh run heartbeat
   ```
   A healthy run returns `{"ok":true,...}`. Then check the whole Salesforce side, read-only, as the integration user:
   ```bash
   bash scripts/vista-admin.sh check-salesforce   # every query Vista runs, every field it writes, flows and list views
   ```
   It ends with **Ready** or **NOT ready**; each ✗ line names the field, value or permission to fix.

### 8. Turn it on

People don't need to be enrolled one by one. When someone signs in or texts, Vista matches the mobile number to
their Salesforce **User** or **ServiceResource**, and PMs are recognized from `Job__c.Production_Manager__c`.
Enroll only people who aren't in Salesforce, or whose number there is wrong:

```bash
bash scripts/vista-admin.sh add '+17065550112' 'Dwayne Tucker' installer en 0HnXXXXXXXXXXXX
```

Flip the rollout switch (live, no deploy):

```bash
bash scripts/vista-admin.sh rollout                                   # see it
bash scripts/vista-admin.sh set-location Augusta pilot                # pilot: only listed accounts
bash scripts/vista-admin.sh pilot Augusta 'Tucker Installs LLC'
bash scripts/vista-admin.sh set-location Augusta on                   # everyone at Augusta…
bash scripts/vista-admin.sh opt-out Augusta 'Some Account LLC'        # …except accounts that opt out
bash scripts/vista-admin.sh set-location Augusta off                  # back to the old process
```

`off` stops everything for that location: app screens, texts and dispatch notices. Records already in
Salesforce stay as they are.

## Routine

- **Ship a change:** merge to `main`, then run the workflow, choose `vista-prod` and approve. Tests run first; a
  red test stops the deploy.
- **Pause scheduled jobs:** set the `SCHEDULES_ENABLED` variable to `false`, then run the workflow.
- **See what happened:** open CloudWatch Logs, groups `vista-ApiLogs-*` and `vista-WorkerLogs-*`. The alarm
  `vista-WorkerErrors-*` fires if the worker errors 3 or more times in an hour. Subscribe an SNS topic to it if you
  want email.
- **Rotate a secret:** run `scripts/aws-secrets.sh`, then redeploy, or wait for the functions to recycle.
- **Try it without AWS:** run `npm run api:local` and `VISTA_API_URL=http://localhost:4174 npm run dev`. That
  starts the real API code with pretend Salesforce and Twilio, and sign-in codes print in the terminal.

## Security notes

- **Salesforce:** JWT bearer as a dedicated integration user. There are no passwords, and the key lives only in
  SSM.
- **App sign-in:** a 6-digit code texted to the number on file.
  - The code is single-use, expires in 10 minutes, and allows 5 tries.
  - At most 5 codes per hour per number, and none within 30 seconds of the last.
  - Unknown numbers get the same "code sent" answer, so nobody can probe who works for Southern.
- **Incoming texts:** every webhook call is checked against Twilio's signature. Anything else gets a 403.
- **Picture messages:** each photo is copied to Vista's S3 bucket. Once the Salesforce record is saved, the
  photo is deleted from Twilio, so homeowners' photos don't pile up with the text provider.
- **Rules the server enforces, whatever the phone sends:**
  - installers only touch their own dispatched visits;
  - pay needs the trade's minimum photos and stays within the contract;
  - only PMs approve or issue draws;
  - an approval needs every deliverable ticked.
- **Photos:** private. Uploads use short-lived signed URLs scoped to one key.
