# Vista architecture

```
phone (PWA, offline-first)            AWS (template.yaml)                         systems of record
┌─────────────────────────┐  HTTPS   ┌───────────────────────────────┐        ┌────────────────────┐
│ Today · Job · Pay ·      │────────▶│ API Gateway → ApiFunction      │───────▶│ Salesforce (JWT,    │
│ Approve · Ask Vi         │         │   /auth /snapshot /sync        │        │  integration user)  │
│ IndexedDB: jobs, draws,  │  PUT    │   /photos/sign /vi /admin      │───────▶│ Claude API (Vi)     │
│ checklist, outbox        │───────▶ S3 photos (signed URLs)          │        │ Twilio (texts)      │
│ served by CloudFront     │         │ WorkerFunction                 │◀───────│  webhook /sms/inbound│
└─────────────────────────┘         │   texts · heartbeat · digests  │        └────────────────────┘
plain phone (texts) ──── Twilio ───▶│   cutoff · dispatch poll       │
                                     │ DynamoDB · SSM secrets         │
                                     └───────────────────────────────┘
```

## Web (`/web`)
- Plain HTML/CSS/ES modules. No framework, no bundler. Ships as-is to the CDN (`scripts/build.sh`).
- `src/data.js` is the only file that knows where data comes from. The `fixture` adapter serves demo data; the `api` adapter (on when `config.js` sets `apiUrl`) loads `GET /snapshot` and pushes the outbox to `POST /sync`. Both use the same shapes (Salesforce API names), so the screens don't know the difference.
- Live mode starts with sign-in: phone number, then the 6-digit code by text (`src/api.js`). The token and last snapshot stay on the phone, so a signed-in person can work offline.
- `src/db.js` wraps IndexedDB. Stores: `jobs`, `draws`, `checklist`, `outbox`, `meta`.
- Every write goes to the local store *and* the outbox. `src/sync.js` flushes the outbox when `navigator.onLine` flips true or on app focus. Conflicts: last-write-wins on the phone, Salesforce is truth after sync.
- `sw.js` caches the app shell, i18n, checklists and icons. Fixture/API responses are network-first with cache fallback.
- Language is per user (`vista.lang`), defaulting from the crew record, switchable from the Today header. Content (checklists) carries both languages; UI strings come from `/i18n/{lang}.json`.

## API (`/api`)
See `api/README.md` for routes, rules and jobs, and `docs/deploy-aws.md` for deploying.

## Vi
- Model: `claude-sonnet-5` via the Claude API.
- Context per question: the job record (WorkOrder + Job__c + line items + open Cases + draw statuses), the trade checklist, and the retrieved trade documents for that trade.
- System prompt pins: reply in the asker's language (`lang` from the request), never invent Salesforce values, offer to draft a problem report but never create one.

## Heartbeat
Every 2 hours: login → read a WorkOrder → create `SA_Expense__c` with `TEST_SA__c = true` → upload a photo → SMS Matt and Mike on failure. Details in `docs/data-contract.md` (Heartbeat section).
