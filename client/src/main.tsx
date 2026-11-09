import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import "@/globals.css";
import { router } from "@/router";

const query = new URLSearchParams(window.location.search);
const isOAuthCallback =
  (query.has("code") && query.has("state")) || query.has("error");

if (window.location.pathname === "/" && isOAuthCallback) {
  window.location.replace(`/api/auth/agora/callback${window.location.search}`);
} else {
  const root = document.getElementById("root");
  if (!root) throw new Error("Root element was not found.");

  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}

