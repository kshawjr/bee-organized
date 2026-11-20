// lib/network/nurturing-actions.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 8 — WHAT CAN BE DONE TO NURTURING
// PEOPLE, and the rules for doing it. Three actions, nothing else (Kevin,
// 2026-11-20): tags (one person or in bulk), a follow-up (a reminder, one
// person at a time), and the link to the full client record (no write).
//
// NOTHING HERE CAN SEND AN EMAIL. A tag is a lead_tags row and a follow-up
// is a reminders row. No trigger sits on either table (checked 2026-11-20),
// no sending module is imported here or by the routes that use this file,
// and lib/network/nurturing-actions.test.ts pins that by fingerprint. (The
// Mailchimp "Sync now" button does read lead tags, but only at a location
// switched live by hand, only when someone presses it, and it sends nothing
// itself. One location is switched live today.)
//
// SAID NO TO MARKETING: marketing_opt_out, or marketing_unsubscribed_at set.
// Those people are left out of EVERY action here, always. There is no flag,
// role or argument that lets anyone act on them anyway: the check is
// `saidNoToMarketing`, it takes the person and nothing else, and every write
// path calls it on the server.
//
// A BULK TAG IS ALL OR NOTHING. It writes in chunks; if a chunk fails, every
// row this run already wrote is taken back out (or, for a removal, put back
// exactly as it was, with its original date and who added it). The answer
// then says nothing changed. If even the taking-back fails, the answer names
// how many people are left changed, so the state can always be described.
// There is no database transaction (that would need a migration); this is
// the same save-then-undo Kevin accepted for the Network import.
// ─────────────────────────────────────────────────────────────

export const BULK_CHUNK = 500

/** The one hard rule. Takes the person, nothing else: there is no override. */
export function saidNoToMarketing(lead: { marketing_opt_out?: boolean | null; marketing_unsubscribed_at?: string | null; noMarketing?: boolean }): boolean {
  if (lead.noMarketing === true) return true
  return lead.marketing_opt_out === true || !!lead.marketing_unsubscribed_at
}

export type BulkTagAction = 'tag_add' | 'tag_remove'
export const isBulkTagAction = (a: unknown): a is BulkTagAction => a === 'tag_add' || a === 'tag_remove'

const people = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}`

/** The confirmation's question. It always names the number. */
export function bulkTagQuestion(action: BulkTagAction, label: string, n: number): string {
  return action === 'tag_add' ? `Add “${label}” to ${people(n)}?` : `Take “${label}” off ${people(n)}?`
}

export type BulkTagPlan = {
  /** everyone the selection names who is Nurturing here */
  selected: number
  /** left out: said no to marketing */
  noMarketing: string[]
  /** left out: already as asked (has the tag / does not have it) */
  already: string[]
  /** these change */
  change: string[]
  /** named in the selection but not Nurturing at this location (any more) */
  notNurturing: number
}

/** Who a bulk tag would change. Pure. */
export function planBulkTag(args: {
  action: BulkTagAction
  targets: { id: string; noMarketing: boolean }[]
  haveTag: ReadonlySet<string>
  notNurturing?: number
}): BulkTagPlan {
  const noMarketing: string[] = []
  const already: string[] = []
  const change: string[] = []
  for (const t of args.targets) {
    if (saidNoToMarketing(t)) noMarketing.push(t.id)
    else if (args.action === 'tag_add' ? args.haveTag.has(t.id) : !args.haveTag.has(t.id)) already.push(t.id)
    else change.push(t.id)
  }
  return { selected: args.targets.length, noMarketing, already, change, notNurturing: args.notNurturing ?? 0 }
}

/** The lines under the question: who is left out, and why. */
export function bulkTagLeftOut(action: BulkTagAction, plan: BulkTagPlan): string[] {
  const out: string[] = []
  if (plan.noMarketing.length) out.push(`${people(plan.noMarketing.length)} who said no to marketing ${plan.noMarketing.length === 1 ? 'is' : 'are'} left out. Nobody can change that from here.`)
  if (plan.already.length) out.push(`${people(plan.already.length)} ${action === 'tag_add' ? 'already have it' : 'don’t have it'}, so ${plan.already.length === 1 ? 'is' : 'are'} left as ${plan.already.length === 1 ? 'it is' : 'they are'}.`)
  if (plan.notNurturing) out.push(`${people(plan.notNurturing)} ${plan.notNurturing === 1 ? 'is' : 'are'} no longer Nurturing here, so ${plan.notNurturing === 1 ? 'is' : 'are'} left out.`)
  return out
}

export type LinkRow = { lead_id: string; tag_lookup_id: string; added_at?: string | null; added_by?: string | null }
type Db = { from: (table: string) => any }

export type BulkTagOutcome =
  | { ok: true; changed: number }
  | { ok: false; error: string; state: 'nothing_changed' | 'partly_changed'; wrote: number; undone: number; leftChanged: string[] }

const chunks = <T,>(xs: T[], n = BULK_CHUNK): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/**
 * Do it, all or nothing. `before` is the rows as they stood for a removal
 * (so they can be put back exactly).
 */
export async function runBulkTag(db: Db, args: { action: BulkTagAction; tagId: string; ids: string[]; by: string; before?: LinkRow[] }): Promise<BulkTagOutcome> {
  const done: string[] = []
  const parts = chunks(args.ids)
  let failure: string | null = null
  for (const part of parts) {
    const res = args.action === 'tag_add'
      ? await db.from('lead_tags').upsert(part.map((id) => ({ lead_id: id, tag_lookup_id: args.tagId, added_by: args.by })), { onConflict: 'lead_id,tag_lookup_id', ignoreDuplicates: true })
      : await db.from('lead_tags').delete().eq('tag_lookup_id', args.tagId).in('lead_id', part)
    if (res?.error) { failure = res.error.message || 'write_failed'; break }
    done.push(...part)
  }
  if (!failure) return { ok: true, changed: args.ids.length }

  // Take it back, chunk by chunk, so one bad chunk of the undo does not stop the rest.
  const left: string[] = []
  const before = new Map((args.before || []).map((r) => [r.lead_id, r]))
  for (const part of chunks(done)) {
    const res = args.action === 'tag_add'
      ? await db.from('lead_tags').delete().eq('tag_lookup_id', args.tagId).in('lead_id', part)
      : await db.from('lead_tags').upsert(part.map((id) => {
        const r = before.get(id)
        return { lead_id: id, tag_lookup_id: args.tagId, added_at: r?.added_at ?? undefined, added_by: r?.added_by ?? null }
      }), { onConflict: 'lead_id,tag_lookup_id', ignoreDuplicates: true })
    if (res?.error) left.push(...part)
  }
  return {
    ok: false, error: failure,
    state: left.length ? 'partly_changed' : 'nothing_changed',
    wrote: done.length, undone: done.length - left.length, leftChanged: left,
  }
}

/** What the owner reads when it fails. */
export function bulkTagFailureWords(action: BulkTagAction, label: string, o: Extract<BulkTagOutcome, { ok: false }>): string {
  if (o.state === 'nothing_changed') {
    return `That didn’t finish, so nothing was changed: the ${o.wrote.toLocaleString('en-US')} already done were put back. Check the connection and try again.`
  }
  return `That didn’t finish, and ${people(o.leftChanged.length)} could not be put back: ${action === 'tag_add' ? `they still have “${label}”` : `they no longer have “${label}”`}. Run the same action again to finish it for everyone.`
}
