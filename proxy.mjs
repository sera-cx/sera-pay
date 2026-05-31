/**
 * SeraPay Unified Reverse Proxy
 * Serves everything on port 3000:
 *   /api/*       → API server (port 8080)
 *   /wallet/*    → Wallet PWA static files
 *   /*           → Web frontend static files
 */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const API_PORT = 8080;

const WEB_DIST   = path.join(__dirname, "artifacts/web/dist/public");
const WALLET_DIST = path.join(__dirname, "artifacts/wallet-pwa/dist/public");

const MIME = {
  ".html":  "text/html; charset=utf-8",
  ".js":    "application/javascript",
  ".mjs":   "application/javascript",
  ".css":   "text/css",
  ".png":   "image/png",
  ".jpg":   "image/jpeg",
  ".jpeg":  "image/jpeg",
  ".svg":   "image/svg+xml",
  ".ico":   "image/x-icon",
  ".json":  "application/json",
  ".woff2": "font/woff2",
  ".woff":  "font/woff",
  ".ttf":   "font/ttf",
  ".webp":  "image/webp",
  ".map":   "application/json",
  ".txt":   "text/plain",
};

function serveStatic(distDir, urlPath, res) {
  const cleanPath = urlPath.split("?")[0];
  let filePath = path.join(distDir, cleanPath === "/" ? "index.html" : cleanPath);

  // Prevent path traversal
  if (!filePath.startsWith(distDir)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  const stat = fs.statSync(filePath);

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  fs.createReadStream(filePath).pipe(res);
}

function proxyToAPI(req, res) {
  const options = {
    hostname: "localhost",
    port: API_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${API_PORT}` },
  };
  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on("error", (err) => {
    console.error("[proxy] API error:", err.message);
    res.writeHead(502); res.end("API unavailable");
  });
  req.pipe(proxy, { end: true });
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";

  // Route: /api/* → API server
  if (url.startsWith("/api")) {
    return proxyToAPI(req, res);
  }

  // Route: /wallet/* → Wallet PWA (strip /wallet prefix)
  if (url.startsWith("/wallet")) {
    const walletPath = url.slice("/wallet".length) || "/";
    return serveStatic(WALLET_DIST, walletPath, res);
  }

  // Route: everything else → Web frontend
  return serveStatic(WEB_DIST, url, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[SeraPay] Proxy running on port ${PORT}`);
  console.log(`[SeraPay] Web:    http://localhost:${PORT}/`);
  console.log(`[SeraPay] Wallet: http://localhost:${PORT}/wallet/`);
  console.log(`[SeraPay] API:    http://localhost:${PORT}/api/healthz`);
});
