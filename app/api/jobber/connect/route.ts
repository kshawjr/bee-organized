// app/api/jobber/connect/route.ts
// Initiates the Jobber OAuth flow. Called by the BeeHub UI.
// Expects ?location_id=... where location_id matches the locations.id (UUID)
// or locations.location_id (slug).

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

const JOBBER_AUTH_URL = 'https://api.getjobber.com/api/oauth/authorize'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')

  if (!locationId) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }

  const clientId = process.env.JOBBER_CLIENT_ID

  if (!clientId) {
    const home = new URL('/', request.url)
    home.searchParams.set('jobber', 'error')
    home.searchParams.set('reason', 'no_credentials')
    home.searchParams.set('loc', locationId)
    return NextResponse.redirect(home)
  }

  // State includes locationId + random nonce for CSRF protection
  const state = `${locationId}:${crypto.randomBytes(16).toString('hex')}`
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/jobber/callback`

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
  })

  return NextResponse.redirect(`${JOBBER_AUTH_URL}?${params.toString()}`)
}
