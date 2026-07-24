import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { isValidPaymentLinkUrl } from '@/lib/stripe-links'

const VALID_TIER_IDS = ['owner', 'manager', 'light', 'readonly'] as const
type TierId = (typeof VALID_TIER_IDS)[number]

type TierPriceRow = {
  id: TierId
  display_name: string
  price_annual: number
  description: string | null
  sort_order: number
  updated_at: string
  payment_link_url?: string | null // absent pre-migration (tier_prices_payment_links.sql)
}

// GET — fetch all tier prices, ordered by sort_order. Any authenticated user.
// select('*') on purpose: payment_link_url may not exist yet (held
// migration), and an explicit column list would turn every read into an
// unknown-column error until it's applied.
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
    .select('*')
    .order('sort_order', { ascending: true })

  if (error) {
    console.error('[tier_prices GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data || [])
}

// PUT — update one or more tier prices. Super_admin or admin only.
// Body: { prices: [{ id, price_annual, payment_link_url? }, ...] }
// payment_link_url is OPTIONAL per entry and only written when the key is
// present ('' clears to null) — so price-only saves keep working on a
// pre-migration schema that lacks the column.
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
    if ('payment_link_url' in entry) {
      const link = entry.payment_link_url
      const cleared = link === null || link === ''
      if (!cleared && !isValidPaymentLinkUrl(link)) {
        return NextResponse.json(
          { error: `payment_link_url must be an https URL (or empty to clear) for tier ${entry.id}` },
          { status: 400 }
        )
      }
    }
  }

  for (const entry of prices) {
    const update: Record<string, any> = {
      price_annual: entry.price_annual,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    }
    if ('payment_link_url' in entry) {
      update.payment_link_url =
        entry.payment_link_url === '' ? null : entry.payment_link_url
    }
    const { error: upErr } = await supabase
      .from('tier_prices')
      .update(update)
      .eq('id', entry.id)

    if (upErr) {
      console.error('[tier_prices PUT]', entry.id, upErr)
      const hint =
        'payment_link_url' in entry && /payment_link_url/.test(upErr.message)
          ? ' — has migrations/tier_prices_payment_links.sql been applied?'
          : ''
      return NextResponse.json(
        { error: `update failed for ${entry.id}: ${upErr.message}${hint}` },
        { status: 500 }
      )
    }
  }

  const { data: updated, error: readErr } = await supabase
    .from('tier_prices')
    .select('*')
    .order('sort_order', { ascending: true })

  if (readErr) {
    console.error('[tier_prices PUT read-back]', readErr)
    return NextResponse.json({ error: readErr.message }, { status: 500 })
  }

  return NextResponse.json(updated || [])
}
