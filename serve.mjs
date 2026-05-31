import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WEB_DIST = path.join(__dirname, "artifacts/web/dist/public");
const WALLET_DIST = path.join(__dirname, "artifacts/wallet-pwa/dist/public");
const API_PORT = 8080;
const WEB_PORT = 22333;
const WALLET_PORT = 23630;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".map": "application/json",
};

function serveStatic(distDir, req, res) {
  let urlPath = req.url.split("?")[0];
  let filePath = path.join(distDir, urlPath === "/" ? "index.html" : urlPath);

  // Prevent path traversal
  if (!filePath.startsWith(distDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
}

function proxyToPort(port, req, res) {
  const options = {
    hostname: "localhost",
    port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${port}` },
  };
  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on("error", (err) => {
    res.writeHead(502);
    res.end(`Proxy error: ${err.message}`);
  });
  req.pipe(proxy, { end: true });
}

// ── Main web server (port 22333) — serves web frontend + proxies /api and /wallet ──
const webServer = http.createServer((req, res) => {
  if (req.url.startsWith("/api") || req.url === "/api") {
    proxyToPort(API_PORT, req, res);
  } else if (req.url.startsWith("/wallet")) {
    proxyToPort(WALLET_PORT, req, res);
  } else {
    serveStatic(WEB_DIST, req, res);
  }
});

// ── Wallet PWA server (port 23630) — serves wallet PWA ──
const walletServer = http.createServer((req, res) => {
  // Strip /wallet prefix if present
  if (req.url.startsWith("/wallet")) {
    req.url = req.url.slice("/wallet".length) || "/";
  }
  if (req.url.startsWith("/api")) {
    proxyToPort(API_PORT, req, res);
  } else {
    serveStatic(WALLET_DIST, req, res);
  }
});

webServer.listen(WEB_PORT, "0.0.0.0", () => {
  console.log(`[SeraPay] Web frontend: http://localhost:${WEB_PORT}`);
});

walletServer.listen(WALLET_PORT, "0.0.0.0", () => {
  console.log(`[SeraPay] Wallet PWA:   http://localhost:${WALLET_PORT}`);
});
