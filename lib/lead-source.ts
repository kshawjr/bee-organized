// lib/lead-source.ts
//
// ONE vocabulary for leads.source: the admin lead_sources lookup labels
// ("how did the client hear about us" — Website, Referral, Google, …).
//
// Make scenarios historically stamped per-form slugs (seattle_assessment,
// web_form, facebook_lead_ad). Those slugs are not in the admin vocab, so
// the Source picker couldn't check-mark them — and selecting anything
// silently overwrote the attribution. Normalizing at intake keeps the card
// and the picker speaking the same language; no display mapping exists or
// is needed downstream.
//
// UNKNOWN values pass through verbatim, deliberately: a new producer slug
// must surface as itself (off-vocab, visible on the card) rather than be
// silently misfiled under Website. When one shows up, add it to the map.
// smoke_test / scout_test ride this passthrough so test artifacts stay
// identifiable as test artifacts.

// Every *_assessment scenario is the website's "Schedule Your FREE
// Assessment" form with a location prefix — all of them are Website.
const ASSESSMENT_SLUG_RE = /^[a-z0-9]+_assessment$/

// Exact slugs from INTAKE_CONTRACT.md and the historical Make scenarios.
const SLUG_TO_LABEL: Record<string, string> = {
  web_form: 'Website',
  website_form: 'Website',
  facebook_lead_ad: 'Facebook',
  instagram_lead_ad: 'Instagram',
}

// Spellings an owner (or Jobber) types for a label we already have. Matched
// WITHOUT caring about capitals, so "google", "GOOGLE" and "Google" are one
// source in the reports. This is a tidy-up, not a fixed list: anything not
// here stays exactly as typed (see UNKNOWN above). Keys are lower case.
const ALIAS_TO_LABEL: Record<string, string> = {
  website: 'Website',
  referral: 'Referral',
  google: 'Google',
  instagram: 'Instagram',
  ig: 'Instagram',
  insta: 'Instagram',
  facebook: 'Facebook',
  fb: 'Facebook',
  'word of mouth': 'Word of Mouth',
  yelp: 'Yelp',
  nextdoor: 'NextDoor',
  tiktok: 'TikTok',
}

// What an intake submission with no source at all lands as: this door is
// the website form. (The old default was the 'web_form' slug — same
// meaning, now in vocabulary.)
export const DEFAULT_LEAD_SOURCE = 'Website'

export function normalizeLeadSource(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  if (ASSESSMENT_SLUG_RE.test(s)) return 'Website'
  return SLUG_TO_LABEL[s] ?? ALIAS_TO_LABEL[s.toLowerCase()] ?? s
}

// What Jobber writes on a client OUR app created when we send no source:
// the app's own name. It says "this came through Bee Hub", not how the
// client heard about us, so it must never be read back in as a source.
// On a REQUEST it cannot be changed at all (Request.source is read-only) and
// is kept on purpose as the marker of a Bee Hub request — see the note in
// lib/jobber-request-form.ts before trying to change it.
export const JOBBER_APP_SOURCE_STAMP = 'Bee Organized Interface'

// ─── What we SEND to Jobber (2026-10-19) ──────────────────────────────
//
// The lead's source goes into an owner's Jobber as free text (the new
// client's lead source, and the "Source" line on the request). Jobber stores
// it loose — it never matches the owner's lead-source picklist — so whatever
// we send is exactly what the owner sees. leads.source itself is NOT changed
// by this: Bee Hub and the reports keep the value as it is; only the copy
// sent to Jobber is tidied.
//
// Keys are lower case with runs of spaces collapsed.
const JOBBER_SEND_ALIAS: Record<string, string> = {
  ggle: 'Google',
  'chatgpt.com': 'AI',
  'next door': 'NextDoor',
  'angi leads integration': 'Angi',
  'angi integration': 'Angi',
  'friend referred': 'Referral',
  'client referral': 'Referral',
  'referral from other hive': 'Referral',
  friend: 'Word of Mouth',
  'personal friend': 'Word of Mouth',
}

// Our own words, not how the client heard about us — send NOTHING rather
// than these. "Other" and "Google Voice" are deliberately NOT here: every
// lead carrying them came from an owner's own Jobber, where the owner chose
// them ("Other" is on Jobber's own picklist; "Google Voice" means they rang
// that number).
const JOBBER_SEND_DROP = new Set([
  'manual',
  'returning client',
  'existing client',
  'beeorganized',
  JOBBER_APP_SOURCE_STAMP.toLowerCase(),
  'bee applicant',
  'smoke_test',
  'scout_test',
])

// What a NEW Jobber client's lead source says when the lead has no source,
// or leadSourceForJobber drops it. Sending nothing is not an option: Jobber
// then writes our app name ("Bee Organized Interface") and owners see it as
// a lead source row in Insights > Reports > Lead source. That report groups
// by the text (proven 2026-10-19 on Test Location: a client we created with
// "Website" shows as its own Website row). "Other" is on Jobber's own
// picklist and is honest.
export const JOBBER_NO_SOURCE = 'Other'

/**
 * leads.source → the lead source we send to Jobber. Same tidy-up as every
 * door (normalizeLeadSource), then obvious variants become one name and our
 * internal words become nothing. Anything else — a real source we have no
 * rule for (Thumbtack, Yelp, an owner's local event) — goes as typed.
 * Null means send no source at all.
 */
export function leadSourceForJobber(raw: unknown): string | null {
  const s = normalizeLeadSource(raw)
  if (!s) return null
  const key = s.toLowerCase().replace(/\s+/g, ' ')
  if (JOBBER_SEND_DROP.has(key)) return null
  return JOBBER_SEND_ALIAS[key] ?? s
}

/**
 * Jobber's Client.leadSource → leads.source, for clients arriving FROM
 * Jobber (webhook + initial import). Same tidy-up as every other door;
 * an owner's own Jobber label ("Hershey Mills Ads") comes through as typed.
 * Jobber's stamp of our app name is not a source — it lands blank.
 */
export function leadSourceFromJobber(raw: unknown): string | null {
  const s = normalizeLeadSource(raw)
  if (!s || s.toLowerCase() === JOBBER_APP_SOURCE_STAMP.toLowerCase()) return null
  return s
}
