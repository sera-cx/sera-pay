const rawClientId = import.meta.env.VITE_PRIVY_CLIENT_ID || "";

export const privyConfig = {
  appId: import.meta.env.VITE_PRIVY_APP_ID || "",
  clientId: import.meta.env.DEV && import.meta.env.VITE_PRIVY_USE_CLIENT_ID_IN_DEV !== "true" ? "" : rawClientId,
};

export function isPrivyConfigured() {
  return Boolean(privyConfig.appId);
}

export function getPrivyConfigError() {
  if (!privyConfig.appId) return "Missing VITE_PRIVY_APP_ID.";
  return null;
}
