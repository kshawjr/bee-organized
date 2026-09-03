// components/hive/shared/hubUrl.js
// ─────────────────────────────────────────────────────────────
// The single home for Hub URL ↔ state mapping. Extracted from
// BeeHub so the pure logic is unit-testable (parseHubUrl / clientPath /
// engagementPath / nextRecordOverlay) instead of buried in a 33k-line component.
//
// The Hub is a single-page shell: every top-level route renders the
// SAME <BeeHub> (see app/_hub-page.tsx). Tab changes and record opens
// use window.history.pushState (NOT router.push) so BeeHub stays mounted
// — the page.tsx files exist only so a hard refresh / shared link SSRs
// to the right state. This module owns the pathname vocabulary both
// directions share.
//
// RECORD-IN-URL (client): opening a client reflects /clients/<id> so a
// record is shareable, refresh-survivable, and back/forward-aware. In
// the beta board (HiveShell), the open client lives in HiveShell's local
// `overlay`; nextRecordOverlay() is the pure reducer BeeHub feeds the URL
// id(s) INTO so the overlay follows the URL (deep-link on load + popstate),
// while HiveShell feeds opens/closes back OUT via onOpenClient /
// onOpenEngagementUrl / onCloseRecord. Engagements ride the client path as
// ?e=<id> (engagementPath), inheriting its server-side location scoping.
// ─────────────────────────────────────────────────────────────

// Internal route slug → activeNav key. 'clients'/'hive' both land on the
// Clients tab (internal nav key 'hive'); 'network'/'contacts'/'partners'
// all land on Network (nav key stays 'partners' — renaming the internal
// key would touch every gate for a string). /contacts is a permanent
// ALIAS, not a redirect: old links and bookmarks keep resolving.
export const ROUTE_TO_NAV = {
  clients: 'hive',
  hive:    'hive',
  network: 'partners',
  contacts:'partners',
  partners:'partners',
  reports: 'reports',
  // issue 140: Back Office is its own top-level tab, self-mapped like reports.
  backoffice:'backoffice',
  settings:'settings',
  admin:   'admin',
  home:    'home',
  // The Help section (help_entries). Self-mapped like reports.
  help:    'help',
}

// activeNav key → canonical pathname (the tab's bare URL, no record id).
// Network's canonical URL is /network; /contacts stays a working alias.
export const NAV_TO_URL = {
  home:    '/',
  hive:    '/clients',
  partners:'/network',
  reports: '/reports',
  backoffice:'/backoffice',
  settings:'/settings',
  admin:   '/admin',
  help:    '/help',
}

// activeNav key → the human screen LABEL that rides a feedback item's
// `context.screen` (issue 249). This is the SAME vocabulary the two
// record-menu affordances already hardcode — ClientProfile and
// EngagementPanel both send screen:'Clients' because they only ever open
// from the Clients tab. Two vocabularies for one field would make the
// column unqueryable, so the general modal reuses these exact strings.
//
// 'admin' resolves by role the way the mobile top bar and the Ask Bee Hub
// panel already resolve it (super_admin sees 'Admin', corp sees 'Corp') —
// they are genuinely different surfaces, not one screen with two names.
export const NAV_TO_SCREEN = {
  home:      'Home',
  hive:      'Clients',
  partners:  'Network',
  reports:   'Reports',
  backoffice:'Back Office',
  settings:  'Settings',
  help:      'Help',
}

// Strict on purpose: an UNKNOWN nav returns null, not a fallback label.
// The two inline copies of this map (MobileTopBar's screenTitle, the Ask Bee
// Hub panel's screenName) fall back to 'Bee Hub' / 'Home' because a heading
// must render something. A stored context must not: a guessed screen is
// worse than an absent one, because the triage step cannot tell it apart
// from a real one. Callers omit the key when this returns null.
export function navScreenLabel(nav, role) {
  if (nav === 'admin') return role === 'super_admin' ? 'Admin' : 'Corp'
  return NAV_TO_SCREEN[nav] || null
}

// Query params allowed to ride a feedback `path`. The Hub writes exactly
// three: ?e=<engagement id> and ?section=<settings slug> both say WHERE the
// user was, and ?feedback=1 (the reply-email deep link) says how the modal
// opened — not where the user was — so it is dropped.
//
// This is an allow-list rather than a deny-list because a query string is
// precisely where free text would first appear (a typed search term is one
// feature away), and this column is id-only by decision (issue 110a). A
// param added later is dropped until someone adds it here deliberately.
const PATH_PARAMS = ['e', 'section']

// Build the `path` value: the pathname plus only the whitelisted params, in
// a fixed order so the same screen always produces the same string. Returns
// null when there is no usable pathname (SSR, or a non-absolute value), so
// the caller omits the key rather than storing something invented.
export function safeContextPath(pathname, search) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null
  let params
  try { params = new URLSearchParams(typeof search === 'string' ? search : '') } catch { return pathname }
  const kept = []
  for (const key of PATH_PARAMS) {
    const v = params.get(key)
    if (v) kept.push(`${key}=${encodeURIComponent(v)}`)
  }
  return kept.length ? `${pathname}?${kept.join('&')}` : pathname
}

// The AMBIENT context for a feedback item filed from the general modal
// (issue 249): where the user was standing, as opposed to the DECLARED
// context a record menu hands over when the user points at a specific
// record. Every key here is already on the buildSafeContext whitelist
// (lib/feedback-context.ts) and every value is an id, a route, or a fixed
// label — no free text, no PII.
//
// lead_id / engagement_id are read back out of the URL rather than threaded
// down from state: the Hub already reflects the open record into the address
// bar (see parseHubUrl), so a user who files a general bug with a client
// open still records WHICH client, for free and without a new prop.
//
// origin is what lets the triage step tell these two kinds of context apart.
// A 'client_profile_menu' item means the user pointed AT the record; a
// 'feedback_modal' item means we observed where they were standing. Reading
// an inferred screen as if the user had named it is how a shortlist gets
// mistaken for a placement.
export function buildAmbientContext({ nav, role, pathname, search } = {}) {
  const out = { origin: 'feedback_modal' }
  const screen = navScreenLabel(nav, role)
  if (screen) out.screen = screen
  const path = safeContextPath(pathname, search)
  if (path) out.path = path
  const { leadId, engagementId } = parseHubUrl(pathname, search)
  if (leadId) out.lead_id = leadId
  if (engagementId) out.engagement_id = engagementId
  return out
}

// Where an owner's own reports live now: Help › My requests. The reply
// email links here; the old /?feedback=1 deep link is redirected here.
export const HELP_REQUESTS_PATH = '/help?tab=requests'

// The legacy deep link. Every reply email sent before the nav swap says
// /?feedback=1, and so do a few team-facing Slack links; a bookmark of it
// must keep landing on the reply it was written to show. Returns the new
// address when the legacy param is present, else null.
export function legacyFeedbackRedirect(search) {
  if (!search || typeof search !== 'string') return null
  try { return new URLSearchParams(search).get('feedback') ? HELP_REQUESTS_PATH : null } catch { return null }
}

// The canonical path for an open client record.
export function clientPath(id) {
  return `/clients/${id}`
}

// The canonical path for an open ENGAGEMENT. An engagement belongs to a
// client, so it rides the client route as a query param (?e=<id>) rather
// than a /engagements/<id> route of its own — this INHERITS the client
// route's server-side location scoping (the parent client is already
// location-validated; a foreign deal can't be deep-linked for free).
export function engagementPath(clientId, engagementId) {
  return `/clients/${clientId}?e=${engagementId}`
}

// Pull the engagement id out of a location.search string (?e=<id>). Kept
// tiny + dependency-free so parseHubUrl can stay a pure string function.
function readEngagementParam(search) {
  if (!search || typeof search !== 'string') return null
  const m = search.match(/[?&]e=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

// Parse the current pathname (+ optional search) into the activeNav key,
// the optional open client id, and the optional open engagement id. Drives
// initial state on mount and the popstate handler so browser back/forward
// stay in sync with internal nav state. Only the Clients tab carries a
// record id today (/clients/<id>), and only a /clients/<id> path carries an
// engagement param (?e=) — an engagement without its parent client is
// meaningless, so engagementId is dropped unless a client id is present.
export function parseHubUrl(pathname, search) {
  if (!pathname || pathname === '/') return { nav: 'home', leadId: null, engagementId: null }
  const m = pathname.match(/^\/clients(?:\/([^/]+))?$/)
  if (m) {
    const leadId = m[1] || null
    return { nav: 'hive', leadId, engagementId: leadId ? readEngagementParam(search) : null }
  }
  const seg = pathname.split('/').filter(Boolean)[0]
  return { nav: ROUTE_TO_NAV[seg] || 'home', leadId: null, engagementId: null }
}

// Pure reducer for HiveShell's URL→overlay sync effect. Given the client id
// and engagement id the URL currently names (either/both may be null) and
// the overlay currently open, return the next overlay. Referentially STABLE
// when nothing should change so setOverlay(prev => next) is a no-op (React
// bails out) — this is what preserves an already-open client's `siblings`
// (prev/next chevrons), and an already-open engagement's full `seed`, when
// the URL merely re-confirms them.
//
// The single overlay slot is shared: an engagement in the URL WINS (it's the
// top surface a click produces), otherwise a client in the URL opens its
// profile, otherwise any URL-backed overlay closes.
//
//   · ?e set, same engagement open   → SAME overlay (no-op; keeps seed)
//   · ?e set, different/none open    → open the engagement overlay with a
//     minimal seed {id, client_id}; EngagementPanel fetches the rest
//     (location-scoped 403s a foreign deal). A deep-link/popstate has no
//     board row to seed from.
//   · no ?e, /clients/<id>, same client open → SAME overlay (keeps siblings)
//   · no ?e, /clients/<id>, other/none open  → open the client overlay
//   · nothing named, a client OR engagement overlay open → close it
//   · nothing named, a person overlay open → leave it (no URL scope; legacy)
export function nextRecordOverlay(urlClientId, urlEngagementId, overlay) {
  if (urlEngagementId) {
    if (overlay && overlay.type === 'engagement' && overlay.engagement && overlay.engagement.id === urlEngagementId) return overlay
    return { type: 'engagement', engagement: { id: urlEngagementId, client_id: urlClientId || null } }
  }
  if (urlClientId) {
    if (overlay && overlay.type === 'client' && overlay.clientId === urlClientId) return overlay
    return { type: 'client', clientId: urlClientId, siblings: null }
  }
  if (overlay && (overlay.type === 'client' || overlay.type === 'engagement')) return null
  return overlay
}
