# VAT Validator MCP

**AI-powered VAT fraud detection and live VAT number validation
for AI agents.**

Validates EU, UK, and AU VAT numbers against authoritative live
sources and uses AI pattern analysis to detect invoice fraud
before payment is authorised. Built for compliance agents,
invoice processing workflows, and supplier onboarding pipelines.

## What This Solves

VAT fraud costs EU businesses €50bn annually. The most common
attack vectors — missing trader fraud, carousel fraud,
deregistered entity re-use — share one common signal: a VAT
number that looks valid but isn't registered to the entity on
the invoice.

Claude and other LLMs cannot reliably check live VAT registration
status from training data. This tool calls the authoritative
sources directly:

- **EU VIES** — all 27 member states, real-time
- **UK HMRC VAT API v2** — OAuth2, authoritative
- **AU ABR** — Australian Business Register

## Tools

| Tool | Free Tier | Use When |
|---|---|---|
| validate_vat | 20/month | Before approving any EU supplier or invoice |
| validate_uk_vat | 20/month | Before approving any UK supplier or invoice |
| get_vat_rates | 20/month | Before calculating cross-border invoice totals |
| batch_validate | Paid | Validating a supplier list or invoice batch |
| analyse_vat_risk | 20/month | Before approving any high-value cross-border invoice |
| compare_invoice_details | 20/month | Before authorising payment on any supplier invoice |

## Add to Your Agent

**Claude Code** — add to .mcp.json:
{
  "mcpServers": {
    "vat-validator": {
      "type": "sse",
      "url": "https://vat-validator-mcp-production.up.railway.app/sse"
    }
  }
}

**LangChain:**
from langchain_mcp import MCPClient
client = MCPClient(
    "https://vat-validator-mcp-production.up.railway.app/sse"
)

**OpenAI Agents SDK:**
from agents.mcp import MCPServerSse
mcp_server = MCPServerSse(
    params={
        "url": "https://vat-validator-mcp-production.up.railway.app/sse"
    }
)

## Pricing

| Tier | Calls | Price |
|---|---|---|
| Free | 20/month | No card required |
| Pro | Unlimited | $39/month |
| Enterprise | Unlimited + priority | $199/month |

Upgrade: https://kordagencies.com

## Search Terms

VAT number validation · EU VAT check · VIES lookup · HMRC VAT
verification · VAT fraud detection · invoice VAT compliance ·
missing trader fraud · carousel fraud detection · cross-border
invoice check · supplier VAT screening · VAT registration
verification · EU invoice compliance · AU ABR lookup ·
UK VAT API · invoice fraud detection API · supplier VAT fraud
risk · accounts payable compliance agent · VAT invoice audit ·
AI invoice compliance · MCP VAT validation
