// app/api/mailchimp/import/choice/route.ts
//
// MAILCHIMP SLICE 7 (FL-75, 2026-11-26): save ONE tick on "Who comes in from
// Mailchimp", so it survives leaving the screen.
//
//   POST { location_id, scope: 'group'|'person', key, choice: 'in'|'out'|null }
//
// Writes only the mailchimp_import_choices table (lib/mailchimp-import-choices.ts).
// Brings nobody in, sends nothing. Pilot locations only. Same
// resolveMailchimpTarget gate as every other Mailchimp route.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { resolveMailchimpTarget, targetFailureResponse } from '@/lib/mailchimp-oauth-guard'
import { saveImportChoice } from '@/lib/mailchimp-import-choices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'bad_request' }, { status: 400 }) }
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const t = await resolveMailchimpTarget(supabase, user.id, typeof body?.location_id === 'string' ? body.location_id : null)
  if (!t.ok) {
    const f = targetFailureResponse(t.reason)
    return NextResponse.json({ error: f.error }, { status: f.status })
  }
  const r = await saveImportChoice(t.locationUuid, user.id, { scope: body?.scope, key: body?.key, choice: body?.choice ?? null })
  if (!r.ok) return NextResponse.json({ error: r.error, words: r.words }, { status: r.status })
  return NextResponse.json({ ok: true })
}
