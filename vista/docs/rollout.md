# Vista rollout: on/off by location, opt-out by account

Everything that exists today keeps running: Jotform, the Jotform and Titan approval processes, and the ACH batch.
Vista switches on **location by location**. When a location is on, **every account there uses Vista except the accounts that opt out**.

## The switch

`config/rollout.json` (the Vista API reads it; the app uses `web/fixtures/rollout.json` in fixture mode):

```json
{
  "defaultMode": "off",
  "locations": {
    "Augusta": { "mode": "on", "pilotAccounts": [], "optOutAccounts": ["Hernández Siding"] }
  }
}
```

| Mode | Who uses Vista at that location |
|---|---|
| `off` (default) | Nobody. Jotform as today. |
| `pilot` | Only the accounts in `pilotAccounts`, for a first crew or two. |
| `on` | Everyone, **except** the accounts in `optOutAccounts`. |

- **Location** is the job's Office (`Job__c.Office__c`, a Location record), matched by Id or exact name.
- **Account** is the installer's or measure tech's Account (`ServiceResource.AccountId`), matched by Id or exact name. PMs see every Vista-active visit at their locations.
- Locations not listed use `defaultMode` (`off`).
- Changing the file needs no Salesforce deploy.

## What "on" and "off" mean in practice

| | Vista on for the crew | Vista off (or opted out) |
|---|---|---|
| Installer / measure tech | Sees dispatched visits, submits for pay in Vista | Sees "Vista isn't on for your crew yet. Keep using Jotform." |
| Pay | Vista pay request → PM checklist → Approved | Jotform → OA / Titan approval as today |
| Draws | PM issues in Vista; Mike Duncan emailed | As today |
| Salesforce | Vista records (`Type__c = Vista`) and the two Vista flows | Untouched |

**Switching a location or account off** stops new Vista activity only. Pay requests and draws already in Vista finish their normal path, so nobody is left unpaid mid-cycle.

## Why this is safe to deploy to production before anyone is switched on

| Piece | Effect when every location is `off` |
|---|---|
| `Vista` picklist value | Unused |
| *Vista - Pay Request Submitted* flow | Only fires on `Type__c = Vista` records, of which there are none |
| *Vista - Draw Issued Notice* flow | Same |
| List views | Empty |
| Titan entry criteria `Type ≠ Vista` | Excludes records that don't exist yet |

Both flows can be activated in production right away. Nothing changes for anyone until a location in `config/rollout.json` is set to `pilot` or `on` **and** the Vista API is live.

## One thing to settle before the first location goes on: Jotform

A crew on Vista must not also get the Jotform text, or one job could be paid twice (a Jotform SA Expense and a Vista pay request). We don't yet know what sends Jotform today (the `Send_Jotform_SMS__c` checkbox and `SMS_Sent_Date__c` on SA Expense suggest a flow or process on visit completion).

`salesforce/automation-check.sh` lists it. Once we see it, the fix is one extra condition on that automation. For example: "skip if this visit already has a `Type__c = Vista` SA Expense, or the visit's crew is on Vista."

## Production run order (from `vista/`, on your Mac)

```bash
# 1. Read-only: find what sends Jotform today (commit the output)
ORG=myorg bash salesforce/automation-check.sh

# 2. Picklist value: validate, then add
bash salesforce/add-vista-type.sh --prod
bash salesforce/add-vista-type.sh --prod --go

# 3. Flows (Draft) + list views: validate, then deploy
bash salesforce/deploy.sh --prod
bash salesforce/deploy.sh --prod --go
```

`--go` against production asks you to type the org alias before it deploys. Then in Setup: Titan entry criteria `Type not equal to Vista`, the *Vista - In review* WorkOrder list view, and activate both flows.
