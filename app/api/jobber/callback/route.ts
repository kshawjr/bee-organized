import { NextRequest, NextResponse } from 'next/server'
import { getZohoLocation, zohoUpdate } from '@/lib/zoho'

const JOBBER_TOKEN_URL = 'https://api.getjobber.com/api/oauth/token'
const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql'
const JOBBER_API_VERSION = '2025-04-16'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error || !code || !state) {
    return NextResponse.redirect(
      new URL('/dashboard/locations?error=jobber_denied', request.url)
    )
  }

  const locationId = state.split(':')[0]

  try {
    const location = await getZohoLocation(locationId)

    if (!location) {
      return NextResponse.redirect(new URL('/dashboard/locations?error=not_found', request.url))
    }

    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/jobber/callback`

    const tokenRes = await fetch(JOBBER_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.JOBBER_CLIENT_ID!,
        client_secret: process.env.JOBBER_CLIENT_SECRET!,
        code,
        redirect_uri: redirectUri,
      }),
    })

    const tokenText = await tokenRes.text()
    console.log('Token response:', tokenText)

    let tokens
    try {
      tokens = JSON.parse(tokenText)
    } catch {
      console.error('Token parse error:', tokenText)
      return NextResponse.redirect(
        new URL(`/dashboard/locations/${locationId}?error=token_parse_failed`, request.url)
      )
    }

    if (!tokens.access_token) {
      console.error('No access token:', tokens)
      return NextResponse.redirect(
        new URL(`/dashboard/locations/${locationId}?error=no_access_token`, request.url)
      )
    }

    const accountRes = await fetch(JOBBER_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
        'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION,
      },
      body: JSON.stringify({ query: '{ account { id name } }' }),
    })

    const accountData = await accountRes.json()
    const accountId = accountData.data?.account?.id

    console.log('Account ID:', accountId)
    console.log('Attempting zoho update for record:', location.id)

    const expiryMs = Date.now() + 55 * 60 * 1000

    console.log('Update payload:', JSON.stringify({
  Jobber_Client_ID_App: process.env.JOBBER_CLIENT_ID,
  Jobber_Secret_App: process.env.JOBBER_CLIENT_SECRET,
}))

await zohoUpdate('Locations', location.id, {
  Jobber_Access_Token: tokens.access_token,
  Jobber_Refresh_Token: tokens.refresh_token,
  Jobber_Account_ID: accountId,
  Jobber_Client_ID_App: process.env.JOBBER_CLIENT_ID,
  Jobber_Secret_App: process.env.JOBBER_CLIENT_SECRET,
  Token_Expiry: expiryMs.toString(),
  Token_Expiry_Display: new Date(expiryMs).toISOString().slice(0, 19),
  Last_Sync_Status: `Connected via Hub: ${new Date().toLocaleString()}`,
})

    return NextResponse.redirect(
      new URL(`/dashboard/locations/${locationId}?success=connected`, request.url)
    )
  } catch (err) {
    console.error('Callback error:', err)
    return NextResponse.redirect(
      new URL(`/dashboard/locations/${locationId}?error=callback_failed`, request.url)
    )
  }
}