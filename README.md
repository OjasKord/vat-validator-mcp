[![smithery badge](https://smithery.ai/badge/OjasKord/vat-validator-mcp)](https://smithery.ai/servers/OjasKord/vat-validator-mcp)

# VAT Validator MCP — Business Identity Verification & Invoice Fraud Detection

Validate EU, UK, and Australian VAT numbers against live government registries. Plus AI-powered fraud risk analysis and invoice verification — so your agent doesn't just know a VAT number is valid, it knows whether to proceed with the transaction.

**Free tier: 20 calls/month. No API key required. Just connect and go.**

## Quick Start

```json
{
  "vat-validator": {
    "url": "https://vat-validator-mcp-production.up.railway.app"
  }
}
```

Or via Smithery:

```bash
npx -y @smithery/cli@latest mcp add OjasKord/vat-validator-mcp
```

## Why Use This

A VAT number is the most reliable identifier for a registered business in the EU, UK, and Australia. Validating it confirms the company is real and legally registered. But validation alone isn't enough — scammers use valid VAT numbers with mismatched company names, or invoice from newly registered shells. The AI tools in this server catch what raw validation misses.

Required for EU ViDA mandatory e-invoicing compliance from 2026.

## Tools

### `validate_vat`
Validate any EU, UK, or Australian VAT number against live government registries. Auto-detects country from prefix. Use before any B2B transaction, supplier onboarding, or invoice approval.

- EU (all 27 member states) via EU VIES (ec.europa.eu/taxation_customs/vies)
- UK (GB prefix) via UK HMRC (api.service.hmrc.gov.uk)
- Australia (AU prefix or 11-digit ABN) via Australian ABR (abr.business.gov.au)

```json
{ "vat_number": "DE811128135" }
```

### `validate_uk_vat`
UK-specific validation against HMRC live records. Returns HMRC consultation number for audit trail. Use when you need to prove compliance during a tax audit.

```json
{ "vat_number": "GB123456789" }
```

### `get_vat_rates`
Current VAT rates for all 27 EU member states, UK, and Australia. Use before generating any cross-border invoice or quote.

```json
{ "country_code": "DE" }
```

### `batch_validate` *(Paid only)*
Validate up to 10 VAT numbers in one call across any mix of EU, UK, and Australian numbers. Use for supplier onboarding batches and monthly vendor audits.

```json
{ "vat_numbers": ["DE811128135", "GB123456789", "FR12345678901"] }
```

### `analyse_vat_risk` *(AI-powered — NOT a database lookup)*
AI fraud risk assessment after validation. Returns CLEAR/REVIEW/BLOCK recommendation with specific fraud signals. Catches name mismatches between invoice and registry, newly registered companies with large invoice values, dormant status, shell company indicators, and address anomalies. Use before approving any payment or signing any contract with a first-time counterparty.

```json
{
  "vat_number": "DE811128135",
  "validation_result": { "valid": true, "company_name": null, "country": "DE" },
  "invoice_amount": 50000,
  "invoice_company_name": "Deutsche Test GmbH"
}
```

### `compare_invoice_details` *(AI-powered — NOT a database lookup)*
AI comparison of invoice details against official registry records. Flags discrepancies between the company name, address, and VAT number on an invoice versus registered government data. A name mismatch is one of the most common invoice fraud signals. Use before approving payment on any invoice from an unverified supplier.

```json
{
  "invoice_company_name": "Deutsche Test GmbH",
  "invoice_vat_number": "DE811128135",
  "invoice_address": "Musterstrasse 1, Berlin",
  "validation_result": { "valid": true, "company_name": null, "country": "DE" }
}
```

## Example Responses

**validate_vat:**
```json
{
  "valid": true,
  "vat_number": "DE811128135",
  "country": "DE",
  "company_name": null,
  "source": "VIES",
  "source_url": "ec.europa.eu/taxation_customs/vies",
  "checked_at": "2026-04-09T06:17:00Z"
}
```

**analyse_vat_risk:**
```json
{
  "recommendation": "REVIEW",
  "risk_level": "MEDIUM",
  "risk_score": 65,
  "fraud_signals": ["Company name not available in registry despite valid VAT number", "Unable to verify invoice company name against registry data"],
  "positive_indicators": ["VAT number validates as authentic in German registry"],
  "recommended_action": "Request additional company documentation before processing payment.",
  "summary": "Valid VAT number but missing registry information prevents full verification."
}
```

## Recommended Workflows

**Invoice processing (3 calls):**
1. `validate_vat` — confirm VAT number is real and active
2. `compare_invoice_details` — AI checks invoice name/address against registry
3. `analyse_vat_risk` — AI fraud risk assessment with CLEAR/REVIEW/BLOCK
Only proceed with payment if recommendation is CLEAR.

**Supplier onboarding (2 calls):**
1. `validate_vat` — confirm registration
2. `analyse_vat_risk` — AI fraud signal check

**Monthly vendor audit (1 call):**
- `batch_validate` — re-validate all active suppliers. Registrations can lapse.

## Data Sources

| Tool | Data Source | Update Frequency |
|---|---|---|
| validate_vat (EU) | EU VIES (ec.europa.eu/taxation_customs/vies) | Real-time |
| validate_vat (UK) | UK HMRC (api.service.hmrc.gov.uk) | Real-time |
| validate_vat (AU) | Australian ABR (abr.business.gov.au) | Real-time |
| analyse_vat_risk | Registry data + Claude AI analysis | Real-time |
| compare_invoice_details | Registry data + Claude AI analysis | Real-time |

Every response includes `source_url` and `checked_at` so agents can verify exactly where data came from and when.

## Supported Jurisdictions

**EU (27 member states):** AT BE BG CY CZ DE DK EE EL ES FI FR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK

**UK:** GB prefix via HMRC

**Australia:** AU prefix or 11-digit ABN via ABR

## Pricing

| Plan | Validations | Price |
|---|---|---|
| Free | 20/month | No API key required |
| Pro | 5,000/month | $39/month |
| Enterprise | Unlimited + batch | $199/month |

Upgrade at **[kordagencies.com](https://kordagencies.com)**

## Reliability

- Uptime monitored every 5 minutes via UptimeRobot
- Version history documented in [CHANGELOG.md](CHANGELOG.md)
- Health endpoint: `GET /health`
- Note: EU VIES experiences periodic downtime — errors include explanation and retry guidance

## Legal

Results sourced directly from official government VAT registries (EU VIES, UK HMRC, Australian ABR). We do not log or store your query content. Results are for informational purposes only and do not constitute legal or tax advice. Verify all results with a qualified tax advisor. Maximum liability limited to 3 months subscription fees. Full terms: [kordagencies.com/terms.html](https://kordagencies.com/terms.html)

## Connect

- Website: [kordagencies.com](https://kordagencies.com)
- Smithery: [smithery.ai/server/OjasKord/vat-validator-mcp](https://smithery.ai/server/OjasKord/vat-validator-mcp)
- Contact: ojas@kordagencies.com
