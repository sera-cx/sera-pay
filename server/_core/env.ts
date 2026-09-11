import { resolveAppOrigin } from "../../shared/app-url";

function env(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}

export const ENV = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  paymentBaseUrl: resolveAppOrigin({
    configuredOrigin: env("PAYMENT_BASE_URL", "APP_BASE_URL", "VITE_APP_BASE_URL"),
    nodeEnv: process.env.NODE_ENV,
  }),
  seraApiBaseUrl: env("SERA_API_BASE_URL"),
  /** Sera's own web app, which serves the reference FX feed its swap UI reads. */
  seraAppBaseUrl: env("SERA_APP_BASE_URL") || "https://app.sera.cx",
  seraApiTestnetBaseUrl: env("SERA_API_TESTNET_BASE_URL"),
  seraApiKey: env("SERA_API_KEY"),
  // Advisory quote owner used only by the merchant-side liquidity preflight.
  // It never signs, submits, receives, or holds funds.
  seraPreflightProbeAddress: env("SERA_PREFLIGHT_PROBE_ADDRESS"),
  // Optional server-side quote safety policy. Empty values leave a limit off.
  seraMaxGasCostUsd: env("SERA_MAX_GAS_COST_USD"),
  seraMaxQuoteInputDeviationBps: env("SERA_MAX_QUOTE_INPUT_DEVIATION_BPS"),
  // Positive settlement latency policy. Missing-event failures still require
  // a finalized scan regardless of this setting.
  seraProvisionalConfirmations: env("SERA_PROVISIONAL_CONFIRMATIONS"),
  // Master switch for Sepolia. Off unless explicitly enabled, so no request
  // parameter, stale database row, or old QR code can route real money to a
  // test network. Sera itself only supports Ethereum mainnet and Sepolia.
  seraEnableTestnet: env("SERA_ENABLE_TESTNET").toLowerCase() === "true",
  goldskyGraphqlUrl: env("GOLDSKY_GRAPHQL_URL"),
  alchemyApiKey: env("ALCHEMY_API_KEY"),
  rpcUrls: {
    1: env("ETHEREUM_RPC_URL", "MAINNET_RPC_URL", "RPC_URL_1"),
    137: env("POLYGON_RPC_URL", "RPC_URL_137"),
    8453: env("BASE_RPC_URL", "RPC_URL_8453"),
    42161: env("ARBITRUM_RPC_URL", "ARBITRUM_ONE_RPC_URL", "RPC_URL_42161"),
    11155111: env("SEPOLIA_RPC_URL", "ETHEREUM_SEPOLIA_RPC_URL", "RPC_URL_11155111"),
  } as Record<number, string>,
  privyAppId: env("PRIVY_APP_ID", "VITE_PRIVY_APP_ID"),
  privyClientId: env("PRIVY_CLIENT_ID", "VITE_PRIVY_CLIENT_ID"),
  privyAppSecret: env("PRIVY_SECRET", "PRIVY_APP_SECRET"),
  privyJwks: env("PRIVY_JWKS"),
  privyJwtIssuer: "privy.io",
  allowedOrigins: process.env.ALLOWED_ORIGINS ?? "",
  r2AccountId: env("CLOUDFLARE_R2_ACCOUNT_ID"),
  r2AccessKeyId: env("CLOUDFLARE_R2_ACCESS_KEY_ID"),
  r2SecretAccessKey: env("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
  r2ApiToken: env("CLOUDFLARE_R2_API_TOKEN"),
  r2Bucket: env("CLOUDFLARE_R2_BUCKET"),
  r2Endpoint: env("CLOUDFLARE_R2_ENDPOINT"),
  r2PublicUrl: env("CLOUDFLARE_R2_PUBLIC_URL"),
};

function requireProductionSecret(errors: string[], name: string, purpose: string) {
  const value = process.env[name]?.trim() ?? "";
  if (Buffer.byteLength(value, "utf8") < 32) {
    errors.push(`${name} must be at least 32 bytes (${purpose}).`);
  }
}

export function validateRuntimeEnv() {
  if (!ENV.isProduction) return;

  const errors: string[] = [];
  requireProductionSecret(errors, "SESSION_SECRET", "generate a stable random value for server session/cookie signing");
  requireProductionSecret(errors, "SERA_CONFIG_ENCRYPTION_KEY", "generate a stable random value for encrypting saved Sera API credentials");
  if (!/^postgres(?:ql)?:\/\//i.test(ENV.databaseUrl.trim())) {
    errors.push("DATABASE_URL must be a PostgreSQL connection URL (payment lifecycle durability and recovery).");
  }
  try {
    const rpcUrl = new URL(ENV.rpcUrls[1]);
    if (rpcUrl.protocol !== "https:" && rpcUrl.protocol !== "http:") throw new Error("unsupported protocol");
  } catch {
    errors.push("ETHEREUM_RPC_URL must be an HTTP(S) Ethereum mainnet RPC URL (prompt settlement scans).");
  }

  if (errors.length > 0) {
    throw new Error([
      "Invalid production environment configuration:",
      ...errors.map((error) => `- ${error}`),
      "Generate each value with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    ].join("\n"));
  }
}
