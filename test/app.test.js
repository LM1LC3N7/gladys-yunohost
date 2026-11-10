// -----------------------------------------------------------------------------
// The app end to end: fake Gladys (SDK), fake YunoHost, virtual clock, the
// handlers of the container.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusalTag } from '../src/app.js';
import { FEATURES } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { CODES, YnhError } from '../src/ynh/errors.js';
import { DOMAIN, PASSWORD, TOKEN, USERNAME } from './fixtures/ynh.js';
import * as F from './fixtures/ynh.js';
import {
  BASE_CONFIG,
  HOUR,
  KEY,
  MINUTE,
  POLL,
  SECOND,
  T0,
  badge,
  fid,
  fixedRandom,
  sentTo,
  serverDevice,
  settle,
  setup,
  state,
} from './helpers/app.js';
import { FINGERPRINT, OTHER_FINGERPRINT, createFakeServer } from './helpers/fakeServer.js';

const status = (gladys) => gladys.fake.connectionStatus;
const pressKey = (gladys, key, value = 1, device = serverDevice()) => {
  const feature = device.features.find((f) => f.external_id === fid(key));
  assert.ok(feature, key);
  return gladys.fake.setValue(device, feature, value);
};
const actionsOf = (srv) => srv.actions.map((a) => a.kind);
/** A press whose answer waits on the clock: the steps run first, then 5 s pass. */
async function pressAndWait(ctx, key, device) {
  const pending = pressKey(ctx.gladys, key, 1, device);
  await settle();
  await ctx.wait(5 * SECOND);
  return pending;
}

/** Nothing secret nor personal left the integration (logs, Gladys, /data). */
function assertNoSecret({ gladys, logs, store }) {
  const out = JSON.stringify([
    logs,
    gladys.fake.requests,
    gladys.fake.connectionStatuses,
    store.data,
  ]);
  for (const secret of [PASSWORD, TOKEN, DOMAIN, `${USERNAME}:${PASSWORD}`]) {
    assert.ok(!out.includes(secret), `leaked: ${secret}`);
  }
}

test('first start: the certificate pinned in /data before the password is sent, then everything published', async () => {
  const store = memoryStore();
  const srv = createFakeServer();
  let pinnedBeforeLogin = null;
  srv.hook = (entry) => {
    if (entry.path === '/login') pinnedBeforeLogin ??= store.data?.pins?.[KEY] ?? null;
  };
  const ctx = await setup({ srv, store });
  const { gladys } = ctx;
  assert.equal(pinnedBeforeLogin, FINGERPRINT);
  assert.equal(sentTo(srv, '/login').length, 1);
  for (const path of ['/versions', '/update', '/services', '/diagnosis', '/backups']) {
    assert.equal(sentTo(srv, path).length, 1, path);
  }
  assert.equal(sentTo(srv, '/backups/20261108-020000').length, 1, 'the newest archive');
  assert.deepEqual(actionsOf(srv), [], 'nothing but reading');
  assert.ok(srv.sent.every((r) => r.method === 'GET' || r.path === '/login'));
  assert.equal(status(gladys).connected, true);
  assert.match(
    status(gladys).message.en,
    /^YunoHost 12\.1\.41\.2 answers: 4 upgrade\(s\) waiting, 1 service\(s\) down\.$/,
  );
  assert.equal(state(gladys, FEATURES.VERSION), '12.1.41.2');
  assert.equal(state(gladys, FEATURES.SYSTEM_UPDATES), 3);
  assert.equal(state(gladys, FEATURES.APP_UPDATES), 1, 'url_required is not counted');
  assert.equal(state(gladys, FEATURES.MAJOR_UPDATE), 0);
  assert.equal(state(gladys, FEATURES.MIGRATIONS), 0);
  assert.equal(state(gladys, FEATURES.UPDATES_CHECKED), 2);
  assert.equal(state(gladys, FEATURES.SERVICES_DOWN), 1, 'postfix failed; dnsmasq disabled');
  assert.equal(state(gladys, FEATURES.DIAGNOSIS_ERRORS), 1);
  assert.equal(state(gladys, FEATURES.DIAGNOSIS_WARNINGS), 2);
  assert.equal(state(gladys, FEATURES.BACKUPS), 2);
  assert.equal(state(gladys, FEATURES.LAST_BACKUP), 54, '2026-11-08 02:00 -> 2026-11-10 08:00');
  assert.equal(state(gladys, FEATURES.LAST_ACTION), undefined);
  assert.equal(state(gladys, 'service_nginx'), 1);
  assert.equal(state(gladys, 'service_postfix'), 0);
  assert.equal(state(gladys, 'service_php8_2e2-fpm'), 1);
  assert.equal(state(gladys, 'service_dnsmasq'), 0);
  assert.equal(state(gladys, 'service_yunohost-firewall'), undefined, 'unknown, never 0');
  assert.equal(badge(gladys).transport, 'local');
  const discovered = gladys.fake.discoveredDevices.at(-1);
  assert.equal(discovered.name, 'YunoHost server');
  assert.ok(discovered.features.some((f) => f.external_id === fid('service_redis-server')));
  assert.ok(
    !discovered.features.some((f) => f.external_id.includes(':restart_')),
    'no restart button unless listed',
  );
  // The login: JSON, `user:password`, exactly application/json.
  const login = sentTo(srv, '/login')[0];
  assert.equal(login.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(login.body), { credentials: `${USERNAME}:${PASSWORD}` });
  const read = sentTo(srv, '/versions')[0];
  assert.equal(read.headers.cookie, `yunohost.admin=${TOKEN}0`);
  assert.equal(read.headers['x-requested-with'], 'XMLHttpRequest');
  assertNoSecret({ ...ctx, store });
});

test('the actions are push buttons, never a switch; every other feature is read only', () => {
  const device = serverDevice({ restartable: ['redis-server', 'php8.2-fpm'] });
  const buttons = device.features.filter((f) => f.category === 'button');
  assert.deepEqual(
    buttons.map((f) => f.external_id.split(':').at(-1)),
    ['upgrade_system', 'upgrade_apps', 'backup', 'restart_redis-server', 'restart_php8_2e2-fpm'],
  );
  for (const f of device.features) {
    assert.notEqual(f.category, 'switch', f.name);
    if (f.category === 'button') {
      assert.equal(f.type, 'push');
      assert.equal(f.read_only, false);
    } else {
      assert.equal(f.read_only, true, f.name);
      assert.notEqual(f.type, 'binary-switch');
    }
  }
});

test('pace: one reading per interval, whatever asks; a restart of the container never reads sooner', async () => {
  const store = memoryStore();
  const srv = createFakeServer();
  const { gladys, wait, app } = await setup({ srv, store });
  assert.equal(sentTo(srv, '/versions').length, 1);
  await gladys.fake.configUpdated({ ...BASE_CONFIG });
  await gladys.fake.action('test_connection');
  await gladys.fake.scanRequest();
  await wait(POLL - MINUTE);
  assert.equal(sentTo(srv, '/versions').length, 1, 'nothing sooner than the interval');
  await wait(MINUTE + SECOND);
  assert.equal(sentTo(srv, '/versions').length, 2);
  await app.stop();
  // Restarted 2 minutes after the last attempt: the next one 13 minutes later.
  const again = await setup({ srv, store, now: T0 + POLL + 3 * MINUTE });
  assert.equal(sentTo(srv, '/versions').length, 2, 'no reading at start');
  await again.wait(11 * MINUTE);
  assert.equal(sentTo(srv, '/versions').length, 2);
  await again.wait(2 * MINUTE);
  assert.equal(sentTo(srv, '/versions').length, 3);
  await again.app.stop();
});

test('a refused login: kept in /data, never tried again by the loop, then a gate against fail2ban', async () => {
  const store = memoryStore();
  const srv = createFakeServer({ password: 'other' });
  const { gladys, wait, app } = await setup({ srv, store });
  assert.equal(srv.logins, 1);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /refused the user name or the password/);
  assert.match(status(gladys).message.en, /no other login for 5 min/);
  assert.equal(store.data.refused.tag, refusalTag(store.data.salt, PASSWORD));
  assert.equal(store.data.loginGate.count, 1);
  await wait(3 * HOUR);
  assert.equal(srv.logins, 1, 'never again by the loop');
  // The test button tries once more (the gate is over by now)...
  let ack = await gladys.fake.action('test_connection');
  assert.equal(ack.success, false);
  assert.equal(srv.logins, 2);
  assert.equal(store.data.loginGate.count, 2);
  // ...but not again before 10 min: nothing sent.
  await wait(5 * MINUTE);
  ack = await gladys.fake.action('test_connection');
  assert.equal(ack.success, false);
  assert.match(ack.error ?? JSON.stringify(ack), /no other login/);
  assert.equal(srv.logins, 2, 'the gate holds the test button');
  // A new password saved waits for the gate (and the interval), then is tried.
  srv.password = PASSWORD;
  await gladys.fake.configUpdated({ ...BASE_CONFIG });
  await settle();
  assert.equal(srv.logins, 2);
  assert.match(status(gladys).message.en, /no other login for 5 min/);
  await wait(10 * MINUTE - 2 * SECOND);
  assert.equal(srv.logins, 2, 'never sooner than the interval');
  await wait(3 * SECOND);
  assert.equal(srv.logins, 3);
  assert.equal(status(gladys).connected, true);
  assert.equal(store.data.refused, null);
  assert.equal(store.data.loginGate, null, 'a login that works lifts the gate');
  await app.stop();
});

test('a refused login stands across a restart (same password); the gate too', async () => {
  const store = memoryStore();
  const srv = createFakeServer({ password: 'other' });
  const first = await setup({ srv, store });
  await first.app.stop();
  const again = await setup({ srv, store, now: T0 + MINUTE });
  assert.equal(srv.logins, 1, 'not tried again at the restart');
  assert.match(status(again.gladys).message.en, /refused/);
  await again.wait(HOUR);
  assert.equal(srv.logins, 1);
  await again.app.stop();
});

test('the gate doubles per refusal in a row (5, 10, 20, 40 min), kept in /data', async () => {
  const store = memoryStore();
  const srv = createFakeServer({ password: 'other' });
  const { gladys, wait, clock, app } = await setup({ srv, store });
  const gateLeft = () => store.data.loginGate.until - clock.now;
  assert.equal(gateLeft(), 5 * MINUTE);
  // The test button tries once, after the interval and the gate.
  for (const [waitMs, count, gate] of [
    [POLL, 2, 10],
    [POLL, 3, 20],
    [20 * MINUTE, 4, 40],
  ]) {
    await wait(waitMs - 2 * SECOND);
    await gladys.fake.action('test_connection');
    assert.equal(srv.logins, count - 1, `not before ${waitMs / MINUTE} min`);
    await wait(2 * SECOND);
    await gladys.fake.action('test_connection');
    assert.equal(srv.logins, count);
    assert.equal(store.data.loginGate.count, count);
    assert.equal(gateLeft(), gate * MINUTE);
  }
  await app.stop();
});

test('a session expired: one new login in the reading, never a refusal', async () => {
  const srv = createFakeServer();
  const { gladys, wait, app } = await setup({ srv });
  srv.expireSessions();
  await wait(POLL);
  assert.equal(srv.logins, 2);
  assert.equal(status(gladys).connected, true);
  await app.stop();
});

test('a secondary part failing (401, 500, cut) is not read and spaced, never a refusal nor a pause', async () => {
  const store = memoryStore();
  const srv = createFakeServer();
  const { gladys, wait, app } = await setup({ srv, store });
  srv.override('/diagnosis', { status: 401, body: '' });
  srv.override('/update', { status: 500, body: '{"error":"x"}' });
  srv.override('/services', { status: 200, body: '{not json' });
  await wait(POLL);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.en, /Not read this time: updates, services, diagnosis\./);
  assert.equal(store.data.refused, null);
  assert.equal(store.data.pause, null);
  assert.equal(srv.logins, 1, 'a 401 there opens no session');
  // Spaced: asked again, then skipped 1, 3, 7... readings; the others read.
  await wait(POLL);
  assert.equal(sentTo(srv, '/diagnosis').length, 3);
  await wait(POLL);
  assert.equal(sentTo(srv, '/diagnosis').length, 3, 'skipped once');
  assert.equal(sentTo(srv, '/versions').length, 4);
  await wait(POLL);
  assert.equal(sentTo(srv, '/diagnosis').length, 4);
  await app.stop();
});

test('HTTP 503 on the main route: a pause of every request, kept in /data', async () => {
  const store = memoryStore();
  const srv = createFakeServer();
  const { gladys, wait, app } = await setup({ srv, store });
  srv.override('/versions', { status: 503, headers: { 'retry-after': '3600' }, body: '' }, 1);
  await wait(POLL);
  assert.match(status(gladys).message.en, /asked to wait \(HTTP 503\): no request for 60 min/);
  assert.equal(store.data.pause.status, 503);
  const count = srv.sent.length;
  await wait(59 * MINUTE);
  assert.equal(srv.sent.length, count, 'nothing during the pause');
  await wait(2 * MINUTE);
  assert.equal(status(gladys).connected, true);
  assert.equal(store.data.pause, null);
  await app.stop();
});

test('not a YunoHost (no versions envelope): unexpected answer, retried, never a refusal', async () => {
  const srv = createFakeServer();
  srv.override('/versions', { status: 200, body: { version: 'x' } });
  const { gladys, app } = await setup({ srv });
  assert.match(status(gladys).message.en, /cannot be read: unexpected answer\. Retried in 15 min/);
  await app.stop();
});

test('the web admin allowlist (403): said as such, retried, never a refusal of the password', async () => {
  const store = memoryStore();
  const srv = createFakeServer();
  srv.override('/login', { status: 403, body: '<html>403</html>' });
  const { gladys, app } = await setup({ srv, store });
  assert.match(status(gladys).message.en, /refuses the address of Gladys \(HTTP 403\)/);
  assert.equal(store.data.refused, null);
  assert.equal(store.data.loginGate, null);
  await app.stop();
});

test('another certificate: nothing sent, kept in /data; trusted by two clicks, or by a typed fingerprint', async () => {
  const store = memoryStore();
  const srv = createFakeServer();
  const { gladys, wait, app } = await setup({ srv, store });
  srv.fingerprint = OTHER_FINGERPRINT;
  const count = srv.sent.length;
  await wait(POLL);
  assert.equal(srv.sent.length, count, 'not a byte to the other certificate');
  assert.match(
    status(gladys).message.en,
    new RegExp(`another HTTPS certificate .*${OTHER_FINGERPRINT}`),
  );
  assert.equal(store.data.certChanged.seen, OTHER_FINGERPRINT);
  await wait(HOUR);
  assert.equal(srv.sent.length, count, 'never relearned blindly');
  // First click: the fingerprint shown; nothing trusted.
  let ack = await gladys.fake.action('trust_certificate');
  assert.equal(ack.success, true);
  assert.match(
    JSON.stringify(ack.data),
    new RegExp(`${OTHER_FINGERPRINT}.*again within 2 minutes`),
  );
  assert.equal(store.data.pins[KEY], FINGERPRINT);
  // A second click too late is a first click again.
  await wait(3 * MINUTE);
  ack = await gladys.fake.action('trust_certificate');
  assert.match(JSON.stringify(ack.data), /again within 2 minutes/);
  assert.equal(store.data.pins[KEY], FINGERPRINT);
  await wait(30 * SECOND);
  ack = await gladys.fake.action('trust_certificate');
  assert.match(JSON.stringify(ack.data), /trusted/);
  assert.equal(store.data.pins[KEY], OTHER_FINGERPRINT);
  assert.equal(store.data.certChanged, null);
  await wait(SECOND);
  assert.equal(status(gladys).connected, true, 'read again at once');
  assert.ok(srv.sent.length > count);
  // Nothing refused now: the button has nothing to trust.
  ack = await gladys.fake.action('trust_certificate');
  assert.match(JSON.stringify(ack.data), /nothing to trust/);
  await app.stop();
});

test('another certificate after a typed fingerprint: refused, the one met shown; the button defers to it', async () => {
  const srv = createFakeServer();
  const { gladys, app } = await setup({
    srv,
    config: { certificate_fingerprint: OTHER_FINGERPRINT.toLowerCase().replace(/:/g, '') },
  });
  assert.equal(srv.sent.length, 0);
  assert.match(
    status(gladys).message.en,
    new RegExp(`not the fingerprint you typed .*${FINGERPRINT}`),
  );
  const ack = await gladys.fake.action('trust_certificate');
  assert.equal(ack.success, false);
  await app.stop();
});

test('/data unreadable: no certificate learned, nothing sent; read again every 10 s', async () => {
  const store = memoryStore(null, { unreadable: true });
  const srv = createFakeServer();
  const { gladys, wait, app } = await setup({ srv, store });
  assert.equal(srv.sent.length, 0);
  assert.match(
    status(gladys).message.en,
    /cannot be read: the certificate of the server is not learned/,
  );
  store.unreadable = false;
  await wait(10 * SECOND);
  assert.equal(srv.sent.length, 0, 'the next reading at its time');
  await wait(POLL);
  assert.equal(store.data.pins[KEY], FINGERPRINT);
  assert.equal(status(gladys).connected, true);
  await app.stop();
});

test('/data unreadable at start but readable later: the pin kept there is never overwritten', async () => {
  const store = memoryStore({ salt: 'ab'.repeat(32), pins: { [KEY]: OTHER_FINGERPRINT } });
  store.unreadable = true;
  const srv = createFakeServer();
  const { wait, app } = await setup({ srv, store });
  store.unreadable = false;
  await wait(10 * SECOND);
  assert.equal(store.data.pins[KEY], OTHER_FINGERPRINT);
  assert.equal(srv.sent.length, 0, 'the server presents another certificate than the pin');
  await app.stop();
});

test('getConfig failing in `connected`: asked again without end, the status saying so, then reads', async () => {
  // The fake's connect() reads it once itself; then the app's reads fail twice.
  let fail = 3;
  let calls = 0;
  const srv = createFakeServer();
  let gladysRef;
  const ctx = await setup({
    srv,
    getConfig: async () => {
      calls += 1;
      if (calls > 1 && fail > 1) {
        fail -= 1;
        throw new Error('down');
      }
      return { ...BASE_CONFIG };
    },
  });
  gladysRef = ctx.gladys;
  assert.match(status(gladysRef).message.en, /did not give the configuration: asked again in 30 s/);
  await ctx.wait(30 * SECOND);
  assert.match(status(gladysRef).message.en, /asked again in 1 min/);
  assert.equal(srv.sent.length, 0);
  await ctx.wait(MINUTE);
  assert.equal(status(gladysRef).connected, true);
  await ctx.app.stop();
});

// --- The actions -------------------------------------------------------------

test('every action refused by default: nothing sent, the reason said', async () => {
  const srv = createFakeServer();
  const device = serverDevice({ restartable: ['redis-server'] });
  const { gladys, app } = await setup({ srv, created: [device] });
  const count = srv.sent.length;
  for (const [key, why] of [
    [FEATURES.UPGRADE_SYSTEM, /Upgrades are disabled/],
    [FEATURES.UPGRADE_APPS, /Upgrades are disabled/],
    [FEATURES.BACKUP, /Backups are disabled/],
    ['restart_redis-server', /Restarting redis-server is not allowed/],
  ]) {
    const ack = await pressKey(gladys, key, 1, device);
    assert.equal(ack.success, false, key);
    assert.match(ack.error, why);
  }
  // A reading feature never acts.
  const ack = await pressKey(gladys, FEATURES.SYSTEM_UPDATES, 1);
  assert.match(ack.error, /read only/);
  assert.equal(srv.sent.length, count);
  assert.deepEqual(actionsOf(srv), []);
  await app.stop();
});

test('a system upgrade allowed: fresh read, delay kept before the first byte, answered while it runs, outcome in Last action', async () => {
  const store = memoryStore();
  const srv = createFakeServer();
  let keptBeforeSend = null;
  srv.hook = (entry) => {
    if (entry.path === '/upgrade/system') keptBeforeSend = store.data.cooldowns?.at?.upgrade_system;
  };
  const ctx = await setup({ srv, store, config: { allow_upgrades: true } });
  const { gladys, wait, app, logs } = ctx;
  const reads = sentTo(srv, '/versions').length;
  const ack = await pressAndWait(ctx, FEATURES.UPGRADE_SYSTEM);
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.equal(sentTo(srv, '/versions').length, reads + 1, 'a fresh read first');
  assert.deepEqual(actionsOf(srv), ['upgrade_system']);
  const put = sentTo(srv, '/upgrade/system', 'PUT')[0];
  assert.equal(put.headers['x-requested-with'], 'XMLHttpRequest');
  assert.ok(keptBeforeSend > 0, 'the delay written to /data before the request');
  assert.equal(state(gladys, FEATURES.LAST_ACTION), 'System upgrade: running (sent from Gladys)');
  // While it runs: the readings go on, a second action is refused.
  const other = await pressKey(gladys, FEATURES.UPGRADE_APPS);
  assert.match(other.error, /already running \(system upgrade\)/);
  const disabled = await pressKey(gladys, FEATURES.BACKUP);
  assert.match(disabled.error, /Backups are disabled/, 'the option first, whatever runs');
  // It ends 20 min later: the outcome, then a reading soon.
  srv.updates = F.updates({ system: 0, apps: 1 });
  await wait(20 * MINUTE);
  srv.actions[0].finish();
  await settle();
  assert.equal(state(gladys, FEATURES.LAST_ACTION), 'System upgrade: finished (YunoHost answered)');
  const before = sentTo(srv, '/update').length;
  await wait(16 * SECOND);
  assert.equal(sentTo(srv, '/update').length, before + 1, 'read again after the action');
  assert.equal(state(gladys, FEATURES.SYSTEM_UPDATES), 0);
  assert.ok(logs.some((l) => l.includes('System upgrade requested from Gladys')));
  await app.stop();
});

test('the delay between two upgrades: kept in /data across a restart', async () => {
  const store = memoryStore();
  const srv = createFakeServer();
  srv.autoFinish = () => ({ status: 204, headers: {}, body: Buffer.from('') });
  const first = await setup({ srv, store, config: { allow_upgrades: true } });
  const ack = await pressKey(first.gladys, FEATURES.UPGRADE_APPS);
  assert.equal(ack.success, true, JSON.stringify(ack));
  await first.app.stop();
  const again = await setup({
    srv,
    store,
    now: T0 + 10 * MINUTE,
    config: { allow_upgrades: true },
  });
  const refused = await pressKey(again.gladys, FEATURES.UPGRADE_APPS);
  assert.match(
    refused.error,
    /Apps upgrade was sent a short while ago: nothing sent, try again in 20 min/,
  );
  assert.equal(srv.actions.length, 1);
  // Another action has its own delay.
  const system = await pressKey(again.gladys, FEATURES.UPGRADE_SYSTEM);
  assert.equal(system.success, true);
  await again.wait(21 * MINUTE);
  const later = await pressKey(again.gladys, FEATURES.UPGRADE_APPS);
  assert.equal(later.success, true, JSON.stringify(later));
  assert.equal(srv.actions.length, 3);
  await again.app.stop();
});

test('the delay cannot be kept (/data not writable): nothing sent', async () => {
  const store = memoryStore();
  const srv = createFakeServer();
  const { gladys, app } = await setup({ srv, store, config: { allow_backup: true } });
  store.failing = true;
  const ack = await pressKey(gladys, FEATURES.BACKUP);
  assert.match(ack.error, /cannot be kept in \/data: nothing sent/);
  assert.deepEqual(actionsOf(srv), []);
  await app.stop();
});

test('the option turned off during the fresh read: nothing sent, no delay written', async () => {
  const srv = createFakeServer();
  const store = memoryStore();
  const kept = [];
  const save = store.save.bind(store);
  store.save = (data) => {
    if (data.cooldowns) kept.push(data.cooldowns);
    return save(data);
  };
  const { gladys, app } = await setup({ srv, store, config: { allow_upgrades: true } });
  srv.hook = async (entry) => {
    if (entry.path === '/versions') {
      srv.hook = null;
      await gladys.fake.configUpdated({ ...BASE_CONFIG, allow_upgrades: false });
    }
  };
  const ack = await pressKey(gladys, FEATURES.UPGRADE_SYSTEM);
  assert.match(ack.error, /Upgrades are disabled/);
  assert.deepEqual(actionsOf(srv), []);
  assert.deepEqual(kept, [], 'refused before the delay was written');
  await app.stop();
});

test('the option re-checked right before the first byte (after the handshakes)', async () => {
  const srv = createFakeServer();
  const { gladys, app } = await setup({ srv, config: { allow_upgrades: true } });
  srv.connectHook = (target) => {
    if (target.path.endsWith('/upgrade/system')) app.config.allowUpgrades = false;
  };
  const ack = await pressKey(gladys, FEATURES.UPGRADE_SYSTEM);
  assert.match(ack.error, /Upgrades are disabled/);
  assert.deepEqual(actionsOf(srv), []);
  // Nothing happened: the delay is put back.
  srv.connectHook = null;
  srv.autoFinish = () => ({ status: 204, headers: {}, body: Buffer.from('') });
  app.config.allowUpgrades = true;
  const again = await pressKey(gladys, FEATURES.UPGRADE_SYSTEM);
  assert.equal(again.success, true, JSON.stringify(again));
  await app.stop();
});

test('a handshake that hangs past the deadline: cut, nothing sent, the delay put back', async () => {
  const srv = createFakeServer();
  const { gladys, wait, app, timers } = await setup({ srv, config: { allow_backup: true } });
  srv.connectHook = (target) =>
    target.path.endsWith('/backups') && target.method === 'POST'
      ? new Promise((resolve) => timers.setTimeout(resolve, 10 * SECOND))
      : undefined;
  let answered = false;
  const pending = pressKey(gladys, FEATURES.BACKUP).then((ack) => {
    answered = true;
    return ack;
  });
  await settle();
  await wait(5 * SECOND);
  assert.equal(answered, true, 'Gladys answered within its 5 s (the handshake cut)');
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /not sent/);
  await wait(6 * SECOND);
  assert.deepEqual(actionsOf(srv), []);
  srv.connectHook = null;
  srv.autoFinish = () => ({ status: 201, headers: {}, body: Buffer.from('{"name":"x"}') });
  const again = await pressKey(gladys, FEATURES.BACKUP);
  assert.equal(again.success, true, JSON.stringify(again));
  await app.stop();
});

test('YunoHost refusing an action at once (400): refused, the delay put back; 500 (lock): refused, the delay kept', async () => {
  const srv = createFakeServer();
  const { gladys, app } = await setup({ srv, config: { allow_upgrades: true } });
  srv.autoFinish = () => ({ status: 400, headers: {}, body: Buffer.from('{"error":"dpkg"}') });
  let ack = await pressKey(gladys, FEATURES.UPGRADE_SYSTEM);
  assert.match(ack.error, /YunoHost refused: system upgrade \(HTTP error 400\)/);
  assert.match(state(gladys, FEATURES.LAST_ACTION), /refused by YunoHost/);
  srv.autoFinish = () => ({ status: 500, headers: {}, body: Buffer.from('{"error":"lock"}') });
  ack = await pressKey(gladys, FEATURES.UPGRADE_SYSTEM);
  assert.match(ack.error, /HTTP error 500/);
  assert.match(state(gladys, FEATURES.LAST_ACTION), /failed or refused/);
  ack = await pressKey(gladys, FEATURES.UPGRADE_SYSTEM);
  assert.match(ack.error, /short while ago/, 'the delay stays after a 500');
  assert.equal(srv.actions.length, 2);
  assert.equal(status(gladys).connected, true, 'a 500 of an action never pauses the readings');
  await app.stop();
});

test('an upgrade cut after it left (API restarted): sent, no final answer, never a success', async () => {
  const srv = createFakeServer();
  const ctx = await setup({ srv, config: { allow_upgrades: true } });
  const { gladys, app } = ctx;
  assert.equal((await pressAndWait(ctx, FEATURES.UPGRADE_SYSTEM)).success, true);
  srv.actions[0].finish({ status: 502, headers: {}, body: Buffer.from('502 - Bad Gateway') });
  await settle();
  assert.match(state(gladys, FEATURES.LAST_ACTION), /sent, no final answer \(HTTP error 502\)/);
  await app.stop();
});

test('a backup: POST with a form body, the outcome; the archive name never shown', async () => {
  const srv = createFakeServer();
  srv.autoFinish = () => ({
    status: 201,
    headers: {},
    body: Buffer.from(JSON.stringify({ name: `${DOMAIN}-x`, size: 9 })),
  });
  const { gladys, wait, app, store, logs } = await setup({ srv, config: { allow_backup: true } });
  const ack = await pressKey(gladys, FEATURES.BACKUP);
  assert.equal(ack.success, true, JSON.stringify(ack));
  const post = sentTo(srv, '/backups', 'POST')[0];
  assert.equal(post.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(post.headers['x-requested-with'], 'XMLHttpRequest');
  assert.equal(state(gladys, FEATURES.LAST_ACTION), 'Backup: finished (YunoHost answered)');
  srv.backups = F.backups(['20261101-020000', '20261108-020000', '20261110-080000']);
  srv.backupInfo = F.backupInfo('2026-11-10T08:00:00+00:00');
  await wait(16 * SECOND);
  assert.equal(state(gladys, FEATURES.BACKUPS), 3);
  assert.equal(state(gladys, FEATURES.LAST_BACKUP), 0);
  assertNoSecret({ gladys, logs, store });
  await app.stop();
});

test('a restart: only a listed service, the service read first and again 5 s after', async () => {
  const srv = createFakeServer();
  srv.autoFinish = () => {
    srv.services['redis-server'] = F.service('running', 'enabled', '2026-11-10T08:00:02+00:00');
    return { status: 204, headers: {}, body: Buffer.from('') };
  };
  const device = serverDevice({ restartable: ['redis-server', 'ghost'] });
  const { gladys, wait, app } = await setup({
    srv,
    created: [device],
    config: { restart_services: 'redis-server, ghost' },
  });
  const discovered = gladys.fake.discoveredDevices.at(-1);
  assert.ok(discovered.features.some((f) => f.external_id === fid('restart_redis-server')));
  let ack = await pressKey(gladys, 'restart_redis-server', 1, device);
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.equal(sentTo(srv, '/services/redis-server').length, 1, 'read before');
  assert.equal(sentTo(srv, '/services/redis-server/restart', 'PUT').length, 1);
  await wait(5 * SECOND);
  assert.equal(sentTo(srv, '/services/redis-server').length, 2, 'read again after');
  assert.equal(
    state(gladys, FEATURES.LAST_ACTION),
    'Restart redis-server: done, the service is running',
  );
  // A service YunoHost does not know: nothing sent.
  ack = await pressKey(gladys, 'restart_ghost', 1, device);
  assert.match(ack.error, /does not know the service ghost: nothing sent/);
  assert.equal(srv.actions.length, 1);
  // A second restart within 2 min: refused.
  ack = await pressKey(gladys, 'restart_redis-server', 1, device);
  assert.match(ack.error, /short while ago/);
  await app.stop();
});

test('a restart that answers but the service did not restart: said so, never "done"', async () => {
  const srv = createFakeServer();
  srv.autoFinish = () => ({ status: 204, headers: {}, body: Buffer.from('') });
  const device = serverDevice({ restartable: ['redis-server'] });
  const { gladys, wait, app } = await setup({
    srv,
    created: [device],
    config: { restart_services: 'redis-server' },
  });
  await pressKey(gladys, 'restart_redis-server', 1, device);
  await wait(5 * SECOND);
  assert.equal(
    state(gladys, FEATURES.LAST_ACTION),
    'Restart redis-server: running, the restart is not seen yet',
  );
  await app.stop();
});

test('a restart without an answer within the 5 s of Gladys: "sent, without an answer", never a success', async () => {
  const srv = createFakeServer();
  const device = serverDevice({ restartable: ['redis-server'] });
  const ctx = await setup({
    srv,
    created: [device],
    config: { restart_services: 'redis-server' },
  });
  const { app } = ctx;
  const ack = await pressAndWait(ctx, 'restart_redis-server', device);
  assert.equal(ack.success, false);
  assert.match(ack.error, /sent, without an answer from YunoHost yet/);
  await app.stop();
});

test('a press with another value than 1, or on an unknown feature: refused, nothing sent', async () => {
  const srv = createFakeServer();
  const { gladys, app } = await setup({ srv, config: { allow_upgrades: true } });
  for (const value of [0, true, '', 2]) {
    const ack = await pressKey(gladys, FEATURES.UPGRADE_SYSTEM, value);
    assert.equal(ack.success, false, String(value));
  }
  const device = serverDevice();
  const ack = await gladys.fake.setValue(
    device,
    { ...device.features[0], external_id: 'ext:yunohost:server:main:restart_a_zz' },
    1,
  );
  assert.match(ack.error, /Unknown device/);
  assert.deepEqual(actionsOf(srv), []);
  await app.stop();
});

test('an action while a refusal or a changed certificate stands: nothing sent', async () => {
  const srv = createFakeServer({ password: 'other' });
  const { gladys, app } = await setup({ srv, config: { allow_upgrades: true } });
  const ack = await pressKey(gladys, FEATURES.UPGRADE_SYSTEM);
  assert.match(ack.error, /not configured or a stop stands/);
  assert.equal(srv.logins, 1);
  await app.stop();
});

test('an action while a pause stands: nothing sent', async () => {
  const srv = createFakeServer();
  const { gladys, wait, app } = await setup({ srv, config: { allow_upgrades: true } });
  srv.override('/versions', { status: 503, body: '' }, 1);
  await wait(POLL);
  const ack = await pressKey(gladys, FEATURES.UPGRADE_SYSTEM);
  assert.match(ack.error, /asked to wait/);
  assert.deepEqual(actionsOf(srv), []);
  await app.stop();
});

test('stop: the request of an action cut, no timer nor request after it', async () => {
  const srv = createFakeServer();
  const ctx = await setup({ srv, config: { allow_upgrades: true } });
  const { gladys, wait, app, pending } = ctx;
  await pressAndWait(ctx, FEATURES.UPGRADE_SYSTEM);
  const requests = gladys.fake.requests.length;
  const sent = srv.sent.length;
  await app.stop();
  await settle();
  assert.equal(pending.size, 0, 'no timer left');
  await wait(2 * HOUR);
  assert.equal(srv.sent.length, sent);
  assert.equal(gladys.fake.requests.length, requests, 'nothing published after the stop');
});

test('Last action survives a reconnection of Gladys and a device update', async () => {
  const srv = createFakeServer();
  srv.autoFinish = () => ({ status: 204, headers: {}, body: Buffer.from('') });
  const { gladys, app } = await setup({ srv, config: { allow_upgrades: true } });
  await pressKey(gladys, FEATURES.UPGRADE_APPS);
  await settle();
  const before = gladys.fake.states.filter(
    (s) => s.device_feature_external_id === fid(FEATURES.LAST_ACTION),
  ).length;
  await gladys.fake.deviceUpdated(serverDevice());
  const after = gladys.fake.states.filter(
    (s) => s.device_feature_external_id === fid(FEATURES.LAST_ACTION),
  ).length;
  assert.equal(after, before + 1);
  await app.stop();
});

test('services: at most 64 read, names with dots and @ in injective ids', async () => {
  const srv = createFakeServer();
  srv.services = Object.fromEntries(
    Array.from({ length: 80 }, (_, i) => [`svc${String(i).padStart(2, '0')}@a.b`, F.service()]),
  );
  srv.services['bad name'] = F.service();
  const { gladys, app } = await setup({ srv, created: [serverDevice({ services: [] })] });
  const discovered = gladys.fake.discoveredDevices.at(-1);
  const svc = discovered.features.filter((f) => f.external_id.includes(':service_'));
  assert.equal(svc.length, 64);
  assert.ok(svc.some((f) => f.external_id === fid('service_svc00_40a_2eb')));
  assert.ok(svc.every((f) => !/[.:@]/.test(f.external_id.split(':').at(-1))));
  await app.stop();
});

test('Discovery: every feature kept from the created device, never fewer', async () => {
  const srv = createFakeServer();
  const created = serverDevice({ services: ['old-service', 'nginx'] });
  const { gladys, app } = await setup({ srv, created: [created] });
  const discovered = gladys.fake.discoveredDevices.at(-1);
  for (const f of created.features) {
    assert.ok(
      discovered.features.some((d) => d.external_id === f.external_id),
      f.external_id,
    );
  }
  await app.stop();
});

test('the login never leaves while the gate stands, even from the fresh read of an action', async () => {
  const store = memoryStore({
    salt: 'ab'.repeat(32),
    pins: { [KEY]: FINGERPRINT },
    loginGate: { key: KEY, until: T0 + 30 * MINUTE, count: 3 },
  });
  const srv = createFakeServer();
  const { gladys, wait, app } = await setup({ srv, store, config: { allow_upgrades: true } });
  assert.equal(srv.logins, 0);
  assert.match(status(gladys).message.en, /no other login for 30 min/);
  const ack = await pressKey(gladys, FEATURES.UPGRADE_SYSTEM);
  assert.equal(ack.success, false);
  assert.equal(srv.logins, 0);
  assert.equal(srv.connections, 0, 'not even a connection opened');
  await wait(30 * MINUTE + SECOND);
  assert.equal(srv.logins, 1);
  assert.equal(status(gladys).connected, true);
  await app.stop();
});

test('a wall clock set back: the pause capped at 6 h, a delay "in the future" counts as now', async () => {
  const store = memoryStore({
    salt: 'ab'.repeat(32),
    pins: { [KEY]: FINGERPRINT },
    pause: { key: KEY, until: T0 + 400 * 24 * HOUR, status: 503 },
    cooldowns: { key: KEY, at: { upgrade_system: T0 + 24 * HOUR } },
  });
  const srv = createFakeServer();
  srv.autoFinish = () => ({ status: 204, headers: {}, body: Buffer.from('') });
  const { gladys, wait, app } = await setup({ srv, store, config: { allow_upgrades: true } });
  assert.equal(srv.sent.length, 0);
  await wait(6 * HOUR - MINUTE);
  assert.equal(srv.sent.length, 0);
  await wait(2 * MINUTE);
  assert.equal(status(gladys).connected, true, 'the pause capped at 6 h');
  const ack = await pressKey(gladys, FEATURES.UPGRADE_SYSTEM);
  assert.equal(ack.success, true, 'the delay, taken as "now" 6 h ago, is over');
  await app.stop();
});

test('the same salt is kept; the refusal marker is 8 bits, never the password', () => {
  const salt = fixedRandom(32).toString('hex');
  const tag = refusalTag(salt, PASSWORD);
  assert.match(tag, /^[0-9a-f]{2}$/);
  // 256 passwords share a marker at most: brute force learns nothing useful.
  const seen = new Set();
  for (let i = 0; i < 4096; i += 1) seen.add(refusalTag(salt, `p${i}`));
  assert.equal(seen.size, 256);
});

test('the errors of the client never hold the address nor a secret', () => {
  const err = new YnhError(CODES.UNREACHABLE, 'ECONNREFUSED');
  assert.doesNotMatch(err.message, /192\.168/);
});

test('the deadline re-checked right before the first byte: a handshake past 3.5 s sends nothing', async () => {
  const srv = createFakeServer();
  const { gladys, wait, app, timers } = await setup({ srv, config: { allow_upgrades: true } });
  srv.connectHook = (target) =>
    target.path.endsWith('/upgrade/system')
      ? new Promise((resolve) => timers.setTimeout(resolve, 4 * SECOND))
      : undefined;
  const pending = pressKey(gladys, FEATURES.UPGRADE_SYSTEM);
  await settle();
  await wait(5 * SECOND);
  const ack = await pending;
  assert.match(ack.error, /did not answer in time: nothing sent/);
  assert.deepEqual(actionsOf(srv), []);
  await app.stop();
});

test('/data not writable at the first contact: no pin, nothing sent', async () => {
  const store = memoryStore(null, { failing: true });
  const srv = createFakeServer();
  const { gladys, app } = await setup({ srv, store });
  assert.equal(srv.sent.length, 0);
  assert.match(status(gladys).message.en, /cannot be kept \(\/data cannot be written\)/);
  await app.stop();
});

test('/data unreadable: an action is refused (its delay could not be kept), the readings go on', async () => {
  const store = memoryStore(null, { unreadable: true });
  const srv = createFakeServer();
  const { gladys, app } = await setup({
    srv,
    store,
    config: { allow_upgrades: true, certificate_fingerprint: FINGERPRINT },
  });
  assert.equal(status(gladys).connected, true, 'a typed fingerprint needs no /data');
  const ack = await pressKey(gladys, FEATURES.UPGRADE_SYSTEM);
  assert.match(ack.error, /storage \/data cannot be read/);
  assert.deepEqual(actionsOf(srv), []);
  await app.stop();
});

test('a login gate set while the connection opens: not a byte of the login sent', async () => {
  const srv = createFakeServer();
  const { gladys, wait, app } = await setup({ srv, connect: false });
  srv.connectHook = (target) => {
    if (target.path.endsWith('/login')) app.gateDue = app.monotonic() + 5 * MINUTE;
  };
  await gladys.connect();
  await wait(0);
  assert.equal(srv.connections, 1);
  assert.equal(srv.logins, 0);
  assert.equal(sentTo(srv, '/login').length, 0);
  await app.stop();
});

test('another certificate met on a secondary route stops everything (never swallowed)', async () => {
  const store = memoryStore();
  const srv = createFakeServer();
  const { gladys, wait, app } = await setup({ srv, store });
  srv.hook = (entry) => {
    if (entry.path === '/update') srv.fingerprint = OTHER_FINGERPRINT;
  };
  await wait(POLL);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /another HTTPS certificate/);
  assert.equal(store.data.certChanged.seen, OTHER_FINGERPRINT);
  await app.stop();
});

test('a reading that starts while a refusal stands (a timer armed before it) sends nothing', async () => {
  const srv = createFakeServer({ password: 'other' });
  const { app, wait } = await setup({ srv });
  assert.equal(srv.logins, 1);
  await wait(HOUR);
  // What a timer armed before the refusal would run: the loop's own reading.
  await app.tick();
  assert.equal(srv.logins, 1, 'only the test button tries a refused login');
  await app.stop();
});
