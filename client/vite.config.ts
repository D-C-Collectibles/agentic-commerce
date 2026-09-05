import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Storefront SPA. Talks to the Express API (default http://localhost:3000);
// override with VITE_API_URL. Dev server runs on 5173 (Vite default).
export default defineConfig({
  plugins: [react()],
});
