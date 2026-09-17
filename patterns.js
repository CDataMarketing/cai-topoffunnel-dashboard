'use strict';
// URL pattern + event definitions for the AI CTR dashboard.
// Each pattern belongs to a fetch "scope" (one SQL page filter shared by several
// patterns); the regex decides client-side which rows belong to the pattern.

const LLM_SLUGS = '(agentforce|claude|chatgpt|gemini|langchain|copilot|openai|servicenow|crewai|gumloop|n8n)';

// Scopes = the actual SQL page filters sent to GA4 (via the Connect Engine).
// Only exact `=` and prefix LIKE push down to the GA4 API — anything fancier
// (OR, mid-string wildcards) makes the driver scan the whole property and can
// run for many minutes. The regex trims the broader LIKE down client-side.
const SCOPES = {
  home: { where: "[pagePath] = '/'" },
  // all of /ai/* — serves the exact-/ai/ pattern, every /ai/connect/ pattern,
  // and the all-Connect-AI aggregate (prefix LIKE pushes down fine)
  ai: { where: "[pagePath] LIKE '/ai/%'" },
  // broad prefix (mid-string wildcards don't push down); regexes trim to /mcp/ + /cloud/
  drivers: { where: "[pagePath] LIKE '/drivers/%'" },
  data_access: { where: "[pagePath] LIKE '/data/access/%'" },
  // heavy KB scopes — fetched only by runs with --heavy (the Monday task) or an
  // explicit --only. /kb/tech/ alone spans 200k+ generated paths; pulling it
  // daily would swamp the shared GA4 quota.
  kb_articles: { where: "[pagePath] LIKE '/kb/articles/%'", weekly: true },
  kb_tech: { where: "[pagePath] LIKE '/kb/tech/%'", weekly: true },
};

const PATTERNS = [
  {
    id: 'home',
    example: 'https://www.cdata.com/',
    label: '/ (Homepage)',
    scope: 'home',
    regex: '^/(\\?.*)?$',
    events: ['cc_ai_claude_app', 'cc_ai_chatgpt_app', 'cc_ai_gemini_app', 'cc_ai_copilot_app', 'cc_ai_free_trial'],
  },
  {
    id: 'ai',
    example: 'https://www.cdata.com/ai/',
    label: '/ai/',
    scope: 'ai',
    regex: '^/ai/(\\?.*)?$',
    events: ['cc_ai_claude_trial', 'cc_ai_chatgpt_trial', 'cc_ai_gemini_trial', 'cc_ai_copilot_trial', 'cc_ai_openai_trial', 'cc_ai_free_trial'],
  },
  {
    // aggregate across every Connect AI funnel page: all of /ai/* plus the
    // driver MCP + Cloud + PowerBI pages — one traffic-mix/CTR view of
    // everything that links to the Connect AI free trial and/or product tour
    id: 'connect-ai-all',
    example: 'https://www.cdata.com/ai/',
    label: 'All Connect AI pages (/ai/* + /drivers/[ds]/mcp|cloud|powerbi/)',
    scopes: ['ai', 'drivers'],
    regex: '^/(ai/.*|drivers/(mysql|office365|qbonline|xero)/powerbi/(\\?.*)?|drivers/[^/]+/(mcp|cloud)/(\\?.*)?)$',
    events: [],
  },
  {
    // same aggregate without the /drivers/ pages: everything under /ai/ only
    id: 'ai-all',
    example: 'https://www.cdata.com/ai/',
    label: 'All /ai/* pages (without /drivers/)',
    scope: 'ai',
    regex: '^/ai/.*$',
    events: [],
  },
  {
    id: 'ai-connect-llm',
    example: 'https://www.cdata.com/ai/connect/claude/',
    label: '/ai/connect/[LLM]/',
    scope: 'ai',
    regex: `^/ai/connect/${LLM_SLUGS}/(\\?.*)?$`,
    events: ['cc_ai_product_tour', 'cc_ai_free_trial'],
  },
  {
    id: 'ai-connect-datasource',
    example: 'https://www.cdata.com/ai/connect/salesforce/',
    label: '/ai/connect/[datasource]/',
    scope: 'ai',
    // All single-segment pages without hyphens, minus the LLM pages.
    regex: '^/ai/connect/[^/\\-]+/(\\?.*)?$',
    excludeRegex: `^/ai/connect/${LLM_SLUGS}/(\\?.*)?$`,
    events: ['cc_ai_product_tour', 'cc_ai_free_trial'],
  },
  {
    id: 'ai-connect-sap-datasource',
    example: 'https://www.cdata.com/ai/connect/sapbusinessone/',
    label: '/ai/connect/[SAPdatasource]/',
    scope: 'ai',
    // the 14 SAP-technology datasource pages served by Connect AI (per Christof,
    // 2026-09-01) — basis of the "Other SAP Technologies" experiment
    regex: '^/ai/connect/(sapbusinessone|sapbusinessobjectsbi|saphybris|concur|saparibaprocurement|saparibasource|sapbydesign|sapfieldglass|sapgateway|saphana|sapsuccessfactors|sapsuccessfactorslms|sybase|sybaseiq)/(\\?.*)?$',
    events: ['cc_ai_product_tour', 'cc_ai_free_trial'],
  },
  {
    id: 'ai-connect-ds-to-llm',
    example: 'https://www.cdata.com/ai/connect/salesforce-to-claude/',
    label: '/ai/connect/[datasource]-to-[LLM]/',
    scope: 'ai',
    regex: '^/ai/connect/[^/]+-to-[^/]+/(\\?.*)?$',
    events: ['cc_ai_product_tour', 'cc_ai_free_trial'],
    // Experiment evaluation periods for this (and every) pattern come from
    // ctr-dashboard/experiments.json — maintained in the Web experiments tab.
  },
  {
    id: 'ai-connect-main',
    example: 'https://www.cdata.com/ai/connect/',
    label: '/ai/connect/ (main page)',
    scope: 'ai',
    regex: '^/ai/connect/(\\?.*)?$',
    events: ['cc_ai_main_page'],
  },
  {
    id: 'ai-connect-sf-to-claude',
    example: 'https://www.cdata.com/ai/connect/salesforce-to-claude/',
    label: '/ai/connect/salesforce-to-claude/',
    scope: 'ai',
    regex: '^/ai/connect/salesforce-to-claude/(\\?.*)?$',
    events: ['cc_ai_free_trial', 'cc_ai_product_tour'],
  },
  {
    id: 'ai-connect-top15-to-claude',
    example: 'https://www.cdata.com/ai/connect/qbonline-to-claude/',
    label: '/ai/connect/[top15]-to-claude/',
    scope: 'ai',
    regex: '^/ai/connect/(qbonline|sql|github|shopify|athena|workday|odata|bigquery|servicenow|sapbusinessone|kintone|pardot|saphana|adobeanalytics|intacct)-to-claude/(\\?.*)?$',
    events: ['cc_ai_free_trial', 'cc_ai_product_tour'],
  },
  {
    id: 'ai-connect-top16-to-claude',
    example: 'https://www.cdata.com/ai/connect/salesforce-to-claude/',
    label: '/ai/connect/[top16]-to-claude/ (incl. salesforce)',
    scope: 'ai',
    regex: '^/ai/connect/(salesforce|qbonline|sql|github|shopify|athena|workday|odata|bigquery|servicenow|sapbusinessone|kintone|pardot|saphana|adobeanalytics|intacct)-to-claude/(\\?.*)?$',
    events: ['cc_ai_free_trial', 'cc_ai_product_tour'],
  },
  {
    id: 'ai-connect-top25-to-claude',
    example: 'https://www.cdata.com/ai/connect/salesforce-to-claude/',
    label: '/ai/connect/[top25]-to-claude/',
    scope: 'ai',
    // the 25 X+Y-to-Claude pages of the "How-it-works" experiment (per
    // Christof, 2026-09-10)
    regex: '^/ai/connect/(salesforce|sql|servicenow|snowflake|workday|qbonline|sapbusinessone|kintone|msplanner|office365|netsuite|jira|dynamics365|shopify|facebook|odoo|mysql|databricks|concur|postgresql|adp|saphana|intacct|sharepoint|acumatica)-to-claude/(\\?.*)?$',
    events: ['cc_ai_free_trial', 'cc_ai_product_tour'],
  },
  {
    id: 'ai-lp-campaign',
    example: 'https://www.cdata.com/ai/lp/claude-linkedin-ads/',
    label: '/ai/lp/[campaign-slug]/',
    scope: 'ai',
    // campaign landing pages (per Christof, 2026-09-16) — any single slug, so
    // newly launched campaigns show up automatically
    regex: '^/ai/lp/[^/]+/(\\?.*)?$',
    events: [],
  },
  {
    id: 'ai-integrations-llm',
    example: 'https://www.cdata.com/ai/integrations/anthropic/',
    label: '/ai/integrations/[LLM]/',
    scope: 'ai',
    // provider slugs (anthropic, openai, microsoft, google, databricks, n8n, …):
    // any single segment, so newly launched providers show up automatically
    regex: '^/ai/integrations/[^/]+/(\\?.*)?$',
    events: [],
  },
  {
    id: 'ai-capabilities',
    example: 'https://www.cdata.com/ai/capabilities/data-access/',
    label: '/ai/capabilities/[capability]/',
    scope: 'ai',
    // capability slugs (data-access, governance, agent-tooling, security, …):
    // any single segment, so newly launched capability pages show up automatically
    regex: '^/ai/capabilities/[^/]+/(\\?.*)?$',
    events: [],
  },
  {
    id: 'data-access-ds-to-consumer',
    example: 'https://www.cdata.com/data/access/salesforce-to-microsoft-power-bi-service/',
    label: '/data/access/[datasource]-to-[dataconsumer]/',
    scope: 'data_access',
    regex: '^/data/access/[^/]+-to-[^/]+/(\\?.*)?$',
    events: [],
  },
  {
    id: 'kb-connect-ai',
    example: 'https://www.cdata.com/kb/tech/postgresql-cloud-claude.rst',
    label: '/kb/ Connect AI pages (updated weekly)',
    scopes: ['kb_articles', 'kb_tech'],
    // All Connect AI-related KB pages by slug convention: the hand-written
    // articles (connect-ai-*, know-llm-*, connect-cloud-*) plus the generated
    // how-to matrix ([source]-cloud-*). MCP KB content (tech -mcp- pages,
    // articles mcp-*) is deliberately EXCLUDED — it covers the downloadable
    // on-premise MCP drivers, not Connect AI (per Christof, 2026-09-08). Both
    // scopes are weekly-only, so this pattern's numbers refresh Mondays.
    // No cc_ai_* events fire on /kb/ pages → all_button_clicks fallback CTR.
    regex: '^/kb/(articles/(connect-ai-|know-llm-|connect-cloud-)[^/]+|tech/[^/]+-cloud-[^/]+)$',
    events: [],
  },
  {
    id: 'drivers-ds-mcp',
    example: 'https://www.cdata.com/drivers/salesforce/mcp/',
    label: '/drivers/[datasource]/mcp/',
    scope: 'drivers',
    regex: '^/drivers/[^/]+/mcp/(\\?.*)?$',
    events: [],
  },
  {
    id: 'drivers-ds-powerbi',
    example: 'https://www.cdata.com/drivers/mysql/powerbi/',
    label: '/drivers/[datasource]/powerbi/',
    scope: 'drivers',
    // the 4 PowerBI connector pages (per Christof, 2026-09-11)
    regex: '^/drivers/(mysql|office365|qbonline|xero)/powerbi/(\\?.*)?$',
    events: [],
  },
  {
    id: 'drivers-ds-cloud',
    example: 'https://www.cdata.com/drivers/salesforce/cloud/',
    label: '/drivers/[datasource]/cloud/',
    scope: 'drivers',
    regex: '^/drivers/[^/]+/cloud/(\\?.*)?$',
    events: [],
  },
];

// Tracked for every pattern and shown separately, but NOT part of the CTR
// calculation (CTR = the pattern's stated events / engaged sessions).
const EXTRA_EVENTS = ['all_button_clicks'];
for (const p of PATTERNS) p.extraEvents = EXTRA_EVENTS;

// A pattern may aggregate from several scopes (`scopes: [...]`); normalize.
for (const p of PATTERNS) p.scopes = p.scopes || [p.scope];

// Union of events per scope — one events query per scope covers all its patterns.
for (const scope of Object.values(SCOPES)) scope.events = [];
for (const p of PATTERNS) {
  for (const sc of p.scopes) {
    if (!SCOPES[sc]) continue;
    for (const ev of [...p.events, ...p.extraEvents]) {
      if (!SCOPES[sc].events.includes(ev)) SCOPES[sc].events.push(ev);
    }
  }
}

// sessionDefaultChannelGroup → traffic bucket (same mapping as the weekly-ctr analysis)
const PAID = new Set(['Paid Search', 'Paid Social', 'Display', 'Paid Other', 'Paid Shopping', 'Paid Video']);
const ORGANIC = new Set(['Organic Search', 'Organic Social', 'Organic Video', 'Organic Shopping']);

function channelBucket(group) {
  if (group === 'Direct') return 'direct';
  if (PAID.has(group)) return 'paid';
  if (ORGANIC.has(group)) return 'organic';
  return 'other';
}

module.exports = { PATTERNS, SCOPES, channelBucket };
