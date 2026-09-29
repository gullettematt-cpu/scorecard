# Vista program playbook

This playbook explains how Vista runs day to day and who does what. It's written for three groups of people:

- **Lisa**, in payroll, who runs the program. Most of the playbook is for Lisa.
- **PMs**, who handle their crews and decide on pay. See [For PMs](#for-pms).
- **Crews**, who do the work and get paid. See [For crews](#for-crews-para-las-cuadrillas); that section is in English and Spanish.

To practice without touching Salesforce, open the demo on the
[walkthrough page](https://claude.ai/artifact/1p9mbThVcv2rNVm1XXzGJa) and sign in as **Lisa · Payroll**. The screens
there are the real ones, running on sample jobs.

---

## Who does what

| Who | Owns | Contacts |
|---|---|---|
| **Crews** (installers, measure techs) | Doing the work; submitting for pay with photos; fixing what's sent back; reporting problems | Their **PM** |
| **PMs** | Their crews and every pay decision: approving by 10:00 AM, sending back what's missing, issuing draws | **Lisa** for anything about the program or the system |
| **Lisa** (payroll, program admin) | The whole program: that approvals happen before the cutoff, who's on Vista, which locations are live | PMs for approvals; **Angie** for invoices; **Matt** for Salesforce; **Donald** for AWS and Twilio |
| **Angie** | Linking the payable invoice for approved requests; the ACH run | Lisa |
| **Matt** | Salesforce: records, statuses, the Vista flows, the integration user | Lisa |
| **Donald** | AWS and Twilio: Vista being up, texts sending, sign-in codes arriving | Lisa |

Crews go to their PM. PMs go to Lisa. Lisa goes to Angie, Matt or Donald. Vista's **Health** screen tells Lisa
which of them a failure belongs to.

## How money moves

These are the four stages on Lisa's **Pay run** screen, in order:

1. **Waiting on PMs.** A crew submitted for pay with every required photo, the checklist and the line items. It
   sits with the job's PM.
2. **Sent back to crews.** The PM said what's missing. The crew adds it in Vista or by text, and it goes back to
   step 1.
3. **Approved, next run.** The PM submitted it. It's in Salesforce as Approved, with the PM as approver, and Angie
   links the payable invoice.
   - Anything approved by **10:00 AM Eastern on a weekday** goes in that day's ACH run.
   - Anything approved later goes in the next business day's run.
   - **Draws** (pay before a job is done) start here. A PM issues them already approved, and Mike Duncan gets an
     email for every one.
4. **Paid.** It shows as paid once the payable invoice or paycheck period is linked in Salesforce.

"No photos, no pay": Vista won't let a crew submit until every required photo is in, and it won't accept an amount
over what's left on the contract.

## What Vista does on its own

| When (Eastern) | What |
|---|---|
| 6:30 AM, Mon–Sat | Crews on texts get today's job list. |
| As soon as a visit is dispatched | The crew gets "new job dispatched". |
| When a crew submits | The job's PM gets a text. |
| 7:30 AM and 9:30 AM, Mon–Fri | PMs with requests waiting get their review list. |
| 10:00 AM, Mon–Fri | The cutoff. Anything still waiting misses today's run. The crew is told why, in their language, and each PM gets a count. |
| When a PM approves or sends back | The crew gets a text. |
| When someone reports a problem | The job's PM gets a text. |
| Every 2 hours | The health check. If it fails, the alert list gets a text. |

---

## Lisa's screens

Lisa signs in to Vista like everyone else, with a code texted to her mobile. Vista then shows four screens made for
her role, plus Ask Vi.

### Pay run

This is Lisa's main screen.

- **The header** counts down to today's 10:00 AM cutoff, or says which run approvals now go in.
- **Three tiles** show what's waiting on PMs, what's sent back to crews, and what's approved for the next run,
  with counts and dollar totals.
- **Waiting on PMs** is grouped by PM, with the longest-waiting PM first. Each card lists the jobs, amounts and how
  long each has waited, and marks anything waiting **over a day**.
  - **Text {PM} a reminder** sends the PM one text: how many are waiting, the total, and the cutoff.
  - Each PM gets at most one reminder an hour.
  - If the PM turned texts off, the screen shows their number to call instead.
- **Sent back to crews** shows what's missing on each one.
- **Approved, on the next pay run** is the list for Angie.
- **Paid, last 30 days** gives a count and total.

### People

Everyone who uses Vista, grouped by role and searchable by name, phone or company. Tap a person to:

- change their role, language, or how they get Vista (app and texts, app only, or texts only);
- **turn Vista off** for someone who's left or shouldn't have access. Their Salesforce records don't change, and it
  can be turned back on.

**Most people never need adding.** Vista finds them in Salesforce by the mobile number on their User or Service
Resource. Use **Add a person** only when someone's missing or their number in Salesforce is wrong. Also let Matt
know, so Salesforce gets fixed too.

Lisa can manage crews, measure techs and PMs. Only Donald can grant admin access.

### Rollout

This screen sets who uses Vista at each location. Changes take effect right away, with no deploy.

- **Off:** nobody at the location uses Vista. Crews and PMs keep the old process.
- **Pilot:** only the companies listed use Vista.
- **On:** everyone uses Vista, except the companies listed as staying on the old process.

Company names must match Salesforce exactly. Turning a location off stops the app, texts and dispatch notices
there. Nothing already in Salesforce changes.

### Health

- **Whether Vista is working,** as of the last 2-hour check, and a button to run the check now. If it's failing,
  the screen says whether that's Salesforce (Matt) or AWS (Donald).
- **Language requests:** people who asked for Vista in another language. Vi already answers them in it.
- **Who handles what,** for quick reference.
- **Sign out.**

---

## Lisa's day

**Weekdays**

| Time | What to do |
|---|---|
| 8:30 AM | Open **Pay run**. For anything **over a day** in *Waiting on PMs*, text that PM a reminder. PMs already got their 7:30 list; this is the personal nudge. |
| 9:30 AM | Look again. For large amounts or anything still old, call the PM. Vista's own 9:30 reminder has just gone out. |
| 10:00 AM | Cutoff. Nothing to do; crews and PMs are told automatically. |
| After 10 AM | **Approved, on the next pay run** is today's run. Make sure Angie has what she needs to link invoices. |
| Afternoon | Check **Sent back to crews**. For anything over 2 days, ask the PM to follow up with the crew. |

**Weekly**

- **People:** turn off anyone who's left, and clear up anything strange.
- **Health:** confirm the last check is recent and green, and review language requests.
- **Rollout:** 15 minutes with Mike. How is the pilot going, and who's next?

## When someone asks…

| Question | What Lisa checks | What to do |
|---|---|---|
| "Where's my pay?" (usually via the PM) | **Pay run**: find the job | **Waiting on PMs:** text the PM a reminder. **Sent back:** the missing items are listed, so tell the PM; the crew adds them in Vista. **Approved:** it's on the run for the day it was approved (before 10 AM, same day; after, the next business day), so check with Angie. **Not on the board at all:** see the next row. |
| "The crew submitted, but the PM doesn't see it" | Not on the board | It's probably still on the crew's phone without signal. Their header shows "waiting to sync", and it goes through as soon as they have signal and open Vista. If it still doesn't appear, contact Donald. |
| "They can't sign in / no code comes" | **People**: are they there, turned off, with the right number? | Fix or add them. Codes are limited to 5 an hour per phone, so wait a bit after several tries. If nobody is getting codes, contact Donald. |
| "The job isn't showing" | Is it **dispatched**? Are they **assigned** to the visit? Is their company on Vista (**Rollout**)? | Jobs only show once the visit is dispatched and assigned. Otherwise fix Rollout. |
| "The PM is out this week" | — | Requests go to the PM on the job in Salesforce. To move them, change the Job's Production Manager in Salesforce (Matt). |
| "They'd rather get texts / use the app" | **People** | Change **How they get Vista**. |
| "Switch them to Spanish (or English, or both)" | **People** | Change the language, or they tap 🌐 at the top of the app, or text ESPAÑOL, ENGLISH or BILINGUAL. |
| "Wrong amount / duplicate" | **Pay run** | The PM sends it back with a reason. Vista already blocks amounts over the contract. |
| "They don't get any texts" | **People**: does it say *Hasn't texted START*? | Vista only texts phones that have texted **START** to (706) 955-2075. Ask them to text START. The app works either way. |
| "They texted STOP" | **People** shows *Texted STOP* | Vista stops all texts to that phone. They text START to get texts again. The app still works. |
| "Someone left the company" | **People** | Turn Vista off for them, and deactivate them in Salesforce (Matt). |
| The Health screen shows a failure | **Health** | It names who to contact. Mike and Matt also get a text when it happens. |

---

## Rolling out a location

1. **Pick the pilot.** One or two companies, with Mike as PM.
2. **Turn it on for them.** In **Rollout**, set the location to **Pilot** and add the companies, spelled as in
   Salesforce.
3. **Tell the crews.** Use the message below, or have the PM tell them.
4. **First week:** check **Pay run** every morning, and meet with Mike on day 3 and day 5.
5. **Widen the pilot:** add more companies.
6. **Go live:** set the location to **On**. List any companies that need to stay on the old process.
7. **To go back at any time:** set the location to **Off**.

Message to crews (the PM can send it):

> Starting Monday, submit for pay in Vista: open **[App URL]** on your phone. To get Vista texts, text **START**
> to **(706) 955-2075**, then text **TODAY** for your jobs. Sign in with the code we text you. A photo of each required shot is needed to get paid. Approved by
> 10 AM = paid that day. Questions: call me.
>
> Desde el lunes, envíe para cobro en Vista: abra **[App URL]** en su celular. Para recibir textos de Vista, mande
> **START** al **(706) 955-2075**, luego **HOY** para ver sus trabajos. Entre con el código que le mandamos por texto. Se necesita una foto de cada toma requerida para cobrar.
> Aprobado antes de las 10 a.m. = pagado ese día. Preguntas: llámeme.

---

## For PMs

- **Every morning:** open **Approve**, or reply **REVIEW** to the 7:30 text. The header counts down to the 10:00 AM
  cutoff.
- **To review a request:**
  - **Check** the photos and the deliverables list. Vista already checked the photo minimums, the checklist, the
    line items and the contract amount.
  - **Submit to accounting** stays locked until every item is ticked. It asks "Are you sure?" once. It then goes to
    Salesforce **already approved**, with you as approver, and the crew gets a text.
  - **Send back** turns anything not ticked into the "missing" list, with a reason. The crew gets it in their
    language, adds what's missing, and it comes back to you with only those items to check.
- **Draws:** a crew asks you directly. Open the job, fill in **Issue a draw** (it needs a progress photo), and
  confirm. It's approved at once, and Mike Duncan gets an email.
- **Problem reports** from crews come to you by text and create a Service case on the job.
- **If a reminder comes from Lisa,** there are requests waiting on you. Approve before 10 AM so your crews are paid
  today.

## For crews / Para las cuadrillas

| | English | Español |
|---|---|---|
| **Sign in** | Open the Vista link and enter your mobile number. Type the 6-digit code we text you. | Abra el enlace de Vista y escriba su celular. Ponga el código de 6 dígitos que le mandamos. |
| **Your jobs** | **Today** shows your dispatched jobs. Tap one for the address, scope and line items. | **Hoy** muestra sus trabajos despachados. Toque uno para ver la dirección, el alcance y las partidas. |
| **On site** | Tap **Start job**. Tick each line item as you finish it, and work through the checklist. | Toque **Iniciar trabajo**. Marque cada partida al terminarla y siga la lista. |
| **Get paid** | **Pay** asks for a photo of each required shot, the amount and the work. "No photos, no pay." Approved by 10 AM = paid that day. | **Cobrar** pide una foto de cada toma requerida, el monto y el trabajo. "Sin fotos, no hay pago." Aprobado antes de las 10 a.m. = pagado ese día. |
| **Sent back** | Vista tells you exactly what's missing. Tap **Add what's missing**, add it, and send. | Vista le dice qué falta. Toque **Agregar lo que falta**, agréguelo y envíe. |
| **Draw** | Need pay before the job is done? Ask your PM. | ¿Necesita un adelanto? Pídaselo a su PM. |
| **A problem** | On the job, tap **Report a problem**. Add a photo. Tick "Work is stopped" if you can't continue. | En el trabajo, toque **Reportar un problema**. Agregue una foto. Marque "El trabajo está detenido" si no puede seguir. |
| **Questions** | Ask **Vi** in the app. For safety, money or anything structural, call your PM. | Pregúntele a **Vi** en la app. Para seguridad, dinero o algo estructural, llame a su PM. |
| **No signal** | Keep working. Vista saves on your phone and sends when you have signal. | Siga trabajando. Vista guarda en su celular y envía cuando haya señal. |
| **By text** | TODAY, PAY, HELP. ESPAÑOL, ENGLISH or BILINGUAL to change language. | HOY, COBRAR, AYUDA. ESPAÑOL, ENGLISH o BILINGUAL para cambiar el idioma. |
