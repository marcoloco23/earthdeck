# Trust — what the AI may publish on its own, and how to challenge it

Earth Watch findings are published by AI, automatically, and checked afterwards. This page
says what that means in practice. The rules are code, not promises: they live in
[`src/ledger/schema.ts`](src/ledger/schema.ts) (`checkAppend`, `publishGates`), and the
ledger refuses any entry that breaks them. Anyone can re-check the whole history with
`earthdeck ledger verify`.

Current policy: **`2026-09-26-autonomous`**.

## What the AI may publish on its own

A finding goes public only if all of these hold:

1. **Evidence.** It was opened with evidence a third party can fetch again (scene IDs,
   dates, method and version).
2. **A second, independent signal.** A different sensor, a different provider, or a later
   pass agreed. This step is decided by fixed rules, never by an AI's opinion.
3. **A written account.** An AI wrote a plain-language narration, and every claim in it
   points at evidence the finding actually holds.
4. **A second pair of eyes.** After that narration, a *different* reviewer — another AI
   model or a person — read it and gave the verdict **publish**. The AI that wrote it
   cannot approve it. If the text is rewritten, it needs a fresh review. The latest review
   saying *hold* or *reject* stops publication.
5. **Tier 0–2 only.** The most serious findings (tier 3) are published only by a named
   person, never by the AI alone.
6. **A record of the gates.** The publish entry states who wrote the narration, who
   approved it, how long the party had been notified, and which policy applied. The ledger
   checks those claims against its own history; a publish that claims a review it doesn't
   have is refused.

Reviewer identities are the names written into the ledger (`model:<id>`, `reviewer:<handle>`).
They are self-declared, so the separation between writer and reviewer is a recorded,
checkable practice — not a cryptographic proof. Every published finding says it was
AI-drafted and names the models involved.

## Naming a company or institution

Findings are about **assets, places and institutions — never private individuals.** There
is no way to record a person as a subject or party; the schema has no such field.

To name a responsible party (an operator, an owner):

- the link must come from a **cited public registry** (for example Climate TRACE or Global
  Energy Monitor ownership data), and the finding must be tier 2 or higher;
- **two different reviewers** (people or AI models, distinct from each other and from the
  AI that wrote the narration) must sign off on the attribution;
- the party must have been **notified privately at least 72 hours before** publication —
  or the notice records that the party could not be reached — and "could not be reached"
  is itself a record, not a claim: it must list at least two channels that were actually
  tried, with timestamps;
- for tier 3, the 30-day right-of-reply clock must also have run out.

## How to challenge a finding

- **Right of reply.** If you are named, you are told privately first. Your reply is
  recorded word for word and shown next to the finding. "No response" is also shown.
- **Retraction.** A finding that turns out to be wrong is retracted, with a reason. Nothing
  is deleted: the finding, the retraction and the reason stay in the public ledger.
- **Our error rate is public.** False positives and retractions are kept forever and
  counted, so anyone can see how often we are wrong.
- **Community votes are a signal, not a gate.** Votes and comments can prompt a re-check or
  a retraction, but they never publish or suppress a finding on their own. The evidence and
  the rules above decide.

## The daily Situation — how the level is set

Once a day the site shows one level for the whole watch: **quiet**, **watch** or
**urgent**. The level is set by the fixed rules below, never by the AI. Each rule that
fires is listed under "Why this level", pointing at the cases or indicators behind it.

It is **urgent** if any of these is true:

- the El Niño / La Niña phase (NOAA's definition: five seasons in a row beyond ±0.5 °C)
  was newly declared or changed this month, or an ENSO case was opened this month;
- an earthquake of magnitude 7 or more became a case in the last 48 hours;
- an extreme-heat or tropical-cyclone case was published in the last 48 hours;
- Arctic or Antarctic sea ice is below the lowest value ever recorded for that date;
- three or more cases were confirmed within one day in the same region (a 10° × 10° box).

It is **watch** if none of those holds but any of these does:

- at least one case was confirmed by a second, independent signal in the last 7 days;
- a world indicator just moved outside its usual range (above its 90th or below its 10th
  percentile, when the reading before was inside);
- sea ice is in the lowest tenth of 1981–2010 for the date.

Otherwise it is **quiet**.

An AI then writes a short briefing from a fixed set of facts (the level and its reasons,
what changed since yesterday, new and good-news cases, the indicators, the false alarms we
caught). Every number in it must appear in those facts, it may not name people, and a
second, separate AI must accept it. If any of that fails, the site shows the rules' own
plain sentences instead. At most one AI briefing is written a day. The briefing is kept
next to the signed ledger for 30 days, not inside it: the ledger records only events on
individual cases.

## Changing these rules

Each publish entry names the policy it was made under. Changing the rules means a new
policy version, so every past decision can still be read against the rules that applied
at the time. A named person can still publish under the original human-review rule (one
human approval at tier 1, two distinct ones at tier 2 and above, no recorded gates) —
that is how findings from before this policy were published, and they remain valid. The
party-notice and tier-3 rules above apply on both routes.
