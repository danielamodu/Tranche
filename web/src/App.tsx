import { useCallback, useEffect, useState } from "react";
import { WalletProvider } from "@/context/WalletContext";
import { AgentPage } from "@/pages/AgentPage";
import { ConnectWalletPage } from "@/pages/ConnectWalletPage";
import { DocsPage } from "@/pages/DocsPage";
import { LandingPage } from "@/pages/LandingPage";
import { PrivacyPage } from "@/pages/PrivacyPage";
import { RolePickerPage } from "@/pages/RolePickerPage";
import { TermsPage } from "@/pages/TermsPage";
import { TicketsPage } from "@/pages/TicketsPage";
import { TradePage } from "@/pages/TradePage";
import { VaultPage } from "@/pages/VaultPage";

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
  | "/agent";

const MARKETING_HOSTS = new Set(["tranche.space", "www.tranche.space"]);
const APP_HOST = "app.tranche.space";
const APP_ROUTES = new Set<AppRoute>(["/connect", "/start", "/trade", "/tickets", "/vault", "/agent"]);

function getHostKind(): "marketing" | "app" | "local" {
  if (typeof window === "undefined") return "local";
  const host = window.location.hostname.toLowerCase();
  if (host === APP_HOST) return "app";
  if (MARKETING_HOSTS.has(host)) return "marketing";
  return "local";
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
  return hostKind === "app" ? "/connect" : "/";
}

function AppRouter() {
  const hostKind = getHostKind();
  const [route, setRoute] = useState<AppRoute>(() =>
    resolveRoute(window.location.pathname, hostKind),
  );

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

  if (route === "/connect") return <ConnectWalletPage onNavigate={navigate} />;
  if (route === "/start") return <RolePickerPage onNavigate={navigate} />;
  if (route === "/trade") return <TradePage onNavigate={navigate} />;
  if (route === "/tickets") return <TicketsPage onNavigate={navigate} />;
  if (route === "/vault") return <VaultPage onNavigate={navigate} />;
  if (route === "/agent") return <AgentPage onNavigate={navigate} />;
  if (route === "/docs") return <DocsPage onNavigate={navigate} />;
  if (route === "/privacy") return <PrivacyPage onNavigate={navigate} />;
  if (route === "/terms") return <TermsPage onNavigate={navigate} />;
  return <LandingPage onNavigate={navigate} />;
}

export function App() {
  return (
    <WalletProvider>
      <AppRouter />
    </WalletProvider>
  );
}

export default App;
