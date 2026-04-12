export const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql'
export const JOBBER_API_VERSION = '2025-04-16'

export async function jobberQuery(accessToken: string, query: string, variables?: object) {
  const res = await fetch(JOBBER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  })
  return res.json()
}

async function doRefresh(location: any, zohoToken: string): Promise<string> {
  const ZOHO_API_BASE = process.env.ZOHO_API_BASE!
  console.log('Refreshing Jobber token for:', location.Location_ID)

  const res = await fetch('https://api.getjobber.com/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.JOBBER_CLIENT_ID!,
      client_secret: process.env.JOBBER_CLIENT_SECRET!,
      refresh_token: location.Jobber_Refresh_Token,
    }),
    cache: 'no-store',
  })

  const tokens = await res.json()
  if (!tokens.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(tokens))
  console.log('Token refresh: success')

  // Save tokens only — do NOT write Token_Expiry (Deluge owns that field)
  const zohoRes = await fetch(`${ZOHO_API_BASE}/Locations`, {
    method: 'PUT',
    headers: {
      Authorization: `Zoho-oauthtoken ${zohoToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [{
      id: location.id,
      Jobber_Access_Token: tokens.access_token,
      Jobber_Refresh_Token: tokens.refresh_token,
      Last_Sync_Status: `Token refreshed by Hub: ${new Date().toISOString().slice(0, 19)}`,
    }] }),
    cache: 'no-store',
  })
  const updateResult = await zohoRes.json()
  console.log('Token saved to Zoho:', updateResult?.data?.[0]?.code)

  return tokens.access_token
}

// Test token validity, refresh only if needed
// Does NOT write Token_Expiry — Deluge owns that field
export async function getValidJobberToken(location: any, zohoToken: string): Promise<string> {
  const test = await jobberQuery(location.Jobber_Access_Token, '{ account { id } }')

  if (test?.data?.account?.id) {
    console.log('Jobber token valid — skipping refresh')
    return location.Jobber_Access_Token
  }

  console.log('Jobber token invalid — refreshing')
  return doRefresh(location, zohoToken)
}