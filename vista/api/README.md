# Vista API

This is Node 22 code on AWS Lambda. It runs as two functions from one codebase:

- `src/http.mjs` serves API Gateway.
- `src/worker.mjs` handles incoming texts and the scheduled jobs.

Salesforce is the only system of record. DynamoDB holds only what Salesforce has no place for:

- sign-in codes
- text conversations
- sync receipts
- the translation cache
- the live rollout switch
- heartbeat state

To deploy, see [`docs/deploy-aws.md`](../docs/deploy-aws.md). The infrastructure is defined in [`template.yaml`](../template.yaml).

```bash
npm run test:api         # 19 tests; fake Salesforce answers the real SOQL from the app's fixtures
npm run api:local        # the API on :4174 with fakes; sign-in codes print in the terminal
VISTA_API_URL=http://localhost:4174 npm run dev   # the app in live mode against it
```

## Routes

| Route | Who | What |
|---|---|---|
| `GET /health` | anyone | Loads secrets and returns `{ok:true}`. Used as the deploy smoke test. |
| `POST /auth/start` `{phone, lang}` | anyone | Texts a 6-digit code if the number belongs to someone (enrolled, or found in Salesforce). Same answer either way. Limits: 5 codes an hour and 1 per 30 seconds for each number. |
| `POST /auth/verify` `{phone, code}` → `{token, person}` | anyone | Code is single-use, expires in 10 minutes, and allows 5 tries. Returns an app token (HS256, `APP_JWT_SECRET`). |
| `GET /me`, `PATCH /me/prefs` `{lang, channel}` | signed in | Language `en` / `es` / `bi` and channel `app` / `text` / `both`, shared with texts. |
| `GET /snapshot` | signed in | The caller's jobs, pay requests, draws, cases and people, in the same shapes as `web/fixtures/*` (Salesforce API names). Also returns the rollout switch, draw rules and translation pairs for free text. |
| `POST /sync` `{entries:[{id, kind, payload}]}` | signed in | Replays the phone's outbox. Each `id` is applied once. Each entry gets `{ok}` or `{ok:false, status, error}` (a rule refusal). Kinds are listed below. |
| `POST /photos/sign` `{workOrderId, kind, count}` | installers, measure techs | Signed S3 PUT URLs (15 minutes), only for the caller's own job. |
| `POST /translate` `{texts[]}` | signed in | English/Spanish pairs, cached per text. |
| `POST /vi/ask` `{workOrderId, question}` | signed in | Vi (Claude, `claude-sonnet-5`) answers with the job, its trade checklist and the person's language. |
| `POST /sms/inbound` | Twilio | Checks the signature, then hands off to the worker and returns an empty TwiML reply. |
| `GET/POST /admin/people`, `GET/PUT /admin/rollout`, `GET /admin/language-requests`, `POST /admin/run` `{job}` | `x-admin-token` | Use `scripts/vista-admin.sh`, which reads the token from SSM. |

### Sync kinds (the same actions the text engine emits)

| Kind | Rule enforced on the server |
|---|---|
| `serviceappointment.start` | Caller's own visit, only while Dispatched. |
| `serviceappointment.complete` | Measure techs, once every line item is measured (installers complete through pay). |
| `woli.status` | Installers can only set *Installation Completed*; measure techs only *Measurement Completed*. |
| `payrequest.create` | Installer only. Amount must be within the contract and the trade's minimum photos present. Creates `SA_Expense__c` with Type **Vista**, Status **New**, "job complete" **Yes**, and the manifest in `Additional_Work_Performed_Description__c`. |
| `payrequest.resubmit` | Only after a send-back; asks only for the missing photos. |
| `payrequest.approve` | PM only. Status must be New and every required deliverable ticked. Sets **Approved** and `Approver__c` = PM name. No approval process. |
| `payrequest.sendBack` | PM only. Needs the missed items. The record stays New. |
| `draw.issue` | PM only. Job must be eligible under `draw-rules.json`, have a progress photo, and the amount must be within what remains. Creates the record **Approved** with "job complete" **No**. The Salesforce flow emails Mike Duncan. |
| `checklist`, `progress.photo`, `person.prefs`, `person.channel`, `language.request`, `vi.ask` | As the names say. |

## Scheduled jobs (worker)

| Job | When (ET) | What |
|---|---|---|
| `heartbeat` | every 2 h | Steps: log in to Salesforce, read a WorkOrder, create an `SA_Expense__c` with `TEST_SA__c = true` (deleting the previous one), store a 1×1 photo in S3. Texts `ALERT_PHONES` once when a step starts failing, and once when it recovers. |
| `morning` | 6:30 AM Mon–Sat | Today's list for installers and measure techs on `text` / `both`. |
| `pm-digest` | 7:30 and 9:30 AM Mon–Fri | Review list for PMs. |
| `cutoff` | 10:00 AM Mon–Fri | Vista pay requests still New miss today's run. Subs get the reason; each PM gets a count. Once per record per day. |
| `dispatch-poll` | every 5 min | "New job dispatched" text for visits dispatched since the last check, where Vista is on. |

## Code map

| File | Role |
|---|---|
| `src/lib/salesforce.mjs` | JWT bearer auth (RS256), query with paging, create/update/delete, retry once on 401 |
| `src/lib/snapshot.mjs` | Salesforce → the app's fixture shapes, per person and role |
| `src/lib/actions.mjs` | The rules above, then the Salesforce writes |
| `src/lib/services.mjs` | Snapshot, sync, texts, scheduled jobs, rollout |
| `src/lib/people.mjs` | Phone → person (enrolled, or found on User / ServiceResource) |
| `src/lib/auth.mjs` | Sign-in codes and app tokens |
| `src/lib/vi.mjs` | Vi and translation (Anthropic SDK) |
| `src/lib/twilio.mjs`, `photos.mjs`, `store.mjs` | Twilio, S3, DynamoDB |
| `src/lib/shared.mjs` | Imports the app's own engine, strings, rollout and checklists, so the app, the texts and the API share one set of rules |
| `src/lib/deps.mjs` | Real dependencies. Secrets come from SSM under `SECRETS_PATH`. |
