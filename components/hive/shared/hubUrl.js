// components/hive/shared/hubUrl.js
// ─────────────────────────────────────────────────────────────
// The single home for Hub URL ↔ state mapping. Extracted from
// BeeHub so the pure logic is unit-testable (parseHubUrl / clientPath /
// nextClientOverlay) instead of buried in a 33k-line component.
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
// `overlay`; nextClientOverlay() is the pure reducer BeeHub feeds the URL
// id INTO so the overlay follows the URL (deep-link on load + popstate),
// while HiveShell feeds opens/closes back OUT via onOpenClient/onCloseRecord.
// ─────────────────────────────────────────────────────────────

// Internal route slug → activeNav key. 'clients'/'hive' both land on the
// Clients tab (internal nav key 'hive'); 'contacts'/'partners' both land
// on Contacts.
export const ROUTE_TO_NAV = {
  clients: 'hive',
  hive:    'hive',
  contacts:'partners',
  partners:'partners',
  reports: 'reports',
  settings:'settings',
  admin:   'admin',
  home:    'home',
}

// activeNav key → canonical pathname (the tab's bare URL, no record id).
export const NAV_TO_URL = {
  home:    '/',
  hive:    '/clients',
  partners:'/contacts',
  reports: '/reports',
  settings:'/settings',
  admin:   '/admin',
}

// The canonical path for an open client record.
export function clientPath(id) {
  return `/clients/${id}`
}

// Parse the current pathname into the activeNav key + (optional) open
// client id. Drives initial state on mount and the popstate handler so
// browser back/forward stay in sync with internal nav state. Only the
// Clients tab carries a record id today (/clients/<id>).
export function parseHubUrl(pathname) {
  if (!pathname || pathname === '/') return { nav: 'home', leadId: null }
  const m = pathname.match(/^\/clients(?:\/([^/]+))?$/)
  if (m) return { nav: 'hive', leadId: m[1] || null }
  const seg = pathname.split('/').filter(Boolean)[0]
  return { nav: ROUTE_TO_NAV[seg] || 'home', leadId: null }
}

// Pure reducer for HiveShell's URL→overlay sync effect. Given the client
// id the URL currently names (or null) and the overlay currently open,
// return the next overlay. Referentially STABLE when nothing should
// change so setOverlay(prev => next) is a no-op (React bails out) — this
// is what preserves an already-open client's `siblings` (prev/next
// chevrons) when the URL id merely re-confirms it.
//
//   · urlClientId set, same client already open → return SAME overlay
//     (no-op; keeps siblings)
//   · urlClientId set, different/none open      → open the client overlay
//     (siblings null — a deep-link/popstate has no natural ordering)
//   · urlClientId null, a client overlay open   → close it
//   · urlClientId null, engagement/person open  → leave it alone (those
//     record types don't own a URL in this scope)
export function nextClientOverlay(urlClientId, overlay) {
  if (urlClientId) {
    if (overlay && overlay.type === 'client' && overlay.clientId === urlClientId) return overlay
    return { type: 'client', clientId: urlClientId, siblings: null }
  }
  if (overlay && overlay.type === 'client') return null
  return overlay
}
