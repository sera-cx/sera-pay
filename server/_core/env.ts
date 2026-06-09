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
  seraApiTestnetBaseUrl: env("SERA_API_TESTNET_BASE_URL"),
  seraApiKey: env("SERA_API_KEY"),
  seraApiDebug: process.env.SERA_API_DEBUG === "true",
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

  if (errors.length > 0) {
    throw new Error([
      "Invalid production environment configuration:",
      ...errors.map((error) => `- ${error}`),
      "Generate each value with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    ].join("\n"));
  }
}
