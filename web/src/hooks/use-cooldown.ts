import { useEffect, useState } from "react"

export function useCooldown() {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (seconds <= 0) return
    const timer = setTimeout(() => setSeconds((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [seconds])

  return {
    seconds,
    running: seconds > 0,
    start: (value: number) => setSeconds(Math.max(0, Math.ceil(value)))
  }
}
