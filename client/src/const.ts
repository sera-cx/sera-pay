// Privy login is launched in-app via usePrivy().login(). This URL is only used
// by legacy unauthorized handlers that need a safe fallback location.
export const getLoginUrl = () => {
  return "/";
};
