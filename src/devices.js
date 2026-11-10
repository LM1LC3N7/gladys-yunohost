// -----------------------------------------------------------------------------
// The Gladys device of the server (pure): `ext:<selector>:server:main`.
//
// Every value is read only. The actions (system upgrade, apps upgrade,
// backup, restart of a service) are `button`/`push` features, never a switch
// nor a binary: a "turn everything off" of a voice assistant, MCP or a
// `switch` scene action must not reach them; each is refused unless allowed
// in the configuration. A restart button exists only for the services listed
// in the configuration.
//
// The service features (`service_<id>`) follow the services the server lists:
// before the first reading, the device has the features of the server only.
// `<id>` is the service name with every character other than a-z, 0-9 and `-`
// written `_<hex>` (`php8.2-fpm` -> `php8_2e2-fpm`): one id per name, never a
// `.` nor a `:` in an id.
//
// A device published again never loses a feature: the core would mark it
// `structure_changed`, and "Update" would drop the history of the missing
// one. The features of the device created in Gladys (`gladys.devices`, kept
// up to date by the SDK) are added back when the blueprint lacks them.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { SERVICE_NAME } from './config.js';
import {
  FEATURES as F,
  LIMITS,
  RESTART_PREFIX,
  SERVER_ID,
  SERVER_TYPE,
  SERVICE_PREFIX,
} from './constants.js';

export const serverIds = (gladys) => gladys.externalIds(SERVER_TYPE, SERVER_ID);

/** The id of a service name in a feature key (injective, see above). */
export const serviceId = (name) =>
  [...name]
    .map((ch) => (/[a-z0-9-]/.test(ch) ? ch : `_${ch.charCodeAt(0).toString(16).padStart(2, '0')}`))
    .join('');

/** The service name of an id, or null when it is not one this code makes. */
export function serviceNameOf(id) {
  if (typeof id !== 'string' || id.length > 3 * 64) return null;
  if (!/^([a-z0-9-]|_[0-9a-f]{2})+$/.test(id)) return null;
  const name = id.replace(/_([0-9a-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return SERVICE_NAME.test(name) && serviceId(name) === id ? name : null;
}

const reading = (extra) => ({ read_only: true, has_feedback: false, keep_history: true, ...extra });
const textual = () =>
  reading({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
// No "count" category in the core: a plain number, the unit in the name.
const plain = (max = LIMITS.COUNT) =>
  reading({ category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN, min: 0, max });
const binary = () => reading({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const hours = () =>
  reading({
    category: C.DURATION,
    type: T.DURATION.DECIMAL,
    unit: U.HOURS,
    min: 0,
    max: 1_000_000,
    keep_history: false,
  });
const button = (name, externalId) => ({
  name,
  external_id: externalId,
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
});

/** A number published only when finite, never NaN. */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const flagOf = (v) => (v === true ? 1 : v === false ? 0 : null);
const hoursOf = (seconds) => (num(seconds) === null ? null : Math.round(seconds / 360) / 10);
const cut = (v) => (typeof v === 'string' && v ? v.slice(0, LIMITS.TEXT_LENGTH) : null);

/** The features of the server: [key, name, definition, value of a reading]. Units of the core only. */
export const SERVER_FEATURES = [
  [F.VERSION, 'YunoHost version', textual(), (s) => cut(s.version)],
  [F.SYSTEM_UPDATES, 'System packages to upgrade', plain(), (s) => num(s.updates?.systemUpdates)],
  [F.APP_UPDATES, 'Apps to upgrade', plain(), (s) => num(s.updates?.appUpdates)],
  [F.MAJOR_UPDATE, 'Major YunoHost upgrade available', binary(), (s) => flagOf(s.updates?.major)],
  [F.MIGRATIONS, 'Pending migrations', plain(), (s) => num(s.updates?.migrations)],
  [F.UPDATES_CHECKED, 'Package lists age', hours(), (s) => hoursOf(s.updates?.checkedSeconds)],
  [F.SERVICES_DOWN, 'Services down', plain(LIMITS.SERVICES), (s) => num(s.services?.down)],
  [F.DIAGNOSIS_ERRORS, 'Diagnosis errors', plain(), (s) => num(s.diagnosis?.errors)],
  [F.DIAGNOSIS_WARNINGS, 'Diagnosis warnings', plain(), (s) => num(s.diagnosis?.warnings)],
  [F.BACKUPS, 'Local backups', plain(), (s) => num(s.backups?.count)],
  [F.LAST_BACKUP, 'Newest backup age', hours(), (s) => hoursOf(s.backupAgeSeconds)],
  [F.LAST_ACTION, 'Last action', textual(), (s) => cut(s.lastAction)],
];

/** The running feature of each service read: [key, name, definition, value]. */
export const serviceFeatures = (names) =>
  names.map((name) => [
    `${SERVICE_PREFIX}${serviceId(name)}`,
    `Service ${name} running`,
    binary(),
    (s) => num(s.services?.services?.get(name)?.running),
  ]);

/** Every reading feature of a server whose services are `names`. */
export function allFeatures(names = []) {
  return [...SERVER_FEATURES, ...serviceFeatures(names.slice(0, LIMITS.SERVICES))];
}

/** The features of the created device the blueprint lacks, appended (never fewer). */
export function withCreatedFeatures(device, devices) {
  const created = (devices ?? []).find((d) => d?.external_id === device.external_id);
  if (!created) return device;
  const known = new Set(device.features.map((f) => f.external_id));
  const extra = (created.features ?? []).filter(
    (f) => f && typeof f.external_id === 'string' && !known.has(f.external_id),
  );
  if (extra.length === 0) return device;
  return { ...device, features: [...device.features, ...extra] };
}

/**
 * @param {object} gladys
 * @param {{ services?: string[], restartable?: string[] }} [what] the services
 *   read, the services listed as restartable in the configuration
 */
export function buildServerDevice(gladys, { services = [], restartable = [] } = {}) {
  const ids = serverIds(gladys);
  return withCreatedFeatures(
    {
      name: 'YunoHost server',
      external_id: ids.device,
      model: 'YunoHost',
      should_poll: false,
      features: [
        ...allFeatures(services).map(([key, name, definition]) => ({
          name,
          external_id: ids.feature(key),
          ...definition,
        })),
        button('Upgrade the system', ids.feature(F.UPGRADE_SYSTEM)),
        button('Upgrade the apps', ids.feature(F.UPGRADE_APPS)),
        button('Back up the server', ids.feature(F.BACKUP)),
        ...restartable.map((name) =>
          button(`Restart ${name}`, ids.feature(`${RESTART_PREFIX}${serviceId(name)}`)),
        ),
      ],
    },
    gladys.devices,
  );
}

/** The states of a reading for the created device: numbers and texts, never null nor NaN. */
export function statesOf(gladys, srv, { only } = {}) {
  const ids = serverIds(gladys);
  const created = (gladys.devices ?? []).find((d) => d?.external_id === ids.device);
  if (!created || !srv) return [];
  const have = new Set((created.features ?? []).map((f) => f?.external_id));
  const names = srv.services?.services ? [...srv.services.services.keys()] : [];
  const states = [];
  for (const [key, , definition, valueOf] of allFeatures(names)) {
    if (only && !only.includes(key)) continue;
    const id = ids.feature(key);
    if (!have.has(id)) continue;
    const value = valueOf(srv);
    if (definition.category === C.TEXT) {
      if (typeof value === 'string' && value)
        states.push({ device_feature_external_id: id, text: value });
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      states.push({ device_feature_external_id: id, state: value });
    }
  }
  return states;
}

/**
 * What a feature external id of this integration designates:
 *   { key } for a feature of the server, { key, restart: <service> } for a
 *   restart button, { key, service } for a running feature; null for the
 *   device itself; undefined when not ours.
 */
export function featureOf(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) return undefined;
  const device = serverIds(gladys).device;
  if (externalId === device) return null;
  if (!externalId.startsWith(`${device}:`)) return undefined;
  const key = externalId.slice(device.length + 1);
  if (Object.values(F).includes(key)) return { key };
  for (const [prefix, field] of [
    [RESTART_PREFIX, 'restart'],
    [SERVICE_PREFIX, 'service'],
  ]) {
    if (key.startsWith(prefix)) {
      const name = serviceNameOf(key.slice(prefix.length));
      return name ? { key, [field]: name } : undefined;
    }
  }
  return undefined;
}

/** The created device of the server, or null. */
export const createdServer = (gladys) =>
  (gladys.devices ?? []).find((d) => d?.external_id === serverIds(gladys).device) ?? null;
