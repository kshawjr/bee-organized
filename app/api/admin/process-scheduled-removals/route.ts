// app/api/admin/process-scheduled-removals/route.ts
//
// POST /api/admin/process-scheduled-removals
// super_admin only — manually triggers the seat-removal job for seats whose
// scheduled_removal_at <= today. Run on March 1 (or whenever renewal hits).
// A future cron can call this automatically; for now it's manual.
//
// Returns: { removed_count, removed_ids }

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (hubUser?.role !== 'super_admin') {
    return NextResponse.json({ error: 'forbidden — super_admin only' }, { status: 403 })
  }

  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  const { data, error } = await supabaseService
    .from('subscription_seats')
    .update({
      status: 'inactive',
      removed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .lte('scheduled_removal_at', today)
    .eq('status', 'active')
    .select('id')

  if (error) {
    console.error('[process-scheduled-removals]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const removed_ids = (data || []).map((r: { id: string }) => r.id)
  return NextResponse.json({ removed_count: removed_ids.length, removed_ids })
}
