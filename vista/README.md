# Vista — *Todo a la vista* / *See the whole job*

Phone-first PWA for Southern Industries installers and project managers. The assistant inside it is **Vi**.
Spanish and English at launch.

## Principles (non-negotiable)

1. **Five screens only:** Today · Job · Submit Draw · Approve (PMs) · Ask Vi.
2. **No new Salesforce objects or fields.** Job = `WorkOrder`, draw = `SA_Expense__c`, problem = `Case` (Service record type; `Work_Type__c`, `Service_Type__c`, `Warranty_Type__c` set at creation).
3. **Photos go to object storage.** A JSON manifest is written to an existing long-text field on `SA_Expense__c` (see `docs/data-contract.md`).
4. **No photos, no pay.** A PM can always approve from Salesforce with a reason.
5. **Field Service is the backbone.** Installers only see *Dispatched* ServiceAppointments (dispatch also fires the PulseM bio). Installers and measure techs mark their line items complete. Submitting a draw completes the visit; when every line item is done the WorkOrder moves to *Installation Completed* for review.
6. **PMs submit draws.** The installer's draw waits at *New*; the PM reviews it against a deliverables checklist and submits it. After that, Salesforce runs exactly as today (payable invoice, Angie's daily ACH run). Not submitted by 10:00 AM = not paid that day, and the sub gets a text listing what was missed. Details: `docs/approval-flow.md`.

## Layout

| Path | What |
|---|---|
| `web/` | Static PWA. No framework, no build step. Offline-first (IndexedDB + service worker + outbox). |
| `api/` | Serverless API contract: SMS code verification, Salesforce (JWT bearer, integration user), photo upload. Plus the 2-hour heartbeat. **Not wired yet (Step 2).** |
| `salesforce/` | The Vista picklist value, the *Vista - Draw Submitted* flow, list views, and sandbox-only deploy scripts. See `salesforce/README.md`. |
| `docs/` | `approval-flow.md` (draw approval + daily ACH run), `data-contract.md` (fields the five screens read/write), `describe.sh` (dumps `sf sobject describe` for the four objects), architecture notes. |
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
- **Mike · PM** — sees both crews and the Approve queue

Fixture data lives in `web/fixtures/*.json` and mirrors Salesforce API field names exactly, so swapping the fixture adapter for the Salesforce adapter (`web/src/data.js`) does not touch the screens.

## Status

- [x] Step 1 — repo, data contract, PWA shell, **Today** and **Job** screens on fixtures (EN + ES)
- [x] Step 1b — Field Service gating, approval-flow design, **Approve** screen (PM deliverables checklist) on fixtures
- [x] Step 1c — PM-submits flow, line-item completion, WO review; Salesforce automation as source in `salesforce/` (not deployed)
- [ ] Step 2 — Submit Draw (camera, manifest, `SA_Expense__c` write), problem sheet (`Case`); deploy `salesforce/` to DevSandi
- [ ] Step 3 — Ask Vi (Claude API), SMS login, cutoff notices, heartbeat
