# Weekly Sync — Call Center Operations

**Monday, September 28, 2026 · 10:00–11:00 ET · Matt's Office**
**Covers the week of Monday Sep 21 – Saturday Sep 26**
Chair: Deb · Scoreboard: Heather · Data and air cover: Matt

> Operating rule: the scoreboard tells the story. Honest numbers over good-looking ones, always. A bad week reported straight is a good week for this room.

Anything marked **[fill Monday]** comes from the Monday Momentum run, Salesforce, or Five9 and was not available when this was prepared. Leave it blank rather than guess it.

---

## Read this first — the five things that matter this week

1. **Volume is the lever.** The last Momentum run (week of 9/14–9/19) had Augusta running 80 leads against a goal of 103. To land the month at the current net rate, the call center has to set **8.6 appointments a day** for Augusta and marketing has to bring **21.2 raw leads a day**. This week's set number goes on the board first.
2. **Fresh-lead flows are at risk on the systems side.** Calls failed between AviTrak tracking numbers and Five9 last week, with dead air on some. A Five9 escalation ticket is open and the root-cause analysis is still owed. On Sep 21 the team agreed to reconcile AviTrak tracking numbers against active Five9 DNISs **every day**. Confirm it is happening and who runs it.
3. **The recovery program is not fully loaded.** Missed leads and callback lists still have to be routed into Five9 (open from Friday Sep 25, Deb and the call center team). Callback and return-voicemail tracking has been a known gap since Aug 17.
4. **Lead volume is soft, so every rate needs its lead count beside it.** Leads have averaged about 90 a day. August was down 3.3% year over year. Southern real-time transfer volume dropped sharply and aged-transfer conversion fell 14.26%. Matt owes lead counts on the transfer and monthly reports for the same comparison window.
5. **Huntsville is converting poorly.** The Sep 27 ops alert flagged a 19% close rate (3 sold on 16 demos, last 7 days). Before pushing more sets into Huntsville, look at confirm quality and lead-source mix for that market.

---

## 1. Scoreboard — Heather presents

Leads worked → sets → confirms → appointments run → sold, by market. Counts show actual / goal. Rates show the rate, the goal rate, and the gap in points.

| Market | Leads worked | Sets | Set rate | Confirms | Confirm rate | Appts run | Sold | Notes |
|---|---|---|---|---|---|---|---|---|
| Augusta (SSW + ENL) | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | Prior Momentum run: 80 run vs 103 goal |
| Atlanta | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | Spend already pulled back; watch not-runs |
| Savannah | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | |
| Charlotte | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | |
| Greenville | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | |
| Huntsville | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | Close rate 19% alert on 9/27 |
| **Company** | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] | |

Add or remove markets to match the scoreboard as built.

**Fresh flows** (new leads only, this week vs last week)

| Measure | This week | Last week | Goal |
|---|---|---|---|
| Contact rate on fresh leads | [fill] | [fill] | [fill] |
| Speed to lead (median minutes to first dial) | [fill] | [fill] | [fill] |
| Share of fresh leads dialed within 5 minutes | [fill] | [fill] | [fill] |
| Leads with no dial after 24 hours | [fill] | [fill] | 0 |

**Reference from the last Momentum run (week of 9/14–9/19, Augusta).** These are a week old and are replaced by the Monday run.

| Measure | Actual | Goal |
|---|---|---|
| Leads run | 80 | 103 (78% of goal) |
| Demo rate | 85% | 80% |
| Close rate | 39% | 26% |
| Board matchup used on appointments | 9 of 82 (11%) | run the board |
| Appointments the call center must set per day (rest of month) | 8.6 | |
| Raw leads marketing must generate per day | 21.2 | |
| SSW set / raw per day | 7.2 / 17.8 | |
| ENL set / raw per day | 1.4 / 3.4 | |

---

## 2. Cadence and list health — systems: Heather · people: Deb

Is every pool owned, loaded, and moving?

| Pool | Owner | Where it stood going into this week | Question for the room |
|---|---|---|---|
| Fresh-lead flows (web, Google, Facebook, LSA, and third parties: LightFire, Lavin, Remodel Boom, Contractor Appointments, Porch) | Heather (systems) | AviTrak → Five9 routing failures and dead air. Five9 ticket open with SIP traces. Updated list of problem tracking numbers was to go to Dana. Daily reconciliation agreed 9/21. | Was every live tracking number reconciled to an active DNIS this morning? Who ran it, and where is the log? |
| Confirmations | Heather / Deb | A confirmation-call problem was raised 9/11. One example with screenshots or a short video is still owed to George. | Was the example sent? Is confirm rate on the scoreboard by market? |
| Recovery program (dials → re-sets → runs) | Heather leads | Missed leads and callback lists not yet routed into Five9 (open 9/25). Return-voicemail and callback tracking gap since 8/17. | What lists are loaded today, how many records, who is dialing them, and when do dials → re-sets → runs show on the card? |
| Cancel-saves | Deb (people) · Donald (Salesforce list) | Erica works a same-day cancel list from Salesforce. Rules: no brand-new reps on saves, and never the rep who was originally out there. Cancellations must be logged the day they happen. | Is the list generating on its own each morning? Cancels in last week, saves attempted, saves won? |
| Rehash and previous customers | Deb | Rehash was down roughly 50 versus the same month last year. Reps are holding leads or talking the product down. Previous-customer campaign moves faster with more people in it. | Which reps are holding rehash? Has the list gone to Scott? |
| Third-party setters | Deb | Executive Boutique's four weakest setters were flagged to Jasmine: train or replace. LightFire saves improved once they came off confirmations. | Outcome on the four setters? |
| Service-call line | Deb / Lori | Skill order Danielle → Hope → Cassie, overflow to a message or Revvin voice AI that opens a case. Overflow never goes back to the phone room. | Is the IVR built in Five9? Seat count verified with Lori before ordering? |

---

## 3. Quality and coaching — patterns, not blame

- **Balto.** Scripts, PIP documents, and KPI docs were shared with Deb 8/24. Missing scripts still have to be rebuilt in Balto, including the cancel-save script. Playbooks by product and lead source, and scoring or leaderboards, are on the list. Which Balto signals did we look at this week, and what are the top two themes?
- **Disposition integrity.** Reps have been gaming result codes (a no-show entered when quote photos exist, a no-show logged days late). Donald proposed a Salesforce validation rule that blocks an invalid result when a quote exists. Results get captured from the driveway, not the next day.
- **Setter and confirmer trends.** Name the trend, not the person, unless it is a repeat. Which two behaviors get coached this week?
- **QA / trainer role.** The QA or trainer job posting was on the 8/24 list. Status: **[fill Monday]**.

---

## 4. Staffing and coverage

- Prime-time target is coverage from **8 AM to 8 PM**.
- Scheduling against lead volume by market and shift: **[fill Monday]** (dials and sets by hour block versus agents on).
- Five9 seats run about **$149 per seat plus taxes**. Verify the seat count with Lori before anything is ordered. A credit is pending with Five9; hold new asks until it lands unless urgent.
- Heather's office, laptop, and camera were part of the transition plan. Confirm they are in place.

---

## 5. Projects in flight — max three

Each project in one line: owner, status, next milestone, on or off track. New projects wait for an open slot, and nothing gets added without naming what it displaces.

| # | Project | Owner | Status | Next milestone | On track? |
|---|---|---|---|---|---|
| 1 | Five9 routing reliability: daily AviTrak-to-DNIS reconciliation plus the Five9 escalation | Heather (George until the handoff completes) | Ticket open, RCA owed by Five9. Daily reconciliation agreed 9/21. | Five9 RCA received; five straight days of the reconciliation log with zero unrouted numbers | [fill] |
| 2 | Recovery program into Five9: missed leads and callback lists | Heather (systems) · Deb (people) | Open since 9/25 | Lists loaded and dialing; dials → re-sets → runs on next Monday's card | [fill] |
| 3 | Balto rebuild and QA role | Deb | Scripts and KPI docs shared 8/24; backend setup and approved triggers sent to Deb's team | Cancel-save script live; playbooks by product and source; QA posting up | [fill] |

**Waiting for a slot (say what it displaces):** exclusive-lead program and its Salesforce integration · Aqua Finance application workflow · Salesforce Contact Center agent (voice route, wrap-up, Einstein recommendations) · Genesys evaluation · customer-care IVR in Five9 · branded outbound calling and spam remediation · Slack pilot.

---

## 6. Blockers and decisions — needs Matt or Deb to clear

**Decisions**
- **LightFire / Lavin transfers.** Understand contract mechanics, transfer cost, and dollar value before the workflow changes (open since 9/4).
- **Exclusive-lead program.** Which markets get bath leads first, whether SMS is approved for the workflow, whether quantities can shift between Atlanta and Savannah, and leadership sign-off on the contract and rollout.
- **Marketing spend.** Marketing is at 22% of sales against a 15% target. Cost per issued lead is $5.72. Cuts must come out of flows that are not producing, not out of the ones that are. Bring the source-level numbers.

**Blockers**
- Five9 root-cause analysis on the call failures.
- Reps holding rehash or miscoding results. Derek asked Deb to name the reps so Scott can act.
- Lead counts on the transfer and monthly reports for the same comparison window (Matt).

**Changes we are making this week, and how we will know they worked**

| Change | Owner | Proof next Monday |
|---|---|---|
| Daily AviTrak-to-DNIS reconciliation | Heather | Log shows five days, zero unrouted numbers, no dead-air reports |
| Recovery lists loaded into Five9 | Heather / Deb | Dials, re-sets, and runs from the recovery pool on the scoreboard |
| Cancel list auto-generates for Erica | Donald / Deb | Cancels logged same day; saves attempted equals cancels received |
| Lead count shown beside every rate | Heather / Matt | Every rate on the scoreboard carries its lead count |

**Coming up**
- **October 1 PIT program** for GSs and OSRs starts Thursday.
- The George handoff continues; target window is late September through October. Heather is the named successor on the systems side.

---

## Appendix — Monday morning pull list (Heather, before 9:30)

1. Run Momentum for the week of 9/21–9/26 and paste the scoreboard, pace, and board-matchup lines.
2. Five9: dials, contacts, sets, and confirms by campaign and by market; contact rate and speed to lead on the fresh-lead campaigns.
3. Five9: agents logged in per campaign and remaining records per list.
4. AviTrak: active tracking numbers versus Five9 DNIS list, with the reconciliation log.
5. Salesforce: cancels received last week, saves attempted and won; rehash leads issued versus the same week last year.
6. Ops alerts from the weekend (Huntsville close rate is already on the list).
