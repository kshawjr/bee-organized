import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const error = searchParams.get('error')

  if (error || !code) {
    return NextResponse.json({ error: error || 'No code received', all_params: Object.fromEntries(searchParams) }, { status: 400 })
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.ZOHO_CLIENT_ID!,
    client_secret: process.env.ZOHO_CLIENT_SECRET!,
    code,
    redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/zoho/callback`,
  })

  const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  const tokens = await res.json()

  // Return everything so we can debug
  return NextResponse.json({
    tokens,
    code_used: code,
    redirect_uri_used: `${process.env.NEXT_PUBLIC_APP_URL}/api/zoho/callback`,
    client_id_used: process.env.ZOHO_CLIENT_ID,
  })
}