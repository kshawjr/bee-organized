import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'

// POST /api/places/details
// Body: { place_id: string, sessiontoken: string }
//
// Resolves a place_id (from the autocomplete response) to structured address
// components: street, city, state, zip, etc. Called exactly once per
// autocomplete session — when the user clicks a suggestion. Sharing the
// sessiontoken with the autocomplete calls bundles them under one billable
// session (much cheaper than per-keystroke billing).
//
// Only requests `address_components` and `formatted_address` fields to keep
// the per-request cost minimal. If we ever need lat/lng for mapping later,
// add `geometry` to the fields list.

const FIELDS = 'address_components,formatted_address'

// Map Google's address_components types[] → our flat shape.
// Google returns an array of components each with `long_name`, `short_name`,
// and a `types[]` array. We pick the right one for each of our fields.
function parseComponents(components: any[]): {
  street: string
  apt: string
  city: string
  state: string
  zip: string
  country: string
} {
  const get = (type: string, short = false) => {
    const c = components.find((c: any) => Array.isArray(c.types) && c.types.includes(type))
    if (!c) return ''
    return short ? (c.short_name || '') : (c.long_name || '')
  }

  // Street = street_number + route (e.g. "123" + "Main St")
  const streetNum = get('street_number')
  const route = get('route')
  const street = [streetNum, route].filter(Boolean).join(' ')

  // City: locality is the standard residential city. Fallbacks for places
  // where locality isn't returned (some unincorporated areas):
  //   - sublocality (NYC boroughs, e.g. "Brooklyn")
  //   - administrative_area_level_3 (some townships)
  //   - administrative_area_level_2 (county; last resort)
  const city =
    get('locality') ||
    get('sublocality') ||
    get('administrative_area_level_3') ||
    get('administrative_area_level_2')

  const apt = get('subpremise')  // apartment / unit number (e.g. "Apt 4B")
  const state = get('administrative_area_level_1', true)  // 2-letter code
  const zip = get('postal_code')
  const country = get('country', true)

  return { street, apt, city, state, zip, country }
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth()

    const apiKey = process.env.GOOGLE_PLACES_API_KEY
    if (!apiKey) {
      console.error('[/api/places/details] GOOGLE_PLACES_API_KEY not configured')
      return NextResponse.json({ error: 'Places API not configured' }, { status: 500 })
    }

    const body = await req.json().catch(() => ({}))
    const { place_id, sessiontoken } = (body || {}) as {
      place_id?: string
      sessiontoken?: string
    }

    if (!place_id || typeof place_id !== 'string') {
      return NextResponse.json({ error: 'place_id required' }, { status: 400 })
    }
    if (!sessiontoken || typeof sessiontoken !== 'string') {
      return NextResponse.json({ error: 'sessiontoken required' }, { status: 400 })
    }

    const params = new URLSearchParams({
      place_id,
      sessiontoken,
      key: apiKey,
      fields: FIELDS,
    })
    const url = `https://maps.googleapis.com/maps/api/place/details/json?${params.toString()}`
    const res = await fetch(url, { method: 'GET' })
    const json = await res.json().catch(() => ({}))

    if (json.status !== 'OK') {
      console.error('[/api/places/details] Places API status:', json.status, json.error_message)
      return NextResponse.json(
        { error: json.error_message || 'Places API error', status: json.status },
        { status: 502 }
      )
    }

    const result = json.result || {}
    const parsed = parseComponents(result.address_components || [])

    return NextResponse.json({
      formatted: result.formatted_address || '',
      ...parsed,
    })
  } catch (err: any) {
    console.error('[/api/places/details] error:', err?.message || err)
    return NextResponse.json(
      { error: err?.message || 'Server error' },
      { status: 500 }
    )
  }
}
