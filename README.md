# VAT Validator MCP

Validate EU, UK, and Australian VAT numbers for AI agents. EU VIES, UK HMRC, and Australian ABN in one call. Required for EU ViDA mandatory e-invoicing compliance.

## Free Tier

20 validations/month. No API key required. Just connect and start validating.

## Tools

### validate_vat
Validate any VAT number — auto-detects country from prefix and routes to the correct authority.
- EU (all 27 member states) via VIES
- UK (GB prefix) via HMRC
- Australia (AU prefix or 11-digit ABN) via ABR

### validate_uk_vat
Validate UK VAT numbers against HMRC live records. Returns consultation number for audit trail.

### get_vat_rates
Get current VAT rates for any EU country, UK, or Australia. Returns standard and all reduced rates.

### batch_validate
Validate up to 10 VAT numbers in one call across any mix of EU, UK, and Australian numbers. Paid tier only.

## Pricing

- **Free**: 20 validations/month, no API key
- **Pro**: $99/month — 5,000 validations/month
- **Enterprise**: $299/month — unlimited + batch validation

Get your API key at [kordagencies.com](https://kordagencies.com)

## Legal

Results are for informational purposes only and do not constitute legal or tax advice. Verify all results with a qualified tax advisor. Full terms: kordagencies.com/terms.html

## MCP Config

```json
{
  "vat-validator": {
    "url": "https://vat-validator-mcp-production.up.railway.app",
    "headers": { "x-api-key": "YOUR_API_KEY" }
  }
}
```
