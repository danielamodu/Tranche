import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { WalletProvider } from "@/context/WalletContext";

const LandingPage = lazy(() =>
  import("@/pages/LandingPage").then((m) => ({ default: m.LandingPage })),
);
const ConnectWalletPage = lazy(() =>
  import("@/pages/ConnectWalletPage").then((m) => ({ default: m.ConnectWalletPage })),
);
const RolePickerPage = lazy(() =>
  import("@/pages/RolePickerPage").then((m) => ({ default: m.RolePickerPage })),
);
const TradePage = lazy(() => import("@/pages/TradePage").then((m) => ({ default: m.TradePage })));
const TicketsPage = lazy(() =>
  import("@/pages/TicketsPage").then((m) => ({ default: m.TicketsPage })),
);
const VaultPage = lazy(() => import("@/pages/VaultPage").then((m) => ({ default: m.VaultPage })));
const AgentPage = lazy(() => import("@/pages/AgentPage").then((m) => ({ default: m.AgentPage })));
const HspPaymentsPage = lazy(() =>
  import("@/pages/HspPaymentsPage").then((m) => ({ default: m.HspPaymentsPage })),
);
const DocsPage = lazy(() => import("@/pages/DocsPage").then((m) => ({ default: m.DocsPage })));
const PrivacyPage = lazy(() =>
  import("@/pages/PrivacyPage").then((m) => ({ default: m.PrivacyPage })),
);
const TermsPage = lazy(() => import("@/pages/TermsPage").then((m) => ({ default: m.TermsPage })));

export type AppRoute =
  | "/"
  | "/docs"
  | "/privacy"
  | "/terms"
  | "/connect"
  | "/start"
  | "/trade"
  | "/tickets"
  | "/vault"
  | "/agent"
  | "/agent/activity"
  | "/agent/policy"
  | "/payments";

const MARKETING_HOSTS = new Set(["tranche.space", "www.tranche.space"]);
const APP_HOST = "app.tranche.space";
const APP_ROUTES = new Set<AppRoute>([
  "/connect",
  "/start",
  "/trade",
  "/tickets",
  "/vault",
  "/agent",
  "/agent/activity",
  "/agent/policy",
  "/payments",
]);

function getHostKind(): "marketing" | "app" | "local" {
  if (typeof window === "undefined") return "local";
  const host = window.location.hostname.toLowerCase();
  if (host === APP_HOST) return "app";
  if (MARKETING_HOSTS.has(host)) return "marketing";
  return "local";
}

const RETURNING_WORKSPACE_ROUTES = new Set<AppRoute>([
  "/agent",
  "/agent/activity",
  "/agent/policy",
  "/trade",
  "/tickets",
  "/vault",
  "/payments",
]);

function getSavedReturningRoute(): AppRoute | null {
  try {
    const lastRoute = localStorage.getItem("tranche-last-route") as AppRoute | null;
    if (lastRoute && RETURNING_WORKSPACE_ROUTES.has(lastRoute)) {
      return lastRoute;
    }
    const role = localStorage.getItem("tranche-role");
    if (role === "agent") return "/agent";
    if (role === "lp") return "/vault";
    if (role === "trader") return "/trade";
    if (localStorage.getItem("tranche-wallet-rdns")) return "/agent";
  } catch {
    // ignore storage errors
  }
  return null;
}

function resolveRoute(pathname: string, hostKind: "marketing" | "app" | "local"): AppRoute {
  if (pathname === "/docs") return "/docs";
  if (pathname === "/privacy") return "/privacy";
  if (pathname === "/terms") return "/terms";
  if (pathname === "/connect") return "/connect";
  if (pathname === "/start") return "/start";
  if (pathname === "/trade") return "/trade";
  if (pathname === "/tickets") return "/tickets";
  if (pathname === "/vault") return "/vault";
  if (pathname === "/agent") return "/agent";
  if (pathname === "/agent/activity") return "/agent/activity";
  if (pathname === "/agent/policy") return "/agent/policy";
  if (pathname === "/payments") return "/payments";
  if (hostKind === "app") {
    return getSavedReturningRoute() ?? "/connect";
  }
  return "/";
}

function RouteFallback() {
  return <div className="min-h-screen bg-background text-foreground" aria-busy="true" />;
}

function AppRouter() {
  const hostKind = getHostKind();
  const [route, setRoute] = useState<AppRoute>(() =>
    resolveRoute(window.location.pathname, hostKind),
  );

  // Persist last visited workspace route so returning users skip /connect on app.tranche.space
  useEffect(() => {
    if (RETURNING_WORKSPACE_ROUTES.has(route)) {
      try {
        localStorage.setItem("tranche-last-route", route);
      } catch {
        // ignore storage errors
      }
      if (hostKind === "app" && window.location.pathname === "/") {
        window.history.replaceState({}, "", route);
      }
    }
  }, [route, hostKind]);

  useEffect(() => {
    const onPopState = () => {
      setRoute(resolveRoute(window.location.pathname, hostKind));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [hostKind]);

  const navigate = useCallback(
    (next: AppRoute) => {
      // Cross-subdomain navigation between tranche.space (marketing) and app.tranche.space (app)
      if (hostKind === "marketing" && APP_ROUTES.has(next)) {
        window.location.assign(`https://${APP_HOST}${next === "/connect" ? "" : next}`);
        return;
      }
      if (hostKind === "app" && next === "/") {
        window.location.assign("https://tranche.space");
        return;
      }

      if (window.location.pathname !== next) {
        window.history.pushState({}, "", next);
      }
      setRoute(next);
      window.scrollTo({ top: 0 });
    },
    [hostKind],
  );

  let page;
  if (route === "/connect") page = <ConnectWalletPage onNavigate={navigate} />;
  else if (route === "/start") page = <RolePickerPage onNavigate={navigate} />;
  else if (route === "/trade") page = <TradePage onNavigate={navigate} />;
  else if (route === "/tickets") page = <TicketsPage onNavigate={navigate} />;
  else if (route === "/vault") page = <VaultPage onNavigate={navigate} />;
  else if (route === "/agent") page = <AgentPage view="overview" onNavigate={navigate} />;
  else if (route === "/agent/activity") page = <AgentPage view="activity" onNavigate={navigate} />;
  else if (route === "/agent/policy") page = <AgentPage view="policy" onNavigate={navigate} />;
  else if (route === "/payments") page = <HspPaymentsPage onNavigate={navigate} />;
  else if (route === "/docs") page = <DocsPage onNavigate={navigate} />;
  else if (route === "/privacy") page = <PrivacyPage onNavigate={navigate} />;
  else if (route === "/terms") page = <TermsPage onNavigate={navigate} />;
  else page = <LandingPage onNavigate={navigate} />;

  return <Suspense fallback={<RouteFallback />}>{page}</Suspense>;
}

export function App() {
  return (
    <WalletProvider>
      <AppRouter />
    </WalletProvider>
  );
}

export default App;
