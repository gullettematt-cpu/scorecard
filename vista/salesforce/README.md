# Vista · Salesforce automation

Everything Vista needs in Salesforce, as source. Nothing here creates objects or fields.
The design is in `../docs/approval-flow.md`.

| What | File |
|---|---|
| `Vista` picklist value on `SA_Expense__c.Type__c` | `add-vista-type.sh` (retrieves the field from the org, appends the value, deploys it back) |
| Flow **Vista - Pay Request Submitted** (after create on `SA_Expense__c`, `Type__c = Vista`, `Status__c = New`, job complete = `Yes`) | `force-app/main/default/flows/Vista_Pay_Request_Submitted.flow-meta.xml` |
| List view **Vista - Waiting on PM** | `force-app/.../SA_Expense__c/listViews/Vista_Waiting_on_PM.listView-meta.xml` |
| List view **Vista - Draws (paid before completion)** | `force-app/.../SA_Expense__c/listViews/Vista_Draws.listView-meta.xml` |
| List view **Vista - Submitted, not on a payable invoice** | `force-app/.../SA_Expense__c/listViews/Vista_Submitted_Not_Invoiced.listView-meta.xml` |
| Existing-automation report (read-only) | `automation-check.sh` → `../docs/describe/AUTOMATION.md` |
| Existing SA Expense approval process (read-only) | `retrieve-approval.sh` → `reference/approvalProcesses/` + `../docs/describe/APPROVAL.md` |

**Work order review list view.** Create it in Setup rather than from source (a one-minute step): Work Orders, *Vista - In review*, filter `Status equals Installation Completed`.

## Run order (from `vista/`)

```bash
# 1. Read-only: what automation already exists, and the approval process Vista submits through (production is fine here)
ORG=myorg bash salesforce/automation-check.sh
ORG=myorg bash salesforce/retrieve-approval.sh

# 2. Sandbox: add the picklist value (dry run, then real)
bash salesforce/add-vista-type.sh
bash salesforce/add-vista-type.sh --go

# 3. Sandbox: validate, then deploy the flow (Draft) and list views
bash salesforce/deploy.sh
bash salesforce/deploy.sh --go
```

Steps 2 and 3 default to the `DevSandi` alias and refuse any org that isn't a sandbox.
The flow deploys as **Draft**. Activate it in Setup after checking `AUTOMATION.md` for collisions.
