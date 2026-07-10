// lib/jobber-contact-writeback.ts
//
// Fetch-at-push contact sync for send-to-jobber (feedback #2/#4).
//
// ClientEditInput dropped the bare `phones`/`emails` fields — updates go
// through phonesToEdit/phonesToAdd (and the emails mirror), each edit keyed
// by the entry's EncodedId. We don't store those ids; instead the client
// search that matches the existing client also returns its phones/emails
// WITH ids, and this module diffs the lead's contact info against them at
// push time.
//
// Rules (approved design):
//   - lead value matches ANY existing entry (normalized) → field omitted
//     entirely: no no-op mutation churn, and no risk of demoting an entry
//     that already carries the value.
//   - lead value present, no match, entries exist → *ToEdit on the primary
//     (else first) entry's id.
//   - lead value present, client has no entries → *ToAdd as primary.
//   - NEVER *ToDelete. Never touch non-primary entries.
//   - lead value empty → field omitted (we never erase Jobber-side data).

export type ContactFieldOutcome = 'updated' | 'added' | 'unchanged' | 'failed'

export interface ContactWriteback {
  phone: ContactFieldOutcome
  email: ContactFieldOutcome
}

export type ContactFieldPlan = 'edit' | 'add' | 'none'

export interface ContactEditPlan {
  phone: ContactFieldPlan
  email: ContactFieldPlan
}

interface JobberPhone { id?: string | null; number?: string | null; primary?: boolean | null }
interface JobberEmail { id?: string | null; address?: string | null; primary?: boolean | null }

// Digits-only comparison key. US country-code prefix is formatting, not
// identity: "+1 (413) 297-8444" and "4132978444" are the same number.
export function normalizePhoneDigits(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D+/g, '')
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
  return digits
}

export function normalizeEmail(raw: string | null | undefined): string {
  return String(raw ?? '').trim().toLowerCase()
}

// Per-field trigger decision for the lead-edit sync (PATCH /api/leads/:id).
// Returns the NEW value to push, or null when the patch must not trigger a
// push for that field: field absent from the patch, non-string (clearing —
// we never delete Jobber-side data), or equal to the stored value after
// normalization (digits-only phones, case-insensitive emails), so a
// formatting-only edit — or a webhook echo re-saving Jobber's own value —
// never reaches the Jobber API.
export interface ContactPatchDiff {
  phone: string | null
  email: string | null
  changed: boolean
}

export function diffContactPatch(
  patch: Record<string, unknown>,
  stored: { phone?: string | null; email?: string | null },
): ContactPatchDiff {
  let phone: string | null = null
  if (typeof patch.phone === 'string') {
    const next = patch.phone.trim()
    const key = normalizePhoneDigits(next)
    if (key && key !== normalizePhoneDigits(stored.phone)) phone = next
  }

  let email: string | null = null
  if (typeof patch.email === 'string') {
    const next = patch.email.trim()
    const key = normalizeEmail(next)
    if (key && key !== normalizeEmail(stored.email)) email = next
  }

  return { phone, email, changed: phone !== null || email !== null }
}

function primaryOrFirst<T extends { primary?: boolean | null }>(entries: T[]): T | undefined {
  return entries.find(e => e.primary) ?? entries[0]
}

export function buildContactEditFields(
  lead: { phone?: string | null; email?: string | null },
  client: { phones?: JobberPhone[] | null; emails?: JobberEmail[] | null },
): { fields: Record<string, any>; plan: ContactEditPlan } {
  const fields: Record<string, any> = {}
  const plan: ContactEditPlan = { phone: 'none', email: 'none' }

  const leadPhone = String(lead.phone ?? '').trim()
  const leadPhoneKey = normalizePhoneDigits(leadPhone)
  const phones = (client.phones ?? []).filter(p => p && String(p.number ?? '').trim())
  if (leadPhone && leadPhoneKey) {
    const alreadyThere = phones.some(p => normalizePhoneDigits(p.number) === leadPhoneKey)
    if (!alreadyThere) {
      const target = primaryOrFirst(phones)
      if (target?.id) {
        fields.phonesToEdit = [{ id: target.id, number: leadPhone }]
        plan.phone = 'edit'
      } else {
        // No entries at all (or, defensively, none carrying an id): add.
        // Primary only when the client had no phone to begin with.
        fields.phonesToAdd = [{ number: leadPhone, primary: phones.length === 0 }]
        plan.phone = 'add'
      }
    }
  }

  const leadEmail = String(lead.email ?? '').trim()
  const leadEmailKey = normalizeEmail(leadEmail)
  const emails = (client.emails ?? []).filter(e => e && String(e.address ?? '').trim())
  if (leadEmail && leadEmailKey) {
    const alreadyThere = emails.some(e => normalizeEmail(e.address) === leadEmailKey)
    if (!alreadyThere) {
      const target = primaryOrFirst(emails)
      if (target?.id) {
        fields.emailsToEdit = [{ id: target.id, address: leadEmail }]
        plan.email = 'edit'
      } else {
        fields.emailsToAdd = [{ address: leadEmail, primary: emails.length === 0 }]
        plan.email = 'add'
      }
    }
  }

  return { fields, plan }
}

// Outcome per field for the route's response payload. A clientEdit that
// comes back with userErrors doesn't say WHICH input field it rejected, so
// every attempted field is reported failed; fields we never attempted stay
// 'unchanged'.
export function resolveContactWriteback(
  plan: ContactEditPlan,
  hadUserErrors: boolean,
): ContactWriteback {
  const resolve = (p: ContactFieldPlan): ContactFieldOutcome => {
    if (p === 'none') return 'unchanged'
    if (hadUserErrors) return 'failed'
    return p === 'edit' ? 'updated' : 'added'
  }
  return { phone: resolve(plan.phone), email: resolve(plan.email) }
}
