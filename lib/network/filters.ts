// lib/network/filters.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 1 — who shows, in what order. Pure.
// Ported from the design's network-filters.ts. Nothing here depends on the
// old types, so the rules are the design's own:
//
//   Needs follow-up — a follow-up date that is today or past. With no date
//                     set, a relationship that has gone quiet (60 days, or
//                     never contacted). A FUTURE date wins over quiet: the
//                     owner has already said when they will be in touch.
//   Birthdays       — month and day only ("Mar 22"), never a year.
//   Gift earned     — three or more referrals.
// ─────────────────────────────────────────────────────────────

import { isCold, isOrganization, type NetContact } from './types'

/** Scheduled follow-ups take priority; otherwise surface quiet relationships. `today` is an ISO date. */
export function needsFollowUp(c: Pick<NetContact, 'nextFollowUp' | 'lastTalkedDays'>, today: string): boolean {
  return c.nextFollowUp ? c.nextFollowUp <= today : isCold(c)
}

/** The second line of a list row: role, company, people count. Never repeats the name or a tag already shown. */
export function contactSecondaryDetails(c: Pick<NetContact, 'name' | 'tags' | 'role' | 'company' | 'people' | 'types'>): string[] {
  const seen = new Set([c.name, ...c.tags].map((value) => value.trim().toLowerCase()))
  return [c.role, c.company, isOrganization(c) && c.people ? `${c.people} ${c.people === 1 ? 'person' : 'people'}` : undefined]
    .filter((value): value is string => {
      if (!value) return false
      const normalized = value.trim().toLowerCase()
      if (seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Days from today until the next birthday (stored like "Mar 22"); null when unknown. */
export function daysUntilBirthday(c: Pick<NetContact, 'birthday'>, today: Date): number | null {
  const m = c.birthday?.trim().match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})$/i)
  if (!m) return null
  const month = MONTHS.indexOf(m[1]!.toLowerCase())
  if (month < 0) return null
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  let next = new Date(start.getFullYear(), month, Number(m[2]))
  if (next < start) next = new Date(start.getFullYear() + 1, month, Number(m[2]))
  return Math.round((next.getTime() - start.getTime()) / 86400000)
}

export function birthdayThisMonth(c: Pick<NetContact, 'birthday'>, today: Date): boolean {
  const m = c.birthday?.trim().slice(0, 3).toLowerCase()
  return !!m && MONTHS.indexOf(m) === today.getMonth()
}

/** A partner who has sent this many leads has earned a gift. */
export const GIFT_REFERRALS = 3
export const giftEarned = (c: Pick<NetContact, 'referred'>) => c.referred >= GIFT_REFERRALS

export type ContactSort = 'az' | 'referrals' | 'recent' | 'quiet' | 'birthday' | 'newest'

/** A sorted COPY. `newest` trusts the list to arrive oldest-first and flips it. */
export function sortContacts<C extends NetContact>(list: readonly C[], sort: ContactSort, today: Date): C[] {
  const byName = (a: C, b: C) => a.name.localeCompare(b.name)
  const r = [...list]
  if (sort === 'referrals') return r.sort((a, b) => b.referred - a.referred || b.revenue - a.revenue || byName(a, b))
  if (sort === 'quiet') return r.sort((a, b) => (b.lastTalkedDays ?? 9999) - (a.lastTalkedDays ?? 9999) || byName(a, b))
  if (sort === 'recent') return r.sort((a, b) => (a.lastTalkedDays ?? 9999) - (b.lastTalkedDays ?? 9999) || byName(a, b))
  if (sort === 'birthday') return r.sort((a, b) => (daysUntilBirthday(a, today) ?? 9999) - (daysUntilBirthday(b, today) ?? 9999) || byName(a, b))
  if (sort === 'newest') return r.reverse()
  return r.sort(byName)
}
