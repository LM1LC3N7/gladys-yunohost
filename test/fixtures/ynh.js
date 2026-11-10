// -----------------------------------------------------------------------------
// Answers of a YunoHost 12 administration API, shaped after the routes of its
// actionsmap and the return values documented there (no answer of a real
// server recorded: never tested with a real one). The names are made up.
// -----------------------------------------------------------------------------

export const USERNAME = 'camille';
export const PASSWORD = 'Sésame ouvre-toi 42!';
/** A JWT-shaped session cookie (base64url and dots). */
export const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiY2FtaWxsZSJ9.c2Vzc2lvbi1zaWduYXR1cmU';
/** A domain of the user: never in a log, a status nor /data. */
export const DOMAIN = 'maison-dupont.nohost.me';

export const versions = (version = '12.1.41.2') => ({
  yunohost: { version, repo: 'stable' },
  yunohost_admin: { version: '12.1.10', repo: 'stable' },
  moulinette: { version: '12.1.6', repo: 'stable' },
  ssowat: { version: '12.1.3', repo: 'stable' },
});

export const updates = ({
  system = 3,
  apps = 1,
  major = false,
  migrations = 0,
  age = 7200,
} = {}) => ({
  system: {
    yunohost: Array.from({ length: Math.min(system, 1) }, () => ({
      name: 'yunohost',
      current_version: '12.1.41.2',
      new_version: '12.1.42',
    })),
    'misc utils and libs': Array.from({ length: Math.max(0, system - 1) }, (_, i) => ({
      name: `libfoo${i}`,
      current_version: '1.0',
      new_version: '1.1',
    })),
  },
  apps: [
    ...Array.from({ length: apps }, (_, i) => ({
      id: `app${i}`,
      name: `App ${i}`,
      label: `${DOMAIN} app ${i}`,
      upgrade: { status: 'upgradable', current_version: '1.0~ynh1', new_version: '1.1~ynh1' },
    })),
    // Listed but not counted (as `yunohost tools update` does).
    { id: 'oldapp', upgrade: { status: 'url_required' } },
  ],
  important_yunohost_upgrade: major,
  pending_migrations: Array.from({ length: migrations }, (_, i) => ({ id: `00${40 + i}_x` })),
  last_apt_update: age,
  last_apps_catalog_update: 3600,
});

export const service = (
  status = 'running',
  boot = 'enabled',
  changed = '2026-11-10T07:00:00+00:00',
) => ({
  status,
  start_on_boot: boot,
  last_state_change: changed,
  description: 'A service',
  configuration: 'valid',
});

export const services = () => ({
  nginx: service(),
  'php8.2-fpm': service(),
  'yunohost-api': service(),
  slapd: service(),
  postfix: service('failed'),
  'redis-server': service(),
  // Stopped on purpose (disabled): not down.
  dnsmasq: service('dead', 'disabled'),
  // A oneshot service: unknown, never "down".
  'yunohost-firewall': service('unknown', 'enabled', 'unknown'),
});

export const diagnosis = ({ errors = 1, warnings = 2 } = {}) => ({
  reports: [
    {
      id: 'basesystem',
      description: 'Base system',
      items: [{ status: 'SUCCESS', summary: 'ok' }],
    },
    {
      id: 'dnsrecords',
      description: 'DNS records',
      items: [
        ...Array.from({ length: errors }, () => ({ status: 'ERROR', summary: `${DOMAIN} bad` })),
        ...Array.from({ length: warnings }, () => ({ status: 'WARNING', summary: 'meh' })),
        { status: 'INFO', summary: 'note' },
      ],
    },
  ],
});

export const backups = (names = ['20261101-020000', '20261108-020000']) => ({ archives: names });

export const backupInfo = (createdAt = '2026-11-08T02:00:00+00:00') => ({
  path: '/home/yunohost.backup/archives/20261108-020000.tar',
  created_at: createdAt,
  description: '',
  size: 123456789,
  apps: {},
  system: {},
});
