// components/hive/shared/assessmentTime.js
// ─────────────────────────────────────────────────────────────
// The assessment day + time pickers' shared pieces — lifted out of
// SendToJobberModal unchanged so Book assessment (BookAssessment.jsx) offers
// the same 15-minute slots and turns a pick into the same ISO string. The
// server (lib/jobber-assessment-create) then converts that instant into the
// location's wall-clock time, for both doors.
// ─────────────────────────────────────────────────────────────

// 15-min increments 7am–7pm.
export const ASSESSMENT_TIME_OPTIONS = (() => {
  const times = []
  for (let h = 7; h <= 19; h++) {
    for (let m = 0; m < 60; m += 15) {
      const ampm = h < 12 ? 'AM' : 'PM'
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
      times.push(`${h12}:${m.toString().padStart(2, '0')} ${ampm}`)
    }
  }
  return times
})()

export const DEFAULT_ASSESSMENT_TIME = '10:00 AM'

// Combine YYYY-MM-DD `date` + "h:mm AM/PM" `time` into an ISO string,
// interpreted in the browser's local timezone (the route converts to the
// location's zone). UNCHANGED from the legacy popup.
export function buildAssessmentIso(date, time) {
  if (!date) return null
  const [hm, ampm] = (time || DEFAULT_ASSESSMENT_TIME).split(' ')
  const [hh, mm] = hm.split(':').map(Number)
  let h24 = hh % 12
  if (ampm === 'PM') h24 += 12
  const d = new Date(`${date}T00:00:00`)
  d.setHours(h24, mm, 0, 0)
  return d.toISOString()
}
