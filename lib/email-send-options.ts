// lib/email-send-options.ts
//
// What an owner decides on Settings → Emails that changes WHAT a client email
// says or WHETHER it goes (2026-10-30). One module so the three senders —
// drips (lib/drip-send.ts), the welcome (lib/welcome-email.ts) and the stage
// emails (lib/stage-emails.ts) — and the test send all apply the same rules.
//
//   locations.email_style          the look (lib/drip-email-layout.ts)
//   locations.shows_hourly_rate    false = "I don't show rates"
//   locations.uses_booking_links   false = "I don't use booking links"
//   locations.discovery_booking_link / virtual_booking_link
//                                  {{discovery_booking_link}} / {{virtual_booking_link}}
//   drip_path_steps.is_paused      Pause one email
//   drip_path_steps / templates .button_text + .button_link
//
// EVERY READ HERE IS select('*'). These columns arrive in five migrations that
// Kevin runs by hand, in any order, after the code ships. A named column that
// doesn't exist yet fails the whole select; '*' simply leaves it out, and each
// missing value reads as today's behaviour (Soft, rates shown, links used, not
// paused, no button). Nothing here can stop a send that works today.
//
// THE RATE AND LINK SWITCHES — Kevin, 2026-10-30:
//   An email that ALWAYS sends (drip step 1, the welcome) is never skipped:
//   with rates off it goes out with the price sentence taken out; with links
//   off, with the booking-link sentence taken out and no button that needs a
//   link. Any OTHER email that quotes the rate / asks for a booking link is
//   SKIPPED — passed over, the client moves on — never HELD. Held (waiting for
//   the owner to fill something in) stays exactly as it is today for a
//   location that has the switch ON and the value blank.
//
// Deliberately free of lib/resend.ts imports: sender tests mock resend
// wholesale, and these rules must stay real under those mocks.

import { supabaseService } from './supabase-service'
import { normalizeEmailStyle, type EmailStyle } from './drip-email-layout'
export * from './email-switches'

export type LocationEmailOptions = {
  style: EmailStyle
  showsHourlyRate: boolean
  usesBookingLinks: boolean
  discoveryBookingLink: string | null
  virtualBookingLink: string | null
}

export const DEFAULT_LOCATION_EMAIL_OPTIONS: LocationEmailOptions = {
  style: 'soft',
  showsHourlyRate: true,
  usesBookingLinks: true,
  discoveryBookingLink: null,
  virtualBookingLink: null,
}

function cleanText(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

// Only an explicit false switches something off. NULL / missing is ON.
export function locationEmailOptionsFromRow(row: Record<string, unknown> | null | undefined): LocationEmailOptions {
  if (!row) return { ...DEFAULT_LOCATION_EMAIL_OPTIONS }
  return {
    style: normalizeEmailStyle(row.email_style),
    showsHourlyRate: row.shows_hourly_rate !== false,
    usesBookingLinks: row.uses_booking_links !== false,
    discoveryBookingLink: cleanText(row.discovery_booking_link),
    virtualBookingLink: cleanText(row.virtual_booking_link),
  }
}

export async function readLocationEmailOptions(locationId: string): Promise<LocationEmailOptions> {
  try {
    const { data, error } = await supabaseService
      .from('locations')
      .select('*')
      .eq('id', locationId)
      .maybeSingle()
    if (error || !data) return { ...DEFAULT_LOCATION_EMAIL_OPTIONS }
    return locationEmailOptionsFromRow(data as Record<string, unknown>)
  } catch {
    return { ...DEFAULT_LOCATION_EMAIL_OPTIONS }
  }
}

export type EmailExtras = {
  isPaused: boolean
  buttonText: string | null
  buttonLink: string | null
}
export const NO_EXTRAS: EmailExtras = { isPaused: false, buttonText: null, buttonLink: null }

export function extrasFromRow(row: Record<string, unknown> | null | undefined): EmailExtras {
  if (!row) return { ...NO_EXTRAS }
  return {
    isPaused: row.is_paused === true,
    buttonText: cleanText(row.button_text),
    buttonLink: cleanText(row.button_link),
  }
}

// One drip step's pause flag + button. Tolerant, as above.
export async function readStepExtras(stepId: string | null | undefined): Promise<EmailExtras> {
  if (!stepId) return { ...NO_EXTRAS }
  try {
    const { data, error } = await supabaseService.from('drip_path_steps').select('*').eq('id', stepId).maybeSingle()
    if (error || !data) return { ...NO_EXTRAS }
    return extrasFromRow(data as Record<string, unknown>)
  } catch {
    return { ...NO_EXTRAS }
  }
}

// A template's button (the welcome, the job follow-ups). Templates can't be
// paused, so isPaused is always false here.
export async function readTemplateExtras(templateId: string | null | undefined): Promise<EmailExtras> {
  if (!templateId) return { ...NO_EXTRAS }
  try {
    const { data, error } = await supabaseService.from('templates').select('*').eq('id', templateId).maybeSingle()
    if (error || !data) return { ...NO_EXTRAS }
    return { ...extrasFromRow(data as Record<string, unknown>), isPaused: false }
  } catch {
    return { ...NO_EXTRAS }
  }
}

