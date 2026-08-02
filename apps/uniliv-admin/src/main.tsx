import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { getToken, bootstrapAuth } from "@/lib/api-fetch";
import { useAuthStore } from "@/lib/store";

// Bearer getter reads the in-memory access token (never web storage) so the generated
// api-client hooks attach the same token as our apiFetch/apiDownload helpers.
setAuthTokenGetter(() => getToken());

// A full page reload wipes the in-memory token. Before first render, mint a fresh access
// token from the httpOnly refresh cookie so a logged-in user who reloads stays logged in
// (otherwise ProtectedRoute, which gates on the store token, would bounce them to /login).
// If there is no valid refresh cookie this is a no-op and the app renders logged out.
// Either way the 401→refresh→retry path in apiFetch/apiDownload remains the safety net.
async function boot() {
  const ok = await bootstrapAuth();
  if (ok) {
    // Mirror the rehydrated token into the zustand store so isAuthenticated() is true on boot.
    // Pass through the persisted remember-me choice so a reload doesn't flip it to "1".
    const remember = localStorage.getItem("uniliv_remember") !== "0";
    useAuthStore.getState().setToken(getToken(), remember);
  }
  createRoot(document.getElementById("root")!).render(<App />);
}

void boot();
