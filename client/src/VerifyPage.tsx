// #storefront-verify-page — the human-facing ^personhood-verified page for an
// agent-initiated purchase (route /verify/:sessionId). Fetches the verification context
// from the API, renders the World ID Selfie Check widget, and on a valid proof the
// backend settles the order. In mock mode it redirects to the server's click-through page.

import { useEffect, useState } from "react";
import { IDKitRequestWidget, selfieCheckLegacy, type RpContext } from "@worldcoin/idkit";
import { api, apiBaseUrl, type VerificationContext } from "./api";

type Phase = "loading" | "ready" | "done" | "expired" | "error";

export function VerifyPage({ sessionId }: { sessionId: string }) {
  const [context, setContext] = useState<VerificationContext | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getVerificationContext(sessionId)
      .then((ctx) => {
        // Mock deployments settle via the server's own page — send the human there.
        if (ctx.mode === "mock") {
          window.location.href = `${apiBaseUrl}/verify/${sessionId}`;
          return;
        }
        setContext(ctx);
        setPhase(ctx.usable ? "ready" : "expired");
      })
      .catch(() => setPhase("error"));
  }, [sessionId]);

  async function handleVerify(proof: unknown) {
    // Throwing here keeps the IDKit widget in its error state; onSuccess fires only if this resolves.
    await api.submitWorldProof(sessionId, proof);
  }

  return (
    <main className="container">
      <div className="verify-card">
        <h1>Authorize purchase</h1>
        <p className="muted">
          An agent started a purchase on your behalf. Complete the World ID Selfie Check to
          approve it — this proves a real person authorized the spend.
        </p>

        {phase === "loading" && <p className="muted">Loading…</p>}
        {phase === "expired" && (
          <p className="error">This verification has expired. Ask your agent to start the purchase again.</p>
        )}
        {phase === "error" && <p className="error">Couldn't load this verification. Is the API running?</p>}
        {phase === "done" && <p className="success">Verified ✓ — you can return to your agent.</p>}

        {phase === "ready" && context?.appId && context.action && context.rpContext && (
          <>
            <button onClick={() => setOpen(true)}>Verify with World ID</button>
            {error && <p className="error small">{error}</p>}
            <IDKitRequestWidget
              open={open}
              onOpenChange={setOpen}
              app_id={context.appId as `app_${string}`}
              action={context.action}
              rp_context={context.rpContext as RpContext}
              allow_legacy_proofs={true}
              preset={selfieCheckLegacy({ signal: sessionId })}
              handleVerify={handleVerify}
              onSuccess={() => setPhase("done")}
              onError={(code) => setError(`Verification failed (${code}). Please try again.`)}
            />
          </>
        )}
      </div>
    </main>
  );
}
