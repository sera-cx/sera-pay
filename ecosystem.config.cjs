const path = require("node:path");

const appRoot = process.env.SERAPAY_CWD || __dirname;
require("dotenv").config({ path: path.join(appRoot, ".env") });

module.exports = {
  apps: [
    {
      name: "serapay-api",
      script: "node",
      args: "--enable-source-maps dist/index.js",
      cwd: appRoot,
      env: {
        NODE_ENV: "production",
        PORT: "8080",
        DATABASE_URL: process.env.DATABASE_URL || "",
        SESSION_SECRET: process.env.SESSION_SECRET || "",
        SERA_CONFIG_ENCRYPTION_KEY: process.env.SERA_CONFIG_ENCRYPTION_KEY || "",
        PAYMENT_BASE_URL: process.env.PAYMENT_BASE_URL || "",
        SERA_API_BASE_URL: process.env.SERA_API_BASE_URL || "https://api.sera.cx/api/v1",
        SERA_API_TESTNET_BASE_URL: process.env.SERA_API_TESTNET_BASE_URL || "https://api.testnet.sera.cx/api/v1",
        SERA_API_KEY: process.env.SERA_API_KEY || "",
        VITE_PRIVY_APP_ID: process.env.VITE_PRIVY_APP_ID || "",
        VITE_PRIVY_CLIENT_ID: process.env.VITE_PRIVY_CLIENT_ID || "",
        PRIVY_SECRET: process.env.PRIVY_SECRET || process.env.PRIVY_APP_SECRET || "",
        PRIVY_JWKS: process.env.PRIVY_JWKS || "",
        CLOUDFLARE_R2_BUCKET: process.env.CLOUDFLARE_R2_BUCKET || "",
        CLOUDFLARE_R2_ACCESS_KEY_ID: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || "",
        CLOUDFLARE_R2_SECRET_ACCESS_KEY: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || "",
        CLOUDFLARE_R2_API_TOKEN: process.env.CLOUDFLARE_R2_API_TOKEN || "",
        CLOUDFLARE_R2_ENDPOINT: process.env.CLOUDFLARE_R2_ENDPOINT || "",
        CLOUDFLARE_R2_PUBLIC_URL: process.env.CLOUDFLARE_R2_PUBLIC_URL || "",
        ALLOWED_ORIGINS: "https://sera.cx,https://www.sera.cx,https://app.sera.cx,https://dev.sera.cx,https://app.dev.sera.cx,https://testnet.sera.cx,https://app.testnet.sera.cx,https://pay.sera.cx,https://wallet.sera.cx",
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      log_file: "/tmp/serapay-api.log",
      error_file: "/tmp/serapay-api-error.log",
      out_file: "/tmp/serapay-api-out.log",
    },
    {
      name: "serapay-proxy",
      script: "node",
      args: "proxy.mjs",
      cwd: appRoot,
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      log_file: "/tmp/serapay-proxy.log",
      error_file: "/tmp/serapay-proxy-error.log",
      out_file: "/tmp/serapay-proxy-out.log",
    },
  ],
};
