# Nomad deployment

[doordash-cli-mcp.nomad.hcl](doordash-cli-mcp.nomad.hcl) runs one Linux amd64
allocation on port 8787. Node 24 and the complete, checksum-verified DoorDash
CLI v0.2.5 distribution are in the image. Persistent application state lives
in PostgreSQL; the allocation needs no host volume or macOS Keychain.

The job reads `nomad/jobs/doordash-cli-mcp` through an ordinary `nomadVar`
environment template. The Docker `auth` password is the literal `CHANGEME`;
replace it with your GHCR package-read token when submitting the job.
There are no Nomad `secret` blocks or Vault integration.

## Prerequisites and PostgreSQL

- A Nomad Linux amd64 Docker client in `dc1`, with workload identity access to
  the job's Variable path in the target namespace.
- An ingress/controller honoring `service.meta.public_hostname`, with DNS and
  TLS for your hostname. Replace `doordash.example.com` in the job file.
- PostgreSQL reachable from the allocation, with a dedicated `doordash` role
  and database. PostgreSQL 17 is used in CI.
- A GitHub personal access token (classic) with `read:packages`, owned by a
  user who can read `ghcr.io/francisschmaltz/doordash-cli-mcp`.

Connect with `psql` as a PostgreSQL administrator and create the application
role and database. `\password` prompts without recording the password in
SQL history:

```sql
CREATE ROLE doordash LOGIN;
\password doordash
CREATE DATABASE doordash OWNER doordash;
```

Use `postgres://doordash:URL_ENCODED_PASSWORD@HOST:5432/doordash` as
`database_url`. The application applies versioned migrations before listening;
the role must own its schema and be able to create tables. Backups must include
MCP token hashes, permissions, submission history, and the shared DoorDash
credential. The credential is a live account token stored in PostgreSQL.

Use `database_ssl=true` for TLS. Keep `database_ssl_reject_unauthorized=true`
with a trusted certificate; set it to `false` only for your private self-signed
database certificate. This setting affects the PostgreSQL connection only.

## Initial Nomad Variables

Copy the placeholder document outside the repository and edit that copy:

```bash
umask 077
cp docs/nomad/nomad-variable.example.json /secure/path/doordash.nomad-vars.json
```

Set `Namespace` to the deployment namespace and fill these `Items`:

| Item | Value |
| --- | --- |
| `database_url` | Dedicated `doordash` PostgreSQL connection URL |
| `database_ssl` | `true` for a TLS database connection |
| `database_ssl_reject_unauthorized` | `true`, or `false` for a private self-signed certificate |
| `admin_access_token` | Generate with `openssl rand -hex 32` |
| `dd_cli_access_token` | Optional initial DoorDash token; keep the key with `""` when unused |

Write the Variable after editing the secure copy:

```bash
nomad var put -in=json \
  nomad/jobs/doordash-cli-mcp \
  @/secure/path/doordash.nomad-vars.json
```

Use `-namespace=YOUR_NAMESPACE` for these Nomad commands when deploying outside
`default`. Keep real credentials out of repository files and build arguments;
replace `CHANGEME` in the job you submit to Nomad.

## Import the existing SQLite state

Stop the old server before copying its `.data/doordash-mcp.sqlite` database;
that also flushes SQLite WAL state. Keep a backup. Import **before starting the
new server** so the PostgreSQL credential store and submission ledger begin
with the existing state.

On a machine with Node 24, the repository dependencies, and a secure `.env`
pointing at the target PostgreSQL database:

```bash
npm run import:sqlite -- /secure/path/doordash-mcp.sqlite
```

The importer runs migrations and imports the original MCP token hashes,
purchase permissions, revocations, and submission attempts. Existing bearer
tokens keep working; purchase attempts retain their duplicate protection.
The importer is one-time and requires an empty destination: no existing MCP
tokens, submission attempts, DoorDash credentials, or prior import marker.
Applying migrations beforehand is fine. It does not import macOS Keychain
credentials. Keep the source SQLite database for
rollback until the PostgreSQL deployment is verified.

## Publish and deploy

One GitHub workflow checks syntax and runs the test suite once, including
PostgreSQL integration, for pull requests and pushes to `main`. Docs-only changes
skip CI. After checks pass on `main`, it builds one cached Linux amd64 image and
publishes:

```text
ghcr.io/francisschmaltz/doordash-cli-mcp:latest
ghcr.io/francisschmaltz/doordash-cli-mcp:sha-FULL_COMMIT_SHA
```

The workflow also supports manual dispatch. Container smoke verification is an
optional local check: build `doordash-cli-mcp:test` and run `npm run test:container`
as shown in the root README. It covers CLI startup, migrations, HTTP/MCP
authentication, restart persistence, revocation, and database outage/recovery.

Publishing an image does not deploy it. Validate, plan, and submit the job:

```bash
nomad job validate docs/nomad/doordash-cli-mcp.nomad.hcl
nomad job plan docs/nomad/doordash-cli-mcp.nomad.hcl
nomad job run docs/nomad/doordash-cli-mcp.nomad.hcl
```

The checked-in job has a literal `latest` image. After a later publish:

```bash
nomad job restart -yes doordash-cli-mcp
```

The Docker driver pulls `latest` when a task starts. Variable updates restart
the task through `change_mode = "restart"`; ordinary DoorDash token renewal
through MCP requires no Variable change or restart.

## Login and MCP connection

On a laptop with browser sign-in, run the [supported export command](https://developer.doordash.com/en-US/docs/cli/tutorials/get_started/):

```bash
./dd-cli export-token
```

Provide its output through the authenticated MCP tool:

```json
{"name":"doordash_auth","arguments":{"access_token":"EXPORTED_TOKEN"}}
```

Any active MCP bearer can use `doordash_auth`; purchase permission remains a
separate setting. The tool validates a replacement with a read-only DoorDash
command, saves it in PostgreSQL, and starts using it immediately. Invalid
replacements leave the current credential intact. Calling it without
`access_token` returns authentication status and renewal instructions.

For first boot, `dd_cli_access_token` can instead seed an empty credential
store. Once PostgreSQL has a credential, that environment value is ignored,
including after restarts. Remove the bootstrap value from the Variable once
stored if desired; keep its key empty so template rendering continues.

The exported credential contains an access token only; it cannot renew itself
headlessly. When it expires, the assistant asks for another exported token and
calls `doordash_auth` in the same conversation. Follow the original inspection
and duplicate-submission rules for any cart/order command already attempted.

Open `https://YOUR_HOST/`, authenticate with `admin_access_token`, and generate
an MCP bearer. Configure the client with:

- Transport: `MCP (Streamable HTTP)`
- URL: `https://YOUR_HOST/mcp`
- Authentication: the generated MCP bearer token

Disconnect and reconnect clients that cache tool schemas after an upgrade.
The admin secret and MCP bearers serve different interfaces.

## Health checks and rollback

```bash
nomad job status doordash-cli-mcp
curl --fail-with-body --silent --show-error https://YOUR_HOST/health/live
curl --fail-with-body --silent --show-error https://YOUR_HOST/health/ready
```

`/health/live` reports the process; `/health/ready` verifies PostgreSQL.
Missing or expired DoorDash credentials do not fail health checks, so renewal
stays reachable through MCP. A database outage fails readiness; the process
can recover when PostgreSQL returns.

To roll back within the PostgreSQL releases, edit only the literal image tag:

```hcl
image = "ghcr.io/francisschmaltz/doordash-cli-mcp:sha-PREVIOUS_FULL_COMMIT_SHA"
```

Then plan and run the job again. Migrations are forward-only: use an older
image only if it supports the installed schema. Rolling back to the original
macOS/SQLite service also requires restoring its SQLite backup. It will not
contain tokens or submission attempts created after the move; reconcile that
ledger before permitting purchases to avoid duplicate submissions.
