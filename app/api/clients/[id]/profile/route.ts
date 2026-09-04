// app/api/clients/[id]/profile/route.ts
//
// GET /api/clients/:id/profile — everything the beta ClientProfile card
// renders in one round trip: identity + contact + secondary contacts +
// marketing state + Jobber link + ALL engagements (open + closed, with
// minimal children for the open ones so deriveStatusChip stays the one
// status authority client-side) + latest touchpoints + latest buzz notes
// + lifetime aggregates.
//
// Auth mirrors the engagement routes: logged-in hub_user;
// super_admin/admin any location; everyone else scoped to their own.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { profileAggregates } from '@/lib/profile-aggregates'
import { factsFromRows } from '@/lib/enquiry-exit'

const isOpen = (s: string) => s !== 'Closed Won' && s !== 'Closed Lost'

// Reverse-referral fetch ceiling. Was a hard .range(0, 49) — referrals
// 51+ never loaded, so a prolific referral partner's later referrals
// were absent from the payload (not a scroll gap). Raised to a sane
// ceiling + a total count so the UI can say "showing N of M". A single
// client realistically never out-refers this; the count guards the case.
const REFERRED_US_CAP = 200

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }

  // former_addresses rides the select for the card's address history; the
  // retry drops it while migrations/lead_former_addresses.sql is pending —
  // the profile must never 500 over a column that only adds history.
  const PROFILE_COLS =
    'id, name, first_name, last_name, email, phone, address, city, state, zip, created_at, source, paused, marketing_opt_out, snoozed_until, snoozed_note, assigned_to, referred_by_kind, referred_by_id, jobber_client_id, location_uuid, location_id, paid_amount, request_details, project_type, import_source, jobber_request_id, jobber_job_id, is_junk'
  let { data: lead, error: leadError } = await supabaseService
    .from('leads')
    .select(`${PROFILE_COLS}, former_addresses`)
    .eq('id', id)
    .maybeSingle()
  if (leadError && /former_addresses/i.test(leadError.message || '')) {
    console.warn('[client profile] former_addresses column missing — served without history (migration pending)')
    ;({ data: lead, error: leadError } = await supabaseService
      .from('leads')
      .select(PROFILE_COLS)
      .eq('id', id)
      .maybeSingle())
  }
  if (leadError || !lead) {
    return NextResponse.json({ error: 'client_not_found' }, { status: 404 })
  }
  if (!isAdmin(hubUser.role) && hubUser.location_id !== lead.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  // Referrer resolution — referred_by_id is polymorphic on kind:
  // 'partner' → partners row (contacts included; they share the table),
  // 'lead' → another leads row, 'company' → companies row (Network
  // Phase 1 — legal once network_phase1.sql widens the kind CHECK).
  // Resolved to a NAME so the profile can say who, not just "via partner".
  const referrerTable =
    lead.referred_by_kind === 'lead' ? 'leads'
    : lead.referred_by_kind === 'company' ? 'companies'
    : 'partners'
  const referrerQuery = lead.referred_by_kind && lead.referred_by_id
    ? supabaseService
        .from(referrerTable)
        .select('id, name')
        .eq('id', lead.referred_by_id)
        .maybeSingle()
    : Promise.resolve({ data: null } as { data: { id: string, name: string } | null })

  const [contactsRes, engagementsRes, touchesRes, notesRes, jobNotesRes, locRes, referrerRes, referredUsRes, tagsRes, dripRes] = await Promise.all([
    supabaseService.from('lead_contacts').select('id, name, role, phone, email').eq('lead_id', id).order('created_at', { ascending: true }),
    supabaseService.from('engagements').select('id, title, description, stage, founded_by, created_at, stage_entered_at, closed_at, closed_reason, closed_note, nurture_started_at, total_invoiced, total_paid, balance_owing').eq('client_id', id).order('created_at', { ascending: false }),
    supabaseService.from('touchpoints').select('id, kind, method, label, notes, occurred_at, engagement_id, user_id').eq('lead_id', id).order('occurred_at', { ascending: false }).limit(50),
    supabaseService.from('lead_notes').select('id, kind, text, user_label, created_at').eq('lead_id', id).eq('kind', 'buzz').order('created_at', { ascending: false }).limit(50),
    // ALL kind='job' notes with engagement_id — ClientProfile's
    // client-WIDE activity slice tags engagement-scoped ones
    // '· re: <title>'.
    supabaseService.from('lead_notes').select('id, kind, text, user_label, created_at, engagement_id').eq('lead_id', id).eq('kind', 'job').order('created_at', { ascending: false }).limit(50),
    // lifecycle_status + activated_at ride along for the never-enrolled
    // reason below (#243) — this row was already being fetched for `name`,
    // so the two extra columns cost nothing.
    supabaseService.from('locations').select('name, lifecycle_status, activated_at').eq('id', lead.location_uuid).maybeSingle(),
    referrerQuery,
    // Reverse direction — leads THIS client referred (kind='lead' rows
    // pointing back here). Junk exclusion via .not(is,true) — NULL stays.
    // count:'exact' returns the FULL match total alongside the capped
    // page so the UI can show "showing N of M" past the ceiling.
    supabaseService.from('leads').select('id, name, created_at', { count: 'exact' }).eq('referred_by_kind', 'lead').eq('referred_by_id', id).not('is_junk', 'is', true).order('created_at', { ascending: false }).range(0, REFERRED_US_CAP - 1),
    // Tag junction rows — resolved to lookup LABELS below (the v4 tags
    // row renders labels, not the classic attrs.key ids).
    // lead_tags is a (lead_id, tag_lookup_id) junction with no `id` column —
    // selecting one 42703'd and silently blanked every tag on the card. Only
    // tag_lookup_id is read below (resolved to lookups.label).
    supabaseService.from('lead_tags').select('tag_lookup_id').eq('lead_id', id),
    // Nurture-drip lifecycle (#112). leads.paused is only the PAUSE flag —
    // terminal stops (hard_bounce, invalid_recipient, max_send_retries,
    // no_email, opted_out, spam_complaint, stage_changed, junk) write
    // lead_drip_progress only, so without this the Preferences panel reads
    // "active" on a dead sequence. Small: one row per drip_path per lead.
    supabaseService.from('lead_drip_progress').select('stopped_at, stopped_reason, completed_at, created_at').eq('lead_id', id),
  ])

  // Effective nurture-drip state for PreferencesBlock. A live row (neither
  // stopped nor completed — includes paused, which the leads.paused flag
  // already carries) means the drip is NOT terminal; only when every row is
  // terminal do we surface the most-recent terminal outcome. stopped wins
  // over completed on the same row by construction (a completed row never
  // gets stopped_at).
  const dripRows = dripRes.data ?? []
  const dripHasLive = dripRows.some(r => !r.stopped_at && !r.completed_at)
  let drip_stopped_reason: string | null = null
  let drip_completed = false
  if (!dripHasLive && dripRows.length > 0) {
    const latest = [...dripRows].sort(
      (a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
    )[0]
    if (latest.stopped_at) drip_stopped_reason = latest.stopped_reason ?? 'unknown'
    else if (latest.completed_at) drip_completed = true
  }

  // #243 — NEVER ENROLLED is its own state, not a flavour of "active".
  // #112 separated terminal stops from the paused/active flag but kept the
  // zero-rows case folded in with them: `dripRows.length > 0` guards the
  // block above, so a lead that was never enrolled fell through with a null
  // reason and false completed, and PreferencesBlock's final else rendered
  // "Nurture drips active" with a live Pause button. An absent row is not
  // evidence of a running drip — it is the absence of any drip — and only
  // the route can tell the two apart (the component sees the same nulls
  // either way, which is why this is derived HERE and not there).
  const drip_never_enrolled = dripRows.length === 0

  // WHY, where it is knowable and cheap. startDripForLead's dominant skip is
  // its interface-active gate (lib/drip-lifecycle.ts) — the location must be
  // lifecycle_status='active' at the moment the lead arrives, or nothing is
  // enrolled. That yields two substantiable reasons off the location row we
  // already have:
  //   location_not_active     — the location still isn't active today.
  //   location_activated_later— it is active now, but the lead predates
  //                             activation, so the gate was closed then.
  // Anything else stays null: the panel says "not in a drip" without
  // guessing. Deliberately NOT inferred: no-email / junk / opted-out leads
  // can also be missing rows, but those have their own causes and their own
  // rows in this panel — claiming the location gate for them would be a
  // fabricated reason.
  let drip_never_enrolled_reason: string | null = null
  if (drip_never_enrolled) {
    const locRow = locRes.data
    const activatedAt = locRow?.activated_at ? new Date(locRow.activated_at).getTime() : null
    const createdAt = lead.created_at ? new Date(lead.created_at).getTime() : null
    if (locRow && locRow.lifecycle_status !== 'active') {
      drip_never_enrolled_reason = 'location_not_active'
    } else if (locRow && activatedAt !== null && createdAt !== null && createdAt < activatedAt) {
      drip_never_enrolled_reason = 'location_activated_later'
    }
  }

  // touchpoints carry user_id but no user_label — resolve author names
  // (same as the engagement GET) so note/touch streams can say who.
  // leads.assigned_to is a hub_user id too — ride the same fetch so the
  // v4 assigned-to row can show a name.
  const touchRows = touchesRes.data ?? []
  const authorIds = Array.from(new Set(
    [...touchRows.map(t => t.user_id), lead.assigned_to].filter(Boolean)
  ))
  const authorById: Record<string, string> = {}
  if (authorIds.length > 0) {
    const { data: authors } = await supabaseService
      .from('hub_users')
      .select('id, full_name, first_name, last_name')
      .in('id', authorIds)
    for (const a of authors ?? []) {
      authorById[a.id] = a.full_name || [a.first_name, a.last_name].filter(Boolean).join(' ').trim() || '—'
    }
  }
  const touchpoints = touchRows.map(t => ({ ...t, user_label: t.user_id ? (authorById[t.user_id] ?? null) : null }))

  // Tag labels — junction → lookups.label (display vocabulary; classic's
  // attrs.key ids stay classic's concern via people-mapper).
  const tagLookupIds = Array.from(new Set((tagsRes.data ?? []).map((lt: any) => lt.tag_lookup_id).filter(Boolean)))
  let tags: { id: string, label: string }[] = []
  if (tagLookupIds.length > 0) {
    const { data: tagRows } = await supabaseService
      .from('lookups')
      .select('id, label')
      .in('id', tagLookupIds)
    tags = (tagsRes.data ?? [])
      .map((lt: any) => (tagRows ?? []).find(r => r.id === lt.tag_lookup_id))
      .filter(Boolean)
      .map((r: any) => ({ id: r.id, label: r.label }))
  }

  // Dangling-referrer detection — referred_by_id may point at a
  // partner/lead row that has since been deleted. .maybeSingle() already
  // fails soft (data:null, no throw), but null alone can't tell "no
  // referrer" from "referrer removed". When a referrer IS set yet the
  // lookup found nothing, flag it so the UI can say "removed referrer"
  // instead of a blank/generic line.
  const referrerSet = !!(lead.referred_by_kind && lead.referred_by_id)
  const referredByMissing = referrerSet && !referrerRes.data

  const engagements = engagementsRes.data ?? []
  const openIds = engagements.filter(e => isOpen(e.stage)).map(e => e.id)

  // Minimal children for OPEN engagements only — same shape the board rows
  // carry, so the profile's engagement cards reuse deriveStatusChip.
  let quotesByEng: Record<string, any[]> = {}, jobsByEng: Record<string, any[]> = {}, invoicesByEng: Record<string, any[]> = {}, assessByEng: Record<string, any[]> = {}
  if (openIds.length > 0) {
    const [q, j, inv, ass] = await Promise.all([
      supabaseService.from('quotes').select('id, engagement_id, status, total, sent_at, approved_at').in('engagement_id', openIds),
      supabaseService.from('jobs').select('id, engagement_id, status, title, scheduled_start, completed_at').in('engagement_id', openIds),
      supabaseService.from('invoices').select('id, engagement_id, status, total, balance_owing').in('engagement_id', openIds),
      supabaseService.from('assessments').select('id, engagement_id, scheduled_at, status, completed_at').in('engagement_id', openIds),
    ])
    const group = (rows: any[] | null) => {
      const out: Record<string, any[]> = {}
      for (const r of rows ?? []) (out[r.engagement_id] ??= []).push(r)
      return out
    }
    quotesByEng = group(q.data); jobsByEng = group(j.data); invoicesByEng = group(inv.data); assessByEng = group(ass.data)
  }

  const withChildren = engagements.map(e => ({
    ...e,
    quotes: quotesByEng[e.id] ?? [],
    jobs: jobsByEng[e.id] ?? [],
    invoices: invoicesByEng[e.id] ?? [],
    assessments: assessByEng[e.id] ?? [],
  }))

  // Inbox rule (2026-09-03) — the profile chip must agree with the Inbox, so
  // the same exit facts the hub page ships ride the payload: every Jobber
  // child row by lead (exit 1 — the open-engagement children above are not
  // enough, a closed engagement's request still counts), Network moves
  // (exit 2), and the closes from the full engagement list (exit 3). Built by
  // the one shared assembler (lib/enquiry-exit.ts factsFromRows).
  const [srAll, quotesAll, jobsAll, partnersAll] = await Promise.all([
    supabaseService.from('service_requests').select('requested_at, created_at').eq('lead_id', id),
    supabaseService.from('quotes').select('created_at').eq('lead_id', id),
    supabaseService.from('jobs').select('created_at').eq('lead_id', id),
    supabaseService.from('partners').select('customer_lead_id, is_customer').is('deleted_at', null).eq('customer_lead_id', id),
  ])
  const enquiry_facts = factsFromRows({
    lead,
    touchpoints,
    service_requests: srAll.data ?? [],
    quotes: quotesAll.data ?? [],
    jobs: jobsAll.data ?? [],
    engagements,
    networkMoved: (partnersAll.data ?? []).some((p: any) => p.is_customer !== true),
  })

  return NextResponse.json({
    client: {
      ...lead,
      enquiry_facts,
      location_name: locRes.data?.name ?? null,
      referred_by_name: referrerRes.data?.name ?? null,
      referred_by_missing: referredByMissing,
      assigned_to_name: lead.assigned_to ? (authorById[lead.assigned_to] ?? null) : null,
      // #112 — nurture-drip terminal state (see derivation above).
      // #243 — plus the never-enrolled state that used to hide inside the
      // nulls. The four fields are read in precedence order by
      // PreferencesBlock: stopped → completed → paused (leads.paused, on the
      // lead row) → never-enrolled → active. paused outranks never-enrolled
      // deliberately: an imported lead is BOTH (it lands paused with no
      // progress rows) and its Activate button is the real, working
      // first-enrollment path, so it must keep winning.
      drip_stopped_reason,
      drip_completed,
      drip_never_enrolled,
      drip_never_enrolled_reason,
    },
    referred_us: referredUsRes.data ?? [],
    referred_us_total: referredUsRes.count ?? (referredUsRes.data?.length ?? 0),
    contacts: contactsRes.data ?? [],
    engagements: withChildren,
    touchpoints,
    buzz_notes: notesRes.data ?? [],
    job_notes: jobNotesRes.data ?? [],
    tags,
    // Shared pure math (lib/profile-aggregates) — the v4 metric band's
    // numbers; owing spans ALL engagements incl. closed (drift fix).
    aggregates: profileAggregates(withChildren),
  })
}
