const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PERSIST_FILE = '/tmp/vat_stats.json';
const VERSION = '2.0.40';
const FIRST_DEPLOYED = '2026-04-08T06:05:41Z';
const LIFETIME_CALLS_REDIS_KEY = 'vat:lifetime_calls';
const UPTIME_HEARTBEAT_KEY = 'vat:uptime:heartbeat_count';
const UPTIME_MONITORING_START_KEY = 'vat:uptime:monitoring_started';
const UPTIME_HEARTBEAT_INTERVAL_MS = 60000;
const FLEET_IP24_TTL_SECONDS = 30 * 24 * 60 * 60;
const FLEET_CROSS_SERVER_THRESHOLD = 3;

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OWNER_KEY = process.env.OWNER_KEY || '';
const PORT = process.env.PORT || 3000;
const STATS_KEY = process.env.STATS_KEY || 'ojas2026';
const REDIS_PREFIX = 'vat';
const FREE_TIER_REDIS_KEY = 'vat:free_tier_usage';
const FREE_TIER_LIMIT = 50;
// Caching/staleness policy per tool, in seconds.
const VERDICT_TTL = { validate_vat: 2592000, get_vat_rates: 604800 };
const METERED_SUBSCRIBE_URL = 'https://vat-validator-mcp-production.up.railway.app/subscribe';
const BUNDLE_500_URL = 'https://buy.stripe.com/28EeVceUB06N1ty3teebu0l';
const BUNDLE_2000_URL = 'https://buy.stripe.com/00w14m7s96vb1ty5Bmebu0m';
const ALLOWED_PAYMENT_LINK_IDS = ['plink_1TQz5UD6WvRe6sn3I1GPShmC', 'plink_1TQz6rD6WvRe6sn3mqxD0Gy8'];

const freeTierUsage = new Map();
const usageLog = [];
const toolUsageCounts = {};
const trialExtensions = new Map();
const FREE_TIER_WARNING = 40;
const TRIAL_EXTENSION_CALLS = 10;
const apiKeys = new Map();

const perMinuteUsage = new Map();

function checkPerMinuteLimit(ip, toolName, limit) {
  const minuteKey = ip + ':' + toolName + ':' + new Date().toISOString().slice(0, 16);
  const count = perMinuteUsage.get(minuteKey) || 0;
  if (count >= limit) return false;
  perMinuteUsage.set(minuteKey, count + 1);
  if (perMinuteUsage.size > 10000) {
    const currentMinute = new Date().toISOString().slice(0, 16);
    for (const [key] of perMinuteUsage) {
      if (!key.includes(currentMinute)) perMinuteUsage.delete(key);
    }
  }
  return true;
}

function saveStats() {
  try {
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({
      freeTierUsage: Array.from(freeTierUsage.entries()),
      usageLog: usageLog.slice(-1000),
      toolUsageCounts,
      trialExtensions: Array.from(trialExtensions.entries())
    }));
  } catch(e) { console.error('Stats save error:', e.message); }
}

function loadStats() {
  try {
    if (fs.existsSync(PERSIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
      if (data.freeTierUsage) data.freeTierUsage.forEach(([k, v]) => freeTierUsage.set(k, v));
      if (data.usageLog) usageLog.push(...data.usageLog);
      if (data.toolUsageCounts) Object.assign(toolUsageCounts, data.toolUsageCounts);
      if (data.trialExtensions) data.trialExtensions.forEach(([k, v]) => trialExtensions.set(k, v));
      console.log('Stats loaded: ' + freeTierUsage.size + ' IPs, ' + usageLog.length + ' calls, ' + trialExtensions.size + ' trial extensions');
    }
  } catch(e) { console.error('Stats load error:', e.message); }
}

function getMonthKey(ip) { return ip + ':' + new Date().toISOString().slice(0, 7); }

function getEffectiveLimit(ip) {
  for (const record of trialExtensions.values()) {
    if (record.ip === ip) return FREE_TIER_LIMIT + TRIAL_EXTENSION_CALLS;
  }
  return FREE_TIER_LIMIT;
}

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json();
    if (data.error) console.error('[Redis] redisGet error:', data.error, 'key:', key);
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch(e) { return null; }
}

async function redisSet(key, value) {
  try {
    const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    if (data.error) console.error('[Redis] redisSet error:', data.error, 'key:', key);
  } catch(e) { console.error('[Redis] redisSet failed:', e); }
}

async function redisExpire(key, seconds) {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/expire/${encodeURIComponent(key)}/${seconds}`,
      { method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json();
    if (data.error) console.error('[Redis] redisExpire error:', data.error, 'key:', key);
  } catch(e) { console.error('[Redis] redisExpire failed:', e); }
}

async function redisDelete(key) {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/del/${encodeURIComponent(key)}`,
      { method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json();
    if (data.error) console.error('[Redis] redisDelete error:', data.error, 'key:', key);
  } catch(e) { console.error('[Redis] redisDelete failed:', e); }
}

async function redisIncr(key) {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/incr/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json();
    if (data.error) { console.error('[Redis] redisIncr error:', data.error, 'key:', key); return null; }
    return data.result;
  } catch(e) { console.error('[Redis] redisIncr failed:', e); return null; }
}

// ─── FLEET CROSS-SERVER OPERATOR DETECTION ─────────────────────────────────────
async function recordFleetGateHit(ip) {
  try {
    const ip24 = truncateIp(ip);
    const key = `fleet:ip24:${ip24}:${REDIS_PREFIX}`;
    await redisSet(key, nowISO());
    await redisExpire(key, FLEET_IP24_TTL_SECONDS);
  } catch(e) { console.error('[Fleet] recordFleetGateHit failed:', e); }
}

async function checkFleetCrossServer(ip) {
  try {
    const ip24 = truncateIp(ip);
    const keys = await redisKeys(`fleet:ip24:${ip24}:*`);
    return keys.length;
  } catch(e) { return 0; }
}

async function buildCrossServerNote(ip) {
  const serverCount = await checkFleetCrossServer(ip);
  if (serverCount >= FLEET_CROSS_SERVER_THRESHOLD) {
    return 'Cross-server trial extension available -- this operator is already using ' + serverCount + ' Kord Agencies MCP servers. POST /trial-extension on any one of those servers to extend the trial across all of them.';
  }
  return null;
}

// ─── UPTIME TRACKING (for /public-stats) ───────────────────────────────────────
async function initUptimeTracking() {
  try {
    let started = await redisGet(UPTIME_MONITORING_START_KEY);
    if (!started) {
      started = nowISO();
      await redisSet(UPTIME_MONITORING_START_KEY, started);
    }
    setInterval(() => { redisIncr(UPTIME_HEARTBEAT_KEY).catch(() => {}); }, UPTIME_HEARTBEAT_INTERVAL_MS);
  } catch(e) { console.error('[Uptime] initUptimeTracking failed:', e); }
}

async function appendSessionLog(ip, tool) {
  try {
    const ipSafe = ip.replace(/:/g, '_').replace(/\s/g, '');
    const dayKey = new Date().toISOString().slice(0, 10);
    const key = `${REDIS_PREFIX}:session:${ipSafe}:${dayKey}`;
    const existing = await redisGet(key) || [];
    existing.push({ tool, timestamp: new Date().toISOString() });
    await redisSet(key, existing);
    await redisExpire(key, 86400);
  } catch(e) { console.error('[SessionLog] internal error:', e); }
}

async function redisKeys(pattern) {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/keys/${encodeURIComponent(pattern)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json();
    if (data.error) console.error('[Redis] redisKeys error:', data.error, 'pattern:', pattern);
    return data.result || [];
  } catch(e) { return []; }
}

async function saveKeyToRedis(apiKey, record, prefix) {
  await redisSet(`${prefix}:key:${apiKey}`, record);
}

async function loadApiKeysFromRedis(prefix) {
  const keys = await redisKeys(`${prefix}:key:*`);
  for (const redisKey of keys) {
    const record = await redisGet(redisKey);
    if (record) {
      const apiKey = redisKey.replace(`${prefix}:key:`, '');
      apiKeys.set(apiKey, record);
    }
  }
  console.log(`Loaded ${apiKeys.size} API keys from Redis`);
}

async function loadFreeTierFromRedis() {
  try {
    const data = await redisGet(FREE_TIER_REDIS_KEY);
    if (data && Array.isArray(data)) {
      data.forEach(([k, v]) => freeTierUsage.set(k, v));
      console.log('[FreeTier] Loaded ' + freeTierUsage.size + ' IPs from Redis');
    }
  } catch(e) { console.error('[FreeTier] load failed:', e); }
}

async function saveFreeTierToRedis() {
  try {
    const existing = await redisGet(FREE_TIER_REDIS_KEY) || [];
    const existingMap = new Map(existing);
    for (const [key, value] of freeTierUsage.entries()) {
      const existingCount = existingMap.get(key) || 0;
      existingMap.set(key, Math.max(existingCount, value));
    }
    await redisSet(FREE_TIER_REDIS_KEY, Array.from(existingMap.entries()));
  } catch(e) { console.error('[FreeTier] save failed:', e); }
}

const USAGE_LOG_REDIS_KEY = REDIS_PREFIX + ':usage_log';
const TOOL_USAGE_COUNTS_REDIS_KEY = REDIS_PREFIX + ':tool_usage_counts';

async function loadUsageStatsFromRedis() {
  try {
    const log = await redisGet(USAGE_LOG_REDIS_KEY);
    if (Array.isArray(log)) usageLog.push(...log);
    const counts = await redisGet(TOOL_USAGE_COUNTS_REDIS_KEY);
    if (counts && typeof counts === 'object') Object.assign(toolUsageCounts, counts);
    console.log('[UsageStats] Loaded ' + usageLog.length + ' log entries, ' + Object.keys(toolUsageCounts).length + ' tool counters from Redis');
  } catch(e) { console.error('[UsageStats] load failed:', e); }
}

// Fire-and-forget — redisSet already catches its own errors internally, so
// this never blocks or throws on the calling request path.
function saveUsageStatsToRedis() {
  redisSet(USAGE_LOG_REDIS_KEY, usageLog.slice(-1000)).catch(() => {});
  redisSet(TOOL_USAGE_COUNTS_REDIS_KEY, toolUsageCounts).catch(() => {});
}

// Gate hits (free-tier exhausted, bundle exhausted) return before the normal
// success-path counters run — this makes them visible as EVENTS to
// /daily-report and /stats without touching freeTierUsage/quota logic.
function recordGatedCall(ip, toolName) {
  usageLog.push({ tool: toolName, tier: 'gated', time: new Date().toISOString(), ip: (ip || 'unknown').slice(0, 8) + '...' });
  if (usageLog.length > 1000) usageLog.shift();
  toolUsageCounts[toolName] = (toolUsageCounts[toolName] || 0) + 1;
  saveStats();
  saveUsageStatsToRedis();
  appendSessionLog(ip, toolName).catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));
}

function generateApiKey() { return 'vat_' + crypto.randomBytes(24).toString('hex'); }
function getPlanFromProduct(productName) {
  if (!productName) return 'bundle_500';
  const n = productName.toLowerCase();
  if (n.includes('metered') || n.includes('pay as you go') || n === 'metered') return 'metered';
  if (n.includes('2000') || n.includes('2,000') || n.includes('enterprise')) return 'bundle_2000';
  return 'bundle_500';
}
function nowISO() { return new Date().toISOString(); }

function checkAndResetPeriod(record) {
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  if (Date.now() - record.periodStart > thirtyDays) {
    record.calls = 0;
    record.periodStart = Date.now();
    return true;
  }
  return false;
}

async function reportMeteredUsage(customerId, eventName) {
  try {
    await stripe.billing.meterEvents.create({
      event_name: eventName,
      payload: {
        stripe_customer_id: customerId,
        value: '1'
      }
    });
  } catch(e) {
    console.error('Stripe metered usage report failed:', e.message);
  }
}

async function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: 'VAT Validator MCP <ojas@kordagencies.com>', to: [to], subject, html });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) console.error('[Resend] Email failed: HTTP ' + res.statusCode + ' ' + d);
      resolve({ status: res.statusCode, body: d });
    }); });
    req.on('error', e => { console.error('[Resend] Email network error:', e.message); resolve({ error: e.message }); });
    req.write(body); req.end();
  });
}

function truncateIp(ip) {
  const parts = (ip || '').split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') + '.0' : ip;
}

// Redis-independent circuit breaker for the email paths that remain after
// raw gate-hit emails were removed 2026-07-27 (trial-extension request +
// payment events only). Caps total sends server-wide so a flood of fake
// trial-extension requests can't exhaust the fleet's shared Resend quota
// even if Redis-backed dedup elsewhere is unavailable (Lesson 209).
const EMAIL_CIRCUIT_BREAKER_LIMIT = 20;
let emailBreakerCount = 0;
let emailBreakerWindowStart = Date.now();
function emailCircuitBreakerAllow() {
  const now = Date.now();
  if (now - emailBreakerWindowStart > 3600000) { emailBreakerWindowStart = now; emailBreakerCount = 0; }
  if (emailBreakerCount >= EMAIL_CIRCUIT_BREAKER_LIMIT) return false;
  emailBreakerCount++;
  return true;
}

// One trial extension per IP, ever (2026-08-19). Redis (trial_ext_granted:{ipSafe},
// no TTL) is the authoritative per-IP dedup and survives restarts. This breaker is a
// Redis-independent backstop: even if Redis is unreachable and the dedup check
// silently passes every request, no more than 5 NEW grants can be issued per hour
// per server process.
const TRIAL_GRANT_HOURLY_CAP = 5;
let trialGrantBreakerCount = 0;
let trialGrantBreakerWindowStart = Date.now();
function trialGrantCircuitBreakerAllow() {
  const now = Date.now();
  if (now - trialGrantBreakerWindowStart > 3600000) { trialGrantBreakerWindowStart = now; trialGrantBreakerCount = 0; }
  if (trialGrantBreakerCount >= TRIAL_GRANT_HOURLY_CAP) return false;
  trialGrantBreakerCount++;
  return true;
}

function ipSafeKey(ip) { return String(ip).replace(/:/g, '_').replace(/\s/g, ''); }

async function sendApiKeyEmail(email, apiKey, plan) {
  const planLabel = plan === 'metered' ? 'Pay-as-you-go' : plan === 'bundle_2000' ? 'Bundle 2000' : 'Bundle 500';
  const limitNote = plan === 'metered' ? 'Pay only for what you use — billed monthly' : plan === 'bundle_2000' ? '2,000 calls included' : '500 calls included';
  const html = '<!DOCTYPE html><html><body style="font-family:monospace;background:#080A0F;color:#E8EDF5;padding:40px;max-width:600px;margin:0 auto"><div style="border:1px solid rgba(0,229,195,0.3);border-radius:8px;padding:32px"><div style="color:#00E5C3;font-size:13px;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:24px">VAT Validator MCP - ' + planLabel + '</div><h1 style="font-size:24px;font-weight:700;margin-bottom:8px;color:#FFFFFF">Your API key is ready.</h1><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#5A6478;font-size:11px;text-transform:uppercase;margin-bottom:8px">Your API Key</div><div style="color:#00E5C3;font-size:14px;word-break:break-all">' + apiKey + '</div></div><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#5A6478;font-size:11px;text-transform:uppercase;margin-bottom:8px">MCP Config</div><div style="color:#86EFAC;font-size:12px">{"vat-validator":{"url":"https://vat-validator-mcp-production.up.railway.app","headers":{"x-api-key":"' + apiKey + '"}}}</div></div><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#E8EDF5;font-size:13px">Plan: ' + planLabel + '<br>' + limitNote + '</div></div><div style="background:#0D1219;border-radius:6px;padding:16px;margin-bottom:24px;font-size:11px;color:#5A6478;line-height:1.7">Results are informational only. Verify with a qualified tax advisor. Liability capped at 3 months fees. Full terms: kordagencies.com/terms.html</div><p style="color:#5A6478;font-size:12px">Questions? ojas@kordagencies.com</p></div></body></html>';
  return sendEmail(email, 'Your VAT Validator MCP API Key — ' + planLabel, html);
}

async function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d).content?.[0]?.text || ''); } catch(e) { reject(e); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function validateVIES(countryCode, vatNumber) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'ec.europa.eu',
      path: '/taxation_customs/vies/rest-api/ms/' + countryCode + '/vat/' + vatNumber,
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'VAT-Validator-MCP/1.0' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ source: 'VIES', data: JSON.parse(d) }); }
        catch(e) { resolve({ source: 'VIES', error: 'Parse error' }); }
      });
    });
    req.on('error', e => resolve({ source: 'VIES', error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ source: 'VIES', error: 'Timeout - VIES unavailable, try again later' }); });
    req.end();
  });
}

async function validateABN(abn) {
  return new Promise((resolve) => {
    const clean = abn.replace(/\s/g, '');
    const guid = process.env.ABR_GUID || 'f7b75e2e-6d6a-4c1c-a8d4-5b2e3c9d8f4a';
    const req = https.request({
      hostname: 'abr.business.gov.au',
      path: '/json/?abn=' + clean + '&guid=' + guid,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ source: 'ABR', data: JSON.parse(d) }); }
        catch(e) { resolve({ source: 'ABR', error: 'Parse error' }); }
      });
    });
    req.on('error', e => resolve({ source: 'ABR', error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ source: 'ABR', error: 'Timeout' }); });
    req.end();
  });
}

function detectCountry(vatNumber) {
  const clean = vatNumber.trim().toUpperCase().replace(/\s/g, '');
  if (clean.startsWith('ABN')) return { country: 'AU', type: 'au', number: clean.slice(3) };
  if (clean.startsWith('AU') || /^\d{11}$/.test(clean)) return { country: 'AU', type: 'au', number: clean };
  const euCodes = ['AT','BE','BG','CY','CZ','DE','DK','EE','EL','ES','FI','FR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'];
  for (const code of euCodes) {
    if (clean.startsWith(code)) return { country: code, type: 'eu', number: clean.slice(2) };
  }
  return { country: null, type: 'unknown', number: clean };
}

const LEGAL_DISCLAIMER = 'Results sourced directly from official government VAT registries (EU VIES, Australian ABR). We do not log or store your query content. Results are for informational purposes only and do not constitute legal or tax advice. Operator must independently verify all results with a qualified tax advisor before making compliance decisions. Provider maximum liability is limited to subscription fees paid in the preceding 3 months. Full terms: kordagencies.com/terms.html';

const VAT_RATES = {
  AT:{standard:20,reduced:[10,13],country:'Austria'},BE:{standard:21,reduced:[6,12],country:'Belgium'},
  BG:{standard:20,reduced:[9],country:'Bulgaria'},CY:{standard:19,reduced:[5,9],country:'Cyprus'},
  CZ:{standard:21,reduced:[12],country:'Czech Republic'},DE:{standard:19,reduced:[7],country:'Germany'},
  DK:{standard:25,reduced:[],country:'Denmark'},EE:{standard:22,reduced:[9],country:'Estonia'},
  EL:{standard:24,reduced:[6,13],country:'Greece'},ES:{standard:21,reduced:[4,10],country:'Spain'},
  FI:{standard:25.5,reduced:[10,14],country:'Finland'},FR:{standard:20,reduced:[5.5,10],country:'France'},
  HR:{standard:25,reduced:[5,13],country:'Croatia'},HU:{standard:27,reduced:[5,18],country:'Hungary'},
  IE:{standard:23,reduced:[9,13.5],country:'Ireland'},IT:{standard:22,reduced:[4,5,10],country:'Italy'},
  LT:{standard:21,reduced:[5,9],country:'Lithuania'},LU:{standard:17,reduced:[3,8,14],country:'Luxembourg'},
  LV:{standard:21,reduced:[5,12],country:'Latvia'},MT:{standard:18,reduced:[5,7],country:'Malta'},
  NL:{standard:21,reduced:[9],country:'Netherlands'},PL:{standard:23,reduced:[5,8],country:'Poland'},
  PT:{standard:23,reduced:[6,13],country:'Portugal'},RO:{standard:19,reduced:[5,9],country:'Romania'},
  SE:{standard:25,reduced:[6,12],country:'Sweden'},SI:{standard:22,reduced:[5,9.5],country:'Slovenia'},
  SK:{standard:20,reduced:[10],country:'Slovakia'},GB:{standard:20,reduced:[5],country:'United Kingdom'},
  AU:{standard:10,reduced:[],country:'Australia'}
};

async function executeTool(name, args) {
  if (name === 'validate_vat') {
    const { vat_number, invoice_company_name, invoice_amount } = args;
    const checkedAt = nowISO();

    if (!vat_number) return {
      error: 'vat_number is required',
      agent_action: 'PROVIDE_REQUIRED_FIELD',
      category: 'invalid_input',
      retryable: false,
      retry_after_ms: null,
      fallback_tool: null,
      trace_id: Math.random().toString(36).slice(2, 10)
    };

    const detected = detectCountry(vat_number);
    let valid = false;
    let company_name = null;
    let address = null;
    let jurisdiction = '';
    let sourceUrl = '';

    if (detected.type === 'eu') {
      jurisdiction = 'EU';
      sourceUrl = 'ec.europa.eu/taxation_customs/vies';
      const result = await validateVIES(detected.country, detected.number);
      if (result.error) return {
        error: 'EU VIES portal is temporarily unavailable — this is a known issue with the official EU system, not a problem with the VAT number. Retry in 30 minutes.',
        vat_number,
        jurisdiction,
        agent_action: 'RETRY_IN_30_MIN',
        category: 'upstream_unavailable',
        retryable: true,
        retry_after_ms: 1800000,
        fallback_tool: null,
        trace_id: Math.random().toString(36).slice(2, 10),
        source_url: sourceUrl,
        checked_at: checkedAt,
        _disclaimer: LEGAL_DISCLAIMER
      };
      const d = result.data;
      valid = d.isValid || false;
      company_name = d.traderName || null;
      address = d.traderAddress || null;
    } else if (detected.type === 'au') {
      jurisdiction = 'AU';
      sourceUrl = 'abr.business.gov.au';
      const result = await validateABN(detected.number);
      if (result.error) return {
        error: result.error,
        vat_number,
        jurisdiction,
        agent_action: 'RETRY_IN_2_MIN',
        category: 'upstream_unavailable',
        retryable: true,
        retry_after_ms: 120000,
        fallback_tool: null,
        trace_id: Math.random().toString(36).slice(2, 10),
        source_url: sourceUrl,
        checked_at: checkedAt,
        _disclaimer: LEGAL_DISCLAIMER
      };
      const d = result.data;
      valid = !!(d.Abn && d.AbnStatus === 'Active');
      company_name = d.EntityName || null;
    } else {
      return {
        error: 'Could not detect country. Supported prefixes: EU (AT BE BG CY CZ DE DK EE EL ES FI FR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK), Australia (AU or ABN).',
        vat_number,
        agent_action: 'PROVIDE_COUNTRY_PREFIX',
        category: 'invalid_input',
        retryable: false,
        retry_after_ms: null,
        fallback_tool: null,
        trace_id: Math.random().toString(36).slice(2, 10),
        _disclaimer: LEGAL_DISCLAIMER
      };
    }

    // AI fraud risk analysis — runs internally, result is always returned in one call
    const nameSection = invoice_company_name ? `Invoice Company Name: ${invoice_company_name}\n` : '';
    const amountSection = invoice_amount != null ? `Invoice Amount: ${invoice_amount}\n` : '';
    const prompt = `You are a B2B fraud detection specialist. Analyze this VAT validation result for fraud risk.

VAT Number: ${vat_number}
Jurisdiction: ${jurisdiction}
Valid/Active: ${valid}
Registered Company Name: ${company_name || 'Not available from registry'}
Registered Address: ${address || 'Not available from registry'}
${nameSection}${amountSection}
Analyze for: registration status, jurisdiction risk factors, name mismatch between invoice and registry (if invoice company name provided), address anomalies, shell company indicators, missing trader fraud patterns, recently registered entity risk.

Name match rules: if no invoice_company_name was provided set name_match to "NOT_CHECKED". If provided and registry name unavailable set name_match to "NOT_CHECKED". If both available compare them: "MATCH" if they clearly refer to the same company (allow abbreviations and legal suffix variations), "MISMATCH" if clearly different companies.

recommendation must be exactly one of: CLEAR, REVIEW, or BLOCK. No other values permitted. CLEAR = valid, low risk. REVIEW = valid but requires manual verification. BLOCK = invalid or high/critical risk.

Return ONLY valid JSON with no preamble or markdown:
{"fraud_risk_score":0,"fraud_risk_level":"LOW","fraud_signals":[],"name_match":"NOT_CHECKED","recommendation":"CLEAR","summary":"one sentence plain English"}`;

    let fraudRiskScore = 50;
    let fraudRiskLevel = 'MEDIUM';
    let fraudSignals = [];
    let nameMatch = 'NOT_CHECKED';
    let recommendation = 'REVIEW';
    let summary = 'Manual review recommended — AI analysis unavailable.';
    let aiDegraded = false;

    try {
      const aiResponse = await callClaude(prompt);
      const parsed = JSON.parse(aiResponse.replace(/```json|```/g, '').trim());
      fraudRiskScore = typeof parsed.fraud_risk_score === 'number' ? parsed.fraud_risk_score : fraudRiskScore;
      fraudRiskLevel = parsed.fraud_risk_level || fraudRiskLevel;
      fraudSignals = Array.isArray(parsed.fraud_signals) ? parsed.fraud_signals : [];
      nameMatch = parsed.name_match || nameMatch;
      recommendation = parsed.recommendation || recommendation;
      summary = parsed.summary || summary;
    } catch(e) {
      aiDegraded = true;
      if (!valid) {
        fraudRiskLevel = 'HIGH';
        fraudRiskScore = 75;
        fraudSignals = ['VAT number invalid or deregistered'];
        recommendation = 'BLOCK';
        summary = 'VAT number is invalid or deregistered.';
      }
    }

    let agentAction;
    if (!valid || fraudRiskLevel === 'CRITICAL' || nameMatch === 'MISMATCH') {
      agentAction = 'HOLD';
    } else if (fraudRiskLevel === 'HIGH' || fraudRiskLevel === 'MEDIUM') {
      agentAction = 'VERIFY_MANUALLY';
    } else {
      agentAction = 'PROCEED';
    }

    const vatResult = {
      agent_action: agentAction,
      valid,
      vat_number,
      jurisdiction,
      company_name,
      address,
      fraud_risk_score: fraudRiskScore,
      fraud_risk_level: fraudRiskLevel,
      fraud_signals: fraudSignals,
      name_match: nameMatch,
      recommendation,
      summary,
      verdict_ttl: VERDICT_TTL.validate_vat,
      data_source_status: aiDegraded ? 'partial' : 'full',
      source_url: sourceUrl,
      checked_at: checkedAt,
      _disclaimer: LEGAL_DISCLAIMER,
      ai_notice: 'AI-powered fraud analysis -- NOT a simple database lookup'
    };
    if (agentAction === 'VERIFY_MANUALLY') {
      vatResult.hold_reason = nameMatch === 'MISMATCH'
        ? 'Invoice company name does not match registered VAT holder name in ' + jurisdiction + ' registry'
        : (fraudSignals[0] || 'VAT number flagged for elevated fraud risk -- manual verification required');
      vatResult.retry_after = null;
      vatResult.escalation_path = nameMatch === 'MISMATCH'
        ? 'Contact supplier to confirm correct VAT registration and verify independently with ' + jurisdiction + ' tax authority before approving payment'
        : 'Verify VAT registration status directly with ' + jurisdiction + ' tax authority before approving payment';
    }
    return vatResult;
  }

  if (name === 'get_vat_rates') {
    const country_code = args.country_code;
    const checkedAt = nowISO();
    if (!country_code) return { agent_action: 'PROCEED', rates: VAT_RATES, note: 'VAT rates as of 2026. Verify with official tax authority before use.', verdict_ttl: VERDICT_TTL.get_vat_rates, data_source_status: 'full', source_url: 'taxation-customs.ec.europa.eu/tedb/taxes-list.html', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    const code = country_code.toUpperCase();
    const rate = VAT_RATES[code];
    if (!rate) return { error: 'No VAT rate data for: ' + code + '. Supported: ' + Object.keys(VAT_RATES).join(', '), agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };
    return Object.assign({ agent_action: 'PROCEED', country_code: code }, rate, { note: 'Verify current rates with official tax authority before use.', verdict_ttl: VERDICT_TTL.get_vat_rates, data_source_status: 'full', source_url: 'taxation-customs.ec.europa.eu/tedb/taxes-list.html', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER });
  }

  return { error: 'Unknown tool: ' + name, agent_action: 'RETRY_IN_2_MIN', category: 'unknown_tool', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10) };
}

async function checkOwnerKey(req, requestBody) {
  if (!OWNER_KEY) return false;
  const provided = req.headers['x-owner-key'] || (requestBody && requestBody.owner_key) || '';
  if (provided !== OWNER_KEY) return false;
  redisIncr(REDIS_PREFIX + ':owner_calls:' + new Date().toISOString().slice(0, 7)).catch(() => {});
  console.log('[owner] owner key used');
  return true;
}

async function checkAccess(req, toolName) {
  const rawIpAll = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ipAll = rawIpAll.split(',')[0].trim();
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const record = apiKeys.get(apiKey);
    if (!record) {
      return { allowed: false, error: 'Invalid API key' };
    }

    const wasReset = checkAndResetPeriod(record);
    if (wasReset) {
      saveKeyToRedis(apiKey, record, REDIS_PREFIX).catch(() => {});
    }

    if (record.plan === 'metered') {
      record.calls++;
      saveKeyToRedis(apiKey, record, REDIS_PREFIX).catch(() => {});
      return {
        allowed: true,
        paid: true,
        plan: 'metered',
        stripeCustomerId: record.stripeCustomerId
      };
    }

    if (record.calls >= record.limit) {
      recordGatedCall(ipAll, toolName);
      recordFleetGateHit(ipAll).catch(() => {});
      const crossServerNote = await buildCrossServerNote(ipAll);
      return {
        allowed: false,
        error: 'VAT Validator MCP bundle exhausted -- VAT verification is blocked for this invoice workflow until you purchase another bundle or switch to pay-as-you-go at ' + METERED_SUBSCRIBE_URL + '. You have used all ' + record.limit + ' calls in this bundle.' + (crossServerNote ? ' ' + crossServerNote : ''),
        subscribe_url: METERED_SUBSCRIBE_URL,
        bundle_500_url: BUNDLE_500_URL,
        bundle_2000_url: BUNDLE_2000_URL,
        agent_action: 'PAUSE_AND_NOTIFY_USER'
      };
    }

    record.calls++;
    saveKeyToRedis(apiKey, record, REDIS_PREFIX).catch(() => {});
    return { allowed: true, paid: true, plan: record.plan };
  }
  const ip = ipAll;
  const monthKey = getMonthKey(ip);
  const calls = freeTierUsage.get(monthKey) || 0;
  if (calls >= FREE_TIER_LIMIT) {
    recordGatedCall(ip, toolName);
    recordFleetGateHit(ip).catch(() => {});
    const crossServerNote = await buildCrossServerNote(ip);
    return {
    allowed: false,
    error: 'VAT Validator MCP free tier exhausted -- VAT verification is now blocked, halting any invoice-approval workflow that depends on it, until you extend via POST /trial-extension or upgrade at ' + BUNDLE_500_URL + '. An approved invoice with an invalid VAT number creates unrecoverable tax liability -- stopping here leaves your payment workflow incomplete. Free tier limit of 50 calls/month reached. To continue: (1) Trial extension — 10 free calls, no payment required: POST /trial-extension with {"name":"...","email":"...","use_case":"..."}. (2) Bundle 500 — $8, 500 calls, never expire: ' + BUNDLE_500_URL + '. (3) Pay-as-you-go — $0.010/call, no commitment: ' + METERED_SUBSCRIBE_URL + '.' + (crossServerNote ? ' ' + crossServerNote : ''),
    options: {
      pay_as_you_go: {
        description: 'No commitment. Pay only for what you use. Billed monthly at end of period.',
        pricing: {
          vat_query: '$0.010 per query'
        },
        subscribe_url: METERED_SUBSCRIBE_URL
      },
      bundle: {
        description: 'Buy a fixed call bundle. No subscription.',
        options: [
          { calls: 500, price: '$8', url: BUNDLE_500_URL },
          { calls: 2000, price: '$28', url: BUNDLE_2000_URL }
        ]
      }
    },
    agent_action: 'PAUSE_AND_NOTIFY_USER'
  };
  }
  freeTierUsage.set(monthKey, calls + 1);
  saveStats();
  saveFreeTierToRedis().catch(() => {});
  const remaining = FREE_TIER_LIMIT - calls - 1;
  const warningMsg = remaining < 10 ? remaining + ' free validations remaining this month. Get 500 calls for $8 at ' + BUNDLE_500_URL + ' -- calls never expire.' : null;
  return { allowed: true, tier: 'free', remaining, warning: warningMsg };
}

function verifyStripeSignature(body, sig, secret) {
  if (!secret) return false;
  if (!sig) return false;
  try {
    const parts = sig.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts['t'];
    const expected = parts['v1'];
    if (!timestamp || !expected) return false;
    const signed = timestamp + '.' + body;
    const computed = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
  } catch(e) { return false; }
}

async function handleStripeWebhook(body, sig) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[vat] STRIPE_WEBHOOK_SECRET not set — rejecting webhook');
    return { error: 'Webhook secret not configured', status: 400 };
  }
  if (!verifyStripeSignature(body, sig, secret)) {
    console.error('[vat] Invalid Stripe signature — rejecting webhook');
    return { error: 'Invalid signature', status: 400 };
  }
  try {
    const event = JSON.parse(body);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const paymentLinkId = session.payment_link;
      if (paymentLinkId && !ALLOWED_PAYMENT_LINK_IDS.includes(paymentLinkId)) {
        console.log('[vat] Webhook received but payment link ' + paymentLinkId + ' not for this server — ignoring.');
        return { received: true, ignored: true };
      }
      const plan = getPlanFromProduct(session.metadata?.product_name);
      const apiKey = generateApiKey();
      const limit = plan === 'metered' ? null : plan === 'bundle_2000' ? 2000 : 500;
      const record = {
        email: session.customer_details?.email || 'unknown',
        plan,
        calls: 0,
        periodStart: Date.now(),
        limit,
        stripeCustomerId: session.customer || null,
        createdAt: Date.now()
      };
      apiKeys.set(apiKey, record);
      await saveKeyToRedis(apiKey, record, REDIS_PREFIX);
      if (record.email && record.email !== 'unknown') {
        if (emailCircuitBreakerAllow()) {
          await sendApiKeyEmail(record.email, apiKey, plan);
        } else {
          console.error('[EmailBreaker] suppressed API key delivery email for ' + record.email + ' — hourly cap reached, key is still valid, follow up manually');
        }
      } else {
        console.error('[vat] No customer email in webhook — skipping email send');
      }
      console.log('[vat] API key created for ' + record.email + ' (' + plan + ')');
      return { success: true, email: record.email, plan };
    }
    if (event.type === 'customer.subscription.created') {
      const sub = event.data.object;
      const customerId = sub.customer;
      for (const [key, record] of apiKeys.entries()) {
        if (record.stripeCustomerId === customerId && !record.subscriptionId) {
          record.subscriptionId = sub.id;
          await saveKeyToRedis(key, record, REDIS_PREFIX);
          break;
        }
      }
      return { received: true, type: event.type };
    }
    if (event.type === 'charge.refunded') {
      if (!process.env.STRIPE_SECRET_KEY) {
        console.error('[vat] STRIPE_SECRET_KEY not set — cannot revoke key on refund');
        return { received: true, ignored: true };
      }
      const paymentIntentId = event.data.object.payment_intent;
      if (!paymentIntentId) {
        console.log('[vat] charge.refunded missing payment_intent — ignoring.');
        return { received: true, ignored: true };
      }
      try {
        const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
        const email = sessions.data[0]?.customer_details?.email;
        if (!email) {
          console.log('[vat] No checkout session/email found for refunded payment_intent ' + paymentIntentId);
          return { received: true, ignored: true };
        }
        let revokedKey = null;
        for (const [key, record] of apiKeys.entries()) {
          if (record.email === email) { revokedKey = key; break; }
        }
        if (!revokedKey) {
          console.log('[vat] No API key found for ' + email + ' — refund received, nothing to revoke');
          return { received: true, ignored: true };
        }
        apiKeys.delete(revokedKey);
        await redisDelete(`${REDIS_PREFIX}:key:${revokedKey}`);
        console.log('[Webhook] API key revoked for ' + email + ' — refund received');
        return { received: true, revoked: true };
      } catch(e) {
        console.error('[vat] charge.refunded handling error:', e.message);
        return { received: true, ignored: true };
      }
    }
    return { received: true, type: event.type };
  } catch(e) { console.error('[vat] Webhook error:', e.message); return { error: e.message, status: 400 }; }
}

const tools = [
  {
    name: 'validate_vat',
    idempotent: true,
    description: 'Validates a VAT number against live government registries. Call this BEFORE submitting any B2B payment via an agentic payment rail -- at the moment a VAT number appears on a supplier invoice and Stripe MPP, Alipay AI Pay, or Shopify UCP has not yet been called -- and BEFORE submitting any structured invoice under e-invoicing mandates now active or imminent: Belgium B2B (active Jan 2026), France B2B (Sep 2026), Poland KSeF (Feb 2026), AU GST digital reporting (ongoing). Use this when a supplier invoice carries a VAT number and your agent must confirm it is registered to the correct entity before approving payment or submitting a mandate-compliant e-invoice. Validates against EU VIES (ec.europa.eu, 27 member states) and AU ABR (abr.business.gov.au) live registries. Returns PROCEED / VERIFY_MANUALLY / HOLD verdict with fraud risk score 0-100 and name-match check. A settled B2B payment against an invalid or mismatched VAT number creates unrecoverable tax liability -- no agentic rail reverses a cleared cross-border transfer; an e-invoice submitted with an invalid VAT number is rejected at the mandate platform, halting the payables workflow. Pass the country_code from this response to get_vat_rates. One call, machine-ready verdict, no further analysis needed.',
    inputSchema: {
      type: 'object',
      properties: {
        vat_number: { type: 'string', description: 'VAT number with country prefix. EU: DE123456789. AU: ABN12345678901.' },
        invoice_company_name: { type: 'string', description: 'Company name as it appears on the invoice — if provided, cross-checks against registry and flags mismatches.' },
        invoice_amount: { type: 'number', description: 'Invoice amount in local currency — used in fraud risk weighting.' }
      },
      required: ['vat_number']
    },
    outputSchema: {
      type: 'object',
      properties: {
        agent_action: { type: 'string', enum: ['PROCEED', 'VERIFY_MANUALLY', 'HOLD'], description: 'Machine-readable verdict' },
        valid: { type: 'boolean', description: 'Whether the VAT number is currently registered and active per the source registry' },
        vat_number: { type: 'string' },
        jurisdiction: { type: 'string', enum: ['EU', 'AU'] },
        company_name: { type: ['string', 'null'] },
        address: { type: ['string', 'null'] },
        fraud_risk_score: { type: 'number', minimum: 0, maximum: 100 },
        fraud_risk_level: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
        fraud_signals: { type: 'array', items: { type: 'string' } },
        name_match: { type: 'string', enum: ['MATCH', 'MISMATCH', 'NOT_CHECKED'] },
        recommendation: { type: 'string', enum: ['CLEAR', 'REVIEW', 'BLOCK'] },
        summary: { type: 'string' },
        source_url: { type: 'string' },
        checked_at: { type: 'string', format: 'date-time' },
        _disclaimer: { type: 'string' }
      },
      required: ['agent_action', 'valid', 'vat_number', 'jurisdiction', 'source_url', 'checked_at'],
      additionalProperties: true
    }
  },
  {
    name: 'get_vat_rates',
    idempotent: true,
    description: 'Retrieves current VAT rates for a jurisdiction. Call this BEFORE calculating any invoice total or approving any VAT amount -- or immediately after validate_vat passing the country_code from that response. Use this when your agent needs to verify that the VAT rate on a supplier invoice matches the current official rate for that country before authorising payment. Returns current standard and reduced VAT rates for the jurisdiction. An agentic payment workflow that approves an invoice with an incorrect VAT rate creates a compounding compliance gap across every settled payment in that run -- VAT rates change without notice and cannot be sourced from training data. If the rate on the invoice differs from the rate returned here, do not approve payment.',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'ISO 2-letter code e.g. DE, FR, GB. Omit for all countries.' }
      },
      required: []
    },
    outputSchema: {
      type: 'object',
      properties: {
        agent_action: { type: 'string', enum: ['PROCEED'] },
        country_code: { type: 'string' },
        standard: { type: 'number', description: 'Standard VAT rate as a percentage' },
        reduced: { type: 'array', items: { type: 'number' }, description: 'Reduced VAT rates as percentages, if any apply' },
        country: { type: 'string' },
        rates: { type: 'object', description: 'Present only when country_code is omitted -- full rate table for all supported jurisdictions' },
        note: { type: 'string' },
        source_url: { type: 'string' },
        checked_at: { type: 'string', format: 'date-time' },
        _disclaimer: { type: 'string' }
      },
      required: ['agent_action', 'source_url', 'checked_at'],
      additionalProperties: true
    }
  }
];

const sseClients = new Map();
const server = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-api-key, mcp-session-id, x-stats-key' };
  if (req.method === 'OPTIONS') { res.writeHead(200, cors); res.end(); return; }

  if (req.url === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: VERSION, service: 'vat-validator-mcp', free_tier: 'no API key required for first ' + FREE_TIER_LIMIT + ' calls/month', paid_keys_issued: apiKeys.size }));
    return;
  }

  if (req.url === '/ready' && (req.method === 'GET' || req.method === 'HEAD')) {
    const checks = { anthropic: !!ANTHROPIC_API_KEY };
    const ready = checks.anthropic;
    res.writeHead(ready ? 200 : 503, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready', version: VERSION, checks }));
    return;
  }

  if (req.url === '/deps' && req.method === 'GET') {
    const depCheck = (hostname, path, headers) => new Promise((resolve) => {
      const r = https.request({ hostname, path, method: 'GET', headers: Object.assign({ 'User-Agent': 'VAT-Validator-MCP-HealthCheck/1.0' }, headers || {}) }, (res2) => {
        res2.resume();
        resolve({ ok: res2.statusCode < 500, status: res2.statusCode });
      });
      r.on('error', () => resolve({ ok: false, status: 0, error: 'unreachable' }));
      r.setTimeout(5000, () => { r.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
      r.end();
    });
    const [vies, abr, ai] = await Promise.all([
      depCheck('ec.europa.eu', '/taxation_customs/vies/rest-api/ms/DE/vat/123456789'),
      depCheck('abr.business.gov.au', '/json/?abn=12345678901&guid=' + (process.env.ABR_GUID || 'f7b75e2e-6d6a-4c1c-a8d4-5b2e3c9d8f4a')),
      depCheck('api.anthropic.com', '/v1/models', { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' })
    ]);
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ server: 'vat-validator-mcp', checked_at: nowISO(), dependencies: { vies, abr, anthropic: ai } }));
    return;
  }

  if (req.url === '/stats' && req.method === 'GET') {
    if (req.headers['x-stats-key'] !== STATS_KEY) { res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const totalFreeCalls = Array.from(freeTierUsage.values()).reduce((a, b) => a + b, 0);
    const freeUniqueIPs = new Set(Array.from(freeTierUsage.keys()).map(k => k.split(':')[0])).size;
    const monthPrefix = new Date().toISOString().slice(0, 7);
    const breakdown = {};
    for (const [key, count] of freeTierUsage.entries()) {
      if (key.includes(':' + monthPrefix)) {
        const ip = key.split(':')[0];
        breakdown[ip.slice(0, 10) + '...'] = count;
      }
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ free_tier_unique_ips: freeUniqueIPs, free_tier_total_calls: totalFreeCalls, paid_keys_issued: apiKeys.size, tool_usage: toolUsageCounts, recent_calls: usageLog.slice(-20).reverse(), trial_extensions_granted: trialExtensions.size, free_tier_breakdown: breakdown }));
    return;
  }

  // Unauthenticated machine-readable track record -- for agent orchestrators
  // evaluating server trustworthiness, not for humans. No stats-key required.
  if (req.url === '/public-stats' && req.method === 'GET') {
    (async () => {
      const [lifetimeCallsRaw, heartbeatCountRaw, monitoringStart] = await Promise.all([
        redisGet(LIFETIME_CALLS_REDIS_KEY),
        redisGet(UPTIME_HEARTBEAT_KEY),
        redisGet(UPTIME_MONITORING_START_KEY)
      ]);
      const lifetimeCalls = lifetimeCallsRaw || 0;
      const heartbeatCount = heartbeatCountRaw || 0;
      const monitoringStartTime = monitoringStart ? new Date(monitoringStart).getTime() : Date.now();
      const elapsedMs = Math.max(1, Date.now() - monitoringStartTime);
      const uptimePct = Math.min(100, Math.round((heartbeatCount * UPTIME_HEARTBEAT_INTERVAL_MS / elapsedMs) * 1000) / 10);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        server: 'vat-validator-mcp',
        version: VERSION,
        first_deployed: FIRST_DEPLOYED,
        total_lifetime_tool_calls: lifetimeCalls,
        uptime_percentage: uptimePct,
        uptime_monitoring_since: monitoringStart || nowISO()
      }));
    })();
    return;
  }

  if (req.url === '/session-log' && req.method === 'GET') {
    if (req.headers['x-stats-key'] !== STATS_KEY) { res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    (async () => {
      const keys = await redisKeys(`${REDIS_PREFIX}:session:*`);
      const sessions = [];
      for (const key of keys) {
        const calls = await redisGet(key) || [];
        if (!calls.length) continue;
        const withoutPrefix = key.slice(`${REDIS_PREFIX}:session:`.length);
        const dateIdx = withoutPrefix.lastIndexOf(':');
        const ipPart = withoutPrefix.slice(0, dateIdx);
        const date = withoutPrefix.slice(dateIdx + 1);
        sessions.push({ ip: ipPart.slice(0, 8), date, calls, first_call: calls[0]?.timestamp || '', last_call: calls[calls.length - 1]?.timestamp || '' });
      }
      sessions.sort((a, b) => new Date(b.first_call) - new Date(a.first_call));
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
    })();
    return;
  }

  if (req.url === '/trial-extension' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { name, email, use_case } = JSON.parse(body);
        if (!name || !email) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'name and email are required', agent_action: 'PROVIDE_REQUIRED_FIELDS' })); return; }
        const emailNorm = email.toLowerCase().trim();
        const emailKey = 'trial:' + emailNorm;
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
        const ipGrantKey = REDIS_PREFIX + ':trial_ext_granted:' + ipSafeKey(ip);

        // One trial extension per IP, ever. IP is the authoritative key -- never
        // name/email, both are attacker-controlled and trivially rotated. Redis
        // has no TTL on this key, so a grant issued once is permanent regardless
        // of process restarts.
        const alreadyGrantedForIp = await redisGet(ipGrantKey);
        if (alreadyGrantedForIp) {
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ granted: false, error: 'This IP address has already received its one-time trial extension.', message: 'Only one trial extension is available per IP address, and it has already been used. Upgrade to continue: ' + BUNDLE_500_URL, bundle_url: BUNDLE_500_URL, agent_action: 'HALT_WORKFLOW — trial extension already used for this IP. Do not retry /trial-extension from this IP under a different name or email. Direct the user to the paid upgrade path.' }));
          return;
        }
        // Redis-independent backstop -- caps new grants at 5/hr/server even if
        // Redis is unreachable and the check above can't be trusted.
        if (!trialGrantCircuitBreakerAllow()) {
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ granted: false, error: 'Trial extension grants are temporarily rate-limited on this server.', message: 'Please try again in a few minutes, or upgrade now: ' + BUNDLE_500_URL, bundle_url: BUNDLE_500_URL, agent_action: 'RETRY_LATER_OR_UPGRADE' }));
          return;
        }
        if (trialExtensions.has(emailKey)) { res.writeHead(409, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Trial extension already granted for this email.', bundle_url: BUNDLE_500_URL, agent_action: 'INFORM_USER_TRIAL_ALREADY_USED' })); return; }
        const monthKey = getMonthKey(ip);
        const currentCalls = freeTierUsage.get(monthKey) || 0;
        freeTierUsage.set(monthKey, Math.max(0, currentCalls - TRIAL_EXTENSION_CALLS));
        trialExtensions.set(emailKey, { name, email, use_case: use_case || '', ip, granted_at: nowISO() });
        saveStats();
        await redisSet(REDIS_PREFIX + ':trial:' + emailNorm, { name, email, use_case: use_case || '', ip, timestamp: nowISO(), server: 'vat-validator-mcp' });
        await redisSet(ipGrantKey, { name, email, ip, granted_at: nowISO() }); // no TTL -- one per IP, ever
        // 24h follow-up record -- processed by /process-trial-followups (fleet cron)
        await redisSet(REDIS_PREFIX + ':followup:' + emailNorm, { email, name, server: 'vat-validator-mcp', granted_at: nowISO(), sent: false });
        if (emailCircuitBreakerAllow()) {
          await sendEmail('ojas@kordagencies.com', 'VAT Validator -- Trial Extension: ' + name,
            '<p><b>Name:</b> ' + name + '<br><b>Email:</b> ' + email + '<br><b>Use case:</b> ' + (use_case || 'Not provided') + '<br><b>IP:</b> ' + ip + '<br><b>Calls granted:</b> ' + TRIAL_EXTENSION_CALLS + '</p>');
        } else { console.log('[EmailBreaker] suppressed trial-extension notify — hourly cap reached'); }
        if (emailCircuitBreakerAllow()) {
          await sendEmail(email, TRIAL_EXTENSION_CALLS + ' extra free calls added -- VAT Validator MCP',
            '<p>Hi ' + name + ',</p><p>Your ' + TRIAL_EXTENSION_CALLS + ' extra free calls have been added. You can keep using VAT Validator MCP right now -- no action needed.</p><p>When you need more, get 500 calls for $8: ' + BUNDLE_500_URL + '</p><p>Ojas<br>kordagencies.com</p>');
        } else { console.log('[EmailBreaker] suppressed trial-extension confirmation — hourly cap reached'); }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ granted: true, additional_calls: TRIAL_EXTENSION_CALLS, message: TRIAL_EXTENSION_CALLS + ' extra free calls added. Check your email for confirmation.', bundle_url: BUNDLE_500_URL }));
      } catch(e) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message, agent_action: 'RETRY_IN_2_MIN' })); }
    });
    return;
  }

  // Fleet cron hits this hourly. Sends exactly one follow-up email per email
  // address, 24h after a trial extension was granted, unless that email has
  // since picked up a paid key on this server.
  if (req.url === '/process-trial-followups' && req.method === 'POST') {
    if (req.headers['x-stats-key'] !== STATS_KEY) { res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    (async () => {
      const keys = await redisKeys(REDIS_PREFIX + ':followup:*');
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      let processed = 0, sent = 0, skippedPaid = 0;
      for (const key of keys) {
        const record = await redisGet(key);
        if (!record || record.sent) continue;
        if (Date.now() - new Date(record.granted_at).getTime() < TWENTY_FOUR_HOURS_MS) continue;
        processed++;
        const emailNorm = (record.email || '').toLowerCase().trim();
        const hasPaidKey = Array.from(apiKeys.values()).some(r => (r.email || '').toLowerCase().trim() === emailNorm);
        if (hasPaidKey) {
          skippedPaid++;
        } else if (emailCircuitBreakerAllow()) {
          await sendEmail(record.email, 'VAT Validator MCP -- VAT verification will block your invoice workflow again without an upgrade',
            '<p>Hi ' + record.name + ',</p><p>Your trial extension on VAT Validator MCP was granted 24 hours ago. Once those extra calls run out, VAT verification stops and any invoice-approval workflow that depends on it pauses until you upgrade.</p><p>Upgrade now -- 500 calls for $8, never expire: ' + BUNDLE_500_URL + '</p><p>Ojas<br>kordagencies.com</p>');
          sent++;
        } else { console.log('[EmailBreaker] suppressed trial-followup — hourly cap reached'); }
        record.sent = true;
        record.sent_at = nowISO();
        await redisSet(key, record);
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ checked: keys.length, processed, emails_sent: sent, skipped_already_paid: skippedPaid }));
    })();
    return;
  }

  if (req.url === '/webhook/stripe' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      const sig = req.headers['stripe-signature'] || '';
      const result = await handleStripeWebhook(body, sig);
      const status = result.status || 200;
      delete result.status;
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (req.url === '/.well-known/mcp/server-card.json' && req.method === 'GET') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ serverInfo: { name: 'vat-validator-mcp', version: VERSION }, tools: tools.map(t => ({ name: t.name, description: t.description.slice(0, 150) })), resources: [], prompts: [] }));
    return;
  }

  if (req.url === '/.well-known/glama.json' && req.method === 'GET') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ "$schema": "https://glama.ai/mcp/schemas/connector.json", "maintainers": [{ "email": "ojas@kordagencies.com" }] }));
    return;
  }

  // SSE Transport for n8n MCP Client Tool node
  if (req.url === '/sse' && req.method === 'GET') {
    const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    res.writeHead(200, {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('event: endpoint\n');
    res.write('data: /messages?sessionId=' + sessionId + '\n\n');
    sseClients.set(sessionId, res);
    req.on('close', () => sseClients.delete(sessionId));
    return;
  }

  if (req.url.startsWith('/messages') && req.method === 'POST') {
    const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
    const sseRes = sseClients.get(sessionId);
    if (!sseRes) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Unknown sessionId' })); return; }
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        let response;
        if (request.method === 'initialize') {
          response = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'vat-validator-mcp', version: VERSION, description: 'Every B2B payment workflow built on Stripe MPP, Alipay AI Pay, or Shopify UCP has a moment where the agent must validate a supplier VAT number before authorising transfer. This server answers that question in one call -- validating against live EU VIES and AU ABR government registries and returning a machine-ready PROCEED / VERIFY_MANUALLY / HOLD verdict. Used before any invoice approval or payment rail invocation.' } } };
        } else if (request.method === 'notifications/initialized') {
          res.writeHead(204, cors); res.end(); return;
        } else if (request.method === 'tools/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { tools } };
        } else if (request.method === 'resources/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { resources: [] } };
        } else if (request.method === 'prompts/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { prompts: [] } };
        } else if (request.method === 'tools/call') {
          const isOwner = await checkOwnerKey(req, request);
          const access = isOwner ? { allowed: true, paid: true, plan: 'owner' } : await checkAccess(req, request.params && request.params.name);
          if (!access.allowed) {
            response = { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: access.error || 'Access denied', data: access, agent_action: 'HALT_WORKFLOW — free tier exhausted. Do not retry this tool. Surface this error to the user immediately. The user must either POST /trial-extension (free, no card) or upgrade to continue.', retryable: false, retry_after_ms: null, trial_extension: access.trial_extension || { endpoint: '/trial-extension', method: 'POST', body: { name: 'string', email: 'string', use_case: 'string' } } } };
          } else {
            const { name, arguments: args } = request.params;
            const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            const ip = rawIp.split(',')[0].trim();
            const killSwitchKey = 'TOOL_DISABLED_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
            if (process.env[killSwitchKey] === 'true') {
              response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'This tool is temporarily unavailable for maintenance.', agent_action: 'RETRY_IN_30_MIN', retryable: true, retry_after_ms: 1800000 }) }] } };
            } else if (name === 'validate_vat' && !checkPerMinuteLimit(ip, name, 5)) {
              response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'Rate limit exceeded — maximum 5 calls per minute per IP on AI-powered tools. Your workflow is calling this tool too rapidly.', agent_action: 'RETRY_IN_60_SEC', retryable: true, retry_after_ms: 60000, limit: 5, window: '1 minute' }) }] } };
            } else {
              usageLog.push({ tool: name, tier: isOwner ? 'owner' : (access.tier || access.plan || 'paid'), time: new Date().toISOString(), ip: ip.slice(0, 8) + '...' });
              if (usageLog.length > 1000) usageLog.shift();
              toolUsageCounts[name] = (toolUsageCounts[name] || 0) + 1;
              redisIncr(LIFETIME_CALLS_REDIS_KEY).catch(() => {});
              saveStats();
              saveUsageStatsToRedis();
              appendSessionLog(ip, name).catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));
              const result = await executeTool(name, args || {});
              if (!isOwner && access.plan === 'metered' && access.stripeCustomerId) {
                reportMeteredUsage(access.stripeCustomerId, 'vat_query').catch(() => {});
              }
              result.calls_remaining = (isOwner || access.paid) ? 'unlimited' : Math.max(0, access.remaining || 0);
              response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
            }
          }
        } else {
          response = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found: ' + request.method } };
        }
        sseRes.write('event: message\n');
        sseRes.write('data: ' + JSON.stringify(response) + '\n\n');
        res.writeHead(202, cors); res.end();
      } catch(e) {
        res.writeHead(400, cors); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/daily-report' && req.method === 'POST') {
    if (req.headers['x-stats-key'] !== STATS_KEY) {
      res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
    }
    (async () => {
      const today = new Date().toISOString().slice(0, 10);
      const since24h = new Date(Date.now() - 86400000).toISOString();
      const cutoffMs = Date.now() - 86400000;

      const recentLog = usageLog.filter(e => e.time >= since24h);
      const successLog = recentLog.filter(e => e.tier !== 'gated');
      const gatedLog = recentLog.filter(e => e.tier === 'gated');
      const calls24h = successLog.length;
      const gateHits24h = gatedLog.length;
      const unique24h = new Set(successLog.map(e => e.ip)).size;

      const limitIPs = new Set();
      for (const [key, count] of freeTierUsage.entries()) {
        if (count >= FREE_TIER_LIMIT) limitIPs.add(key.slice(0, key.length - 8));
      }

      let trialCount = 0;
      for (const record of trialExtensions.values()) {
        if (record.granted_at && record.granted_at >= since24h) trialCount++;
      }

      let paidCount = 0;
      for (const record of apiKeys.values()) {
        const ts = record.createdAt ? (typeof record.createdAt === 'number' ? record.createdAt : new Date(record.createdAt).getTime()) : 0;
        if (ts >= cutoffMs) paidCount++;
      }

      const sessionKeys = await redisKeys(REDIS_PREFIX + ':session:*:' + today);
      const toolBreakdown = {};
      for (const key of sessionKeys) {
        const calls = await redisGet(key) || [];
        calls.forEach(c => { if (c.tool) toolBreakdown[c.tool] = (toolBreakdown[c.tool] || 0) + 1; });
      }

      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        server: 'vat-validator-mcp',
        date: today,
        calls_24h: calls24h,
        gate_hits_24h: gateHits24h,
        unique_ips_24h: unique24h,
        limit_hits: limitIPs.size,
        trial_extensions: trialCount,
        paid_conversions: paidCount,
        tool_breakdown: toolBreakdown
      }));
    })();
    return;
  }

  if (req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        let response;
        if (request.method === 'tools/call') {
          const _toolNameKs = request.params?.name;
          const _ksKey = 'TOOL_DISABLED_' + (_toolNameKs || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
          if (process.env[_ksKey] === 'true') {
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'This tool is temporarily unavailable for maintenance.', agent_action: 'RETRY_IN_30_MIN', retryable: true, retry_after_ms: 1800000 }) }] } }));
            return;
          }
          const _rawIpKs = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
          const _clientIpKs = _rawIpKs.split(',')[0].trim();
          if (_toolNameKs === 'validate_vat' && !checkPerMinuteLimit(_clientIpKs, _toolNameKs, 5)) {
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'Rate limit exceeded — maximum 5 calls per minute per IP on AI-powered tools. Your workflow is calling this tool too rapidly.', agent_action: 'RETRY_IN_60_SEC', retryable: true, retry_after_ms: 60000, limit: 5, window: '1 minute' }) }] } }));
            return;
          }
          const isOwner = await checkOwnerKey(req, request);
          const access = isOwner ? { allowed: true, paid: true, plan: 'owner', tier: 'owner' } : await checkAccess(req, _toolNameKs);
          if (!access.allowed) {
            res.writeHead(402, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: access.error || 'Access denied', data: access, agent_action: 'HALT_WORKFLOW — free tier exhausted. Do not retry this tool. Surface this error to the user immediately. The user must either POST /trial-extension (free, no card) or upgrade to continue.', retryable: false, retry_after_ms: null, trial_extension: access.trial_extension || { endpoint: '/trial-extension', method: 'POST', body: { name: 'string', email: 'string', use_case: 'string' } } } }));
            return;
          }
          req._accessWarning = access.warning;
          req._tier = access.tier;
          req._accessResult = access;
        }
        if (request.method === 'initialize') { response = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'vat-validator-mcp', version: VERSION, description: 'Every B2B payment workflow built on Stripe MPP, Alipay AI Pay, or Shopify UCP has a moment where the agent must validate a supplier VAT number before authorising transfer. This server answers that question in one call -- validating against live EU VIES and AU ABR government registries and returning a machine-ready PROCEED / VERIFY_MANUALLY / HOLD verdict. Used before any invoice approval or payment rail invocation.' } } };
        } else if (request.method === 'notifications/initialized') { res.writeHead(204, cors); res.end(); return;
        } else if (request.method === 'tools/list') { response = { jsonrpc: '2.0', id: request.id, result: { tools } };
        } else if (request.method === 'resources/list') { response = { jsonrpc: '2.0', id: request.id, result: { resources: [] } };
        } else if (request.method === 'prompts/list') { response = { jsonrpc: '2.0', id: request.id, result: { prompts: [] } };
        } else if (request.method === 'tools/call') {
          const { name, arguments: toolArgs } = request.params;
          const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
          const ip = rawIp.split(',')[0].trim();
          usageLog.push({ tool: name, tier: req._tier || req._accessResult?.plan || 'paid', time: new Date().toISOString(), ip: ip.slice(0, 8) + '...' });
          if (usageLog.length > 1000) usageLog.shift();
          toolUsageCounts[name] = (toolUsageCounts[name] || 0) + 1;
          redisIncr(LIFETIME_CALLS_REDIS_KEY).catch(() => {});
          saveStats();
          saveUsageStatsToRedis();
          appendSessionLog(ip, name).catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));
          const result = await executeTool(name, toolArgs || {});
          if (req._accessWarning) result._notice = req._accessWarning;
          result.calls_remaining = req._accessResult && req._accessResult.paid ? 'unlimited' : Math.max(0, (req._accessResult && req._accessResult.remaining) || 0);

          if (req._accessResult && req._accessResult.plan === 'metered' && req._accessResult.stripeCustomerId) {
            reportMeteredUsage(req._accessResult.stripeCustomerId, 'vat_query').catch(() => {});
          }

          if (req._tier === 'free' && !result.error) {
            const used = freeTierUsage.get(getMonthKey(ip)) || 0;
            const remaining = FREE_TIER_LIMIT - used;
            const isWarning = used >= FREE_TIER_WARNING;
            const effectiveLimit = getEffectiveLimit(ip);

            if (name === 'validate_vat') {
              const gated = ['fraud_signals', 'address'];
              gated.forEach(f => delete result[f]);
              result._upgrade_note = 'Free tier: ' + remaining + ' of ' + effectiveLimit + ' calls remaining. Get 500 calls for $8 at ' + BUNDLE_500_URL + ' -- calls never expire. Includes full registered address and detailed fraud signal breakdown.';
              result._gated_fields = gated;
            }

            if (isWarning) result._notice = 'Warning: only ' + remaining + ' free call' + (remaining === 1 ? '' : 's') + ' left this month. Get 500 calls for $8 at ' + BUNDLE_500_URL + ' -- calls never expire.';
          }

          response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
        } else { response = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found: ' + request.method } }; }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch(e) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ name: 'vat-validator-mcp', version: VERSION, status: 'ok', tools: 2, free_tier: '50 calls/month, no API key required', description: 'VAT validation + AI fraud detection. EU VIES, Australian ABN.', subscribe_url: METERED_SUBSCRIBE_URL, bundle_500_url: BUNDLE_500_URL, bundle_2000_url: BUNDLE_2000_URL })); return; }

  if (req.url === '/subscribe' && req.method === 'GET') {
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [
          { price: 'price_1TUkxWD6WvRe6sn3eFTaokqx' }
        ],
        success_url: 'https://vat-validator-mcp-production.up.railway.app/subscribed',
        cancel_url: 'https://kordagencies.com/vat-validator.html',
        metadata: { product_name: 'metered' }
      });
      res.writeHead(302, { Location: session.url });
      res.end();
    } catch(e) {
      res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not create checkout session', details: e.message }));
    }
    return;
  }

  if (req.url === '/subscribed' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Subscription confirmed</title>
<style>
body{background:#070910;color:#00E5C3;
font-family:'DM Mono',monospace;padding:3rem;
max-width:600px;margin:0 auto}
h2{font-weight:400;margin-bottom:1rem}
p{color:#8895AA;font-size:13px;line-height:1.6;
margin-bottom:0.8rem}
a{color:#00E5C3}
</style>
</head>
<body>
<h2>Subscription confirmed.</h2>
<p>Your API key will arrive by email within 60 seconds.</p>
<p>Add it to your agent config as the
<span style="color:#fff">x-api-key</span> header.</p>
<p>Full documentation at
<a href="https://kordagencies.com">kordagencies.com</a></p>
</body>
</html>`);
    return;
  }

  res.writeHead(404, cors); res.end(JSON.stringify({ error: 'Not found' }));
});

function setupStdio() {
  if (process.stdin.isTTY) return;
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach(async line => {
      if (!line.trim()) return;
      let req;
      try { req = JSON.parse(line); } catch(e) { return; }
      let response;
      if (req.method === 'initialize') {
        response = { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'vat-validator-mcp', version: VERSION, description: 'Every B2B payment workflow built on Stripe MPP, Alipay AI Pay, or Shopify UCP has a moment where the agent must validate a supplier VAT number before authorising transfer. This server answers that question in one call -- validating against live EU VIES and AU ABR government registries and returning a machine-ready PROCEED / VERIFY_MANUALLY / HOLD verdict. Used before any invoice approval or payment rail invocation.' } } };
      } else if (req.method === 'notifications/initialized') {
        return;
      } else if (req.method === 'tools/list') {
        response = { jsonrpc: '2.0', id: req.id, result: { tools } };
      } else if (req.method === 'resources/list') {
        response = { jsonrpc: '2.0', id: req.id, result: { resources: [] } };
      } else if (req.method === 'prompts/list') {
        response = { jsonrpc: '2.0', id: req.id, result: { prompts: [] } };
      } else if (req.method === 'tools/call') {
        try {
          const _name = req.params.name;
          const _ks = 'TOOL_DISABLED_' + (_name || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
          if (process.env[_ks] === 'true') {
            response = { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'This tool is temporarily unavailable for maintenance.', agent_action: 'RETRY_IN_30_MIN', retryable: true, retry_after_ms: 1800000 }) }] } };
          } else {
            const result = await executeTool(_name, req.params.arguments || {});
            result.calls_remaining = 'unlimited';
            response = { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
          }
        } catch(e) {
          response = { jsonrpc: '2.0', id: req.id, error: { code: -32603, message: e.message, agent_action: 'RETRY_IN_2_MIN' } };
        }
      } else {
        response = { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found: ' + req.method } };
      }
      process.stdout.write(JSON.stringify(response) + '\n');
    });
  });
  process.stdin.resume();
}

setupStdio();

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error('[Redis] WARNING: UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set — session logging will fail silently');
}

server.listen(PORT, async () => {
  loadStats();
  await loadApiKeysFromRedis('vat');
  await loadFreeTierFromRedis();
  await loadUsageStatsFromRedis();
  await initUptimeTracking();
  console.log('VAT Validator MCP v' + VERSION + ' running on port ' + PORT);
  console.log('Free tier: ' + FREE_TIER_LIMIT + ' calls/IP/month, no API key required');
  console.log('Resend: ' + (RESEND_API_KEY ? 'configured' : 'MISSING'));
  console.log('Anthropic: ' + (ANTHROPIC_API_KEY ? 'configured' : 'MISSING'));
  console.log('ABR GUID: ' + (process.env.ABR_GUID ? 'custom GUID set' : 'using fallback demo GUID — set ABR_GUID env var'));
  console.log('Upstash Redis: ' + (UPSTASH_URL ? 'configured' : 'MISSING - set UPSTASH_REDIS_REST_URL'));
  console.log('Stripe: ' + (process.env.STRIPE_SECRET_KEY ? 'configured' : 'MISSING - set STRIPE_SECRET_KEY'));
});
