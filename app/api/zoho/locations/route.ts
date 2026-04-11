import { NextResponse } from 'next/server'
import { zohoGet } from '@/lib/zoho'

export async function GET() {
  try {
    const data = await zohoGet(
      'Locations?fields=Name,Location_ID,Time_Zone,CRM_Status,Jobber_Account_ID,Configure_Location_to_Jobber,Group_Email&per_page=200'
    )
    return NextResponse.json(data)
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}