// #storefront-api — thin typed client for the Express API.
// Base URL from VITE_API_URL (defaults to the local server). Auth is a JWT passed
// as `Authorization: Bearer <token>`; prices stay strings (never float math on money).

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export interface Product {
  sku: string;
  name: string;
  price_usdc: string;
}

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthResult {
  token: string;
  user: AuthUser;
}

export interface CheckoutResult {
  orderId: string;
  circleTransactionId: string;
  amountUsdc: string;
  state: string;
}

export interface AgentGrantResult {
  agentGrant: string;
  note: string;
}

export interface WorldRpContext {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
}

// Everything the verification page needs to run the personhood check for a session.
export interface VerificationContext {
  status: string;
  usable: boolean;
  mode?: "mock" | "world";
  appId?: string;
  action?: string;
  rpContext?: WorldRpContext;
}

// Carries the HTTP status + parsed error body so callers can branch on
// 401 / 402 (spend cap) / 428 (confirmation required) precisely.
export class ApiError extends Error {
  status: number;
  body: Record<string, unknown> | null;
  constructor(status: number, body: Record<string, unknown> | null) {
    super(typeof body?.error === "string" ? body.error : `request_failed_${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const api = {
  listProducts: () => request<{ products: Product[] }>("/products").then((r) => r.products),

  signup: (email: string, password: string) =>
    request<AuthResult>("/auth/signup", { method: "POST", body: { email, password } }),

  login: (email: string, password: string) =>
    request<AuthResult>("/auth/login", { method: "POST", body: { email, password } }),

  checkout: (
    token: string,
    input: { sku: string; quantity: number; checkoutConfirmed?: boolean },
  ) => request<CheckoutResult>("/checkout", { method: "POST", body: input, token }),

  createAgentGrant: (token: string) =>
    request<AgentGrantResult>("/agent/grant", { method: "POST", token }),

  getVerificationContext: (sessionId: string) =>
    request<VerificationContext>(`/verify-context/${sessionId}`),

  // Forwards the IDKit proof to the backend, which verifies it with World and settles.
  submitWorldProof: (sessionId: string, proof: unknown) =>
    request<{ status: string }>(`/verify/${sessionId}`, { method: "POST", body: proof }),
};

// Base URL of the storefront API, exported so the verify page can redirect to the
// server's mock verification page when the deployment is in mock mode.
export const apiBaseUrl = API_URL;
