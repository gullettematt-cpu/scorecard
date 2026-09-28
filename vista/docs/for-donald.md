# Vista: getting it running on AWS

Donald,

Vista is the phone app and text line for our installers, measure techs and PMs. Its tagline is *Todo a la vista*
("see the whole job"). Crews see their dispatched jobs, mark line items done, and submit for pay with photos.
PMs review a checklist and approve in one step. Draws also go through the PM. It works in English, Spanish or
both, and crews can use the app, texts, or both.

The code is written and tested, and it's built to run in AWS. What's left is setting it up in our accounts,
and most of that is yours. The full step-by-step guide is
[`vista/docs/deploy-aws.md`](https://github.com/gullettematt-cpu/scorecard/blob/claude/vista-pwa-setup-x8gov3/vista/docs/deploy-aws.md).
This note is the short version: what I need from you, in order.

## Deploying is safe

- **Nobody sees Vista after the first deploy.** Every location starts switched off. We turn Augusta on
  ourselves, first for a pilot group and then for everyone, with one command, and we can turn it back off the
  same way.
- **Salesforce keeps working the way it does now.** Vista writes the same SA Expense records, and Angie's
  payable invoice process doesn't change.
- **One thing does start right away.** A health check runs every 2 hours in production. It logs in, reads a
  job, writes a test SA Expense (`TEST_SA__c = true`, cleaned up on the next run) and stores a test photo. If
  any step fails, Mike and I get a text.
- **Nothing is deployed without approval.** Deploys only run when someone clicks **Run workflow** in GitHub,
  and they need your approval.

## What I need from you

| # | What | Where in the guide | Time |
|---|---|---|---|
| 1 | **Twilio:** pick a dedicated number for Vista, put it in a new Messaging Service named *Vista*, and register an A2P 10DLC campaign for it under our existing brand. **Start this first, because carrier approval can take several days.** | Step 2 | 30 min, then wait |
| 2 | **AWS:** add GitHub as an identity provider (OIDC) and create the `vista-github-deploy` role from the two JSON files in `vista/deploy/`. | Step 4 | 20 min |
| 3 | **Secrets:** run `scripts/aws-secrets.sh`. It asks for the Salesforce key file, the Twilio Auth Token and the Anthropic key at a hidden prompt, and stores them in AWS Parameter Store. | Step 6 | 10 min |
| 4 | **First deploy:** in GitHub, open **Actions**, then **Vista**, click **Run workflow**, choose `vista-prod`, and approve. The run summary shows the app address, the API address and the Twilio webhook. | Step 7 | 15 min |
| 5 | **Twilio webhook:** paste the webhook address into the *Vista* Messaging Service, under **Integration**, then **Send a webhook**. | Step 7 | 5 min |
| 6 | **Health check:** run `bash scripts/vista-admin.sh run heartbeat` and confirm it returns `ok`. | Step 7 | 5 min |

**Please don't send keys, tokens or passwords by email, text or chat, including to me.** They go straight into
AWS with the script in step 3. Nothing secret is stored in GitHub or in the code.

## What I'm doing in parallel

- The Salesforce side: the integration user, the connected app with its certificate, the Vista picklist value
  and the two flows (guide step 1). I'll get you the **Consumer Key** and **integration username**. Neither is
  secret. I'll also hand you the private key file in person or through our password manager, and you load it in
  step 3.
- Creating the `vista-prod` environment in GitHub, with you as the required approver, and filling in its
  settings (guide step 5). I'll need your AWS region and the deploy role's ARN for that.
- Adding you to the GitHub repository if you aren't already.

## Questions for you

1. **AWS account:** should this go in our existing account or a separate one? And which region (the guide
   assumes `us-east-1`)?
2. **Twilio:** what's registered today? I need the brand and campaign names, their use cases, and whether a
   Messaging Service already exists. If the current campaign already covers job and pay notices, we may be
   able to reuse it.
3. **Web address:** it launches on an AWS default address (`…cloudfront.net`). Do you want
   `vista.southernindustries.com` instead? It's a small follow-up once DNS is sorted.
4. **Alerts:** who besides Mike and me should get a text if the health check fails?

## What it costs

AWS should come to a few dollars a month at Augusta's volume, because everything is pay-per-use. Twilio texts
and the AI assistant (Vi, which runs on Anthropic's Claude) are billed by those companies as they're used.

## Where things are

- The code is on branch `claude/vista-pwa-setup-x8gov3`, in pull request #1:
  https://github.com/gullettematt-cpu/scorecard/pull/1
- What gets created in AWS: `vista/template.yaml` (one CloudFormation stack, named `vista`)
- The deploy pipeline: `.github/workflows/vista.yml`
- How the API works: `vista/api/README.md`
- To try it on your own computer with pretend Salesforce and Twilio, run `npm run api:local`, then
  `VISTA_API_URL=http://localhost:4174 npm run dev` (details in `vista/README.md`)

Once steps 1–6 are done, we pilot Vista in Augusta with one or two crews.

Thanks,
Matt
