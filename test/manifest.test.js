// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. The published
// device follows the rules of the core (units, supported_options).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS } from '../src/config.js';
import { ACTIONS, POLL_INTERVALS } from '../src/constants.js';
import { buildServerDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');
const dockerignore = read('.dockerignore');

// The core's own validator of supported_options, when a Gladys clone is at hand
// (not on GitHub CI): the rules below are its schema, this is the proof.
const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));

test('the store basics; the version set by hand everywhere, never frozen here', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.keywords, undefined, 'keywords need gladys_version >= 5.3.0 (TODO.md)');
  assert.equal(manifest.countries, undefined);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-yunohost:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-yunohost');
  assert.equal(lock.name, 'gladys-yunohost');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['servers']);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien/);
  assert.match(read('docs/en.md'), /never been tested with a real YunoHost server/i);
  assert.match(read('docs/fr.md'), /jamais été testée avec un vrai serveur YunoHost/i);
});

test('the license and the notices ship in the image; no person named in LICENSE; scripts stay out', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'the standard text');
  assert.match(read('THIRD_PARTY_NOTICES.md'), /YunoHost[\s\S]*AGPL[\s\S]*Nothing of their code/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
  assert.doesNotMatch(dockerfile, /COPY (scripts|test)/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code; every action off by default; the secret without default', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'host',
    'username',
    'password',
    'certificate_fingerprint',
    'poll_interval',
    'actions_section',
    'allow_upgrades',
    'allow_backup',
    'restart_services',
  ]);
  assert.deepEqual(
    fields.poll_interval.options.map((o) => o.value),
    POLL_INTERVALS,
  );
  for (const option of fields.poll_interval.options) {
    assert.equal(typeof option.label.en, 'string');
  }
  for (const key of ['allow_upgrades', 'allow_backup']) {
    assert.equal(fields[key].type, 'boolean', key);
    assert.equal(fields[key].default, false, key);
  }
  assert.equal(fields.restart_services.default, '', 'no service restartable by default');
  assert.equal(fields.username.default, undefined, 'no administrator guessed');
  assert.equal(fields.username.required, true);
  assert.equal(fields.password.type, 'secret');
  assert.equal(fields.password.default, undefined, 'never a default on a secret');
  assert.ok(
    manifest.config_schema.filter((f) => f.type === 'secret').every((f) => !('default' in f)),
  );
  assert.ok(
    !manifest.config_schema.some((f) => f.key.startsWith('gladys_')),
    'GLADYS_* is the core',
  );
  assert.doesNotMatch(JSON.stringify(manifest), /chiffré|encrypted/i);
  assert.match(fields.actions_section.description.en, /never a switch/);
});

test('sections store nothing', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    assert.ok(!(section.key in DEFAULTS), section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
  assert.match(dockerignore, /^node_modules$/m);
});

const device = () =>
  buildServerDevice(createFakeGladys({ selector: 'yunohost' }), {
    services: ['nginx', 'php8.2-fpm', 'yunohost-api', 'slapd'],
    restartable: ['nginx', 'redis-server'],
  });

test('units: only those the core lists for the category (server/utils/constants.js)', () => {
  // DEVICE_FEATURE_UNITS_BY_CATEGORY of the core, for the categories used here.
  const allowed = {
    duration: [
      'microseconds',
      'milliseconds',
      'seconds',
      'minutes',
      'hours',
      'days',
      'weeks',
      'months',
      'years',
    ],
  };
  for (const feature of device().features) {
    if (feature.unit === undefined) {
      assert.ok(
        ['unknown', 'text', 'button'].includes(feature.category),
        `${feature.name}: no unit`,
      );
      continue;
    }
    assert.ok(Object.values(DEVICE_FEATURE_UNITS).includes(feature.unit));
    assert.ok(
      allowed[feature.category]?.includes(feature.unit),
      `${feature.name}: ${feature.unit}`,
    );
  }
});

test('supported_options of every published feature follow the rules of the core (none here)', () => {
  const features = device().features;
  assert.equal(features.length, 12 + 4 + 3 + 2);
  const ids = new Set();
  for (const feature of features) {
    assert.ok(!ids.has(feature.external_id), `unique: ${feature.external_id}`);
    ids.add(feature.external_id);
    assert.ok(typeof feature.name === 'string' && feature.name.trim() === feature.name);
    if (feature.supported_options === undefined) continue;
    const options = feature.supported_options;
    assert.ok(Array.isArray(options) && options.length > 0, feature.name);
    const values = new Set();
    for (const option of options) {
      assert.deepEqual(Object.keys(option).sort(), ['label', 'value'], feature.name);
      assert.equal(typeof option.label, 'string');
      assert.ok(option.label.length > 0 && option.label.trim() === option.label, option.label);
      assert.ok(
        Number.isInteger(option.value) || typeof option.value === 'string',
        `${feature.name}: ${option.value}`,
      );
      assert.ok(!values.has(option.value), 'unique values');
      values.add(option.value);
    }
    if (normalizeSupportedOptions) {
      assert.doesNotThrow(() => normalizeSupportedOptions(options, { allowStringValues: true }));
    }
  }
  assert.ok(
    features.every((f) => f.supported_options === undefined),
    'no select feature',
  );
});
