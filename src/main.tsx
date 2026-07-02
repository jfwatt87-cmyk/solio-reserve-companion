import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./fonts.css";
import "./theme.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Service worker: PRODUCTION ONLY. In dev it caches built assets and serves
// stale code (which was masking live changes), so during development we actively
// unregister any existing worker and clear its caches instead of registering.
if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => { /* offline PWA unavailable */ });
    });
  } else {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
    if (typeof caches !== "undefined") caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
  }
}
