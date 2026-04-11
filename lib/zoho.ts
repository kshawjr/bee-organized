const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'
const ZOHO_API_BASE = process.env.ZOHO_API_BASE!

async function getAccessToken(): Promise<string> {
  const res = await fetch(
    `${ZOHO_TOKEN_URL}?grant_type=refresh_token&client_id=${process.env.ZOHO_CLIENT_ID}&client_secret=${process.env.ZOHO_CLIENT_SECRET}&refresh_token=${process.env.ZOHO_REFRESH_TOKEN}`,
    { method: 'POST' }
  )
  const data = await res.json()
  return data.access_token
}

export async function zohoGet(endpoint: string) {
  const token = await getAccessToken()
  const res = await fetch(`${ZOHO_API_BASE}/${endpoint}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  })
  return res.json()
}

export async function getZohoLocations() {
  const data = await zohoGet(
    'Locations?fields=Name,Location_ID,Email,Phone_Number,Time_Zone,CRM_Status,Jobber_Account_ID,Jobber_Client_ID_App,Token_Expiry,Token_Expiry_Display,Last_Sync_Status,Group_Email,Configure_Location_to_Jobber,Booking_Link,Google_Reviews,Jobber_URL,Website,FAQ_Doc,Group_ID&per_page=200'
  )
  return data.data || []
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
  })
  return res.json()
}