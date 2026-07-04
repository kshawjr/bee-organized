// components/hive/shared/useStoredControls.js — SSR-safe persisted
// control state (the bee_hive_beta_lens pattern, generalized): hydrate
// from localStorage after mount, write-through on change, never write
// defaults before hydration finishes. clear() resets AND removes the
// stored key. One hook per surface key (bee_hive_list_filters,
// bee_hive_board_sort, bee_hive_inbox_*, bee_hive_clients_*).
'use client'

import { useState, useEffect, useRef } from 'react'

export function useStoredState(key, defaults) {
  const [value, setValue] = useState(defaults)
  const hydrated = useRef(false)
  const defaultsRef = useRef(defaults)

  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || 'null')
      if (raw && typeof raw === 'object') setValue({ ...defaultsRef.current, ...raw })
    } catch {}
    hydrated.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (!hydrated.current) return
    try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
  }, [key, value])

  const clear = () => {
    setValue(defaultsRef.current)
    try { localStorage.removeItem(key) } catch {}
  }
  return [value, setValue, clear]
}
