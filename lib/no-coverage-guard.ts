// lib/no-coverage-guard.ts
// ─────────────────────────────────────────────────────────────
// May Bee Hub tell this customer "we don't serve your area"? (Kevin, 20 Oct
// 2026.) Of the 8 no-coverage emails ever sent, 3 went to zips on a
// franchise's list and 7 were within 75 miles of a hive — because only the
// Slack button checked anything. This is the ONE check, run inside
// lib/lead-no-coverage.ts closeLeadAsNoCoverage, which every door goes
// through (the Inbox's No coverage modal → the API route, and the Slack
// button), so no door can skip it.
//
// THE VERDICTS
//   blocked  — the zip is on a location's list. That IS their territory.
//              Refused, from any door, with no override. The claimants are
//              named so the person can route there instead.
//   confirm  — no claim, but a hive that takes leads is within 75 measured
//              miles (the miles as shown, rounded — the same line the Slack
//              card uses). Not blocked: 70 miles may genuinely be out of
//              range. The person must confirm with the hive and the number in
//              front of them.
//   unmeasured — Bee Hub can't place the customer (no zip, a zip that isn't
//              five digits, a zip the Census doesn't carry, or no hive to
//              measure to). Also needs a person to confirm: we don't KNOW
//              they're out of area, and the email says we are sure.
//   clear    — no claim and the nearest hive is more than 75 measured miles
//              away. Sent as before, no friction.
// A failed read is none of these: the caller refuses (fail closed), because
// "couldn't check" must never become "sent to someone in a territory".
// ─────────────────────────────────────────────────────────────

import { nearestLocationsForZip } from '@/lib/zip-proximity'
import { buildRouteSuggestion, type RouteSuggestion } from '@/lib/route-suggestion'

export type NoCoverageVerdict =
  | { kind: 'blocked'; zip: string | null; claimants: { slug: string; name: string }[] }
  | { kind: 'confirm'; zip: string; nearest: { slug: string; name: string; miles: number } }
  | { kind: 'unmeasured'; zip: string | null; why: 'no_zip' | 'unreadable_zip' | 'unknown_zip' | 'no_hive' }
  | { kind: 'clear'; zip: string; nearest: { slug: string; name: string; miles: number } | null }

// Pure: from the card's own suggestion to the verdict, so the email and the
// Slack card can never disagree about where "too far" starts.
export function verdictFromSuggestion(s: RouteSuggestion): NoCoverageVerdict {
  if (s.kind === 'claimed') {
    return { kind: 'blocked', zip: s.zip, claimants: s.options.map((o) => ({ slug: o.slug, name: o.name })) }
  }
  if (s.kind === 'no_zip' || s.kind === 'unreadable_zip' || s.kind === 'unknown_zip') {
    return { kind: 'unmeasured', zip: s.zip, why: s.kind }
  }
  const first = s.options[0]
  if (!first || first.miles === null) return { kind: 'unmeasured', zip: s.zip, why: 'no_hive' }
  const nearest = { slug: first.slug, name: first.name, miles: first.miles }
  if (s.showNotInServiceArea) return { kind: 'clear', zip: s.zip!, nearest }
  return { kind: 'confirm', zip: s.zip!, nearest }
}

// The live check. Throws when the map can't be read — the caller refuses.
export async function checkNoCoverage(lead: { id: string; zip: string | null; state: string | null }): Promise<NoCoverageVerdict> {
  const proximity = await nearestLocationsForZip(lead.zip, lead.state, 60)
  return verdictFromSuggestion(buildRouteSuggestion({ id: lead.id, zip: lead.zip, state: lead.state }, proximity))
}

// Whether the email may go. `confirmed` is the person saying "I've seen the
// distance and they're out of range" — it moves confirm/unmeasured to sent,
// and does nothing for blocked.
export function mayEmailNoCoverage(v: NoCoverageVerdict, confirmed: boolean): boolean {
  if (v.kind === 'clear') return true
  if (v.kind === 'blocked') return false
  return confirmed
}

// What a person is told, in words. Used by the API's refusals, the Slack
// reply and the timeline note.
export function verdictWords(v: NoCoverageVerdict): string {
  switch (v.kind) {
    case 'blocked': {
      const names = v.claimants.map((c) => c.name)
      const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
      return `Zip ${v.zip} is on ${who}'s zip list — that is their territory, so Bee Hub won't send the not-in-area email. Route the lead to ${names.length === 1 ? names[0] : 'one of them'} instead.`
    }
    case 'confirm':
      return `${v.nearest.name} is ${v.nearest.miles} mi from zip ${v.zip}. Check they're really out of range before sending.`
    case 'unmeasured': {
      const what = {
        no_zip: 'This lead has no zip',
        unreadable_zip: `"${v.zip ?? ''}" isn't a US zip`,
        unknown_zip: `Zip ${v.zip} isn't in the Census zip list`,
        no_hive: `No hive could be measured to from zip ${v.zip}`,
      }[v.why]
      return `${what}, so Bee Hub can't tell how far they are from a hive. Check they're really out of range before sending.`
    }
    case 'clear':
      return v.nearest
        ? `The nearest hive, ${v.nearest.name}, is ${v.nearest.miles} mi away.`
        : 'No hive is near.'
  }
}
