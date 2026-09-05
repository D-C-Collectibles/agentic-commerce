// #storefront-app — layout shell. Header shows session state; body is the product
// grid, with the auth panel shown alongside when signed out.

import { AuthPanel } from "./AuthPanel";
import { Storefront } from "./Storefront";
import { AuthProvider, useAuth } from "./auth";

function Header() {
  const { user, logout } = useAuth();
  return (
    <header className="topbar">
      <div className="brand">Agentic Commerce</div>
      <div className="session">
        {user ? (
          <>
            <span className="muted small">{user.email}</span>
            <button className="link" onClick={logout}>
              Sign out
            </button>
          </>
        ) : (
          <span className="muted small">Not signed in</span>
        )}
      </div>
    </header>
  );
}

function Shell() {
  const { user } = useAuth();
  return (
    <>
      <Header />
      <main className="container">
        {!user && (
          <div className="signed-out">
            <AuthPanel />
          </div>
        )}
        <div>
          <h1>Storefront</h1>
          <p className="muted">Pay in USDC from your custodied wallet. Spend caps enforced server-side.</p>
          <Storefront />
        </div>
      </main>
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
