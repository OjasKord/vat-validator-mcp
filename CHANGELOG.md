# Changelog — VAT Validator MCP

All notable changes to VAT Validator MCP are documented here.
Format: version number, date, what changed.

---

## v1.4.9 — 2026-05-05

### Fixed
- Free tier gate now only applies to tool calls, not discovery requests (tools/list, resources/list, prompts/list no longer consume free tier quota)

## v1.4.6 — 2026-04-28

### Changed
- Payment links updated to prepaid bundle URLs: 500 calls for $8 -- calls never expire
- Free tier limit errors now direct agents to prepaid bundle purchase link directly

## v1.4.5 — 2026-04-27

### Added
- `token_count` field on all tool responses — lets orchestrator budget ledgers track token cost per call
- `/ready` endpoint — returns 200 when `ANTHROPIC_API_KEY`, `HMRC_CLIENT_ID`, and `HMRC_CLIENT_SECRET` are present, 503 otherwise
- Phase 4 enhanced error objects: `category`, `retryable`, `retry_after_ms`, `fallback_tool`, `trace_id` on all 16 error paths across all 6 tools

## v1.4.4 — 2026-04-26

### Improved
- All 6 tool descriptions rewritten with TCO framework: irresistibility opening, stale-cache penalty consequence, exact data source hostnames, prepaid bundle pricing last
- Initialize serverInfo description rewritten for all 3 transport paths
- compare_invoice_details: agent_action now returned in success response (PROCEED_WITH_PAYMENT / MANUAL_REVIEW_REQUIRED / BLOCK_PAYMENT derived from recommendation); discrepancies always returned as array

## v1.3.0 — 2026-04-09

### Added
- `source_url` field in every tool response — agents can verify exactly which government API provided the data (EU VIES, UK HMRC, Australian ABR)
- `checked_at` ISO timestamp in every tool response — agents know exactly when the data was retrieved
- "We do not log or store your query content" added to legal disclaimer — privacy signal for operators
- Honest timeout error messages — VIES and HMRC timeouts now explain the issue is with the external government portal, not the VAT number

### Changed
- Legal disclaimer updated: now explicitly names data sources and confirms no query content logging
- VIES timeout message: "EU VIES portal is temporarily unavailable — this is a known issue with the official EU system, not a problem with the VAT number. Retry in 30 minutes."
- HMRC timeout message: "UK HMRC API is temporarily unavailable — this is not a problem with the VAT number. Retry in a few minutes."

---

## v1.2.0 — 2026-04-09

### Added
- `analyse_vat_risk` tool — AI-powered fraud risk assessment after validation
  - Returns CLEAR/REVIEW/BLOCK recommendation with specific fraud signals
  - Catches name mismatches, newly registered companies, dormant status, shell company indicators
  - Uses Claude claude-sonnet-4-20250514 for analysis
- `compare_invoice_details` tool — AI comparison of invoice details against registry records
  - Returns APPROVE/REVIEW/REJECT recommendation
  - Flags discrepancies between invoice name/address and registered data
  - Uses Claude claude-sonnet-4-20250514 for analysis
- ANTHROPIC_API_KEY environment variable added to Railway

### Changed
- Server description updated to highlight AI fraud detection capability
- Tools count updated to 6

---

## v1.1.0 — 2026-04-09

### Changed
- All tool descriptions broadened from "invoicing and e-invoicing compliance" to "business identity verification layer"
- New triggers added: supplier onboarding, contract signing, CRM enrichment, procurement, B2B tax exemptions, fraud detection
- smithery.yaml system prompt rewritten with recommended workflows and fraud detection signals

---

## v1.0.0 — 2026-04-09

### Added
- Initial release
- `validate_vat` — auto-detects country, routes to EU VIES / UK HMRC / AU ABR
- `validate_uk_vat` — UK-specific with HMRC consultation number for audit trail
- `get_vat_rates` — current VAT rates for all 27 EU countries, UK, and Australia
- `batch_validate` — up to 10 VAT numbers per call (paid only)
- Free tier: 20 validations/month, no API key required
- Stripe webhook → API key email delivery
- Stats endpoint protected by STATS_KEY
- Legal disclaimer in every tool response
- Published to: Railway, npm, Smithery, Anthropic MCP Registry, Glama
