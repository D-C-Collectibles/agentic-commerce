// #storefront-agent-access — lets a signed-in human mint an agent grant to paste into
// the merchant MCP config. Surfaces the token with a copy button and a reminder that
// agent-initiated purchases still require a per-purchase selfie check.

import { useState } from "react";
import { ApiError, api } from "./api";
import { useAuth } from "./auth";

export function AgentAccess() {
  const { token } = useAuth();
  const [grant, setGrant] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function authorize() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.createAgentGrant(token);
      setGrant(result.agentGrant);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? "Couldn't authorize an agent — try signing in again."
          : "Network error — is the API running?",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyGrant() {
    if (!grant) return;
    try {
      await navigator.clipboard.writeText(grant);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — the textarea is selectable as a fallback
    }
  }

  return (
    <section className="agent-access">
      <h2>Agent access</h2>
      <p className="muted small">
        Authorize an AI agent to shop on your behalf via the merchant MCP. Every purchase an
        agent starts still requires your live selfie check.
      </p>

      {!grant ? (
        <button onClick={authorize} disabled={busy}>
          {busy ? "…" : "Authorize an agent"}
        </button>
      ) : (
        <div className="grant">
          <label className="small muted">
            Agent grant — paste into your MCP config as <code>AGENT_GRANT</code>
            <textarea readOnly rows={3} value={grant} onFocus={(event) => event.target.select()} />
          </label>
          <div className="confirm-row">
            <button onClick={copyGrant}>{copied ? "Copied ✓" : "Copy"}</button>
            <button className="link" onClick={() => setGrant(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {error && <p className="error small">{error}</p>}
    </section>
  );
}
