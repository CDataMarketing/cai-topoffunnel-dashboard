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

// Entry_Attribution__c value -> category for the Trial Attribution tab.
// Website entries (URL paths, the pageless `web` marker and /default.aspx) are
// "traffic-related" and split by the lead's Source_Category traffic bucket;
// app markers and anything else get their own category by marker name.
function entryCategory(raw, bucket) {
  const v = raw.split('|')[0].trim();
  if (v.startsWith('/')) {
    if (v.includes('/jp/')) return null; // dashboard-wide /jp/ exclusion
    return bucket === 'other' ? 'web-other' : bucket;
  }
  if (v === 'web') return bucket === 'other' ? 'web-other' : bucket;
  return v || 'unknown'; // app-mcp, app-gpt, web-local, local-sandbox, …
}

// Spreadsheets-edition and OEM signups are EXCLUDED from every trial number
// (per Christof, 2026-09-21): their CAI account carries PlanType__c
// 'Spreadsheets' or IsOEM__c = true. Two simple-equality queries so the
// filters push down; matched by the account's cloud UUID.
async function fetchExcludedAccounts() {
  const table = '[Salesforce-US-Prod].[Salesforce].[CAI_Account__c]';
  const oem = await query(`SELECT [CAI_AccountID__c] FROM ${table} WHERE [IsOEM__c] = true LIMIT ${ROW_LIMIT}`);
  const sheets = await query(`SELECT [CAI_AccountID__c] FROM ${table} WHERE [PlanType__c] = 'Spreadsheets' LIMIT ${ROW_LIMIT}`);
  return new Set([...oem.rows, ...sheets.rows].map((r) => String(r.CAI_AccountID__c)));
}

async function fetchTrials(excludedAccounts) {
  // no Entry_Attribution filter: signups WITHOUT attribution count toward the
  // "All started trials" total only
  const sql =
    'SELECT [CreatedDate], [Entry_Attribution__c], [Source_Category__c], ' +
    '[Cloud_AccountId__c], [ConvertedAccountId] ' +
    'FROM [Salesforce-US-Prod].[Salesforce].[Lead] ' +
    `WHERE [CreatedDate] >= '${TRIALS_START}' ` +
    `AND [Cloud_AccountId__c] IS NOT NULL LIMIT ${ROW_LIMIT}`;
  const res = await query(sql);
  if (res.rowCount >= ROW_LIMIT) throw new Error('trials row cap hit — raise ROW_LIMIT');

  const trials = {}; // { patternId: { date: { all, paid, organic, direct } } }
  const attribution = {}; // { date: { category: count } } — Trial Attribution tab
  const allTotal = {}; // { date: count } — EVERY non-excluded CAI signup, with or without entry attribution
  const leads = []; // for the opportunity join below
  let attributed = 0, excluded = 0;
  for (const row of res.rows) {
    if (excludedAccounts.has(String(row.Cloud_AccountId__c))) { excluded++; continue; }
    const date = String(row.CreatedDate).slice(0, 10);
    allTotal[date] = (allTotal[date] || 0) + 1;
    if (!row.Entry_Attribution__c) continue; // unattributed — All-started total only
    const rawEntry = String(row.Entry_Attribution__c);
    const bucket = sourceBucket(String(row.Source_Category__c || ''));
    const cat = entryCategory(rawEntry, bucket);
    const p = entryPath(rawEntry);
    const pats = []; // every pattern the entry page matches (incl. aggregates)
    if (p && !p.includes('/jp/')) { // same Japanese-pages exclusion as GA4
      for (const pat of compiled) {
        if (!pat.re.test(p) || (pat.exRe && pat.exRe.test(p))) continue;
        const cell = ((trials[pat.id] ??= {})[date] ??= { all: 0, paid: 0, organic: 0, direct: 0 });
        cell.all++;
        if (bucket !== 'other') cell[bucket]++;
        pats.push(pat.id);
      }
      if (pats.length) attributed++;
    }
    if (cat) {
      (attribution[date] ??= {})[cat] = ((attribution[date] ??= {})[cat] || 0) + 1;
      leads.push({
        date, cat, pats,
        cloudAcct: row.Cloud_AccountId__c ? String(row.Cloud_AccountId__c) : null,
        convAcct: row.ConvertedAccountId ? String(row.ConvertedAccountId) : null,
      });
    }
  }
  console.log(`Trials: ${res.rowCount} CAI signup leads fetched, ${excluded} excluded (Spreadsheets/OEM), ${attributed} matched a URL pattern`);
  return { trials, attribution, allTotal, leads };
}

// Trial -> Opportunity conversion. Opportunities are NOT auto-created by a
// trial: sales opens them on the (converted) account. A trial "converted" if
// a Connect AI new-business opp exists on the lead's converted account with a
// CreatedDate on/after the signup (memory: sfdc-plg-attribution). Each opp is
// attributed to the LATEST signup on the account at or before the opp date.
async function fetchTrialOpps(leads) {
  const opps = await query(
    'SELECT [AccountId], [CreatedDate] FROM [Salesforce-US-Prod].[Salesforce].[Opportunity] ' +
    `WHERE [CreatedDate] >= '${TRIALS_START}' AND [Type] LIKE 'New Business%' AND (` +
    "[Leading_Product__c] IN ('Connect for Analytics', 'Connect MCP') " +
    "OR [Main_Products__c] LIKE '%Connect AI%' OR [Main_Products__c] LIKE '%Connect Cloud%') " +
    `LIMIT ${ROW_LIMIT}`);
  // trial expiry per CAI account — a week's trials are "all ended" once every
  // expiry date lies in the past. Trial__c.CAI_Account__c holds the SFDC
  // record id of CAI_Account__c, while Lead.Cloud_AccountId__c holds the cloud
  // UUID (CAI_Account__c.CAI_AccountID__c) — bridge via the CAI_Account__c table.
  const trialRows = await query(
    'SELECT [CAI_Account__c], [TrialExpiryDate__c] FROM [Salesforce-US-Prod].[Salesforce].[Trial__c] ' +
    `WHERE [Product__c] = 'Cloud' AND [CreatedDate] >= '${TRIALS_START}' ` +
    `AND [CAI_Account__c] IS NOT NULL LIMIT ${ROW_LIMIT}`);
  const caiRows = await query(
    'SELECT [Id], [CAI_AccountID__c] FROM [Salesforce-US-Prod].[Salesforce].[CAI_Account__c] ' +
    `WHERE [CreatedDate] >= '${TRIALS_START}' AND [CAI_AccountID__c] IS NOT NULL LIMIT ${ROW_LIMIT}`);
  const recIdByUuid = new Map(caiRows.rows.map((r) => [String(r.CAI_AccountID__c), String(r.Id)]));

  const leadsByAcct = new Map(); // ConvertedAccountId -> leads (sorted later)
  for (const l of leads) {
    if (!l.convAcct) continue;
    if (!leadsByAcct.has(l.convAcct)) leadsByAcct.set(l.convAcct, []);
    leadsByAcct.get(l.convAcct).push(l);
  }
  const trialOpps = {}; // { leadDate: { category: count } }
  const trialOppsByPattern = {}; // { leadDate: { patternId: count } } — same opp, keyed by the lead's entry URL pattern(s)
  let converted = 0;
  for (const o of opps.rows) {
    const cands = leadsByAcct.get(String(o.AccountId || ''));
    if (!cands) continue;
    const oDate = String(o.CreatedDate).slice(0, 10);
    const lead = cands.filter((l) => l.date <= oDate).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!lead) continue;
    (trialOpps[lead.date] ??= {})[lead.cat] = ((trialOpps[lead.date] ??= {})[lead.cat] || 0) + 1;
    for (const pid of lead.pats || [])
      (trialOppsByPattern[lead.date] ??= {})[pid] = ((trialOppsByPattern[lead.date] ??= {})[pid] || 0) + 1;
    converted++;
  }
  const expiryByAcct = new Map();
  for (const t of trialRows.rows) {
    const acct = String(t.CAI_Account__c), exp = String(t.TrialExpiryDate__c || '').slice(0, 10);
    if (exp && (!expiryByAcct.has(acct) || expiryByAcct.get(acct) < exp)) expiryByAcct.set(acct, exp);
  }
  const trialMaxExpiry = {}; // { leadDate: latest trial expiry among that day's signups }
  for (const l of leads) {
    const recId = l.cloudAcct ? recIdByUuid.get(l.cloudAcct) : null;
    const exp = recId ? expiryByAcct.get(recId) : null;
    if (exp && (!trialMaxExpiry[l.date] || trialMaxExpiry[l.date] < exp)) trialMaxExpiry[l.date] = exp;
  }
  console.log(`Trial opps: ${opps.rowCount} CAI new-business opps fetched, ${converted} attributed to a trial signup`);
  return { trialOpps, trialOppsByPattern, trialMaxExpiry };
}

// merge into the snapshot; keeps existing trials if Salesforce is unreachable
async function updateSnapshot() {
  const snapshot = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  const excludedAccounts = await fetchExcludedAccounts();
  const { trials, attribution, allTotal, leads } = await fetchTrials(excludedAccounts);
  const { trialOpps, trialOppsByPattern, trialMaxExpiry } = await fetchTrialOpps(leads);
  snapshot.trials = trials;
  snapshot.trialAttribution = attribution; // Trial Attribution tab: { date: { category: n } }
  snapshot.trialsAllTotal = allTotal; // { date: n } — all CAI signups incl. unattributed (Spreadsheets/OEM excluded)
  snapshot.trialOpps = trialOpps; // { leadDate: { category: opps } }
  snapshot.trialOppsByPattern = trialOppsByPattern; // { leadDate: { patternId: opps } }
  snapshot.trialMaxExpiry = trialMaxExpiry; // { leadDate: latest trial expiry }
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
