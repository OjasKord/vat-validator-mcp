const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const PERSIST_FILE = '/tmp/vat_stats.json';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const PORT = process.env.PORT || 3000;
const STATS_KEY = process.env.STATS_KEY || 'ojas2026';

const freeTierUsage = new Map();
const usageLog = [];
const FREE_TIER_LIMIT = 20;
const apiKeys = new Map();
const PLAN_LIMITS = { pro: 5000, enterprise: Infinity };

function saveStats() {
  try {
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({
      freeTierUsage: Array.from(freeTierUsage.entries()),
      usageLog: usageLog.slice(-1000)
    }));
  } catch(e) { console.error('Stats save error:', e.message); }
}

function loadStats() {
  try {
    if (fs.existsSync(PERSIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
      if (data.freeTierUsage) data.freeTierUsage.forEach(([k, v]) => freeTierUsage.set(k, v));
      if (data.usageLog) usageLog.push(...data.usageLog);
      console.log(`Stats loaded: ${freeTierUsage.size} IPs, ${usageLog.length} calls`);
    }
  } catch(e) { console.error('Stats load error:', e.message); }
}

function generateApiKey() { return 'vat_' + crypto.randomBytes(24).toString('hex'); }

function getPlanFromProduct(name) {
  if (!name) return 'pro';
  return name.toLowerCase().includes('enterprise') ? 'enterprise' : 'pro';
}

async function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: 'VAT Validator MCP <ojas@kordagencies.com>', to: [to], subject, html });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body); req.end();
  });
}

async function sendApiKeyEmail(email, apiKey, plan) {
  const planLabel = plan === 'enterprise' ? 'Enterprise' : 'Pro';
  const limit = plan === 'enterprise' ? 'Unlimited' : '5,000';
  const html = `<!DOCTYPE html><html><body style="font-family:monospace;background:#080A0F;color:#E8EDF5;padding:40px;max-width:600px;margin:0 auto"><div style="border:1px solid rgba(0,229,195,0.3);border-radius:8px;padding:32px"><div style="color:#00E5C3;font-size:13px;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:24px">VAT Validator MCP - ${planLabel} Plan</div><h1 style="font-size:24px;font-weight:700;margin-bottom:8px;color:#FFFFFF">Your API key is ready.</h1><p style="color:#8A95A8;margin-bottom:32px">Welcome to VAT Validator MCP. Here is everything you need to get started.</p><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#5A6478;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:8px">Your API Key</div><div style="color:#00E5C3;font-size:14px;word-break:break-all;font-weight:500">${apiKey}</div></div><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#5A6478;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:12px">Add to your MCP config</div><div style="color:#86EFAC;font-size:12px;line-height:2">{<br>&nbsp;&nbsp;"vat-validator": {<br>&nbsp;&nbsp;&nbsp;&nbsp;"url": "https://vat-validator-mcp-production.up.railway.app",<br>&nbsp;&nbsp;&nbsp;&nbsp;"headers": { "x-api-key": "${apiKey}" }<br>&nbsp;&nbsp;}<br>}</div></div><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#5A6478;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:12px">Your Plan</div><div style="color:#E8EDF5;font-size:13px;line-height:2">Plan: ${planLabel}<br>VAT validations: ${limit}/month<br>Batch validation: ${plan === 'enterprise' ? 'Included' : 'Up to 10 per call'}<br>All tools included</div></div><div style="background:#0D1219;border:1px solid rgba(255,255,255,0.07);border-radius:6px;padding:16px;margin-bottom:24px;font-size:11px;color:#5A6478;line-height:1.7">By using your API key you agree to the VAT Validator MCP Terms of Service at <a href="https://kordagencies.com/terms.html" style="color:#00E5C3">kordagencies.com/terms.html</a>. Results are provided for informational purposes only and do not constitute legal or tax advice. You must independently verify all results with a qualified tax advisor before making compliance decisions. Provider maximum liability is limited to subscription fees paid in the preceding 3 months.</div><p style="color:#5A6478;font-size:12px">Questions? Email ojas@kordagencies.com</p><p style="color:#5A6478;font-size:12px;margin-top:8px">Ojas, Kordagencies</p></div></body></html>`;
  return sendEmail(email, `Your VAT Validator MCP ${planLabel} API Key`, html);
}

// Validate EU VAT number via VIES REST API
async function validateVIES(countryCode, vatNumber) {
  return new Promise((resolve) => {
    const path = `/taxation_customs/vies/rest-api/ms/${countryCode}/vat/${vatNumber}`;
    const req = https.request({
      hostname: 'ec.europa.eu', path, method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'VAT-Validator-MCP/1.0' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ source: 'VIES', data: JSON.parse(d) }); }
        catch(e) { resolve({ source: 'VIES', error: 'Parse error', raw: d.slice(0, 200) }); }
      });
    });
    req.on('error', e => resolve({ source: 'VIES', error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ source: 'VIES', error: 'Timeout — VIES unavailable, try again later' }); });
    req.end();
  });
}

// Validate UK VAT number via HMRC API (no key needed for basic check)
async function validateHMRC(vatNumber) {
  return new Promise((resolve) => {
    const clean = vatNumber.replace(/^GB/i, '').replace(/\s/g, '');
    const req = https.request({
      hostname: 'api.service.hmrc.gov.uk',
      path: `/organisations/vat/check-vat-number/lookup/${clean}`,
      method: 'GET',
      headers: { 'Accept': 'application/vnd.hmrc.1.0+json' }
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

// Validate Australian ABN via ABR API
async function validateABN(abn) {
  return new Promise((resolve) => {
    const clean = abn.replace(/\s/g, '');
    const path = `/json/?abn=${clean}&guid=f7b75e2e-6d6a-4c1c-a8d4-5b2e3c9d8f4a`;
    const req = https.request({
      hostname: 'abr.business.gov.au', path, method: 'GET',
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

// Detect country from VAT number prefix and route appropriately
function detectCountry(vatNumber) {
  const clean = vatNumber.trim().toUpperCase().replace(/\s/g, '');
  if (clean.startsWith('GB')) return { country: 'GB', type: 'uk', number: clean.slice(2) };
  if (clean.startsWith('AU') || /^\d{11}$/.test(clean)) return { country: 'AU', type: 'au', number: clean };
  // EU country codes
  const euCodes = ['AT','BE','BG','CY','CZ','DE','DK','EE','EL','ES','FI','FR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'];
  for (const code of euCodes) {
    if (clean.startsWith(code)) return { country: code, type: 'eu', number: clean.slice(2) };
  }
  return { country: null, type: 'unknown', number: clean };
}

const LEGAL_DISCLAIMER = 'Results are for informational purposes only and do not constitute legal or tax advice. Operator must independently verify all results with a qualified tax advisor before making compliance decisions. A VALID result does not guarantee compliance with all applicable tax laws. Provider maximum liability is limited to subscription fees paid in the preceding 3 months. Full terms: kordagencies.com/terms.html';

const VAT_RATES = {
  AT: { standard: 20, reduced: [10, 13], country: 'Austria' },
  BE: { standard: 21, reduced: [6, 12], country: 'Belgium' },
  BG: { standard: 20, reduced: [9], country: 'Bulgaria' },
  CY: { standard: 19, reduced: [5, 9], country: 'Cyprus' },
  CZ: { standard: 21, reduced: [12], country: 'Czech Republic' },
  DE: { standard: 19, reduced: [7], country: 'Germany' },
  DK: { standard: 25, reduced: [], country: 'Denmark' },
  EE: { standard: 22, reduced: [9], country: 'Estonia' },
  EL: { standard: 24, reduced: [6, 13], country: 'Greece' },
  ES: { standard: 21, reduced: [4, 10], country: 'Spain' },
  FI: { standard: 25.5, reduced: [10, 14], country: 'Finland' },
  FR: { standard: 20, reduced: [5.5, 10], country: 'France' },
  HR: { standard: 25, reduced: [5, 13], country: 'Croatia' },
  HU: { standard: 27, reduced: [5, 18], country: 'Hungary' },
  IE: { standard: 23, reduced: [9, 13.5], country: 'Ireland' },
  IT: { standard: 22, reduced: [4, 5, 10], country: 'Italy' },
  LT: { standard: 21, reduced: [5, 9], country: 'Lithuania' },
  LU: { standard: 17, reduced: [3, 8, 14], country: 'Luxembourg' },
  LV: { standard: 21, reduced: [5, 12], country: 'Latvia' },
  MT: { standard: 18, reduced: [5, 7], country: 'Malta' },
  NL: { standard: 21, reduced: [9], country: 'Netherlands' },
  PL: { standard: 23, reduced: [5, 8], country: 'Poland' },
  PT: { standard: 23, reduced: [6, 13], country: 'Portugal' },
  RO: { standard: 19, reduced: [5, 9], country: 'Romania' },
  SE: { standard: 25, reduced: [6, 12], country: 'Sweden' },
  SI: { standard: 22, reduced: [5, 9.5], country: 'Slovenia' },
  SK: { standard: 20, reduced: [10], country: 'Slovakia' },
  GB: { standard: 20, reduced: [5], country: 'United Kingdom' },
  AU: { standard: 10, reduced: [], country: 'Australia' }
};

async function executeTool(name, args) {

  if (name === 'validate_vat') {
    const { vat_number } = args;
    if (!vat_number) return { error: 'vat_number is required' };

    const detected = detectCountry(vat_number);

    if (detected.type === 'uk') {
      const result = await validateHMRC(detected.number);
      if (result.error) return {
        valid: null, vat_number, country: 'GB', source: 'HMRC',
        error: result.error, retry: true,
        _disclaimer: LEGAL_DISCLAIMER
      };
      const d = result.data;
      if (result.status === 200 && d.target) {
        return {
          valid: true, vat_number, country: 'GB',
          company_name: d.target.name || null,
          address: d.target.vatNumber ? `GB${d.target.vatNumber}` : null,
          source: 'HMRC', consultation_number: d.consultationNumber || null,
          _disclaimer: LEGAL_DISCLAIMER
        };
      }
      return { valid: false, vat_number, country: 'GB', source: 'HMRC', reason: d.code || 'VAT number not found', _disclaimer: LEGAL_DISCLAIMER };
    }

    if (detected.type === 'eu') {
      const result = await validateVIES(detected.country, detected.number);
      if (result.error) return {
        valid: null, vat_number, country: detected.country, source: 'VIES',
        error: result.error, retry: result.error.includes('Timeout'),
        note: 'VIES experiences frequent downtime during filing periods. Retry in 30 minutes or use batch_validate during off-peak hours.',
        _disclaimer: LEGAL_DISCLAIMER
      };
      const d = result.data;
      return {
        valid: d.isValid || false, vat_number, country: detected.country,
        company_name: d.traderName || null,
        address: d.traderAddress || null,
        source: 'VIES',
        request_date: d.requestDate || null,
        _disclaimer: LEGAL_DISCLAIMER
      };
    }

    if (detected.type === 'au') {
      const result = await validateABN(detected.number);
      if (result.error) return { valid: null, vat_number, country: 'AU', source: 'ABR', error: result.error, _disclaimer: LEGAL_DISCLAIMER };
      const d = result.data;
      const isValid = d.Abn && d.AbnStatus === 'Active';
      return {
        valid: isValid, vat_number, country: 'AU',
        company_name: d.EntityName || null,
        abn_status: d.AbnStatus || null,
        entity_type: d.EntityTypeName || null,
        source: 'ABR',
        _disclaimer: LEGAL_DISCLAIMER
      };
    }

    return {
      valid: null, vat_number,
      error: 'Could not detect country from VAT number prefix. Supported: EU (AT, BE, BG, CY, CZ, DE, DK, EE, EL, ES, FI, FR, HR, HU, IE, IT, LT, LU, LV, MT, NL, PL, PT, RO, SE, SI, SK), UK (GB), Australia (AU).',
      _disclaimer: LEGAL_DISCLAIMER
    };
  }

  if (name === 'validate_uk_vat') {
    const { vat_number } = args;
    if (!vat_number) return { error: 'vat_number is required' };
    const result = await validateHMRC(vat_number);
    if (result.error) return { valid: null, vat_number, source: 'HMRC', error: result.error, _disclaimer: LEGAL_DISCLAIMER };
    const d = result.data;
    if (result.status === 200 && d.target) {
      return {
        valid: true, vat_number,
        company_name: d.target.name || null,
        registered_address: d.target.address ? Object.values(d.target.address).filter(Boolean).join(', ') : null,
        consultation_number: d.consultationNumber || null,
        source: 'HMRC',
        _disclaimer: LEGAL_DISCLAIMER
      };
    }
    return { valid: false, vat_number, source: 'HMRC', reason: d.code || 'VAT number not found or not registered', _disclaimer: LEGAL_DISCLAIMER };
  }

  if (name === 'get_vat_rates') {
    const { country_code } = args;
    if (!country_code) {
      return {
        rates: VAT_RATES,
        note: 'VAT rates as of 2026. Rates change periodically — verify with official tax authority before use.',
        _disclaimer: LEGAL_DISCLAIMER
      };
    }
    const code = country_code.toUpperCase();
    const rate = VAT_RATES[code];
    if (!rate) return { error: `No VAT rate data for country code: ${code}. Supported: ${Object.keys(VAT_RATES).join(', ')}`, _disclaimer: LEGAL_DISCLAIMER };
    return { country_code: code, ...rate, note: 'Verify current rates with official tax authority before use.', _disclaimer: LEGAL_DISCLAIMER };
  }

  if (name === 'batch_validate') {
    const { vat_numbers } = args;
    if (!vat_numbers || !Array.isArray(vat_numbers)) return { error: 'vat_numbers must be an array' };
    if (vat_numbers.length > 10) return { error: 'Maximum 10 VAT numbers per batch call. For larger batches upgrade to Enterprise plan at kordagencies.com' };
    const results = await Promise.all(vat_numbers.map(async (vat) => {
      try {
        return await executeTool('validate_vat', { vat_number: vat });
      } catch(e) {
        return { vat_number: vat, valid: null, error: e.message };
      }
    }));
    const summary = {
      total: results.length,
      valid: results.filter(r => r.valid === true).length,
      invalid: results.filter(r => r.valid === false).length,
      error: results.filter(r => r.valid === null).length
    };
    return { summary, results, _disclaimer: LEGAL_DISCLAIMER };
  }

  return { error: 'Unknown tool: ' + name };
}

function checkAccess(req) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const record = apiKeys.get(apiKey);
    if (!record) return { allowed: false, reason: 'Invalid API key. Get yours at kordagencies.com', tier: 'invalid' };
    if (record.limit !== Infinity && record.calls >= record.limit) {
      return { allowed: false, reason: `Monthly limit of ${record.limit} validations reached. Upgrade at kordagencies.com`, tier: 'limit_reached' };
    }
    record.calls++;
    return { allowed: true, tier: record.plan, record };
  }
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const calls = freeTierUsage.get(ip) || 0;
  if (calls >= FREE_TIER_LIMIT) {
    return { allowed: false, reason: `Free tier limit of ${FREE_TIER_LIMIT} VAT validations/month reached. Upgrade to Pro ($99/month) at kordagencies.com for 5,000 validations/month.`, upgrade_url: 'https://kordagencies.com', tier: 'free_limit_reached' };
  }
  freeTierUsage.set(ip, calls + 1);
  saveStats();
  const remaining = FREE_TIER_LIMIT - calls - 1;
  return { allowed: true, tier: 'free', remaining, warning: remaining < 5 ? `${remaining} free validations remaining this month. Upgrade at kordagencies.com` : null };
}

async function handleStripeWebhook(body) {
  try {
    const event = JSON.parse(body);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;
      const plan = getPlanFromProduct(session.metadata?.product_name || '');
      if (email) {
        const apiKey = generateApiKey();
        apiKeys.set(apiKey, { email, plan, createdAt: new Date().toISOString(), calls: 0, limit: PLAN_LIMITS[plan] });
        const emailResult = await sendApiKeyEmail(email, apiKey, plan);
        console.log(`API key created for ${email} (${plan}): ${apiKey}`);
        console.log('Email result:', JSON.stringify(emailResult));
        return { success: true, email, plan };
      }
    }
    return { received: true, type: event.type };
  } catch(e) {
    console.error('Webhook error:', e.message);
    return { error: e.message };
  }
}

const tools = [
  {
    name: 'validate_vat',
    description: 'Call this tool when your agent needs to verify a VAT number before generating a B2B invoice, onboarding an EU supplier, or completing an e-invoicing compliance check. Automatically detects the country from the number prefix and routes to the correct authority: EU VIES for all 27 EU member states, HMRC for UK (GB prefix), or ABR for Australia (AU prefix). Returns valid/invalid status, registered company name, and address. Required for EU ViDA e-invoicing compliance. LEGAL NOTICE: Results are informational only and do not constitute tax advice. Verify independently with a qualified tax advisor. Full terms: kordagencies.com/terms.html. Free tier: first 20 calls/month require no API key.',
    inputSchema: {
      type: 'object',
      properties: {
        vat_number: { type: 'string', description: 'VAT number including country prefix (e.g. DE123456789, GB123456789, FR12345678901, AU51824753556)' }
      },
      required: ['vat_number']
    }
  },
  {
    name: 'validate_uk_vat',
    description: 'Call this tool when your agent needs to validate a UK VAT number specifically against HMRC live records — for example before issuing a UK invoice, verifying a UK supplier, or completing UK tax compliance checks. Returns company name, registered address, and an HMRC consultation number for your audit trail. More detailed than validate_vat for UK numbers. LEGAL NOTICE: Results are informational only. Not a substitute for professional tax advice. Full terms: kordagencies.com/terms.html. Free tier: first 20 calls/month require no API key.',
    inputSchema: {
      type: 'object',
      properties: {
        vat_number: { type: 'string', description: 'UK VAT number — with or without GB prefix (e.g. GB123456789 or 123456789)' }
      },
      required: ['vat_number']
    }
  },
  {
    name: 'get_vat_rates',
    description: 'Call this tool when your agent needs to apply the correct VAT rate to an invoice, quote, or pricing calculation for a specific EU or UK country. Returns standard rate, all reduced rates, and country name. Covers all 27 EU member states plus UK and Australia. Use before calculating invoice totals when selling cross-border. LEGAL NOTICE: Rates are indicative only — verify current rates with official tax authority before use. Full terms: kordagencies.com/terms.html. Free tier: first 20 calls/month require no API key.',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'ISO 2-letter country code (e.g. DE, FR, GB, IT). Leave blank to get all countries.' }
      },
      required: []
    }
  },
  {
    name: 'batch_validate',
    description: 'Call this tool when your agent needs to validate multiple VAT numbers in a single call — for example when onboarding a batch of new suppliers, auditing an existing supplier list, or running periodic compliance checks on all active counterparties. Validates up to 10 VAT numbers simultaneously across any mix of EU, UK, and Australian numbers. Returns a summary (valid/invalid/error counts) plus individual results. LEGAL NOTICE: Results are informational only. Not a substitute for professional tax compliance review. Full terms: kordagencies.com/terms.html. Paid API key required.',
    inputSchema: {
      type: 'object',
      properties: {
        vat_numbers: { type: 'array', items: { type: 'string' }, description: 'Array of VAT numbers to validate (max 10). Include country prefix for each (e.g. ["DE123456789", "GB123456789", "FR12345678901"])' }
      },
      required: ['vat_numbers']
    }
  }
];

const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, mcp-session-id, x-stats-key'
  };

  if (req.method === 'OPTIONS') { res.writeHead(200, cors); res.end(); return; }

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '1.1.0', service: 'vat-validator-mcp', free_tier: 'no API key required for first 20 calls/month', paid_keys_issued: apiKeys.size }));
    return;
  }

  if (req.url === '/stats' && req.method === 'GET') {
    if (req.headers['x-stats-key'] !== STATS_KEY) { res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const totalFreeCalls = Array.from(freeTierUsage.values()).reduce((a, b) => a + b, 0);
    const toolCounts = {};
    usageLog.forEach(e => { toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1; });
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      free_tier_unique_ips: freeTierUsage.size,
      free_tier_total_calls: totalFreeCalls,
      paid_keys_issued: apiKeys.size,
      tool_usage: toolCounts,
      recent_calls: usageLog.slice(-20).reverse()
    }));
    return;
  }

  if (req.url === '/webhook/stripe' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      const result = await handleStripeWebhook(body);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        let response;

        if (request.method !== 'initialize' && request.method !== 'notifications/initialized') {
          if (request.method === 'tools/call' && request.params?.name === 'batch_validate') {
            // batch_validate requires paid key
            const apiKey = req.headers['x-api-key'];
            if (!apiKey) {
              res.writeHead(402, { ...cors, 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32002, message: 'batch_validate requires a paid API key. Get yours at kordagencies.com — Pro $99/month for 5,000 validations.', upgrade_url: 'https://kordagencies.com' } }));
              return;
            }
            const record = apiKeys.get(apiKey);
            if (!record) {
              res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Invalid API key. Get yours at kordagencies.com' } }));
              return;
            }
          } else {
            const access = checkAccess(req);
            if (!access.allowed) {
              res.writeHead(429, { ...cors, 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: access.reason, upgrade_url: 'https://kordagencies.com' } }));
              return;
            }
            req._accessWarning = access.warning;
            req._tier = access.tier;
          }
        }

        if (request.method === 'initialize') {
          response = { jsonrpc: '2.0', id: request.id, result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'vat-validator-mcp', version: '1.1.0', description: 'VAT number validation for AI agents. Validates EU VIES, UK HMRC, and Australian ABN in one call. Required for EU ViDA e-invoicing compliance. Free tier: 20 validations/month.' }
          }};
        } else if (request.method === 'notifications/initialized') {
          res.writeHead(204, cors); res.end(); return;
        } else if (request.method === 'tools/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { tools } };
        } else if (request.method === 'resources/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { resources: [] } };
        } else if (request.method === 'prompts/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { prompts: [] } };
        } else if (request.method === 'tools/call') {
          const { name, arguments: args } = request.params;
          const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
          usageLog.push({ tool: name, tier: req._tier || 'paid', time: new Date().toISOString(), ip: ip.slice(0, 8) + '...' });
          if (usageLog.length > 1000) usageLog.shift();
          saveStats();
          const result = await executeTool(name, args || {});
          if (req._accessWarning) result._notice = req._accessWarning;
          response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
        } else {
          response = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found: ' + request.method } };
        }

        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch(e) {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'vat-validator-mcp', version: '1.1.0', status: 'ok', tools: 4, free_tier: '20 validations/month, no API key required', description: 'VAT number validation for AI agents. EU VIES, UK HMRC, Australian ABN. Required for EU ViDA e-invoicing compliance.', upgrade: 'https://kordagencies.com' }));
    return;
  }

  res.writeHead(404, cors); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  loadStats();
  console.log(`VAT Validator MCP v1.1.0 running on port ${PORT}`);
  console.log(`Free tier: ${FREE_TIER_LIMIT} validations/IP/month, no API key required`);
  console.log(`Resend: ${RESEND_API_KEY ? 'configured' : 'MISSING'}`);
});
