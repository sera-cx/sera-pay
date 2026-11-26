import { Suspense, lazy, useEffect, useLayoutEffect } from "react";
import { useLocation } from "wouter";
import { syncGuideMetadata } from "@shared/guide-metadata";
import ErrorBoundary from "./components/ErrorBoundary";
import { RouteLoadingFallback } from "./components/RouteLoadingFallback";
import { integrationPath } from "./pages/integrations/catalog";
import { IntegrationHeader } from "./pages/integrations/Navigation";
import { GuideLoadingContent } from "./pages/integrations/GuideLoadingContent";

const MerchantApp = lazy(() => import("./App"));
const SwapGuide = lazy(() => import("./pages/swap-guide"));
const IntegrationGuide = lazy(() => import("./pages/integrations/IntegrationGuide"));

export default function AppRoutes() {
  const [path] = useLocation();
  const flow = integrationPath(path)?.flow;
  useEffect(() => { syncGuideMetadata(path); }, [path]);
  useLayoutEffect(() => {
    if (flow && !window.location.hash) window.scrollTo(0, 0);
  }, [flow]);

  if (!flow) {
    return <Suspense fallback={<RouteLoadingFallback />}><MerchantApp /></Suspense>;
  }
  return (
    <ErrorBoundary>
      <Suspense fallback={
        <div className="si-page">
          <IntegrationHeader flow={flow} />
          <GuideLoadingContent flow={flow} />
        </div>
      }>
        {flow === "swap" ? <SwapGuide /> : <IntegrationGuide key={flow} flow={flow} />}
      </Suspense>
    </ErrorBoundary>
  );
}
