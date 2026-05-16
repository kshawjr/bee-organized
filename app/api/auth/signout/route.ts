// app/api/auth/signout/route.ts
//
// Signs the user out and redirects to /auth/login.
// Accepts both GET (simple anchor href) and POST.
// Origin is derived from the request URL so this works on any deployment
// (production, preview, localhost) without depending on NEXT_PUBLIC_APP_URL.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

async function doSignOut(req: Request) {
  const supabase = await createServerSupabaseClient()
  await supabase.auth.signOut()
  const url = new URL('/auth/login', new URL(req.url).origin)
  // 303 forces a GET on the target, regardless of the inbound method.
  return NextResponse.redirect(url, { status: 303 })
}

export const GET = doSignOut
export const POST = doSignOut
