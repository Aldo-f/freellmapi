import { useState, useEffect, type Dispatch, type SetStateAction } from 'react'

export function usePersistedState<T>(
  key: string,
  defaultValue: T
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      if (stored !== null) {
        return JSON.parse(stored) as T
      }
    } catch {
      // JSON parse error, quota exceeded, private browsing, etc.
    }
    return defaultValue
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state))
    } catch {
      // Quota exceeded, private browsing — silently ignore
    }
  }, [key, state])

  return [state, setState]
}