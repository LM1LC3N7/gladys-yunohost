# TODO — YunoHost v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests on Node 24 and 22,
  Docker build, store validator), `npm audit --omit=dev`, the mutants
  (`node scripts/mutants.mjs`, under `memcap`), then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. The claim is in /t/10385 (lot 21, reply 475).

## Status

- [x] **Milestone 1 — core** (2026-11-10): the administration API of
      YunoHost (`/yunohost/api`, after its actionsmap): login by
      `credentials` `user:password`, the `yunohost.admin` cookie; GET
      `/versions` (needed), `/update`, `/services`, `/diagnosis`, `/backups`
      (+ the date of the newest archive, read once per archive) secondary;
      HTTPS only, the certificate checked by its SHA-256 fingerprint before any
      byte is written (pinned in /data at the first contact, written before
      the password is sent; or typed; or trusted by a two-click button); a
      login gate after a refusal (fail2ban); one device (12 features + one
      per service), four kinds of buttons off by default (upgrade system,
      upgrade apps, backup, restart a listed service); pace on a monotonic
      clock; refused login, changed certificate, pause 429/5xx, login gate and
      the delays between actions kept in /data; /data bounded in time, re-read
      on its own timer. Tested against the SDK's fake Gladys, a fake server in
      memory, real TLS servers on loopback, a real-clock test, a
      versioned mutation list. **Never tested with a real YunoHost server.**
- [ ] **Milestone 2 — real server** (a YunoHost 12 in a VM, or a tester):
      record real answers as fixtures (domains and names anonymized), fix
      what differs. To check first:
  - that `POST /login` with `{"credentials": "user:password"}` in JSON
    answers 200 and the `yunohost.admin` cookie on 11.1, 11.2 and 12.x, and
    401 on a wrong password (a 401 is also what the API answers when LDAP is
    down: taken as a refusal here; the test button and a save try again);
  - how many refused logins fail2ban takes before banning, and for how long
    (the `yunohost` jail; the gate starts at 5 min and doubles);
  - what `GET /update` (no refresh) costs on a server with 30 apps, and
    whether `last_apt_update` really follows the Debian apt timers;
  - the exact shape of `GET /services` on 11.x (`status`, `start_on_boot`,
    `last_state_change` as an ISO date) and whether a restart changes
    `last_state_change` at once;
  - whether `GET /services/<name>` answers within the 2.5 s of the fresh read
    of a restart (YunoHost runs the configuration test of the service there,
    `nginx -t` for nginx);
  - the dates of `GET /backups/<name>` (`created_at` written with or without
    a time zone);
  - what `PUT /upgrade/system` answers when the YunoHost package itself is
    upgraded (the API restarts 10 s after its answer), and what nginx
    answers past its 1 h `proxy_read_timeout` (504 assumed: "sent, no final
    answer");
  - whether an administrator with the web admin allowlist off but the
    "admin only from the local network" setting on sees a 403;
  - the session: 3 days of validity, touched at each request; whether a
    session per restart of the container leaves too many session files
    (they are purged after 3 days).
- [ ] **Later** (ask on the forum first): refresh the update lists (PUT
      `/update/all`, it fetches from the internet), run the diagnosis, the
      free disk space (diagnosis `systemresources` data), the apps and their
      versions, the domains and their certificates (expiry), a log out at
      stop, accepting automatically a Let's Encrypt renewal for the same
      names (needs Louis's decision: see Decisions).

## Decisions

- **Version 0.1.0 set by hand** (package.json, package-lock.json, manifest,
  `docker_image` tag) before the first release; versions belong to the
  Release workflow from then on. The User-Agent takes the version of
  package.json at start.
- **SDK `^0.16.0`** (latest on npm on 2026-11-10). `keywords`, `countries` and
  `gladys_version >= 5.3.0` wait until Gladys 5.3 is widespread. Planned:
  keywords `yunohost`, `self-hosting`, `server`, `upgrade`, `backup`;
  countries: worldwide. Category `servers`.
- **License**: YunoHost and moulinette are AGPL-3.0 (LICENSE read on
  2026-11-10, YunoHost 12.1.41.2, commit `2734f23`). Only the API is called;
  the routes, the field names and the login protocol were read in the
  actionsmap and the moulinette API to call them, nothing copied nor ported.
- **Read only by default.** Four kinds of buttons, each a `button`/`push`
  feature, never a switch: `upgrade_system` and `upgrade_apps` (option
  `allow_upgrades`), `backup` (option `allow_backup`), `restart_<id>` (only
  the services of `restart_services`, empty by default). Each option is
  checked at the press, again after the fresh read, and again in
  `beforeSend`, right before the request is written. No action is
  protective: none is ever sent without its option.
- **An action**: refused during a pause, a final failure, while /data cannot
  be read, while another action runs, or within its delay (30 min per
  upgrade kind, 1 h for the backup, 2 min per service); it waits for the
  reading in flight (within its 2.5 s budget), then a fresh read
  (`/versions`, or `/services/<name>` for a restart: an unknown service is
  refused); the delay is written to /data before the first byte, put back
  when the request was not written or YunoHost answered "no" (4xx, 401, 403,
  redirect). A 500 of the action route keeps the delay (the action may have
  run) and never pauses the readings (it is the lock of another operation or
  the failure of this one). A 502/504, a silence or a cut answer after the
  request left: "sent, no final answer".
- **Long actions**: an upgrade or a backup runs inside its HTTP request
  (nginx gives it 1 h). The press is answered within the 5 s of Gladys: the
  answer of YunoHost if it came by 4.5 s, else success once the request was
  written (the button means "start"); the outcome goes to the `last_action`
  text feature and the log, then a reading 15 s later. A restart answers in
  seconds: without an answer by 4.5 s the press fails with "sent, without an
  answer yet" (never a success), and the service is read again 5 s after an
  answer (running, and `last_state_change` moved).
- **Certificate**: as gladys-qnap-qsw (first pin written before the password;
  /data unreadable or not writable: nothing learned nor sent). Another
  certificate stops everything until it is trusted: its fingerprint typed in
  the form, or the "Trust the certificate met" button pressed twice within 2
  minutes (the first press shows the fingerprint; only the certificate met
  and refused can be trusted; written to /data first). Let's Encrypt
  renews with a new key every 60 to 90 days, so a user on a domain sees this
  every renewal: accepting a renewal signed by a public authority for the
  same names automatically was **not** done (the brief says "a change blocks
  until agreed"): Louis's decision.
- **Identity**: the pinned certificate is the identity of the server; no
  other identifier is kept (the domains are personal). The external id is
  fixed (`server:main`).
- **Refused login**: only `POST /login` answering 401. 8 bits of an HMAC of
  the refused password, per address and user, in /data, so that a restart
  does not send it again. Saving the configuration always tries the password
  saved once; the test button tries once. **Login gate**: after each 401, no
  login at all (test button, save, fresh read of an action included) for 5
  min, doubling per refusal in a row up to 6 h, kept in /data, lifted by a
  login that works (fail2ban bans after a few refusals; the gate keeps
  Gladys well under it). A 403 is never a refusal (nginx allowlist, CSRF).
- **Secondary routes**: updates, services, diagnosis, backups: any failure
  (5xx, 401, timeout, unreadable answer) leaves their values unpublished this
  time, said in the status, never a pause nor a failed reading; a certificate
  or login refusal met there is final as anywhere. A 401 there opens no
  session; a failing part is asked again 1, 2, 4... readings later, at most
  6 h apart.
- **Counts**: what YunoHost lists, strictly (a list of an unexpected shape is
  unknown, never 0). Apps to upgrade: status `upgradable` or
  `fail_requirements`, as `yunohost tools update` counts them. A service is
  down when `start_on_boot` is `enabled` and its systemd sub-state is `dead`
  or `failed`; `unknown` (oneshot) and the other sub-states are unknown. The
  package lists age is unknown when YunoHost says 99999 h.
- **Service ids**: the name with every character other than a-z, 0-9 and `-`
  written `_<hex>` (injective; never `.` nor `:` in an id); at most 64
  services read (sorted), 16 restartable.
- **/data** (lessons of lot 20): every read and write bounded to 5 s; the
  file opened non-blocking and refused unless a regular file; the temporary
  file created anew (`wx`). Unreadable or slow at start: read again every
  10 s on its own timer, never two reads at once; a refusal, a gate or a
  pause decided meanwhile is merged into what /data holds.
- **Pace**: one timer; `dueAt(mono)` on the caller's instant; the time of the
  last attempt written to /data before the request; failures retried from
  max(1 min, interval) doubling to 1 h; 429/5xx of the main route a pause of
  the interval to 6 h, Retry-After honoured, kept in /data. The test button
  reading counts as the reading of the session. Only the end of an upgrade or
  a backup, and a certificate just trusted, bring a reading forward.
- **Units** (core list only): hours for the ages; counts have no unit in the
  core: plain numbers (category `unknown`), the unit in the name.
- **No scene trigger**: the counts and the service binaries are device values,
  usable in scenes as any.
- **User-Agent**: `gladys-yunohost/<version> (+https://github.com/LM1LC3N7/gladys-yunohost)`,
  never a browser's.
