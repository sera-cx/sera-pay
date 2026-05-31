import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { paymentRouter } from "../payment-routes";
import { menuRouter } from "../menu-routes";
import { gatewayRouter } from "../gateway-routes";
import { validateRuntimeEnv } from "./env";
import { getContentSecurityPolicyDirectives, getCorsOrigin } from "./security";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  validateRuntimeEnv();

  const app = express();
  const server = createServer(app);

  // ── Trust proxy (required for correct IP behind production reverse proxies) ──
  app.set("trust proxy", 1);

  // ── HTTP → HTTPS redirect ─────────────────────────────────────────────────────
  // Telegram and some clients open http:// links; Privy/wagmi require HTTPS.
  // Production proxies set x-forwarded-proto when TLS is terminated upstream.
  if (process.env.NODE_ENV === "production") {
    app.use((req, res, next) => {
      const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "";
      if (proto && proto.split(",")[0].trim() !== "https") {
        return res.redirect(301, `https://${req.headers.host}${req.url}`);
      }
      next();
    });
  }

  // ── Compression (gzip) ─────────────────────────────────────────────────────
  app.use(compression());

  // ── Security headers via helmet ───────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: getContentSecurityPolicyDirectives(),
      },
      hsts:
        process.env.NODE_ENV === "production"
          ? { maxAge: 31536000, includeSubDomains: true, preload: true }
          : false,
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      // Required: Privy and WalletConnect embed iframes
      crossOriginEmbedderPolicy: false,
    })
  );

  // ── Rate limiters ─────────────────────────────────────────────────────────────
  const makeLimit = (max: number, msg: string) =>
    rateLimit({
      windowMs: 60_000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: msg },
    });

  app.use("/api/payment/create",   makeLimit(20, "Too many payment requests, please slow down."));
  app.use("/api/payment/notify",   makeLimit(10, "Too many notification requests, please slow down."));
  app.use("/api/merchant/register",makeLimit(5,  "Too many registration attempts."));
  app.use("/api/merchant/events",  makeLimit(30, "Too many SSE connections."));

  app.post(
    "/api/security/csp-report",
    express.json({ type: ["application/csp-report", "application/reports+json", "application/json"], limit: "32kb" }),
    (req, res) => {
      console.warn("[Security] CSP report", JSON.stringify(req.body).slice(0, 2000));
      res.sendStatus(204);
    }
  );

  // ── Body parsers ──────────────────────────────────────────────────────────────
  // Logo/image routes need up to 10 MB (base64 encoded); everything else gets 2 MB.
  app.use((req, res, next) => {
    const isLogoRoute =
      (req.method === "PUT" || req.method === "POST") &&
      (req.path.endsWith("/merchant/settings") || req.path.endsWith("/merchant/profile"));
    express.json({ limit: isLogoRoute ? "10mb" : "2mb" })(req, res, next);
  });
  app.use(express.urlencoded({ limit: "2mb", extended: true }));

  // ── CORS for wallet PWA and web frontend ──────────────────────────────────────
  app.use((req, res, next) => {
    const origin = getCorsOrigin(req);
    if (origin) {
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Api-Key,Authorization,X-Sera-Webhook-Secret");
    } else if (req.headers.origin) {
      if (req.method === "OPTIONS") { res.sendStatus(403); return; }
    }
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
  });

  // ── Payment API routes under /api/ ────────────────────────────────────────────
  app.use("/api", gatewayRouter);
  app.use("/api", paymentRouter);
  app.use("/api", menuRouter);

  // ── tRPC API ──────────────────────────────────────────────────────────────────
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // ── Static / Vite ─────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
