// lib/drip-step-order.ts
//
// Renumber a sequence's steps 1..n, keeping their order. PURE — used by
// PATCH /api/drip-paths/:id/steps on every save (2026-09-27): a sequence
// saved as a single "step 3" made enrolment find no first step, and every
// lead at that location silently never started nurture emails.
//
// `moves` is [oldNumber, newNumber] for each step whose number changed, in
// ascending order, so the route can move in-flight leads with their step.
// When the payload repeats a number the mapping is ambiguous (two steps were
// both "2"), so no moves are reported for it — those leads are left as they
// are, exactly as before this existed.

export function renumberSteps<T extends { step_order: number }>(steps: T[]): {
  steps: T[]
  moves: [number, number][]
} {
  const ordered = steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.step_order - b.s.step_order || a.i - b.i)
  const counts = new Map<number, number>()
  for (const { s } of ordered) counts.set(s.step_order, (counts.get(s.step_order) ?? 0) + 1)

  const moves: [number, number][] = []
  const out = ordered.map(({ s }, idx) => {
    const n = idx + 1
    if (s.step_order !== n && counts.get(s.step_order) === 1) moves.push([s.step_order, n])
    return { ...s, step_order: n }
  })
  moves.sort((a, b) => a[0] - b[0])
  return { steps: out, moves }
}
