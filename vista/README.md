# Vista — *Todo a la vista* / *See the whole job*

Phone-first PWA for Southern Industries installers and project managers. The assistant inside it is **Vi**.
Spanish and English at launch.

## Principles (non-negotiable)

1. **Five screens only:** Today · Job · Submit for Pay · Approve (PMs) · Ask Vi.
2. **No new Salesforce objects or fields.** Job = `WorkOrder`, pay request and draw = `SA_Expense__c`, problem = `Case` (Service record type; `Work_Type__c`, `Service_Type__c`, `Warranty_Type__c` set at creation).
3. **Photos go to object storage.** A JSON manifest is written to an existing long-text field on `SA_Expense__c` (see `docs/data-contract.md`).
4. **No photos, no pay.** A PM can always approve from Salesforce with a reason.
5. **Field Service is the backbone.** Installers only see *Dispatched* ServiceAppointments (dispatch also fires the PulseM bio). Installers and measure techs mark their line items complete. Submitting a draw completes the visit; when every line item is done the WorkOrder moves to *Installation Completed* for review.
6. **PMs submit everything to accounting.** The installer's pay request (at completion) waits at *New*; the PM reviews it against a deliverables checklist and submits it once, after an "Are you sure?" question. It lands in Salesforce as Approved and moves through as today (payable invoice, Angie's daily ACH run). Not submitted by 10:00 AM = not paid that day, and the sub gets a text listing what was missed. A **draw** is a payment before completion: the installer asks the PM directly and the PM issues it, on jobs the PM chooses. Mike Duncan is emailed about every draw. Details: `docs/approval-flow.md`.
7. **Roll out by location, opt out by account.** `config/rollout.json` turns Vista on per location (`off` / `pilot` / `on`); when on, every account there uses Vista except those that opt out. Jotform keeps running for everyone else. Details: `docs/rollout.md`.
8. **App, text, or both.** Everything works by text message too (English or Spanish), with the same rules. Each person replies `APP`, `TEXT` or `BOTH`. Details: `docs/sms.md`; try it at `/dev/sms.html`.
9. **English, Español, or both.** One language setting per person, shared by the app and texts, including a bilingual mode. Job text from Salesforce and what people type is translated, with the original one tap away. Anyone can request another language. Details: `docs/languages.md`.

## Layout

| Path | What |
|---|---|
| `web/` | Static PWA. No framework, no build step. Offline-first (IndexedDB + service worker + outbox). |
| `api/` | The Vista API on AWS Lambda: text-code sign-in, Salesforce (JWT bearer, integration user), photo upload, Vi, the text channel, the 10 AM cutoff and the 2-hour heartbeat. See `api/README.md`. |
| `template.yaml`, `deploy/` | The whole AWS stack (SAM) and the GitHub deploy role. Setup: `docs/deploy-aws.md`. |
| `salesforce/` | The Vista picklist value, the *Vista - Pay Request Submitted* flow, list views, and sandbox-only deploy scripts. See `salesforce/README.md`. |
| `config/` | `rollout.json`: the on/off switch by location and account. |
| `docs/` | `rollout.md` (switch and production run order), `approval-flow.md` (pay requests, draws, daily ACH run), `data-contract.md` (fields the five screens read/write), `describe.sh` (dumps `sf sobject describe` for the four objects), architecture notes. |
| `i18n/` | `en.json`, `es.json`. Every user-facing string lives here. |
| `scripts/` | `dev.js` (local static server), `build.sh` (assemble `dist/` for the CDN). |

## Run it (fixture mode)

```bash
cd vista
npm run dev          # http://localhost:4173
```

Pick a login on first load:

- **Crew 12 · Tucker** — Augusta installer, English, windows & doors
- **Cuadrilla 7 · Hernández** — Augusta installer, Spanish, siding
- **Measure · Ortega** — Augusta measure tech, Spanish, measurement visits only
- **Mike · PM** — sees all crews and the Approve queue

**By text:** open http://localhost:4173/dev/sms.html for two simulated phones. `npm run test:sms` runs the text conversations.

**Live mode (the real API code, pretend Salesforce and Twilio):**

```bash
npm install
npm run api:local                                   # terminal 1: API on :4174; sign-in codes print here
VISTA_API_URL=http://localhost:4174 npm run dev     # terminal 2: the app signs in by text code
```

Test numbers: 706-555-0112 (Tucker), 706-555-0107 (Luis), 706-555-0133 (Rafael), 706-555-0100 (Mike, PM). Photos taken in live mode upload to the local API's in-memory storage.

Tests: `npm run test:api` (API), `npm run test:sms` (texts), `npm run test:pay`, `npm run test:problem` and `npm run test:vi` (Submit for Pay, Report a problem and Ask Vi end to end in a browser; need `npm run dev` running and Playwright installed).

Fixture data lives in `web/fixtures/*.json` and mirrors Salesforce API field names exactly, so swapping the fixture adapter for the Salesforce adapter (`web/src/data.js`) does not touch the screens.

## Status

- [x] Step 1 — repo, data contract, PWA shell, **Today** and **Job** screens on fixtures (EN + ES)
- [x] Step 1b — Field Service gating, approval-flow design, **Approve** screen (PM deliverables checklist) on fixtures
- [x] Step 1c — PM-submits flow, line-item completion, WO review; Salesforce automation as source in `salesforce/` (not deployed)
- [x] Step 1d — pay request vs draw: PM-issued draws with progress-photo rule
- [x] Step 1e — rollout switch by location/account; production deploy path (`--prod`)
- [x] Step 1f — Vista by text: shared engine, two-phone simulator, conversation tests
- [x] Step 1g — language picker, bilingual mode, free-text translation, language requests
- [x] Step 1h — Vista API on AWS: SMS login, Salesforce reads/writes with server-side rules, texts, cutoff notices, heartbeat, Vi; app live mode; SAM template and GitHub deploy (`docs/deploy-aws.md`)
- [x] Step 2a — **Submit for Pay** in the app: camera per required shot (no photos, no pay), checklist and line items, amount within the contract, "Are you sure?"; works offline (photos wait on the phone, upload before the request syncs); send-back asks only for what the PM named; PM review shows the real photos
- [x] Step 2b — **Report a problem**: a Service `Case` on the job in the crew's own words, optional photos, work type defaulted from the trade, who pays and which warranty in plain language (exact Salesforce picklist values behind them), "work is stopped" = High priority; the job's PM gets a text; works offline
- [x] Step 2c — **Ask Vi**: a conversation about one job (or a general question) with suggested questions; Vi answers from the job record, line items, open problems, pay status and the trade checklist in the person's language, and offers a pre-filled problem report when something's wrong (never sends it). Conversations stay on the phone per job. Demo mode gives sample answers from the job data. All five screens are built.
- [x] Step 2d — **Program admin (payroll)**: a sign-in role with its own screens: **Pay run** (every request by stage, grouped by PM, with "Text the PM a reminder" and the 10 AM cutoff countdown), **People** (find, add, change, turn off), **Rollout** (off / pilot / on per location, companies), **Health** (the 2-hour check, language requests, who handles what). App actions now text whoever is next (PM on submit, crew on approve or send-back). PMs see the cutoff countdown on Approve. Playbook for Lisa, PMs and crews: `docs/program-playbook.md`.
- [ ] Step 3 — First AWS deploy (Donald), Twilio A2P registration, Augusta pilot
