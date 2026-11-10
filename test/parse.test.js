// -----------------------------------------------------------------------------
// The answers of YunoHost, strictly: an unexpected shape is unknown, never 0;
// lists bounded; own keys only; the session cookie read from Set-Cookie.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookieOf } from '../src/ynh/client.js';
import { CODES } from '../src/ynh/errors.js';
import {
  parseBackupInfo,
  parseBackups,
  parseDiagnosis,
  parseServices,
  parseUpdates,
  parseVersions,
} from '../src/ynh/parse.js';
import * as F from './fixtures/ynh.js';

test('versions: the envelope of YunoHost, else not a YunoHost', () => {
  assert.deepEqual(parseVersions(F.versions()), { version: '12.1.41.2' });
  assert.deepEqual(parseVersions(F.versions('<b>x</b>')), { version: null });
  for (const bad of [null, [], {}, { yunohost: 'x' }, { yunohost: { version: 12 } }]) {
    assert.throws(
      () => parseVersions(bad),
      (e) => e.code === CODES.BAD_ANSWER,
    );
  }
  assert.throws(() => parseVersions(JSON.parse('{"__proto__":{"yunohost":{"version":"1"}}}')));
});

test('updates: counts of what is listed; the "no date" of YunoHost is unknown', () => {
  assert.deepEqual(parseUpdates(F.updates()), {
    systemUpdates: 3,
    appUpdates: 1,
    major: false,
    migrations: 0,
    checkedSeconds: 7200,
  });
  const none = parseUpdates({ ...F.updates(), last_apt_update: 99999 * 3600 });
  assert.equal(none.checkedSeconds, null);
  const odd = parseUpdates({ system: [], apps: 'x', important_yunohost_upgrade: 'yes' });
  assert.equal(odd.systemUpdates, null, 'a list where an object was expected');
  assert.equal(odd.appUpdates, null);
  assert.equal(odd.major, null);
  assert.equal(odd.migrations, null);
  assert.equal(parseUpdates({ apps: [{ id: 'a' }] }).appUpdates, null, 'a status missing');
  assert.equal(parseUpdates({ system: { a: Array(6000).fill({}) } }).systemUpdates, null);
  assert.throws(() => parseUpdates(null));
});

test('services: running, down only when enabled; oneshot unknown; bounded', () => {
  const { services, down } = parseServices(F.services());
  assert.equal(down, 1);
  assert.equal(services.get('nginx').running, 1);
  assert.equal(services.get('postfix').running, 0);
  assert.equal(services.get('dnsmasq').enabled, false);
  assert.equal(services.get('yunohost-firewall').running, null);
  assert.equal(services.get('yunohost-firewall').changed, null);
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`s${i}`, F.service()]));
  assert.equal(parseServices(many).services.size, 64);
  assert.equal(parseServices({ 'a b': F.service(), '../x': F.service() }).services.size, 0);
  assert.throws(() => parseServices([]));
});

test('diagnosis: errors and warnings counted; never ran: unknown', () => {
  assert.deepEqual(parseDiagnosis(F.diagnosis()), { errors: 1, warnings: 2 });
  assert.deepEqual(parseDiagnosis(null), { errors: null, warnings: null });
  assert.throws(() => parseDiagnosis({ reports: [{ items: 'x' }] }));
  assert.throws(() => parseDiagnosis({}));
});

test('backups: the newest archive, its date (UTC when no zone)', () => {
  assert.deepEqual(parseBackups(F.backups()), { count: 2, newest: '20261108-020000' });
  assert.deepEqual(parseBackups(F.backups([])), { count: 0, newest: null });
  assert.equal(parseBackups(F.backups(['../etc'])).newest, null);
  assert.equal(parseBackupInfo(F.backupInfo()), Date.parse('2026-11-08T02:00:00Z'));
  assert.equal(
    parseBackupInfo(F.backupInfo('2026-11-08 02:00:00')),
    Date.parse('2026-11-08T02:00:00Z'),
  );
  assert.equal(parseBackupInfo(F.backupInfo('yesterday')), null);
  assert.equal(parseBackupInfo({ created_at: 1731031200 }), null);
});

test('the session cookie: yunohost.admin only, a JWT shape, never a header injection', () => {
  assert.equal(
    cookieOf({ 'set-cookie': [`other=1`, `yunohost.admin=${F.TOKEN}; Path=/yunohost/api`] }),
    F.TOKEN,
  );
  assert.equal(cookieOf({ 'set-cookie': `yunohost.admin="${F.TOKEN}"; Secure` }), F.TOKEN);
  assert.equal(cookieOf({ 'set-cookie': ['yunohost.admin=a b c; Path=/'] }), null);
  assert.equal(cookieOf({ 'set-cookie': ['yunohost.admin=short'] }), null);
  assert.equal(cookieOf({ 'set-cookie': [`yunohost.admin=${F.TOKEN}\r\nX: 1`] }), null);
  assert.equal(cookieOf({}), null);
});
