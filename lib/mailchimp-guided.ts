// lib/mailchimp-guided.ts
//
// MAILCHIMP GUIDED SET-UP (FL-75, 2026-11-26): the rules behind the one guided
// path that replaces the never-sent-yet page of separate cards. Built to
// Kevin's approved Lovable design ("Bee Organized Control Hive",
// src/components/settings/MailchimpConnection.tsx, MailchimpPeopleStep.tsx and
// mailchimp-guided-model.ts). Pure: no database, no Mailchimp, no network.
//
// WHY (Kevin, 2026-11-26): an owner could work through everything and only be
// refused at the very end, because a Mailchimp welcome email was still on.
// So the flow check comes FIRST, on the overview — and the overview still
// says the real check happens again at the end. It is not a guarantee.
//
// THE NUMBER RULE, everywhere: nobody who will not actually be sent, or
// brought in, is in a headline number. Held, refused, skipped and unticked
// people go in one quiet line.
//
// IT DECIDES NOTHING ON ITS OWN. Every number comes from a server answer, and
// the server checks every rule again right before it brings anyone in or
// sends anyone over.

import { reviewTally, matchedByPhone, type ReviewModel } from './mailchimp-review'

// The design's four steps after the overview (step 0, not numbered).
export const STEP_NAMES = ['Your Mailchimp', 'Into Bee Hub', 'Over to Mailchimp', 'Your decision'] as const
export const STEP_COUNT = STEP_NAMES.length

export type Place = { v: 1; step: number; done: number[] }
export const START: Place = { v: 1, step: 0, done: [] }

// Where the place is kept: this device, one per location (no migration — the
// ticks themselves are saved on the server, so only the step is kept here).
export const placeKey = (locationId: unknown) => `bee-hub-mailchimp-setup-v1:${String(locationId || '')}`

const isStep = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= STEP_COUNT

// A saved place is never trusted: anything odd starts at the overview, and a
// step can only be reached when every step before it was finished.
export function readPlace(raw: string | null | undefined): Place {
  if (!raw) return START
  try {
    const p = JSON.parse(raw)
    if (!p || p.v !== 1 || !Number.isInteger(p.step) || p.step < 0 || p.step > STEP_COUNT) return START
    if (!Array.isArray(p.done) || !p.done.every(isStep)) return START
    const done = Array.from(new Set<number>(p.done)).sort((a, b) => a - b)
    for (let s = 1; s < p.step; s++) if (!done.includes(s)) return START
    return { v: 1, step: p.step, done }
  } catch { return START }
}

export function nextPlace(p: Place): Place {
  if (p.step >= STEP_COUNT) return p
  const done = p.step > 0 ? Array.from(new Set([...p.done, p.step])).sort((a, b) => a - b) : p.done
  return { v: 1, step: p.step + 1, done }
}
export function backPlace(p: Place): Place {
  return { ...p, step: Math.max(0, p.step - 1) }
}
// The round step buttons: only the step you are on, or one already finished.
export function canGoTo(p: Place, step: number): boolean {
  return isStep(step) && (step === p.step || p.done.includes(step))
}
export function goTo(p: Place, step: number): Place {
  return canGoTo(p, step) ? { ...p, step } : p
}

// The flow check, from GET /api/mailchimp/overview. No answer, or an answer
// Mailchimp could not give, is "couldn't check" — never "clear".
export type EmailCheck =
  | { kind: 'clear'; conditional: Array<{ name: string; tag: string }> }
  | { kind: 'live'; flows: string[] }
  | { kind: 'unreadable' }
export function emailCheck(ov: any): EmailCheck {
  const f = ov && ov.flows
  if (!f || f.ok !== true || !Array.isArray(f.mustPause)) return { kind: 'unreadable' }
  if (f.mustPause.length > 0) return { kind: 'live', flows: f.mustPause.map((x: any) => String(x?.name || 'A Mailchimp email')) }
  return { kind: 'clear', conditional: Array.isArray(f.conditional) ? f.conditional : [] }
}

// Coming in, from GET /api/mailchimp/import's model (slice 7). The headline is
// the people ticked who will be created, plus the "same person?" people the
// owner answered "Different people" (c 'in'); everyone else Mailchimp holds
// that isn't already in Bee Hub — unticked, unanswered, answered "same",
// skipped — is left out. The group's tick never reaches a held person.
export type ImportModelLike = {
  create: Array<{ k: string; c?: 'in' | 'out' }>
  group?: 'in' | 'out' | null
  held: Array<{ k: string; c?: 'in' | 'out' }>
  skipped: { total: number }
}
export function tickedToBringIn(model: ImportModelLike): string[] {
  return [
    ...model.create.filter((p) => (p.c ? p.c === 'in' : model.group !== 'out')).map((p) => p.k),
    ...model.held.filter((p) => p.c === 'in').map((p) => p.k),
  ]
}
export function incomingNumbers(model: ImportModelLike): { bringing: number; leftOut: number } {
  const bringing = tickedToBringIn(model).length
  return { bringing, leftOut: (model.create.length + model.held.length - bringing) + Number(model.skipped?.total || 0) }
}

// Going out, from GET /api/mailchimp/review's model (with who is held back
// marked). Left out = not ticked, held back, or can't be added at all.
export function outgoingNumbers(model: ReviewModel): { sending: number; leftOut: number } {
  const t = reviewTally(model.people, model.groups, matchedByPhone(model.phone), model)
  return { sending: t.adding, leftOut: t.archivedUnticked + t.otherUnticked + t.heldBack + Number(model.notOffered?.total || 0) }
}

const n = (x: unknown) => Number(x || 0).toLocaleString('en-US')
export const peopleWords = (x: unknown) => `${n(x)} ${Number(x) === 1 ? 'person' : 'people'}`

// The overview's one quiet line, or null when nobody is left out.
export function leftOutLine(incoming: number | null, outgoing: number | null): string | null {
  const parts: string[] = []
  if (incoming) parts.push(`${n(incoming)} coming in`)
  if (outgoing) parts.push(`${n(outgoing)} going out`)
  if (!parts.length) return null
  return `Another ${parts.join(' and ')} can’t be added or are left out. You’ll see who and why as you go.`
}

// The last step's button says what it does.
// finishing: the set-up can be finished here (the first send has asked and
// is waiting for a yes), so with nobody to bring in or send the button still
// has a job — saving that the set-up is finished (2026-11-27).
export const FINISH_AT_ZERO = 'Finish set-up'
export function finishLabel(bringing: number, sending: number, finishing = false): string | null {
  if (bringing > 0 && sending > 0) return 'Bring them in & send them over'
  if (bringing > 0) return 'Bring them in'
  if (sending > 0) return 'Send them over'
  return finishing ? FINISH_AT_ZERO : null
}

// What actually happened, from the two server answers. `inn` = POST
// /api/mailchimp/import's answer (or { error }), `out` = POST
// /api/mailchimp/sync's answer (or { error }). null = that side wasn't asked.
export type Line = { tone: 'big' | 'quiet' | 'amber'; text: string }
export function finishLines(inn: any, out: any, listName: string, flowsWords?: (flows: string[]) => string): { incoming: Line[]; outgoing: Line[]; allWell: boolean } {
  const list = (listName || '').trim() || 'your Mailchimp list'
  const incoming: Line[] = []
  const outgoing: Line[] = []
  let allWell = true
  if (inn) {
    if (inn.error) { incoming.push({ tone: 'amber', text: inn.words || 'Nobody was brought in. Bee Hub couldn’t finish. Please try again in a few minutes.' }); allWell = false }
    else {
      incoming.push({ tone: 'big', text: `${peopleWords(inn.created)} brought into Bee Hub` })
      incoming.push({ tone: 'quiet', text: 'They’re in your clients list as Nurturing. No one was emailed.' })
      if (inn.createdUnsubscribed > 0) incoming.push({ tone: 'quiet', text: `${peopleWords(inn.createdUnsubscribed)} came in marked “No marketing emails”, because they unsubscribed in Mailchimp.` })
      if (inn.taggedPeople > 0 || inn.notedPeople > 0 || (inn.quizPeople || 0) > 0) incoming.push({ tone: 'quiet', text: tagWords(inn.taggedPeople, inn.notedPeople, inn.quizPeople || 0) })
      if (inn.tagsFailed > 0) { incoming.push({ tone: 'amber', text: `${peopleWords(inn.tagsFailed)} came in, but their Mailchimp tags couldn’t all be added. You can add them on their page.` }); allWell = false }
      if (inn.alreadyThere > 0) incoming.push({ tone: 'quiet', text: `${peopleWords(inn.alreadyThere)} had been added to Bee Hub in the meantime, so they weren’t added twice.` })
      if (Array.isArray(inn.failed) && inn.failed.length) { incoming.push({ tone: 'amber', text: `${peopleWords(inn.failed.length)} couldn’t be brought in: ${inn.failed.map((f: any) => f.e).join(', ')}. Nothing was made for them.` }); allWell = false }
    }
  }
  if (out) {
    if (out.error || !('ran' in out)) { outgoing.push({ tone: 'amber', text: 'Nobody was sent over. Bee Hub couldn’t start. Please try again in a few minutes.' }); allWell = false }
    else if (!out.ran) {
      allWell = false
      if (out.reason === 'signup_flows_live') {
        const names = (out.must_pause || []).map((f: any) => f?.name).filter(Boolean)
        outgoing.push({ tone: 'amber', text: flowsWords ? flowsWords(names) : `Nobody was sent over. A Mailchimp welcome email was switched back on${names.length ? `: ${names.join(', ')}` : ''}. Pause it, then come back to the last step.` })
      } else if (out.reason === 'needs_confirmation') {
        outgoing.push({ tone: 'amber', text: 'Nobody was sent over. Something changed since you looked, so the number changed. Come back to the last step to see it again.' })
      } else if (out.reason === 'mailchimp_unreadable') {
        outgoing.push({ tone: 'amber', text: 'Nobody was sent over. Bee Hub couldn’t read your Mailchimp just now, so it couldn’t check. Please try again in a few minutes.' })
      } else {
        outgoing.push({ tone: 'amber', text: out.words || 'Nobody was sent over.' })
      }
    } else if (out.complete === false && String(out.stopped || '').startsWith('record_not_saved') && !(out.pushed > 0)) {
      // Nobody needed sending, but the set-up's finish couldn't be saved.
      outgoing.push({ tone: 'amber', text: 'Nobody needed sending, but Bee Hub couldn’t save that your set-up is finished. Please come back to the last step and press Finish set-up again.' }); allWell = false
    } else if (!(out.pushed > 0) && !(out.failed > 0) && !(out.remaining > 0) && out.complete !== false) {
      outgoing.push({ tone: 'big', text: `Nobody needed sending over to ${list}` })
      outgoing.push({ tone: 'quiet', text: 'Everyone who can go is already there. No email was sent from Bee Hub.' })
      if (out.already > 0) outgoing.push({ tone: 'quiet', text: `${peopleWords(out.already)} turned out to be in your Mailchimp already.` })
    } else {
      outgoing.push({ tone: 'big', text: `${peopleWords(out.pushed)} sent over to ${list}` })
      outgoing.push({ tone: 'quiet', text: 'No email was sent from Bee Hub.' })
      if (out.already > 0) outgoing.push({ tone: 'quiet', text: `${peopleWords(out.already)} turned out to be in your Mailchimp already.` })
      if (out.held_back > 0) outgoing.push({ tone: 'quiet', text: `${peopleWords(out.held_back)} Mailchimp turned down before ${out.held_back === 1 ? 'wasn’t' : 'weren’t'} sent.` })
      if (Array.isArray(out.tags_held) && out.tags_held.length) outgoing.push({ tone: 'quiet', text: `Left off, because they start an email in Mailchimp: ${out.tags_held.join(', ')}.` })
      if (out.failed > 0) { outgoing.push({ tone: 'amber', text: `Mailchimp turned down ${peopleWords(out.failed)}. You’ll see who on your Mailchimp page.` }); allWell = false }
      if (out.remaining > 0 || out.complete === false) { outgoing.push({ tone: 'amber', text: `Bee Hub stopped partway${out.remaining > 0 ? `, with ${peopleWords(out.remaining)} still to go` : ''}. The rest go over the next time you send.` }); allWell = false }
    }
  }
  return { incoming, outgoing, allWell }
}

// The finish's one tag line, in plain words.
export function tagWords(tagged: number, noted: number, quiz = 0): string {
  const parts: string[] = []
  if (tagged > 0) parts.push(`${peopleWords(tagged)} got the Bee Hub tags that match their Mailchimp tags`)
  if (noted > 0) parts.push(`${peopleWords(noted)} had Mailchimp tags Bee Hub doesn’t have, so those are kept in a note on them`)
  if (quiz > 0) parts.push(`${peopleWords(quiz)} joined your mailing list by taking the quiz on your website, and a note on them says so`)
  return parts.join('. ') + '.'
}

// The direction picture's two numbers and which way is lit. Only people who
// will actually move: the same numbers as the headlines, never the quiet line.
//   active 'in'  — step 2 (Mailchimp → Bee Hub lit)
//   active 'out' — step 3 (Bee Hub → Mailchimp lit)
//   active 'both' — the overview, step 1, the last step and the finish
// null = not known yet (the arrow shows no number rather than a guess).
export type Flow = { active: 'in' | 'out' | 'both'; incoming: number | null; outgoing: number | null }
export function flowActive(step: number): Flow['active'] {
  return step === 2 ? 'in' : step === 3 ? 'out' : 'both'
}
export function flowFinish(inn: any, out: any): { incoming: number; outgoing: number } {
  return {
    incoming: inn && !inn.error ? Number(inn.created || 0) : 0,
    outgoing: out && !out.error && out.ran ? Number(out.pushed || 0) : 0,
  }
}

// The finish only counts as the end of the set-up when the sending side really
// ran to the end (the first send is then recorded by the server).
export function sendFinished(out: any): boolean {
  return !!out && out.ran === true && out.complete !== false && !(out.remaining > 0)
}
