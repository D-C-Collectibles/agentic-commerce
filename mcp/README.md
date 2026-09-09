# @agentic-commerce/merchant-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent on the user's
machine **browse an agentic-commerce storefront and initiate purchases on the user's
behalf** — with every purchase gated by a **World ID personhood (selfie) check** that the
human must complete. The agent can find and start a purchase; it can never move money
without a live human proving they authorized it.

Scoped to a single storefront for now; generalizing to "any compliant storefront" is a
follow-up.

## Tools

| Tool | What it does |
|------|--------------|
| `list_products` | Lists the catalog (`sku`, `name`, `price_usdc`). |
| `initiate_purchase(sku, quantity)` | Starts a purchase. Does **not** charge — returns a `verificationUrl` the human must open to complete the selfie check, plus an `orderId`. |
| `check_purchase_status(orderId)` | Polls the outcome: `pending_verification` → `completed` (or `expired`/`failed`). |

## Configuration

Set via environment variables (see `.env.example`):

- `STORE_API_URL` — storefront API base URL (default `http://127.0.0.1:3000`).
- `AGENT_GRANT` — the agent grant token. Get one by signing in to the storefront and
  calling `POST /agent/grant` (or the **Authorize an agent** button in the SPA).

## Run

```bash
pnpm install
pnpm build      # -> dist/index.js
# or during development:
pnpm dev
```

## Register with Claude Code

```json
{
  "mcpServers": {
    "merchant": {
      "command": "node",
      "args": ["/absolute/path/to/agentic-commerce/mcp/dist/index.js"],
      "env": {
        "STORE_API_URL": "http://127.0.0.1:3000",
        "AGENT_GRANT": "<paste the agent grant here>"
      }
    }
  }
}
```

## The flow

1. Agent calls `initiate_purchase("gadget-1", 1)`.
2. MCP returns *"human verification required"* + a `verificationUrl`.
3. The agent surfaces the URL to the human, who completes the World ID selfie check.
4. Agent polls `check_purchase_status(orderId)` until it reads `completed`.

The human's in-browser checkout on the storefront itself is **not** gated by the selfie —
only agent-initiated purchases are. That distinction is enforced server-side by the token
audience (an agent grant always takes the personhood-gated path), so an agent can't
present itself as a human to skip the check.
