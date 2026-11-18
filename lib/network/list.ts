// lib/network/list.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 3 — the Network LIST's own rules. Pure:
// no fetch, no React. The screen (components/network/NetworkListScreen.jsx)
// and the route (app/api/network/list) both stand on this file.
//
// It writes no rule a second time. Types, levels, stages, sorting, paging
// and "what is a Referral partner" all come from the slice 1 files beside
// it. What is new here is only what a LIST needs:
//
//   contactFromRow    a stored partners row → the contact the rules work on
//   matchesSearch     name, company, email, phone
//   applyListFilters  type · partner level · partner stage · tag · follow-up
//   typeCounts        the number on each type pill
//   dueForFollowUp    the "Needs follow-up" view
//
// NEEDS FOLLOW-UP IS REMINDERS ONLY (slice 3 brief: "using the existing
// reminders"). A contact needs follow-up when it has an open reminder due
// today or earlier. The design's wider rule (lib/network/filters.ts
// needsFollowUp: no reminder + nothing logged for 60 days, or nothing logged
// ever) is deliberately NOT used for this view: only 27 of the 263 live
// contacts have a logged contact at all, so it would list about nine in ten
// of them on day one. It is still there, tested, for whenever Kevin wants it.
//
// A row whose network_types is empty reads as Not sure yet (normalizeTypes),
// so a contact added by the old doors after the backfill still lists.
// ─────────────────────────────────────────────────────────────

import { phoneKey } from '@/lib/phone'
import {
  NET_TYPES, PARTNER_LEVELS, PARTNER_STAGES, hasType, normalizeTypes, partnerLevel, partnerStage,
  type NetContact, type NetType, type PartnerLevel, type PartnerStage,
} from './types'

/** One contact as /api/network/list sends it. Plain data, no rules applied yet. */
export type NetworkListRow = {
  id: string
  locationId: string
  locationName?: string | null
  name: string
  company?: string | null
  title?: string | null
  phone?: string | null
  email?: string | null
  howWeMet?: string | null
  /** Month and day, like "Mar 22" (slice 5: read for the export). */
  birthday?: string | null
  /** partners.network_types, as stored. */
  networkTypes?: readonly string[] | null
  /** partners.partner_level, as stored. */
  partnerLevel?: string | null
  /** partners.partner_stage, as stored. */
  partnerStage?: string | null
  tagIds?: readonly string[] | null
  /** ISO time of the last logged contact, or null when nothing is logged. */
  lastContactedAt?: string | null
  /** Also a client in Bee Hub (partners.is_customer). */
  isCustomer?: boolean | null
}

/** A contact on the list: the slice 1 contact, plus what only the list shows. */
export type ListContact = NetContact & {
  locationId: string
  locationName: string
  tagIds: string[]
  isCustomer: boolean
}

export type RowContext = {
  /** A tag id → its name. Unknown ids are left out rather than shown as an id. */
  tagLabel: (id: string) => string | null | undefined
  /** The contact's soonest open reminder date (ISO), if it has one. */
  nextFollowUp?: string | null
  /** Real referral numbers for this contact (lib/referral-rollup), if known. */
  referral?: { count?: number; converted?: number; revenue?: number } | null
  /** "Now", in ms. Passed in so the answer never depends on when a test runs. */
  nowMs: number
}

const DAY_MS = 86_400_000
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Whole days since `iso`; null when there is no date or it cannot be read. */
export function daysSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS))
}

/** A stored row → the contact every rule in lib/network/ works on. */
export function contactFromRow(row: NetworkListRow, ctx: RowContext): ListContact {
  const types = normalizeTypes(row.networkTypes)
  const isPartner = types.includes('partner')
  const level = PARTNER_LEVELS.find((l) => l === row.partnerLevel)
  const stage = PARTNER_STAGES.find((s) => s === row.partnerStage)
  const tagIds = (row.tagIds || []).filter((id): id is string => typeof id === 'string' && !!id)
  const named = tagIds.map((id) => ({ id, label: text(ctx.tagLabel(id)) })).filter((t) => t.label)
  return {
    id: row.id,
    name: text(row.name) || 'Unnamed',
    types,
    // Read through the slice 1 helpers, so a level or stage stored on someone
    // who is not a Referral partner never shows.
    level: partnerLevel({ types, level: isPartner ? level : undefined }) ?? undefined,
    stage: partnerStage({ types, stage: isPartner ? stage : undefined }) ?? undefined,
    tags: named.map((t) => t.label as string).sort((a, b) => a.localeCompare(b)),
    tagIds: named.map((t) => t.id),
    role: text(row.title),
    company: text(row.company),
    phone: text(row.phone),
    email: text(row.email),
    howMet: text(row.howWeMet),
    birthday: text(row.birthday),
    referred: Number(ctx.referral?.count) || 0,
    converted: Number(ctx.referral?.converted) || 0,
    revenue: Number(ctx.referral?.revenue) || 0,
    lastTalkedDays: daysSince(row.lastContactedAt, ctx.nowMs),
    nextFollowUp: text(ctx.nextFollowUp),
    mailchimp: { on: false },
    locationId: row.locationId,
    locationName: text(row.locationName) || '',
    isCustomer: row.isCustomer === true,
  }
}

// ── Search ───────────────────────────────────────────────────
const lower = (v: unknown) => String(v ?? '').toLowerCase()

/**
 * Name, company, email and phone. Words match anywhere, any case. A phone
 * matches on its digits, so "303-555" finds "(303) 555-0142"; that needs at
 * least three digits and nothing but phone punctuation in the box, so a
 * number inside a name ("Studio 54") is still searched as words.
 */
export function matchesSearch(c: Pick<NetContact, 'name' | 'company' | 'email' | 'phone'>, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if ([c.name, c.company, c.email].some((v) => lower(v).includes(q))) return true
  if (!c.phone) return false
  const digits = q.replace(/\D/g, '')
  if (digits.length < 3 || !/^[\d\s().+\-]+$/.test(q)) return false
  return phoneKey(c.phone).includes(digits) || c.phone.replace(/\D/g, '').includes(digits)
}

// ── Needs follow-up ──────────────────────────────────────────
/** An open reminder due today or earlier. `today` is an ISO date (YYYY-MM-DD). */
export function dueForFollowUp(c: Pick<NetContact, 'nextFollowUp'>, today: string): boolean {
  return !!c.nextFollowUp && c.nextFollowUp <= today
}

// ── Filters ──────────────────────────────────────────────────
export type ListFilters = {
  q: string
  /** One type, or everyone. */
  type: NetType | 'all'
  /** Any of these levels. Picking one narrows the list to Referral partners. */
  levels: PartnerLevel[]
  /** Any of these stages. Picking one narrows the list to Referral partners. */
  stages: PartnerStage[]
  /** Any of these tags (tag ids). */
  tagIds: string[]
  followUp: boolean
}

export const NO_FILTERS: ListFilters = { q: '', type: 'all', levels: [], stages: [], tagIds: [], followUp: false }

/** How many choices are on inside the Filters menu (its badge). */
export const menuFilterCount = (f: ListFilters) => f.levels.length + f.stages.length + (f.followUp ? 1 : 0)

/** True when anything at all narrows the list. */
export const anyFilterOn = (f: ListFilters) =>
  f.type !== 'all' || menuFilterCount(f) > 0 || f.tagIds.length > 0 || f.q.trim() !== ''

export function applyListFilters<C extends ListContact>(list: readonly C[], f: ListFilters, today: string): C[] {
  return list.filter((c) => {
    if (f.type !== 'all' && !hasType(c, f.type)) return false
    if (f.levels.length) { const l = partnerLevel(c); if (!l || !f.levels.includes(l)) return false }
    if (f.stages.length) { const s = partnerStage(c); if (!s || !f.stages.includes(s)) return false }
    if (f.tagIds.length && !f.tagIds.some((id) => c.tagIds.includes(id))) return false
    if (f.followUp && !dueForFollowUp(c, today)) return false
    return matchesSearch(c, f.q)
  })
}

/** The number on each type pill. A contact with two types counts under both. */
export function typeCounts(list: readonly Pick<NetContact, 'types'>[]): Record<NetType | 'all', number> {
  const out = { all: list.length } as Record<NetType | 'all', number>
  for (const t of NET_TYPES) out[t] = list.filter((c) => hasType(c, t)).length
  return out
}

/** Tags in use on these contacts, with how many carry each, by name. */
export function tagsInUse(list: readonly ListContact[], tagLabel: (id: string) => string | null | undefined) {
  const n = new Map<string, number>()
  for (const c of list) for (const id of c.tagIds) n.set(id, (n.get(id) || 0) + 1)
  return Array.from(n, ([id, count]) => ({ id, label: text(tagLabel(id)) || '', count }))
    .filter((t) => t.label)
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * The list in the design's default layout: one group per type, in the type
 * order, each holding its contacts A to Z. A contact with two types is in
 * both groups. Picking one type shows that type's group alone. Searching,
 * filtering by tag, or asking for Needs follow-up flattens it to one list, so
 * a match is never hidden inside a closed group. (The design flattens for
 * search and tags; follow-up was added after the first screenshots showed
 * "5 matching" above a single visible row.)
 */
export function groupForList<C extends ListContact>(list: readonly C[], f: ListFilters): { type: NetType | null; contacts: C[] }[] {
  const az = (a: C, b: C) => a.name.localeCompare(b.name)
  if (f.q.trim() || f.tagIds.length || f.followUp) return [{ type: null, contacts: [...list].sort(az) }]
  // One type picked: that type's group alone, so a contact who is also
  // something else is not listed a second time under a heading nobody asked for.
  const types = f.type === 'all' ? NET_TYPES : [f.type]
  return types.map((type) => ({ type, contacts: list.filter((c) => hasType(c, type)).sort(az) }))
}
