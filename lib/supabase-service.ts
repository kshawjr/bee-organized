// lib/supabase-service.ts
// Service role client for server-side writes (API routes only)
// Never use this on the client side — it bypasses RLS

import { createClient } from '@supabase/supabase-js'

export const supabaseService = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)