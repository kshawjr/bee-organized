import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'

// POST /api/places/autocomplete
// Body: { input: string, sessiontoken: string, types?: 'address' }
//
// Server-side proxy to Google Places Autocomplete (Legacy). The key lives
// only on the server (GOOGLE_PLACES_API_KEY, no NEXT_PUBLIC_ prefix) so it
// stays out of the browser bundle.
//
// Sessiontoken matters for billing: Google bundles all autocomplete calls +
// the final Place Details call under one "session" if they share a token.
// Without it, every keystroke bills separately — ~10x more expensive. The
// client generates the token (crypto.randomUUID()) and keeps reusing it
// until the user picks a suggestion.
//
// Auth gate: any signed-in user can query (no role check) — autocomplete is
// part of the onboarding flow that elevated and franchise users both use.

export async function POST(req: NextRequest) {
  try {
    await requireAuth()

    const apiKey = process.env.GOOGLE_PLACES_API_KEY
    if (!apiKey) {
      console.error('[/api/places/autocomplete] GOOGLE_PLACES_API_KEY not configured')
      return NextResponse.json({ error: 'Places API not configured' }, { status: 500 })
    }

    const body = await req.json().catch(() => ({}))
    const { input, sessiontoken, types } = (body || {}) as {
      input?: string
      sessiontoken?: string
      types?: string
    }

    if (!input || typeof input !== 'string' || input.trim().length < 3) {
      // Match component-side minimum (3 chars). Returning empty rather than
      // an error keeps the client logic simple — no special-casing 400s.
      return NextResponse.json({ predictions: [] })
    }
    if (!sessiontoken || typeof sessiontoken !== 'string') {
      return NextResponse.json({ error: 'sessiontoken required' }, { status: 400 })
    }

    // Restrict to US addresses. If we ever expand internationally, widen
    // the components filter (or accept a country code in the body).
    const params = new URLSearchParams({
      input: input.trim(),
      sessiontoken,
      key: apiKey,
      types: types || 'address',
      components: 'country:us',
    })

    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params.toString()}`
    const res = await fetch(url, { method: 'GET' })
    const json = await res.json().catch(() => ({}))

    // Google returns status='OK' on success, 'ZERO_RESULTS' on no matches,
    // or various error codes. Treat ZERO_RESULTS as empty (not an error).
    if (json.status === 'ZERO_RESULTS') {
      return NextResponse.json({ predictions: [] })
    }
    if (json.status !== 'OK') {
      console.error('[/api/places/autocomplete] Places API status:', json.status, json.error_message)
      return NextResponse.json(
        { error: json.error_message || 'Places API error', status: json.status },
        { status: 502 }
      )
    }

    // Pass through only what the client needs. place_id is opaque — used
    // by the details call. description is the user-facing label.
    const predictions = (json.predictions || []).slice(0, 5).map((p: any) => ({
      place_id: p.place_id,
      description: p.description,
      main_text: p.structured_formatting?.main_text || p.description,
      secondary_text: p.structured_formatting?.secondary_text || '',
    }))

    return NextResponse.json({ predictions })
  } catch (err: any) {
    console.error('[/api/places/autocomplete] error:', err?.message || err)
    return NextResponse.json(
      { error: err?.message || 'Server error' },
      { status: 500 }
    )
  }
}
