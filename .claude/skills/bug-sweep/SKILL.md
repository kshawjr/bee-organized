---
name: bug-sweep
description: Produce a read-only triage report of what's currently broken or newly reported in Bee Hub — new feedback_items in 'submitted', Vercel runtime errors over the last 24h, silence checks on the lead intake, daily digest, and failure-alert cron, and the live CAN-SPAM check of owner-edited email copy. Use when asked for a bug sweep, a triage report, or "what's broken in Bee Hub". Report only — never fix, never file, never change a status.
---

# Bee Hub bug sweep

Run this to produce a triage report of what's currently broken or newly reported in Bee Hub. Twice daily. Report only — never fix, never file, never change a status.

## What to pull

### 1. New feedback

Owners submit from their locations, categorized bug or feature.

- Table: `feedback_items`
- "New" in the UI = `status = 'submitted'`
- Statuses: `submitted → under_review → planned → in_progress → shipped → declined`
- `type` is `bug` or `feature` (features display as "Ideas")
- Useful fields: `title`, `description`, `user_id`, `location_id`, `created_at`, `attachments`, `context` (a record deep-link when submitted from an engagement)

Pull everything in `submitted`. Join to `hub_users` and `locations` so each item carries a person and a place.

### 2. Runtime errors

Vercel project `prj_ceyRu0Rm9Omu9FOEgrXdT35KKlEX`, team `team_xs4KA8tH22aiz0huwcOnYf3s`.

Use `get_runtime_errors` over the last 24h — it reads a pre-aggregated table and won't time out. `get_runtime_logs` times out on wide ranges; if you need it, scope to a single deployment or a short window.

### 3. Silence

Absence doesn't log, and it's how the worst failures hide. Check whether these are still happening, and say plainly if any has gone quiet:

- **Website lead intake** — `/api/leads/intake`. A day with zero requests means the pipeline is dead upstream, in MAKE or the website form. Bee Hub logs nothing because nothing arrives. Cross-check by querying `leads` for recent rows with a website source.
- **The digest** — should post once daily around 10:00 UTC.
- **Failure alerts** — the `*/5` cron.

### 4. Email compliance (CAN-SPAM, live copy)

Owners edit their own drip sequences and template copies in the app, and nothing in the repo tests sees those edits. Run the live check from the repo root (read-only):

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/scan-canspam-live.mjs
```

Exit `0` = nothing flagged, `1` = something flagged, `2` = couldn't read the data (say so plainly). It lists:

- **NEEDS A LOOK** — an email that goes out with no unsubscribe footer (a drip step or estimate follow-up) but carries an offer or the brand story, or doesn't mention the recipient's own enquiry. An **offer** here is the one that matters most: an owner has turned a no-footer email into marketing. Name the location, the sequence and the step, quote the line, and say whether anyone is on that sequence now.
- **CHANGED** — a standard email no longer matches what was assessed. The CAN-SPAM assessment needs redoing for it.

A flag means "a person should read this email", not "this is a violation" — say it that way.

## How to triage

Group bugs together, features together. Flag duplicates.

For each bug, say one of:

- **LIKELY FIXED by <issue>**, with your reasoning
- **STILL REAL**, and name the code path if you can find it
- **CAN'T TELL from the report alone**, and say what you'd need

Be honest about the third. A report saying "this is broken" with no detail isn't diagnosable from code, and guessing wastes Kevin's time worse than saying so.

Check reports against recently shipped work before calling them real — a lot ships in a day here and some reports go stale within hours.

## Known noise — mention only if the pattern changes

- `[can-spam] could not establish unsubscribe token` on `/api/cron/send-drips` — a real bug, tracked. Report the count and the number of distinct leads, not every occurrence.
- `resend` rejections for `*.test@example.com` — two fake test leads on the hourly drip. Ignore unless the recipients change.
- `[jobber-webhook] request_not_found_in_jobber` — a deleted Jobber record, self-resolving.
- Token-race webhook errors that self-heal within 5 minutes.
- The email compliance check's 8 returning-client "nudge" emails (flagged 2026-09-28: "Just making sure this didn't get buried…", "This is the last you'll hear from us…" in Returning client Path A and C — master, North Houston, West St Louis, San Diego). They're awaiting Kevin's call on whether a follow-up nudge counts as part of the client's own enquiry. Report the count; list them only if the count or the list changes, or if any of them gains an offer.

## Rules

- **Read-only. SELECT only.** Never write, never change a feedback status, never fix anything.
- Never print secrets. Report a token or key as present or absent, never its value.
- If you can't reach Supabase or Vercel, say so plainly and report what you could get. A report that silently omits half its sources is worse than one that admits the gap.
- Lead names and client emails are real people. Include what's needed to act, nothing more.

## Report shape

Lead with anything urgent — a broken pipeline, a new error spike, a report describing something client-facing.

Then: new feedback grouped and triaged. Then runtime errors with counts and first/last seen. Then the silence checks, stated even when everything is fine, because "intake is running normally" is information. Then email compliance — "nothing new flagged" is information too.

Close with what you'd look at first, and be willing to say nothing needs attention.
