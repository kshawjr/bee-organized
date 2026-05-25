# Jobber → Bee Hub Webhook Setup

This is the **inbound** half of the Jobber integration. When something
changes in Jobber (a quote is approved, a job completes, an invoice
gets paid), Jobber POSTs to Bee Hub's webhook endpoint and the
corresponding lead is updated in real time.

The route lives at `app/api/webhooks/jobber/route.ts`. Topic handlers
live in `lib/jobber-webhook-handlers.ts`. Both rely on the upsert
helpers in `lib/jobber-import.ts` (the same ones the manual import uses
— code is shared, not duplicated).

---

## 1. Endpoint

```
https://bee-hub-kappa.vercel.app/api/webhooks/jobber
```

Method: `POST`
Content-Type: `application/json`

The route is **public** (no auth gate) but requires a valid HMAC
signature in the `X-Jobber-Hmac-Sha256` header. Anything else returns
`401`.

---

## 2. Signature verification

Per Jobber's docs, webhook signatures are HMAC-SHA256 of the raw
request body, **keyed with the app's OAuth client secret** — there is
no separate "webhook secret" in Jobber's model. Bee Hub reuses the
existing `JOBBER_CLIENT_SECRET` env var (already configured in Vercel
for the OAuth flow) to verify the `X-Jobber-Hmac-Sha256` header.

No additional env var is needed. If `JOBBER_CLIENT_SECRET` is unset
the route fail-closes — every webhook returns 401.

---

## 3. Topics to subscribe

Bee Hub handles **22** Jobber webhook topics. Subscribe to all 22 in
each account that should sync to Bee Hub (subject to per-topic
availability in the Developer Center — see the note below). Only
**4 topics drive a stage transition**; the others either stamp
timestamps so the Outreach timeline can render distinct entries, or
clean up the Jobber linkage on the lead when something is destroyed
Jobber-side.

### CREATE / UPDATE / state-change topics

| Topic            | Stage change            | Lead columns stamped                                |
|------------------|-------------------------|-----------------------------------------------------|
| `REQUEST_CREATE` | → `Request` (fwd-only)  | `request_created_at`                                 |
| `REQUEST_UPDATE` | _none_                  | _refresh request fields only_                        |
| `QUOTE_CREATE`   | → `Estimate Sent` (fwd) | `jobber_quote_id`, `estimate_amount`, `quote_created_at` |
| `QUOTE_UPDATE`   | _none_                  | `jobber_quote_id`, `estimate_amount`                  |
| `QUOTE_SENT`     | → `Estimate Sent` (fwd) | `quote_sent_at`                                       |
| `QUOTE_APPROVED` | _none_                  | `quote_approved_at`                                   |
| `JOB_CREATE`     | _none_                  | `jobber_job_id`, `scheduled_at`, `job_created_at`     |
| `JOB_UPDATE`     | _none_                  | `jobber_job_id`, `scheduled_at`                        |
| `JOB_COMPLETE`   | → `Closed Won` (fwd) + stop drip | `job_completed_at`                          |
| `INVOICE_CREATE` | _none_                  | `jobber_invoice_id`, `balance_owing`, `invoice_created_at` |
| `INVOICE_PAID`   | → `Closed Won` (fwd) + stop drip | `paid_amount`, `invoice_paid_at`            |
| `CLIENT_UPDATE`  | _none_                  | _refresh name/email/phone/address_                    |
| `PROPERTY_CREATE` | _none_                 | `jobber_property_id`, `address`, `city`, `state`, `zip` (Jobber authoritative) |
| `PROPERTY_UPDATE` | _none_                 | same as `PROPERTY_CREATE`                             |

### Destroy / disconnect topics

In every destroy case the Bee Hub lead row **persists** — only the
Jobber linkage is nulled. Bee Hub is the source of truth for the
customer relationship and survives Jobber-side deletes.

| Topic                | Effect on lead                                                                                       |
|----------------------|------------------------------------------------------------------------------------------------------|
| `REQUEST_DESTROY`    | nulls `jobber_request_id` + `jobber_assessment_id` (paired)                                          |
| `QUOTE_DESTROY`      | nulls `jobber_quote_id`                                                                              |
| `JOB_DESTROY`        | nulls `jobber_job_id`                                                                                |
| `INVOICE_DESTROY`    | nulls `jobber_invoice_id`                                                                            |
| `PROPERTY_DESTROY`   | nulls `jobber_property_id` (address fields stay — Bee Hub's record)                                  |
| `ASSESSMENT_DESTROY` | nulls `jobber_assessment_id` (keeps `jobber_request_id`)                                             |
| `CLIENT_DESTROY`     | nulls **all** `jobber_*_id` columns (full link break)                                                |
| `APP_DISCONNECT`     | on `locations`: `jobber_connected=false`, clears tokens. Preserves `jobber_account_id` + `hub_users.jobber_user_id` for reconnect. |

`REQUEST_UPDATE` falls through to the same cleanup as `REQUEST_DESTROY`
when Jobber returns "not found" for the request — this fixes a race
where the DESTROY event arrives before the UPDATE event in the same
batch.

**Key point**: `Job in Progress` is **owner-driven only**. No webhook
ever transitions a lead into `Job in Progress` — owners flip the stage
manually when real work begins on the ground.

`VISIT_*` topics are deliberately **not** subscribed — visit-level
events don't map to a lead-level state in Bee Hub.

> **Topic availability**: `ASSESSMENT_DESTROY` and `PROPERTY_DESTROY`
> are wired defensively. Confirm each is selectable in the Developer
> Center before subscribing; if Jobber doesn't expose a topic, you
> simply can't tick the box and the corresponding handler stays dormant
> (harmless). The handlers exist so we never log "unknown topic" if a
> future Jobber API release adds them.

---

## 4. Register the webhook (once, at the app level)

Webhook configuration in Jobber lives at the **app** level in the
Developer Center, **not** per Jobber account. A single config covers
every customer that has connected to the Bee Hub app — there is no
per-account registration to repeat.

1. Sign into the **Jobber Developer Center** with the account that owns
   the Bee Hub app.
2. Open the **Bee Hub** app → **Webhooks**.
3. **URL**: set to
   `https://bee-hub-kappa.vercel.app/api/webhooks/jobber`
   (no trailing slash, must be HTTPS).
4. **Topics**: select every topic listed in section 3 that the
   Developer Center exposes. (Some destroy variants may not be
   available in the topic picker — that's fine, the handlers are
   dormant if Jobber doesn't fire the event.)
5. Save.

Signature verification uses the app's OAuth client secret automatically
— there is no separate secret to paste into the Developer Center.

> **Heads-up**: there is currently an older webhook config in the
> Developer Center pointing at `/api/jobber/webhook` (singular, under
> `/api/jobber/...`). That path does **not** exist in this codebase, so
> those webhooks have been silently 404'ing. Update the URL in the
> Developer Center to `/api/webhooks/jobber` (this route) to start
> receiving events.

Jobber typically fires a confirmation POST against the URL on save.
Watch the Vercel logs (`vercel logs --follow`) — you should see a
`[jobber-webhook]` line with `topic=...` and `processed=true` (or a
clear error message).

---

## 5. Verify the wiring

After registering, change something in Jobber and confirm Bee Hub
picked it up:

### a) Smoke test — change a quote status
1. Pick a client in Jobber that's also a lead in Bee Hub.
2. Approve one of their quotes.
3. Within ~5 seconds, refresh the Bee Hub lead — stage stays at
   **Estimate Sent** (QUOTE_APPROVED doesn't transition stage) but
   `quote_approved_at` should be populated, which the Outreach timeline
   uses to render a distinct "Quote approved" entry.
4. Check `sync_log` in Supabase for a row with:
   `direction='inbound'`, `entity_type='quote'`,
   `message LIKE '%QUOTE_APPROVED%'`.

To verify a stage-driving topic instead, complete a job in Jobber
(JOB_COMPLETE → `Closed Won`) or mark an invoice paid (INVOICE_PAID →
`Closed Won`) — both stop the drip via `applyDripSideEffects`.

### b) Manual curl (no real Jobber)
You can synthesize a signed payload for local testing. The signing key
is the OAuth client secret (`JOBBER_CLIENT_SECRET`):

```bash
SECRET="$JOBBER_CLIENT_SECRET"
BODY='{"topic":"CLIENT_UPDATE","accountId":"123","itemId":"456","occurredAt":"'"$(date -u +%FT%TZ)"'"}'
SIG=$(printf "%s" "$BODY" | openssl dgst -sha256 -binary -hmac "$SECRET" | base64)

curl -X POST https://bee-hub-kappa.vercel.app/api/webhooks/jobber \
  -H "Content-Type: application/json" \
  -H "X-Jobber-Hmac-Sha256: $SIG" \
  --data "$BODY"
```

Expected: `{"ok":true,"processed":false,...,"error":"client_fetch:..."}`
(processed=false because the test accountId/itemId don't resolve to
real Jobber records, but the signature check passed.)

### c) Real Jobber → Bee Hub end-to-end
1. In Jobber, change the Test Location's data — create a new client, a
   quote, approve it.
2. Tail Vercel logs: `vercel logs --follow --project bee-hub-kappa`.
3. You should see 3 `[jobber-webhook]` lines (CLIENT_UPDATE,
   QUOTE_CREATE, QUOTE_APPROVED) within a few seconds.
4. Confirm the Bee Hub lead reflects the new state.

---

## 6. Operational notes

- **Replay window**: events older than 5 minutes log a warning but are
  still processed (Jobber occasionally legitimately re-sends).
- **Unknown topics**: logged + 200'd so Jobber stops retrying.
- **Unknown account**: a webhook from an account not connected to any
  Bee Hub location is logged + 200'd (no sync_log row, since there's no
  location to scope to).
- **Handler errors**: logged + sync_log row with `status='error'` +
  always 200'd (so Jobber doesn't retry forever).
- **Forward-only stage promotion**: a `QUOTE_SENT` event will not
  demote a lead that's already at `Job in Progress` or `Closed Won`.
  Stage ranking (lib/jobber-import.ts) uses the canonical 9 stages
  matching `VALID_STAGES` in `/api/leads/route.ts`.
- **Drip side-effects**: only stage promotions into `Closed Won` (via
  `JOB_COMPLETE` or `INVOICE_PAID`) stop active drips. Promotions into
  `Request` / `Estimate Sent` route through `applyDripSideEffects` too
  but those stages already stop the drip per drip-lifecycle.ts.

---

## 7. Troubleshooting

- **Every webhook returns 401** → `JOBBER_CLIENT_SECRET` is unset in
  Vercel, or its value drifted from what the Jobber app is actually
  using (e.g. the OAuth client secret was rotated in Developer Center
  without updating Vercel). Both must match exactly.
- **Webhooks return 200 with `skipped: 'unknown_account'`** → the
  account isn't linked to any Bee Hub location. Either re-run
  `/api/jobber/connect` for that location or remove the webhook from
  the Jobber account.
- **Webhooks return 200 with `error` set** → check Vercel logs for the
  `[jobber-webhook] handler_threw` line and the `sync_log` row.
- **Lead state doesn't update** → the handler may have run successfully
  for a different lead than expected. Check the `sync_log` row's
  `entity_id` and `message` — `topic=… item=…` identifies the Jobber
  record and the lead it resolved to.
