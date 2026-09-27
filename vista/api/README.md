# Vista API (serverless) — contract only, not wired in Step 1

Three jobs and one cron. Every handler is stateless; the phone is the only client.

| Route | Job | Notes |
|---|---|---|
| `POST /auth/start` `{phone}` | SMS code | Rate-limited per phone. Only phones on the installer/PM allow-list get a code. |
| `POST /auth/verify` `{phone, code}` → `{token, user:{name, crew, role, lang}}` | SMS code | Short-lived JWT for the phone. Role is `installer` or `pm`. |
| `GET /sf/today` | Salesforce | WorkOrders for the caller's crew, today ± 7 days, with draw statuses. Shapes = Salesforce API names (see `docs/data-contract.md`). |
| `GET /sf/job/:id` | Salesforce | WorkOrder + line items + Job__c + open Cases + draws. |
| `PATCH /sf/visit/:id/start` | Salesforce | `ServiceAppointment.Status = In Progress`, `ActualStartTime`. Only on the caller's Dispatched visits. |
| `POST /sf/case` | Salesforce | Creates the Service-record-type Case with the three picklists. |
| `POST /sf/draw` | Salesforce | Creates `SA_Expense__c` with `Type__c = Vista`, `Status__c = Submitted`. **Refuses without the trade's minimum photos** or if the visit is not In Progress. Flow A then completes the visit and closes the WO. |
| `PATCH /sf/draw/:id/decision` `{decision, checked[], missed[]}` | Salesforce | PM only. `Approved` only when every required deliverable is ticked; otherwise `Rejected` with missed items in the manifest. |
| `POST /photos/sign` `{workOrderId, drawId, count}` → signed PUT URLs | Photo upload | Phone uploads directly to object storage; API never proxies bytes. |
| `POST /vi/ask` `{workOrderId, lang, question, history}` | Vi | Claude API, `claude-sonnet-5`, streamed. |
| cron 10:00 AM ET, Mon–Fri | Cutoff notices | For every Vista draw not `Approved` at cutoff: one text per sub in their language listing what was missed (respects `ServiceAppointment.SMS_Opt_out__c`); one reminder per PM with unreviewed draws. See `docs/approval-flow.md`. |
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
SMS_PROVIDER_SID, SMS_PROVIDER_TOKEN, SMS_FROM
ALERT_PHONES                      # Matt, Mike
STORAGE_BUCKET, STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY, STORAGE_ENDPOINT
ANTHROPIC_API_KEY, VI_MODEL=claude-sonnet-5
APP_JWT_SECRET
```
