// app/api/engagements/route.ts
//
// GET /api/engagements?closed=1[&stage=won|lost][&location_uuid=][&offset=][&limit=]
//
// Collection endpoint for the EngagementList's lazy 'Closed' page — the
// initial page load deliberately ships only OPEN engagements plus a
// closed COUNT, so ~1,400 terminal rows never ride in the page payload.
// Returns { rows, total, offset, limit } ordered closed_at desc; rows
// carry client_name (joined) in the same shape the list renders.
//
// Only closed=1 is supported — open engagements ship server-rendered via
// _hub-page. Auth: logged-in hub_user; elevated may scope with
// location_uuid; everyone else is forced to their own location.
//
// POST /api/engagements — { client_id, title? }
//
// Manual founding (founded_by='manual'), the decoupled local write behind
// "Start new engagement" on a returning client. Founds a NEW engagement
// under the EXISTING lead — never a second leads row, so the returning-
// client path can no longer trip leads_jobber_client_id_location_idx.
// Every call is a distinct concurrent engagement (rule 1). Returns the
// real inserted row in the board shape _hub-page ships (client_name/
// phone/email + repeat_count + empty children).

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { foundManualEngagement } from '@/lib/engagements'
// PURE zero-import module (§8.5) — safe from the server route; ONE
// source for the terminal stage strings ('Closed Won' / 'Closed Lost').
import { CLOSED_STAGE_FILTERS } from '@/components/hive/shared/stageConfig'

export async function GET(req: Request) {
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

  const url = new URL(req.url)

  // ── OPEN mode: the board's focus-revalidation read ──────────────
  // GET /api/engagements?open=1[&location_uuid=]
  //
  // Serves the SAME open-engagement board shape _hub-page ships at page
  // load (client_name/phone/email + repeat_count + minimal child arrays),
  // so HiveShell's focus/visibility revalidation reconciles server-derived
  // stage moves (webhook/import) without a full reload. The shape MUST
  // mirror _hub-page.tsx initialEngagements — keep them in lockstep.
  if (url.searchParams.get('open') === '1') {
    // Scope: owners locked to their location; elevated may pass one.
    const requestedLoc = url.searchParams.get('location_uuid')
    const scopeLoc = isAdmin(hubUser.role) ? (requestedLoc || null) : hubUser.location_id

    // Short-page .range() loop — the 1000-row silent-truncation gotcha
    // applies here exactly as it does in _hub-page's engagement fetch.
    const OPEN_PAGE = 1000
    const notTerminal = `(${CLOSED_STAGE_FILTERS.closed.map(s => `"${s}"`).join(',')})`
    const openRows: any[] = []
    for (let from = 0; ; from += OPEN_PAGE) {
      let q = supabaseService
        .from('engagements')
        .select('*')
        .not('stage', 'in', notTerminal)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, from + OPEN_PAGE - 1)
      if (scopeLoc) q = q.eq('location_uuid', scopeLoc)
      const { data, error } = await q
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      openRows.push(...(data || []))
      if ((data || []).length < OPEN_PAGE) break
    }

    if (openRows.length === 0) return NextResponse.json({ rows: [], total: 0 })

    const clientIds = Array.from(new Set(openRows.map(r => r.client_id).filter(Boolean)))
    const engIds = openRows.map(r => r.id)

    // client name/contact for the joined card headline.
    const infoById: Record<string, { name: string; phone: string | null; email: string | null }> = {}
    if (clientIds.length > 0) {
      const { data: leads } = await supabaseService
        .from('leads').select('id, name, phone, email').in('id', clientIds)
      for (const l of leads ?? []) infoById[l.id] = { name: l.name || 'Unknown', phone: l.phone || null, email: l.email || null }
    }

    // repeat_count: ALL engagements per client (closed included), the same
    // count _hub-page's all-engagements sweep produces.
    const repeatCounts: Record<string, number> = {}
    if (clientIds.length > 0) {
      for (let i = 0; i < clientIds.length; i += 200) {
        const chunk = clientIds.slice(i, i + 200)
        const { data } = await supabaseService
          .from('engagements').select('id, client_id').in('client_id', chunk)
        for (const r of data ?? []) repeatCounts[r.client_id] = (repeatCounts[r.client_id] || 0) + 1
      }
    }

    // Child rows by engagement_id — same projection _hub-page ships for the
    // board chips (value/status derivation + linked-vs-local gate).
    const byEng = <T extends { engagement_id?: string | null }>(rows: T[] | null) => {
      const out: Record<string, T[]> = {}
      ;(rows || []).forEach(r => {
        if (!r.engagement_id) return
        ;(out[r.engagement_id] ||= []).push(r)
      })
      return out
    }
    const fetchByEng = async (table: string, cols: string): Promise<any[]> => {
      const acc: any[] = []
      for (let i = 0; i < engIds.length; i += 200) {
        const chunk = engIds.slice(i, i + 200)
        const { data, error } = await supabaseService.from(table).select(cols).in('engagement_id', chunk)
        if (error) {
          console.error(`[engagements?open] ${table} child fetch failed: ${error.message}`)
          continue
        }
        acc.push(...(data || []))
      }
      return acc
    }
    const [quotesRaw, jobsRaw, invoicesRaw, assessmentsRaw, serviceReqsRaw] = await Promise.all([
      fetchByEng('quotes', 'id, engagement_id, status, total, sent_at, approved_at'),
      fetchByEng('jobs', 'id, engagement_id, status, title, scheduled_start, completed_at'),
      fetchByEng('invoices', 'id, engagement_id, status, total, balance_owing'),
      fetchByEng('assessments', 'id, engagement_id, scheduled_at, status, completed_at'),
      fetchByEng('service_requests', 'id, engagement_id'),
    ])
    const quotesByEng = byEng(quotesRaw)
    const jobsByEng = byEng(jobsRaw)
    const invoicesByEng = byEng(invoicesRaw)
    const assessmentsByEng = byEng(assessmentsRaw)
    const serviceReqsByEng = byEng(serviceReqsRaw)

    const rows = openRows.map((e: any) => ({
      ...e,
      client_name: infoById[e.client_id]?.name || 'Unknown',
      client_phone: infoById[e.client_id]?.phone ?? null,
      client_email: infoById[e.client_id]?.email ?? null,
      repeat_count: repeatCounts[e.client_id] || 1,
      quotes: (quotesByEng[e.id] || []).map((q: any) => ({
        id: q.id, status: q.status, total: q.total, sent_at: q.sent_at, approved_at: q.approved_at,
      })),
      jobs: (jobsByEng[e.id] || []).map((j: any) => ({
        id: j.id, status: j.status, title: j.title, scheduled_start: j.scheduled_start, completed_at: j.completed_at,
      })),
      invoices: (invoicesByEng[e.id] || []).map((i: any) => ({
        id: i.id, status: i.status, total: i.total, balance_owing: i.balance_owing,
      })),
      assessments: (assessmentsByEng[e.id] || []).map((a: any) => ({
        id: a.id, scheduled_at: a.scheduled_at, status: a.status, completed_at: a.completed_at,
      })),
      service_requests: (serviceReqsByEng[e.id] || []).map((sr: any) => ({ id: sr.id })),
    }))

    return NextResponse.json({ rows, total: rows.length })
  }

  if (url.searchParams.get('closed') !== '1') {
    return NextResponse.json({ error: 'unsupported_query', hint: 'only closed=1 or open=1 is served here' }, { status: 400 })
  }
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0)
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200))

  // Optional won/lost narrowing — vocabulary lives in stageConfig, the
  // audited stage strings, never inline literals.
  const stageParam = url.searchParams.get('stage') || 'closed'
  const stages = (CLOSED_STAGE_FILTERS as Record<string, string[]>)[stageParam]
  if (!stages) {
    return NextResponse.json({ error: 'unsupported_stage', hint: 'stage must be won or lost' }, { status: 400 })
  }

  // Scope: owners locked to their location; elevated may pass one.
  const requestedLoc = url.searchParams.get('location_uuid')
  const scopeLoc = isAdmin(hubUser.role)
    ? (requestedLoc || null)
    : hubUser.location_id

  let q = supabaseService
    .from('engagements')
    .select('*', { count: 'exact' })
    .in('stage', stages)
    .order('closed_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1)
  if (scopeLoc) q = q.eq('location_uuid', scopeLoc)

  const { data: rows, count, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Join client name + contact for this page in one query.
  const clientIds = Array.from(new Set((rows ?? []).map(r => r.client_id).filter(Boolean)))
  const infoById: Record<string, { name: string; phone: string | null; email: string | null }> = {}
  if (clientIds.length > 0) {
    const { data: leads } = await supabaseService
      .from('leads')
      .select('id, name, phone, email')
      .in('id', clientIds)
    for (const l of leads ?? []) infoById[l.id] = { name: l.name || 'Unknown', phone: l.phone || null, email: l.email || null }
  }

  return NextResponse.json({
    rows: (rows ?? []).map(r => ({
      ...r,
      client_name: infoById[r.client_id]?.name || 'Unknown',
      client_phone: infoById[r.client_id]?.phone ?? null,
      client_email: infoById[r.client_id]?.email ?? null,
    })),
    total: count ?? 0,
    offset,
    limit,
  })
}

export async function POST(req: Request) {
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
  if (hubUser.role === 'lite_user') {
    return NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 })
  }

  let body: { client_id?: string; title?: string | null }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }
  if (!body.client_id || typeof body.client_id !== 'string') {
    return NextResponse.json({ error: 'client_id required' }, { status: 400 })
  }
  if (body.title != null && (typeof body.title !== 'string' || body.title.length > 200)) {
    return NextResponse.json({ error: 'invalid_title' }, { status: 400 })
  }

  // Location scoping rides the LEAD (same rule as send-to-jobber): the
  // engagement inherits leads.location_uuid inside foundManualEngagement,
  // so the gate checks the same value the write will use.
  const { data: lead, error: leadErr } = await supabaseService
    .from('leads')
    .select('id, name, phone, email, location_uuid')
    .eq('id', body.client_id)
    .maybeSingle()
  if (leadErr) return NextResponse.json({ error: leadErr.message }, { status: 500 })
  if (!lead) return NextResponse.json({ error: 'client_not_found' }, { status: 404 })
  if (!isAdmin(hubUser.role) && hubUser.location_id !== lead.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  // ─── Read-only guard (868kawwmh) ──────────────────────────────
  const roBlock = await readOnlyWriteBlock(hubUser, lead.location_uuid)
  if (roBlock) return roBlock

  const founded = await foundManualEngagement({
    clientId: lead.id,
    title: body.title ?? null,
    note: `manual founding via POST /api/engagements by hub_user ${hubUser.id}`,
  })
  if ('error' in founded) {
    return NextResponse.json({ error: founded.error }, { status: 500 })
  }

  // repeat_count matches the _hub-page sweep: ALL engagements for this
  // client, closed included, the new row among them.
  const { count: repeatCount } = await supabaseService
    .from('engagements')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', lead.id)

  return NextResponse.json({
    engagement: {
      ...founded.engagement,
      client_name: lead.name || 'Unknown',
      client_phone: lead.phone || null,
      client_email: lead.email || null,
      repeat_count: repeatCount ?? 1,
      quotes: [],
      jobs: [],
      invoices: [],
      assessments: [],
    },
  }, { status: 201 })
}
