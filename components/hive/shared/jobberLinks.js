// components/hive/shared/jobberLinks.js
// ─────────────────────────────────────────────────────────────
// PURE module — Jobber deep-link derivation for the hive cards
// (card-restore build 1, Kevin's 7/10 mockups).
//
// Two sources of truth, in order:
//   1. the stored *_url column (jobberWebUri, written by every
//      import/webhook upsert — see lib/jobber-import.ts)
//   2. derived from the stored jobber_*_id — the same
//      secure.getjobber.com path family classic BeeHub builds from
//      person.jobberRef.
// Assessments carry NEITHER (no url/id columns) — no link derivable.
//
// The CLIENT link is always id-derived: leads.jobber_client_id →
// /clients/{id} (classic's pattern) — never a child record's URL, so
// "Open in Jobber" on a client lands on the client, not one job.
// ─────────────────────────────────────────────────────────────

const JOBBER_BASE = 'https://secure.getjobber.com'

export function jobberClientUrl(jobberClientId) {
  return jobberClientId ? `${JOBBER_BASE}/clients/${jobberClientId}` : null
}

// kind → { url column, jobber id column, path segment }
const RECORD_LINKS = {
  request: { url: 'request_url', id: 'jobber_request_id', path: 'requests' },
  quote:   { url: 'quote_url',   id: 'jobber_quote_id',   path: 'quotes' },
  job:     { url: 'job_url',     id: 'jobber_job_id',     path: 'jobs' },
  invoice: { url: 'invoice_url', id: 'jobber_invoice_id', path: 'invoices' },
}

// Stored URL first, id-derived fallback, null when the record was never
// in Jobber (or kind is unknown — assessments land here by design).
export function recordJobberUrl(kind, row) {
  const spec = RECORD_LINKS[kind]
  if (!spec || !row) return null
  if (row[spec.url]) return row[spec.url]
  if (row[spec.id]) return `${JOBBER_BASE}/${spec.path}/${row[spec.id]}`
  return null
}
