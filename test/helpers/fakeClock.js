// -----------------------------------------------------------------------------
// Fake timers on a virtual clock: nothing fires by itself; `advance(ms)` moves
// the clock and runs every timer due on the way, in order, awaiting each.
// -----------------------------------------------------------------------------

export function createFakeClock(start) {
  const clock = { now: start };
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  async function advance(ms) {
    const target = clock.now + ms;
    // A storm of timers (a loop rescheduling at once) fails the test, never hangs it.
    for (let i = 0; ; i += 1) {
      if (i >= 2_000) throw new Error('Timer storm: more than 2000 timers in one advance');
      let next;
      for (const [id, timer] of pending) {
        if (timer.at <= target && (!next || timer.at < next.timer.at)) {
          next = { id, timer };
        }
      }
      if (!next) {
        break;
      }
      pending.delete(next.id);
      clock.now = Math.max(clock.now, next.timer.at);
      await next.timer.fn();
    }
    // Never back: a slow answer may have moved the clock beyond the target.
    clock.now = Math.max(clock.now, target);
  }
  return { clock, timers, pending, advance };
}
