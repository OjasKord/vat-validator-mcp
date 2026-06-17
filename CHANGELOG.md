# Changelog — VAT Validator MCP

All notable changes to VAT Validator MCP are documented here.
Format: version number, date, what changed.

---

## v2.0.24 — 2026-06-17
- fix: Stripe webhook now validates payment_link ID — ignores events not belonging to this server

## v2.0.23 — 2026-06-16
- feat: ATO optimisation — purpose verb, usage context, required fields, ToolRank badge

## v2.0.22 — 2026-06-15
- feat: add hold_reason, retry_after, escalation_path to VERIFY_MANUALLY responses in validate_vat

## v2.0.21 — 2026-06-15
- feat: reposition tool descriptions for agentic payment rail discovery -- Stripe MPP, Alipay AI Pay, Shopify UCP trigger vocabulary across validate_vat, get_vat_rates, and initialize description

## v2.0.20 — 2026-06-11
- feat: add /.well-known/mcp/server-card.json static metadata endpoint

## v2.0.19 — 2026-06-11
- fix: bump version past existing npm publish (2.0.18 already on registry)

## v2.0.18 — 2026-06-11
- feat: per-tool kill switch + per-minute rate limiting on AI tools

## v2.0.17 — 2026-06-08
- fix: BEFORE trigger language, consequence-first limit error

## v2.0.16 — 2026-06-05
- feat: Smithery optimisation - updated package.json description/keywords and smithery.yaml with system prompt

## v2.0.15 — 2026-06-04
- feat: /daily-report endpoint for consolidated daily summary

## v2.0.14 — 2026-06-03

fix: saveFreeTierToRedis merges with existing Redis data — prevents historical IP counts lost on redeploy

## v2.0.13 — 2026-06-03

feat: per-IP free tier breakdown added to /stats endpoint

## v2.0.12 — 2026-06-02

feat: tool descriptions rewritten for orchestral agent runtime selection

## v2.0.11 — 2026-06-02

chore: .npmignore updated — dev/backup files and zero-byte artifacts excluded from npm package

## v2.0.10 — 2026-06-02

feat: tool descriptions updated for agentic finance workflows — Robinhood Agentic Trading trigger language added

## v2.0.9 — 2026-06-02

fix: README pricing updated to current rates

## v2.0.8 — 2026-06-02

fix: free tier usage persisted in Redis (survives redeploys), IP extraction fixed for Cloudflare proxy headers

## v2.0.7 — 2026-05-22

improve: tool descriptions updated to make validate_vat + get_vat_rates two-step workflow explicit

## v2.0.6 — 2026-05-21

fix: Upstash redisSet corrected to REST GET format, response error logging added to all Redis helpers

## v2.0.5 — 2026-05-21

fix: session log Redis errors now visible, IP extraction takes first forwarded IP only, startup warning if Upstash env vars missing

## v2.0.4 — 2026-05-11

feat: session co-occurrence logging to Redis — tracks tool call sequences per IP per day

## v2.0.3 — 2026-05-11

v2.0.3 — add HMRC 429 retry with exponential backoff (3 req/sec limit compliance)

## v2.0.2 — 2026-05-11

v2.0.2 — add mandatory HMRC fraud prevention headers (BATCH_PROCESS_DIRECT) per VAT MTD API legal requirement

## v2.0.1 — 2026-05-11

fix: constrain recommendation to CLEAR/REVIEW/BLOCK enum in Claude prompt for `validate_vat`; fix: `get_vat_rates` source_url corrected to `taxation-customs.ec.europa.eu/tedb/taxes-list.html`.

## v2.0.0 — 2026-05-11

Redesign: collapsed 6 tools to 2. `validate_vat` now auto-detects jurisdiction (EU/UK/AU), runs fraud analysis internally, and cross-checks invoice details in one call. Removed: `validate_uk_vat`, `batch_validate`, `analyse_vat_risk`, `compare_invoice_details`. `get_vat_rates` retained unchanged. Zero chained inputs — all tools are now self-contained.

---

## v1.4.13 — 2026-05-08

billing upgrade: Upstash Redis persistent key storage, monthly period reset, metered billing via Stripe Meter Events API, dual billing options (pay-as-you-go + bundles), /subscribe and /subscribed endpoints, FREE_TIER_LIMIT updated to 50

## v1.4.12 — 2026-05-08

discovery rewrite: tool descriptions rewritten with workflow triggers and consequence framing. README rewritten with AI engine search terms. smithery.yaml description updated.

## v1.4.11 — 2026-05-07

### Docs
- docs: add harness config blocks and improve registry description for developer discovery

## v1.4.10 — 2026-05-05

### Fixed
- `_upgrade_note` denominator now reflects effective limit (30) after a trial extension is granted, not the base limit (20)
- `agent_action` added to all successful tool responses: `validate_vat` (PROCEED/VERIFY_MANUALLY), `validate_uk_vat` (PROCEED/VERIFY_MANUALLY), `get_vat_rates` (PROCEED), `batch_validate` (PROCEED), `analyse_vat_risk` (PROCEED/VERIFY_MANUALLY/HOLD derived from risk_level), `compare_invoice_details` (PROCEED/INVESTIGATE derived from match_verdict)

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
