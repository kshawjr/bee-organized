export type TouchType = 'email' | 'sms' | 'call_prompt' | 'link' | 'wait'

export interface PathStep {
  id: string
  day: number
  type: TouchType
  label: string
  description?: string
}

export interface DripPath {
  id: string
  name: string
  description: string
  icon: string
  firstTouch: TouchType
  steps: PathStep[]
  isDefault?: boolean
  isCustom?: boolean
}

export const DEFAULT_PATHS: DripPath[] = [
  {
    id: 'email-nurture',
    name: 'Email Nurture',
    description: 'Start with a warm welcome email, follow up with value content over 2 weeks.',
    icon: '📧',
    firstTouch: 'email',
    steps: [
      { id: 's1', day: 0,  type: 'email',        label: 'Welcome Email',         description: 'Warm intro + what to expect' },
      { id: 's2', day: 2,  type: 'email',        label: 'How We Help',           description: 'Services overview + testimonial' },
      { id: 's3', day: 6,  type: 'email',        label: 'Real Results',          description: 'Before/after client story' },
      { id: 's4', day: 13, type: 'email',        label: 'Ready to Get Started?', description: 'Booking CTA' },
    ],
  },
  {
    id: 'quick-connect',
    name: 'Quick Connect',
    description: 'Text first for fastest response, then call, then follow up by email.',
    icon: '⚡',
    firstTouch: 'sms',
    steps: [
      { id: 's1', day: 0,  type: 'sms',          label: 'Welcome Text',          description: 'Hi + quick intro text' },
      { id: 's2', day: 1,  type: 'call_prompt',  label: 'Call Reminder',         description: 'Notify owner to call' },
      { id: 's3', day: 3,  type: 'email',        label: 'Follow-up Email',       description: 'In case they missed the text' },
      { id: 's4', day: 10, type: 'email',        label: 'Last Touch',            description: 'Final check-in' },
    ],
  },
  {
    id: 'direct-book',
    name: 'Direct Book',
    description: 'Send a scheduling link immediately so they can book on their own time.',
    icon: '📅',
    firstTouch: 'link',
    steps: [
      { id: 's1', day: 0,  type: 'link',         label: 'Scheduling Link',       description: 'Book your assessment' },
      { id: 's2', day: 2,  type: 'email',        label: 'Link Reminder',         description: 'Did you get a chance to book?' },
      { id: 's3', day: 5,  type: 'email',        label: 'Value Email',           description: 'Why now is a great time' },
      { id: 's4', day: 12, type: 'sms',          label: 'Final Text',            description: 'Last check-in via text' },
    ],
  },
  {
    id: 'personal-touch',
    name: 'Personal Touch',
    description: 'Owner calls first before any automation. Best for high-value referrals.',
    icon: '🤝',
    firstTouch: 'call_prompt',
    steps: [
      { id: 's1', day: 0,  type: 'call_prompt',  label: 'Call Prompt',           description: 'Notify owner to call within 24hr' },
      { id: 's2', day: 3,  type: 'email',        label: 'Follow-up Email',       description: 'If no contact made yet' },
      { id: 's3', day: 7,  type: 'email',        label: 'Value Email',           description: 'Client story + services' },
      { id: 's4', day: 14, type: 'email',        label: 'Ready to Book?',        description: 'Final CTA' },
    ],
  },
  {
    id: 'manual',
    name: 'Manual Only',
    description: 'No automation. Owner manages all communication manually.',
    icon: '✋',
    firstTouch: 'call_prompt',
    steps: [
      { id: 's1', day: 0, type: 'call_prompt', label: 'New Lead Alert', description: 'Notify owner — no automation will run' },
    ],
  },
]

export const TOUCH_CONFIG: Record<TouchType, { label: string; icon: string; color: string; bg: string }> = {
  email:       { label: 'Email',        icon: '📧', color: '#6366f1', bg: 'rgba(99,102,241,0.1)'  },
  sms:         { label: 'Text (SMS)',   icon: '💬', color: '#10b981', bg: 'rgba(16,185,129,0.1)'  },
  call_prompt: { label: 'Call Prompt', icon: '📞', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)'  },
  link:        { label: 'Booking Link',icon: '🔗', color: '#0ea5e9', bg: 'rgba(14,165,233,0.1)'  },
  wait:        { label: 'Wait',         icon: '⏳', color: '#8a9e9a', bg: 'rgba(138,158,154,0.1)' },
}