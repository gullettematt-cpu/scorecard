# Vista API (serverless) — contract only, not wired in Step 1

Three jobs and one cron. Every handler is stateless; the phone is the only client.

| Route | Job | Notes |
|---|---|---|
| `POST /auth/start` `{phone}` | SMS code | Rate-limited per phone. Only phones on the installer/PM allow-list get a code. |
| `POST /auth/verify` `{phone, code}` → `{token, user:{name, crew, role, lang}}` | SMS code | Short-lived JWT for the phone. Role is `installer` or `pm`. |
| `GET /sf/today` | Salesforce | WorkOrders for the caller's crew, today ± 7 days, with pay request and draw statuses. Shapes = Salesforce API names (see `docs/data-contract.md`). |
| `GET /sf/job/:id` | Salesforce | WorkOrder + line items + Job__c + open Cases + pay requests and draws. |
| `PATCH /sf/visit/:id/start` | Salesforce | `ServiceAppointment.Status = In Progress`, `ActualStartTime`. Only on the caller's Dispatched visits. |
| `PATCH /sf/visit/:id/finish-measure` | Salesforce | Measure techs only: `Status = Completed`, `ActualEndTime`, when every line item is `Measurement Completed`. |
| `POST /sf/case` | Salesforce | Creates the Service-record-type Case with the three picklists. |
| `POST /sf/pay-request` | Salesforce | Installer's *Submit for pay* at completion. Creates `SA_Expense__c` with `Type__c = Vista`, `Status__c = New` (waits for the PM). **Refuses without the trade's minimum photos** or if the visit is not In Progress. Flow *Vista - Draw Submitted* completes the visit and, when every line item is done, moves the WO to `Installation Completed` for review. |
| `POST /sf/draw` `{workOrderId, amount, covers, requestedBy}` | Salesforce | **PM only.** Payment before completion: creates `SA_Expense__c` already `Approved` (`Approver__c` = PM) with `Did_you_complete_the_job_or_service__c = No`, after the PM confirms in the app. Salesforce emails Mike Duncan. Requires a progress photo on the job and passes `draw-rules.json`. |
| `PATCH /sf/pay-request/:id/decision` `{decision, checked[], missed[]}` | Salesforce | PM only. `submitted` (every required deliverable ticked, confirmed in the app) → `Status__c = Approved`, `Approver__c` = PM. No approval process. `sent_back` → stays `New`, missed items in the manifest. |
| `PATCH /sf/line-item/:id` `{status}` | Salesforce | `Installation Completed` (installer) or `Measurement Completed` (measure tech), only on the caller's in-progress visit. |
| `POST /photos/sign` `{workOrderId, expenseId, count}` → signed PUT URLs | Photo upload | Phone uploads directly to object storage; API never proxies bytes. |
| `POST /vi/ask` `{workOrderId, lang, question, history}` | Vi | Claude API, `claude-sonnet-5`, streamed. |
| `POST /sms/inbound` (text provider webhook) | Text | Verifies the provider signature, runs `web/src/sms/engine.js` for the sender, performs the returned actions (same Salesforce writes as the app), copies picture messages to object storage, sends the replies. |
| cron 6:30 AM | Text | Morning list for people on `TEXT`. |
| cron 7:30 AM and 9:30 AM | Text | Review list for PMs with requests waiting. |
| on dispatch (poll every 5 min for newly Dispatched visits) | Text | "New job dispatched" to the crew. |
| cron 10:00 AM ET, Mon–Fri | Cutoff notices | For every Vista pay request still `New` at cutoff (sent back or not yet reviewed): one text per sub in their language listing what was missed (respects `ServiceAppointment.SMS_Opt_out__c`); one reminder per PM with unreviewed draws. See `docs/approval-flow.md`. |
| cron every 2 h | Heartbeat | login → read WorkOrder → create `SA_Expense__c` (`TEST_SA__c = true`) → upload photo → SMS Matt + Mike on failure. |

## Salesforce auth
Connected app, **JWT bearer flow**, a dedicated company-owned integration user (API-only, own profile/permission set,
IP-restricted). The private key lives in the serverless secret store, never in the repo or the phone.
Token is cached in memory per warm instance and refreshed on 401.

## Configuration (names only — values live in the secret store)
```
SF_LOGIN_URL, SF_CLIENT_ID, SF_USERNAME, SF_JWT_PRIVATE_KEY
SF_MANIFEST_FIELD                 # e.g. SA_Expense__c.Notes__c — from docs/data-contract.md
SF_CASE_SERVICE_RECORD_TYPE_ID
SMS_PROVIDER_SID, SMS_PROVIDER_TOKEN, SMS_FROM   # one number with MMS; A2P 10DLC or toll-free verified
ALERT_PHONES                      # Matt, Mike
STORAGE_BUCKET, STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY, STORAGE_ENDPOINT
ANTHROPIC_API_KEY, VI_MODEL=claude-sonnet-5
APP_JWT_SECRET
```
