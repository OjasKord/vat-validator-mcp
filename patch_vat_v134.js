const fs = require('fs');
let c = fs.readFileSync('C:/vat-validator-mcp/src/server.js', 'utf8');

console.log('File size:', c.length);
console.log('Has vat_stats:', c.includes('vat_stats'));
console.log('Version 1.3.2:', c.includes('1.3.2'));
console.log('Has validate_vat:', c.includes('validate_vat'));

if (!c.includes('vat_stats')) {
  console.error('ERROR: Wrong file');
  process.exit(1);
}

// 1. Add FREE_TIER_WARNING constant
c = c.replace(
  'const FREE_TIER_LIMIT = 20;',
  'const FREE_TIER_LIMIT = 20;\nconst FREE_TIER_WARNING = 16; // warn at 80% usage'
);

// 2. Bump version to 1.4.0
c = c.replace(/1\.3\.2/g, '1.4.0');

// 3. Add partial response logic in tools/call handler
// Find the existing tools/call result handling
const oldResult = `          const result = await executeTool(name, toolArgs || {});
          if (req._accessWarning) result._notice = req._accessWarning;
          response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };`;

const newResult = `          const result = await executeTool(name, toolArgs || {});
          if (req._accessWarning) result._notice = req._accessWarning;

          // Partial response for free tier
          if (req._tier === 'free' && !result.error) {
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            const used = freeTierUsage.get(ip) || 0;
            const remaining = FREE_TIER_LIMIT - used;
            const isWarning = used >= FREE_TIER_WARNING;

            if (name === 'validate_vat' || name === 'validate_uk_vat') {
              // Gate address on free tier — company name + valid status visible
              const gated = ['registered_address', 'address', 'consultation_number'];
              gated.forEach(f => delete result[f]);
              result._upgrade_note = 'Free tier: ' + remaining + ' of ' + FREE_TIER_LIMIT + ' calls remaining. Upgrade to Pro ($39/month) at kordagencies.com for full registered address and HMRC consultation number.';
              result._gated_fields = gated;
            }

            if (name === 'analyse_vat_risk') {
              // Gate full reasoning — verdict visible, details gated
              const gated = ['fraud_signals', 'positive_indicators', 'recommended_action', 'summary'];
              gated.forEach(f => delete result[f]);
              result._upgrade_note = 'Free tier: ' + remaining + ' of ' + FREE_TIER_LIMIT + ' calls remaining. Upgrade to Pro ($39/month) at kordagencies.com for full fraud signal breakdown, positive indicators, and recommended action.';
              result._gated_fields = gated;
            }

            if (name === 'compare_invoice_details') {
              // Gate detail fields — match_status visible, discrepancies gated
              const gated = ['discrepancies', 'name_match', 'address_match', 'recommended_action', 'summary'];
              gated.forEach(f => delete result[f]);
              result._upgrade_note = 'Free tier: ' + remaining + ' of ' + FREE_TIER_LIMIT + ' calls remaining. Upgrade to Pro ($39/month) at kordagencies.com for full discrepancy analysis and recommended action.';
              result._gated_fields = gated;
            }

            if (isWarning) result._notice = 'Warning: only ' + remaining + ' free call' + (remaining === 1 ? '' : 's') + ' left this month. Upgrade to Pro at kordagencies.com to avoid interruption.';
          }

          response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };`;

if (!c.includes(oldResult)) {
  console.error('ERROR: Could not find tool call handler');
  const idx = c.indexOf('executeTool(name');
  console.log('executeTool at:', idx);
  console.log('Context:', c.substring(idx - 20, idx + 150));
  process.exit(1);
}

c = c.replace(oldResult, newResult);

console.log('FREE_TIER_WARNING:', c.includes('FREE_TIER_WARNING'));
console.log('Version 1.4.0:', c.includes('1.4.0'));
console.log('Partial response:', c.includes('_upgrade_note'));
console.log('New size:', c.length);

fs.writeFileSync('C:/vat-validator-mcp/src/server.js', c);
console.log('Done');
