// lib/network/bulk.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture, slice 6 — BULK ACTIONS on the list. Pure: it decides,
// from the rows as stored, exactly what one bulk action writes. The route
// (app/api/network/contacts/bulk) reads, asks this, and writes.
//
// FOUR ACTIONS, nothing else (Kevin's slice 6 brief):
//   tag_add      put one of this location's Network tags on every contact
//   tag_remove   take that tag off every contact that has it
//   level        set a Referral partner's level
//   stage        set a Referral partner's stage
// Mailchimp, drips and campaigns are NOT here: consent is slice 8.
// FOLLOW-UPS ARE NOT HERE, on purpose: a follow-up is one person's reminder
// with its own date and note, and twenty identical ones would bury the
// Reminders page. They stay one at a time, from the contact sheet.
//
// THE RULES:
//   · ASKED ONCE. The route refuses any bulk action without confirmed: true,
//     before it writes anything. The screen asks once for the whole
//     selection, never once per contact.
//   · ONE LOCATION. Every contact must be live and at the location named;
//     one that is not refuses the whole action, nothing written.
//   · ONLY WHAT CHANGES. A contact that already has the level, stage or tag
//     (or, to remove, does not have it) is left alone and counted as
//     unchanged. A level or stage is offered on Referral partners only:
//     anyone else in the selection is skipped and named, never changed.
//     Nothing stored reads as Potential / New Contact (lib/network/types.ts),
//     so setting that on them writes nothing.
//   · ONE STATEMENT per action: one update, one insert or one delete. Postgres
//     runs a single statement all or nothing.
// ─────────────────────────────────────────────────────────────

import { DEFAULT_PARTNER_LEVEL, DEFAULT_PARTNER_STAGE, PARTNER_LEVELS, PARTNER_STAGES, LEVEL_META } from './types'

export const BULK_ACTIONS = ['tag_add', 'tag_remove', 'level', 'stage'] as const
export type BulkAction = (typeof BULK_ACTIONS)[number]
export const BULK_MAX = 500

export type BulkRow = { id: string; name?: string | null; location_id: string; deleted_at?: string | null; network_types?: string[] | null; partner_level?: string | null; partner_stage?: string | null }
export type BulkLink = { partner_id: string; tag_lookup_id: string }

export type BulkPlan =
  | { ok: false; status: 400 | 404 | 422 | 428; error: string }
  | {
      ok: true
      action: BulkAction
      /** Contacts this action really changes. */
      changeIds: string[]
      /** level/stage: the one column and value written to every changeId. */
      update?: { column: 'partner_level' | 'partner_stage'; value: string }
      /** tag_add: the links inserted; tag_remove: the tag taken off changeIds. */
      tagId?: string
      unchanged: number
      /** Left alone and named: not a Referral partner (level/stage only). */
      skipped: { id: string; name: string; reason: 'not_a_referral_partner' }[]
    }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isPartner = (r: BulkRow) => Array.isArray(r.network_types) && r.network_types.includes('partner')

/** Check the request itself, before anything is read. */
export function checkBulkRequest(body: any): { ok: true; ids: string[]; action: BulkAction; value: string } | { ok: false; status: 400 | 428; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, status: 400, error: 'invalid_body' }
  const { ids, action, value } = body
  if (!BULK_ACTIONS.includes(action)) return { ok: false, status: 400, error: 'action_unknown' }
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, status: 400, error: 'pick_someone_first' }
  if (ids.length > BULK_MAX) return { ok: false, status: 400, error: 'too_many_at_once' }
  if (ids.some((id) => typeof id !== 'string' || !UUID.test(id))) return { ok: false, status: 400, error: 'contact_not_found' }
  if (typeof value !== 'string' || !value) return { ok: false, status: 400, error: 'value_required' }
  if (action === 'level' && !(PARTNER_LEVELS as readonly string[]).includes(value)) return { ok: false, status: 400, error: 'level_unknown' }
  if (action === 'stage' && !(PARTNER_STAGES as readonly string[]).includes(value)) return { ok: false, status: 400, error: 'stage_unknown' }
  if ((action === 'tag_add' || action === 'tag_remove') && !UUID.test(value)) return { ok: false, status: 400, error: 'tag_not_on_network_here' }
  // Asked once, for the whole selection. Without it, nothing is read or written.
  if (body.confirmed !== true) return { ok: false, status: 428, error: 'needs_confirmation' }
  return { ok: true, ids: Array.from(new Set(ids as string[])), action, value }
}

/**
 * Plan one bulk action against the rows as stored now.
 *   rows        the partners named, as read (id, name, location, types, level, stage)
 *   links       their existing partner_tags rows for the tag (tag actions only)
 *   allowedTags this location's Network tag ids (tag actions only)
 */
export function planBulk(
  req: { ids: string[]; action: BulkAction; value: string },
  ctx: { locationId: string; rows: readonly BulkRow[]; links?: readonly BulkLink[]; allowedTagIds?: readonly string[] },
): BulkPlan {
  const byId = new Map(ctx.rows.map((r) => [r.id, r]))
  for (const id of req.ids) {
    const r = byId.get(id)
    if (!r || r.deleted_at) return { ok: false, status: 404, error: 'contact_not_found' }
    if (r.location_id !== ctx.locationId) return { ok: false, status: 422, error: 'not_all_at_this_location' }
  }
  const rows = req.ids.map((id) => byId.get(id)!)
  const name = (r: BulkRow) => String(r.name || '').trim() || 'Unnamed'

  if (req.action === 'level' || req.action === 'stage') {
    const column = req.action === 'level' ? 'partner_level' : 'partner_stage'
    const fallback = req.action === 'level' ? DEFAULT_PARTNER_LEVEL : DEFAULT_PARTNER_STAGE
    const known = (req.action === 'level' ? PARTNER_LEVELS : PARTNER_STAGES) as readonly string[]
    const skipped: { id: string; name: string; reason: 'not_a_referral_partner' }[] = []
    const changeIds: string[] = []
    let unchanged = 0
    for (const r of rows) {
      if (!isPartner(r)) { skipped.push({ id: r.id, name: name(r), reason: 'not_a_referral_partner' }); continue }
      const stored = known.includes(String(r[column] ?? '')) ? String(r[column]) : fallback
      if (stored === req.value) unchanged++
      else changeIds.push(r.id)
    }
    return { ok: true, action: req.action, changeIds, update: { column, value: req.value }, unchanged, skipped }
  }

  if (!(ctx.allowedTagIds || []).includes(req.value)) return { ok: false, status: 422, error: 'tag_not_on_network_here' }
  const has = new Set((ctx.links || []).filter((l) => l.tag_lookup_id === req.value).map((l) => l.partner_id))
  const changeIds = rows.filter((r) => (req.action === 'tag_add' ? !has.has(r.id) : has.has(r.id))).map((r) => r.id)
  return { ok: true, action: req.action, changeIds, tagId: req.value, unchanged: rows.length - changeIds.length, skipped: [] }
}

/** The words the confirmation uses for an action, e.g. "Set the stage to Reaching Out". */
export function bulkActionWords(action: BulkAction, valueLabel: string): string {
  if (action === 'level') return `Set the level to ${valueLabel}`
  if (action === 'stage') return `Move to ${valueLabel}`
  if (action === 'tag_add') return `Add the tag ${valueLabel}`
  return `Take off the tag ${valueLabel}`
}

export const levelWord = (v: string) => LEVEL_META[v as keyof typeof LEVEL_META]?.label || v

export const BULK_ERROR_WORDS: Record<string, string> = {
  needs_confirmation: 'That change needs confirming first. Nothing was changed.',
  pick_someone_first: 'Pick at least one contact first.',
  too_many_at_once: `Change ${BULK_MAX} contacts or fewer at once.`,
  not_all_at_this_location: 'Some of those contacts are at another location. Nothing was changed.',
  contact_not_found: 'One of those contacts was removed meanwhile. Nothing was changed; the list has been reloaded.',
  tag_not_on_network_here: 'That tag is not on this location’s Network list. Nothing was changed.',
}
