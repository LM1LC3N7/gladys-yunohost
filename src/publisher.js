// -----------------------------------------------------------------------------
// What goes to Gladys, within its limit of 300 states per minute: a sliding
// one-minute window of what was sent (on the monotonic clock), and the
// publication of a list of states through publishChangedStates (unchanged
// values skipped by the SDK, sent again every 30 min). A round that exceeds
// what is left of the minute is cut, the cut rotating so that no feature is
// held back for ever. Never throws: a refusal of Gladys is not a failure of
// the server.
// -----------------------------------------------------------------------------

import { INTERVALS, LIMITS } from './constants.js';

const WINDOW_MS = 60_000;

export class Budget {
  /** @param {{ perMinute: number, monotonic: () => number }} options */
  constructor({ perMinute, monotonic }) {
    this.perMinute = perMinute;
    this.monotonic = monotonic;
    this.entries = []; // [at, count]
  }

  #prune(mono) {
    const since = mono - WINDOW_MS;
    while (this.entries.length > 0 && this.entries[0][0] <= since) this.entries.shift();
  }

  used(mono = this.monotonic()) {
    this.#prune(mono);
    return this.entries.reduce((sum, [, count]) => sum + count, 0);
  }

  remaining(mono = this.monotonic()) {
    return Math.max(0, this.perMinute - this.used(mono));
  }

  record(count, mono = this.monotonic()) {
    if (count > 0) this.entries.push([mono, count]);
  }
}

export class StatePublisher {
  constructor({ gladys, logger, monotonic }) {
    this.gladys = gladys;
    this.logger = logger;
    this.budget = new Budget({ perMinute: LIMITS.STATES_PER_MINUTE, monotonic });
    this.cursor = 0;
  }

  /** Publish what changed among `list`, within the per-minute budget. Never throws. */
  async publish(list) {
    if (list.length === 0) return;
    const remaining = this.budget.remaining();
    if (list.length > remaining) {
      this.logger.debug(`${list.length - remaining} state(s) held back (state budget)`);
      const start = this.cursor % list.length;
      list = [...list.slice(start), ...list.slice(0, start)].slice(0, remaining);
      this.cursor = start + remaining;
    }
    if (list.length === 0) return;
    try {
      const result = await this.gladys.publishChangedStates(list, {
        heartbeat: INTERVALS.HEARTBEAT_MS,
      });
      this.budget.record(result?.count ?? list.length);
    } catch (err) {
      this.logger.warn(`States not published: ${err.message}`);
    }
  }
}
