'use strict';
// Serves the AI CTR dashboard: static UI + the aggregated GA4 snapshot.
// Data comes exclusively from data/cache/ctr-dashboard.json (written by
// fetch-data.js) — this server never queries GA4 itself.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { execFile, spawn } = require('child_process');
const { PATTERNS } = require('./patterns');

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

const listener = app.listen(PORT, () => console.log(`AI CTR dashboard: http://localhost:${PORT}`));
listener.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // another instance (e.g. the auto-start one) is already serving — that's fine
    console.log(`AI CTR dashboard already running on port ${PORT} — exiting.`);
    process.exit(0);
  }
  throw err;
});
