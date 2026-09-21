# Connect Engine

A small shared service that any hackathon team's app can call to run SQL against
**CData Connect AI** — the same data layer described in the root
[`CLAUDE.md`](../CLAUDE.md) — without every team needing to touch JDBC or set up
their own credentials.

It wraps the **CData JDBC Driver for Connect**, authenticated via **OAuth**
(`InitiateOAuth=GETANDREFRESH`) instead of a hosted username/PAT: the first time it
runs, it opens a browser for a one-time login against CData Connect Cloud, then the
driver caches and silently refreshes the token locally. No credential ever lives in
code, an env file, or git.

## Why this exists

Teams building against Connect AI have two options: go through Claude/MCP (good for
exploration, bad for a live app that needs to hit the database on every page load), or
query Connect AI directly from app code. This engine is the second path — a tiny local
HTTP API in front of the JDBC driver, so a team's Node/Python/whatever app can do:

```bash
curl -s -X POST http://localhost:8090/query \
  -H 'Content-Type: application/json' \
  -d '{"sql": "SELECT [Key],[Summary],[StatusName] FROM [Jira-Prod].[Jira].[Issues] WHERE [ProjectKey] = '\''WEB'\'' LIMIT 25"}'
```

and get JSON rows back — no JDBC, no OAuth handshake, no credentials to manage.

## Setup

### 1. Prerequisites

- Java 17+ and Maven (`java -version`, `mvn -version`)
- A CData Connect Cloud account with access to the org's connections

### 2. Build and run

```bash
cd engine
./run.sh
```

`run.sh` fetches the driver automatically the first time it runs, straight from
CData's own canonical driver repository at `maven.cdata.com` — the same build CData
ships, no re-hosting, no separate account or token needed (it's a plain public
download; licensing is enforced later, at OAuth login). It is not committed to git
since it's a vendor binary.

If you'd rather fetch it yourself: [connect-jdbc-26.0.9676.jar](https://maven.cdata.com/p/jdbc/cdata/connect-jdbc/26.0.9676/connect-jdbc-26.0.9676.jar),
placed at `engine/lib/cdata.jdbc.connect.jar`.

Then it builds the project (`mvn package`) if needed, and starts the server. See
**Authentication** below for what to wire up in your app — it needs an explicit "Sign
In" step, it doesn't just happen on first query.

## Authentication — what to call from a "Sign In" button

The engine doesn't log in on its own. Your app's UI needs a real sign-in affordance
that calls these two endpoints:

- **`GET /auth/status`** → `{"authenticated": true|false}`. Non-triggering — call this
  on page load to decide whether to show "Sign In" or "Signed in as ...". Safe to poll;
  it never opens a browser or attempts a connection.
- **`POST /auth/login`** → `{"authenticated": true}` once connected. **This is what
  your Sign In button's click handler calls.** If no token is cached yet, it opens the
  system browser to the CData Connect Cloud consent screen and **blocks until a human
  completes it** (or it fails) — so the call can hang for a while on first use. Design
  the button to show a "waiting for sign-in..." state and disable itself while the
  request is in flight, rather than a plain spinner. If a token is already cached
  (this machine, or a prior run), it returns almost immediately.

Once authenticated, the driver persists the refreshed token at
`engine/.oauth/oauthsettings.txt` (gitignored) and silently refreshes it after that —
you won't need to call `/auth/login` again unless that file is deleted or the refresh
token is revoked.

Whoever completes that login is the identity the engine queries as — every `/query`
request runs with that person's Connect Cloud permissions. See **Per-user auth in a
hosted deployment** below — this local flow is one identity per running engine, not
one identity per end user.

## API

**`GET /health`** — pure liveness check, `200 {"status":"ok"}` if the process is up.
No JDBC/OAuth side effects — safe for a load balancer or uptime monitor to poll.

**`GET /auth/status`** / **`POST /auth/login`** — see Authentication above.

**`POST /query`** — body `{"sql": "..."}`.
- `SELECT` statements return `{"columns": [...], "rows": [...], "rowCount": N}`.
- `INSERT`/`UPDATE`/`DELETE`/procedure calls return `{"updateCount": N}`.
- Returns `500` if `/auth/login` hasn't succeeded yet — call that first.

## Per-user auth in a hosted deployment (e.g. Azure)

This local setup gives you **one CData Connect Cloud identity per running engine
process** — whoever clicks through `/auth/login` first. That's fine for local dev
(you're the only user), but it does **not** become per-user auth just by deploying the
same code to an Azure App Service. Every visitor to that hosted site would still share
whatever single identity is cached on the server. Two real options if you deploy this:

1. **App-level SSO + one shared service identity (recommended for this app).** Put
   real per-user login in front of the app itself — Azure AD/Entra ID, since everyone's
   already a CData employee with corporate SSO — so you get genuine per-user identity,
   access control, and audit logging at the application layer. The engine underneath
   keeps using **one** CData Connect Cloud service-account token, just persisted
   somewhere durable and shared across app instances (Azure Key Vault or an encrypted
   DB row, not a local file — `InitiateOAuth=GETANDREFRESH`'s local-file caching is a
   dev-machine convenience, not a hosted-service pattern). This is how most internal
   BI/dashboard tools work: one service account to the data layer, with the app's own
   auth governing who sees the UI at all. Least engineering, and it matches this app's
   actual sensitivity boundary — "is this a CData employee," not "does this specific
   employee have different Salesforce/Asana permissions than their teammates."

2. **True per-user CData OAuth.** Only worth it if different end users genuinely need
   different Connect Cloud entitlements enforced server-side. This is a real
   architecture change, not a config flag: swap the desktop-oriented loopback flow
   (`InitiateOAuth=GETANDREFRESH`, which needs a browser and a localhost callback on
   the *same machine* as the driver) for a standard web OAuth 2.0 authorization-code
   flow — register a CData Connect Cloud OAuth app with a real HTTPS redirect URI on
   your Azure domain, drive the authorize/callback exchange yourself, and store each
   user's own access/refresh token server-side (encrypted, keyed by their app session)
   instead of the shared connection pool this code uses today. Every real end user
   would also need their own CData Connect Cloud account with appropriate
   entitlements — confirm that's viable before committing to this path.

## Concurrency

The engine runs a small **pool of JDBC connections** (default 5, `ENGINE_POOL_SIZE`)
behind a matching HTTP thread pool, so concurrent requests actually run in parallel.
This replaced an earlier version that shared one `Connection` behind
`server.setExecutor(null)` — worth knowing if you're wondering why the API looks the
way it does:

- **`setExecutor(null)` makes `HttpServer` fully sequential** — every request,
  regardless of how many arrive at once, is handled one at a time on a single thread.
  Measured against a real dashboard load (7 concurrent queries): total wall time was
  **28.8s concurrent vs. 24.9s sequential** — concurrency bought nothing, because
  nothing was actually happening in parallel.
- **A single shared `Connection` reused across threads is also a correctness risk**,
  not just a speed one — JDBC connections aren't generally safe for concurrent
  statement execution by multiple threads. This is a plausible cause behind reports of
  the engine "just not working" under load, not only being slow.
- **Fixed by:** each `/query` request now borrows its own `Connection` from a pool
  (`ConnectEngine.borrowConnection`/`returnConnection`) for the life of that one query,
  and `HttpServer` runs on `Executors.newFixedThreadPool(poolSize + 2)` instead of the
  default. Same 7-query load after the fix: **12.1s concurrent vs. 23.9s sequential** —
  concurrent time now tracks the slowest single query, not the sum of all of them.
  Verified correct under load (10 concurrent distinct queries against a pool of 5, no
  cross-contamination, no deadlock — pool.take() just blocks a caller until a
  connection frees up once all 5 are checked out).
- **Tune `ENGINE_POOL_SIZE`** if needed, but remember Rule 3: Salesforce and Asana are
  shared, rate-limited production connections used by every team. A bigger pool means
  more genuinely concurrent requests against those sources, not just faster localhost
  responses — don't set this arbitrarily high.

## Security model — read before pointing another machine at this

- **The server binds to `127.0.0.1` only.** It is reachable from processes on the same
  machine, not from the network. This is deliberate: `/query` will run *any* SQL it's
  given, including writes, so it is not safe to expose beyond localhost as-is.
- **There is currently no auth on the HTTP layer itself.** OAuth secures the JDBC
  driver's connection to Connect Cloud; it does not gate who can call this local API.
  Anything on this machine that can reach port 8090 can run SQL through it.
- If a team genuinely needs to call this from a different machine or container, that
  requires adding real authentication (e.g. a shared-secret header) first — don't just
  rebind to `0.0.0.0`. Talk to Jerod before changing this.

## Playing by the hackathon's rules

This engine is a plumbing layer, not a policy enforcer — the conventions in the root
[`CLAUDE.md`](../CLAUDE.md) still apply to whatever you build on top of it:

- **Rule 1 (context):** this is the "app queries Connect AI directly at runtime" path
  the root CLAUDE.md describes — real rows can flow straight to your app. Just don't
  paste query results from here back into a Claude Code session.
- **Rule 3 (rate limits):** this engine does **not** cache for you. Cache-first is
  still your app's responsibility for anything hitting Salesforce or Asana.
- **Rule 4 (Asana writes):** if you use `/query` to write to Asana, you still need the
  `[HACKATHON]` prefix and an entry in `data/asana-writes.log`, same as any other write.
