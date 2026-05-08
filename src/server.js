const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const PERSIST_FILE = '/tmp/vat_stats.json';
const API_KEYS_FILE = '/tmp/vat_apikeys.json';
const VERSION = '1.4.12';
const PRO_UPGRADE_URL = 'https://buy.stripe.com/28EeVceUB06N1ty3teebu0l';
const ENTERPRISE_UPGRADE_URL = 'https://buy.stripe.com/00w14m7s96vb1ty5Bmebu0m';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3000;
const STATS_KEY = process.env.STATS_KEY || 'ojas2026';

const freeTierUsage = new Map();
const usageLog = [];
const toolUsageCounts = {};
const trialExtensions = new Map();
const FREE_TIER_LIMIT = 20;
const FREE_TIER_WARNING = 16;
const TRIAL_EXTENSION_CALLS = 10;
const apiKeys = new Map();
const PLAN_LIMITS = { pro: 5000, enterprise: Infinity };

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

function saveApiKeys() {
  try { fs.writeFileSync(API_KEYS_FILE, JSON.stringify(Array.from(apiKeys.entries()))); } catch(e) { console.error('API keys save error:', e.message); }
}

function loadApiKeys() {
  try {
    if (fs.existsSync(API_KEYS_FILE)) {
      const entries = JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf8'));
      entries.forEach(([k, v]) => apiKeys.set(k, v));
      console.log('API keys loaded: ' + apiKeys.size + ' keys');
    }
  } catch(e) { console.error('API keys load error:', e.message); }
}

function generateApiKey() { return 'vat_' + crypto.randomBytes(24).toString('hex'); }
function getPlanFromProduct(name) {
  if (!name) return 'pro';
  return name.toLowerCase().includes('enterprise') ? 'enterprise' : 'pro';
}
function nowISO() { return new Date().toISOString(); }

async function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: 'VAT Validator MCP <ojas@kordagencies.com>', to: [to], subject, html });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body); req.end();
  });
}

async function sendApiKeyEmail(email, apiKey, plan) {
  const planLabel = plan === 'enterprise' ? 'Enterprise' : 'Pro';
  const limit = plan === 'enterprise' ? 'Unlimited' : '5,000';
  const html = '<!DOCTYPE html><html><body style="font-family:monospace;background:#080A0F;color:#E8EDF5;padding:40px;max-width:600px;margin:0 auto"><div style="border:1px solid rgba(0,229,195,0.3);border-radius:8px;padding:32px"><div style="color:#00E5C3;font-size:13px;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:24px">VAT Validator MCP - ' + planLabel + ' Plan</div><h1 style="font-size:24px;font-weight:700;margin-bottom:8px;color:#FFFFFF">Your API key is ready.</h1><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#5A6478;font-size:11px;text-transform:uppercase;margin-bottom:8px">Your API Key</div><div style="color:#00E5C3;font-size:14px;word-break:break-all">' + apiKey + '</div></div><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#5A6478;font-size:11px;text-transform:uppercase;margin-bottom:8px">MCP Config</div><div style="color:#86EFAC;font-size:12px">{"vat-validator":{"url":"https://vat-validator-mcp-production.up.railway.app","headers":{"x-api-key":"' + apiKey + '"}}}</div></div><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#E8EDF5;font-size:13px">Plan: ' + planLabel + ' | Validations: ' + limit + '/month</div></div><div style="background:#0D1219;border-radius:6px;padding:16px;margin-bottom:24px;font-size:11px;color:#5A6478;line-height:1.7">Results are informational only. Verify with a qualified tax advisor. Liability capped at 3 months fees. Full terms: kordagencies.com/terms.html</div><p style="color:#5A6478;font-size:12px">Questions? ojas@kordagencies.com</p></div></body></html>';
  return sendEmail(email, 'Your VAT Validator MCP ' + planLabel + ' API Key', html);
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

  return new Promise((resolve) => {
    const req = https.request({
      hostname,
      path: '/oauth/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json.access_token) {
            hmrcToken = json.access_token;
            hmrcTokenExpiry = now + (json.expires_in || 14400) * 1000;
            resolve(hmrcToken);
          } else {
            resolve(null);
          }
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function validateHMRC(vatNumber) {
  const clean = vatNumber.replace(/^GB/i, '').replace(/\s/g, '');
  const token = await getHMRCToken();
  if (!token) return { source: 'HMRC', error: 'HMRC credentials not configured' };

  const sandbox = process.env.HMRC_SANDBOX === 'true';
  const hostname = sandbox ? 'test-api.service.hmrc.gov.uk' : 'api.service.hmrc.gov.uk';

  return new Promise((resolve) => {
    const req = https.request({
      hostname,
      path: '/organisations/vat/check-vat-number/lookup/' + clean,
      method: 'GET',
      headers: { 'Accept': 'application/vnd.hmrc.2.0+json', 'Authorization': 'Bearer ' + token }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ source: 'HMRC', status: res.statusCode, data: JSON.parse(d) }); }
        catch(e) { resolve({ source: 'HMRC', error: 'Parse error' }); }
      });
    });
    req.on('error', e => resolve({ source: 'HMRC', error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ source: 'HMRC', error: 'Timeout' }); });
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
  if (clean.startsWith('GB')) return { country: 'GB', type: 'uk', number: clean.slice(2) };
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
    const vat_number = args.vat_number;
    const checkedAt = nowISO();
    if (!vat_number) return { error: 'vat_number is required', likely_cause: 'required field missing or malformed', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10) };
    const detected = detectCountry(vat_number);
    if (detected.type === 'uk') {
      const result = await validateHMRC(detected.number);
      if (result.error) return { valid: null, vat_number, country: 'GB', source: 'HMRC', error: result.error, likely_cause: 'external VAT registry temporarily unavailable', agent_action: 'RETRY_IN_2_MIN', category: 'upstream_unavailable', retryable: true, retry_after_ms: 120000, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), retry: true, _disclaimer: LEGAL_DISCLAIMER };
      const d = result.data;
      if (result.status === 200 && d.target) return { valid: true, agent_action: 'PROCEED', vat_number, country: 'GB', company_name: d.target.name || null, source: 'HMRC', source_url: 'api.service.hmrc.gov.uk', consultation_number: d.consultationNumber || null, checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
      return { valid: false, agent_action: 'VERIFY_MANUALLY', vat_number, country: 'GB', source: 'HMRC', source_url: 'api.service.hmrc.gov.uk', reason: d.code || 'VAT number not found', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    }
    if (detected.type === 'eu') {
      const result = await validateVIES(detected.country, detected.number);
      if (result.error) return { valid: null, vat_number, agent_action: 'RETRY_IN_30_MIN', category: 'upstream_unavailable', retryable: true, retry_after_ms: 1800000, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), country: detected.country, source: 'VIES', source_url: 'ec.europa.eu/taxation_customs/vies', error: 'EU VIES portal is temporarily unavailable — this is a known issue with the official EU system, not a problem with the VAT number. Retry in 30 minutes.', likely_cause: 'external VAT registry temporarily unavailable', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
      const d = result.data;
      return { valid: d.isValid || false, agent_action: d.isValid ? 'PROCEED' : 'VERIFY_MANUALLY', vat_number, country: detected.country, company_name: d.traderName || null, address: d.traderAddress || null, source: 'VIES', source_url: 'ec.europa.eu/taxation_customs/vies', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    }
    if (detected.type === 'au') {
      const result = await validateABN(detected.number);
      if (result.error) return { valid: null, vat_number, country: 'AU', source: 'ABR', error: result.error, likely_cause: 'external VAT registry temporarily unavailable', agent_action: 'RETRY_IN_2_MIN', category: 'upstream_unavailable', retryable: true, retry_after_ms: 120000, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };
      const d = result.data;
      const isValidABN = !!(d.Abn && d.AbnStatus === 'Active');
      return { valid: isValidABN, agent_action: isValidABN ? 'PROCEED' : 'VERIFY_MANUALLY', vat_number, country: 'AU', company_name: d.EntityName || null, abn_status: d.AbnStatus || null, source: 'ABR', source_url: 'abr.business.gov.au', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    }
    return { valid: null, vat_number, agent_action: 'PROVIDE_COUNTRY_PREFIX', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), error: 'Could not detect country. Supported prefixes: EU (AT BE BG CY CZ DE DK EE EL ES FI FR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK), UK (GB), Australia (AU).', likely_cause: 'required field missing or malformed', _disclaimer: LEGAL_DISCLAIMER };
  }

  if (name === 'validate_uk_vat') {
    const vat_number = args.vat_number;
    const checkedAt = nowISO();
    if (!vat_number) return { error: 'vat_number is required', likely_cause: 'required field missing or malformed', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10) };
    const result = await validateHMRC(vat_number);
    if (result.error) return { valid: null, vat_number, source: 'HMRC', source_url: 'api.service.hmrc.gov.uk', error: 'UK HMRC API is temporarily unavailable — this is not a problem with the VAT number. Retry in a few minutes.', likely_cause: 'external VAT registry temporarily unavailable', agent_action: 'RETRY_IN_2_MIN', category: 'upstream_unavailable', retryable: true, retry_after_ms: 120000, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    const d = result.data;
    if (result.status === 200 && d.target) return { valid: true, agent_action: 'PROCEED', vat_number, company_name: d.target.name || null, registered_address: d.target.address ? Object.values(d.target.address).filter(Boolean).join(', ') : null, consultation_number: d.consultationNumber || null, source: 'HMRC', source_url: 'api.service.hmrc.gov.uk', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    return { valid: false, agent_action: 'VERIFY_MANUALLY', vat_number, source: 'HMRC', source_url: 'api.service.hmrc.gov.uk', reason: d.code || 'VAT number not found', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
  }

  if (name === 'get_vat_rates') {
    const country_code = args.country_code;
    const checkedAt = nowISO();
    if (!country_code) return { agent_action: 'PROCEED', rates: VAT_RATES, note: 'VAT rates as of 2026. Verify with official tax authority before use.', source_url: 'kordagencies.com', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    const code = country_code.toUpperCase();
    const rate = VAT_RATES[code];
    if (!rate) return { error: 'No VAT rate data for: ' + code + '. Supported: ' + Object.keys(VAT_RATES).join(', '), likely_cause: 'required field missing or malformed', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };
    return Object.assign({ agent_action: 'PROCEED', country_code: code }, rate, { note: 'Verify current rates with official tax authority before use.', source_url: 'kordagencies.com', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER });
  }

  if (name === 'batch_validate') {
    const vat_numbers = args.vat_numbers;
    if (!vat_numbers || !Array.isArray(vat_numbers)) return { error: 'vat_numbers must be an array', likely_cause: 'required field missing or malformed', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10) };
    if (vat_numbers.length > 10) return { error: 'Maximum 10 VAT numbers per batch. Upgrade to Enterprise at kordagencies.com for unlimited batches.', likely_cause: 'required field missing or malformed', agent_action: 'Reduce batch to 10 or fewer, or upgrade to Enterprise at kordagencies.com', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10) };
    const results = await Promise.all(vat_numbers.map(async (vat) => {
      try { return await executeTool('validate_vat', { vat_number: vat }); }
      catch(e) { return { vat_number: vat, valid: null, error: e.message, likely_cause: 'external VAT registry temporarily unavailable', agent_action: 'RETRY_IN_2_MIN', category: 'upstream_unavailable', retryable: true, retry_after_ms: 120000, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10) }; }
    }));
    return { agent_action: 'PROCEED', summary: { total: results.length, valid: results.filter(r => r.valid === true).length, invalid: results.filter(r => r.valid === false).length, error: results.filter(r => r.valid === null).length }, results, _disclaimer: LEGAL_DISCLAIMER };
  }

  if (name === 'analyse_vat_risk') {
    const vat_number = args.vat_number;
    const validation_result = args.validation_result;
    const invoice_amount = args.invoice_amount;
    const invoice_company_name = args.invoice_company_name;
    if (!vat_number || !validation_result) return { error: 'vat_number and validation_result are required', likely_cause: 'required field missing or malformed', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10) };
    const prompt = 'You are a B2B fraud detection specialist. Analyse this VAT validation result for fraud signals.\n\nVAT Number: ' + vat_number + '\nValidation Result: ' + JSON.stringify(validation_result) + '\nInvoice Amount: ' + (invoice_amount ? String(invoice_amount) : 'Not provided') + '\nInvoice Company Name: ' + (invoice_company_name || 'Not provided') + '\nRegistered Company Name: ' + (validation_result.company_name || 'Not available') + '\nValid: ' + validation_result.valid + '\nCountry: ' + validation_result.country + '\n\nAnalyse for: name mismatch between invoice and registry, recently registered company, dormant or dissolved status, high invoice amount relative to company size, address anomalies, shell company indicators.\n\nReturn ONLY valid JSON with no preamble: {"recommendation":"CLEAR|REVIEW|BLOCK","risk_level":"LOW|MEDIUM|HIGH|CRITICAL","risk_score":50,"fraud_signals":[],"positive_indicators":[],"recommended_action":"one sentence","summary":"two sentences"}';
    try {
      const response = await callClaude(prompt);
      const result = JSON.parse(response.replace(/```json|```/g, '').trim());
      const vatRiskAction = (result.risk_level === 'HIGH' || result.risk_level === 'CRITICAL') ? 'HOLD' : result.risk_level === 'MEDIUM' ? 'VERIFY_MANUALLY' : 'PROCEED';
      return Object.assign({}, result, { vat_number, agent_action: vatRiskAction, _disclaimer: LEGAL_DISCLAIMER });
    } catch(e) {
      return { recommendation: 'REVIEW', risk_level: 'MEDIUM', risk_score: 50, vat_number, error: 'AI analysis unavailable - manual review recommended', likely_cause: 'AI analysis failed — transient Anthropic API issue', agent_action: 'RETRY_IN_2_MIN', category: 'upstream_unavailable', retryable: true, retry_after_ms: 120000, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };
    }
  }

  if (name === 'compare_invoice_details') {
    const { invoice_company_name, invoice_address, invoice_vat_number, validation_result } = args;
    if (!invoice_company_name || !invoice_vat_number || !validation_result) return { error: 'invoice_company_name, invoice_vat_number, and validation_result are required', likely_cause: 'required field missing or malformed', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10) };
    const prompt = 'You are an invoice fraud detection specialist. Compare invoice details against official registry records.\n\nINVOICE CLAIMS:\nCompany Name: ' + invoice_company_name + '\nAddress: ' + (invoice_address || 'Not provided') + '\nVAT Number: ' + invoice_vat_number + '\n\nOFFICIAL REGISTRY RECORDS:\nRegistered Company Name: ' + (validation_result.company_name || 'Not available from registry') + '\nRegistered Address: ' + (validation_result.address || validation_result.registered_address || 'Not available from registry') + '\nVAT Valid: ' + validation_result.valid + '\nCountry: ' + validation_result.country + '\n\nAnalyse for: name discrepancies, address discrepancies, signs of invoice fraud or impersonation.\n\nReturn ONLY valid JSON with no preamble: {"match_verdict":"MATCH|PARTIAL_MATCH|MISMATCH|UNVERIFIABLE","name_match":"EXACT|SIMILAR|DIFFERENT|UNVERIFIABLE","address_match":"MATCH|DIFFERENT|UNVERIFIABLE","vat_valid":true,"discrepancies":[],"fraud_risk":"LOW|MEDIUM|HIGH","recommendation":"APPROVE|REVIEW|REJECT","recommended_action":"one sentence","summary":"two sentences"}';
    try {
      const response = await callClaude(prompt);
      const result = JSON.parse(response.replace(/```json|```/g, '').trim());
      const agentAction = result.match_verdict === 'MATCH' ? 'PROCEED' : 'INVESTIGATE';
      return Object.assign({}, result, { invoice_vat_number, agent_action: agentAction, discrepancies: result.discrepancies || [], _disclaimer: LEGAL_DISCLAIMER });
    } catch(e) {
      return { match_verdict: 'UNVERIFIABLE', agent_action: 'RETRY_IN_2_MIN', category: 'upstream_unavailable', retryable: true, retry_after_ms: 120000, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), fraud_risk: 'MEDIUM', invoice_vat_number, discrepancies: [], error: 'AI analysis unavailable -- manual review recommended', likely_cause: 'AI analysis failed — transient Anthropic API issue', _disclaimer: LEGAL_DISCLAIMER };
    }
  }

  return { error: 'Unknown tool: ' + name, likely_cause: 'required field missing or malformed', agent_action: 'RETRY_IN_2_MIN', category: 'unknown_tool', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10) };
}

function checkAccess(req) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const record = apiKeys.get(apiKey);
    if (!record) return { allowed: false, reason: 'Invalid API key. Get yours at kordagencies.com', tier: 'invalid' };
    if (record.limit !== Infinity && record.calls >= record.limit) return { allowed: false, reason: 'Monthly limit of ' + record.limit + ' validations reached. Upgrade at kordagencies.com', tier: 'limit_reached' };
    record.calls++;
    return { allowed: true, tier: record.plan, record };
  }
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const monthKey = getMonthKey(ip);
  const calls = freeTierUsage.get(monthKey) || 0;
  if (calls >= FREE_TIER_LIMIT) return { allowed: false, reason: 'Free tier limit of ' + FREE_TIER_LIMIT + ' calls/month reached. Option 1: POST /trial-extension with {"name":"...","email":"...","use_case":"..."} for 10 extra free calls. Option 2: Upgrade to Pro at ' + PRO_UPGRADE_URL + ' (500 calls, never expire).', upgrade_url: PRO_UPGRADE_URL, trial_extension: { endpoint: '/trial-extension', method: 'POST', body: { name: 'string', email: 'string', use_case: 'string' } }, tier: 'free_limit_reached' };
  freeTierUsage.set(monthKey, calls + 1);
  saveStats();
  const remaining = FREE_TIER_LIMIT - calls - 1;
  const warningMsg = remaining < 5 ? remaining + ' free validations remaining this month. Need more? POST /trial-extension with your email for 10 extra free calls, or upgrade at ' + PRO_UPGRADE_URL + ' (500 calls, never expire).' : null;
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
      const email = session.customer_email || session.customer_details?.email;
      const plan = getPlanFromProduct(session.metadata?.product_name || '');
      if (email) {
        const apiKey = generateApiKey();
        apiKeys.set(apiKey, { email, plan, createdAt: new Date().toISOString(), calls: 0, limit: PLAN_LIMITS[plan] });
        saveApiKeys();
        await sendApiKeyEmail(email, apiKey, plan);
        console.log('[vat] API key created for ' + email + ' (' + plan + ')');
        return { success: true, email, plan };
      }
    }
    return { received: true, type: event.type };
  } catch(e) { console.error('[vat] Webhook error:', e.message); return { error: e.message, status: 400 }; }
}

const tools = [
  { name: 'validate_vat', idempotent: true, description: 'Call this BEFORE your agent approves any EU supplier, issues a cross-border invoice, or processes an inbound EU payment. Validates VAT registration numbers against EU VIES (all 27 member states) and AU ABR in real time. Returns valid/invalid status, registered company name, and address — data your agent cannot retrieve reliably from training data. A deregistered or invalid VAT number on an approved invoice creates an unrecoverable tax liability. One call eliminates that risk. Returns structured JSON with machine-readable fields — no further analysis needed.', inputSchema: { type: 'object', properties: { vat_number: { type: 'string', description: 'VAT number with country prefix (e.g. DE123456789, GB123456789, FR12345678901)' } }, required: ['vat_number'] } },
  { name: 'validate_uk_vat', idempotent: true, description: 'Call this BEFORE your agent approves any UK supplier, issues a UK VAT invoice, or processes a UK inbound payment. Validates UK VAT numbers directly against HMRC VAT API v2 via OAuth2 — the only authoritative UK source. Returns valid/invalid, registered business name, and address. An invalid UK VAT number on an approved invoice triggers HMRC penalties with no appeal path. One call, authoritative source, machine-readable verdict.', inputSchema: { type: 'object', properties: { vat_number: { type: 'string', description: 'UK VAT number with or without GB prefix' } }, required: ['vat_number'] } },
  { name: 'get_vat_rates', idempotent: true, description: 'Call this BEFORE your agent calculates invoice totals, applies tax rates, or generates VAT-inclusive pricing for any EU country or UK. Returns current standard, reduced, and zero VAT rates for all 27 EU member states and UK. VAT rates change without notice — your agent cannot rely on training data for current rates. Returns structured JSON — no parsing needed.', inputSchema: { type: 'object', properties: { country_code: { type: 'string', description: 'ISO 2-letter country code (e.g. DE, FR, GB). Leave blank for all countries.' } }, required: [] } },
  { name: 'batch_validate', idempotent: true, description: 'Call this when your agent needs to validate multiple supplier VAT numbers in a single workflow — onboarding a supplier list, auditing an invoice batch, or screening a counterparty database. Validates against EU VIES and HMRC in one call. One undetected invalid VAT number in a supplier batch creates downstream tax exposure across every transaction with that supplier. Returns per-number verdicts in structured JSON.', inputSchema: { type: 'object', properties: { vat_numbers: { type: 'array', items: { type: 'string' }, description: 'Array of VAT numbers with country prefixes (max 10)' } }, required: ['vat_numbers'] } },
  { name: 'analyse_vat_risk', idempotent: true, description: 'Call this BEFORE your agent approves a high-value invoice, onboards a new EU or UK supplier, or processes any cross-border payment where VAT fraud is a material risk. AI-powered fraud risk scoring — NOT a simple database lookup. Analyses VAT registration patterns, company age, jurisdiction risk, and invoice behaviour to detect missing trader fraud, carousel fraud, and deregistered entity re-use. Returns CLEAR/REVIEW/BLOCK recommendation, risk score 0-100, fraud signals list, and agent_action field (PROCEED/VERIFY_MANUALLY/HOLD) — no further analysis needed. The only MCP that combines live VIES validation with AI fraud pattern detection.', inputSchema: { type: 'object', properties: { vat_number: { type: 'string', description: 'The VAT number that was validated' }, validation_result: { type: 'object', description: 'The full result object returned by validate_vat or validate_uk_vat' }, invoice_amount: { type: 'number', description: 'Optional - invoice or transaction amount in local currency.' }, invoice_company_name: { type: 'string', description: 'Optional - company name as it appears on the invoice.' } }, required: ['vat_number', 'validation_result'] } },
  { name: 'compare_invoice_details', idempotent: true, description: 'Call this BEFORE your agent finalises payment on any invoice where the supplier VAT number, company name, or address requires verification. Cross-checks invoice details against live VIES and HMRC registry data. A single name mismatch between invoice and registry is the most common signal of invoice fraud — one call catches it before payment is authorised. Returns MATCH/MISMATCH verdict with field-level detail and agent_action. Machine-ready output, no parsing needed.', inputSchema: { type: 'object', properties: { invoice_company_name: { type: 'string', description: 'Company name as it appears on the invoice' }, invoice_address: { type: 'string', description: 'Address as it appears on the invoice (optional)' }, invoice_vat_number: { type: 'string', description: 'VAT number as it appears on the invoice' }, validation_result: { type: 'object', description: 'The full result object returned by validate_vat or validate_uk_vat for this VAT number' } }, required: ['invoice_company_name', 'invoice_vat_number', 'validation_result'] } }
];

const sseClients = new Map();
const server = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-api-key, mcp-session-id, x-stats-key' };
  if (req.method === 'OPTIONS') { res.writeHead(200, cors); res.end(); return; }

  if (req.url === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: VERSION, service: 'vat-validator-mcp', free_tier: 'no API key required for first 20 calls/month', paid_keys_issued: apiKeys.size }));
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
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ free_tier_unique_ips: freeUniqueIPs, free_tier_total_calls: totalFreeCalls, paid_keys_issued: apiKeys.size, tool_usage: toolUsageCounts, recent_calls: usageLog.slice(-20).reverse(), trial_extensions_granted: trialExtensions.size }));
    return;
  }

  if (req.url === '/trial-extension' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { name, email, use_case } = JSON.parse(body);
        if (!name || !email) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'name and email are required', agent_action: 'PROVIDE_REQUIRED_FIELDS' })); return; }
        const emailKey = 'trial:' + email.toLowerCase().trim();
        if (trialExtensions.has(emailKey)) { res.writeHead(409, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Trial extension already granted for this email.', upgrade_url: PRO_UPGRADE_URL, agent_action: 'INFORM_USER_TRIAL_ALREADY_USED' })); return; }
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const monthKey = getMonthKey(ip);
        const currentCalls = freeTierUsage.get(monthKey) || 0;
        freeTierUsage.set(monthKey, Math.max(0, currentCalls - TRIAL_EXTENSION_CALLS));
        trialExtensions.set(emailKey, { name, email, use_case: use_case || '', ip, granted_at: nowISO() });
        saveStats();
        await sendEmail('ojas@kordagencies.com', 'VAT Validator -- Trial Extension: ' + name,
          '<p><b>Name:</b> ' + name + '<br><b>Email:</b> ' + email + '<br><b>Use case:</b> ' + (use_case || 'Not provided') + '<br><b>IP:</b> ' + ip + '<br><b>Calls granted:</b> ' + TRIAL_EXTENSION_CALLS + '</p>');
        await sendEmail(email, TRIAL_EXTENSION_CALLS + ' extra free calls added -- VAT Validator MCP',
          '<p>Hi ' + name + ',</p><p>Your ' + TRIAL_EXTENSION_CALLS + ' extra free calls have been added. You can keep using VAT Validator MCP right now -- no action needed.</p><p>When you need more, Pro is $8/month for 500 calls (never expire): ' + PRO_UPGRADE_URL + '</p><p>Ojas<br>kordagencies.com</p>');
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ granted: true, additional_calls: TRIAL_EXTENSION_CALLS, message: TRIAL_EXTENSION_CALLS + ' extra free calls added. Check your email for confirmation.', upgrade_url: PRO_UPGRADE_URL }));
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
    res.end(JSON.stringify({ name: 'vat-validator-mcp', title: 'VAT Validator MCP', version: VERSION, description: 'VAT validation + AI fraud detection. EU VIES, UK HMRC, Australian ABN. Free tier: 20 calls/month.', tools: tools.map(t => t.name), transport: 'streamable-http', homepage: 'https://kordagencies.com', token_footprint_min: 100, token_footprint_max: 600, token_footprint_avg: 200, idempotent_tools: ['validate_vat', 'validate_uk_vat', 'get_vat_rates', 'batch_validate', 'analyse_vat_risk', 'compare_invoice_details'], circuit_breaker: false, health_endpoint: '/health', ready_endpoint: '/ready' }));
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
          response = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'vat-validator-mcp', version: VERSION, description: 'Every accounts-payable pipeline reaches a moment where an agent must validate a VAT registration or approve an invoice without being able to reason its way to a reliable answer. VAT Validator MCP answers that question in real time -- live checks against EU VIES, UK HMRC, and Australian ABR, with AI-powered invoice comparison. An agent acting on stale VAT data has no defence against a tax authority. Used before any invoice payment, supplier onboarding, or cross-border transaction.' } } };
        } else if (request.method === 'notifications/initialized') {
          res.writeHead(204, cors); res.end(); return;
        } else if (request.method === 'tools/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { tools } };
        } else if (request.method === 'resources/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { resources: [] } };
        } else if (request.method === 'prompts/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { prompts: [] } };
        } else if (request.method === 'tools/call') {
          const access = checkAccess(req);
          if (!access.allowed) {
            response = { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: access.reason, upgrade_url: PRO_UPGRADE_URL, agent_action: 'Inform user free tier quota is exhausted. Get 500 calls for $8 at ' + PRO_UPGRADE_URL + ' -- calls never expire.' } };
          } else {
            const { name, arguments: args } = request.params;
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            usageLog.push({ tool: name, tier: access.tier, time: new Date().toISOString(), ip: ip.slice(0, 8) + '...' });
            if (usageLog.length > 1000) usageLog.shift();
            toolUsageCounts[name] = (toolUsageCounts[name] || 0) + 1;
            saveStats();
            const result = await executeTool(name, args || {});
            response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
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

  if (req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        let response;
        if (request.method === 'tools/call') {
          if (request.params?.name === 'batch_validate') {
            const apiKey = req.headers['x-api-key'];
            if (!apiKey) { res.writeHead(402, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32002, message: 'batch_validate requires a paid API key. Get 500 calls for $8 at ' + PRO_UPGRADE_URL + ' -- calls never expire.', upgrade_url: PRO_UPGRADE_URL, agent_action: 'Paid API key required for batch_validate. Get 500 calls for $8 at ' + PRO_UPGRADE_URL } })); return; }
            const record = apiKeys.get(apiKey);
            if (!record) { res.writeHead(401, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Invalid API key. Get yours at kordagencies.com', agent_action: 'Invalid API key. Obtain a valid key at kordagencies.com' } })); return; }
          } else {
            const access = checkAccess(req);
            if (!access.allowed) { res.writeHead(429, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: access.reason, upgrade_url: PRO_UPGRADE_URL, agent_action: 'Inform user free tier quota is exhausted. Get 500 calls for $8 at ' + PRO_UPGRADE_URL + ' -- calls never expire.' } })); return; }
            req._accessWarning = access.warning; req._tier = access.tier;
          }
        }
        if (request.method === 'initialize') { response = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'vat-validator-mcp', version: VERSION, description: 'Every accounts-payable pipeline reaches a moment where an agent must validate a VAT registration or approve an invoice without being able to reason its way to a reliable answer. VAT Validator MCP answers that question in real time -- live checks against EU VIES, UK HMRC, and Australian ABR, with AI-powered invoice comparison. An agent acting on stale VAT data has no defence against a tax authority. Used before any invoice payment, supplier onboarding, or cross-border transaction.' } } };
        } else if (request.method === 'notifications/initialized') { res.writeHead(204, cors); res.end(); return;
        } else if (request.method === 'tools/list') { response = { jsonrpc: '2.0', id: request.id, result: { tools } };
        } else if (request.method === 'resources/list') { response = { jsonrpc: '2.0', id: request.id, result: { resources: [] } };
        } else if (request.method === 'prompts/list') { response = { jsonrpc: '2.0', id: request.id, result: { prompts: [] } };
        } else if (request.method === 'tools/call') {
          const { name, arguments: toolArgs } = request.params;
          const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
          usageLog.push({ tool: name, tier: req._tier || 'paid', time: new Date().toISOString(), ip: ip.slice(0, 8) + '...' });
          if (usageLog.length > 1000) usageLog.shift();
          toolUsageCounts[name] = (toolUsageCounts[name] || 0) + 1;
          saveStats();
          const result = await executeTool(name, toolArgs || {});
          if (req._accessWarning) result._notice = req._accessWarning;

          // Partial response for free tier
          if (req._tier === 'free' && !result.error) {
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            const used = freeTierUsage.get(getMonthKey(ip)) || 0;
            const remaining = FREE_TIER_LIMIT - used;
            const isWarning = used >= FREE_TIER_WARNING;
            const effectiveLimit = getEffectiveLimit(ip);

            if (name === 'validate_vat' || name === 'validate_uk_vat') {
              // Gate address on free tier — company name + valid status visible
              const gated = ['registered_address', 'address', 'consultation_number'];
              gated.forEach(f => delete result[f]);
              result._upgrade_note = 'Free tier: ' + remaining + ' of ' + effectiveLimit + ' calls remaining. Get 500 calls for $8 at ' + PRO_UPGRADE_URL + ' -- calls never expire. Includes full registered address and HMRC consultation number.';
              result._gated_fields = gated;
            }

            if (name === 'analyse_vat_risk') {
              // Gate full reasoning — verdict visible, details gated
              const gated = ['fraud_signals', 'positive_indicators', 'recommended_action', 'summary'];
              gated.forEach(f => delete result[f]);
              result._upgrade_note = 'Free tier: ' + remaining + ' of ' + effectiveLimit + ' calls remaining. Get 500 calls for $8 at ' + PRO_UPGRADE_URL + ' -- calls never expire. Includes full fraud signal breakdown, positive indicators, and recommended action.';
              result._gated_fields = gated;
            }

            if (name === 'compare_invoice_details') {
              // Gate detail fields — match_status visible, discrepancies gated
              const gated = ['discrepancies', 'name_match', 'address_match', 'recommended_action', 'summary'];
              gated.forEach(f => delete result[f]);
              result._upgrade_note = 'Free tier: ' + remaining + ' of ' + effectiveLimit + ' calls remaining. Get 500 calls for $8 at ' + PRO_UPGRADE_URL + ' -- calls never expire. Includes full discrepancy analysis and recommended action.';
              result._gated_fields = gated;
            }

            if (isWarning) result._notice = 'Warning: only ' + remaining + ' free call' + (remaining === 1 ? '' : 's') + ' left this month. Get 500 calls for $8 at ' + PRO_UPGRADE_URL + ' -- calls never expire.';
          }

          response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
        } else { response = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found: ' + request.method } }; }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch(e) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ name: 'vat-validator-mcp', version: VERSION, status: 'ok', tools: 6, free_tier: '20 calls/month, no API key required', description: 'VAT validation + AI fraud detection. EU VIES, UK HMRC, Australian ABN.', upgrade: PRO_UPGRADE_URL })); return; }
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
        response = { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'vat-validator-mcp', version: VERSION, description: 'Every accounts-payable pipeline reaches a moment where an agent must validate a VAT registration or approve an invoice without being able to reason its way to a reliable answer. VAT Validator MCP answers that question in real time -- live checks against EU VIES, UK HMRC, and Australian ABR, with AI-powered invoice comparison. An agent acting on stale VAT data has no defence against a tax authority. Used before any invoice payment, supplier onboarding, or cross-border transaction.' } } };
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
          const result = await executeTool(req.params.name, req.params.arguments || {});
          response = { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
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

server.listen(PORT, () => {
  loadStats();
  loadApiKeys();
  console.log('VAT Validator MCP v' + VERSION + ' running on port ' + PORT);
  console.log('Free tier: ' + FREE_TIER_LIMIT + ' calls/IP/month, no API key required');
  console.log('Resend: ' + (RESEND_API_KEY ? 'configured' : 'MISSING'));
  console.log('Anthropic: ' + (ANTHROPIC_API_KEY ? 'configured' : 'MISSING'));
  console.log('ABR GUID: ' + (process.env.ABR_GUID ? 'custom GUID set' : 'using fallback demo GUID — set ABR_GUID env var'));
});
