# Lead Intake — Payload Contract

The contract for anything POSTing leads into Bee Hub (Make.com scenarios, website forms).
Endpoint audit + punch-list live in [INBOUND_INTAKE_STATUS.md](INBOUND_INTAKE_STATUS.md).

## Endpoint

```
POST https://<prod-domain>/api/leads/intake
Content-Type: application/json
X-API-Key: <LEAD_INTAKE_API_KEY>
```

Auth is the `X-API-Key` header, compared constant-time against the `LEAD_INTAKE_API_KEY`
env var in Vercel. Wrong or missing key → `401` (not logged, not retryable — fix the key).

## Fields

| Field | Required | Notes |
|---|---|---|
| `location_slug` | **yes** | The target location's `locations.location_id`. Unknown slug → `400 location_not_found` — this is a mapping bug, not a transient error. |
| `full_name` | **yes** | Split into first/last on the first space. |
| `email` | one of these two | Must look like an email. An invalid email is treated as absent (warned as `email_invalid_ignored`), never stored. |
| `phone` | one of these two | Free-text accepted; must contain **≥7 digits** to count. Matching/dedup uses digits only. |
| `address`, `city`, `state`, `zip` | no | Stored on the lead. |
| `project_type` | no | Stored on the lead. |
| `message` | no | The project-details free-text. Stored as the lead's `request_details` (the request record shown on the card and used as the engagement description); also echoed into the resubmission touchpoint on a merge. On a merge it only backfills when the matched lead has no `request_details` — an existing value is never overwritten. |
| `preferred_contact` | no | Preferred contact method (e.g. `Text`, `Email`, `Phone`), mirroring Zoho's `Preferred_Method_of_Contact`. Stored on the lead's `preferred_contact` column. Fill-empty on a merge. |
| `source` | no — **but set it** | Defaults to `web_form`. Make MUST set this explicitly per scenario (e.g. `facebook_lead_ad`, `instagram_lead_ad`, `website_form`) or every Make lead lands as a generic `web_form` lead and attribution is lost. |
| `metadata` | no | Arbitrary JSON (raw ad/form IDs etc.). Stored as-is. |

Neither email nor a usable phone → `400 email_or_phone_required`.

## Response semantics

- **200** — lead captured. Body:
  - `lead_id` — the Bee Hub lead (new, or the matched existing lead).
  - `merged: true` + `matched_on` — the submission exactly matched one existing lead
    (email or phone); no new row was created, empty fields were filled.
  - `possible_duplicate_of: [ids]` — created, but flagged against likely duplicates.
  - `drip_enrolled` — whether the drip sequence started. `false` + `drip_skipped_reason:
    'no_email'` means a phone-only lead: captured, deliberately not enrolled (a later
    resubmission with an email will enroll it).
  - `warnings: [...]` — non-fatal downstream failures (touchpoint, drip). The lead is
    safe; nothing to retry.
- **400** — payload problem (`invalid_json`, missing fields, `location_not_found`).
  **Alert, don't retry** — retrying the same payload gives the same 400. Fix the Make
  mapping.
- **401** — bad/missing `X-API-Key`.
- **500** — transient server/DB problem (`location_lookup_failed`, `insert_failed`).
  **Retry with backoff** — the lead is NOT saved.

Every authenticated call (success or failure) writes a `sync_log` row visible on the
admin **Webhooks** tab (rows labeled "Lead intake") and failures feed the twice-daily
Slack digest.

## Example

Request:

```json
POST /api/leads/intake
X-API-Key: ****

{
  "location_slug": "boulder-01",
  "full_name": "Sarah Mitchell",
  "email": "sarah@email.com",
  "phone": "(561) 555-0199",
  "city": "Boulder",
  "state": "CO",
  "project_type": "Garage",
  "message": "Need the garage organized before winter",
  "preferred_contact": "Text",
  "source": "facebook_lead_ad",
  "metadata": { "fb_form_id": "120211234567890123" }
}
```

Response:

```json
{
  "success": true,
  "lead_id": "97ccfc85-ecba-4bc9-8495-b13e6a9e8507",
  "location": { "id": "…", "name": "Boulder", "slug": "boulder-01", "lifecycle_status": "active" },
  "drip_enrolled": true
}
```
