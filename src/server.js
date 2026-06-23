const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PERSIST_FILE = '/tmp/vat_stats.json';
const VERSION = '2.0.28';

// Persistent device ID for HMRC fraud prevention headers (BATCH_PROCESS_DIRECT)
const DEVICE_ID_FILE = path.join(__dirname, '..', 'device-id.txt');
let DEVICE_ID;
try {
  DEVICE_ID = fs.readFileSync(DEVICE_ID_FILE, 'utf8').trim();
} catch(e) {
  DEVICE_ID = crypto.randomUUID();
  try { fs.writeFileSync(DEVICE_ID_FILE, DEVICE_ID); } catch(we) {}
}
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3000;
const STATS_KEY = process.env.STATS_KEY || 'ojas2026';
const REDIS_PREFIX = 'vat';
const FREE_TIER_REDIS_KEY = 'vat:free_tier_usage';
const FREE_TIER_LIMIT = 50;
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
    const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
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

function notifyGateHit(serverName, ip, toolName, totalCalls, stripeUrl) {
  const maskedIp = truncateIp(ip);
  const html = '<p>Server: ' + serverName + '</p><p>IP: ' + maskedIp + '</p><p>Tool: ' + (toolName || 'unknown') + '</p><p>Calls this month: ' + totalCalls + '</p><p>Time: ' + new Date().toISOString() + '</p><p>Upgrade: ' + stripeUrl + '</p>';
  sendEmail('ojas@kordagencies.com', '[Gate Hit] ' + serverName + ' — ' + maskedIp + ' hit free tier limit', html)
    .catch(e => console.error('[GateNotify] failed:', e.message));
}

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

async function hmrcFetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429) return response;
    if (attempt === maxRetries) return response;
    await new Promise(resolve => setTimeout(resolve, attempt * 1000));
  }
}

function getFraudPreventionHeaders() {
  return {
    'Gov-Client-Connection-Method': 'BATCH_PROCESS_DIRECT',
    'Gov-Client-Device-ID': DEVICE_ID,
    'Gov-Client-Local-IPs': '127.0.0.1',
    'Gov-Client-Local-IPs-Timestamp': new Date().toISOString().replace(/(\.\d{3})\d*Z/, '$1Z'),
    'Gov-Client-MAC-Addresses': 'not-applicable',
    'Gov-Client-Timezone': 'UTC+00:00',
    'Gov-Client-User-Agent': 'os-family=Linux&os-version=Server&device-manufacturer=Railway&device-model=Cloud',
    'Gov-Client-User-IDs': 'os=railway-service',
    'Gov-Vendor-License-IDs': 'vat-validator-mcp=not-applicable',
    'Gov-Vendor-Product-Name': 'VAT%20Validator%20MCP',
    'Gov-Vendor-Version': 'vat-validator-mcp=2.0.3'
  };
}

// HMRC OAuth 2.0 token cache
let hmrcToken = null;
let hmrcTokenExpiry = 0;

async function getHMRCToken() {
  const now = Date.now();
  // Refresh if missing or within 5 minutes of expiry
  if (hmrcToken && now < hmrcTokenExpiry - 300000) return hmrcToken;

  const clientId = process.env.HMRC_CLIENT_ID || '';
  const clientSecret = process.env.HMRC_CLIENT_SECRET || '';
  const sandbox = process.env.HMRC_SANDBOX === 'true';
  const hostname = sandbox ? 'test-api.service.hmrc.gov.uk' : 'api.service.hmrc.gov.uk';

  if (!clientId || !clientSecret) return null;

  const body = `client_secret=${encodeURIComponent(clientSecret)}&client_id=${encodeURIComponent(clientId)}&grant_type=client_credentials&scope=read%3Avat`;

  try {
    const response = await hmrcFetchWithRetry(`https://${hostname}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...getFraudPreventionHeaders() },
      body,
      signal: AbortSignal.timeout(8000)
    });
    const json = await response.json();
    if (json.access_token) {
      hmrcToken = json.access_token;
      hmrcTokenExpiry = now + (json.expires_in || 14400) * 1000;
      return hmrcToken;
    }
    return null;
  } catch(e) {
    return null;
  }
}

async function validateHMRC(vatNumber) {
  const clean = vatNumber.replace(/^GB/i, '').replace(/\s/g, '');
  const token = await getHMRCToken();
  if (!token) return { source: 'HMRC', error: 'HMRC credentials not configured' };

  const sandbox = process.env.HMRC_SANDBOX === 'true';
  const hostname = sandbox ? 'test-api.service.hmrc.gov.uk' : 'api.service.hmrc.gov.uk';

  try {
    const response = await hmrcFetchWithRetry(`https://${hostname}/organisations/vat/check-vat-number/lookup/${clean}`, {
      method: 'GET',
      headers: { 'Accept': 'application/vnd.hmrc.2.0+json', 'Authorization': 'Bearer ' + token, ...getFraudPreventionHeaders() },
      signal: AbortSignal.timeout(8000)
    });
    const data = await response.json();
    return { source: 'HMRC', status: response.status, data };
  } catch(e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { source: 'HMRC', error: 'Timeout' };
    return { source: 'HMRC', error: e.message };
  }
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
  if (clean.startsWith('GB')) return { country: 'GB', type: 'uk', number: clean.slice(2) };
  if (clean.startsWith('ABN')) return { country: 'AU', type: 'au', number: clean.slice(3) };
  if (clean.startsWith('AU') || /^\d{11}$/.test(clean)) return { country: 'AU', type: 'au', number: clean };
  const euCodes = ['AT','BE','BG','CY','CZ','DE','DK','EE','EL','ES','FI','FR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'];
  for (const code of euCodes) {
    if (clean.startsWith(code)) return { country: code, type: 'eu', number: clean.slice(2) };
  }
  return { country: null, type: 'unknown', number: clean };
}

const LEGAL_DISCLAIMER = 'Results sourced directly from official government VAT registries (EU VIES, UK HMRC, Australian ABR). We do not log or store your query content. Results are for informational purposes only and do not constitute legal or tax advice. Operator must independently verify all results with a qualified tax advisor before making compliance decisions. Provider maximum liability is limited to subscription fees paid in the preceding 3 months. Full terms: kordagencies.com/terms.html';

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

    if (detected.type === 'uk') {
      jurisdiction = 'UK';
      sourceUrl = 'api.service.hmrc.gov.uk';
      const result = await validateHMRC(detected.number);
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
      if (result.status === 200 && d.target) {
        valid = true;
        company_name = d.target.name || null;
        address = d.target.address ? Object.values(d.target.address).filter(Boolean).join(', ') : null;
      }
    } else if (detected.type === 'eu') {
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
        error: 'Could not detect country. Supported prefixes: EU (AT BE BG CY CZ DE DK EE EL ES FI FR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK), UK (GB), Australia (AU or ABN).',
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
    if (!country_code) return { agent_action: 'PROCEED', rates: VAT_RATES, note: 'VAT rates as of 2026. Verify with official tax authority before use.', source_url: 'taxation-customs.ec.europa.eu/tedb/taxes-list.html', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    const code = country_code.toUpperCase();
    const rate = VAT_RATES[code];
    if (!rate) return { error: 'No VAT rate data for: ' + code + '. Supported: ' + Object.keys(VAT_RATES).join(', '), agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };
    return Object.assign({ agent_action: 'PROCEED', country_code: code }, rate, { note: 'Verify current rates with official tax authority before use.', source_url: 'taxation-customs.ec.europa.eu/tedb/taxes-list.html', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER });
  }

  return { error: 'Unknown tool: ' + name, agent_action: 'RETRY_IN_2_MIN', category: 'unknown_tool', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10) };
}

function checkAccess(req, toolName) {
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
      return {
        allowed: false,
        error: `Bundle exhausted. You have used all ${record.limit} calls in this bundle. Purchase another bundle or switch to pay-as-you-go.`,
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
  const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ip = rawIp.split(',')[0].trim();
  const monthKey = getMonthKey(ip);
  const calls = freeTierUsage.get(monthKey) || 0;
  if (calls >= FREE_TIER_LIMIT) {
    notifyGateHit('VAT Validator', ip, toolName, calls, BUNDLE_500_URL);
    return {
    allowed: false,
    error: 'An approved invoice with an invalid VAT number creates unrecoverable tax liability — stopping here leaves your payment workflow incomplete. Free tier limit of 50 calls/month reached. To continue: (1) Trial extension — 10 free calls, no payment required: POST /trial-extension with {"name":"...","email":"...","use_case":"..."}. (2) Bundle 500 — $8, 500 calls, never expire: ' + BUNDLE_500_URL + '. (3) Pay-as-you-go — $0.010/call, no commitment: ' + METERED_SUBSCRIBE_URL + '.',
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
        await sendApiKeyEmail(record.email, apiKey, plan);
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
    description: 'Validates a VAT number against live government registries. Call this BEFORE submitting any B2B payment via an agentic payment rail -- at the moment a VAT number appears on a supplier invoice and Stripe MPP, Alipay AI Pay, or Shopify UCP has not yet been called. Use this when a supplier invoice carries a VAT number and your agent must confirm it is registered to the correct entity before approving payment. Validates against EU VIES (ec.europa.eu), UK HMRC (api.service.hmrc.gov.uk), and AU ABR (abr.business.gov.au) live registries. Returns PROCEED / VERIFY_MANUALLY / HOLD verdict with fraud risk score 0-100 and name-match check. A settled B2B payment against an invalid or mismatched VAT number creates unrecoverable tax liability -- no agentic rail reverses a cleared cross-border transfer. Pass the country_code from this response to get_vat_rates. One call, machine-ready verdict, no further analysis needed.',
    inputSchema: {
      type: 'object',
      properties: {
        vat_number: { type: 'string', description: 'VAT number with country prefix. EU: DE123456789. UK: GB123456789. AU: ABN12345678901.' },
        invoice_company_name: { type: 'string', description: 'Company name as it appears on the invoice — if provided, cross-checks against registry and flags mismatches.' },
        invoice_amount: { type: 'number', description: 'Invoice amount in local currency — used in fraud risk weighting.' }
      },
      required: ['vat_number']
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
    const checks = { anthropic: !!ANTHROPIC_API_KEY, hmrc_client_id: !!(process.env.HMRC_CLIENT_ID), hmrc_client_secret: !!(process.env.HMRC_CLIENT_SECRET) };
    const ready = checks.anthropic && checks.hmrc_client_id && checks.hmrc_client_secret;
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
    const [vies, hmrc, abr, ai] = await Promise.all([
      depCheck('ec.europa.eu', '/taxation_customs/vies/rest-api/ms/DE/vat/123456789'),
      getHMRCToken().then(t => t ? { ok: true, status: 200, note: 'OAuth token acquired' } : { ok: false, status: 0, error: 'token fetch failed' }),
      depCheck('abr.business.gov.au', '/json/?abn=12345678901&guid=' + (process.env.ABR_GUID || 'f7b75e2e-6d6a-4c1c-a8d4-5b2e3c9d8f4a')),
      depCheck('api.anthropic.com', '/v1/models', { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' })
    ]);
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ server: 'vat-validator-mcp', checked_at: nowISO(), dependencies: { vies, hmrc, abr, anthropic: ai } }));
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
        const emailKey = 'trial:' + email.toLowerCase().trim();
        if (trialExtensions.has(emailKey)) { res.writeHead(409, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Trial extension already granted for this email.', bundle_url: BUNDLE_500_URL, agent_action: 'INFORM_USER_TRIAL_ALREADY_USED' })); return; }
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const monthKey = getMonthKey(ip);
        const currentCalls = freeTierUsage.get(monthKey) || 0;
        freeTierUsage.set(monthKey, Math.max(0, currentCalls - TRIAL_EXTENSION_CALLS));
        trialExtensions.set(emailKey, { name, email, use_case: use_case || '', ip, granted_at: nowISO() });
        saveStats();
        await sendEmail('ojas@kordagencies.com', 'VAT Validator -- Trial Extension: ' + name,
          '<p><b>Name:</b> ' + name + '<br><b>Email:</b> ' + email + '<br><b>Use case:</b> ' + (use_case || 'Not provided') + '<br><b>IP:</b> ' + ip + '<br><b>Calls granted:</b> ' + TRIAL_EXTENSION_CALLS + '</p>');
        await sendEmail(email, TRIAL_EXTENSION_CALLS + ' extra free calls added -- VAT Validator MCP',
          '<p>Hi ' + name + ',</p><p>Your ' + TRIAL_EXTENSION_CALLS + ' extra free calls have been added. You can keep using VAT Validator MCP right now -- no action needed.</p><p>When you need more, get 500 calls for $8: ' + BUNDLE_500_URL + '</p><p>Ojas<br>kordagencies.com</p>');
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ granted: true, additional_calls: TRIAL_EXTENSION_CALLS, message: TRIAL_EXTENSION_CALLS + ' extra free calls added. Check your email for confirmation.', bundle_url: BUNDLE_500_URL }));
      } catch(e) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message, agent_action: 'RETRY_IN_2_MIN' })); }
    });
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
          response = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'vat-validator-mcp', version: VERSION, description: 'Every B2B payment workflow built on Stripe MPP, Alipay AI Pay, or Shopify UCP has a moment where the agent must validate a supplier VAT number before authorising transfer. This server answers that question in one call -- validating against live EU VIES, UK HMRC, and AU ABR government registries and returning a machine-ready PROCEED / VERIFY_MANUALLY / HOLD verdict. Used before any invoice approval or payment rail invocation.' } } };
        } else if (request.method === 'notifications/initialized') {
          res.writeHead(204, cors); res.end(); return;
        } else if (request.method === 'tools/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { tools } };
        } else if (request.method === 'resources/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { resources: [] } };
        } else if (request.method === 'prompts/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { prompts: [] } };
        } else if (request.method === 'tools/call') {
          const access = checkAccess(req, request.params && request.params.name);
          if (!access.allowed) {
            response = { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: access.error || 'Access denied', data: access, agent_action: 'PAUSE_AND_NOTIFY_USER' } };
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
              usageLog.push({ tool: name, tier: access.tier || access.plan || 'paid', time: new Date().toISOString(), ip: ip.slice(0, 8) + '...' });
              if (usageLog.length > 1000) usageLog.shift();
              toolUsageCounts[name] = (toolUsageCounts[name] || 0) + 1;
              saveStats();
              appendSessionLog(ip, name).catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));
              const result = await executeTool(name, args || {});
              if (access.plan === 'metered' && access.stripeCustomerId) {
                reportMeteredUsage(access.stripeCustomerId, 'vat_query').catch(() => {});
              }
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
      const calls24h = recentLog.length;
      const unique24h = new Set(recentLog.map(e => e.ip)).size;

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
          const access = checkAccess(req, _toolNameKs);
          if (!access.allowed) {
            res.writeHead(402, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: access.error || 'Access denied', data: access, agent_action: 'PAUSE_AND_NOTIFY_USER' } }));
            return;
          }
          req._accessWarning = access.warning;
          req._tier = access.tier;
          req._accessResult = access;
        }
        if (request.method === 'initialize') { response = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'vat-validator-mcp', version: VERSION, description: 'Every B2B payment workflow built on Stripe MPP, Alipay AI Pay, or Shopify UCP has a moment where the agent must validate a supplier VAT number before authorising transfer. This server answers that question in one call -- validating against live EU VIES, UK HMRC, and AU ABR government registries and returning a machine-ready PROCEED / VERIFY_MANUALLY / HOLD verdict. Used before any invoice approval or payment rail invocation.' } } };
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
          saveStats();
          appendSessionLog(ip, name).catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));
          const result = await executeTool(name, toolArgs || {});
          if (req._accessWarning) result._notice = req._accessWarning;

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

  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ name: 'vat-validator-mcp', version: VERSION, status: 'ok', tools: 2, free_tier: '50 calls/month, no API key required', description: 'VAT validation + AI fraud detection. EU VIES, UK HMRC, Australian ABN.', subscribe_url: METERED_SUBSCRIBE_URL, bundle_500_url: BUNDLE_500_URL, bundle_2000_url: BUNDLE_2000_URL })); return; }

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
        response = { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'vat-validator-mcp', version: VERSION, description: 'Every B2B payment workflow built on Stripe MPP, Alipay AI Pay, or Shopify UCP has a moment where the agent must validate a supplier VAT number before authorising transfer. This server answers that question in one call -- validating against live EU VIES, UK HMRC, and AU ABR government registries and returning a machine-ready PROCEED / VERIFY_MANUALLY / HOLD verdict. Used before any invoice approval or payment rail invocation.' } } };
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
  console.log('VAT Validator MCP v' + VERSION + ' running on port ' + PORT);
  console.log('Free tier: ' + FREE_TIER_LIMIT + ' calls/IP/month, no API key required');
  console.log('Resend: ' + (RESEND_API_KEY ? 'configured' : 'MISSING'));
  console.log('Anthropic: ' + (ANTHROPIC_API_KEY ? 'configured' : 'MISSING'));
  console.log('ABR GUID: ' + (process.env.ABR_GUID ? 'custom GUID set' : 'using fallback demo GUID — set ABR_GUID env var'));
  console.log('Upstash Redis: ' + (UPSTASH_URL ? 'configured' : 'MISSING - set UPSTASH_REDIS_REST_URL'));
  console.log('Stripe: ' + (process.env.STRIPE_SECRET_KEY ? 'configured' : 'MISSING - set STRIPE_SECRET_KEY'));
});
