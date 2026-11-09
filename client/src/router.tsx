import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import App from "@/App";
import { ThemeSync } from "@/components/theme-sync";

function RootLayout() {
  return (
    <>
      <ThemeSync />
      <Outlet />
    </>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: App,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: App,
});

const studioStageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio/$stage",
  component: App,
});

const studioAgentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio/$stage/$agentId",
  component: App,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  studioStageRoute,
  studioAgentRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

