# AI CTR Dashboard + Web Experiments

Two-tab internal dashboard: **AI CTR Dashboard** (daily GA4 engaged sessions, cc_ai_*
events and CTRs per URL pattern) and **Web experiments** (experiment tracking linked to
the CTR data). Built 2026-08-12 for team-5.

## Run it

```bash
# 1. Connect Engine (data layer, one per machine) — from repo root:
cd engine
java -cp "target/classes;lib/cdata.jdbc.connect.jar;lib/json.jar" com.cdata.hackathon.engine.Main
# then once: POST http://localhost:8090/auth/login (uses cached OAuth token in engine/.oauth/)

# 2. Dashboard server:
cd teams/team-5/ctr-dashboard
node server.js          # → http://localhost:3010
```

In Claude Code, the launch config **"AI CTR Dashboard"** starts the server for you.

**Auto-start:** a shortcut to `start-dashboard.vbs` in the Windows Startup folder
(`shell:startup` → "AI CTR Dashboard.lnk") launches the server hidden at every logon,
so the bookmark artifact's "Refresh data" button always works. The server starts the
Connect Engine on demand; a second instance on a busy port exits by itself. To remove
the auto-start, delete the shortcut from the Startup folder.

**No-server option:** `data/cache/ai-ctr-dashboard.html` is a self-contained snapshot
(bookmarkable, works offline, read-only). It is rewritten on every data fetch/export.

## Files

- `patterns.js` — URL patterns (= dashboard tabs), scopes, traffic-bucket mapping
- `fetch-data.js` — pulls GA4 via the engine, aggregates per pattern/day, writes
  `../data/cache/ctr-dashboard.json`, then rebuilds the HTML artifact.
  Incremental by default (last 10 days); `--full --start YYYY-MM-DD` for backfills.
- `export.js` — builds the standalone HTML artifact from the snapshot + UI
- `server.js` — serves UI + `/api/data`, `/api/refresh`, `/api/experiments`
- `experiments.json` — the Web experiments list (edited via the UI)
- `public/index.html` — the whole UI (vanilla JS)

## Weekly refresh

Claude Code scheduled task `weekly-ai-ctr-refresh`: Mondays 11:00 (local/Berlin),
incremental fetch + artifact rebuild. Runs while the Claude desktop app is open;
runs on next launch otherwise.

## GA4 driver pitfalls (hard-won — do not regress)

- Use `[StartDate]`/`[EndDate]` pseudo-columns to set the API date range. Plain
  `[date] >=` filters only filter within the driver's ~30-day default window and
  silently return nothing for older dates.
- Only exact `=` / prefix `LIKE` page filters push down; `OR` or mid-string wildcards
  cause multi-minute full-property scans.
- `PropertyId` WHERE filters are silently ignored — the connection's default property
  (www.cdata.com GA4, 257445678) is always used.
- The engine handles one query at a time; never run two fetches concurrently. After a
  cloud timeout, restart the engine java process (connection goes stale).
- Heavy backfilling can hit GA4's hourly API quota (HTTP 429) — back off ~1h.
- Yesterday's GA4 numbers are incomplete (sessions settle late); the weekly job's
  10-day lookback corrects this automatically.
- **Japanese pages (`/jp/` anywhere in the path) are excluded from all analyses**
  (per Christof). The `isJapanese` guard in fetch-data.js enforces this at
  aggregation time; as of 2026-08-17 no /jp/ pages exist in this GA4 property's
  scoped sections anyway.
