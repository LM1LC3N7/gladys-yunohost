// -----------------------------------------------------------------------------
// The configuration: the address (HTTPS only) and its port, the user name, the
// fingerprint, the services list, the defaults (mirror of the manifest).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig,
  parseFingerprint,
  parseHost,
  parseServices,
  targetKey,
} from '../src/config.js';

test('the address: HTTPS only, ports, IPv6, URLs pasted from the browser', () => {
  assert.deepEqual(parseHost('192.168.1.20'), { host: '192.168.1.20', port: 443 });
  assert.deepEqual(parseHost('https://Box.Example.org/yunohost/admin/#/'), {
    error: 'invalid',
  });
  assert.deepEqual(parseHost('https://Box.Example.org/yunohost/admin/'), {
    host: 'box.example.org',
    port: 443,
  });
  assert.deepEqual(parseHost('192.168.1.20:8443'), { host: '192.168.1.20', port: 8443 });
  assert.deepEqual(parseHost('[fd00::20]:444'), { host: 'fd00::20', port: 444 });
  assert.equal(parseHost('http://192.168.1.20').error, 'http', 'never plain HTTP');
  for (const bad of [
    'ftp://192.168.1.20',
    'https://user:pw@192.168.1.20',
    'https://192.168.1.20/?a=1',
    '192.168.1.300',
    '0.0.0.0',
    '255.255.255.255',
    '239.1.2.3',
    '::',
    'ff02::1',
    'a b',
    '192.168.1.20:0',
    'box.example/yunohost',
  ]) {
    assert.equal(parseHost(bad).error, 'invalid', bad);
  }
  assert.equal(parseHost('').error, 'missing');
});

test('the fingerprint as typed', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(parseFingerprint(hex), 'AB:'.repeat(31) + 'AB');
  assert.equal(parseFingerprint(`SHA-256: ${hex.match(/../g).join(' ')}`), 'AB:'.repeat(31) + 'AB');
  assert.equal(parseFingerprint(''), '');
  assert.equal(parseFingerprint('abcd'), null);
});

test('the services Gladys may restart: names, unique, 16 at most, nothing else', () => {
  assert.deepEqual(parseServices(' redis-server, php8.2-fpm\nredis-server ;nginx '), {
    names: ['redis-server', 'php8.2-fpm', 'nginx'],
    invalid: false,
  });
  assert.deepEqual(parseServices(''), { names: [], invalid: false });
  assert.equal(parseServices('nginx; rm -rf /').invalid, true);
  assert.equal(parseServices('../x').invalid, true);
  assert.equal(parseServices('a:b').invalid, true);
  assert.equal(
    parseServices(Array.from({ length: 17 }, (_, i) => `s${i}`).join(',')).invalid,
    true,
  );
});

test('normalized: defaults, password kept as typed, user name strict, flags strict', () => {
  const c = normalizeConfig({
    host: '10.0.0.2',
    username: ' camille ',
    password: ' p ',
    allow_upgrades: 'yes',
  });
  assert.equal(c.username, 'camille');
  assert.equal(c.usernameInvalid, false);
  assert.equal(c.password, ' p ');
  assert.equal(c.allowUpgrades, false);
  assert.equal(c.allowBackup, false);
  assert.deepEqual(c.restartable, []);
  assert.equal(c.pollMs, 15 * 60_000);
  assert.equal(targetKey(c), 'https://10.0.0.2:443');
  assert.equal(normalizeConfig({ allow_upgrades: true }).allowUpgrades, true);
  assert.equal(normalizeConfig({ allow_backup: 'true' }).allowBackup, true);
  assert.equal(normalizeConfig({ poll_interval: '7' }).pollMs, 15 * 60_000);
  assert.equal(normalizeConfig({ poll_interval: '60' }).pollMs, 60 * 60_000);
  assert.equal(normalizeConfig({ password: 'a\u0007' }).passwordInvalid, true);
  assert.equal(normalizeConfig({ username: 'cam:ille' }).usernameInvalid, true, 'never a colon');
  assert.equal(normalizeConfig({ username: 'Admin' }).usernameInvalid, true);
  assert.equal(normalizeConfig({ username: '' }).username, '', 'no default user');
  assert.equal(normalizeConfig(null).hostError, 'missing');
});
