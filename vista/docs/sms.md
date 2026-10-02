# Vista by text

Everything in Vista also works by text message, in English or Spanish. Each person picks how they hear from us:

| Reply | Channel |
|---|---|
| `APP` | App only |
| `TEXT` / `TEXTO` | Text only |
| `BOTH` / `AMBOS` (default) | App and texts |

The text channel follows exactly the same rules as the app: only **dispatched** visits, the **rollout** switch, **no photos, no pay**, the **PM deliverables checklist**, and **"Are you sure?"** before any money moves. The same engine (`web/src/sms/engine.js`) will run in the Vista API. Try it locally at `/dev/sms.html` (two phones side by side). Example conversations: `docs/sms-examples.md`. Languages, bilingual mode and translation: `docs/languages.md`.

## Commands

Commands are forgiving: upper or lower case, accents optional, English or Spanish words both work.

### Installers

| Text | Does |
|---|---|
| `TODAY` / `HOY` | Numbered list of your dispatched visits |
| `1` | Details for job 1: address, map link, homeowner phone, scope, line items, PM |
| `START 1` / `EMPEZAR 1` | Visit → In Progress |
| `DONE 1 ALL` / `LISTO 1 TODAS`, or `DONE 1 1 2` | Line items → Installation Completed |
| `PAY 1` / `COBRAR 1` | Guided pay request: amount → photos by kind (send them as picture messages) → checklist → line items → description → summary → `SEND` / `ENVIAR` |
| `PAY 41880` after a send-back | Asks only for what the PM marked missing, then resends the same request |
| `DRAW` / `ADELANTO` | Replies with your PM's name and number (draws are asked for directly) |

Jobs can be referenced by list number or by the last digits of the WO number.

### Measure techs

`TODAY`, `1`, `START 1`, `DONE 1 ALL` (→ Measurement Completed), `FINISH 1` / `TERMINAR 1` (only once every line item is measured). No pay.

### PMs

| Text | Does |
|---|---|
| `TODAY` / `REVIEW` / `REVISAR` | Pay requests waiting for review |
| `REVIEW 2` | The deliverables checklist (✔ / ✖ per line), the work description, and a link to the photos |
| `APPROVE 2` / `APROBAR 2` | Blocked if any line is short. Otherwise: "Are you sure you want to submit this pay request? … Reply YES to confirm all 8 deliverables and submit." `YES` → Approved; `NO` cancels. |
| `FIX 2 1 3 BLURRY` / `DEVOLVER 2 1 3 BORROSA` | Sends back lines 1 and 3 (short lines are always included). Reason words: `BLURRY`, `WRONG`, `INCOMPLETE` (default: missing). The installer gets a text in their language immediately. |
| `DRAW 41859 3000 front elevations` / `ADELANTO …` | Checks eligibility and progress photos, then "Are you sure you want to submit this draw?" `YES` → created Approved; Mike Duncan is emailed by Salesforce as usual. |

### Everyone

| Text | Does |
|---|---|
| `HELP` / `AYUDA` | The commands for your role |
| `ENGLISH` / `ESPAÑOL` / `BILINGUAL` | Switch language (shared with the app; bilingual sends every line in both) |
| `LANGUAGE Português` / `IDIOMA …` | Request another language; Vi answers in it meanwhile |
| `ORIGINAL 1` | Job 1 as written in Salesforce, untranslated |
| `APP` / `TEXT` / `BOTH` | Choose your channel |
| Anything else | Goes to **Vi**, with the job you last looked at as context. Vi answers in your language. |
| `START` / `UNSTOP` | Sign up for Vista texts (the only opt-in words; YES is not one). Twilio confirms. |
| `STOP` | Stop all Vista texts until you text START again. The app keeps working. |

## Demo text line

Program owners (`ADMIN_PHONES`) and program admins can show people what the text line is like from their own phone,
without touching Salesforce (`api/src/lib/demotext.mjs`):

| Text | What happens |
| --- | --- |
| `DEMO` | Your phone becomes Dwayne Tucker (Crew 12) on the demo app's sample jobs |
| `DEMO PM` / `DEMO ES` / `DEMO MEASURE` | Become Mike the PM, Luis (Spanish crew) or Rafael (measure tech) |
| `DEMO RESET` | Start the sample jobs over |
| `DEMO OFF` | Back to the real line (a demo also ends 12 hours after the last text) |

Everything else works like the real line (TODAY, START 1, PAY 1, REVIEW 1, FIX 1 2, questions for Vi). Salesforce
actions are dropped, and a text the engine would send someone else (the crew after a send-back, the PM after a
submit) comes back to your phone, labelled with who would get it. Crews and PMs who text DEMO get the normal line.

## Who gets texts (opt-in)

Vista texts only phones that have texted **START** (or UNSTOP) to the Vista number, **(706) 955-2075**. Being in
Salesforce or in Vista's People list is not enough.

- A phone that hasn't opted in and texts anything else gets one reply a day asking it to text START, and nothing else.
- Every text starts with **Vista (Southern Industries):**. The first text to each phone ends with "Reply HELP for
  help, STOP to opt out" (in their language).
- Automatic texts (morning texts, pay and PM notices, alerts) are capped at **10 per phone per day**, the frequency
  registered with the carriers. Replies to a text the person just sent don't count.
- Sign-in codes aren't gated: the person asks for them in the app.
- Payroll's **People** screen shows each person's status: *Texts on*, *Hasn't texted START*, or *Texted STOP*.

## Texts Vista sends

| When | To | Text |
|---|---|---|
| 6:30 AM | Installers and measure techs on `TEXT` | "Good morning, Luis. Today: 1) 7:00 AM Hall, 512 Lakeside Dr…" |
| A visit is dispatched | The crew (on `TEXT` or `BOTH`) | "Vista: new job dispatched…" |
| An installer submits for pay | PMs on `TEXT` or `BOTH` | "Vista: new pay request, Pierce $1,200 (Cuadrilla 7). Reply REVIEW to see it." |
| 7:30 AM and 9:30 AM | PMs with requests waiting | The review list, ahead of the 10:00 AM cutoff |
| PM approves | The installer | "Vista: approved $1,200 for job 00041880. It's on the next pay run." |
| PM sends back | The installer | "Vista: your PM sent back job 00041880. Needed: … Reply PAY 41880 to fix it." |
| 10:00 AM cutoff | Subs still waiting | As in `approval-flow.md` |

## How it fits

- **No Salesforce changes.** Text conversations write the same records the app does (the engine emits the same actions: `serviceappointment.start`, `woli.status`, `payrequest.create`, `payrequest.approve`, `payrequest.sendBack`, `payrequest.resubmit`, `draw.issue`). The manifest records `"channel": "sms"`.
- **Conversation state** (which list the person last saw, a half-finished pay request, a pending "Are you sure?") lives in the Vista API's store, not in Salesforce.
- **Photos** arrive as picture messages. The API copies each one from the text provider into object storage under the same keys the app uses, then deletes it from the provider.
- **Identity** is the phone number, the same thing the app's text-message sign-in proves. Unknown numbers get a bilingual "ask your PM to add you".

## Before going live

| Item | Why | Lead time |
|---|---|---|
| **Text provider number** with MMS (e.g. Twilio) | Picture messages for photos | Same day |
| **A2P 10DLC registration** (brand + campaign) or **toll-free verification** | US carriers block unregistered business texting | Days to a few weeks. Start early. |
| Opt-in wording at sign-in | Carrier rules: people agree to receive texts; `STOP` / `HELP` always work | — |
| Cost check | Spanish accents switch a text to 70-character segments (vs 160), so Spanish messages cost more per text. We keep replies short; we could drop accents in texts if cost matters. | — |

## Hardening options (later)

| Option | When |
|---|---|
| 4-digit PIN before a PM's `YES` on money actions | If anyone worries about a lost or borrowed phone |
| Rate limits per number | If the number gets spam |
| Accent-free Spanish texts | If texting cost matters |
