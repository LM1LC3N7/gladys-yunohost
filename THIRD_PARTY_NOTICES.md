# Third-party notices

Nothing but the Gladys SDK is installed at runtime. No code of another project
is copied, ported nor bundled.

## YunoHost (API only)

- Project: <https://yunohost.org>, sources <https://github.com/YunoHost/yunohost>
  and <https://github.com/YunoHost/moulinette>, documentation
  <https://github.com/YunoHost/doc>.
- License of YunoHost and moulinette: GNU Affero General Public License v3
  (AGPL-3.0). Nothing of their code is in this repository: this integration
  only calls the administration API that YunoHost serves to its web admin,
  as a browser does.
- Version read: YunoHost 12.1.41.2 (`debian/changelog`, commit `2734f23`,
  2026-10-30), the developer documentation page `docs/dev/80.core/25.ynh_admin.mdx`
  ("the API commands/requests are also defined via the actionsmap", served
  under `/yunohost/api`).

What is used (the interface, never the code): the routes listed in
`share/actionsmap.yml` (`GET /versions`, `/update`, `/services`,
`/services/<name>`, `/diagnosis`, `/backups`, `/backups/<name>`; `PUT
/upgrade/system`, `/upgrade/apps`, `/services/<name>/restart`; `POST
/backups`), the login route of the API (`POST /login` with `credentials`
`user:password`, the `yunohost.admin` session cookie), the
`X-Requested-With` header the API asks for its forms, the field names of the
answers, and the facts that a 401 of the login route is a refused login and
that fail2ban counts those 401s.

No logo nor trademark of YunoHost is used: the cover image is drawn by
`scripts/cover.mjs`.
