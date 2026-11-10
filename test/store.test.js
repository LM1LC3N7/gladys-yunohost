// -----------------------------------------------------------------------------
// /data: a missing file is a first start; anything else unreadable is not;
// a FIFO never holds a read nor a write; the state read back is bounded.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, normalizeMemory } from '../src/store.js';

const random = (n) => Buffer.alloc(n, 1);

async function dir(t) {
  const d = await mkdtemp(join(tmpdir(), 'ynh-store-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

test('missing: null; saved: read back, 0600', async (t) => {
  const d = await dir(t);
  const store = fileStore(join(d, 'state.json'));
  assert.equal(await store.load(), null);
  await store.save({ salt: 'x' });
  assert.deepEqual(await store.load(), { salt: 'x' });
  assert.equal((await stat(join(d, 'state.json'))).mode & 0o777, 0o600);
});

test('not JSON, too large, not an object: unreadable (never a first start)', async (t) => {
  const d = await dir(t);
  const path = join(d, 'state.json');
  const store = fileStore(path);
  await writeFile(path, '{');
  await assert.rejects(store.load(), { code: 'EINVAL' });
  await writeFile(path, ' '.repeat(20_000));
  await assert.rejects(store.load(), { code: 'EFBIG' });
  await writeFile(path, '[]');
  await assert.rejects(store.load(), { code: 'EINVAL' });
});

test('a FIFO in place of the file or of its temporary: refused at once, never waited for', async (t) => {
  const d = await dir(t);
  const path = join(d, 'state.json');
  execFileSync('mkfifo', [path]);
  const store = fileStore(path);
  const started = performance.now();
  await assert.rejects(store.load(), { code: 'EINVAL', message: /regular file/ });
  assert.ok(performance.now() - started < 1000);
  await rm(path);
  execFileSync('mkfifo', [`${path}.tmp`]);
  await store.save({ salt: 'y' });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).salt, 'y');
});

test('normalized: unknown keys dropped, times capped, no prototype pollution', () => {
  const now = Date.parse('2026-11-10T08:00:00Z');
  const m = normalizeMemory(
    JSON.parse(
      '{"__proto__":{"x":1},"salt":"zz","pins":{"a":"bad"},"pause":{"key":"k","until":9e15,"status":503},"loginGate":{"key":"k","until":9e15,"count":3},"cooldowns":{"key":"k","at":{"upgrade_system":9e15,"restart:nginx":1,"__proto__":5,"bad key":1,"restart:../x":1}},"lastAttemptAt":9e15,"refused":{"key":"k","user":"u","tag":"zzz"}}',
    ),
    now,
    random,
  );
  assert.equal(m.salt, '01'.repeat(32));
  assert.deepEqual({ ...m.pins }, {});
  assert.equal(m.pause.until, now + 6 * 3600_000);
  assert.equal(m.loginGate.until, now + 6 * 3600_000);
  assert.equal(m.loginGate.count, 3);
  assert.deepEqual({ ...m.cooldowns.at }, { upgrade_system: now, 'restart:nginx': 1 });
  assert.equal(m.lastAttemptAt, now);
  assert.equal(m.refused, null);
  assert.equal({}.x, undefined);
  assert.equal(
    normalizeMemory({ loginGate: { key: 'k', until: 1, count: 0 } }, now).loginGate,
    null,
  );
});
