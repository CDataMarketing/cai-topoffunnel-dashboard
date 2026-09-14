#!/usr/bin/env node
'use strict';
// Pulls daily engaged sessions + cc_ai_* event counts from GA4 (via the shared
// Connect Engine) for the URL patterns in patterns.js and writes an aggregated
// snapshot to data/cache/ctr-dashboard.json. Raw rows stay in this process —
// they never pass through an AI model (root CLAUDE.md Rule 1).
//
// Usage: node fetch-data.js [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--full]
//   Default: incremental — refetches from (last cached day − 10 days lookback,
//   GA4 data can settle late) through yesterday. --full refetches everything
//   from DATA_START.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { PATTERNS, SCOPES, channelBucket } = require('./patterns');

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8090';
const TABLE = '[GA4-Prod].[GoogleAnalytics4].[GlobalAccessObject]';
const DATA_START = '2026-05-18'; // dashboard epoch (a Monday) — never fetch before this
const LOOKBACK_DAYS = 10;
const ROW_LIMIT = 100000; // overflow guard: hitting it splits the chunk, never truncates silently
const OUT_FILE = path.join(__dirname, '..', 'data', 'cache', 'ctr-dashboard.json');

// ---------- date helpers (all UTC to avoid DST surprises) ----------
const iso = (d) => d.toISOString().slice(0, 10);
const parseDate = (s) => new Date(s + 'T00:00:00Z');
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const mondayOf = (d) => addDays(d, -((d.getUTCDay() + 6) % 7));

function weekChunks(startStr, endStr) {
  const chunks = [];
  let cur = parseDate(startStr);
  const end = parseDate(endStr);
  while (cur <= end) {
    const weekEnd = addDays(mondayOf(cur), 6);
    const chunkEnd = weekEnd < end ? weekEnd : end;
    chunks.push([iso(cur), iso(chunkEnd)]);
    cur = addDays(chunkEnd, 1);
  }
  return chunks;
}

// ---------- engine ----------
// node:http instead of fetch — undici enforces a 300s headers timeout, and the
// broader GA4 pulls can legitimately run longer than that.
function engine(pathname, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(ENGINE_URL + pathname, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`engine ${pathname} -> ${res.statusCode}: ${text.slice(0, 300)}`));
        } else {
          try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const query = (sql) => engine('/query', { method: 'POST', body: JSON.stringify({ sql }) });

// Connect AI occasionally times out at the cloud layer on slow GA4 reports —
// retry a couple of times before giving up on the whole run.
async function queryRetry(sql, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await query(sql);
    } catch (err) {
      if (i >= tries) throw err;
      console.log(`  retry ${i}/${tries - 1} after error: ${err.message.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 20000));
    }
  }
}

async function ensureAuth() {
  const status = await engine('/auth/status');
  if (status.authenticated) return;
  console.log('Engine not authenticated — triggering /auth/login (may open a browser)...');
  const login = await engine('/auth/login', { method: 'POST' });
  if (!login.authenticated) throw new Error('Connect Engine sign-in failed');
}

// ---------- SQL ----------
// Direct traffic from China/Singapore is excluded from sessions (and therefore
// from both the All and Direct buckets). Per spec this does NOT apply to events.
const CN_SG_FILTER = "AND NOT ([sessionDefaultChannelGroup] = 'Direct' AND [country] IN ('China', 'Singapore'))";

// IMPORTANT: [StartDate]/[EndDate] pseudo-columns set the actual GA4 API fetch
// window. Plain [date] >= filters are only applied client-side within the
// driver's default window (~last 30 days) — historical dates silently return
// nothing that way.
const sessionsSql = (scope, s, e) =>
  `SELECT [date], [pagePath], [sessionDefaultChannelGroup], [engagedSessions] FROM ${TABLE} ` +
  `WHERE ${scope.where} AND [StartDate] = '${s}' AND [EndDate] = '${e}' ${CN_SG_FILTER} LIMIT ${ROW_LIMIT}`;

// Events are auto-discovered: everything matching cc_ai_% plus all_button_clicks.
// Two separate queries — prefix LIKE and exact = both push down to the GA4 API,
// but OR-ing them together would force a full-property scan (see ga4 quirks).
const eventsSqlLike = (scope, s, e) =>
  `SELECT [date], [pagePath], [eventName], [sessionDefaultChannelGroup], [eventCount] FROM ${TABLE} ` +
  `WHERE ${scope.where} AND [StartDate] = '${s}' AND [EndDate] = '${e}' ` +
  `AND [eventName] LIKE 'cc_ai_%' LIMIT ${ROW_LIMIT}`;

const eventsSqlClicks = (scope, s, e) =>
  `SELECT [date], [pagePath], [eventName], [sessionDefaultChannelGroup], [eventCount] FROM ${TABLE} ` +
  `WHERE ${scope.where} AND [StartDate] = '${s}' AND [EndDate] = '${e}' ` +
  `AND [eventName] = 'all_button_clicks' LIMIT ${ROW_LIMIT}`;

// Fetch one scope for one date range; split the range if the row cap is hit.
async function fetchScope(scopeId, s, e, out) {
  const scope = SCOPES[scopeId];
  const sess = await queryRetry(sessionsSql(scope, s, e));
  const evLike = await queryRetry(eventsSqlLike(scope, s, e));
  const evClicks = await queryRetry(eventsSqlClicks(scope, s, e));
  const ev = { rowCount: evLike.rowCount + evClicks.rowCount, rows: [...evLike.rows, ...evClicks.rows] };
  if (sess.rowCount >= ROW_LIMIT || evLike.rowCount >= ROW_LIMIT || evClicks.rowCount >= ROW_LIMIT) {
    if (s === e) throw new Error(`row cap hit on a single day (${scopeId} ${s}) — raise ROW_LIMIT`);
    const mid = iso(addDays(parseDate(s), Math.floor((parseDate(e) - parseDate(s)) / 86400000 / 2)));
    console.log(`  ${scopeId} ${s}..${e}: row cap hit, splitting`);
    await fetchScope(scopeId, s, mid, out);
    await fetchScope(scopeId, iso(addDays(parseDate(mid), 1)), e, out);
    return;
  }
  aggregate(scopeId, sess.rows, ev.rows, out);
  console.log(`  ${scopeId} ${s}..${e}: ${sess.rowCount} session rows, ${ev.rowCount} event rows`);
}

// ---------- aggregation ----------
const compiled = PATTERNS.map((p) => ({
  ...p,
  allEvents: [...p.events, ...p.extraEvents],
  re: new RegExp(p.regex),
  exRe: p.excludeRegex ? new RegExp(p.excludeRegex) : null,
}));

const zero = () => ({ all: 0, paid: 0, organic: 0, direct: 0 });

function day(out, patternId, date) {
  const days = (out[patternId] ??= {});
  return (days[date] ??= { s: zero(), e: {} });
}

// Japanese pages (/jp/ anywhere in the path) are excluded from every analysis
// — per Christof's spec. Currently none appear inside our scopes (verified
// 2026-08-17: /ai/jp/, /drivers/jp/ and /jp/* are empty in this property);
// this guard keeps it that way if that ever changes.
const isJapanese = (pagePath) => pagePath.includes('/jp/');

function aggregate(scopeId, sessionRows, eventRows, out) {
  // a pattern may aggregate from several scopes (e.g. the all-Connect-AI view)
  const patterns = compiled.filter((p) => p.scopes.includes(scopeId));
  for (const row of sessionRows) {
    if (isJapanese(row.pagePath)) continue;
    const n = Number(row.engagedSessions) || 0;
    if (!n) continue;
    const bucket = channelBucket(row.sessionDefaultChannelGroup);
    for (const p of patterns) {
      if (!p.re.test(row.pagePath) || (p.exRe && p.exRe.test(row.pagePath))) continue;
      const d = day(out, p.id, row.date);
      d.s.all += n;
      if (bucket !== 'other') d.s[bucket] += n;
    }
  }
  for (const row of eventRows) {
    if (isJapanese(row.pagePath)) continue;
    const n = Number(row.eventCount) || 0;
    if (!n) continue;
    const bucket = channelBucket(row.sessionDefaultChannelGroup);
    for (const p of patterns) {
      // no per-pattern event list — the SQL already restricts to cc_ai_% +
      // all_button_clicks, and every matching event is attributed to the pattern
      if (!p.re.test(row.pagePath) || (p.exRe && p.exRe.test(row.pagePath))) continue;
      const d = day(out, p.id, row.date);
      const ev = (d.e[row.eventName] ??= zero());
      ev.all += n;
      if (bucket !== 'other') ev[bucket] += n;
    }
  }
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };

  const yesterday = iso(addDays(new Date(), -1));
  const endDate = arg('--end') || yesterday;

  let existing = null;
  if (fs.existsSync(OUT_FILE) && !args.includes('--full')) {
    existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  }

  let startDate = arg('--start');
  if (!startDate) {
    startDate = existing
      ? iso(addDays(parseDate(existing.endDate), -LOOKBACK_DAYS))
      : DATA_START;
  }
  if (startDate < DATA_START) startDate = DATA_START;
  if (startDate > endDate) {
    console.log(`Nothing to fetch (start ${startDate} > end ${endDate}).`);
    return;
  }

  // Scope selection: default = light scopes only (daily runs). --heavy adds the
  // weekly-flagged scopes (the Monday task). --only a,b fetches exactly those
  // scopes (backfills) — it must cover ALL scopes of a pattern for that
  // pattern's data to be refreshed (partially fetched patterns are left as-is).
  const heavy = args.includes('--heavy');
  const only = arg('--only');
  const runScopes = Object.keys(SCOPES).filter((id) =>
    only ? only.split(',').includes(id) : (heavy || !SCOPES[id].weekly));
  const skipped = Object.keys(SCOPES).filter((id) => !runScopes.includes(id));
  if (skipped.length) console.log(`Skipping scopes this run: ${skipped.join(', ')}`);

  console.log(`Fetching ${startDate} → ${endDate} (${existing ? 'incremental' : 'full backfill'})`);
  await ensureAuth();

  const fetched = {};
  for (const [s, e] of weekChunks(startDate, endDate)) {
    console.log(`Chunk ${s} → ${e}`);
    for (const scopeId of runScopes) {
      await fetchScope(scopeId, s, e, fetched);
    }
  }

  // Sanity guard: GA4 quota exhaustion (HTTP 429) can yield EMPTY result sets
  // without an error. If the whole fetch produced no data at all, abort rather
  // than overwrite a good snapshot with zeros.
  const fetchedDays = Object.values(fetched).reduce((a, days) => a + Object.keys(days).length, 0);
  if (fetchedDays === 0) {
    throw new Error('fetch returned no data at all — likely GA4 quota exhaustion (silent empty results); snapshot NOT overwritten, retry later');
  }

  // Merge: fetched dates replace existing ones wholesale; older dates survive.
  // Patterns whose scopes were not ALL fetched this run keep their existing
  // data untouched (e.g. the weekly-only KB pattern on a daily run).
  const data = {};
  for (const p of PATTERNS) {
    data[p.id] = { ...(existing?.data?.[p.id] ?? {}) };
    if (!p.scopes.every((sc) => runScopes.includes(sc))) continue;
    for (const date of Object.keys(data[p.id])) {
      if (date >= startDate && date <= endDate) delete data[p.id][date];
    }
    Object.assign(data[p.id], fetched[p.id] ?? {});
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    startDate: existing && existing.startDate < startDate ? existing.startDate : startDate,
    endDate: existing && existing.endDate > endDate ? existing.endDate : endDate,
    data,
  };

  // carry the Salesforce trials section over — it's maintained by
  // fetch-trials.js and refreshed below, independent of the GA4 merges
  if (existing?.trials) {
    snapshot.trials = existing.trials;
    snapshot.trialsUpdatedAt = existing.trialsUpdatedAt;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(snapshot));
  console.log(`Wrote ${OUT_FILE} (${snapshot.startDate} → ${snapshot.endDate})`);

  // started trials from Salesforce (Entry_Attribution__c) — non-fatal: a
  // Salesforce hiccup must not fail the GA4 refresh, old trials stay in place
  try {
    await require('./fetch-trials').updateSnapshot();
  } catch (err) {
    console.error('Trials refresh failed (keeping previous trials):', err.message);
  }

  require('./export').build(); // keep the standalone HTML artifact in sync
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
