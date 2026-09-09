import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { VerifyPage } from "./VerifyPage";
import "./styles.css";

// Minimal path routing: /verify/:sessionId is the personhood check for an agent-initiated
// purchase; everything else is the storefront. Avoids pulling in a router dependency.
const verifyMatch = window.location.pathname.match(/^\/verify\/([^/]+)\/?$/);

createRoot(document.getElementById("root")!).render(
  <StrictMode>{verifyMatch ? <VerifyPage sessionId={verifyMatch[1]} /> : <App />}</StrictMode>,
);
