import { useCallback, useEffect, useState } from "react";
import { DocsPage } from "@/pages/DocsPage";
import { LandingPage } from "@/pages/LandingPage";
import { PrivacyPage } from "@/pages/PrivacyPage";
import { TermsPage } from "@/pages/TermsPage";

export type AppRoute = "/" | "/docs" | "/privacy" | "/terms";

function resolveRoute(pathname: string): AppRoute {
  if (pathname === "/docs") return "/docs";
  if (pathname === "/privacy") return "/privacy";
  if (pathname === "/terms") return "/terms";
  return "/";
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => resolveRoute(window.location.pathname));

  useEffect(() => {
    const onPopState = () => {
      setRoute(resolveRoute(window.location.pathname));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: AppRoute) => {
    if (window.location.pathname !== next) {
      window.history.pushState({}, "", next);
    }
    setRoute(next);
    window.scrollTo({ top: 0 });
  }, []);

  if (route === "/docs") return <DocsPage onNavigate={navigate} />;
  if (route === "/privacy") return <PrivacyPage onNavigate={navigate} />;
  if (route === "/terms") return <TermsPage onNavigate={navigate} />;
  return <LandingPage onNavigate={navigate} />;
}

export default App;
