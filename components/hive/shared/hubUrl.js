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
  settings:'settings',
  admin:   'admin',
  home:    'home',
}

// activeNav key → canonical pathname (the tab's bare URL, no record id).
// Network's canonical URL is /network; /contacts stays a working alias.
export const NAV_TO_URL = {
  home:    '/',
  hive:    '/clients',
  partners:'/network',
  reports: '/reports',
  settings:'/settings',
  admin:   '/admin',
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
