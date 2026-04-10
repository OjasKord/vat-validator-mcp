const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const PERSIST_FILE = '/tmp/vat_stats.json';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
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
      console.log('Stats loaded: ' + freeTierUsage.size + ' IPs, ' + usageLog.length + ' calls');
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
    const body = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] });
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

async function validateHMRC(vatNumber) {
  return new Promise((resolve) => {
    const clean = vatNumber.replace(/^GB/i, '').replace(/\s/g, '');
    const req = https.request({
      hostname: 'api.service.hmrc.gov.uk',
      path: '/organisations/vat/check-vat-number/lookup/' + clean,
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

async function validateABN(abn) {
  return new Promise((resolve) => {
    const clean = abn.replace(/\s/g, '');
    const req = https.request({
      hostname: 'abr.business.gov.au',
      path: '/json/?abn=' + clean + '&guid=f7b75e2e-6d6a-4c1c-a8d4-5b2e3c9d8f4a',
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

function nowISO() { return new Date().toISOString(); }

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
    if (!vat_number) return { error: 'vat_number is required' };
    const detected = detectCountry(vat_number);
    if (detected.type === 'uk') {
      const result = await validateHMRC(detected.number);
      if (result.error) return { valid: null, vat_number, country: 'GB', source: 'HMRC', error: result.error, retry: true, _disclaimer: LEGAL_DISCLAIMER };
      const d = result.data;
      if (result.status === 200 && d.target) return { valid: true, vat_number, country: 'GB', company_name: d.target.name || null, source: 'HMRC', source_url: 'api.service.hmrc.gov.uk', consultation_number: d.consultationNumber || null, checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
      return { valid: false, vat_number, country: 'GB', source: 'HMRC', source_url: 'api.service.hmrc.gov.uk', reason: d.code || 'VAT number not found', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    }
    if (detected.type === 'eu') {
      const result = await validateVIES(detected.country, detected.number);
      if (result.error) return { valid: null, vat_number, country: detected.country, source: 'VIES', source_url: 'ec.europa.eu/taxation_customs/vies', error: 'EU VIES portal is temporarily unavailable — this is a known issue with the official EU system, not a problem with the VAT number. Retry in 30 minutes.', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
      const d = result.data;
      return { valid: d.isValid || false, vat_number, country: detected.country, company_name: d.traderName || null, address: d.traderAddress || null, source: 'VIES', source_url: 'ec.europa.eu/taxation_customs/vies', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    }
    if (detected.type === 'au') {
      const result = await validateABN(detected.number);
      if (result.error) return { valid: null, vat_number, country: 'AU', source: 'ABR', error: result.error, _disclaimer: LEGAL_DISCLAIMER };
      const d = result.data;
      return { valid: !!(d.Abn && d.AbnStatus === 'Active'), vat_number, country: 'AU', company_name: d.EntityName || null, abn_status: d.AbnStatus || null, source: 'ABR', source_url: 'abr.business.gov.au', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    }
    return { valid: null, vat_number, error: 'Could not detect country. Supported prefixes: EU (AT BE BG CY CZ DE DK EE EL ES FI FR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK), UK (GB), Australia (AU).', _disclaimer: LEGAL_DISCLAIMER };
  }

  if (name === 'validate_uk_vat') {
    const vat_number = args.vat_number;
    const checkedAt = nowISO();
    if (!vat_number) return { error: 'vat_number is required' };
    const result = await validateHMRC(vat_number);
    if (result.error) return { valid: null, vat_number, source: 'HMRC', source_url: 'api.service.hmrc.gov.uk', error: 'UK HMRC API is temporarily unavailable — this is not a problem with the VAT number. Retry in a few minutes.', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    const d = result.data;
    if (result.status === 200 && d.target) return { valid: true, vat_number, company_name: d.target.name || null, registered_address: d.target.address ? Object.values(d.target.address).filter(Boolean).join(', ') : null, consultation_number: d.consultationNumber || null, source: 'HMRC', source_url: 'api.service.hmrc.gov.uk', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    return { valid: false, vat_number, source: 'HMRC', source_url: 'api.service.hmrc.gov.uk', reason: d.code || 'VAT number not found', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
  }

  if (name === 'get_vat_rates') {
    const country_code = args.country_code;
    const checkedAt = nowISO();
    if (!country_code) return { rates: VAT_RATES, note: 'VAT rates as of 2026. Verify with official tax authority before use.', source_url: 'kordagencies.com', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    const code = country_code.toUpperCase();
    const rate = VAT_RATES[code];
    if (!rate) return { error: 'No VAT rate data for: ' + code + '. Supported: ' + Object.keys(VAT_RATES).join(', '), _disclaimer: LEGAL_DISCLAIMER };
    return Object.assign({ country_code: code }, rate, { note: 'Verify current rates with official tax authority before use.', source_url: 'kordagencies.com', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER });
  }

  if (name === 'batch_validate') {
    const vat_numbers = args.vat_numbers;
    if (!vat_numbers || !Array.isArray(vat_numbers)) return { error: 'vat_numbers must be an array' };
    if (vat_numbers.length > 10) return { error: 'Maximum 10 VAT numbers per batch. Upgrade to Enterprise at kordagencies.com for unlimited batches.' };
    const results = await Promise.all(vat_numbers.map(async (vat) => {
      try { return await executeTool('validate_vat', { vat_number: vat }); }
      catch(e) { return { vat_number: vat, valid: null, error: e.message }; }
    }));
    return { summary: { total: results.length, valid: results.filter(r => r.valid === true).length, invalid: results.filter(r => r.valid === false).length, error: results.filter(r => r.valid === null).length }, results, _disclaimer: LEGAL_DISCLAIMER };
  }

  if (name === 'analyse_vat_risk') {
    const vat_number = args.vat_number;
    const validation_result = args.validation_result;
    const invoice_amount = args.invoice_amount;
    const invoice_company_name = args.invoice_company_name;
    if (!vat_number || !validation_result) return { error: 'vat_number and validation_result are required' };
    const amountStr = invoice_amount ? String(invoice_amount) : 'Not provided';
    const nameStr = invoice_company_name || 'Not provided';
    const regName = validation_result.company_name || 'Not available';
    const prompt = 'You are a B2B fraud detection specialist. Analyse this VAT validation result for fraud signals.\n\n' +
      'VAT Number: ' + vat_number + '\n' +
      'Validation Result: ' + JSON.stringify(validation_result) + '\n' +
      'Invoice Amount: ' + amountStr + '\n' +
      'Invoice Company Name: ' + nameStr + '\n' +
      'Registered Company Name: ' + regName + '\n' +
      'Valid: ' + validation_result.valid + '\n' +
      'Country: ' + validation_result.country + '\n\n' +
      'Analyse for: name mismatch between invoice and registry, recently registered company, dormant or dissolved status, high invoice amount relative to company size, address anomalies, shell company indicators.\n\n' +
      'Return ONLY valid JSON with no preamble: {"recommendation":"CLEAR|REVIEW|BLOCK","risk_level":"LOW|MEDIUM|HIGH|CRITICAL","risk_score":50,"fraud_signals":[],"positive_indicators":[],"recommended_action":"one sentence","summary":"two sentences"}';
    try {
      const response = await callClaude(prompt);
      const clean = response.replace(/```json|```/g, '').trim();
      const result = JSON.parse(clean);
      return Object.assign({}, result, { vat_number, _disclaimer: LEGAL_DISCLAIMER });
    } catch(e) {
      return { recommendation: 'REVIEW', risk_level: 'MEDIUM', risk_score: 50, vat_number, error: 'AI analysis unavailable - manual review recommended', _disclaimer: LEGAL_DISCLAIMER };
    }
  }

  if (name === 'compare_invoice_details') {
    const invoice_company_name = args.invoice_company_name;
    const invoice_address = args.invoice_address;
    const invoice_vat_number = args.invoice_vat_number;
    const validation_result = args.validation_result;
    if (!invoice_company_name || !invoice_vat_number || !validation_result) return { error: 'invoice_company_name, invoice_vat_number, and validation_result are required' };
    const regName = validation_result.company_name || 'Not available from registry';
    const regAddress = validation_result.address || validation_result.registered_address || 'Not available from registry';
    const addressStr = invoice_address || 'Not provided';
    const prompt = 'You are an invoice fraud detection specialist. Compare invoice details against official registry records.\n\n' +
      'INVOICE CLAIMS:\n' +
      'Company Name: ' + invoice_company_name + '\n' +
      'Address: ' + addressStr + '\n' +
      'VAT Number: ' + invoice_vat_number + '\n\n' +
      'OFFICIAL REGISTRY RECORDS:\n' +
      'Registered Company Name: ' + regName + '\n' +
      'Registered Address: ' + regAddress + '\n' +
      'VAT Valid: ' + validation_result.valid + '\n' +
      'Country: ' + validation_result.country + '\n\n' +
      'Analyse for: name discrepancies, address discrepancies, signs of invoice fraud or impersonation.\n\n' +
      'Return ONLY valid JSON with no preamble: {"match_status":"MATCH|PARTIAL_MATCH|MISMATCH|UNVERIFIABLE","name_match":"EXACT|SIMILAR|DIFFERENT|UNVERIFIABLE","address_match":"MATCH|DIFFERENT|UNVERIFIABLE","vat_valid":true,"discrepancies":[],"fraud_risk":"LOW|MEDIUM|HIGH","recommendation":"APPROVE|REVIEW|REJECT","recommended_action":"one sentence","summary":"two sentences"}';
    try {
      const response = await callClaude(prompt);
      const clean = response.replace(/```json|```/g, '').trim();
      const result = JSON.parse(clean);
      return Object.assign({}, result, { invoice_vat_number, _disclaimer: LEGAL_DISCLAIMER });
    } catch(e) {
      return { match_status: 'UNVERIFIABLE', fraud_risk: 'MEDIUM', invoice_vat_number, error: 'AI analysis unavailable - manual review recommended', _disclaimer: LEGAL_DISCLAIMER };
    }
  }

  return { error: 'Unknown tool: ' + name };
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
  const calls = freeTierUsage.get(ip) || 0;
  if (calls >= FREE_TIER_LIMIT) return { allowed: false, reason: 'Free tier limit of ' + FREE_TIER_LIMIT + ' validations/month reached. Upgrade to Pro ($99/month) at kordagencies.com for 5,000 validations/month.', upgrade_url: 'https://kordagencies.com', tier: 'free_limit_reached' };
  freeTierUsage.set(ip, calls + 1);
  saveStats();
  const remaining = FREE_TIER_LIMIT - calls - 1;
  return { allowed: true, tier: 'free', remaining, warning: remaining < 5 ? remaining + ' free validations remaining. Upgrade at kordagencies.com' : null };
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
        await sendApiKeyEmail(email, apiKey, plan);
        console.log('API key created for ' + email + ' (' + plan + ')');
        return { success: true, email, plan };
      }
    }
    return { received: true, type: event.type };
  } catch(e) { console.error('Webhook error:', e.message); return { error: e.message }; }
}

const tools = [
  { name: 'validate_vat', description: 'Call this tool any time your agent needs to confirm a business is real and legally registered before interacting with them. Use before onboarding a new supplier, customer, or contractor, before signing any B2B contract, before processing or issuing any invoice, before approving a vendor in procurement, or before enriching a CRM record with verified company data. The VAT number is the most reliable identifier for a registered EU, UK, or Australian business. Also use to catch fraud - scammers frequently use fake or stolen VAT numbers. Auto-detects country from prefix: EU VIES for all 27 EU states, HMRC for GB prefix, ABR for AU prefix. LEGAL NOTICE: Results are informational only, not tax advice. Full terms: kordagencies.com/terms.html. Free tier: first 20 calls/month, no API key needed.', inputSchema: { type: 'object', properties: { vat_number: { type: 'string', description: 'VAT number with country prefix (e.g. DE123456789, GB123456789, FR12345678901)' } }, required: ['vat_number'] } },
  { name: 'validate_uk_vat', description: 'Call this tool when your agent is dealing with a UK business and needs to confirm they are genuinely registered with HMRC before onboarding them, paying an invoice, or signing a contract. Returns company name, registered address, and an HMRC consultation number for your audit trail. Also use to verify the company name on an invoice matches the registered name - a mismatch is a fraud red flag. LEGAL NOTICE: Results are informational only, not tax advice. Full terms: kordagencies.com/terms.html. Free tier: first 20 calls/month, no API key needed.', inputSchema: { type: 'object', properties: { vat_number: { type: 'string', description: 'UK VAT number with or without GB prefix' } }, required: ['vat_number'] } },
  { name: 'get_vat_rates', description: 'Call this tool when your agent needs to calculate the correct tax amount for a B2B or B2C transaction involving an EU, UK, or Australian business. Use before generating any quote, invoice, or pricing calculation for cross-border sales. Returns standard rate and all reduced rates for any of the 27 EU member states, UK, or Australia. LEGAL NOTICE: Rates are indicative only - verify with official tax authority. Free tier: first 20 calls/month, no API key needed.', inputSchema: { type: 'object', properties: { country_code: { type: 'string', description: 'ISO 2-letter country code (e.g. DE, FR, GB). Leave blank for all countries.' } }, required: [] } },
  { name: 'batch_validate', description: 'Call this tool when your agent needs to verify multiple businesses at once - for supplier onboarding batches, auditing your entire vendor database, running monthly compliance checks, or cleaning a CRM import. Up to 10 VAT numbers per call across any mix of EU, UK, and Australian businesses. Run this monthly on all active vendors - registrations can lapse. LEGAL NOTICE: Results are informational only, not tax advice. Full terms: kordagencies.com/terms.html. Paid API key required.', inputSchema: { type: 'object', properties: { vat_numbers: { type: 'array', items: { type: 'string' }, description: 'Array of VAT numbers with country prefixes (max 10)' } }, required: ['vat_numbers'] } },
  { name: 'analyse_vat_risk', description: 'Call this tool after validate_vat returns a result, when your agent needs an AI-powered fraud risk assessment before proceeding with a transaction. Uses AI to synthesise registry data with transaction context to detect fraud signals that raw validation misses - this is NOT a simple database lookup. Returns a CLEAR/REVIEW/BLOCK recommendation with specific reasons. Catches: name mismatches between invoice and registry, newly registered companies with large invoice values, dormant status, shell company indicators, address anomalies. Use before approving any payment or signing any contract, especially with first-time counterparties. LEGAL NOTICE: Results are informational only, not fraud investigation advice. Full terms: kordagencies.com/terms.html. Free tier: first 20 calls/month, no API key needed.', inputSchema: { type: 'object', properties: { vat_number: { type: 'string', description: 'The VAT number that was validated' }, validation_result: { type: 'object', description: 'The full result object returned by validate_vat or validate_uk_vat' }, invoice_amount: { type: 'number', description: 'Optional - invoice or transaction amount in local currency. Helps AI assess risk relative to company size.' }, invoice_company_name: { type: 'string', description: 'Optional - company name as it appears on the invoice. Used to detect name mismatches with registry.' } }, required: ['vat_number', 'validation_result'] } },
  { name: 'compare_invoice_details', description: 'Call this tool when your agent has received an invoice and needs to verify the supplier details on the invoice match official government registry records. Uses AI to compare the company name, address, and VAT number claimed on the invoice against validated registry data, flagging any discrepancies that could indicate fraud, impersonation, or error. A mismatch between the name on an invoice and the registered name for that VAT number is one of the most common invoice fraud signals. Use before approving payment on any invoice from a supplier you have not previously verified. LEGAL NOTICE: Results are informational only, not fraud investigation advice. Full terms: kordagencies.com/terms.html. Free tier: first 20 calls/month, no API key needed.', inputSchema: { type: 'object', properties: { invoice_company_name: { type: 'string', description: 'Company name as it appears on the invoice' }, invoice_address: { type: 'string', description: 'Address as it appears on the invoice (optional)' }, invoice_vat_number: { type: 'string', description: 'VAT number as it appears on the invoice' }, validation_result: { type: 'object', description: 'The full result object returned by validate_vat or validate_uk_vat for this VAT number' } }, required: ['invoice_company_name', 'invoice_vat_number', 'validation_result'] } }
];

const server = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-api-key, mcp-session-id, x-stats-key' };
  if (req.method === 'OPTIONS') { res.writeHead(200, cors); res.end(); return; }
  if (req.url === '/health' && (req.method === 'GET' || req.method === 'HEAD') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', version: '1.3.1', service: 'vat-validator-mcp', free_tier: 'no API key required for first 20 calls/month', paid_keys_issued: apiKeys.size })); return; }
  if (req.url === '/stats' && req.method === 'GET') {
    if (req.headers['x-stats-key'] !== STATS_KEY) { res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const totalFreeCalls = Array.from(freeTierUsage.values()).reduce((a, b) => a + b, 0);
    const toolCounts = {};
    usageLog.forEach(e => { toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1; });
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ free_tier_unique_ips: freeTierUsage.size, free_tier_total_calls: totalFreeCalls, paid_keys_issued: apiKeys.size, tool_usage: toolCounts, recent_calls: usageLog.slice(-20).reverse() }));
    return;
  }
  if (req.url === '/webhook/stripe' && req.method === 'POST') { let body = ''; req.on('data', c => body += c); req.on('end', async () => { const result = await handleStripeWebhook(body); res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); }); return; }
  if (req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        let response;
        if (request.method !== 'initialize' && request.method !== 'notifications/initialized') {
          if (request.method === 'tools/call' && request.params?.name === 'batch_validate') {
            const apiKey = req.headers['x-api-key'];
            if (!apiKey) { res.writeHead(402, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32002, message: 'batch_validate requires a paid API key. Get yours at kordagencies.com - Pro $99/month.', upgrade_url: 'https://kordagencies.com' } })); return; }
            const record = apiKeys.get(apiKey);
            if (!record) { res.writeHead(401, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Invalid API key. Get yours at kordagencies.com' } })); return; }
          } else {
            const access = checkAccess(req);
            if (!access.allowed) { res.writeHead(429, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: access.reason, upgrade_url: 'https://kordagencies.com' } })); return; }
            req._accessWarning = access.warning; req._tier = access.tier;
          }
        }
        if (request.method === 'initialize') { response = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'vat-validator-mcp', version: '1.3.1', description: 'VAT validation + AI fraud detection for AI agents. EU VIES, UK HMRC, Australian ABN. AI-powered risk analysis and invoice verification. Free tier: 20 calls/month.' } } };
        } else if (request.method === 'notifications/initialized') { res.writeHead(204, cors); res.end(); return;
        } else if (request.method === 'tools/list') { response = { jsonrpc: '2.0', id: request.id, result: { tools } };
        } else if (request.method === 'resources/list') { response = { jsonrpc: '2.0', id: request.id, result: { resources: [] } };
        } else if (request.method === 'prompts/list') { response = { jsonrpc: '2.0', id: request.id, result: { prompts: [] } };
        } else if (request.method === 'tools/call') {
          const { name, arguments: toolArgs } = request.params;
          const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
          usageLog.push({ tool: name, tier: req._tier || 'paid', time: new Date().toISOString(), ip: ip.slice(0, 8) + '...' });
          if (usageLog.length > 1000) usageLog.shift();
          saveStats();
          const result = await executeTool(name, toolArgs || {});
          if (req._accessWarning) result._notice = req._accessWarning;
          response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
        } else { response = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found: ' + request.method } }; }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch(e) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ name: 'vat-validator-mcp', version: '1.3.1', status: 'ok', tools: 6, free_tier: '20 calls/month, no API key required', description: 'VAT validation + AI fraud detection. EU VIES, UK HMRC, Australian ABN.', upgrade: 'https://kordagencies.com' })); return; }
  res.writeHead(404, cors); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  loadStats();
  console.log('VAT Validator MCP v1.3.1 running on port ' + PORT);
  console.log('Free tier: ' + FREE_TIER_LIMIT + ' calls/IP/month, no API key required');
  console.log('Resend: ' + (RESEND_API_KEY ? 'configured' : 'MISSING'));
  console.log('Anthropic: ' + (ANTHROPIC_API_KEY ? 'configured' : 'MISSING'));
});
