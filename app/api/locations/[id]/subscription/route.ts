import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

// GET /api/locations/[id]/subscription — read current subscription state
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = await createServerSupabaseClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('locations')
    .select(
      'id, name, subscription_status, subscription_plan, deferred_until, subscription_started_at, payment_source, paid_through_date, billing_notes, stripe_customer_id, stripe_subscription_id'
    )
    .eq('id', params.id)
    .single()

  if (error) {
    console.error('[locations subscription GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ location: data })
}

// PATCH /api/locations/[id]/subscription — update subscription. Super_admin only.
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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

  if (!hubUser || hubUser.role !== 'super_admin') {
    return NextResponse.json(
      { error: 'forbidden — super_admin only' },
      { status: 403 }
    )
  }

  const body = await request.json().catch(() => ({}))

  const allowedStatuses = ['deferred', 'active', 'past_due', 'canceled']
  const allowedSources = [
    'none',
    'direct',
    'prepaid_corporate',
    'corporate_sponsored',
    'corporate',
    'stripe',
  ]

  const update: Record<string, any> = {}

  if (typeof body.subscription_status === 'string') {
    if (!allowedStatuses.includes(body.subscription_status)) {
      return NextResponse.json(
        { error: `invalid status — must be one of: ${allowedStatuses.join(', ')}` },
        { status: 400 }
      )
    }
    update.subscription_status = body.subscription_status

    if (body.subscription_status === 'active' && !update.subscription_started_at) {
      update.subscription_started_at = new Date().toISOString()
    }
  }

  if (typeof body.payment_source === 'string') {
    if (!allowedSources.includes(body.payment_source)) {
      return NextResponse.json(
        { error: `invalid payment_source — must be one of: ${allowedSources.join(', ')}` },
        { status: 400 }
      )
    }
    update.payment_source = body.payment_source
  }

  if ('paid_through_date' in body) {
    update.paid_through_date = body.paid_through_date || null
  }

  if ('deferred_until' in body) {
    update.deferred_until = body.deferred_until || null
  }

  if ('subscription_plan' in body) {
    update.subscription_plan = body.subscription_plan || null
  }

  if ('billing_notes' in body) {
    update.billing_notes = body.billing_notes || null
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('locations')
    .update(update)
    .eq('id', params.id)
    .select(
      'id, name, subscription_status, subscription_plan, deferred_until, subscription_started_at, payment_source, paid_through_date, billing_notes'
    )
    .single()

  if (error) {
    console.error('[locations subscription PATCH]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, location: data })
}
