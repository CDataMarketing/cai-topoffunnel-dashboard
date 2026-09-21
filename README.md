# CAI Top-of-Funnel Dashboard & Web Experiments

Internal five-tab dashboard for Connect AI demand generation, published to the
company reports portal (cdatareports.azurewebsites.net, slug
`ai-ctr-dashboard-web-experiments`). Migrated 2026-09-21 from the hackathon repo
(`marketing-cockpit-hackathon`, branch team-5, `teams/team-5/ctr-dashboard/`)
with full history.

**Tabs:** Trial Attribution (weekly started trials by entry channel and by
entry URL pattern, CVR, opportunities) · CAI Traffic, CTR & Trials (daily/weekly
engaged sessions, cc_ai_* click events, CTRs, trials per URL pattern and
traffic type; local-only single-page lookup) · Visitor Intent (page types as a
funnel with paid + organic search intents per category — updates ONLY on
explicit request) · Experiment Timeline (per-page CTR development with
experiment windows) · Experimentation Log (full experiment list with AI
evaluations and test suggestions).

## Run it

```bash
# 1. Connect Engine (data layer; needs engine/.oauth/ with a cached OAuth
#    token — NOT in git; log in once via POST http://localhost:8090/auth/login):
cd engine
java -cp "target/classes;lib/cdata.jdbc.connect.jar;lib/json.jar" com.cdata.hackathon.engine.Main

# 2. Dashboard server (from the repo root):
node server.js          # → http://localhost:3010
```

**Data location caveat:** the scripts write the snapshot to `../data/cache/`
relative to the repo root — i.e. NEXT TO a standalone clone, by design never
inside git. The operational working copy currently lives in the hackathon
repo layout, where that resolves to `teams/team-5/data/cache/`.

**No-server option:** `../data/cache/ai-ctr-dashboard.html` is the
self-contained artifact (also what gets published to the portal). Rewritten on
every fetch/export.

## Files

- `patterns.js` — URL patterns (rows of the CAI tab), GA4 scopes, traffic-bucket mapping
- `fetch-data.js` — GA4 via the engine → aggregates per pattern/day →
  `../data/cache/ctr-dashboard.json`, then rebuilds the artifact and re-runs
  fetch-trials non-fatally. Incremental by default (trailing 10 days);
  `--start YYYY-MM-DD --only <scopes>` for backfills; `--heavy` adds the
  weekly-only KB scopes. Splits a date chunk on row-cap AND on upstream query
  timeout.
- `fetch-trials.js` — Salesforce started trials (Lead `Entry_Attribution__c` +
  `Cloud_AccountId__c`) → `snapshot.trials/trialAttribution/trialsAllTotal/
  trialOpps/trialOppsByPattern/trialMaxExpiry`. Tracking start 2026-09-01.
  **Spreadsheets-edition and OEM signups are excluded at fetch time** (CAI
  account PlanType 'Spreadsheets' / IsOEM). Opportunity attribution: CAI
  new-business opp on the converted account, credited to the latest prior
  signup.
- `funnel-intents.json` — the Visitor Intent tab's frozen analysis (paid Google
  Ads search terms + GSC organic queries per page category). Request-only
  updates; the scheduled tasks never touch it.
- `export.js` — builds the standalone HTML artifact (embeds snapshot + UI)
- `server.js` — serves UI + `/api/data`, `/api/refresh`, `/api/experiments`,
  and the local-only single-page lookup (`/api/page-slugs`, `/api/page-lookup`)
- `experiments.json` — the experiment log (edited via the UI; evaluations
  follow the rules in the weekly scheduled task)
- `public/index.html` — the whole UI (vanilla JS)
- `engine/` — the Connect Engine (Java bridge to CData Connect AI; queries GA4,
  Google Ads and Salesforce). Put OAuth settings in `engine/.oauth/` (gitignored).

## Refresh & publishing

Claude Code scheduled tasks on Christof's machine: `daily-ai-ctr-refresh`
(09:00 Berlin, incremental fetch + portal publish) and `weekly-ai-ctr-refresh`
(Mondays 11:00, adds the heavy KB scopes and processes requested experiment
re-evaluations under documented rules: traffic-base, post-window,
secondary-metric, control-group, trials, style). Publishing: portal
`get_report_upload_url` → HTTP PUT of the artifact → `publish_report`.

## GA4 driver pitfalls (hard-won — do not regress)

- Use `[StartDate]`/`[EndDate]` pseudo-columns for the API date range; plain
  `[date] >=` filters silently miss history.
- Only exact `=` / prefix `LIKE` page filters push down; `OR` or mid-string
  wildcards cause multi-minute full-property scans.
- The engine handles one query at a time; never run two fetches concurrently.
  After a cloud timeout, restart the engine java process.
- Heavy backfills can hit GA4's hourly quota (HTTP 429) — back off ~1h, never
  retry in a loop.
- The last ~2 days of GA4 data are incomplete (sessions settle up to 48h late);
  evaluations exclude them, the 10-day lookback heals them.
- Japanese pages (`/jp/`) are excluded from all analyses.
- Trials caveats: per-channel CVRs mix Salesforce (trial source) with GA4
  (sessions) — approximations; only the All bucket is exact. The page-less
  `web` entry marker carries a traffic category but no URL pattern.
