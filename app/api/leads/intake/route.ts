// app/api/leads/intake/route.ts
//
// Producer-agnostic webhook for inbound lead form submissions.
// Auth: X-API-Key header, constant-time compared to LEAD_INTAKE_API_KEY env.
// Inserts one row into `leads` with stage='New'. No service_requests row is
// created here — these are pre-Jobber leads, the Hive pipeline will pick them
// up via stage filter.

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function verifyApiKey(headerValue: string | null): boolean {
  const expected = process.env.LEAD_INTAKE_API_KEY
  if (!expected || !headerValue) return false
  const a = Buffer.from(headerValue)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function splitName(full: string): { first: string | null; last: string | null } {
  const trimmed = full.trim()
  const idx = trimmed.indexOf(' ')
  if (idx === -1) return { first: trimmed || null, last: null }
  return {
    first: trimmed.slice(0, idx),
    last: trimmed.slice(idx + 1).trim() || null,
  }
}

export async function POST(req: NextRequest) {
  if (!verifyApiKey(req.headers.get('x-api-key'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const {
    location_slug,
    full_name,
    email,
    phone,
    address,
    city,
    state,
    zip,
    project_type,
    message,
    source,
    metadata,
  } = body || {}

  if (!location_slug || typeof location_slug !== 'string') {
    return NextResponse.json({ error: 'location_slug required' }, { status: 400 })
  }
  if (!full_name || typeof full_name !== 'string' || !full_name.trim()) {
    return NextResponse.json({ error: 'full_name required' }, { status: 400 })
  }
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'valid email required' }, { status: 400 })
  }

  // Slug lives in locations.location_id (Zoho-style ID, used as slug across repo).
  const { data: location, error: locErr } = await supabaseService
    .from('locations')
    .select('id, name, location_id')
    .eq('location_id', location_slug)
    .maybeSingle()

  if (locErr) {
    return NextResponse.json(
      { error: 'location_lookup_failed', detail: locErr.message },
      { status: 500 },
    )
  }
  if (!location) {
    return NextResponse.json({ error: 'location_not_found' }, { status: 400 })
  }

  const { first, last } = splitName(full_name)
  const now = new Date().toISOString()

  // leads.location_id stores the slug string (matches lib/dual-write.ts and
  // app/api/import/jobber-clients/route.ts), not the UUID.
  const { data: lead, error: insertErr } = await supabaseService
    .from('leads')
    .insert({
      location_id: location.location_id,
      name: full_name.trim(),
      first_name: first,
      last_name: last,
      email: email.trim(),
      phone: phone || null,
      address: address || null,
      city: city || null,
      state: state || null,
      zip: zip || null,
      project_type: project_type || null,
      stage: 'New',
      source: source || 'web_form',
      notes: message || null,
      metadata: metadata || {},
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single()

  if (insertErr || !lead) {
    return NextResponse.json(
      { error: 'insert_failed', detail: insertErr?.message },
      { status: 500 },
    )
  }

  return NextResponse.json({
    success: true,
    lead_id: lead.id,
    location: {
      id: location.id,
      name: location.name,
      slug: location.location_id,
    },
  })
}
