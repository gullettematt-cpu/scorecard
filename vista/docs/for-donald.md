# Vista: getting it running on AWS

Donald,

Vista is the phone app and text line for our installers, measure techs and PMs. Its tagline is *Todo a la vista*
("see the whole job"). Here's what it does:

- Crews see their dispatched jobs, mark line items done, and submit for pay with a photo for each required shot
  ("no photos, no pay").
- They can report a problem on the job, and ask Vi, the built-in assistant, questions about the job.
- PMs review the photos and a deliverables checklist, then approve in one step or send it back with what's
  missing. Draws also go through the PM.
- It works in English, Spanish or both. Crews can use the app, texts, or both.

**All of it is built and tested.** All five screens work (Today, Job, Submit for Pay, Approve, Ask Vi), plus
Report a problem and the text line. It runs in AWS. What's left is setting it up in our accounts, and most of that
is yours.

- **See it first.** This walkthrough has screenshots of every step and a working demo you can click through:
  https://claude.ai/artifact/1p9mbThVcv2rNVm1XXzGJa
- **The full step-by-step setup guide:**
  [`vista/docs/deploy-aws.md`](https://github.com/gullettematt-cpu/scorecard/blob/claude/vista-pwa-setup-x8gov3/vista/docs/deploy-aws.md).

This note is the short version: what I need from you, in order.

## Deploying is safe

- **Nobody sees Vista after the first deploy.** Every location starts switched off. We turn Augusta on
  ourselves with one command, first for a pilot group and then for everyone. We can turn it back off the same
  way.
- **Salesforce keeps working the way it does now.** Vista writes the same SA Expense records, and Angie's
  payable invoice process doesn't change. Problem reports become normal Service cases.
- **One thing does start right away.** A health check runs every 2 hours in production:
  - it logs in and reads a job;
  - it writes a test SA Expense (`TEST_SA__c = true`, cleaned up on the next run);
  - it stores a test photo.

  If any step fails, Mike and I get a text.
- **Nothing is deployed without approval.** Deploys only run when someone clicks **Run workflow** in GitHub,
  and they need your approval.

## What I need from you

| # | What | Where in the guide | Time |
|---|---|---|---|
| 1 | **Twilio:** in our existing account, pick a dedicated number for Vista and put it in a new Messaging Service named *Vista*. Register an A2P 10DLC campaign for it under our existing brand. **Start this first, because carrier approval can take several days.** | Step 2 | 30 min, then wait |
| 2 | **AWS:** add GitHub as an identity provider (OIDC), then create the `vista-github-deploy` role from the two JSON files in `vista/deploy/`. | Step 4 | 20 min |
| 3 | **Secrets:** run `scripts/aws-secrets.sh`. It asks for the Salesforce key file, the Twilio Auth Token and the Anthropic key at a hidden prompt, then stores them in AWS Parameter Store. | Step 6 | 10 min |
| 4 | **First deploy:** in GitHub, open **Actions**, then **Vista**, and click **Run workflow**. Choose `vista-prod` and approve. The run summary shows the app address, the API address and the Twilio webhook. | Step 7 | 15 min |
| 5 | **Twilio webhook:** paste the webhook address into the *Vista* Messaging Service, under **Integration**, then **Send a webhook**. | Step 7 | 5 min |
| 6 | **Health check:** run `bash scripts/vista-admin.sh run heartbeat` and confirm it returns `ok`. | Step 7 | 5 min |

**Please don't send keys, tokens or passwords by email, text or chat, including to me.** They go straight into
AWS with the script in step 3. Nothing secret is stored in GitHub or in the code.

## What to send me back

None of these are secret. I need them to fill in the GitHub settings before your first deploy (step 4):

- **From AWS:** the region, and the deploy role's ARN (`arn:aws:iam::…:role/vista-github-deploy`)
- **From Twilio:**
  - the Account SID (`AC…`)
  - the *Vista* Messaging Service SID (`MG…`)
  - the Vista phone number

## What I'm doing in parallel

- **The Salesforce side (guide step 1):**
  - the integration user;
  - the connected app with its certificate;
  - the Vista picklist value and the two flows.

  I'll send you the **Consumer Key** and **integration username**. Neither is secret. I'll hand you the private
  key file in person or through our password manager, and you load it in step 3.
- **The `vista-prod` environment in GitHub (guide step 5):** you as the required approver, and its settings
  filled in with what you send back.
- **Adding you to the GitHub repository**, if you aren't on it already.

## Questions for you

1. **AWS account:** should this go in our existing account or a separate one? Which region? The guide assumes
   `us-east-1`.
2. **Twilio:** what's registered today? I need the brand and campaign names, their use cases, and whether a
   Messaging Service already exists. If the current campaign already covers job and pay notices, we may be
   able to reuse it.
3. **Web address:** it launches on an AWS default address (`…cloudfront.net`). Do you want
   `vista.southernindustries.com` instead? It's a small follow-up once DNS is sorted.
4. **Alerts:** who besides Mike and me should get a text if the health check fails?

## What it costs

- **AWS:** a few dollars a month at Augusta's volume, because everything is pay-per-use. That includes photo
  storage.
- **Twilio texts:** billed by Twilio per message.
- **Vi:** runs on Anthropic's Claude and is billed per question. Each person is capped at 60 questions a day, so
  a stuck phone can't run up the bill.

## Where things are

- **The code:** branch `claude/vista-pwa-setup-x8gov3`, pull request #1:
  https://github.com/gullettematt-cpu/scorecard/pull/1
- **What gets created in AWS:** `vista/template.yaml`, one CloudFormation stack named `vista`
- **The deploy pipeline:** `.github/workflows/vista.yml`
- **How the API works:** `vista/api/README.md`
- **To try it on your own computer** with stand-ins for Salesforce and Twilio: run `npm run api:local`, then
  `VISTA_API_URL=http://localhost:4174 npm run dev`. Details are in `vista/README.md`.

Once steps 1–6 are done, we pilot Vista in Augusta with one or two crews.

Thanks,
Matt
