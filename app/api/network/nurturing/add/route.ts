// app/api/network/nurturing/add/route.ts
//
// POST /api/network/nurturing/add — FL-135 (Kevin, 2026-11-28): the Nurturing
// tab's Add. Body:
//   { location_id, first_name, last_name, email, phone,
//     send_mailchimp: boolean, send_welcome: boolean,   (both unticked by default)
//     existing_id?: the person the screen was told is already here }
// Straight into Nurturing (no 30-day wait). Not an enquiry: no Inbox item, no
// auto-close, no lead alert, no drip, nothing to Jobber (lib/network/nurturing-add.ts).
// Same gate as every Nurturing route: super admins only today.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { maySeeNewNetwork } from '@/lib/network/access'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { networkWriteVerdict, READ_ONLY_ANSWER } from '@/lib/network/route-access'
import { nurtureLocation, clearNurtureCache } from '@/lib/network/nurturing-read'
import { planAdd, newNurtureRow, findSamePerson } from '@/lib/network/nurturing-add'
import { saveNurtureChoice, saveMailchimpChoice } from '@/lib/nurture-choice'
import { sendChosenToMailchimp } from '@/lib/nurture-mailchimp'
import { scheduleWelcomeEmail } from '@/lib/welcome-email'
import { mailchimpOpenFor } from '@/lib/mailchimp-rollout'

export const runtime = 'nodejs'
export const maxDuration = 60

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const WORDS: Record<string, string> = {
  name_required: 'Add a first or last name.',
  contact_required: 'Add an email or a phone number.',
  bad_email: 'That email address doesn’t look right.',
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!maySeeNewNetwork(caller.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }
  if (!UUID.test(String(body?.location_id || ''))) return NextResponse.json({ error: 'location_id must be one location id' }, { status: 400 })
  const may = networkWriteVerdict(caller, body.location_id)
  if (may === 'not_found') return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
  if (may === 'read_only') return NextResponse.json(READ_ONLY_ANSWER, { status: 403 })
  const blocked = await readOnlyWriteBlock({ role: caller.role }, body.location_id)
  if (blocked) return blocked
  const loc = await nurtureLocation(supabaseService, body.location_id)
  if (!loc) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })

  const sendMailchimp = body?.send_mailchimp === true && mailchimpOpenFor(loc.id)
  const sendWelcome = body?.send_welcome === true
  const nowIso = new Date().toISOString()

  // ── Someone already here: put THAT person in Nurturing instead ──
  if (body?.existing_id) {
    if (!UUID.test(String(body.existing_id))) return NextResponse.json({ error: 'not_a_person_id' }, { status: 400 })
    const { data: lead } = await supabaseService.from('leads').select('id, name, email, location_uuid, import_source, paid_amount').eq('id', body.existing_id).maybeSingle()
    if (!lead || lead.location_uuid !== loc.id) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (!(await saveNurtureChoice(lead.id, 'in', 'nurturing_add', caller.userId))) return NextResponse.json({ error: 'not_saved' }, { status: 500 })
    const mc = sendMailchimp && lead.email && (await saveMailchimpChoice(lead.id, 'in', 'nurturing_add', caller.userId)) ? await sendChosenToMailchimp(lead.id, loc.id) : null
    const welcome = sendWelcome && lead.email ? await scheduleWelcomeEmail(lead.id, { import_source: lead.import_source, paid_amount: lead.paid_amount }) : null
    clearNurtureCache()
    return NextResponse.json({ ok: true, id: lead.id, existing: true, mailchimp: mc, welcome })
  }

  const plan = planAdd({ firstName: body?.first_name, lastName: body?.last_name, email: body?.email, phone: body?.phone, sendMailchimp, sendWelcome }, loc)
  if (!plan.ok) return NextResponse.json({ error: plan.error, words: WORDS[plan.error] }, { status: 400 })
  const same = await findSamePerson(supabaseService, loc, plan)
  if (same) return NextResponse.json({ error: 'already_here', person: same, words: `${same.name} is already in Bee Hub here.` }, { status: 409 })

  const { data: made, error } = await supabaseService.from('leads').insert(newNurtureRow(plan, loc, caller.userId, nowIso)).select('id').single()
  if (error || !made) return NextResponse.json({ error: 'not_saved', detail: error?.message }, { status: 500 })
  await supabaseService.from('touchpoints').insert({
    lead_id: made.id, location_uuid: loc.id, kind: 'system', label: 'Added to Nurturing', user_id: caller.userId, occurred_at: nowIso,
  })
  const mc = plan.mailchimp ? await sendChosenToMailchimp(made.id, loc.id) : null
  const welcome = plan.welcome ? await scheduleWelcomeEmail(made.id, { import_source: 'nurturing_add', paid_amount: 0 }) : null
  clearNurtureCache()
  return NextResponse.json({ ok: true, id: made.id, mailchimp: mc, welcome }, { status: 201 })
}
