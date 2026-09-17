'use strict';
// Serves the AI CTR dashboard: static UI + the aggregated GA4 snapshot.
// Data comes exclusively from data/cache/ctr-dashboard.json (written by
// fetch-data.js) — this server never queries GA4 itself.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { execFile, spawn } = require('child_process');
const { PATTERNS, channelBucket } = require('./patterns');

const app = express();
const PORT = process.env.CTR_PORT || 3010;
const DATA_FILE = path.join(__dirname, '..', 'data', 'cache', 'ctr-dashboard.json');
const EXPERIMENTS_FILE = path.join(__dirname, 'experiments.json');
const FUNNEL_INTENTS_FILE = path.join(__dirname, 'funnel-intents.json');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// allow the file:// bookmark artifact to trigger refreshes against this server
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function readExperiments() {
  try { return JSON.parse(fs.readFileSync(EXPERIMENTS_FILE, 'utf8')); } catch { return []; }
}

// Web-experiments list: maintained through the UI, persisted next to the app
app.post('/api/experiments', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected an array' });
  fs.writeFileSync(EXPERIMENTS_FILE, JSON.stringify(req.body, null, 2));
  res.json({ ok: true, count: req.body.length });
});

app.get('/api/data', (req, res) => {
  let snapshot = null;
  try {
    snapshot = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    // no snapshot yet — UI shows an empty state
  }
  res.json({
    patterns: PATTERNS.map(({ id, label, regex, excludeRegex, events, extraEvents, presetRanges, example }) => ({ id, label, regex, excludeRegex, events, extraEvents, presetRanges, example })),
    snapshot,
    experiments: readExperiments(),
    funnelIntents: (() => { try { return JSON.parse(fs.readFileSync(FUNNEL_INTENTS_FILE, 'utf8')); } catch { return null; } })(),
  });
});

// Manual refresh (the Monday 11:00 scheduled task runs fetch-data.js directly).
const refreshState = { running: false, step: null, lastFinished: null, lastError: null };

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8090';
const ENGINE_DIR = path.join(__dirname, '..', '..', '..', 'engine');

function engineHealthy() {
  return new Promise((resolve) => {
    const req = require('http').get(ENGINE_URL + '/health', { timeout: 2000 }, (r) => {
      r.resume();
      resolve(r.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// the refresh button must work even when the Connect Engine isn't running:
// start it on demand (fetch-data.js then signs in via the cached OAuth token)
async function ensureEngine() {
  if (await engineHealthy()) return;
  refreshState.step = 'starting Connect Engine';
  console.log('[refresh] engine down — starting it');
  const child = spawn('java',
    ['-cp', 'target/classes;lib/cdata.jdbc.connect.jar;lib/json.jar', 'com.cdata.hackathon.engine.Main'],
    { cwd: ENGINE_DIR, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await engineHealthy()) return;
  }
  throw new Error('Connect Engine did not come up within 30s — check Java and engine/target/classes');
}

app.post('/api/refresh', (req, res) => {
  if (refreshState.running) return res.status(409).json(refreshState);
  refreshState.running = true;
  refreshState.lastError = null;
  res.status(202).json(refreshState);

  (async () => {
    await ensureEngine();
    refreshState.step = 'fetching GA4 data';
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [path.join(__dirname, 'fetch-data.js')], { timeout: 60 * 60 * 1000 },
        (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).slice(0, 500))) : resolve());
    });
  })()
    .then(() => { refreshState.lastError = null; })
    .catch((err) => { refreshState.lastError = err.message; })
    .finally(() => {
      refreshState.running = false;
      refreshState.step = null;
      refreshState.lastFinished = new Date().toISOString();
      console.log('[refresh]', refreshState.lastError ? 'FAILED: ' + refreshState.lastError : 'ok');
    });
});

app.get('/api/refresh', (req, res) => res.json(refreshState));

// ---- single-page lookup (local only) ---------------------------------------
// Live GA4 numbers for ONE /ai/connect/ page, strictly on request. Results are
// cached per day under data/cache/page-lookup/, so repeat lookups cost no GA4
// quota. The published artifact never reaches these endpoints — the lookup
// panel in the UI only appears where this server responds.
const GA4_TABLE = '[GA4-Prod].[GoogleAnalytics4].[GlobalAccessObject]';
const LOOKUP_START = '2026-05-18'; // dashboard epoch, same as fetch-data.js
const LOOKUP_CACHE = path.join(__dirname, '..', 'data', 'cache', 'page-lookup');

function engineQuery(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ sql });
    const req = require('http').request(ENGINE_URL + '/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          j.error ? reject(new Error(j.error)) : resolve(j.rows || []);
        } catch { reject(new Error('bad engine response: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const yesterdayISO = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const readCache = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeCache = (file, data) => { fs.mkdirSync(LOOKUP_CACHE, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };

// slug inventory: every /ai/connect/ page seen in the last 90 days, split into
// datasource and LLM slugs (page shape <ds>-to-<llm>/ — split at the LAST
// "-to-"; single-segment pages land in `singles`). Cached per day.
app.get('/api/page-slugs', async (req, res) => {
  try {
    const end = yesterdayISO();
    const cacheFile = path.join(LOOKUP_CACHE, `slugs-${end}.json`);
    const cached = readCache(cacheFile);
    if (cached) return res.json(cached);
    await ensureEngine();
    const start = new Date(Date.parse(end) - 89 * 864e5).toISOString().slice(0, 10);
    const rows = await engineQuery(
      `SELECT [pagePath], [engagedSessions] FROM ${GA4_TABLE} ` +
      `WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' AND [pagePath] LIKE '/ai/connect/%' LIMIT 100000`);
    const ds = new Set(), llm = new Set(), singles = new Set();
    for (const r of rows) {
      const m = /^\/ai\/connect\/([a-z0-9-]+)\/$/.exec(String(r.pagePath));
      if (!m) continue;
      const slug = m[1];
      const i = slug.lastIndexOf('-to-');
      if (i > 0) { ds.add(slug.slice(0, i)); llm.add(slug.slice(i + 4)); }
      else singles.add(slug);
    }
    const out = { end, ds: [...ds].sort(), llm: [...llm].sort(), singles: [...singles].sort() };
    writeCache(cacheFile, out);
    res.json(out);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// full-range daily numbers for one page (same day shape as the snapshot)
app.get('/api/page-lookup', async (req, res) => {
  try {
    const ds = String(req.query.ds || '').trim().toLowerCase();
    const llm = String(req.query.llm || '').trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(ds) || (llm && !/^[a-z0-9-]+$/.test(llm)))
      return res.status(400).json({ error: 'invalid slug' });
    const pagePath = `/ai/connect/${ds}${llm ? '-to-' + llm : ''}/`;
    const end = yesterdayISO();
    const cacheFile = path.join(LOOKUP_CACHE, `${ds}${llm ? '-to-' + llm : ''}-${end}.json`);
    const cached = readCache(cacheFile);
    if (cached) return res.json(cached);
    await ensureEngine();
    const zero = () => ({ all: 0, paid: 0, organic: 0, direct: 0 });
    const days = {};
    const day = (date) => (days[date] ??= { s: zero(), e: {} });
    // same China/Singapore Direct exclusion as fetch-data.js (sessions only)
    const sess = await engineQuery(
      `SELECT [date], [sessionDefaultChannelGroup], [engagedSessions] FROM ${GA4_TABLE} ` +
      `WHERE [StartDate] = '${LOOKUP_START}' AND [EndDate] = '${end}' AND [pagePath] = '${pagePath}' ` +
      "AND NOT ([sessionDefaultChannelGroup] = 'Direct' AND [country] IN ('China', 'Singapore')) LIMIT 100000");
    for (const r of sess) {
      const n = Number(r.engagedSessions) || 0;
      if (!n) continue;
      const d = day(String(r.date).slice(0, 10));
      const b = channelBucket(r.sessionDefaultChannelGroup);
      d.s.all += n;
      if (b !== 'other') d.s[b] += n;
    }
    const evRows = [
      ...await engineQuery(
        `SELECT [date], [eventName], [sessionDefaultChannelGroup], [eventCount] FROM ${GA4_TABLE} ` +
        `WHERE [StartDate] = '${LOOKUP_START}' AND [EndDate] = '${end}' AND [pagePath] = '${pagePath}' AND [eventName] LIKE 'cc_ai_%' LIMIT 100000`),
      ...await engineQuery(
        `SELECT [date], [eventName], [sessionDefaultChannelGroup], [eventCount] FROM ${GA4_TABLE} ` +
        `WHERE [StartDate] = '${LOOKUP_START}' AND [EndDate] = '${end}' AND [pagePath] = '${pagePath}' AND [eventName] = 'all_button_clicks' LIMIT 100000`),
    ];
    for (const r of evRows) {
      const n = Number(r.eventCount) || 0;
      if (!n) continue;
      const d = day(String(r.date).slice(0, 10));
      const b = channelBucket(r.sessionDefaultChannelGroup);
      const e = (d.e[r.eventName] ??= zero());
      e.all += n;
      if (b !== 'other') e[b] += n;
    }
    const out = { pagePath, start: LOOKUP_START, end, days };
    writeCache(cacheFile, out);
    res.json(out);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

const listener = app.listen(PORT, () => console.log(`AI CTR dashboard: http://localhost:${PORT}`));
listener.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // another instance (e.g. the auto-start one) is already serving — that's fine
    console.log(`AI CTR dashboard already running on port ${PORT} — exiting.`);
    process.exit(0);
  }
  throw err;
});
