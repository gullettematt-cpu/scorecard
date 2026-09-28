# When It Isn't Working As Intended

**A troubleshooting playbook for marketing systems**
For Heather · marketing systems manager · scoreboard and reporting, Five9 lists and campaigns, lead routing and capture, the recovery program
Prepared September 28, 2026

You own the plumbing between a lead showing up and a rep standing in a driveway. When something breaks in that plumbing, this is how to find it, fix it, or hand it off with everything the next person needs. Nobody expects you to know every answer. Everybody expects a clear example, a named layer, and a packet.

---

## The method — five steps, every time

1. **Pin it down to one example.** One lead, one phone number, one list, one report line. Write down what you expected and what actually happened, with the time and time zone. "Leads aren't getting called" is a feeling. "Lead 00Q…, came in 9:14 AM ET Tuesday from Contractor Appointments, no dial in Five9 by 4 PM" is a ticket.
2. **Find the layer.** Walk the lead's path (below) and check each hop until you find where the example falls off. The break is almost always at a handoff between two systems.
3. **Check what changed.** Most breaks follow a change: a new tracking number, a campaign edit, a Salesforce flow, a vendor switch, a rep added or removed. Look at the change log first.
4. **Fix it if it is yours, or escalate with a packet.** If the fix lives in a list, campaign, or mapping you control, fix it and note it. If it is in Salesforce, a vendor, or a carrier, send the packet (below) to the owner. Do not send a symptom without an example.
5. **Log it and add the check.** One line in the change log. If it could happen again, add the check to the daily list so it is caught in ten minutes, not a week.

---

## The lead's path — where things break

```
Source  →  Capture  →  Routing  →  List / Campaign  →  Dialer / Agent  →  Disposition  →  Report
 (web,     (Salesforce   (AviTrak      (Five9 list,        (Five9 agent      (result code,     (scoreboard,
  Google,   lead record,   tracking #    campaign,           logged in,        set, confirm,     Momentum,
  Facebook, source, lane)  → Five9 DNIS, lane rules)         retry, texts)     cancel, no-show)  transfer report)
  LSA,
  third parties)
```

Rules of the road that most breaks violate:
- **One active lane per record.** Every lead has one destination. When it books, the flow stops.
- **No internal text on top of a third party that texts.** Lavin and Contractor Appointments text their own leads. Double texting confuses the customer.
- **Overflow never goes back to the phone room.** The service line overflows to a message or Revvin voice AI that opens a case.
- **No brand-new reps on rehash or saves, and never the original rep.**
- **Results are captured from the driveway**, not the next day.

---

## Symptom → cause → check → fix

| Symptom | Most likely cause | Check first | Fix, or who gets the packet |
|---|---|---|---|
| Calls to a tracking number get dead air, ring out, or never reach an agent | AviTrak tracking number not mapped to an active Five9 DNIS, or a SIP failure at the carrier | Pull the AviTrak active-number list and compare to the Five9 DNIS list. Place a test call from a mobile; note the time, the number dialed, and what you heard. | Mapping gap: fix the DNIS mapping and re-test. Carrier or Five9 failure: open or update the Five9 ticket with the test-call details, SIP responses and error codes, the customer or test mobile number, and the affected tracking numbers. Send the updated list of problem numbers to Dana. |
| A lead arrived but nobody called it | Not captured in Salesforce; captured with no lane; on a list with no agents logged in; excluded by a list filter; merged as a duplicate | Find the lead in Salesforce. Confirm source and lane. Find it in the Five9 list. Check the campaign has agents on and records remaining. | Re-add it to the right list, fix the filter, get agents into the campaign. If capture failed at the source, packet to Donald (Salesforce, Revvin) with the raw form or vendor post. |
| Customer says they were called or texted twice, or by two different lanes | One-lane rule broken; internal text firing on a third-party-handled source; lead in two campaigns | Check which campaigns and text flows hold the record. Check the source. | Remove the record from the second lane. Turn off the internal text for that source. Note it in the change log. |
| A campaign is crawling or a list is not moving | Too few agents in the campaign; list exhausted or everything in retry; retry timers too long | Agents logged in per campaign; records remaining; retry settings. More people in a campaign makes it move faster. | Add people. Reload or extend the list. Adjust retry timers with Deb's OK. |
| Outbound number shows "Spam Likely" and pickup drops | Number flagged by a carrier | Check the number in the carrier and remediation portals. | Submit business info, logo, license, and screenshots through remediation. Push for branded outbound calling on the numbers that matter (saves, confirmations). Rotate if needed and log it. |
| Callbacks and return voicemails are not being counted | Known gap: no report for inbound returns to the campaign or 888 numbers | Check inbound to the campaign DIDs and how those calls are dispositioned. | Until the handoff completes, ask George to show the callback pull. Track the percentage (returns over voicemails left), not just the count. |
| Scoreboard number looks wrong: set rate collapsed, sold does not match, good dollars off | Source mix changed (a jump in Contractor Appointments or Porch volume drops set rate); definition drift; dispositions gamed; report date basis; a rate shown without its lead count; newest weeks overstate net rate before good dollars mature | Re-read the definition line: leads = run, close = sold ÷ run, demo % = demos ÷ run, net rate = good ÷ sold over matured weeks, basis is sales visits due Mon–Sat. Put the lead count beside every rate. Compare the same window. Sample five records by hand. | If the numbers are right and the story changed, say so straight. If a definition is wrong, packet to Matt with the five records. |
| Confirmation calls not happening or wrong | Confirmation campaign not loaded, wrong assignment, or a flow problem | Capture one example: the appointment, the expected confirmation time, screenshots or a short video of what happened. | Packet to George (Five9) or Donald (Salesforce). This example has been owed since Sep 11; send it. |
| A cancellation came in and Erica never got it | Cancellation not logged in Salesforce when it happened; the same-day list did not generate | Check the cancellation date on the record versus when it was entered. Check the list or report that feeds Erica. | List problem: packet to Donald. Late logging: note the rep and the gap and hand it to Deb. |
| Five9 says we need more "lines" | It is seats, not lines. Seats cost about $149 each plus taxes. | Verify the actual seat need with Lori and Deb. Check whether the pending Five9 credit has landed. | Nothing gets ordered until the count is verified. Vendor contact at Five9 is Petra. |
| Reps say the rehash or previous-customer product is "bad" and leads are not going out | Reps holding leads | Rehash issued versus the same week last year; which reps' lists are not moving | Name the reps to Deb. She takes it to Scott. |

---

## The escalation packet — send this every time

Copy this block, fill it, send it. A packet gets a fix. A complaint gets a question back.

```
What broke:        (one sentence)
One example:       lead / record ID, phone number, list, or report line
When:              date and time, time zone
Expected:          what should have happened
Actual:            what happened
Screens:           screenshot, short video, or call recording ID
Last change:       anything that changed in the last 7 days near this
Already checked:   what you ruled out
Impact:            how many leads / markets / hours affected
```

For Five9 or carrier tickets, add: test-call details (time, from number, to number, result), SIP responses and error codes, the customer or test mobile number, and the list of affected tracking numbers.

---

## Who gets the packet

Confirm names and coverage as the handoff progresses. As of today:

| Layer | Owner | Notes |
|---|---|---|
| Vendors, Five9, AviTrak, tracking numbers | George, until the handoff completes | You are the successor. Sit in on every vendor call. |
| Five9 routing and tracking-number tickets | Dana | Updated list of problem numbers goes to Dana. |
| Salesforce, Revvin, automations, cancel-save list | Donald | Flows, validation rules, lists. |
| Data, reporting, roadblock removal | Matt | Scoreboard definitions, Momentum, anything that needs money or a decision. |
| People, coaching, the floor | Deb | Reps, setters, confirmers, disposition behavior. |
| Seat counts and the service line | Lori (with Deb) | Verify before ordering. |

Vendors in the flow: Five9 (Petra), AviTrak, LightFire, Lavin, Remodel Boom, Contractor Appointments, Porch, Executive Boutique (Jasmine).

---

## Daily checks — ten minutes, before 9:30

1. AviTrak active tracking numbers match the Five9 DNIS list. Log the result, even when it is "all clear."
2. Every campaign has agents logged in and records remaining.
3. Every lead that arrived since yesterday is in exactly one lane.
4. Yesterday's callbacks and return voicemails are dispositioned.
5. Cancels from yesterday are on Erica's list.
6. Scoreboard refreshed, and every rate has its lead count beside it.

Weekly: spam status on the outbound numbers that matter; vendor invoices against what was quoted.

---

## The change log

One line per change to a number, campaign, list, flow, or vendor setting:

```
date · what changed · why · who · how to undo it
```

Keep it where Deb and Matt can see it. When something breaks, this is the first place you look.

---

## Call Matt right away when

- A whole source or market has gone dark for more than an hour.
- A change would touch routing or money for every market at once.
- A vendor asks for a contract change, a new charge, or access.
- A number cannot be explained after thirty minutes of looking.
- A rep or manager pushes back on a scoreboard number and you cannot show the records behind it.

Honest numbers over good-looking ones. If the truth is that a flow was down for two days, that goes on the card. The room can fix a problem it can see.
