import { NextResponse } from 'next/server'
import { getZohoLocations } from '@/lib/zoho'

export async function GET() {
  try {
    const locations = await getZohoLocations()
    return NextResponse.json({ locations, count: locations.length })
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
