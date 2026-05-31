import type { Request } from "express";
import { DEVELOPMENT_APP_ORIGIN, PRODUCTION_APP_ORIGIN, isLocalAppOrigin } from "../../shared/app-url";
import { ENV } from "./env";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://sera.cx",
  "https://www.sera.cx",
  "https://app.sera.cx",
  "https://dev.sera.cx",
  "https://app.dev.sera.cx",
  "https://testnet.sera.cx",
  "https://app.testnet.sera.cx",
  PRODUCTION_APP_ORIGIN,
  "https://pay.sera.cx",
];

const DEFAULT_DEVELOPMENT_ORIGINS = [
  DEVELOPMENT_APP_ORIGIN,
  "http://localhost:3001",
  "http://localhost:3002",
];

const PRIVY_FRAME_ORIGINS = ["https://auth.privy.io", "https://*.privy.io"];
const WALLET_CONNECT_ORIGINS = ["https://*.walletconnect.com", "https://*.walletconnect.org"];

function parseOriginList(value: string): string[] {
  return value
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
}

function getConfiguredOrigins(): string[] {
  const configured = parseOriginList(ENV.allowedOrigins)
    .filter(origin => origin !== "*")
    .filter(origin => !ENV.isProduction || !isLocalAppOrigin(origin));
  const defaults = ENV.isProduction ? DEFAULT_ALLOWED_ORIGINS : [...DEFAULT_DEVELOPMENT_ORIGINS, ...DEFAULT_ALLOWED_ORIGINS];
  return Array.from(new Set([...defaults, ...configured]));
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (!ENV.isProduction && isLocalAppOrigin(origin)) return true;
  return getConfiguredOrigins().includes(origin);
}

export function getCorsOrigin(req: Request): string | null {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return null;
  if (isOriginAllowed(origin)) return origin;
  console.warn("[Security] Blocked request from unapproved origin", { origin, path: req.path });
  return null;
}

export function getContentSecurityPolicyDirectives() {
  const allowedOrigins = getConfiguredOrigins();
  const localConnect = ENV.isProduction ? [] : ["http://localhost:*", "ws://localhost:*", "http://127.0.0.1:*", "ws://127.0.0.1:*"];

  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", ...PRIVY_FRAME_ORIGINS, ...WALLET_CONNECT_ORIGINS],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
    imgSrc: ["'self'", "data:", "blob:", "https:"],
    connectSrc: ["'self'", "data:", "blob:", "https:", "wss:", "ws:", ...PRIVY_FRAME_ORIGINS, ...WALLET_CONNECT_ORIGINS, ...localConnect],
    frameSrc: [...PRIVY_FRAME_ORIGINS, ...WALLET_CONNECT_ORIGINS, "https://oauth.telegram.org"],
    childSrc: [...PRIVY_FRAME_ORIGINS, ...WALLET_CONNECT_ORIGINS],
    workerSrc: ["'self'", "blob:"],
    frameAncestors: ["'self'", ...allowedOrigins],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    reportUri: ["/api/security/csp-report"],
    upgradeInsecureRequests: ENV.isProduction ? [] : null,
  };
}

export function getPrivyDashboardAllowedOrigins(): string[] {
  return getConfiguredOrigins();
}
