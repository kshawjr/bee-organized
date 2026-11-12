// lib/slack-channel-name.ts
// A job's Slack channel name. Pure — no server imports — so the create
// dialog previews exactly the name the server will ask Slack for.
//
// ── The channel name ─────────────────────────────────────────
// Slack: lowercase letters, digits, hyphens, underscores; no spaces or full
// stops; at most 80 characters; unique in the workspace.
//
// THE RULE: <client>-<project type>, each part lowercased, accents dropped,
// "&" read as "and", every other run of disallowed characters collapsed to
// one hyphen, no hyphen at either end. NO PREFIX — Kevin named two parts.
//   "Sarah McAllister" + "Pantry"         → sarah-mcallister-pantry
//   "O'Brien & Sons"   + "Garage / Shed"  → o-brien-and-sons-garage-shed
//   no project type                       → sarah-mcallister
//   nothing usable at all                 → job
// Too long: the project type keeps up to 30 characters and the client name
// is cut to fit, so the type (the part that tells two jobs for the same
// client apart) survives. Room is always left for a "-NN" retry suffix.
export const SLACK_CHANNEL_MAX = 80
const SUFFIX_ROOM = 3 // "-99"
const TYPE_MAX = 30

export function slugForSlack(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
}

const trimEnd = (s: string, n: number) => s.slice(0, n).replace(/[-_]+$/g, '')

export function slackJobChannelName(clientName: unknown, projectType: unknown, suffix = ''): string {
  const budget = SLACK_CHANNEL_MAX - SUFFIX_ROOM
  let client = slugForSlack(clientName)
  let type = trimEnd(slugForSlack(projectType), TYPE_MAX)
  if (client && type) {
    const roomForClient = budget - type.length - 1
    client = trimEnd(client, Math.max(roomForClient, 1))
  } else {
    client = trimEnd(client, budget)
    type = trimEnd(type, budget)
  }
  const base = [client, type].filter(Boolean).join('-') || 'job'
  return trimEnd(base, budget) + suffix
}

export const isValidSlackChannelName = (name: string) =>
  name.length >= 1 && name.length <= SLACK_CHANNEL_MAX && /^[a-z0-9][a-z0-9_-]*$/.test(name)

