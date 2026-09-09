// #storefront-auth-panel — email/password login + signup form. Toggles between the
// two modes and surfaces the API's error codes as friendly messages.

import { useState } from "react";
import { ApiError } from "./api";
import { useAuth } from "./auth";

type Mode = "login" | "signup";

const ERROR_COPY: Record<string, string> = {
  invalid_email: "Please enter a valid email address.",
  weak_password: "Password must be at least 6 characters.",
  email_taken: "That email is already registered — try logging in.",
  invalid_credentials: "Email or password is incorrect.",
};

export function AuthPanel() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await login(email, password);
      else await signup(email, password);
    } catch (err) {
      const code = err instanceof ApiError ? String(err.body?.error ?? err.message) : "network_error";
      setError(ERROR_COPY[code] ?? "Something went wrong. Is the API running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-panel" onSubmit={submit}>
      <h2>{mode === "login" ? "Sign in" : "Create account"}</h2>
      <p className="muted">Email + password — demo accounts only.</p>

      <label>
        Email
        <input
          type="email"
          value={email}
          autoComplete="email"
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>

      {error && <p className="error">{error}</p>}

      <button type="submit" disabled={busy}>
        {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
      </button>

      <button
        type="button"
        className="link"
        onClick={() => {
          setMode(mode === "login" ? "signup" : "login");
          setError(null);
        }}
      >
        {mode === "login" ? "Need an account? Sign up" : "Have an account? Sign in"}
      </button>
    </form>
  );
}
