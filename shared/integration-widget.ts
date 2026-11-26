export const widgetFlows = ["accept", "swap", "transfer", "set-rate"] as const;
export type WidgetFlow = (typeof widgetFlows)[number];

export const widgetNetworks = ["sepolia", "live"] as const;
export type WidgetNetwork = (typeof widgetNetworks)[number];

export function readWidgetNetwork(
  search: URLSearchParams,
  fallback: WidgetNetwork = "sepolia",
): WidgetNetwork | null {
  const values = search.getAll("network");
  if (values.length === 0) return fallback;
  if (values.length !== 1) return null;
  return widgetNetworks.find((network) => network === values[0]) ?? null;
}

export function widgetGuidePath(flow: WidgetFlow, network: WidgetNetwork) {
  return `/${flow}/guide?network=${network}`;
}
