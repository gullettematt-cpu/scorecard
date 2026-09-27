# Vista draw approval flow

Status: **design approved 2026-09-27; Salesforce automation drafted in `salesforce/`, not yet deployed.**
Built entirely in Field Service on existing objects and fields, plus one new picklist value (`Vista` on `SA_Expense__c.Type__c`, approved by Matt).

## Decisions (Matt, 2026-09-27)

| Topic | Decision |
|---|---|
| Who submits draws | **A PM.** The installer's draw waits at `New` until the PM reviews it in Vista and submits it. |
| Salesforce process after that | **Unchanged.** `Submitted` → existing approval → Angie links the payable invoice. Vista adds nothing after the PM submits. |
| Cutoff | **10:00 AM**, daily run. |
| Line items | The **installer** marks each line item `Installation Completed`; the **measure tech** marks `Measurement Completed`. |
| WorkOrder | Does **not** close itself. When the installer has completed every line item, it moves to `Installation Completed`, which is the review step. |
| `Vista` picklist value | Approved. |

## The flow

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Dispatched: Dispatcher dispatches visit<br/>(PulseM bio fires)
    Dispatched --> InProgress: Installer taps Start
    InProgress --> WithPM: Installer submits draw<br/>SA_Expense Status = New<br/>visit → Completed<br/>WO → Installation Completed if every line item is done
    WithPM --> Submitted: PM ticks every deliverable<br/>and submits (Status = Submitted)
    WithPM --> SentBack: PM marks items missing (stays New)
    SentBack --> WithPM: Installer adds missing items
    Submitted --> Paid: Existing process<br/>Angie links payable invoice
    WithPM --> Held: 10 AM cutoff, not submitted
    SentBack --> Held: 10 AM cutoff
    Held --> WithPM: next day's run
    Paid --> [*]
```

## Who does what

| Step | Who | Where | Salesforce effect |
|---|---|---|---|
| 1. Dispatch | Dispatcher | Field Service | `ServiceAppointment.Status = Dispatched`. Existing PulseM automation sends the bio. **Vista shows nothing that isn't Dispatched.** |
| 2. Start | Installer | Vista · Job | `ServiceAppointment.Status = In Progress`, `ActualStartTime` |
| 3. Line items | Installer / measure tech | Vista · Job | Each `WorkOrderLineItem.Status` → `Installation Completed` (installation visit) or `Measurement Completed` (measurement visit) |
| 4. Submit draw | Installer | Vista · Submit Draw | Creates `SA_Expense__c` with `Type__c = Vista`, **`Status__c = New`**. Flow A completes the visit and, if every line item is done, moves the WO to review. |
| 5. Review + submit | PM | Vista · Approve | Deliverables checklist. **Submit to accounting** → `Status__c = Submitted`, `Approver__c = PM`. **Send back** → stays `New`, missed items in the manifest. |
| 6. Pay | Existing approvers, Angie | Salesforce, as today | Existing approval, then Angie links `Payable_Invoice_New__c` in her daily run. |
| 7. Chase | Vista API | 10:00 AM daily | Texts every sub whose Vista draw is still `New` (sent back or not yet reviewed), in their language, listing what's missing. One reminder per PM with unreviewed draws. |

Because Vista draws enter the **same** path as every other draw once the PM submits them, there is one pay path and no double-pay risk. `Type__c = Vista` only identifies them for the PM queue, the 10 AM notices, and reporting.

## PM review: the deliverables checklist

"Submit to accounting" stays disabled until every required line is ticked. Unticked lines, with the PM's reason, become the message to the installer.

| Line | Source | Required |
|---|---|---|
| One line per required photo kind, e.g. *Before, each elevation: 2 (need 4)* | trade checklist `photos[]` vs manifest photos | when `min > 0`; lines below the minimum can't be ticked |
| Installer checklist, e.g. *10 of 10 steps* | manifest `checklist.done` | yes |
| Work description matches the scope | `Description_of_Work_Performed__c` vs WO | yes |
| Job complete as claimed | `Did_you_complete_the_job_or_service__c` | yes |
| Line items marked installed, e.g. *4 of 4* | `WorkOrderLineItem.Status` | when the installer claims the job is complete |
| Amount within contract | `Amount__c` ≤ `Sales_Price__c − Total_SA_Expense_Labor__c` | yes |
| Additional work documented | manifest note + photo | only if claimed |

A PM who submits a draw directly in Salesforce (without Vista) is simply using today's process; nothing blocks it.

## WorkOrder review

Flow A moves the WorkOrder to **`Installation Completed`** when, at draw submission:

- the installer answered *Is the job complete?* **Yes**, and
- every line item on the WorkOrder is `Installation Completed` or `Canceled`, and
- no other visit on the WorkOrder is still open.

`Installation Completed` is an existing status, so the existing milestone and time-stamp automation fires as it does today. The office or PM reviews from the list view **Vista · Work orders in review** and moves the WorkOrder on to `Completed` as they do now. If anything is short, the WO stays where it is and the dispatcher schedules the next visit as usual.

## Messages to subcontractors (10:00 AM)

Sent by the Vista API, not Salesforce. One text per sub per day, in the installer's language, respecting `ServiceAppointment.SMS_Opt_out__c`. Opted-out subs see the same message in the app.

> Vista: this draw was not submitted for today's pay run. Job 00041859 (Hall, 512 Lakeside Dr): Before, each elevation: 2 (need 4) — missing; House wrap and flashing: 0 (need 2) — missing. Add it in Vista and your PM will review it for the next run.

> Vista: este cobro no fue enviado para el pago de hoy. Trabajo 00041859 (Hall, 512 Lakeside Dr): Antes, cada fachada: 2 (mínimo 4) — falta; Membrana y sellado: 0 (mínimo 2) — falta. Agrégalo en Vista y tu PM lo revisará para el próximo pago.

Draws the PM simply hasn't opened yet produce "still with your PM, will be in the next run" for the sub and one reminder to the PM.

## Salesforce build (in `salesforce/`)

| Item | Type | Purpose |
|---|---|---|
| `Vista` value on `SA_Expense__c.Type__c` | picklist value | identifies app draws. Added by retrieve-then-append so nothing else on the field changes. |
| `Vista_Draw_Submitted` | record-triggered flow, after create, `SA_Expense__c` | completes the visit; moves the WO to `Installation Completed` when every line item is done |
| `Vista_Waiting_on_PM` | list view, `SA_Expense__c` | Vista draws at `New` |
| `Vista_Submitted_Today` | list view, `SA_Expense__c` | Vista draws submitted by PMs, not yet on a payable invoice |
| `Vista_WO_In_Review` | list view, `WorkOrder` | work orders at `Installation Completed` |

Deploy targets the **DevSandi** sandbox only; `salesforce/deploy.sh` refuses the production alias.

## Guardrails

- **Test records.** Heartbeat draws use `TEST_SA__c = true`; the PM queue, list views and notices all exclude them, and Flow A skips them.
- **Existing automation.** Before activating Flow A, run `salesforce/automation-check.sh` to list every active flow and approval process on the four objects, so nothing already reacting to `Status__c`, visit status, or WO status is double-triggered.
- **Audit.** Every PM decision is in the manifest (`approval.by`, `at`, `decision`, `checked[]`, `missed[]`) and in `Approver__c`.

## Still open

| # | Who | Question | Default |
|---|---|---|---|
| 1 | Matt | Is `Status__c = Submitted` set today by a Salesforce **approval process** ("Submit for Approval")? If so, Vista submits through that same process with the PM as the submitter, instead of writing the field. `automation-check.sh` answers this. | Write the field if no approval process exists. |
| 2 | Matt | Measure techs become Vista users (text-message sign-in, measurement visits only, no draws). OK? | Yes, measurement visits only. |
