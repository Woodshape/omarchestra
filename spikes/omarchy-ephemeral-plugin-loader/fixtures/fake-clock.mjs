// SPIKE — fake-only fixture. Not production code.
//
// fake-clock.mjs — the injected asynchronous driver. The host must schedule
// deferred work (filesystem validation, teardown confirmation, tombstone
// expiry) through this port instead of real timers, so tests stay
// deterministic and never sleep.
//
// Frozen port surface for task 3.a:
//   now()                 -> current fake milliseconds
//   schedule(fn, delayMs) -> id
//   cancel(id)
//   advance(ms)           -> runs every callback whose deadline is reached,
//                            including callbacks scheduled by callbacks
//   pendingCount()        -> number of unresolved scheduled callbacks

export function createClockPort({ nowMs = 1_000_000 } = {}) {
  let now = nowMs
  let sequence = 0
  const timers = []

  const clock = {
    now() { return now },
    schedule(fn, delayMs = 0) {
      sequence += 1
      timers.push({ id: sequence, at: now + (delayMs || 0), fn })
      return sequence
    },
    cancel(id) {
      const index = timers.findIndex((timer) => timer.id === id)
      if (index >= 0) timers.splice(index, 1)
    },
    advance(ms) {
      const target = now + ms
      let fired = 0
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= target)
          .sort((a, b) => a.at - b.at)[0]
        if (!due) break
        const index = timers.indexOf(due)
        if (index >= 0) timers.splice(index, 1)
        now = Math.max(now, due.at)
        due.fn()
        fired += 1
      }
      now = target
      return fired
    },
    pendingCount() { return timers.length },
  }

  return clock
}