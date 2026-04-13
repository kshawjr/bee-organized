const ZOHO_API_BASE = process.env.ZOHO_API_BASE!

let cachedToken: string | null = null
let tokenExpiry = 0

async function getZohoToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken

  const res = await fetch(
    `https://accounts.zoho.com/oauth/v2/token?grant_type=refresh_token&client_id=${process.env.ZOHO_CLIENT_ID}&client_secret=${process.env.ZOHO_CLIENT_SECRET}&refresh_token=${process.env.ZOHO_REFRESH_TOKEN}`,
    { method: 'POST', cache: 'no-store' }
  )
  const data = await res.json()
  cachedToken = data.access_token
  tokenExpiry = Date.now() + 55 * 60 * 1000
  return cachedToken!
}

export async function zohoGet(path: string) {
  const token = await getZohoToken()
  const res = await fetch(`${ZOHO_API_BASE}/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    cache: 'no-store',
  })
  return res.json()
}

export async function zohoUpdate(module: string, id: string, data: object) {
  const token = await getZohoToken()
  const res = await fetch(`${ZOHO_API_BASE}/${module}`, {
    method: 'PUT',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [{ id, ...data }] }),
    cache: 'no-store',
  })
  return res.json()
}

const LOCATION_FIELDS = [
  'Name', 'Location_ID', 'Email', 'Phone_Number', 'Time_Zone', 'CRM_Status',
  'Jobber_Account_ID', 'Jobber_Access_Token', 'Jobber_Refresh_Token',
  'Jobber_Client_ID_App', 'Jobber_Secret_App', 'Token_Expiry', 'Token_Expiry_Display',
  'Last_Sync_Status', 'Group_Email', 'Configure_Location_to_Jobber',
  'Booking_Link', 'Google_Reviews', 'Jobber_URL', 'Website', 'FAQ_Doc', 'Group_ID',
  'Owner',
].join(',')

export async function getZohoLocations() {
  const data = await zohoGet(`Locations?fields=${LOCATION_FIELDS}&per_page=200`)
  return data.data || []
}

export async function getZohoLocation(locationId: string) {
  console.log('Looking for:', locationId)
  const data = await zohoGet(`Locations/search?criteria=(Location_ID:equals:${locationId})&fields=${LOCATION_FIELDS}`)
  const location = data.data?.[0] || null
  console.log('Found:', location?.Name)
  return location
}