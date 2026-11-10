// -----------------------------------------------------------------------------
// The state budget: 250 states in any 60 s window, a cut round rotating so that
// no feature is held back for ever, what the SDK really sent counted.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatePublisher } from '../src/publisher.js';

const quiet = { debug() {}, warn() {} };
const states = (n) =>
  Array.from({ length: n }, (_, i) => ({ device_feature_external_id: `f${i}`, state: i }));

function harness({ sent = (list) => list.length } = {}) {
  let now = 0;
  const calls = [];
  const gladys = {
    async publishChangedStates(list) {
      calls.push(list.map((s) => s.device_feature_external_id));
      return { count: sent(list) };
    },
  };
  const publisher = new StatePublisher({ gladys, logger: quiet, monotonic: () => now });
  return { publisher, calls, at: (ms) => (now = ms) };
}

test('at most 250 states in 60 s: a round above what is left is cut', async () => {
  const { publisher, calls, at } = harness();
  await publisher.publish(states(200));
  at(10_000);
  await publisher.publish(states(200));
  assert.equal(calls[0].length, 200);
  assert.equal(calls[1].length, 50, 'what is left of the minute');
  at(20_000);
  await publisher.publish(states(10));
  assert.equal(calls.length, 2, 'nothing left: nothing sent');
});

test('the window slides: 60 s after a round, its states are free again', async () => {
  const { publisher, calls, at } = harness();
  await publisher.publish(states(250));
  at(59_999);
  await publisher.publish(states(5));
  assert.equal(calls.length, 1);
  at(60_000);
  await publisher.publish(states(5));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 5);
});

test('the cut rotates: every feature is sent in turn', async () => {
  const { publisher, calls, at } = harness();
  await publisher.publish(states(240));
  const seen = new Set();
  for (let minute = 1; minute <= 30; minute += 1) {
    at(minute * 60_000 + 1);
    await publisher.publish(states(240));
    at(minute * 60_000 + 2);
    await publisher.publish(states(300));
    for (const id of calls.at(-1)) seen.add(id);
  }
  assert.equal(seen.size, 300, 'none held back for ever');
});

test('what the SDK really sent is what counts (unchanged values skipped)', async () => {
  const { publisher, calls, at } = harness({ sent: () => 0 });
  await publisher.publish(states(250));
  at(1000);
  await publisher.publish(states(250));
  assert.equal(calls[1].length, 250, 'nothing was sent: the budget is whole');
});
