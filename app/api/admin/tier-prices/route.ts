import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

const VALID_TIER_IDS = ['owner', 'manager', 'light', 'readonly'] as const
type TierId = (typeof VALID_TIER_IDS)[number]

type TierPriceRow = {
  id: TierId
  display_name: string
  price_annual: number
  description: string | null
  sort_order: number
  updated_at: string
}

// GET — fetch all tier prices, ordered by sort_order. Any authenticated user.
export async function GET() {
  const supabase = await createServerSupabaseClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('tier_prices')
    .select('id, display_name, price_annual, description, sort_order, updated_at')
    .order('sort_order', { ascending: true })

  if (error) {
    console.error('[tier_prices GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data || [])
}

// PUT — update one or more tier prices. Super_admin or admin only.
// Body: { prices: [{ id, price_annual }, ...] }
export async function PUT(request: NextRequest) {
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

  const allowedRoles = ['super_admin', 'admin']
  if (!hubUser || !allowedRoles.includes(hubUser.role)) {
    return NextResponse.json(
      { error: 'forbidden — super_admin or admin only' },
      { status: 403 }
    )
  }

  const body = await request.json().catch(() => ({}))
  const prices = body?.prices

  if (!Array.isArray(prices) || prices.length === 0) {
    return NextResponse.json(
      { error: 'invalid payload — prices must be a non-empty array' },
      { status: 400 }
    )
  }

  for (const entry of prices) {
    if (!entry || typeof entry !== 'object') {
      return NextResponse.json({ error: 'invalid entry shape' }, { status: 400 })
    }
    if (!VALID_TIER_IDS.includes(entry.id)) {
      return NextResponse.json(
        { error: `invalid tier id: ${entry.id}` },
        { status: 400 }
      )
    }
    if (!Number.isInteger(entry.price_annual) || entry.price_annual < 0) {
      return NextResponse.json(
        { error: `price_annual must be a non-negative integer for tier ${entry.id}` },
        { status: 400 }
      )
    }
  }

  for (const { id, price_annual } of prices) {
    const { error: upErr } = await supabase
      .from('tier_prices')
      .update({
        price_annual,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (upErr) {
      console.error('[tier_prices PUT]', id, upErr)
      return NextResponse.json(
        { error: `update failed for ${id}: ${upErr.message}` },
        { status: 500 }
      )
    }
  }

  const { data: updated, error: readErr } = await supabase
    .from('tier_prices')
    .select('id, display_name, price_annual, description, sort_order, updated_at')
    .order('sort_order', { ascending: true })

  if (readErr) {
    console.error('[tier_prices PUT read-back]', readErr)
    return NextResponse.json({ error: readErr.message }, { status: 500 })
  }

  return NextResponse.json(updated || [])
}
