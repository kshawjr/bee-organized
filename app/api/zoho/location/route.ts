import { NextRequest, NextResponse } from 'next/server'
import { getZohoLocation } from '@/lib/zoho'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id') || 'loc_test'
  const data = await getZohoLocation(id)
  return NextResponse.json({ data })
}
