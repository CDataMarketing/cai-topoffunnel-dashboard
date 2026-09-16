#!/usr/bin/env node
'use strict';
// Builds a self-contained HTML artifact of the dashboard: the UI with the
// current data snapshot embedded, openable in any browser without the server
// or the Connect Engine. Output goes to data/cache/ (real data — gitignored).

const fs = require('fs');
const path = require('path');
const { PATTERNS } = require('./patterns');

const DATA_FILE = path.join(__dirname, '..', 'data', 'cache', 'ctr-dashboard.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'cache', 'ai-ctr-dashboard.html');

function build() {
  const snapshot = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  let experiments = [];
  try { experiments = JSON.parse(fs.readFileSync(path.join(__dirname, 'experiments.json'), 'utf8')); } catch {}
  let funnelIntents = null;
  try { funnelIntents = JSON.parse(fs.readFileSync(path.join(__dirname, 'funnel-intents.json'), 'utf8')); } catch {}
  const payload = {
    patterns: PATTERNS.map(({ id, label, regex, excludeRegex, events, extraEvents, presetRanges, example }) => ({ id, label, regex, excludeRegex, events, extraEvents, presetRanges, example })),
    snapshot,
    experiments,
    funnelIntents,
  };
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  // <-escape so no `</script>` sequence can terminate the embed block
  const embed = `<script>window.__EMBEDDED__ = ${JSON.stringify(payload).replace(/</g, '\\u003c')};</script>`;
  const out = html.replace('<!-- EMBED_DATA -->', embed);
  if (!out.includes('window.__EMBEDDED__')) throw new Error('EMBED_DATA placeholder not found in index.html');
  fs.writeFileSync(OUT_FILE, out);
  console.log(`Wrote ${OUT_FILE}`);
  return OUT_FILE;
}

if (require.main === module) build();
module.exports = { build };
