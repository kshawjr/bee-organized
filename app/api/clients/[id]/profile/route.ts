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

const isOpen = (s: string) => s !== 'Closed Won' && s !== 'Closed Lost'

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

  const { data: lead, error: leadError } = await supabaseService
    .from('leads')
    .select('id, name, first_name, last_name, email, phone, address, city, state, zip, created_at, source, paused, marketing_opt_out, snoozed_until, assigned_to, referred_by_kind, referred_by_id, jobber_client_id, location_uuid, location_id, paid_amount, request_details, project_type')
    .eq('id', id)
    .maybeSingle()
  if (leadError || !lead) {
    return NextResponse.json({ error: 'client_not_found' }, { status: 404 })
  }
  if (!isAdmin(hubUser.role) && hubUser.location_id !== lead.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  // Referrer resolution — referred_by_id is polymorphic on kind:
  // 'partner' → partners row (contacts included; they share the table),
  // 'lead' → another leads row. Resolved to a NAME so the profile can
  // say who, not just "via partner".
  const referrerQuery = lead.referred_by_kind && lead.referred_by_id
    ? supabaseService
        .from(lead.referred_by_kind === 'lead' ? 'leads' : 'partners')
        .select('id, name')
        .eq('id', lead.referred_by_id)
        .maybeSingle()
    : Promise.resolve({ data: null } as { data: { id: string, name: string } | null })

  const [contactsRes, engagementsRes, touchesRes, notesRes, jobNotesRes, locRes, referrerRes, referredUsRes, tagsRes] = await Promise.all([
    supabaseService.from('lead_contacts').select('id, name, role, phone, email').eq('lead_id', id).order('created_at', { ascending: true }),
    supabaseService.from('engagements').select('id, title, description, stage, founded_by, created_at, stage_entered_at, closed_at, closed_reason, closed_note, nurture_started_at, total_invoiced, total_paid, balance_owing').eq('client_id', id).order('created_at', { ascending: false }),
    supabaseService.from('touchpoints').select('id, kind, method, label, notes, occurred_at, engagement_id, user_id').eq('lead_id', id).order('occurred_at', { ascending: false }).limit(50),
    supabaseService.from('lead_notes').select('id, kind, text, user_label, created_at').eq('lead_id', id).eq('kind', 'buzz').order('created_at', { ascending: false }).limit(50),
    // ALL kind='job' notes with engagement_id — ClientProfile's
    // client-WIDE activity slice tags engagement-scoped ones
    // '· re: <title>'; PersonCard filters to engagement_id IS NULL
    // (client-level only) client-side.
    supabaseService.from('lead_notes').select('id, kind, text, user_label, created_at, engagement_id').eq('lead_id', id).eq('kind', 'job').order('created_at', { ascending: false }).limit(50),
    supabaseService.from('locations').select('name').eq('id', lead.location_uuid).maybeSingle(),
    referrerQuery,
    // Reverse direction — leads THIS client referred (kind='lead' rows
    // pointing back here). Junk exclusion via .not(is,true) — NULL stays.
    supabaseService.from('leads').select('id, name, created_at').eq('referred_by_kind', 'lead').eq('referred_by_id', id).not('is_junk', 'is', true).order('created_at', { ascending: false }).range(0, 49),
    // Tag junction rows — resolved to lookup LABELS below (the v4 tags
    // row renders labels, not the classic attrs.key ids).
    supabaseService.from('lead_tags').select('id, tag_lookup_id').eq('lead_id', id),
  ])

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
  let tags: string[] = []
  if (tagLookupIds.length > 0) {
    const { data: tagRows } = await supabaseService
      .from('lookups')
      .select('id, label')
      .in('id', tagLookupIds)
    tags = (tagsRes.data ?? [])
      .map((lt: any) => (tagRows ?? []).find(r => r.id === lt.tag_lookup_id)?.label)
      .filter(Boolean) as string[]
  }

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

  return NextResponse.json({
    client: {
      ...lead,
      location_name: locRes.data?.name ?? null,
      referred_by_name: referrerRes.data?.name ?? null,
      assigned_to_name: lead.assigned_to ? (authorById[lead.assigned_to] ?? null) : null,
    },
    referred_us: referredUsRes.data ?? [],
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
