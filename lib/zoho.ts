const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'
const ZOHO_API_BASE = process.env.ZOHO_API_BASE!

let cachedToken: { token: string; expiresAt: number } | null = null

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) {
    return cachedToken.token
  }

  const res = await fetch(
    `${ZOHO_TOKEN_URL}?grant_type=refresh_token&client_id=${process.env.ZOHO_CLIENT_ID}&client_secret=${process.env.ZOHO_CLIENT_SECRET}&refresh_token=${process.env.ZOHO_REFRESH_TOKEN}`,
    { method: 'POST', cache: 'no-store' }
  )
  const data = await res.json()

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + 55 * 60 * 1000,
  }

  return data.access_token
}

export async function zohoGet(endpoint: string) {
  const token = await getAccessToken()
  const res = await fetch(`${ZOHO_API_BASE}/${endpoint}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    cache: 'no-store',
  })
  return res.json()
}

export async function getZohoLocations() {
  const data = await zohoGet(
    'Locations?fields=Name,Location_ID,Email,Phone_Number,Time_Zone,CRM_Status,Jobber_Account_ID,Jobber_Access_Token,Jobber_Refresh_Token,Jobber_Client_ID_App,Jobber_Secret_App,Token_Expiry,Token_Expiry_Display,Last_Sync_Status,Group_Email,Configure_Location_to_Jobber&per_page=200'
  )
  return data.data || []
}

export async function getZohoLocation(locationId: string) {
  const all = await getZohoLocations()
  console.log('Looking for:', locationId, 'Found:', all.find((l: any) => l.Location_ID === locationId)?.Name)
  return all.find((l: any) => l.Location_ID === locationId) || null
}

export async function zohoUpdate(module: string, recordId: string, data: Record<string, unknown>) {
  const token = await getAccessToken()
  const res = await fetch(`${ZOHO_API_BASE}/${module}`, {
    method: 'PUT',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [{ id: recordId, ...data }] }),
    cache: 'no-store',
  })
  const result = await res.json()
  console.log('zohoUpdate result:', JSON.stringify(result))
  return result
}