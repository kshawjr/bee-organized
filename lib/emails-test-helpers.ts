// lib/emails-test-helpers.ts
//
// The Emails list folds (2026-10-30 design): only the first group starts
// open, and each shows three emails until "More" is pressed. Tests that need
// every row on screen open them the way an owner would — by clicking.

export async function expandAllEmailGroups(container: HTMLElement, act: (fn: () => Promise<void>) => Promise<void>) {
  for (let pass = 0; pass < 4; pass++) {
    const closed = Array.from(container.querySelectorAll('button[aria-expanded="false"]')) as HTMLButtonElement[]
    const more = (Array.from(container.querySelectorAll('button')) as HTMLButtonElement[])
      .filter(b => (b.textContent ?? '').startsWith('More —'))
    if (!closed.length && !more.length) return
    await act(async () => { for (const b of [...closed, ...more]) b.click() })
  }
}

// The Emails screen's dropdowns are the design's (ESelect, 2026-10-30
// follow-up): a button with role="combobox" that opens a listbox. Tests pick
// an option the way an owner does — open it, click the option.
export const comboboxes = (el: Element) =>
  Array.from(el.querySelectorAll('[role="combobox"]')) as HTMLButtonElement[]
export const comboValue = (b: Element) => b.getAttribute('data-value') ?? ''

export async function pickOption(trigger: HTMLElement, value: string, act: (fn: () => Promise<void>) => Promise<void>) {
  await act(async () => { trigger.click() })
  const box = trigger.closest('[data-eselect]') as HTMLElement
  const opt = Array.from(box.querySelectorAll('[role="option"]')).find(o => o.getAttribute('data-value') === value) as HTMLElement | undefined
  if (!opt) throw new Error(`no option "${value}" in ${trigger.getAttribute('aria-label')}`)
  await act(async () => { opt.click() })
  await act(async () => {})
}

// The labels a dropdown offers, read by opening and closing it.
export async function optionLabels(trigger: HTMLElement, act: (fn: () => Promise<void>) => Promise<void>) {
  await act(async () => { trigger.click() })
  const box = trigger.closest('[data-eselect]') as HTMLElement
  const out = Array.from(box.querySelectorAll('[role="option"]')).map(o => ({ value: o.getAttribute('data-value') ?? '', label: o.textContent ?? '', selected: o.getAttribute('aria-selected') === 'true' }))
  await act(async () => { trigger.click() })
  return out
}
