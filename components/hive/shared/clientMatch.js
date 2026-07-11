// components/hive/shared/clientMatch.js
// ─────────────────────────────────────────────────────────────
// PURE module — the NewClientSheet lookup gate's matching logic.
// Two layers, both anti-dupe:
//
//   matchPeople()      — as-you-type matching over the ALREADY-LOADED
//                        people prop (the full service-role-loaded,
//                        non-junk universe _hub-page ships). Phone is
//                        normalized to digits IN JS here, so it matches
//                        regardless of how the row stored it
//                        ("561-555-0199" vs "5615550199").
//   queryLeadMatches() — the authoritative DB re-check right before
//                        insert, catching rows created after page load.
//                        Takes the supabase client as an ARG (never
//                        imports one — this module stays pure per §8.5).
//
// PHONE-STORAGE NOTE (2026-07-04, updated same day post-migration):
// leads.phone is mixed free-text — bare digits, formatted
// ("###-###-####"), some with inline text ("3039949176 (stuart)").
// leads.phone_normalized now exists: a GENERATED digits-only column,
// indexed — the DB-side gate matches phone_normalized.eq and covers
// every storage shape; never match raw phone DB-side. Because the
// column is generated, NEVER include phone_normalized in an insert or
// update payload — Postgres computes it and an explicit write errors.
// matchPeople() still normalizes in JS: the loaded people prop carries
// raw phone.
//
// Standing bug patterns applied (do not "simplify" these away):
//   - .or() built ONLY from keys that exist — never email.eq.null or
//     an empty phone.
//   - junk exclusion is .not('is_junk','is',true) — `.eq('is_junk',
//     false)` does NOT match NULL (Jobber-imported rows leave it unset).
//   - .range(0,999) always — a bare .select() silently truncates at
//     1000 rows.
// ─────────────────────────────────────────────────────────────

export const normalizeEmail = (s) => (s || '').trim().toLowerCase()
export const normalizePhone = (s) => (s || '').replace(/\D/g, '')

// Masked display for the "matched on <field>" line — enough to confirm
// it's them, without printing the full value back.
export function maskPhone(raw) {
  let d = normalizePhone(raw)
  if (!d) return ''
  const us = d.length === 11 && d.startsWith('1')
  if (us) d = d.slice(1)
  if (d.length < 7) return `${d.slice(0, 3)}···`
  const body = `${d.slice(0, 3)}···${d.slice(-4)}`
  return d.length === 10 ? `+1 ${body}` : body
}

export function maskEmail(raw) {
  const e = normalizeEmail(raw)
  if (!e) return ''
  const at = e.indexOf('@')
  if (at <= 0) return e
  return `${e[0]}···${e.slice(at)}`
}

// As-you-type matcher over the loaded people prop. Same semantics the
// classic NewLeadModal lookup used: exact email when the query has an
// '@', digits-contains when it has ≥7 digits, name-contains otherwise.
// Junk rows are excluded ONLY when is_junk is affirmatively true —
// NULL/undefined stays in (the NULL-equality gotcha, JS edition).
// Returns [{ person, matchedOn, matchedValue }] ranked email > phone >
// name, one row per person.
export function matchPeople(people, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return []
  const qDigits = q.replace(/\D/g, '')
  const isEmailQ = q.includes('@')
  const isPhoneQ = !isEmailQ && qDigits.length >= 7
  const isNameQ = !isEmailQ && !isPhoneQ && q.length >= 2

  const hits = []
  for (const p of people || []) {
    if (p?.isJunk === true) continue
    if (isEmailQ && normalizeEmail(p.email) && normalizeEmail(p.email) === q) {
      hits.push({ person: p, matchedOn: 'email', matchedValue: maskEmail(p.email), rank: 0 })
    } else if (isPhoneQ && normalizePhone(p.phone) && normalizePhone(p.phone).includes(qDigits)) {
      hits.push({ person: p, matchedOn: 'phone', matchedValue: maskPhone(p.phone), rank: 1 })
    } else if (isNameQ && (p.name || '').toLowerCase().includes(q)) {
      hits.push({ person: p, matchedOn: 'name', matchedValue: p.name, rank: 2 })
    }
  }
  hits.sort((a, b) => a.rank - b.rank)
  const seen = new Set()
  return hits.filter(h => {
    if (!h.person?.id || seen.has(h.person.id)) return false
    seen.add(h.person.id)
    return true
  })
}

// The .or() filter string for the authoritative DB gate — built ONLY
// from keys that actually exist. Returns null when there is no usable
// key (never emit email.eq.null / phone_normalized.eq.). Values are
// quoted so a stray comma or paren can't break the PostgREST filter
// grammar. Phone matches against phone_normalized (generated,
// digits-only) so every storage shape of leads.phone is covered.
export function buildLeadMatchOr({ email, phone } = {}) {
  const parts = []
  const e = normalizeEmail(email)
  const d = normalizePhone(phone)
  if (e) parts.push(`email.eq."${e.replace(/"/g, '')}"`)
  if (d) parts.push(`phone_normalized.eq."${d}"`)
  return parts.length ? parts.join(',') : null
}

// Authoritative pre-insert gate. `supabase` is passed in by the caller.
// Resolves to matching rows ([] when there is nothing to match on).
// Errors propagate — the caller decides how a failed re-check degrades
// (the people-prop gate has already run by then).
export async function queryLeadMatches(supabase, { email, phone, locationUuid } = {}) {
  const orFilter = buildLeadMatchOr({ email, phone })
  if (!orFilter) return []
  let q = supabase
    .from('leads')
    .select('id, name, email, phone, phone_normalized, address, city, state, zip, project_type, request_details, preferred_contact, stage, is_junk, location_uuid, created_at')
    .or(orFilter)
    .not('is_junk', 'is', true)
    .range(0, 999)
  if (locationUuid && locationUuid !== 'all') q = q.eq('location_uuid', locationUuid)
  const { data, error } = await q
  if (error) throw new Error(error.message || 'lead match query failed')
  return data || []
}

// Confidence-tier evaluation for the NO-HUMAN-PRESENT intake path
// (webform). `rows` are queryLeadMatches() results (they carry
// phone_normalized). Tiers:
//   solid       — a strong key (email or phone_normalized) resolves to
//                 EXACTLY ONE lead → safe to auto-merge.
//   in_question — a strong key matches more than one lead, OR the two
//                 keys point at different leads (conflicting signal).
//                 Never auto-merge; the caller creates + flags.
//   none        — no strong-key hit. Name matching is the CALLER's
//                 follow-up and can only ever reach in_question.
export function classifyLeadMatches(rows, { email, phone } = {}) {
  const e = normalizeEmail(email)
  const d = normalizePhone(phone)
  const emailIds = new Set()
  const phoneIds = new Set()
  const byId = new Map()
  for (const r of rows || []) {
    if (!r?.id) continue
    byId.set(r.id, r)
    // Re-verify per key: guards against a NULL/empty stored value ever
    // reading as a hit, and attributes WHICH key matched.
    if (e && normalizeEmail(r.email) === e) emailIds.add(r.id)
    if (d && (r.phone_normalized || '') === d) phoneIds.add(r.id)
  }
  const union = new Set([...emailIds, ...phoneIds])
  if (union.size === 0) return { tier: 'none' }
  if (emailIds.size > 1 || phoneIds.size > 1) {
    return { tier: 'in_question', matchIds: [...union], reason: 'strong_key_multiple' }
  }
  if (union.size > 1) {
    return { tier: 'in_question', matchIds: [...union], reason: 'conflicting_keys' }
  }
  const id = [...union][0]
  const matchedOn = emailIds.has(id)
    ? (phoneIds.has(id) ? 'email+phone' : 'email')
    : 'phone'
  return { tier: 'solid', match: byId.get(id), matchedOn }
}
