# Vista data contract

**Rule:** no new Salesforce objects, no new fields. Everything below is read from or written to fields that already exist.
Vista never owns state: the phone holds a local copy and an outbox, Salesforce is the record.

## Verification status

`sf sobject describe` against `myorg` **has not been run yet** — the build container that produced this
document has no Salesforce CLI or org credentials. Run it from a machine that does:

```bash
cd ~/code/vista && bash docs/describe.sh myorg      # writes docs/describe/SUMMARY.md
```

Until then, each row carries a verification tag:

| Tag | Meaning |
|---|---|
| ✅ standard | Standard Salesforce field. Exists on every org; API name is certain. |
| 🟡 named | Named by Matt in the brief. Exists; type/picklist values still to confirm from describe. |
| 🔴 assumed | Custom field we *expect* exists. **Confirm the API name from `SUMMARY.md` before wiring.** |

Anything 🔴 that does not exist gets replaced with whatever the org actually has. If nothing fits, we
store that value inside the photo manifest JSON instead of asking for a new field.

---

## Object map

| Vista concept | Salesforce object | Notes |
|---|---|---|
| Job | `WorkOrder` | Optionally linked to `Job__c` (the sold job / contract) via a lookup. |
| Draw | `SA_Expense__c` | One record per draw request. Angie's ACH batch reads these; we do not change what it reads. |
| Problem | `Case` | Service record type. `Work_Type__c`, `Service_Type__c`, `Warranty_Type__c` set at creation. |
| Photos | Object storage | Key = `vista/{WorkOrderId}/{SA_ExpenseId}/{yyyyMMdd-HHmmss}-{n}.jpg`. Manifest JSON in a long-text field on `SA_Expense__c`. |
| Installer / PM | `User` (integration user acts) | Vista signs in by SMS code; the API maps phone → installer identity. All writes are made by the integration user; the human's identity is recorded inside the manifest and, where a field exists, on the record. |

---

## Screen 1 · Today

Installer's jobs for today (and the rest of the week), one card per `WorkOrder`.

### Reads — `WorkOrder`

| Field | Tag | Used for |
|---|---|---|
| `Id` | ✅ | key |
| `WorkOrderNumber` | ✅ | card label |
| `Subject` | ✅ | card title (falls back to homeowner + trade) |
| `Status` | ✅ | status chip (`New`, `In Progress`, `On Hold`, `Completed`, `Cannot Complete`, `Closed`, `Canceled`) |
| `Priority` | ✅ | ordering tiebreak |
| `StartDate`, `EndDate` | ✅ | "today" filter and time window |
| `Street`, `City`, `State`, `PostalCode` | ✅ | address line + Navigate button |
| `Latitude`, `Longitude` | ✅ | Navigate button when present |
| `AccountId`, `Account.Name` | ✅ | homeowner name |
| `ContactId`, `Contact.Phone`, `Contact.MobilePhone` | ✅ | Call button |
| `WorkTypeId`, `WorkType.Name` | ✅ | trade chip (windows / siding / gutters / bath / roofing) |
| `OwnerId` | ✅ | crew/PM ownership |
| `LastModifiedDate` | ✅ | delta sync |
| `Job__c` (lookup to `Job__c`) | 🔴 | link to sold job. Confirm name; alternates seen in similar orgs: `Job_Number__c`, `Sold_Job__c`. |
| crew assignment | 🔴 | How a WorkOrder is assigned to a crew. Candidates: `ServiceAppointment.AssignedResource` (standard FSL), or a custom `Crew__c` / `Installer__c` lookup. **Describe decides.** |

### Reads — `SA_Expense__c` (draw status badge per job)

| Field | Tag | Used for |
|---|---|---|
| `Id`, `Name` | ✅ | key/label |
| link to job | 🔴 | `Work_Order__c` or `Job__c` lookup. Whichever exists is how we filter draws for a job. |
| status | 🔴 | e.g. `Status__c` (`Submitted` / `Approved` / `Paid` / `Rejected`). If the org tracks status via a checkbox pair (`Approved__c`, `Paid__c`) we derive the chip. |
| amount | 🔴 | `Amount__c` |
| `CreatedDate`, `LastModifiedDate` | ✅ | ordering, delta sync |

### Writes

None. Today is read-only.

---

## Screen 2 · Job

Everything the installer needs on-site: scope, contacts, trade checklist, photo requirements, draws, problems.

### Reads — `WorkOrder` (all of Today's fields, plus)

| Field | Tag | Used for |
|---|---|---|
| `Description` | ✅ | scope of work |
| `CaseId` | ✅ | if the WO was spawned by a service Case |
| `ParentWorkOrderId` | ✅ | multi-visit jobs |
| `WorkOrderLineItems` (`Id`, `LineItemNumber`, `Description`, `Quantity`, `UnitPrice`, `Status`) | ✅ | line items ("8 double-hung, 1 picture") |
| `ServiceTerritoryId` | ✅ | future: filter Augusta vs other branches |

### Reads — `Job__c`

| Field | Tag | Used for |
|---|---|---|
| `Id`, `Name` | ✅ | job number |
| contract amount | 🔴 | e.g. `Contract_Amount__c`, `Sale_Amount__c` — shows total against which draws are requested |
| project manager | 🔴 | e.g. `Project_Manager__c` (lookup User) — who approves, who Vi escalates to |
| trade / product | 🔴 | e.g. `Product_Type__c` / `Trade__c` — picks the trade checklist if `WorkType` is empty |
| `Account__c` | 🔴 | homeowner account if not on the WO |

### Reads — `Case` (open problems on this job)

| Field | Tag | Used for |
|---|---|---|
| `Id`, `CaseNumber`, `Subject`, `Status`, `CreatedDate` | ✅ | problem list |
| link to job | 🔴 | `WorkOrder__c` / `Job__c` lookup on Case, or the WO's own `CaseId`. Describe decides. |

### Writes — `WorkOrder`

| Field | Tag | When |
|---|---|---|
| `Status` | ✅ | installer taps *Start job* → `In Progress`; *Finish* → `Completed`. Only these two transitions from the phone. |

### Writes — `Case` (the *Report a problem* sheet on the Job screen)

| Field | Tag | Value |
|---|---|---|
| `RecordTypeId` | ✅ | Service record type id (from describe `recordTypeInfos`) |
| `Subject` | ✅ | installer's one-line summary |
| `Description` | ✅ | free text (asker's language) + `[Vista] WO {number} · {installer} · {lat,long}` footer |
| `Origin` | ✅ | `Vista` if the picklist value exists, else `Phone` |
| `Status` | ✅ | default `New` |
| `AccountId`, `ContactId` | ✅ | copied from the WorkOrder |
| `Work_Type__c` | 🟡 | required at creation. Picklist values from describe. |
| `Service_Type__c` | 🟡 | required at creation. Picklist values from describe. |
| `Warranty_Type__c` | 🟡 | required at creation. Picklist values from describe. |
| link to job | 🔴 | same lookup as the read above |

---

## Screen 3 · Submit Draw

### Writes — `SA_Expense__c` (create)

| Field | Tag | Value |
|---|---|---|
| link to job | 🔴 | the `WorkOrder` (or `Job__c`) the draw belongs to |
| amount | 🔴 | `Amount__c` — installer-entered, validated against remaining contract amount when known |
| status | 🔴 | initial `Submitted` (or whatever value the ACH batch ignores until approved) |
| installer | 🔴 | `Installer__c` / `Crew__c` lookup if present; always also in the manifest |
| `TEST_SA__c` | 🟡 | `false` for real draws, `true` for heartbeat records. **The ACH batch and PM views must already exclude `TEST_SA__c = true`; confirm with Angie before the first heartbeat runs against prod.** |
| **photo manifest** | 🔴 **BLOCKING** | See below. |

### 📸 The photo manifest field

Photos are uploaded to object storage; Salesforce holds only a JSON manifest. The manifest goes in an
**existing long-text field on `SA_Expense__c`**. `describe.sh` prints every `textarea` field longer than
255 chars under *Long-text fields (manifest candidates)*. Pick one that:

1. is `createable` and `updateable` by the integration user,
2. is **not** read by Angie's ACH batch, any flow, or any report PMs rely on,
3. has length ≥ 32,768 (standard long text area is 32k or 131k; 20 photos ≈ 4 KB, so 32k is plenty).

Record the choice here once confirmed:

```
MANIFEST_FIELD = SA_Expense__c.<________>      # e.g. Notes__c / Description__c / Comments__c
```

Manifest shape (v1). Anything we cannot put in a real field lives here:

```json
{
  "v": 1,
  "app": "vista",
  "submitted_at": "2026-09-26T14:03:11Z",
  "submitted_by": { "phone": "+17065550123", "name": "Dwayne Tucker", "crew": "Crew 12" },
  "work_order": "0WO...",
  "lang": "en",
  "location": { "lat": 33.4735, "lng": -82.0105, "accuracy_m": 12 },
  "checklist": { "windows-v1": ["prep-drop-cloths", "remove-old-units", "..."] },
  "photos": [
    { "key": "vista/0WO.../a0X.../20260926-140211-1.jpg", "kind": "before", "taken_at": "...", "bytes": 812331, "sha256": "..." },
    { "key": "vista/0WO.../a0X.../20260926-140211-2.jpg", "kind": "after",  "taken_at": "...", "bytes": 790112, "sha256": "..." }
  ],
  "approval": null
}
```

**No photos, no pay:** the API refuses to create the `SA_Expense__c` unless `photos` meets the trade's minimum
(`web/content/checklists/<trade>.json → photos[].min`). A PM can still approve from Salesforce with a reason; the
Approve screen writes that reason into `approval.reason` in the manifest and to a real field if one exists (🔴 `Approval_Notes__c`).

---

## Screen 4 · Approve (PMs)

### Reads
`SA_Expense__c` where status = Submitted, with the job (`WorkOrder`) fields above, the manifest, and signed photo URLs from object storage.

### Writes — `SA_Expense__c` (update)

| Field | Tag | Value |
|---|---|---|
| status | 🔴 | `Approved` / `Rejected` — **must be the exact value Angie's batch already keys on.** |
| approver / approved date | 🔴 | `Approved_By__c`, `Approved_Date__c` if present; always in `manifest.approval` |
| approval reason | 🔴 | required when approving without photos; `Approval_Notes__c` if present, always in manifest |
| manifest field | 🔴 | re-written with `approval` filled in |

---

## Screen 5 · Ask Vi

### Reads (assembled server-side as Claude context)
- The `WorkOrder` + `Job__c` + line items above (never the whole org),
- open `Case`s on the job,
- `SA_Expense__c` draws on the job (status + amount only),
- the trade checklist (`web/content/checklists/<trade>.json`),
- trade documents (install guides, warranty terms) from object storage, indexed per trade.

### Writes
None to Salesforce. Vi can *draft* a problem report, but creating the `Case` goes through the Job screen's sheet so the installer confirms the three picklists.

---

## Heartbeat (every 2 h)

| Step | Object | Fields |
|---|---|---|
| Login | — | JWT bearer as the integration user |
| Read | `WorkOrder` | `SELECT Id, WorkOrderNumber, Status FROM WorkOrder ORDER BY LastModifiedDate DESC LIMIT 1` |
| Write | `SA_Expense__c` | create with `TEST_SA__c = true`, amount `0.01`, manifest `{"v":1,"app":"vista-heartbeat"}` in the manifest field; deleted after the next successful heartbeat |
| Upload | object storage | 1 KB PNG to `vista/heartbeat/{ts}.png`, then HEAD it |
| Alert | SMS | Matt and Mike on any failed step, once per incident, with the step name |

---

## Field-level security checklist for the integration user

Grant read on every field above and edit on:
`WorkOrder.Status`, all `Case` fields listed under *Writes*, all `SA_Expense__c` fields listed under *Writes* including the manifest field and `TEST_SA__c`.
Nothing else. The integration user is company-owned, API-only, IP-restricted to the serverless egress range.
