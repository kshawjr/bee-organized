// lib/lead-name.ts
//
// THE client-name rails — derivation, trigger decision, and the Jobber
// ClientEditInput diff. Pure module (no I/O), shared by the editor
// (components/hive/shared/NameField), the route (PATCH /api/leads/:id)
// and the tests, so there is exactly ONE place that decides what a
// client's display name is.
//
// ── WHY THREE FIELDS, NOT ONE ────────────────────────────────────────
// leads.name is the DISPLAY value; first_name / last_name / company sit
// alongside it and are the three that map onto Jobber's client
// (firstName, lastName, companyName — SINGLE_CLIENT_QUERY). The editor
// edits the THREE. Splitting one display string back into first/last
// means guessing, and production is full of records that guessing
// mangles — all four of these are real rows, read from the table today:
//
//   "Jerry & Carri Lamb"                  first "Jerry & Carri"              last "Lamb"
//   "Michelle & Josh Lobel"               first "Michelle & Josh"            last "Lobel"
//   "Sue (Jason - House Manager) Loncar"  first "Sue (Jason - House Manager)" last "Loncar"
//   "Deck Construction Group LLC"         first null, last null, company "Deck Construction Group LLC"
//
// ── THE DERIVATION, AND WHY THIS ONE ─────────────────────────────────
//   name = "first last" (the non-empty parts, one space) || company
//
// It is not invented here. It is the rule the Jobber import has always
// used (lib/jobber-import.ts — `${firstName} ${lastName}`.trim() ||
// companyName), so a hub edit and a CLIENT_UPDATE webhook echo compute
// the SAME display name and can never fight each other.
//
// Measured against the whole table before adopting it (41,734 leads):
//   · 40,737 carry a first name, 39,985 a last name
//   · for every row with either, name is ALREADY exactly "first last"
//     — zero rows drift today
//   · 865 carry neither, and all 865 have a company; for every one of
//     them name is ALREADY exactly the company
//   · rows with neither a person name NOR a company: zero
// So this rule reproduces today's stored name for 41,734 of 41,734
// rows. It is a description of the data, not a new policy.
//
// The import's third branch — the literal 'Unknown' — is deliberately
// NOT carried over. Nothing reaches it today (that zero above), and an
// editor that can write "Unknown" onto a real client is a mangler.
// Instead an all-empty save is refused: see nameValidationError.
//
// ── DRIFT IS PREVENTED BY CONSTRUCTION ───────────────────────────────
// The route derives `name` from the parts on every patch that touches
// a part, and overwrites whatever the caller sent for `name`. A caller
// cannot desynchronise them even by trying, so "name and first/last do
// not drift" is a property of the code rather than a rule to remember.

export interface LeadNameParts {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
}

// Collapse internal runs of whitespace and trim the ends. Names are
// case-SIGNIFICANT — unlike an email, "jerry" → "Jerry" is a real
// correction an owner means, so case is never normalized away.
export function normalizeNamePart(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

// The display name. Person name wins over company when present — which
// is what the data already says: "Sue (Jason - House Manager) Loncar"
// carries the company "Sue Loncar" and still displays the person.
export function composeLeadName(parts: LeadNameParts): string {
  const person = [normalizeNamePart(parts.first_name), normalizeNamePart(parts.last_name)]
    .filter(Boolean)
    .join(' ')
  return person || normalizeNamePart(parts.company)
}

// The three parts, normalized, with empties as null — the shape written
// to the row. Only keys present in the patch are returned, so a patch
// that touches one field never blanks the other two.
export function normalizeNamePatch(
  patch: Record<string, unknown>,
): Partial<Record<'first_name' | 'last_name' | 'company', string | null>> {
  const out: Partial<Record<'first_name' | 'last_name' | 'company', string | null>> = {}
  for (const k of ['first_name', 'last_name', 'company'] as const) {
    if (!(k in patch)) continue
    const v = patch[k]
    if (typeof v !== 'string' && v !== null) continue // ignore junk types
    const n = normalizeNamePart(v as string | null)
    out[k] = n || null
  }
  return out
}

export function touchesName(patch: Record<string, unknown>): boolean {
  return 'first_name' in patch || 'last_name' in patch || 'company' in patch
}

// A client must be CALLED something. Every row in the table satisfies
// this today; the editor is not allowed to create the first exception.
// Returns an error string, or null when the parts are acceptable.
export function nameValidationError(parts: LeadNameParts): string | null {
  return composeLeadName(parts)
    ? null
    : 'Enter a first name, last name, or company'
}

// ── the trigger decision: does this patch change the name? ───────────
// Mirrors diffContactPatch (lib/jobber-contact-writeback). Compares the
// MERGED result against what is stored, so a patch that re-sends an
// unchanged value — a webhook echo, a re-save of an untouched field —
// fires nothing. Whitespace-only reshuffles ("Jerry  Lamb" → "Jerry
// Lamb") normalize equal and are not changes.

export type NameField = 'first_name' | 'last_name' | 'company'

export interface NamePatchDiff {
  // The merged parts as they will be stored.
  next: Record<NameField, string>
  prev: Record<NameField, string>
  // Fields this patch really changes.
  changedFields: NameField[]
  changed: boolean
  // The display name before and after.
  display: string
  prevDisplay: string
  // Fields emptied by this patch. Saved here; NEVER pushed as an
  // erasure — the same policy contact and address write-backs follow
  // (we do not delete Jobber-side data). Surfaced, not swallowed.
  clearedFields: NameField[]
}

export function diffNamePatch(
  patch: Record<string, unknown>,
  stored: LeadNameParts,
): NamePatchDiff {
  const norm = normalizeNamePatch(patch)
  const prev: Record<NameField, string> = {
    first_name: normalizeNamePart(stored.first_name),
    last_name: normalizeNamePart(stored.last_name),
    company: normalizeNamePart(stored.company),
  }
  const next: Record<NameField, string> = { ...prev }
  for (const k of ['first_name', 'last_name', 'company'] as const) {
    if (k in norm) next[k] = norm[k] ?? ''
  }

  const changedFields = (['first_name', 'last_name', 'company'] as const)
    .filter(k => next[k] !== prev[k])
  const clearedFields = changedFields.filter(k => !next[k] && prev[k])

  return {
    next,
    prev,
    changedFields: [...changedFields],
    changed: changedFields.length > 0,
    display: composeLeadName(next),
    prevDisplay: composeLeadName(prev),
    clearedFields: [...clearedFields],
  }
}

// ── the Jobber side ──────────────────────────────────────────────────

export type NameFieldOutcome =
  | 'updated'        // pushed and accepted
  | 'unchanged'      // nothing to push, or Jobber already carries it
  | 'kept_in_jobber' // emptied here; left alone there, by policy
  | 'failed'         // pushed and rejected

export interface NameWriteback {
  first_name: NameFieldOutcome
  last_name: NameFieldOutcome
  company: NameFieldOutcome
}

export type NameFieldPlan = 'edit' | 'none' | 'cleared'

export type NameEditPlan = Record<NameField, NameFieldPlan>

const JOBBER_KEY: Record<NameField, 'firstName' | 'lastName' | 'companyName'> = {
  first_name: 'firstName',
  last_name: 'lastName',
  company: 'companyName',
}

interface JobberClientName {
  firstName?: string | null
  lastName?: string | null
  companyName?: string | null
}

// Fetch-at-push diff → ClientEditInput. Rules, matching the contact
// write-back's:
//   · value already equal on the client (normalized) → field omitted,
//     no no-op mutation churn
//   · value present and different → the field is set
//   · value emptied here → field OMITTED (never an erasure), and the
//     plan records 'cleared' so the outcome can say so out loud
export function buildNameEditFields(
  target: Record<NameField, string>,
  cleared: NameField[],
  client: JobberClientName,
): { fields: Record<string, string>; plan: NameEditPlan } {
  const fields: Record<string, string> = {}
  const plan: NameEditPlan = { first_name: 'none', last_name: 'none', company: 'none' }
  const clearedSet = new Set(cleared)

  for (const k of ['first_name', 'last_name', 'company'] as const) {
    const want = normalizeNamePart(target[k])
    if (!want) {
      if (clearedSet.has(k)) plan[k] = 'cleared'
      continue
    }
    const have = normalizeNamePart((client as any)[JOBBER_KEY[k]])
    if (have === want) continue // already there — converge with no mutation
    fields[JOBBER_KEY[k]] = want
    plan[k] = 'edit'
  }

  return { fields, plan }
}

// A clientEdit that comes back with userErrors doesn't say WHICH input
// field it rejected, so every field we attempted is reported failed —
// the same conservative reading resolveContactWriteback uses. Fields we
// never attempted keep their honest non-success outcome.
export function resolveNameWriteback(
  plan: NameEditPlan,
  hadUserErrors: boolean,
): NameWriteback {
  const resolve = (p: NameFieldPlan): NameFieldOutcome => {
    if (p === 'cleared') return 'kept_in_jobber'
    if (p === 'none') return 'unchanged'
    return hadUserErrors ? 'failed' : 'updated'
  }
  return {
    first_name: resolve(plan.first_name),
    last_name: resolve(plan.last_name),
    company: resolve(plan.company),
  }
}

// ── the whole truth, in one phrase ───────────────────────────────────
// THE HONESTY RULE. This is the function the UI and the audit note both
// read, and it is the one thing in this feature that must never lie: a
// name that saved here and was REJECTED by Jobber has to say so. A
// green tick over a half-applied change is how six days went missing on
// the Philly import.
//
//   wb === null  → not linked to Jobber at all (or nothing was pushed)
//   any 'failed' → the failure leads the sentence, and syncFailed() is
//                  true so the caller can refuse to render it as success
//
// Returns the suffix appended to "Name updated". Empty string = there
// is no claim to make, which is itself the honest answer when a linked
// client's Jobber record already carried every value.
export function nameSyncSuffix(wb: NameWriteback | null | undefined): string {
  if (!wb) return ''
  const vals = [wb.first_name, wb.last_name, wb.company]
  const failed = vals.some(v => v === 'failed')
  const updated = vals.some(v => v === 'updated')
  const kept = vals.some(v => v === 'kept_in_jobber')

  if (failed) {
    // Never soften this. Bee Hub saved; Jobber did not.
    return updated
      ? ' · Jobber sync partial — some of the name didn’t save there'
      : ' · Jobber sync failed — saved in Bee Hub only'
  }
  if (updated) {
    return kept
      // The deliberate skip, said out loud — the address field's precedent.
      ? ' · synced to Jobber — the emptied part was left as it was there'
      : ' · synced to Jobber'
  }
  if (kept) return ' · emptied here — left as it was in Jobber'
  return '' // everything already converged — no claim to make
}

// Did any part of the push fail? The UI uses this to choose the toast
// KIND: a failure is never dressed as a success.
export function nameSyncFailed(wb: NameWriteback | null | undefined): boolean {
  if (!wb) return false
  return wb.first_name === 'failed' || wb.last_name === 'failed' || wb.company === 'failed'
}

// The audit-note phrase for a client who isn't in Jobber at all — the
// address route's wording, so the two feeds read alike.
export const NOT_LINKED_NOTE = 'not connected to Jobber — saved here only'
