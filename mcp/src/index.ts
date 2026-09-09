#!/usr/bin/env node
// #merchant-mcp — an MCP server that runs on the user's machine so their AI agent can
// browse an agentic-commerce storefront and initiate purchases on their behalf. Every
// purchase it starts is gated by a World ID personhood (selfie) check that must be
// completed by the human — the MCP surfaces the verification URL and polls the outcome.
// Scoped to a single store for now (generalization to "any compliant storefront" later).
//
// Config via env:
//   STORE_API_URL   base URL of the storefront API (default http://127.0.0.1:3000)
//   AGENT_GRANT     agent grant token from the store's POST /agent/grant (required to buy)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const STORE_API_URL = process.env.STORE_API_URL ?? "http://127.0.0.1:3000";
const AGENT_GRANT = process.env.AGENT_GRANT ?? "";

interface ApiResponse {
  status: number;
  body: any;
}

async function api(path: string, init?: RequestInit): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body) headers["Content-Type"] = "application/json";
  if (AGENT_GRANT) headers["Authorization"] = `Bearer ${AGENT_GRANT}`;

  const res = await fetch(`${STORE_API_URL}${path}`, { ...init, headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// MCP tool results are text blocks; JSON is pretty-printed for the agent to read.
function text(payload: unknown) {
  const value = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text: value }] };
}

const server = new McpServer({ name: "merchant-mcp", version: "0.1.0" });

server.tool(
  "list_products",
  "List the products available in the storefront (sku, name, price in USDC).",
  {},
  async () => {
    const { status, body } = await api("/products");
    if (status !== 200) return text(`Failed to list products (HTTP ${status}).`);
    return text(body?.products ?? []);
  },
);

server.tool(
  "initiate_purchase",
  "Start a purchase on the user's behalf. This does NOT complete the purchase: it returns a " +
    "verification URL that the HUMAN must open to complete a World ID selfie check. Surface " +
    "that URL to the user, then poll check_purchase_status with the returned orderId.",
  {
    sku: z.string().describe("Product SKU to buy (from list_products)."),
    quantity: z.number().int().min(1).default(1).describe("How many units."),
  },
  async ({ sku, quantity }) => {
    if (!AGENT_GRANT) {
      return text(
        "No AGENT_GRANT configured. The user must authorize this agent (sign in to the " +
          "storefront, POST /agent/grant) and set AGENT_GRANT in this MCP's environment.",
      );
    }
    const { status, body } = await api("/agent/checkout", {
      method: "POST",
      body: JSON.stringify({ sku, quantity }),
    });
    if (status === 202) {
      return text({
        message: "Human verification required before this purchase can complete.",
        orderId: body?.orderId,
        amountUsdc: body?.amountUsdc,
        verificationUrl: body?.verification?.url,
        next:
          "Show verificationUrl to the user and ask them to complete the World ID selfie " +
          "check, then call check_purchase_status with the orderId until it is 'completed'.",
      });
    }
    if (status === 402) {
      return text(`Blocked by spend policy (${body?.cap} cap, limit $${body?.limit}) for $${body?.amountUsdc}.`);
    }
    if (status === 401) return text("Agent grant invalid or expired. The user must re-authorize the agent.");
    if (status === 404) return text(`Unknown SKU "${sku}".`);
    return text(`Purchase could not be initiated (HTTP ${status}).`);
  },
);

server.tool(
  "check_purchase_status",
  "Check the status of a purchase started with initiate_purchase. Statuses include " +
    "pending_verification (waiting on the human selfie), completed, submitted, expired, failed.",
  { orderId: z.string().describe("The orderId returned by initiate_purchase.") },
  async ({ orderId }) => {
    const { status, body } = await api(`/agent/purchase/${orderId}`);
    if (status !== 200) return text(`Could not fetch status (HTTP ${status}).`);
    return text(body);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
