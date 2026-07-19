// components/hive/HiveShell.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 beta shell (doc §7) — the four-tab chrome around the
// step-4 screens: Inbox | Board | List | Clients. When the beta toggle
// is on, this REPLACES the legacy Clients content area entirely (the
// legacy header/tabs/search are hidden, not restyled).
//
// All four tabs are live (Tabler-style icons from ui/icons). Lives
// inside the beta dynamic chunk — BeeHub dynamic-imports THIS module
// (ssr:false) and this module statically owns every beta screen, so all
// beta code stays out of the main bundle (§8.5 bundle-isolation rules).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import EngagementBoard from './EngagementBoard'
// Nav restructure 2026-07-18: the List lens is now the grouped color-band
// EngagementGroupedList; the Client List lens is the grouped ClientGroupedList.
// The prior flat EngagementList / ClientDirectory are RETAINED on disk
// (still unit-tested in isolation) but no longer mounted here — reversible
// by restoring the import + render branch, same pattern as the Classic
// retirement.
import EngagementGroupedList from './EngagementGroupedList'
import EngagementPanel from './EngagementPanel'
import ClientGroupedList from './ClientGroupedList'
import InboxScreen from './InboxScreen'
import ClientProfile from './ClientProfile'
import NewClientSheet from './NewClientSheet'
import { mapLeadToPerson, touchpointToTimelineEntry } from '@/lib/people-mapper'
import { leadColsToPersonFields } from './shared/leadPatchMap'
import { mergePeopleTouches } from './shared/peopleTouchPatch'
import { deriveClientStatus } from './shared/clientStatus'
import { isTerminal, CLOSED_WON } from './shared/stageConfig'
import { ENGAGEMENT_FILTER_DEFAULTS, passesEngagementFilters } from './shared/engagementStatus'
import { reconcileServerRows, mergeEngagements } from './shared/engagementRevalidate'
import { useEngagementsRealtime } from '@/lib/use-engagements-realtime'
import { useStoredState } from './shared/useStoredControls'
import { nextRecordOverlay } from './shared/hubUrl'
import useIsMobile from './shared/useIsMobile'
import { IconInbox, IconLayoutKanban, IconList, IconUsers, IconPlus } from '@/components/ui/icons'
import { TEXT_TOKENS, BORDER_TOKENS, WARNING_TOKENS } from '@/components/ui/tokens'
import { CHIP_STYLES } from './shared/stageConfig'
import { T } from './shared/tokens'

// Nav restructure 2026-07-18: three top-level tabs. Board + List are no
// longer separate tabs — they became a sub-toggle INSIDE Engagements (see
// engView below). "Inbox (New)" keeps the count badge; "Client List" is the
// people lens; "Engagements" holds the board/list toggle.
// Every tab carries a count badge (2026-07-19): Inbox = New+Attempting,
// Engagements = total open engagements (the count the corner text used to
// show, now removed), Client List = total clients in scope. Per-tab counts
// are wired in `tabBadges` below; the badge pill itself is one shared anatomy.
const TABS = [
  { key: 'inbox',       label: 'Inbox (New)', live: true, badge: true, Icon: IconInbox },
  { key: 'engagements', label: 'Engagements', live: true, badge: true, Icon: IconLayoutKanban },
  { key: 'clients',     label: 'Client List', live: true, badge: true, Icon: IconUsers },
]

// The preferred top-level tab sticks across sessions. (Key name unchanged
// for continuity; older stored 'board'/'list' values migrate to
// 'engagements' on hydration below.)
const LENS_LS_KEY = 'bee_hive_beta_lens'
// The Board-vs-List sub-toggle within Engagements — its own preference,
// separate from the retired classic view pref. Default Board.
const ENG_VIEW_LS_KEY = 'bee_hive_eng_view'

// Focus/visibility revalidation guard — collapse a burst of focus events
// (alt-tab flurries, OS focus echoes) into at most one refetch per window.
const REVALIDATE_DEBOUNCE_MS = 4000

// Realtime coalesce window — a single server action often writes an
// engagement more than once (stage + totals + closed_at), and each write is
// its own postgres_changes event. Collect ids for a beat and refetch once.
// Short on purpose: this is the live-move path, and the delay is felt.
const REALTIME_COALESCE_MS = 250

function TabPill({ tab, active, onSelect, badgeCount = null }) {
  if (!tab.live) {
    return (
      <span
        title="Coming soon"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '5px',
          padding: '6px 14px', borderRadius: T.radius.pill,
          border: '0.5px solid transparent',
          fontSize: '13px', fontWeight: 400, color: T.ink.quiet,
          cursor: 'default', userSelect: 'none', whiteSpace: 'nowrap',
        }}
      >
        {tab.label}
        {tab.badge && (
          <span style={{ padding: '0 6px', borderRadius: T.radius.control, background: T.family.gray.bg, color: T.ink.quiet, fontSize: '10px', lineHeight: 1.6 }}>–</span>
        )}
        <span style={{ fontSize: '9px', color: T.ink.faint, fontWeight: 400 }}>soon</span>
      </span>
    )
  }
  return (
    <button
      onClick={onSelect}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '6px 14px', borderRadius: T.radius.pill,
        border: `0.5px solid ${active ? T.hairline.line : 'transparent'}`,
        background: active ? T.surface.raised : 'transparent',
        boxShadow: active ? T.shadow.card : 'none',
        fontSize: '13px', fontWeight: 500,
        color: active ? T.ink.primary : T.ink.muted,
        cursor: active ? 'default' : 'pointer', whiteSpace: 'nowrap',
        fontFamily: 'inherit',
      }}
    >
      {tab.Icon && <tab.Icon size={14} />}
      {tab.label}
      {tab.badge && badgeCount != null && badgeCount > 0 && (
        // Badge metrics are its own role (10px/600 count pill); the COLOR
        // pair is the one CHIP_STYLES teal — the same pair StatusChip uses.
        <span style={{ marginLeft: '6px', padding: '0 6px', borderRadius: T.radius.control, background: CHIP_STYLES.teal.bg, color: CHIP_STYLES.teal.text, fontSize: '10px', fontWeight: 600, lineHeight: 1.6, fontVariantNumeric: T.type.tabular }}>
          {badgeCount}
        </span>
      )}
    </button>
  )
}

// Location scoping: the beta view follows the EXISTING app-level location
// switcher (App top bar — visible above the shell), exactly like the legacy
// board: HiveScreen passes its locFilter prop through and the engagement
// set filters client-side on location_uuid (locFilter holds 'all' or the
// location uuid — the same vocabulary people-mapper documents).
export default function HiveShell({
  engagements = [],
  closedCount = 0,
  closedWonCount = 0,
  people = [],
  // Location team roster (id/name/email/locationId) — BeeHub bridges its
  // LocationUsersContext here so the profile's assigned-to picker can
  // stay §8.5-clean (props only, no context in the hive chunk).
  locationUsers = [],
  // Location roster ({ id, name }) already loaded for the app switcher —
  // threaded down so the Client List can resolve a client's location NAME
  // without a new query (§8.5 props-only).
  locations = [],
  locFilter = 'all',
  currentLocationUuid = null,
  currentUserId = null,
  // Record-in-URL (client): BeeHub owns the URL (single-page shell). It
  // passes DOWN the client id the URL currently names (urlClientId) so the
  // ClientProfile overlay seeds/clears from the URL (deep-link on load +
  // browser back/forward), and receives UP onOpenClient(id, {replace}) /
  // onCloseRecord() so opening/closing/chevron-walking a client here drives
  // the URL. §8.5 direction rule: props only, BeeHub never reaches in here.
  urlClientId = null,
  // Record-in-URL (engagement): the engagement id the URL currently names
  // (?e=<id> on /clients/<clientId>). Feeds the SAME overlay slot the client
  // uses — nextRecordOverlay keeps the engagement on top when it's set, so a
  // deep-link / browser back-forward opens the standalone EngagementPanel a
  // click produces. onOpenEngagementUrl drives it OUT (clientId+engagementId,
  // so the URL inherits the client route's location scoping).
  urlEngagementId = null,
  onOpenClient = () => {},
  onOpenEngagementUrl = () => {},
  onCloseRecord = () => {},
  onSendToJobber = () => {},
  // Live Jobber-link patch, keyed by client id (BeeHub owns it; passed DOWN
  // per §8.5). After a confirmed send-to-jobber the record stays open, and
  // the panel/profile overlays merge { jobber_client_id, jobber_request_id }
  // from here into their server-loaded gate so the Send button flips to
  // "Open in Jobber" WITHOUT a refetch. Empty until the first send.
  jobberLinks = {},
  // The people-merge seam (§8.5 direction rule): BeeHub passes this
  // callback DOWN; after a confirmed create the shell hands the mapped
  // person UP through it. The shell never reaches into BeeHub state.
  onPersonCreated = null,
  // The people-PATCH seam — same direction rule, for edits: after a card
  // saves a lead field (source/type/referrer), the shell hands the
  // Person-shaped patch UP so Inbox rows / filters / reopened cards
  // reflect it without a reload.
  onPersonPatched = null,
  // The partner-create seam — same direction rule: ReferrerPicker's
  // inline create hands its CONFIRMED /api/partners row up so Classic's
  // partners state (PartnersScreen) shows it without a reload. The
  // picker never touches PartnersContext (§8.5).
  onPartnerCreated = null,
  setToast = () => {},
  onExitBeta = () => {},
  // Read-only mode (868kawwmh) — lite_user or paused/inactive location.
  // When true every write affordance in the beta tree is hidden/disabled;
  // the server (lib/read-only-access) rejects independently. past_due
  // keeps full access, so it never reaches here as readOnly. Policy lives
  // in betaGate.js resolveBetaReadOnly; BeeHub threads the boolean down.
  readOnly = false,
}) {
  // Top-level tab — default 'engagements' (opens on the board), hydrated
  // from localStorage after mount (SSR-safe). A stored legacy 'board'/'list'
  // value migrates to 'engagements' (they're now the sub-toggle, not tabs).
  const [lens, setLens] = useState('engagements')
  const isMobile = useIsMobile()
  useEffect(() => {
    try {
      const v = localStorage.getItem(LENS_LS_KEY)
      if (v === 'board' || v === 'list') setLens('engagements')
      else if (['inbox', 'engagements', 'clients'].includes(v)) setLens(v)
    } catch {}
  }, [])
  const pickLens = (v) => { setLens(v); try { localStorage.setItem(LENS_LS_KEY, v) } catch {} }

  // Board-vs-List sub-toggle within Engagements — default 'board', its
  // choice remembered. Hydrated after mount, same SSR-safe pattern.
  const [engView, setEngView] = useState('board')
  useEffect(() => {
    try { const v = localStorage.getItem(ENG_VIEW_LS_KEY); if (v === 'board' || v === 'list') setEngView(v) } catch {}
  }, [])
  const pickEngView = (v) => { setEngView(v); try { localStorage.setItem(ENG_VIEW_LS_KEY, v) } catch {} }

  // ONE overlay slot: EngagementPanel or ClientProfile — they REPLACE
  // each other (no stacking): 'View profile' swaps panel→profile;
  // tapping an engagement card on the profile swaps back. rowPatches
  // mirror panel changes (title/stage) onto the board without a reload.
  // overlay: null | { type:'engagement', engagement } | { type:'client', clientId }
  //        | { type:'person', person }  ← pre-engagement card (Inbox rows)
  const [overlay, setOverlay] = useState(null)
  const [rowPatches, setRowPatches] = useState({})
  // The log-call override — rowPatches' opposite number for PEOPLE: personId →
  // CONFIRMED reach_out timeline entries logged this session. It lives HERE,
  // not in the Inbox, because client status is DERIVED from
  // person.outreachTimeline (clientStatus.js) by every lens: the Inbox's old
  // Inbox-local Set moved its own row and left the directory and the badge
  // still reading New until a reload. Merged in mergePeopleTouches, which is
  // additive-BY-ID rather than last-wins — appends can't use rowPatches'
  // precedence without double-counting the call once a refetch echoes it.
  const [touchPatches, setTouchPatches] = useState({})
  // Server truth re-fetched on focus/visibility (below rowPatches in the
  // merge). Keyed by id; each refetch overwrites — never holds local intent.
  const [serverRevalidated, setServerRevalidated] = useState({})
  // Engagements REOPENED this session (Closed Lost → open, from the panel's
  // ··· Reopen). A reopened row isn't in the open server set, so its id is
  // handed to the board to EVICT it from the (separately-fetched) closed
  // rail without a reload — the other half of the manual-refresh fix.
  const [reopenedIds, setReopenedIds] = useState([])
  // Engagements founded THIS SESSION (NewClientSheet frames B/D — the
  // decoupled manual founding). Merged ahead of the server-hydrated set
  // so the founded row shows on the Board in Request without a reload,
  // and the person derives Active everywhere (openClientIds consumers).
  // Same real-row rule as onPersonCreated: only confirmed API returns
  // land here, never optimistic stubs.
  const [sessionEngagements, setSessionEngagements] = useState([])
  // Manual add-client sheet ("New"). The FAB must not stay live behind
  // ANY open sheet, so both overlay slots feed one flag.
  const [newClientOpen, setNewClientOpen] = useState(false)
  const anySheetOpen = overlay != null || newClientOpen

  // Admin-managed option lists (lookups: global, super-admin curated) —
  // fetched ONCE per shell mount and threaded to PersonCard +
  // EngagementPanel (lighter than per-card fetches).
  const [lookupOptions, setLookupOptions] = useState({ sources: [], projectTypes: [], clientTags: [], closeLostReasons: [] })
  useEffect(() => {
    let dead = false
    fetch('/api/lookups')
      .then(r => r.json())
      .then(j => {
        if (dead) return
        const rows = (j.lookups || []).filter(l => l.is_active !== false)
        const by = (cat) => rows.filter(l => l.category === cat).map(l => l.label)
        setLookupOptions({
          sources: by('lead_sources'),
          projectTypes: by('project_types'),
          // Admin-configured Closed-Lost reasons — drives the CloseLostWizard
          // reason picker (labels stored verbatim in closed_reason).
          closeLostReasons: by('closed_lost_reasons'),
          // Tag writes are id-keyed (lead_tags junction), so tags keep
          // { id, label } instead of the label-only shape.
          clientTags: rows.filter(l => l.category === 'client_tags').map(l => ({ id: l.id, label: l.label })),
        })
      })
      .catch(() => {})
    return () => { dead = true }
  }, [])

  // Work-lens filters (board + list share ONE set — Kevin's call: switch
  // lenses mid-triage, keep the subset). Owned HERE so both lenses and
  // the open-count derive from a single instance; persisted per user.
  const [workFilters, setWorkFilters, clearWorkFilters] = useStoredState('bee_hive_list_filters', ENGAGEMENT_FILTER_DEFAULTS)
  // Board→List deep link ("view all in List" on the closed rail): a
  // one-shot seed the List consumes on mount, then hands back null.
  const [listInitialView, setListInitialView] = useState(null)
  const viewClosedInList = () => { setListInitialView('closed'); pickLens('engagements'); pickEngView('list') }
  // Opening an engagement swaps the single overlay slot to the panel AND
  // drives the URL to /clients/<clientId>?e=<engagementId> — shareable,
  // refresh-survivable, back/forward-aware, and location-scoped through the
  // parent client. Every engagement row carries client_id (board/list/
  // profile); the defensive onCloseRecord fallback only fires if a row
  // somehow lacks one (it never should) so we never strand a URL-less panel.
  const openEngagement = (e) => {
    setOverlay({ type: 'engagement', engagement: e })
    if (e?.id && e?.client_id) onOpenEngagementUrl(e.client_id, e.id)
    else onCloseRecord()
  }
  // siblings: the opener's visible ordering (directory rows) — powers
  // the profile's prev/next chevrons; openers without a natural order
  // pass nothing and the chevrons hide. Also drive the URL (→ /clients/<id>)
  // so a beta-board open is shareable / refresh-survivable.
  const openClient = (clientId, siblings = null) => {
    setOverlay({ type: 'client', clientId, siblings: Array.isArray(siblings) && siblings.length > 1 ? siblings : null })
    onOpenClient(clientId)
  }
  // A lead and a client are the SAME record (one leads row, one uuid). The
  // Inbox opens leads through here — route them onto the SAME ClientProfile
  // overlay a click/deep-link opens, and drive the URL, so a lead is
  // deep-linkable everywhere (no PersonCard/ClientProfile two-UI split, the
  // same unification 3c0ad3a did for clients). ClientProfile is a superset of
  // the old PersonCard (junk/buzz/source/referrer/request-details/touchpoints).
  const openPerson = (person) => { if (person?.id) openClient(person.id) }

  // URL → overlay sync: when the URL-named client id OR engagement id changes
  // (deep-link on mount, browser back/forward), open/close/swap the overlay to
  // match. nextRecordOverlay returns the SAME overlay ref when nothing should
  // change (a click already opened it), so this never fights the openers and
  // preserves an open client's siblings / an open engagement's seed.
  useEffect(() => {
    setOverlay(o => nextRecordOverlay(urlClientId, urlEngagementId, o))
  }, [urlClientId, urlEngagementId])

  // Cards emit lead-COLUMN patches after a confirmed PATCH; translate to
  // Person-shape fields and hand UP (onPersonPatched merges into BeeHub's
  // people state). Unknown columns are dropped by the translator.
  const handleLeadPatched = (leadId, cols) => {
    if (!onPersonPatched) return
    const fields = leadColsToPersonFields(cols)
    if (Object.keys(fields).length > 0) onPersonPatched(leadId, fields)
  }

  // THE single engagement-row hand-up seam: the panel's onChanged (title/
  // stage/close edits) AND the board's drag-to-close both merge through
  // here, so every lens (board columns, open-count header, List) sees the
  // same change without a reload. A terminal patch retires any session
  // reopen-eviction for that row (a re-close should show in the rail again).
  const applyEngagementPatch = useCallback((id, patch) => {
    if (!id || !patch) return
    setRowPatches(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))
    if (patch.stage && isTerminal(patch.stage)) setReopenedIds(prev => prev.filter(x => x !== id))
  }, [])

  // THE single touchpoint hand-up seam — applyEngagementPatch's counterpart.
  // All THREE logging surfaces (Inbox row, engagement card, client profile —
  // one shared TouchpointModal behind each) hand the CONFIRMED inserted row up
  // here (never an optimistic stub, so the id is the real one); projecting it
  // through the same people-mapper function hydration uses makes the local
  // entry identical to what the next reload brings back, which is what lets
  // the merge dedupe on id instead of stacking a second reach_out.
  const applyTouchpoint = useCallback((personId, row) => {
    if (!personId || !row || !row.id) return
    const entry = touchpointToTimelineEntry(row)
    setTouchPatches(prev => {
      const cur = prev[personId] || []
      if (cur.some(t => t.id === entry.id)) return prev
      return { ...prev, [personId]: [...cur, entry] }
    })
  }, [])

  // ── revalidation: reconcile a fresh open set into serverRevalidated ──
  // The MERGE half of the refresh fix (the pure logic lives in
  // engagementRevalidate.js). A future Supabase realtime subscription can
  // call this with the changed rows it receives — the merge doesn't change.
  const reconcileEngagements = useCallback((freshRows) => {
    setServerRevalidated(prev => {
      const baseById = new Map()
      for (const e of engagements) baseById.set(e.id, e)
      for (const e of sessionEngagements) if (!baseById.has(e.id)) baseById.set(e.id, e)
      return reconcileServerRows(prev, freshRows, baseById)
    })
  }, [engagements, sessionEngagements])

  // ── revalidation TRIGGER: refetch the open set on focus/visibility ──
  // The board's set is server-rendered once at page load; working-stage
  // advances happen server-side (webhook/import) with no client event, so
  // without this they need a reload to surface. In-flight + time guards
  // stop rapid focus/visibility events from stacking fetches. Reuses the
  // existing /api/engagements read path (?open=1) — no new endpoint, same
  // shape _hub-page ships. REALTIME UPGRADE: a Supabase subscription
  // replaces THIS trigger and feeds reconcileEngagements the same way.
  const revalidateInFlight = useRef(false)
  const revalidateLastAt = useRef(0)
  const revalidateOpenEngagements = useCallback(async () => {
    if (revalidateInFlight.current) return
    const now = Date.now()
    if (now - revalidateLastAt.current < REVALIDATE_DEBOUNCE_MS) return
    revalidateInFlight.current = true
    revalidateLastAt.current = now
    try {
      const params = new URLSearchParams({ open: '1' })
      if (locFilter && locFilter !== 'all') params.set('location_uuid', locFilter)
      const res = await fetch(`/api/engagements?${params}`)
      if (!res.ok) return
      const j = await res.json().catch(() => null)
      if (j && Array.isArray(j.rows)) reconcileEngagements(j.rows)
    } catch {
      // best-effort — the page-load set stands if a revalidation fails
    } finally {
      revalidateInFlight.current = false
    }
  }, [locFilter, reconcileEngagements])

  useEffect(() => {
    const onFocus = () => { revalidateOpenEngagements() }
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') revalidateOpenEngagements()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [revalidateOpenEngagements])

  // ── revalidation TRIGGER 2: Supabase realtime stage moves ───────────
  // Cards move columns the moment engagements.stage changes from ANY source
  // (another user, a webhook, MAKE) — no reload, no poll. The focus trigger
  // above STAYS: it is the belt to this braces, and it still covers the
  // window where the socket is down or an event was missed.
  //
  // The subscription hands us an id only (the payload has no enrichment), so
  // this refetches the named rows in board shape and feeds them to the SAME
  // reconcileEngagements the focus sweep uses. Everything the merge
  // guarantees therefore holds unchanged here — in particular rowPatches win
  // last, so a pending drag-close or a just-reopened row is never clobbered
  // by a refetch this path kicks off.
  const rtPendingIds = useRef(new Set())
  const rtTimer = useRef(null)
  const rtInFlight = useRef(false)
  const rtFlushRef = useRef(null)

  const flushRealtimeIds = useCallback(async () => {
    rtTimer.current = null
    // Stacking guard, mirroring the focus trigger's: never run two refetches
    // at once. Re-arm rather than drop — the ids stay pending, so a burst
    // that lands mid-fetch still surfaces (it isn't a stale focus event we
    // can safely discard; it's a move nothing else will tell us about).
    if (rtInFlight.current) {
      rtTimer.current = setTimeout(() => rtFlushRef.current?.(), REALTIME_COALESCE_MS)
      return
    }
    const ids = Array.from(rtPendingIds.current)
    rtPendingIds.current.clear()
    if (ids.length === 0) return
    rtInFlight.current = true
    try {
      const params = new URLSearchParams({ ids: ids.join(',') })
      if (locFilter && locFilter !== 'all') params.set('location_uuid', locFilter)
      const res = await fetch(`/api/engagements?${params}`)
      if (!res.ok) return
      const j = await res.json().catch(() => null)
      if (j && Array.isArray(j.rows)) reconcileEngagements(j.rows)
    } catch {
      // best-effort — the focus trigger is the backstop if this fails
    } finally {
      rtInFlight.current = false
    }
  }, [locFilter, reconcileEngagements])
  rtFlushRef.current = flushRealtimeIds

  const handleEngagementRealtime = useCallback(({ engagementId }) => {
    if (!engagementId) return
    rtPendingIds.current.add(engagementId)
    if (rtTimer.current) return
    rtTimer.current = setTimeout(() => rtFlushRef.current?.(), REALTIME_COALESCE_MS)
  }, [])

  // Drop a timer armed at unmount — the channel is already gone by then and
  // the fetch would resolve into a dead tree.
  useEffect(() => () => {
    if (rtTimer.current) clearTimeout(rtTimer.current)
  }, [])

  // Subscribes on mount; tears the channel down and reopens on locFilter
  // change (the hook keys its effect on it), so a location switch can't leave
  // the old location's channel behind delivering into the new board.
  useEngagementsRealtime(locFilter, handleEngagementRealtime)

  const allEngagements = sessionEngagements.length === 0
    ? engagements
    : [...sessionEngagements.filter(s => !engagements.some(e => e.id === s.id)), ...engagements]
  // Layer: base → server-revalidated truth → local rowPatches (win last).
  const patched = mergeEngagements(allEngagements, serverRevalidated, rowPatches)

  const filtered = locFilter === 'all'
    ? patched
    : patched.filter(e => e.location_uuid === locFilter)
  // Rows closed THIS SESSION (via the panel's close-out) carry a terminal
  // rowPatch — they leave the count and every open-set consumer. The
  // counter reflects the ACTIVE work filters (F: counts reconcile).
  const openFiltered = filtered.filter(e => !isTerminal(e.stage))
  const nowMs = Date.now()
  const openCount = openFiltered.filter(e => passesEngagementFilters(e, workFilters, nowMs)).length

  // Layer: page-load snapshot → local log-call override. ONE merge, here, so
  // every lens below derives client status through it — that is the whole
  // point of lifting the override out of the Inbox. Additive by id: a refetch
  // that carries the touchpoint retires the override instead of stacking on it
  // (mergePeopleTouches returns `people` itself, so no re-render).
  const patchedPeople = useMemo(() => mergePeopleTouches(people, touchPatches), [people, touchPatches])

  // Inbox badge: New + Attempting in the current location scope. The
  // won set (session-closed Won + hydrated person.wonEngagements inside
  // the derivation) keeps won clients out of the count — same inputs as
  // the Inbox worklist itself.
  const inboxCount = useMemo(() => {
    const scopedPeople = locFilter === 'all' ? patchedPeople : patchedPeople.filter(p => p.locationId === locFilter)
    const openIds = new Set(openFiltered.map(e => e.client_id))
    const wonIds = new Set(filtered.filter(e => e.stage === CLOSED_WON).map(e => e.client_id))
    let n = 0
    for (const p of scopedPeople) {
      const s = deriveClientStatus(p, openIds, Date.now(), wonIds)
      if (s === 'New' || s === 'Attempting') n++
    }
    return n
  }, [patchedPeople, locFilter, openFiltered, filtered])

  // Client List badge: total clients in the current location scope — the
  // exact set ClientGroupedList renders (grouped by status).
  const clientCount = useMemo(() => (
    locFilter === 'all' ? patchedPeople.length : patchedPeople.filter(p => p.locationId === locFilter).length
  ), [patchedPeople, locFilter])

  // Per-tab badge counts, all from real sources (never hardcoded): Inbox =
  // New+Attempting (inboxCount), Engagements = open engagements (openCount —
  // the value the removed corner text showed), Client List = clientCount.
  const tabBadges = { inbox: inboxCount, engagements: openCount, clients: clientCount }
  const tabPills = TABS.map(t => <TabPill key={t.key} tab={t} active={t.key === lens} onSelect={() => pickLens(t.key)} badgeCount={t.badge ? tabBadges[t.key] : null} />)
  // Desktop "New" pill — the ONE solid chrome element, visible from all
  // four tabs, left of the counter. Mobile gets the FAB instead. Hidden
  // for read-only users (creating a client is a write).
  const newPillEl = readOnly ? null : (
    <button
      onClick={() => setNewClientOpen(true)}
      aria-label="New client"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        height: '34px', padding: '0 14px', borderRadius: T.radius.pill,
        border: 'none', background: T.ink.primary, color: T.ink.inverse,
        fontSize: '13px', fontWeight: 500, cursor: 'pointer',
        fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0,
      }}
    >
      <IconPlus size={14} /> New
    </button>
  )
  // The "Open engagements · N" corner text was REMOVED 2026-07-19 — it
  // collided with the Board/List toggle and its value now lives in the
  // Engagements tab badge (tabBadges.engagements = openCount). openCount /
  // openFiltered are retained above: they still feed that badge.
  // Engagements Board|List sub-toggle — sits in the chrome next to the tabs,
  // only while the Engagements tab is active. Board reuses the board-
  // grid icon, List the list icon (same icons the old tabs carried). The
  // active side is a solid ink pill; the choice persists (pickEngView).
  const ENG_VIEWS = [
    { k: 'board', label: 'Board', Icon: IconLayoutKanban },
    { k: 'list',  label: 'List',  Icon: IconList },
  ]
  const engToggleEl = lens !== 'engagements' ? null : (
    <div role="group" aria-label="Engagements view" style={{ display: 'inline-flex', alignItems: 'center', gap: '2px', padding: '2px', borderRadius: T.radius.pill, border: `0.5px solid ${T.hairline.line}`, background: T.surface.raised, flexShrink: 0 }}>
      {ENG_VIEWS.map(o => {
        const active = engView === o.k
        return (
          <button
            key={o.k}
            onClick={() => pickEngView(o.k)}
            aria-pressed={active}
            aria-label={`${o.label} view`}
            title={`${o.label} view`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px',
              padding: '5px 11px', borderRadius: T.radius.pill, border: 'none',
              background: active ? T.ink.primary : 'transparent',
              color: active ? T.ink.inverse : T.ink.muted,
              fontSize: '12px', fontWeight: 500, cursor: active ? 'default' : 'pointer',
              fontFamily: 'inherit', whiteSpace: 'nowrap',
            }}
          >
            <o.Icon size={13} />{!isMobile && ` ${o.label}`}
          </button>
        )
      })}
    </div>
  )
  // Classic retired 2026-07-18 — the "Back to classic" escape hatch is no
  // longer rendered (see the two removed {exitEl} render sites below). This
  // element + the onExitBeta prop are RETAINED (unrendered) so restoring
  // Classic access is a one-line revert. BeeHub also renders the new Hive view
  // unconditionally now, so even firing onExitBeta would not reach Classic.
  const exitEl = (
    <button
      onClick={onExitBeta}
      style={{
        border: 'none', background: 'transparent', padding: 0,
        fontSize: '11px', color: T.ink.quiet, cursor: 'pointer',
        fontFamily: 'inherit', textDecoration: 'underline',
        textUnderlineOffset: '2px', whiteSpace: 'nowrap',
      }}
    >
      Back to classic
    </button>
  )

  return (
    // min-height fills the VISIBLE viewport (dvh where supported — iOS
    // vh is the large viewport; vh kept as the old-browser fallback).
    // The canvas — a hair warm (T.surface.canvas) so raised white cards
    // float on their border + two-layer shadow (the card-lift idiom).
    <div className="bee-hive-root" style={{ ...TEXT_TOKENS, ...BORDER_TOKENS, ...WARNING_TOKENS, background: T.surface.canvas, padding: '1rem 1rem 5rem', fontFamily: 'DM Sans,system-ui,sans-serif' }}>
      <style>{`.bee-hive-root { min-height: 100vh; min-height: 100dvh; }`}</style>
      {isMobile ? (
        /* Mobile chrome STACKS (nothing may overlap at 320–430px):
           row 1 = the tab pills (with count badges) on ONE nowrap line,
           scrolling horizontally if tight; row 2 = the Board/List toggle,
           right-aligned, ONLY on the Engagements tab (the "Open engagements"
           corner text was removed 2026-07-19 — its count is now a tab badge). */
        <div style={{ marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px', overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', paddingBottom: '2px' }}>
            {tabPills}
          </div>
          {engToggleEl && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '12px', marginTop: '6px', padding: '0 4px' }}>
              {engToggleEl}
            </div>
          )}
        </div>
      ) : (
        /* Desktop top row: tab pills left, New + Board/List toggle right.
           (The "Open engagements" corner text was removed 2026-07-19 — its
           count now rides the Engagements tab badge.) */
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flex: 1, minWidth: 0, overflowX: 'auto', scrollbarWidth: 'none' }}>
            {tabPills}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
            {newPillEl}
            {engToggleEl}
            {/* Classic retired 2026-07-18 — {exitEl} "Back to classic" removed (desktop) */}
          </div>
        </div>
      )}

      {lens === 'inbox' ? (
        <InboxScreen
          people={patchedPeople}
          engagements={patched}
          locFilter={locFilter}
          onOpenPerson={openPerson}
          onSendToJobber={onSendToJobber}
          onCallLogged={applyTouchpoint}
          setToast={setToast}
          readOnly={readOnly}
        />
      ) : lens === 'clients' ? (
        <ClientGroupedList
          people={patchedPeople}
          engagements={patched}
          locFilter={locFilter}
          locations={locations}
          onOpenClient={openClient}
        />
      ) : engView === 'list' ? (
        <EngagementGroupedList
          engagements={filtered}
          closedCount={closedCount}
          closedWonCount={closedWonCount}
          locFilter={locFilter}
          workFilters={workFilters}
          setWorkFilters={setWorkFilters}
          clearWorkFilters={clearWorkFilters}
          onOpenEngagement={openEngagement}
          setToast={setToast}
          initialView={listInitialView}
          onInitialViewConsumed={() => setListInitialView(null)}
        />
      ) : (
        <EngagementBoard
          engagements={filtered}
          closedCount={closedCount}
          reopenedIds={reopenedIds}
          locFilter={locFilter}
          workFilters={workFilters}
          setWorkFilters={setWorkFilters}
          clearWorkFilters={clearWorkFilters}
          onOpenClient={openClient}
          onOpenEngagement={openEngagement}
          onViewClosedInList={viewClosedInList}
          // Drag-close hands terminal stage UP (panel seam).
          onChanged={applyEngagementPatch}
          setToast={setToast}
          lookupOptions={lookupOptions}
          readOnly={readOnly}
        />
      )}

      {/* Mobile FAB — classic FAB position (bottom-right, safe-area
          aware). Hidden whenever any sheet is open so it isn't live
          behind the sheet's actions row. */}
      {isMobile && !anySheetOpen && !readOnly && (
        <button
          onClick={() => setNewClientOpen(true)}
          aria-label="New client"
          style={{
            position: 'fixed',
            right: 'calc(16px + env(safe-area-inset-right, 0px))',
            bottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
            width: '52px', height: '52px', borderRadius: T.radius.round,
            border: 'none', background: T.ink.primary, color: T.ink.inverse,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: T.shadow.drawer, cursor: 'pointer',
            zIndex: 10000,
          }}
        >
          <IconPlus size={24} />
        </button>
      )}

      {newClientOpen && (
        <NewClientSheet
          people={patchedPeople}
          readOnly={readOnly}
          onPartnerCreated={onPartnerCreated}
          engagements={filtered}
          locFilter={locFilter}
          currentLocationUuid={currentLocationUuid}
          currentUserId={currentUserId}
          lookupOptions={lookupOptions}
          setToast={setToast}
          onClose={() => setNewClientOpen(false)}
          onOpenClient={(clientId) => { setNewClientOpen(false); openClient(clientId) }}
          onOpenEngagement={(e) => { setNewClientOpen(false); openEngagement(e) }}
          onSendToJobber={onSendToJobber}
          onFounded={(engRow) => {
            // CONFIRMED founding only — the real returned engagement row
            // (board shape) merges into the session set; the sheet stays
            // open on frame F for the send-or-keep-local next step.
            setSessionEngagements(prev => prev.some(x => x.id === engRow.id) ? prev : [engRow, ...prev])
          }}
          onCreated={(leadRow) => {
            // CONFIRMED insert only — map the real returned row (never an
            // optimistic stub), hand it up through onPersonCreated so the
            // Inbox "New" row appears without a reload, then open the card on
            // the unified ClientProfile overlay (+ URL), same as any lead open.
            const person = mapLeadToPerson(leadRow, {})
            if (onPersonCreated) onPersonCreated(person)
            setNewClientOpen(false)
            if (person?.id) openClient(person.id)
          }}
        />
      )}

      {/* keys: any record change remounts the overlay, so OverlayShell's
          mount reset (scrollTop 0 + body lock) covers every open/swap */}
      {overlay?.type === 'engagement' && (
        <EngagementPanel
          key={overlay.engagement.id}
          engagementId={overlay.engagement.id}
          seed={overlay.engagement}
          people={patchedPeople}
          locationUsers={locationUsers}
          readOnly={readOnly}
          onClose={() => { setOverlay(null); onCloseRecord() }}
          onOpenClient={openClient}
          onChanged={applyEngagementPatch}
          onCallLogged={applyTouchpoint}
          onReopened={(row) => {
            // Inject the freshly-open row into the session set (the founding
            // "show-without-reload" seam) so it lands in the OPEN columns
            // instantly; clear any terminal rowPatch; flag it for closed-rail
            // eviction. The next server refetch carries the real row and the
            // session copy dedups out by id.
            setSessionEngagements(prev => [row, ...prev.filter(e => e.id !== row.id)])
            setRowPatches(prev => { const n = { ...prev }; delete n[row.id]; return n })
            setReopenedIds(prev => prev.includes(row.id) ? prev : [...prev, row.id])
          }}
          onLeadPatched={handleLeadPatched}
          onPartnerCreated={onPartnerCreated}
          onSendToJobber={(clientId, opts) => {
            // Founded-not-sent send (engagement-scoped): resolve the person
            // the popup needs — same lookup as ClientProfile below.
            const p = patchedPeople.find(x => x.id === clientId)
            if (p) onSendToJobber(p, opts)
            else setToast({ kind: 'error', msg: 'Client record not loaded — refresh and try again' })
          }}
          jobberLinks={jobberLinks}
          setToast={setToast}
          lookupOptions={lookupOptions}
        />
      )}
      {/* Lead detail is UNIFIED on ClientProfile below — the old PersonCard
          overlay path is retired so a lead click, a new-lead create, and a
          /clients/<id> deep-link all open the SAME panel and drive the URL.
          PersonCard the component still exists (standalone-tested) but is no
          longer a HiveShell overlay slot. */}
      {overlay?.type === 'client' && (
        <ClientProfile
          key={overlay.clientId}
          clientId={overlay.clientId}
          readOnly={readOnly}
          siblings={overlay.siblings ?? null}
          onNavigate={(id) => {
            // Prev/next chevron walk: swap the shown client AND move the URL
            // with it, but REPLACE (opts.replace) so walking the directory
            // doesn't stack a back-history entry per neighbour.
            setOverlay(o => (o && o.type === 'client' ? { ...o, clientId: id } : o))
            onOpenClient(id, { replace: true })
          }}
          people={patchedPeople}
          locationUsers={locationUsers}
          onClose={() => { setOverlay(null); onCloseRecord() }}
          onOpenEngagement={openEngagement}
          onLeadPatched={handleLeadPatched}
          onPartnerCreated={onPartnerCreated}
          onCallLogged={applyTouchpoint}
          onSendToJobber={(clientId) => {
            const p = patchedPeople.find(x => x.id === clientId)
            if (p) onSendToJobber(p)
            else setToast({ kind: 'error', msg: 'Client record not loaded — refresh and try again' })
          }}
          jobberLinks={jobberLinks}
          setToast={setToast}
          lookupOptions={lookupOptions}
        />
      )}
    </div>
  )
}
