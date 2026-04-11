import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getZohoLocations } from '@/lib/zoho'
import crypto from 'crypto'

const JOBBER_AUTH_URL = 'https://api.getjobber.com/api/oauth/authorize'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')

  if (!locationId) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }

  try {
    await requireAuth()

    const locations = await getZohoLocations()
    const location = locations.find((l: any) => l.Location_ID === locationId)

    if (!location) {
      return NextResponse.json({ error: 'Location not found' }, { status: 404 })
    }

    if (!location.Jobber_Client_ID_App) {
      return NextResponse.redirect(
        new URL(`/dashboard/locations/${locationId}?error=no_credentials`, request.url)
      )
    }

    const state = `${locationId}:${crypto.randomBytes(16).toString('hex')}`
    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/jobber/callback`

    const params = new URLSearchParams({
      client_id: location.Jobber_Client_ID_App,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
    })

    return NextResponse.redirect(`${JOBBER_AUTH_URL}?${params.toString()}`)
  } catch (error) {
    console.error('Connect error:', error)
    return NextResponse.redirect(
      new URL(`/dashboard/locations/${locationId}?error=connect_failed`, request.url)
    )
  }
}