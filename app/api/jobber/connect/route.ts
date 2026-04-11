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
    return NextResponse.redirect(
      new URL(`/dashboard/locations/${locationId}?error=no_credentials`, request.url)
    )
  }

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