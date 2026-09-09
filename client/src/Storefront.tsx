// #storefront — public product grid + agent-style checkout. Anyone can browse;
// buying requires a signed-in session (the JWT is sent to /checkout). Handles the
// server's spend-policy responses: 428 (confirm above auto-approve), 402 (cap hit),
// 401 (expired session).

import { useEffect, useState } from "react";
import { ApiError, api, type Product } from "./api";
import { useAuth } from "./auth";

// Per-product checkout state, keyed by sku.
type BuyState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "confirm"; amountUsdc: string }
  | { kind: "success"; orderId: string; state: string }
  | { kind: "error"; message: string };

function formatUsd(value: string): string {
  return `$${Number(value).toFixed(2)}`;
}

export function Storefront() {
  const { token, user, logout } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [buyState, setBuyState] = useState<Record<string, BuyState>>({});

  useEffect(() => {
    api
      .listProducts()
      .then(setProducts)
      .catch(() => setLoadError("Couldn't load products. Is the API running?"))
      .finally(() => setLoading(false));
  }, []);

  function setState(sku: string, state: BuyState) {
    setBuyState((prev) => ({ ...prev, [sku]: state }));
  }

  async function buy(sku: string, confirmed: boolean) {
    if (!token) return;
    setState(sku, { kind: "pending" });
    try {
      const result = await api.checkout(token, { sku, quantity: 1, checkoutConfirmed: confirmed });
      setState(sku, { kind: "success", orderId: result.orderId, state: result.state });
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setState(sku, { kind: "error", message: "Network error — is the API running?" });
        return;
      }
      if (err.status === 428) {
        setState(sku, { kind: "confirm", amountUsdc: String(err.body?.amountUsdc ?? "") });
      } else if (err.status === 402) {
        const cap = err.body?.cap === "daily" ? "daily" : "per-transaction";
        const limit = err.body?.limit;
        setState(sku, {
          kind: "error",
          message: `Blocked by the ${cap} spend cap${limit ? ` of $${limit}` : ""}.`,
        });
      } else if (err.status === 401) {
        logout();
        setState(sku, { kind: "error", message: "Session expired — please sign in again." });
      } else {
        setState(sku, { kind: "error", message: "Checkout failed. Please try again." });
      }
    }
  }

  if (loading) return <p className="muted">Loading products…</p>;
  if (loadError) return <p className="error">{loadError}</p>;

  return (
    <section>
      <div className="grid">
        {products.map((p) => {
          const state = buyState[p.sku] ?? { kind: "idle" };
          return (
            <article key={p.sku} className="card">
              <div className="card-body">
                <h3>{p.name}</h3>
                <p className="price">{formatUsd(p.price_usdc)} USDC</p>
                <p className="sku">{p.sku}</p>
              </div>

              <div className="card-action">
                {!user ? (
                  <p className="muted small">Sign in to buy</p>
                ) : state.kind === "confirm" ? (
                  <div className="confirm">
                    <p className="small">
                      {formatUsd(state.amountUsdc)} is above the auto-approve limit. Confirm purchase?
                    </p>
                    <div className="confirm-row">
                      <button onClick={() => buy(p.sku, true)}>Confirm</button>
                      <button className="link" onClick={() => setState(p.sku, { kind: "idle" })}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : state.kind === "success" ? (
                  <p className="success small">
                    Order placed ✓ <span className="muted">({state.state.toLowerCase()})</span>
                  </p>
                ) : (
                  <>
                    <button disabled={state.kind === "pending"} onClick={() => buy(p.sku, false)}>
                      {state.kind === "pending" ? "Processing…" : "Buy"}
                    </button>
                    {state.kind === "error" && <p className="error small">{state.message}</p>}
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
