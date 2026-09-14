#!/usr/bin/env node
'use strict';
// Pulls started trials from Salesforce (via the shared Connect Engine) and
// attributes them to the dashboard's URL patterns through the lead-level
// Entry_Attribution__c field. Raw rows stay in this process — they never pass
// through an AI model (root CLAUDE.md Rule 1).
//
// Definition of a started trial: a Lead created on the day in question with
// a Connect AI / Cloud account ([Cloud_AccountId__c] set) and an
// [Entry_Attribution__c] value. The field holds `entry-page-path|token`
// (mirroring Pardot's cloud_ai_attribution_oauth); only the path part is used
// for pattern matching — the token is a static key of the tracking
// integration, identical across users. `/default.aspx` is the IIS default
// document and counts as the homepage `/`. Non-URL markers (`web`,
// `app-mcp`, `app-gpt`, …) match no URL pattern and are ignored here.
//
// Results are merged into data/cache/ctr-dashboard.json as a `trials` section
// ({ patternId: { date: { all, paid, organic, direct } } }, buckets from the
// lead's Source_Category__c) — separate from `data`, so the GA4
// fetch's wholesale per-date merges never touch it. The whole window is
// refetched every run (one cheap query; attribution values can backfill).
//
// Usage: node fetch-trials.js   (standalone: also rebuilds the HTML artifact)

const fs = require('fs');
const path = require('path');
const http = require('http');
const { PATTERNS } = require('./patterns');

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8090';
// Entry_Attribution__c tracking went fully live 2026-09-01 (per Christof,
// 2026-09-14; the data confirms it — Aug shows only a sparse partial ramp of
// 1-18 leads/day vs. 60-107/day from Sep 1). Days before this carry no
// reliable attribution: they are fetched from this date only and the UI
// renders "–" (no data) instead of 0 for earlier days.
const TRIALS_START = '2026-09-01';
const ROW_LIMIT = 100000;
const OUT_FILE = path.join(__dirname, '..', 'data', 'cache', 'ctr-dashboard.json');

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

const compiled = PATTERNS.map((p) => ({
  id: p.id,
  re: new RegExp(p.regex),
  exRe: p.excludeRegex ? new RegExp(p.excludeRegex) : null,
}));

// Salesforce Source_Category__c -> the dashboard's GA4-style traffic buckets.
// Mirrors channelBucket() in patterns.js: Referral and AI Referral map to
// 'other' (GA4 puts Referral / AI Assistant outside paid|organic|direct too),
// as do Events/Outbound categories and unclassified leads — those count in
// the All bucket only. NOTE: trial source classification comes from
// Salesforce, session classification from GA4 — the two usually agree but
// are independent systems, so per-bucket CVRs are approximations.
const PAID_CATS = new Set(['Paid Search', 'Advertising', 'Paid AI', 'Paid Social', 'Paid Shopping', 'Paid Video', 'Display']);
const ORGANIC_CATS = new Set(['Organic Search', 'Organic Social']);
function sourceBucket(category) {
  if (category === 'Direct') return 'direct';
  if (PAID_CATS.has(category)) return 'paid';
  if (ORGANIC_CATS.has(category)) return 'organic';
  return 'other';
}

// Entry_Attribution__c value -> pagePath compatible with the pattern regexes
function entryPath(value) {
  const p = value.split('|')[0].trim();
  if (!p.startsWith('/')) return null;           // non-URL markers: web, app-mcp, …
  if (/^\/default\.aspx$/i.test(p)) return '/';  // IIS default document = homepage
  return p;
}

async function fetchTrials() {
  const sql =
    'SELECT [CreatedDate], [Entry_Attribution__c], [Source_Category__c] ' +
    'FROM [Salesforce-US-Prod].[Salesforce].[Lead] ' +
    `WHERE [CreatedDate] >= '${TRIALS_START}' ` +
    'AND [Entry_Attribution__c] IS NOT NULL ' +
    `AND [Cloud_AccountId__c] IS NOT NULL LIMIT ${ROW_LIMIT}`;
  const res = await query(sql);
  if (res.rowCount >= ROW_LIMIT) throw new Error('trials row cap hit — raise ROW_LIMIT');

  const trials = {}; // { patternId: { date: { all, paid, organic, direct } } }
  let attributed = 0;
  for (const row of res.rows) {
    const p = entryPath(String(row.Entry_Attribution__c || ''));
    if (!p || p.includes('/jp/')) continue; // same Japanese-pages exclusion as GA4
    const date = String(row.CreatedDate).slice(0, 10);
    const bucket = sourceBucket(String(row.Source_Category__c || ''));
    let hit = false;
    for (const pat of compiled) {
      if (!pat.re.test(p) || (pat.exRe && pat.exRe.test(p))) continue;
      const cell = ((trials[pat.id] ??= {})[date] ??= { all: 0, paid: 0, organic: 0, direct: 0 });
      cell.all++;
      if (bucket !== 'other') cell[bucket]++;
      hit = true;
    }
    if (hit) attributed++;
  }
  console.log(`Trials: ${res.rowCount} attribution leads fetched, ${attributed} matched a URL pattern`);
  return trials;
}

// merge into the snapshot; keeps existing trials if Salesforce is unreachable
async function updateSnapshot() {
  const snapshot = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  snapshot.trials = await fetchTrials();
  snapshot.trialsStart = TRIALS_START; // UI: days before this show "–", not 0
  snapshot.trialsUpdatedAt = new Date().toISOString();
  fs.writeFileSync(OUT_FILE, JSON.stringify(snapshot));
  console.log(`Wrote trials into ${OUT_FILE}`);
}

if (require.main === module) {
  updateSnapshot()
    .then(() => require('./export').build())
    .catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
}
module.exports = { updateSnapshot };
