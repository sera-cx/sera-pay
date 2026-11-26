import { useLocation } from "wouter";
import { useSearch } from "wouter/use-browser-location";
import { readWidgetNetwork, type WidgetNetwork } from "@shared/integration-widget";

// The guide network selects sample copy and never changes the merchant wallet.
export function useWidgetNetwork() {
  const [path, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const network = readWidgetNetwork(params) ?? "sepolia";
  function selectNetwork(next: WidgetNetwork) {
    params.set("network", next);
    navigate(path + "?" + params + window.location.hash, { replace: true });
  }
  return { network, selectNetwork };
}
