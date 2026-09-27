# Vista data contract

**Rule:** no new Salesforce objects, no new fields. Everything below is read from or written to fields that already exist.
Vista never owns state: the phone holds a local copy and an outbox, Salesforce is the record.

## Verification status

Confirmed against `sf sobject describe` on org alias `myorg` (org `00D4P000001dcqBUAQ`) on 2026-09-27, including the Field Service objects.

**Vista is anchored on Field Service.** The installer's unit of work is a *Dispatched* `ServiceAppointment`; the pay approval flow (pay requests and draws) is in `docs/approval-flow.md`.
Raw summary: `docs/describe/SUMMARY.md`. Re-run `bash docs/describe.sh myorg` after any schema change.

| Tag | Meaning |
|---|---|
| ✅ | Confirmed by describe: exists, type and picklist values as listed. |
| 🟠 decide | Field exists; the *policy* (which value, who reads it) needs a yes from Matt, Mike or Angie before Step 2 wires it. |

Decisions still open are collected at the bottom under **Open decisions**.

---

## Object map

| Vista concept | Salesforce object | Link | Notes |
|---|---|---|---|
| Job | `WorkOrder` | `WorkOrder.Job_Number__c` → `Job__c` | Record types: **Installation** `0124P000000OMPGQA4` (default), **Service** `0124P0000003LvBQAU`, Admin, RCE Visit, Sales visit. Vista shows Installation and Service. |
| Sold job / contract | `Job__c` | | Contract amount, PM, office, trade. |
| Visit (the installer's unit of work) | `ServiceAppointment` ✅ | `Work_Order__c` → `WorkOrder`, `Job__c` → `Job__c` | Only `Status in (Dispatched, In Progress)` reaches the phone. Dispatch fires the PulseM bio (`PulseM_appt_trigger__c`, `PulseM_Bio_Sent__c`). |
| Crew assignment | `AssignedResource` ✅ → `ServiceResource` ✅ | `ServiceResource.AccountId` → installer Account | `AssignedResource.Lead_Installer__c` marks who submits the draw. |
| Pay request / draw | `SA_Expense__c` | `Work_Order__c`, `Job__c`, `Service_Appointment__c` | "SA" = Service Appointment. The Jotform flow (`Type__c = Jotform`, `Jotform_URL__c`, `Send_Jotform_SMS__c`) is what Vista replaces. |
| Problem | `Case` | `Case.Job__c` → `Job__c` (no WorkOrder lookup on Case) | Service record type **`0124P000000OMP8QAO`** (default). |
| Photos | Object storage | manifest in `SA_Expense__c.Additional_Work_Performed_Description__c` 🟠 | See *Photo manifest*. |
| Installer | `Account` (sub/installer account) | `ServiceResource.AccountId`, `SA_Expense__c.Account__c`, `Case.Original_Installer__c` | `SA_Expense__c.Installer_Name__c` is a formula off the account. Vista maps phone → ServiceResource → Account at SMS login. |
| PM | `User` | `Job__c.Production_Manager__c`, `SA_Expense__c.Production_Manager__c` | Approver. `Office_Administrator__c` on both objects is the OA. |

---

## Screen 1 · Today

Installer's **dispatched** visits for today and the rest of the week. One card per `ServiceAppointment`.

### Reads — `ServiceAppointment`

| Field | Tag | Used for |
|---|---|---|
| `Id`, `AppointmentNumber` | ✅ | key |
| `Status` | ✅ | `New` · `Ready to Schedule` · `Scheduled` · `Dispatched` · `In Progress` · `Completed` · `Canceled` · `On Hold`. **Filter: `Dispatched`, `In Progress`, and today's `Completed`.** |
| `SchedStartTime`, `SchedEndTime`, `ArrivalWindowStartTime`, `ArrivalWindowEndTime` | ✅ | time window; today filter |
| `Work_Order__c`, `Job__c` | ✅ | the WorkOrder and Job |
| `SS_Service_Appointment_Type__c` | ✅ | `Installation` (Vista v1 shows installation and service visits only) |
| `Notes_to_Installer__c`, `Description` | ✅ | dispatcher's notes on the Job screen |
| `SMS_Opt_out__c` | ✅ | whether the daily "what was missed" text may be sent |
| `PulseM_Bio_Sent__c` | ✅ | shown to the PM; not a gate (dispatch is the gate) |
| `Test_SA__c` | ✅ | excluded |
| `AssignedResource.ServiceResourceId`, `.Lead_Installer__c` | ✅ | which crew; who submits |

### Reads — `WorkOrder`

| Field | Tag | Used for |
|---|---|---|
| `Id`, `WorkOrderNumber` | ✅ | key, label |
| `RecordTypeId` | ✅ | Installation vs Service badge |
| `Subject` | ✅ | card title |
| `Status` | ✅ | chip. Values: `New` · `On Hold` · `Set To Measure` · `Measurement Completed` · `Permits and Materials in Progress` · `Ready to Order` · `Ordered` · `Ready to Schedule Installation` · `Installation Scheduled` · `Installation Completed` · `Completed` · `Canceled`. **There is no "In Progress".** Installers only ever see `Installation Scheduled` → `Installation Completed`. |
| `Priority` | ✅ | `Low` · `Medium` · `High` · `Critical` |
| `StartDate`, `EndDate` | ✅ | fallback window when no ServiceAppointment |
| `Street`, `City`, `State`, `PostalCode`, `Latitude`, `Longitude` | ✅ | address + Navigate |
| `AccountId` → `Account.Name` | ✅ | homeowner |
| `ContactId` → `Contact.Phone`, `Contact.MobilePhone`; `Contact_Phone_Numbers__c` (formula) | ✅ | Call button |
| `WorkTypeId` → `WorkType.Name`; `Work_Type_Name__c`, `Product_Family__c` (formulas) | ✅ | trade chip → picks the checklist |
| `Job_Number__c` → `Job__c` | ✅ | sold job |
| `Test_WO__c` | ✅ | hidden from installers; heartbeat may read one |
| `LastModifiedDate` | ✅ | delta sync |

### Reads — `SA_Expense__c` (pay chip per job)

| Field | Tag | Used for |
|---|---|---|
| `Id`, `Name` | ✅ | key |
| `Work_Order__c` | ✅ | filter pay requests and draws for a job |
| `Status__c` | ✅ | `New` · `Submitted` · `Auto-Approved` · `Approved` · `Rejected`. **No "Paid" value.** |
| `Paycheck_Period__c`, `Payable_Invoice_New__c`, `Closed_by_Accounting_New__c` | 🟠 decide | *Paid* is derived: `Paycheck_Period__c` set (employee via Paycom) or `Payable_Invoice_New__c` set (sub via AP) ⇒ show "Paid". Angie confirms which. |
| `Amount__c`, `Date__c`, `CreatedDate` | ✅ | amount, ordering |
| `TEST_SA__c` | ✅ | always excluded from installer views |

### Writes
None.

---

## Screen 2 · Job

### Reads — `WorkOrder` (Today's fields plus)

| Field | Tag | Used for |
|---|---|---|
| `Description` (32000) | ✅ | scope of work, access notes |
| `CaseId` | ✅ | service WOs: the originating Case |
| `ParentWorkOrderId`, `Parent_WO__c` | ✅ | multi-visit jobs |
| `WorkOrderLineItems` (`LineItemNumber`, `Description`, `Quantity`, `Status`) | ✅ | line items. `Status` values: `To Be Measured` · `On Hold (Measure)` · `Set to Measure` · `Measurement in Progress` · `Measurement Completed` · `Not Ready to Schedule` · `Ready to Order` · `Ordered` · `On Hold (Install)` · `Ready to Schedule` · `Installation Scheduled` · `Installation in Progress` · `Installation Completed` · `Canceled` |
| `Additional_Work_Performed__c`, `Additional_Work_Performed_Reason__c` | ✅ | shown if the office already flagged extra work |
| `ServiceTerritoryId` | ✅ | branch filter (Augusta) |

### Reads — `Job__c`

| Field | Tag | Used for |
|---|---|---|
| `Id`, `Name`, `Job_Number__c` (formula) | ✅ | job number |
| `Sales_Price__c` | ✅ | contract amount; `Sale_Amount__c` is the formula twin |
| `Total_SA_Expense_Labor__c` | ✅ | labor already paid or submitted (incl. draws) → "remaining" |
| `Production_Manager__c` → `User.Name`, `.MobilePhone` | ✅ | PM name + call link, Vi escalation |
| `Office_Administrator__c` | ✅ | OA |
| `Office__c` → `Location` | ✅ | branch |
| `Product_type__c`, `Job_Type__c` (formulas) | ✅ | trade fallback |
| `Status__c`, `Hold_Reason__c` | ✅ | job-level status/hold banner |
| `Primary_Contact__c`, `Account__c` | ✅ | homeowner fallback |
| `Service_Tech_Notes__c` (100000), `Kitchen_Call_Comments__c` | ✅ read-only | Vi context only, never shown raw |

### Reads — `Case` (open problems on this job)

| Field | Tag | Used for |
|---|---|---|
| `Id`, `CaseNumber`, `Subject`, `Status`, `CreatedDate`, `Work_Type__c`, `Service_Type__c`, `Warranty_Type__c` | ✅ | problem list, `WHERE Job__c = :jobId AND IsClosed = false` |

### Writes — `ServiceAppointment`

| Field | Tag | When |
|---|---|---|
| `Status` = `In Progress`, `ActualStartTime` | ✅ | installer taps **Start job** |

### Writes — `WorkOrderLineItem`

| Field | Tag | When |
|---|---|---|
| `Status` = `Installation Completed` | ✅ | installer ticks the line item during an installation visit |
| `Status` = `Measurement Completed` | ✅ | measure tech ticks the line item during a measurement visit (`SS_Service_Appointment_Type__c = Measurement`) |

**Measure techs** see only measurement visits, and finish them themselves: `ServiceAppointment.Status = Completed`, `ActualEndTime`, once every line item is `Measurement Completed`. They never see pay.

The phone never writes `WorkOrder.Status`. Flow `Vista_Pay_Request_Submitted` moves the WorkOrder to `Installation Completed` (the review step) when every line item is done (`docs/approval-flow.md`).

### Writes — `Case` (*Report a problem* sheet)

| Field | Tag | Value |
|---|---|---|
| `RecordTypeId` | ✅ | `0124P000000OMP8QAO` (Service) |
| `Job__c` | ✅ | `WorkOrder.Job_Number__c` |
| `Service_Appointment__c` | ✅ | the visit, when known |
| `AccountId`, `ContactId` | ✅ | copied from the WorkOrder |
| `Subject` | ✅ | `[Vista] ` + installer's one line |
| `Description` | ✅ | free text in the asker's language + footer `WO {number} · {installer} · {lat,lng}` |
| `Service_Issue__c` | 🟠 decide | same text as Description if dispatch reads this field rather than Description |
| `Work_Type__c` | ✅ required by policy | `Baths` · `Cover` · `Door` · `Gutters` · `Insulation` · `Rainsoft` · `Roofing` · `Siding` · `Window` · `Cabinet` — defaulted from the trade, installer confirms |
| `Service_Type__c` | ✅ required by policy | `Paid Service` · `Warranty` |
| `Warranty_Type__c` | ✅ required by policy | `Installer Warranty` · `Company Warranty` · `Sales/Service` · `Customer Accommodation` |
| `Origin` | 🟠 decide | no "Vista" value; use `In-Person` (installer on site) unless Mike prefers `Web` |
| `Language` | ✅ | `en_US` / `es_MX` from the asker |
| `Original_Installer__c` | ✅ | installer's Account |
| `Priority` | ✅ | `Medium`; `High` if the installer flags "can't continue" |
| `Status` | ✅ | `New` |
| `Test_record__c` | ✅ | `false` (heartbeat never creates Cases) |

---

## Screen 3 · Submit for Pay

The installer's pay request at completion. **Draws** (payment before completion) are issued by the PM from the Job screen; see *Draws* below.

### Writes — `SA_Expense__c` (create)

| Field | Tag | Value |
|---|---|---|
| `Amount__c` | ✅ required | installer-entered; capped at `Sales_Price__c − Total_SA_Expense_Labor__c` when known |
| `Date__c` | ✅ required | today (installer's local date) |
| `Expense_Type__c` | ✅ | `Labour` |
| `Type__c` | 🟠 new value | **`Vista`**, a new picklist value on the existing field. It routes the record into the Vista pay approval flow and keeps it out of the Jotform batch. |
| `Status__c` | ✅ | **`New`**. The pay request waits for the PM; only the PM moves it to `Submitted`. |
| `Service_Appointment__c` | ✅ required by Vista | the In Progress visit. Flow `Vista_Pay_Request_Submitted` completes it. |
| `Work_Order__c`, `Job__c` | ✅ | from the ServiceAppointment |
| `Account__c` | ✅ | installer's Account (drives `Installer_Name__c`, Paycom/AP fields) |
| `Production_Manager__c` | ✅ | copied from `Job__c.Production_Manager__c` |
| `Work_Performed_Date__c` | ✅ | today |
| `Did_you_complete_the_job_or_service__c` | ✅ | `Yes` / `No` from the installer. `Yes` + every line item done moves the WorkOrder to `Installation Completed` for review. |
| `Description_of_Work_Performed__c` (32768) | ✅ | **human-readable** work summary typed by the installer (Vi can draft it). Stays readable for PMs and accounting. |
| `Additional_Work_Performed__c` | ✅ | `Yes` / `No` |
| `Additional_Work_Performed_Description__c` (32768) | 🟠 **manifest** | the JSON photo manifest (below). Any additional-work text the installer types is stored *inside* the manifest and prefixed as a plain sentence, so a human opening the field still sees the note first. |
| `TEST_SA__c` | ✅ | `false`; `true` only for heartbeat records |

### 📸 The photo manifest field

`SA_Expense__c` has exactly two long-text fields: `Description_of_Work_Performed__c` and `Additional_Work_Performed_Description__c` (both 32768, createable + updateable). Everything else is ≤255 chars.

**Choice: `Additional_Work_Performed_Description__c`.** Reasoning: `Description_of_Work_Performed__c` is what PMs and accounting read, so it stays prose. The additional-work field is free text nobody keys automation on, and its meaning ("more detail about this expense") still fits.

```
MANIFEST_FIELD = SA_Expense__c.Additional_Work_Performed_Description__c
```

The API writes the field as: optional one-line human note, blank line, then `<!--vista-manifest-->` and the JSON. Readers split on the marker.

Manifest v1 (~200 bytes per photo, so 32k holds 100+ photos):

```json
{
  "v": 1, "app": "vista",
  "submitted_at": "2026-09-27T14:03:11Z",
  "submitted_by": { "phone": "+17065550112", "name": "Dwayne Tucker", "account": "001…", "resource": "0Hn…" },
  "work_order": "0WO…", "service_appointment": "08p…", "job": "a0J…",
  "lang": "en",
  "started_at": "2026-09-27T12:58:40Z",
  "location": { "lat": 33.4712, "lng": -82.0019, "accuracy_m": 12 },
  "checklist": { "id": "windows-v1", "done": ["walk", "protect", "before-photos"] },
  "additional_work": { "performed": false, "note": "" },
  "photos": [
    { "key": "vista/0WO…/a0X…/20260927-140211-1.jpg", "kind": "before", "taken_at": "…", "bytes": 812331, "sha256": "…" }
  ],
  "approval": null
}
```

**No photos, no pay:** the API refuses to create the `SA_Expense__c` unless `photos` meets the trade minimum in `web/content/checklists/<trade>.json`. A PM can still approve from Salesforce with a reason; the Approve screen writes that reason into `approval.reason` in the manifest and into `Approver__c`.

---

### Draws — `SA_Expense__c` (create, PM only, from the Job screen)

Payment before completion. The installer asks the PM directly; the PM issues it in Vista.

| Field | Tag | Value |
|---|---|---|
| `Type__c` | 🟠 new value | `Vista` |
| `Status__c` | ✅ | **`Approved`** at creation, after the PM confirms "Are you sure you want to submit this draw?". No approval process. Skips the PM queue and the pay-request flow. |
| `Did_you_complete_the_job_or_service__c` | ✅ | **`No`** — this is what marks a draw |
| `Amount__c`, `Date__c`, `Expense_Type__c` | ✅ | PM-entered amount (≤ contract − labor paid), today, `Labour` |
| `Work_Order__c`, `Job__c`, `Service_Appointment__c`, `Account__c`, `Production_Manager__c` | ✅ | from the visit and job |
| `Description_of_Work_Performed__c` | ✅ | what the draw covers |
| `Approver__c` | ✅ | the PM's name |
| `Additional_Work_Performed_Description__c` | ✅ manifest | `{ kind: "draw", issued_by, requested_by, issued_at, photos: [progress…] }` |

## Screen 4 · Approve (PMs)

The PM reviews a **deliverables checklist** built from the trade requirements (see `docs/approval-flow.md`).

### Reads
`SA_Expense__c` where `Type__c = 'Vista' AND Status__c = 'New' AND TEST_SA__c = false AND Production_Manager__c = :me` (minus pay requests the PM sent back that the installer hasn't resubmitted), with the job fields above, the manifest, and signed photo URLs.

### Writes — `SA_Expense__c` (update)

| Field | Tag | Value |
|---|---|---|
| `Status__c` | ✅ | **`Approved`** when the PM submits (every required line ticked) and confirms "Are you sure you want to submit this pay request?". This is the only approval; the record never enters an approval process. Send back leaves it at `New`. |
| `Approver__c` | ✅ | the PM's name (same format as Titan's `Approver` field update) |
| `Additional_Work_Performed_Description__c` | ✅ | manifest rewritten with `approval: { by, at, decision, checked[], missed: [{ item, reason }] }` |

---

## Screen 5 · Ask Vi

### Reads (assembled server-side as Claude context, never the whole org)
`WorkOrder` (+ line items), `Job__c` (incl. `Service_Tech_Notes__c`, `Kitchen_Call_Comments__c`, `Hold_Reason__c`), open `Case`s on the job, this job's `SA_Expense__c` rows (status + amount only), the trade checklist, and retrieved trade documents.

### Writes
None. Vi drafts `Description_of_Work_Performed__c` text and problem reports; the installer confirms them on the Job screen.

---

## Heartbeat (every 2 h)

| Step | Object | Detail |
|---|---|---|
| Login | — | JWT bearer as the integration user |
| Read | `WorkOrder` | `SELECT Id, WorkOrderNumber, Status FROM WorkOrder WHERE Test_WO__c = true ORDER BY LastModifiedDate DESC LIMIT 1` (falls back to any WO) |
| Write | `SA_Expense__c` | create `{ Amount__c: 0.01, Date__c: today, Expense_Type__c: 'Labour', Type__c: 'Vista', Status__c: 'New', TEST_SA__c: true, Work_Order__c: <test WO>, Additional_Work_Performed_Description__c: '{"v":1,"app":"vista-heartbeat"}' }`; deleted on the next successful run |
| Upload | object storage | 1 KB PNG to `vista/heartbeat/{ts}.png`, then HEAD |
| Alert | SMS | Matt and Mike on any failed step, once per incident |

`Status__c = 'New'` on heartbeat rows keeps them out of every Submitted/Approved list even if a filter forgets `TEST_SA__c`.

---

## Field-level security for the integration user

Read on every field above. Edit only on:
`ServiceAppointment.Status`, `ServiceAppointment.ActualStartTime`; `WorkOrderLineItem.Status`; `Case` create fields listed; `SA_Expense__c`: `Amount__c`, `Date__c`, `Expense_Type__c`, `Type__c`, `Status__c` (`New` on create; `Approved` on PM submit), `Work_Order__c`, `Job__c`, `Service_Appointment__c`, `Account__c`, `Production_Manager__c`, `Work_Performed_Date__c`, `Did_you_complete_the_job_or_service__c`, `Description_of_Work_Performed__c`, `Additional_Work_Performed__c`, `Additional_Work_Performed_Description__c`, `Approver__c`, `TEST_SA__c`.
API-only profile, IP-restricted to the serverless egress range, no UI login.

---

## Open decisions

The approval-flow questions (double-pay filter, cutoff, how paid is marked, WO close status, the `Vista` picklist value) are in `docs/approval-flow.md`. Still open here:

| # | Who | Question | Default if no answer |
|---|---|---|---|
| 1 | Mike | Case `Origin`: `In-Person` or `Web`? Does dispatch read `Description` or `Service_Issue__c`? | `In-Person`; write both fields. |
| 2 | Matt | Manifest in `Additional_Work_Performed_Description__c` (recommended) or `Description_of_Work_Performed__c`? | Recommended. |
