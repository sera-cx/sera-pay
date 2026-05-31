/**
 * SEO Landing Pages — SeraPay
 *
 * 30+ pages targeting high-value search intents around stablecoin payments,
 * multi-currency acceptance, regional markets, use cases, and comparisons.
 * Linked from the homepage footer. Content-rich for crawlers, unobtrusive for users.
 */

import { SeraPayHeader } from "@/components/SeraPayHeader";
import { SeraPayFooter } from "@/components/SeraPayFooter";
import { Link, useLocation } from "wouter";

// ── Design tokens ─────────────────────────────────────────────────────────────
const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const green = "#00C853";
const darkGreen = "#009A3E";
const darkText = "#0A1F1A";
const mutedText = "#3D5A4F";
const bg = "#F2FAF6";
const borderColor = "rgba(78,206,154,0.18)";

// ── SVG Line Icons (SeraPay-branded, stroke-based) ────────────────────────────
const Icon = {
  Zap: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
  Globe: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>
  ),
  Lock: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  ),
  QrCode: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="3" y="14" width="7" height="7"/>
      <path d="M14 14h3v3h-3zM17 17h3v3h-3zM14 20h3"/>
    </svg>
  ),
  Coins: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/>
      <path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>
    </svg>
  ),
  Receipt: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/>
      <path d="M16 8H8M16 12H8M12 16H8"/>
    </svg>
  ),
  Phone: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
      <line x1="12" y1="18" x2="12.01" y2="18"/>
    </svg>
  ),
  Shield: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
  ArrowRight: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
    </svg>
  ),
  Layers: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2"/>
      <polyline points="2 17 12 22 22 17"/>
      <polyline points="2 12 12 17 22 12"/>
    </svg>
  ),
  Check: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  Link2: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  ),
  Store: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  ),
  Clock: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  ),
  NoCard: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
      <line x1="1" y1="10" x2="23" y2="10"/>
      <line x1="4" y1="4" x2="20" y2="20" stroke="#e53935"/>
    </svg>
  ),
  Wallet: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12V22H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2"/>
      <path d="M20 12a2 2 0 0 0-2-2h-2a2 2 0 0 0 0 4h2a2 2 0 0 0 2-2z"/>
    </svg>
  ),
  Users: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  TrendUp: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
      <polyline points="17 6 23 6 23 12"/>
    </svg>
  ),
  Code: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
    </svg>
  ),
  Repeat: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9"/>
      <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
      <polyline points="7 23 3 19 7 15"/>
      <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
    </svg>
  ),
};

// ── All SEO pages index ───────────────────────────────────────────────────────
export const SEO_PAGES: { href: string; label: string; category: string }[] = [
  // Core gateway
  { href: "/stablecoin-payment-gateway", label: "Stablecoin Payment Gateway", category: "Core" },
  { href: "/multi-currency-crypto-payments", label: "Multi-Currency Crypto Payments", category: "Core" },
  { href: "/web3-payment-gateway", label: "Web3 Payment Gateway", category: "Core" },
  { href: "/no-integration-crypto-payments", label: "Accept Crypto Without Integration", category: "Core" },
  { href: "/crypto-qr-payment", label: "Crypto QR Code Payment", category: "Core" },
  { href: "/non-custodial-payment-gateway", label: "Non-Custodial Payment Gateway", category: "Core" },
  // By coin
  { href: "/accept-usdc-payments", label: "Accept USDC Payments", category: "By Coin" },
  { href: "/accept-usdt-payments", label: "Accept USDT Payments", category: "By Coin" },
  { href: "/accept-xsgd-payments", label: "Accept XSGD Payments", category: "By Coin" },
  { href: "/accept-eurc-payments", label: "Accept EURC Payments", category: "By Coin" },
  { href: "/accept-multiple-stablecoins", label: "Accept Multiple Stablecoins at Once", category: "By Coin" },
  // By use case
  { href: "/crypto-payments-for-freelancers", label: "Crypto Payments for Freelancers", category: "Use Case" },
  { href: "/crypto-payments-for-restaurants", label: "Crypto Payments for Restaurants", category: "Use Case" },
  { href: "/crypto-payments-for-ecommerce", label: "Crypto Payments for E-Commerce", category: "Use Case" },
  { href: "/crypto-payments-for-ngos", label: "Crypto Donations for NGOs", category: "Use Case" },
  { href: "/crypto-payments-for-events", label: "Crypto Payments for Events", category: "Use Case" },
  { href: "/crypto-invoice-payments", label: "Crypto Invoice Payments", category: "Use Case" },
  // By region
  { href: "/crypto-payments-singapore", label: "Crypto Payments in Singapore", category: "By Region" },
  { href: "/crypto-payments-malaysia", label: "Crypto Payments in Malaysia", category: "By Region" },
  { href: "/crypto-payments-philippines", label: "Crypto Payments in Philippines", category: "By Region" },
  { href: "/crypto-payments-indonesia", label: "Crypto Payments in Indonesia", category: "By Region" },
  { href: "/crypto-payments-thailand", label: "Crypto Payments in Thailand", category: "By Region" },
  // By feature
  { href: "/instant-crypto-settlement", label: "Instant Crypto Settlement", category: "Features" },
  { href: "/no-kyc-crypto-payments", label: "Accept Crypto Without KYC", category: "Features" },
  { href: "/crypto-payment-link", label: "Crypto Payment Link Generator", category: "Features" },
  { href: "/stablecoin-qr-code-generator", label: "Stablecoin QR Code Generator", category: "Features" },
  // Comparisons
  { href: "/serapay-vs-stripe-crypto", label: "SeraPay vs Stripe for Crypto", category: "Comparisons" },
  { href: "/serapay-vs-coinbase-commerce", label: "SeraPay vs Coinbase Commerce", category: "Comparisons" },
  { href: "/serapay-vs-bitpay", label: "SeraPay vs BitPay", category: "Comparisons" },
  { href: "/serapay-vs-nowpayments", label: "SeraPay vs NOWPayments", category: "Comparisons" },
];

// ── Shared layout ─────────────────────────────────────────────────────────────
function SeoLayout({ children }: { children: React.ReactNode }) {
  const [, setLocation] = useLocation();

  return (
    <div style={{ minHeight: "100dvh", background: bg, fontFamily: font, color: darkText }}>
      <SeraPayHeader
        maxWidth={900}
        primaryAction={{ label: "Get Started", onClick: () => setLocation("/") }}
      />
      <main style={{ maxWidth: 800, margin: "0 auto", padding: "52px 24px 80px" }}>{children}</main>
      <SeoFooter />
    </div>
  );
}

// ── Shared footer ─────────────────────────────────────────────────────────────
export function SeoFooter() {
  const categories = [...new Set(SEO_PAGES.map(p => p.category))];
  const sections = categories.map((category) => ({
    title: category,
    links: SEO_PAGES.filter((page) => page.category === category).map(({ href, label }) => ({ href, label })),
  }));
  return (
    <SeraPayFooter sections={sections} />
  );
}

// ── Shared components ─────────────────────────────────────────────────────────
function H1({ children }: { children: React.ReactNode }) {
  return <h1 style={{ fontSize: 34, fontWeight: 900, color: darkText, margin: "0 0 18px", letterSpacing: "-0.8px", lineHeight: 1.2 }}>{children}</h1>;
}
function H2({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 22, fontWeight: 800, color: darkText, margin: "44px 0 12px", letterSpacing: "-0.4px" }}>{children}</h2>;
}
function Lead({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 15, color: mutedText, lineHeight: 1.75, margin: "0 0 16px" }}>{children}</p>;
}
function FeatureGrid({ features }: { features: { icon: React.ReactNode; title: string; desc: string }[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14, margin: "28px 0" }}>
      {features.map((f, i) => (
        <div key={i} style={{ background: "#fff", border: `1px solid ${borderColor}`, borderRadius: 14, padding: "18px 16px" }}>
          <div style={{ marginBottom: 10 }}>{f.icon}</div>
          <p style={{ fontSize: 13, fontWeight: 700, color: darkText, margin: "0 0 5px" }}>{f.title}</p>
          <p style={{ fontSize: 12, color: mutedText, margin: 0, lineHeight: 1.55 }}>{f.desc}</p>
        </div>
      ))}
    </div>
  );
}
function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <div style={{ borderBottom: `1px solid ${borderColor}`, padding: "18px 0" }}>
      <p style={{ fontSize: 15, fontWeight: 700, color: darkText, margin: "0 0 8px" }}>{q}</p>
      <p style={{ fontSize: 14, color: mutedText, margin: 0, lineHeight: 1.7 }}>{a}</p>
    </div>
  );
}
function CompareTable({ rows }: { rows: [string, string, string][] }) {
  return (
    <div style={{ overflowX: "auto", margin: "16px 0 32px" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr style={{ background: "#EAF7F0" }}>
            <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 700, color: darkText, borderBottom: `1px solid ${borderColor}` }}>Feature</th>
            <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 700, color: green, borderBottom: `1px solid ${borderColor}` }}>SeraPay</th>
            <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 700, color: mutedText, borderBottom: `1px solid ${borderColor}` }}>Competitor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([feature, sera, comp]) => (
            <tr key={feature} style={{ borderBottom: `1px solid ${borderColor}` }}>
              <td style={{ padding: "12px 16px", color: darkText, fontWeight: 500 }}>{feature}</td>
              <td style={{ padding: "12px 16px", color: green, fontWeight: 600 }}>{sera}</td>
              <td style={{ padding: "12px 16px", color: mutedText }}>{comp}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function CtaBanner() {
  return (
    <div style={{ background: green, borderRadius: 16, padding: "28px 24px", textAlign: "center", marginTop: 52 }}>
      <h2 style={{ fontSize: 20, fontWeight: 800, color: "#fff", margin: "0 0 8px" }}>Start accepting multi-currency stablecoin payments today</h2>
      <p style={{ fontSize: 14, color: "rgba(255,255,255,0.85)", margin: "0 0 20px" }}>USDC, USDT, XSGD, EURC and more — all at once. No integration. No KYC. 60-second setup.</p>
      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        <Link href="/"><button style={{ background: "#fff", color: green, border: "none", borderRadius: 24, padding: "12px 28px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Create Your Free Payment Page</button></Link>
        <a href="https://monetapay.to" target="_blank" rel="noopener noreferrer" style={{ background: "rgba(255,255,255,0.15)", color: "#fff", border: "1px solid rgba(255,255,255,0.4)", borderRadius: 24, padding: "12px 28px", fontSize: 14, fontWeight: 600, textDecoration: "none", display: "inline-block" }}>Need more power? → Monetapay.to</a>
      </div>
    </div>
  );
}
function MonetaCallout() {
  return (
    <div style={{ background: "#fff", border: `1px solid ${borderColor}`, borderRadius: 14, padding: "20px 22px", margin: "32px 0", display: "flex", gap: 16, alignItems: "flex-start" }}>
      <div style={{ flexShrink: 0, marginTop: 2 }}><Icon.ArrowRight /></div>
      <div>
        <p style={{ fontSize: 14, fontWeight: 700, color: darkText, margin: "0 0 4px" }}>Need more sophisticated features?</p>
        <p style={{ fontSize: 13, color: mutedText, margin: 0, lineHeight: 1.6 }}>SeraPay is built for speed and simplicity — zero setup, your wallet, multi-currency. For advanced workflows like order management, team accounts, developer APIs, and enterprise integrations, check out <a href="https://monetapay.to" target="_blank" rel="noopener noreferrer" style={{ color: green, fontWeight: 600 }}>Monetapay.to</a>.</p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE PAGES
// ═══════════════════════════════════════════════════════════════════════════════

export function StablecoinPaymentGatewayPage() {
  return (
    <SeoLayout>
      <H1>Stablecoin Payment Gateway for Merchants</H1>
      <Lead>SeraPay is a lightweight stablecoin payment gateway that lets any business or freelancer accept USDC, USDT, XSGD, EURC, and more — all at the same time, from a single QR code. No bank account, no developer, no integration required.</Lead>
      <Lead>Most stablecoin payment gateways force you to choose one currency. SeraPay is different: your payment page accepts every supported stablecoin simultaneously. A customer in Singapore can pay in XSGD, a customer in Europe can pay in EURC, and a customer anywhere can pay in USDC — all to the same QR code, all arriving directly in your wallet.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Zap />, title: "Instant settlement", desc: "Funds arrive in your wallet in seconds, not days." },
        { icon: <Icon.Coins />, title: "Multi-currency by default", desc: "USDC, USDT, XSGD, EURC, EURT — all at once." },
        { icon: <Icon.Lock />, title: "Non-custodial", desc: "Payments go directly to your wallet. SeraPay never holds funds." },
        { icon: <Icon.QrCode />, title: "QR & link payments", desc: "Generate a QR code or shareable link in under 60 seconds." },
        { icon: <Icon.Globe />, title: "Global by default", desc: "Accept payments from any country without FX fees." },
        { icon: <Icon.Receipt />, title: "On-chain receipts", desc: "Every payment is permanently verifiable on the blockchain." },
      ]} />
      <H2>Why multi-currency matters for merchants</H2>
      <Lead>Single-currency gateways create friction: customers who hold USDT cannot pay a merchant who only accepts USDC, and vice versa. SeraPay eliminates this entirely. Your payment page is currency-agnostic — customers pay in whatever stablecoin they hold, and you receive it directly. No conversion, no middleman, no lost sales.</Lead>
      <Lead>This is especially valuable for merchants serving international customers. A restaurant in Singapore can accept XSGD from local customers and USDC from tourists in the same session, from the same QR code, with no configuration changes.</Lead>
      <H2>How SeraPay works</H2>
      <Lead>Log in with your wallet or email. SeraPay generates a permanent payment page and QR code tied to your wallet address. Share the QR code at your counter, in an invoice, or on your website. Customers pay with any compatible wallet app. Funds arrive in your wallet in seconds.</Lead>
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Which stablecoins does SeraPay support?" a="SeraPay currently supports USDC, USDT, XSGD, EURC, and EURT across Ethereum, Polygon, Base, Arbitrum, Optimism, and BNB Chain. Customers can pay in any of these from a single QR code." />
      <FaqItem q="Do I need a bank account?" a="No. SeraPay sends payments directly to your crypto wallet. No bank account, no business registration, and no KYC required to start." />
      <FaqItem q="What are the fees?" a="SeraPay charges no platform fee. The only cost is the on-chain gas fee paid by the sender — typically under $0.01 on Layer 2 networks like Base, Polygon, or Arbitrum." />
      <FaqItem q="Is SeraPay custodial?" a="No. Payments go directly from the customer's wallet to your wallet. SeraPay never holds, controls, or has access to your funds." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function MultiCurrencyCryptoPaymentsPage() {
  return (
    <SeoLayout>
      <H1>Multi-Currency Crypto Payments — Accept All Stablecoins at Once</H1>
      <Lead>SeraPay is the only lightweight payment gateway that lets merchants accept multiple stablecoins simultaneously from a single QR code. USDC, USDT, XSGD, EURC, and EURT — your customers pay in whatever they hold, and you receive it directly in your wallet.</Lead>
      <Lead>Most crypto payment tools are built around a single token. This creates a fragmented experience: you need different setups for different currencies, and customers who hold the "wrong" stablecoin simply cannot pay. SeraPay solves this with a truly multi-currency payment page that requires zero additional configuration.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Coins />, title: "All stablecoins, one QR", desc: "USDC, USDT, XSGD, EURC, EURT — one payment page." },
        { icon: <Icon.Globe />, title: "Regional currencies supported", desc: "XSGD for Singapore for Malaysia, EURC for Europe." },
        { icon: <Icon.Zap />, title: "No switching required", desc: "Customers pay in their preferred coin — no conversion needed." },
        { icon: <Icon.Lock />, title: "Direct to your wallet", desc: "Every currency lands directly in your wallet address." },
        { icon: <Icon.Layers />, title: "Multi-chain", desc: "Ethereum, Base, Polygon, Arbitrum, Optimism, BNB Chain." },
        { icon: <Icon.Receipt />, title: "Unified history", desc: "All currencies appear in one transaction dashboard." },
      ]} />
      <H2>The problem with single-currency gateways</H2>
      <Lead>If you only accept USDC, you exclude every customer who holds USDT, XSGD, or EURC. In Southeast Asia, where XSGD is growing rapidly, a USDC-only gateway misses a significant portion of the market. SeraPay's multi-currency approach means you never turn away a customer because of the coin they hold.</Lead>
      <CompareTable rows={[
        ["Currencies accepted", "USDC, USDT, XSGD, EURC, EURT", "Typically 1–2"],
        ["Regional stablecoins", "Yes (XSGD)", "Rarely"],
        ["Setup per currency", "None — all included", "Separate config per coin"],
        ["Customer friction", "None — pay in any coin", "Must hold specific coin"],
        ["Integration required", "No", "Often yes"],
      ]} />
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Can I receive different stablecoins in the same wallet?" a="Yes. Your wallet address receives any ERC-20 stablecoin. SeraPay's payment page lets customers choose their preferred coin, and all of them arrive in the same wallet." />
      <FaqItem q="What if I only want to accept specific currencies?" a="SeraPay allows you to configure which coins are displayed on your payment page. You can show all supported coins or restrict to a subset." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function Web3PaymentGatewayPage() {
  return (
    <SeoLayout>
      <H1>Web3 Payment Gateway for Merchants</H1>
      <Lead>SeraPay is a Web3 payment gateway built on the Sera Protocol. It enables merchants to accept on-chain stablecoin payments — USDC, USDT, XSGD, EURC, and more — without custodians, intermediaries, or complex integrations. Funds go directly from the customer's wallet to yours.</Lead>
      <Lead>Web3 payments differ fundamentally from traditional crypto payment processors: there is no company holding your money at any point. SeraPay is entirely non-custodial — your wallet address is the payment destination, and SeraPay is simply the interface that makes it easy for customers to pay.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Lock />, title: "Non-custodial", desc: "Funds go directly to your wallet — SeraPay never holds them." },
        { icon: <Icon.Layers />, title: "Multi-chain EVM", desc: "Ethereum, Base, Polygon, Arbitrum, Optimism, BNB Chain." },
        { icon: <Icon.Wallet />, title: "WalletConnect support", desc: "Customers pay with any WalletConnect-compatible wallet." },
        { icon: <Icon.Coins />, title: "Multi-currency", desc: "USDC, USDT, XSGD, EURC, EURT — all supported." },
        { icon: <Icon.Receipt />, title: "On-chain receipts", desc: "Every payment is permanently recorded on the blockchain." },
        { icon: <Icon.Shield />, title: "Self-sovereign", desc: "You own your payment infrastructure — no vendor lock-in." },
      ]} />
      <H2>SeraPay vs. traditional payment gateways</H2>
      <CompareTable rows={[
        ["Settlement time", "Seconds", "1–3 business days"],
        ["Transaction fee", "< $0.01 (gas only)", "2–3% + fixed fee"],
        ["Chargebacks", "None (irreversible)", "Yes — fraud risk"],
        ["KYC required", "No", "Yes"],
        ["Geographic limits", "None", "Many countries blocked"],
        ["Custody of funds", "Non-custodial", "Custodial"],
        ["Currencies accepted", "6+ stablecoins simultaneously", "Usually 1"],
        ["Integration required", "No", "Yes (API/plugin)"],
      ]} />
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="What is the Sera Protocol?" a="Sera Protocol is the underlying infrastructure that SeraPay is built on. It provides the smart contract layer for payment routing, multi-currency support, and future DeFi features." />
      <FaqItem q="Is SeraPay suitable for high-volume merchants?" a="SeraPay is optimised for simplicity and zero-setup. For high-volume merchants needing order management, team accounts, and developer APIs, Monetapay.to is the recommended upgrade path." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function NoIntegrationCryptoPaymentsPage() {
  return (
    <SeoLayout>
      <H1>Accept Crypto Payments Without Any Integration</H1>
      <Lead>Most crypto payment processors require API keys, webhook endpoints, or developer time. SeraPay requires none of that. Log in, set your business name, and your multi-currency payment page is live — accepting USDC, USDT, XSGD, EURC, and more in under 60 seconds.</Lead>
      <Lead>SeraPay is built for merchants who want the benefits of crypto payments — instant settlement, no chargebacks, global reach, multi-currency — without the technical complexity of a full payment integration.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Clock />, title: "60-second setup", desc: "Log in, set your business name, and your payment page is live." },
        { icon: <Icon.Code />, title: "No code required", desc: "No API, no webhooks, no smart contracts, no developer." },
        { icon: <Icon.Link2 />, title: "Shareable link", desc: "Share your payment link via WhatsApp, email, or social media." },
        { icon: <Icon.QrCode />, title: "QR code included", desc: "Download a printable QR code for in-person payments." },
        { icon: <Icon.Coins />, title: "Multi-currency", desc: "USDC, USDT, XSGD, EURC — all from one page." },
        { icon: <Icon.Globe />, title: "No geographic limits", desc: "Accept payments from any country without local banking setup." },
      ]} />
      <H2>Why most crypto payment solutions require integration</H2>
      <Lead>Traditional crypto payment gateways are designed for e-commerce platforms. They require plugins, webhook configuration, and server-side code to handle payment confirmations. This is appropriate for automated order fulfilment, but overkill for merchants who simply want to receive money. SeraPay takes a different approach: the payment page is hosted by SeraPay, the QR code links directly to it, and you receive funds directly in your wallet.</Lead>
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Do I need a website to use SeraPay?" a="No. SeraPay hosts your payment page at pay.sera.cx. You share the link or QR code directly with customers — no website required." />
      <FaqItem q="Can I accept payments offline?" a="Yes. Print your QR code and display it at your stall or counter. Customers scan it with their phone and pay from their wallet. The payment arrives in seconds." />
      <FaqItem q="What if I want deeper integration later?" a="SeraPay provides a shareable payment link you can embed as a button on any website. For full developer API access and advanced workflows, Monetapay.to is the recommended next step." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function CryptoQrPaymentPage() {
  return (
    <SeoLayout>
      <H1>Crypto QR Code Payments for Merchants</H1>
      <Lead>SeraPay generates a branded crypto QR code for your business in under 60 seconds. Customers scan it with any mobile crypto wallet to pay in USDC, USDT, XSGD, EURC, or other stablecoins — no app download, no card reader, and no single-currency restriction.</Lead>
      <Lead>Unlike single-currency QR codes, SeraPay's QR links to a multi-currency payment page. The customer chooses which stablecoin to send — you receive it directly in your wallet regardless of which coin they pick.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.QrCode />, title: "Printable QR code", desc: "Download and print your QR code for countertop or wall display." },
        { icon: <Icon.Coins />, title: "Multi-currency", desc: "One QR code accepts USDC, USDT, XSGD, EURC, and more." },
        { icon: <Icon.Phone />, title: "Any wallet app", desc: "Works with MetaMask, Coinbase Wallet, Trust Wallet, and 300+ others." },
        { icon: <Icon.Zap />, title: "Fixed or open amount", desc: "Set a specific price or let customers enter their own amount." },
        { icon: <Icon.Receipt />, title: "Instant receipt", desc: "Customers receive an on-chain receipt immediately after payment." },
        { icon: <Icon.Store />, title: "Point-of-sale ready", desc: "Designed for restaurants, markets, and retail counters." },
      ]} />
      <H2>How crypto QR payments work</H2>
      <Lead>A SeraPay QR code encodes a link to your hosted payment page. When a customer scans it, they see your business name, the requested amount (if set), and a list of accepted stablecoins. They connect their wallet, choose their preferred coin, and confirm the payment. Funds arrive in your wallet in seconds.</Lead>
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Can I use the same QR code for multiple payments?" a="Yes. Your default SeraPay QR code is permanent and reusable. You can also generate single-use payment links for specific orders." />
      <FaqItem q="Can I add my logo to the QR code?" a="Yes. SeraPay lets you upload your business logo, which is embedded in the centre of the QR code. You can also customise the dot style and colours." />
      <FaqItem q="What if a customer wants to pay in a coin I don't see?" a="SeraPay supports the most widely used stablecoins. If you need support for additional tokens, Monetapay.to offers a broader token catalogue." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function NonCustodialPaymentGatewayPage() {
  return (
    <SeoLayout>
      <H1>Non-Custodial Crypto Payment Gateway</H1>
      <Lead>SeraPay is a fully non-custodial payment gateway. Every payment goes directly from the customer's wallet to your wallet address — SeraPay never holds, controls, or has access to your funds at any point. Your money is always yours.</Lead>
      <Lead>This is a fundamental difference from custodial gateways like Coinbase Commerce or BitPay, which hold your funds in their custody before releasing them to you. With SeraPay, there is no intermediary, no withdrawal process, and no risk of a platform freezing your account.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Lock />, title: "Zero custody", desc: "SeraPay never holds your funds. Payments go wallet-to-wallet." },
        { icon: <Icon.Shield />, title: "No freeze risk", desc: "No platform can freeze or withhold your payments." },
        { icon: <Icon.Wallet />, title: "Your wallet, your keys", desc: "You control your wallet. SeraPay is just the payment interface." },
        { icon: <Icon.Coins />, title: "Multi-currency", desc: "USDC, USDT, XSGD, EURC — all non-custodial." },
        { icon: <Icon.Receipt />, title: "On-chain proof", desc: "Every payment is publicly verifiable on the blockchain." },
        { icon: <Icon.Globe />, title: "No withdrawal delays", desc: "Funds are in your wallet instantly — no payout schedule." },
      ]} />
      <H2>Why non-custodial matters</H2>
      <Lead>Custodial payment processors hold your money between the time a customer pays and the time you receive it. This creates counterparty risk: if the platform is hacked, goes bankrupt, or freezes your account, your funds are at risk. Non-custodial payments eliminate this risk entirely — the blockchain is the settlement layer, not a company's database.</Lead>
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="How does SeraPay make money if it doesn't hold funds?" a="SeraPay is currently free to use. Revenue comes from premium features and the broader Sera Protocol ecosystem. There are no hidden fees on payment flows." />
      <FaqItem q="What happens if SeraPay shuts down?" a="Because SeraPay is non-custodial, your funds are always in your own wallet. If SeraPay shut down, your existing wallet would still hold all received payments. You would simply need a different interface to generate new payment requests." />
      <CtaBanner />
    </SeoLayout>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// BY COIN PAGES
// ═══════════════════════════════════════════════════════════════════════════════

export function AcceptUsdcPaymentsPage() {
  return (
    <SeoLayout>
      <H1>Accept USDC Payments — No Integration Required</H1>
      <Lead>SeraPay makes it effortless to accept USDC (USD Coin) payments for your business. Generate a payment QR code or link in under a minute — no code, no API keys, no developer needed. And unlike single-currency gateways, SeraPay also accepts USDT, XSGD, and EURC from the same QR code.</Lead>
      <Lead>USDC is the world's most widely used regulated stablecoin, issued by Circle and available on Ethereum, Base, Polygon, Arbitrum, and Optimism. It is redeemable 1:1 for US dollars and backed by fully reserved assets audited monthly.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Shield />, title: "Regulated & audited", desc: "USDC is issued by Circle and fully backed by USD reserves." },
        { icon: <Icon.Zap />, title: "Seconds to settle", desc: "USDC on Base or Polygon settles in under 5 seconds." },
        { icon: <Icon.Coins />, title: "Plus 5 other stablecoins", desc: "Accept USDT, XSGD, EURC too — all from one QR." },
        { icon: <Icon.Lock />, title: "No chargebacks", desc: "On-chain payments are irreversible — no fraud risk." },
        { icon: <Icon.Globe />, title: "Multi-chain", desc: "Accept USDC on Ethereum, Base, Polygon, Arbitrum, Optimism." },
        { icon: <Icon.NoCard />, title: "No KYC required", desc: "Start accepting USDC with just a wallet address." },
      ]} />
      <H2>Why accept USDC instead of card payments?</H2>
      <Lead>Credit card payments cost merchants 2–3% per transaction plus fixed fees, take 1–3 business days to settle, and carry chargeback risk. USDC payments settle in seconds on-chain, cost under $0.01 in gas on Layer 2 networks, and are irreversible — eliminating chargeback fraud entirely.</Lead>
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Which networks can I receive USDC on?" a="SeraPay supports USDC on Ethereum mainnet, Base, Polygon, Arbitrum, and Optimism. We recommend Base or Polygon for the lowest gas fees." />
      <FaqItem q="Can I also accept USDT and other stablecoins?" a="Yes — this is one of SeraPay's key advantages. Your payment page accepts USDC, USDT, XSGD, EURC, and EURT simultaneously. Customers pay in whichever coin they hold." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function AcceptUsdtPaymentsPage() {
  return (
    <SeoLayout>
      <H1>Accept USDT Payments for Your Business</H1>
      <Lead>SeraPay lets merchants, freelancers, and online sellers accept USDT (Tether) payments instantly — with a simple QR code or shareable link. No technical setup, no API integration, and no bank account required. Your payment page also accepts USDC, XSGD, and EURC simultaneously.</Lead>
      <Lead>USDT is the largest stablecoin by market cap and is widely used across Asia, the Middle East, and Latin America as a dollar substitute. Accepting USDT opens your business to a global customer base that prefers stablecoin payments over traditional banking.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Coins />, title: "USD-pegged", desc: "USDT is pegged 1:1 to the US dollar — stable value for merchants." },
        { icon: <Icon.Globe />, title: "Popular in Asia & EM", desc: "USDT is the preferred stablecoin in Southeast Asia, Middle East, and LatAm." },
        { icon: <Icon.Phone />, title: "Mobile-first", desc: "Customers pay by scanning a QR code from any mobile wallet." },
        { icon: <Icon.Zap />, title: "Instant settlement", desc: "USDT on Polygon or BNB Chain settles in seconds for under $0.01." },
        { icon: <Icon.Layers />, title: "Multi-chain", desc: "Accept USDT on Ethereum, Polygon, BNB Chain, Arbitrum, Optimism." },
        { icon: <Icon.Coins />, title: "Plus 5 other stablecoins", desc: "Accept USDC, XSGD, EURC too — all from one QR." },
      ]} />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Is USDT the same as USDC?" a="Both are USD-pegged stablecoins but issued by different companies. Tether issues USDT; Circle issues USDC. SeraPay supports both, so you can accept whichever your customers prefer — or both at once." />
      <FaqItem q="What is the cheapest network to receive USDT on?" a="Polygon and BNB Chain offer the lowest gas fees for USDT transfers, typically under $0.01. Ethereum mainnet is also supported but has higher gas fees." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function AcceptXsgdPaymentsPage() {
  return (
    <SeoLayout>
      <H1>Accept XSGD Payments in Singapore</H1>
      <Lead>SeraPay lets Singapore merchants accept XSGD — the Singapore Dollar stablecoin issued by StraitsX — directly to their wallet, alongside USDC, USDT, and EURC. One QR code, all stablecoins, zero setup.</Lead>
      <Lead>XSGD is pegged 1:1 to the Singapore Dollar and regulated under the Monetary Authority of Singapore (MAS). It is the preferred stablecoin for Singapore-based transactions, offering the familiarity of SGD with the speed and efficiency of blockchain settlement.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Shield />, title: "MAS-regulated", desc: "XSGD is issued by StraitsX and regulated under MAS guidelines." },
        { icon: <Icon.Coins />, title: "SGD-pegged", desc: "1 XSGD = 1 SGD — no currency conversion for local customers." },
        { icon: <Icon.Zap />, title: "Instant settlement", desc: "XSGD on Polygon or Ethereum settles in seconds." },
        { icon: <Icon.Globe />, title: "Plus global stablecoins", desc: "Accept USDC, USDT, EURC too — all from one QR." },
        { icon: <Icon.Lock />, title: "Non-custodial", desc: "XSGD goes directly to your wallet — no intermediary." },
        { icon: <Icon.NoCard />, title: "No bank account needed", desc: "Accept XSGD with just a wallet address." },
      ]} />
      <H2>Why accept XSGD?</H2>
      <Lead>For Singapore merchants, XSGD removes the need for currency conversion. Local customers pay in the currency they know — SGD — while you receive it on-chain with instant settlement. Combined with SeraPay's multi-currency support, you can accept XSGD from local customers and USDC or USDT from international customers, all from the same QR code.</Lead>
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Where can customers get XSGD?" a="XSGD is available on StraitsX's platform, as well as on major exchanges and DEXs that support Polygon and Ethereum tokens." />
      <FaqItem q="Can I accept both XSGD and USDC?" a="Yes — SeraPay accepts XSGD, USDC, USDT, EURC, and EURT simultaneously from a single QR code." />
      <CtaBanner />
    </SeoLayout>
  );
}


export function AcceptEurcPaymentsPage() {
  return (
    <SeoLayout>
      <H1>Accept EURC Payments — Euro Stablecoin</H1>
      <Lead>SeraPay lets merchants accept EURC (Euro Coin, issued by Circle) and EURT (Euro Tether) directly to their wallet, alongside USDC, USDT, and XSGD. One QR code, all stablecoins, zero setup.</Lead>
      <Lead>EURC is a fully reserved Euro stablecoin issued by Circle, the same company behind USDC. It is pegged 1:1 to the Euro and available on Ethereum, Base, and Solana. For merchants with European customers, accepting EURC eliminates currency conversion fees and provides instant settlement.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Shield />, title: "Circle-issued", desc: "EURC is issued by Circle — the same trusted issuer as USDC." },
        { icon: <Icon.Coins />, title: "EUR-pegged", desc: "1 EURC = 1 EUR — no FX conversion for European customers." },
        { icon: <Icon.Zap />, title: "Instant settlement", desc: "EURC on Base or Ethereum settles in seconds." },
        { icon: <Icon.Globe />, title: "Plus global stablecoins", desc: "Accept USDC, USDT, XSGD too — all from one QR." },
        { icon: <Icon.Lock />, title: "Non-custodial", desc: "EURC goes directly to your wallet — no intermediary." },
        { icon: <Icon.Receipt />, title: "On-chain receipts", desc: "Every EURC payment is publicly verifiable on-chain." },
      ]} />
      <H2>Frequently asked questions</H2>
      <FaqItem q="What is the difference between EURC and EURT?" a="EURC is issued by Circle (same issuer as USDC) and is fully reserved. EURT is issued by Tether. SeraPay supports both, so European customers can pay in whichever they hold." />
      <FaqItem q="Can I accept EUR and USD stablecoins at the same time?" a="Yes — SeraPay accepts EURC, EURT, USDC, USDT, and XSGD simultaneously from a single QR code. Customers choose their preferred currency." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function AcceptMultipleStablecoinsPage() {
  return (
    <SeoLayout>
      <H1>Accept Multiple Stablecoins at Once — One QR Code</H1>
      <Lead>SeraPay is the only lightweight payment gateway that accepts USDC, USDT, XSGD, EURC, and EURT simultaneously from a single QR code. No configuration per currency, no switching between payment pages, no lost sales from customers holding the "wrong" coin.</Lead>
      <Lead>Most crypto payment tools are single-currency. SeraPay was designed from the ground up to be multi-currency — because in the real world, your customers hold different stablecoins, and you should not have to turn any of them away.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Coins />, title: "6+ stablecoins", desc: "USDC, USDT, XSGD, EURC, EURT — all from one QR." },
        { icon: <Icon.Globe />, title: "Regional currencies", desc: "SGD, MYR, EUR, USD — cover all your customer bases." },
        { icon: <Icon.Zap />, title: "No extra setup", desc: "All currencies are enabled by default — nothing to configure." },
        { icon: <Icon.Lock />, title: "Direct to your wallet", desc: "Every currency lands directly in your wallet address." },
        { icon: <Icon.Layers />, title: "Multi-chain", desc: "Ethereum, Base, Polygon, Arbitrum, Optimism, BNB Chain." },
        { icon: <Icon.TrendUp />, title: "More conversions", desc: "Accepting more currencies means fewer abandoned payments." },
      ]} />
      <H2>Why single-currency gateways cost you sales</H2>
      <Lead>If you only accept USDC, a customer who holds USDT has to swap first — adding friction, fees, and time. Many will simply abandon the payment. SeraPay eliminates this entirely: customers pay in whatever stablecoin they already hold, and you receive it directly. No swaps, no friction, no lost sales.</Lead>
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Do I receive different currencies in different wallets?" a="No. All stablecoins arrive in the same wallet address. Your wallet holds all ERC-20 tokens natively." />
      <FaqItem q="Can I see which currency each payment was made in?" a="Yes. Your SeraPay transaction history shows the exact token and amount for every payment." />
      <CtaBanner />
    </SeoLayout>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// BY USE CASE PAGES
// ═══════════════════════════════════════════════════════════════════════════════

export function CryptoPaymentsForFreelancersPage() {
  return (
    <SeoLayout>
      <H1>Crypto Payments for Freelancers</H1>
      <Lead>SeraPay gives freelancers a professional, multi-currency payment page in under 60 seconds. Accept USDC, USDT, XSGD, EURC, and more from international clients — no bank account, no payment processor account, and no integration required.</Lead>
      <Lead>International freelancing is plagued by slow bank wires, high SWIFT fees, and currency conversion losses. Stablecoin payments solve all three: instant settlement, near-zero fees, and no conversion when you accept the same currency your client holds.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Globe />, title: "Accept from any country", desc: "Clients in Singapore, Europe, or the US can all pay you instantly." },
        { icon: <Icon.Coins />, title: "Multi-currency", desc: "USDC, USDT, XSGD, EURC — clients pay in their coin." },
        { icon: <Icon.Zap />, title: "Instant settlement", desc: "No waiting 3–5 days for a wire to clear." },
        { icon: <Icon.Link2 />, title: "Invoice links", desc: "Generate a payment link with a fixed amount for each invoice." },
        { icon: <Icon.NoCard />, title: "No fees to you", desc: "Gas fees are paid by the client. You receive the full amount." },
        { icon: <Icon.Receipt />, title: "On-chain proof", desc: "Every payment is publicly verifiable — perfect for records." },
      ]} />
      <H2>How freelancers use SeraPay</H2>
      <Lead>Add your SeraPay payment link to your invoice template. When a client is ready to pay, they click the link, connect their wallet, and send the exact amount. You receive it in seconds. For recurring clients, share your permanent QR code once and they can pay you any time.</Lead>
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Can I set a specific invoice amount?" a="Yes. SeraPay lets you generate payment links with a pre-filled amount. Share the link in your invoice and the client pays the exact amount with one click." />
      <FaqItem q="What if my client doesn't have crypto?" a="SeraPay is best suited for clients who already hold stablecoins. For clients who need to convert fiat first, any major exchange (Coinbase, Binance) can help them acquire USDC or USDT in minutes." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function CryptoPaymentsForRestaurantsPage() {
  return (
    <SeoLayout>
      <H1>Crypto Payments for Restaurants</H1>
      <Lead>SeraPay gives restaurants a printable, multi-currency QR code for table or counter payments. Customers scan and pay in USDC, USDT, XSGD, or any supported stablecoin — no card reader, no POS integration, and no transaction fees to the restaurant.</Lead>
      <Lead>For restaurants in tourist areas or crypto-friendly neighbourhoods, accepting stablecoin payments opens a new payment channel with zero chargeback risk and instant settlement — no waiting for card settlements or dealing with disputed charges.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.QrCode />, title: "Table QR codes", desc: "Print a QR code for each table or a single code for the counter." },
        { icon: <Icon.Coins />, title: "Multi-currency", desc: "Local and tourist customers pay in their preferred stablecoin." },
        { icon: <Icon.Zap />, title: "Instant confirmation", desc: "Payment confirmed on-chain in seconds — no waiting." },
        { icon: <Icon.Lock />, title: "No chargebacks", desc: "Stablecoin payments are irreversible — no disputed charges." },
        { icon: <Icon.NoCard />, title: "No card reader needed", desc: "Works on any smartphone — no hardware required." },
        { icon: <Icon.Store />, title: "Open or fixed amount", desc: "Set a bill amount or let customers enter their own." },
      ]} />
      <H2>Frequently asked questions</H2>
      <FaqItem q="How does a customer pay at a restaurant?" a="The customer scans the QR code with their phone, opens the SeraPay payment page, enters the bill amount (or it is pre-filled), connects their wallet, and confirms. The restaurant receives the payment in seconds." />
      <FaqItem q="Can I accept both local and international stablecoins?" a="Yes. SeraPay accepts XSGD (Singapore Dollar) (Malaysian Ringgit), USDC, USDT, EURC, and EURT simultaneously — covering both local and tourist customers." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function CryptoPaymentsForEcommercePage() {
  return (
    <SeoLayout>
      <H1>Crypto Payments for E-Commerce</H1>
      <Lead>SeraPay lets e-commerce sellers accept stablecoin payments without a plugin, API integration, or developer. Generate a payment link for each order, share it with the customer, and receive USDC, USDT, XSGD, or EURC directly in your wallet.</Lead>
      <Lead>For small e-commerce businesses, traditional payment processors charge 2–3% per transaction and hold funds for days. SeraPay's multi-currency stablecoin payments settle in seconds with near-zero fees — and no chargebacks, ever.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Link2 />, title: "Per-order payment links", desc: "Generate a unique payment link for each order with the exact amount." },
        { icon: <Icon.Coins />, title: "Multi-currency", desc: "Customers pay in USDC, USDT, XSGD, EURC — you choose." },
        { icon: <Icon.Globe />, title: "Sell globally", desc: "Accept payments from any country without FX fees or restrictions." },
        { icon: <Icon.Lock />, title: "No chargebacks", desc: "On-chain payments are irreversible — no fraud risk." },
        { icon: <Icon.Zap />, title: "Instant settlement", desc: "Funds arrive in your wallet in seconds, not days." },
        { icon: <Icon.NoCard />, title: "No processor fees", desc: "No 2–3% card processing fee — just near-zero gas." },
      ]} />
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Can I automate order confirmation?" a="SeraPay's basic tier is manual — you generate a link per order and confirm payment by checking your wallet. For automated order fulfilment with webhooks and APIs, Monetapay.to is the recommended upgrade." />
      <FaqItem q="Can I embed a payment button on my website?" a="Yes. Copy your SeraPay payment link and add it as a button or link on any website — no plugin required." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function CryptoPaymentsForNgosPage() {
  return (
    <SeoLayout>
      <H1>Crypto Donations for NGOs and Non-Profits</H1>
      <Lead>SeraPay gives NGOs and non-profit organisations a free, multi-currency crypto donation page in under 60 seconds. Accept USDC, USDT, XSGD, EURC, and more from donors worldwide — no payment processor account, no bank account required, and no platform fees.</Lead>
      <Lead>For international NGOs, stablecoin donations solve the cross-border payment problem: donors in Singapore can give in XSGD, donors in Europe in EURC, and donors anywhere in USDC — all to the same donation page, all arriving directly in the organisation's wallet.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Globe />, title: "Global donors", desc: "Accept donations from any country in any supported stablecoin." },
        { icon: <Icon.Coins />, title: "Multi-currency", desc: "USDC, USDT, XSGD, EURC — donors pay in their coin." },
        { icon: <Icon.Lock />, title: "Non-custodial", desc: "Donations go directly to your wallet — no intermediary." },
        { icon: <Icon.NoCard />, title: "No platform fees", desc: "SeraPay charges no fee — donors' full amount reaches you." },
        { icon: <Icon.Link2 />, title: "Shareable donation link", desc: "Share your donation link on social media, email, or your website." },
        { icon: <Icon.Receipt />, title: "On-chain transparency", desc: "Every donation is publicly verifiable — builds donor trust." },
      ]} />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Can donors give any amount?" a="Yes. SeraPay supports open-amount payments — donors enter the amount they wish to give." />
      <FaqItem q="Is there a record of all donations?" a="Yes. Your SeraPay transaction history shows every donation with amount, currency, and on-chain transaction ID. All donations are also publicly verifiable on the blockchain." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function CryptoPaymentsForEventsPage() {
  return (
    <SeoLayout>
      <H1>Crypto Payments for Events and Ticketing</H1>
      <Lead>SeraPay lets event organisers accept stablecoin ticket payments and on-site purchases with a simple QR code. USDC, USDT, XSGD, EURC — attendees pay in their preferred stablecoin, and you receive it instantly in your wallet.</Lead>
      <Lead>For events with international attendees, multi-currency stablecoin payments remove the friction of currency exchange and card processing fees. A single QR code at the door handles payments from attendees in Singapore, Malaysia, Europe, and beyond.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.QrCode />, title: "Event QR codes", desc: "Print QR codes for entry, merchandise, or food stalls." },
        { icon: <Icon.Coins />, title: "Multi-currency", desc: "USDC, USDT, XSGD, EURC — all from one QR." },
        { icon: <Icon.Zap />, title: "Instant confirmation", desc: "Payment confirmed in seconds — no queues at the door." },
        { icon: <Icon.Link2 />, title: "Pre-sale links", desc: "Generate payment links for pre-event ticket sales." },
        { icon: <Icon.Lock />, title: "No chargebacks", desc: "Stablecoin payments are irreversible — no disputed charges." },
        { icon: <Icon.Globe />, title: "International attendees", desc: "Accept payments from any country without FX friction." },
      ]} />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Can I set a fixed ticket price?" a="Yes. SeraPay lets you generate payment links with a pre-filled amount. Share the link for ticket purchases and attendees pay the exact price." />
      <FaqItem q="What if an attendee doesn't have crypto?" a="SeraPay is best for crypto-native attendees. For events with mixed audiences, consider offering both crypto and traditional payment options." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function CryptoInvoicePaymentsPage() {
  return (
    <SeoLayout>
      <H1>Crypto Invoice Payments</H1>
      <Lead>SeraPay lets you generate a crypto payment link for any invoice in seconds. Set the exact amount, share the link with your client, and receive USDC, USDT, XSGD, EURC, or any supported stablecoin directly in your wallet — no bank transfer, no SWIFT fee, no waiting.</Lead>
      <Lead>For businesses invoicing international clients, stablecoin invoice payments eliminate the two biggest pain points: slow settlement (bank wires take 3–5 days) and high fees (SWIFT charges $15–50 per transfer). SeraPay settles in seconds for under $0.01.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Receipt />, title: "Fixed-amount links", desc: "Generate a payment link with the exact invoice amount pre-filled." },
        { icon: <Icon.Coins />, title: "Multi-currency", desc: "Clients pay in USDC, USDT, XSGD, EURC — you choose." },
        { icon: <Icon.Zap />, title: "Instant settlement", desc: "No waiting 3–5 days for a wire to clear." },
        { icon: <Icon.Globe />, title: "International clients", desc: "Accept payments from any country without SWIFT fees." },
        { icon: <Icon.Lock />, title: "Irreversible", desc: "No chargebacks or reversed payments after settlement." },
        { icon: <Icon.Receipt />, title: "On-chain proof", desc: "Every payment is publicly verifiable — perfect for accounting." },
      ]} />
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Can I generate a unique link for each invoice?" a="Yes. SeraPay lets you create a payment link with a specific amount for each invoice. Share it in your invoice PDF or email." />
      <FaqItem q="What if my client wants to pay in a different stablecoin?" a="SeraPay accepts USDC, USDT, XSGD, EURC, and EURT simultaneously. Clients pay in whichever coin they hold — you receive it directly." />
      <CtaBanner />
    </SeoLayout>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// BY REGION PAGES
// ═══════════════════════════════════════════════════════════════════════════════

function RegionPage({ country, coin, coinFull, context, faq }: {
  country: string; coin: string; coinFull: string; context: string; faq: [string, string][];
}) {
  return (
    <SeoLayout>
      <H1>Crypto Payments in {country}</H1>
      <Lead>SeraPay gives {country} merchants and freelancers a free, multi-currency stablecoin payment page — accepting {coinFull} ({coin}), USDC, USDT, and more from a single QR code. No bank account, no integration, and no KYC required.</Lead>
      <Lead>{context}</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Coins />, title: `${coin} + global stablecoins`, desc: `Accept ${coin}, USDC, USDT, and more — all from one QR.` },
        { icon: <Icon.Zap />, title: "Instant settlement", desc: "Payments settle on-chain in seconds — no bank delays." },
        { icon: <Icon.Lock />, title: "Non-custodial", desc: "Funds go directly to your wallet — no intermediary." },
        { icon: <Icon.Globe />, title: "Accept international payments", desc: "Customers from any country can pay in their preferred stablecoin." },
        { icon: <Icon.QrCode />, title: "QR & link payments", desc: "Generate a QR code or shareable link in under 60 seconds." },
        { icon: <Icon.NoCard />, title: "No bank account needed", desc: "Start accepting crypto with just a wallet address." },
      ]} />
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      {faq.map(([q, a]) => <FaqItem key={q} q={q} a={a} />)}
      <CtaBanner />
    </SeoLayout>
  );
}

export function CryptoPaymentsSingaporePage() {
  return <RegionPage
    country="Singapore"
    coin="XSGD"
    coinFull="Singapore Dollar stablecoin"
    context="Singapore has one of the most crypto-friendly regulatory environments in Asia, with MAS actively licensing digital payment token service providers. XSGD — the SGD stablecoin issued by StraitsX — is growing rapidly among Singapore merchants and consumers who want the speed of crypto with the familiarity of SGD. SeraPay supports XSGD natively alongside USDC, USDT, and EURC."
    faq={[
      ["Is crypto payment legal in Singapore?", "Yes. Singapore has a clear regulatory framework for digital payment tokens under the Payment Services Act, administered by MAS. Accepting stablecoin payments is legal for businesses."],
      ["Can I accept both SGD stablecoins and USD stablecoins?", "Yes. SeraPay accepts XSGD, USDC, USDT, EURC, and EURT simultaneously from a single QR code."],
    ]}
  />;
}

export function CryptoPaymentsMalaysiaPage() {
  return <RegionPage
    country="Malaysia"
    coin="XSGD"
    coinFull="Malaysian Ringgit stablecoin"
    context="Malaysia's crypto adoption is growing rapidly, with Bank Negara Malaysia providing regulatory clarity for digital asset businesses. SeraPay supports USDC, USDT, XSGD, and EURC natively, enabling Malaysian merchants to accept international stablecoin payments with instant settlement and near-zero fees."
    faq={[
      ["Is accepting crypto payments legal in Malaysia?", "Yes. Bank Negara Malaysia has provided guidance on digital assets. Accepting stablecoin payments as a merchant is generally permissible, though you should consult a local advisor for your specific situation."],
      ["Can I accept both MYR stablecoins and USD stablecoins?", "Yes. SeraPay accepts USDC, USDT, XSGD, EURC, and EURT simultaneously from a single QR code."],
    ]}
  />;
}

export function CryptoPaymentsPhilippinesPage() {
  return <RegionPage
    country="Philippines"
    coin="USDC"
    coinFull="USD Coin"
    context="The Philippines is one of Southeast Asia's fastest-growing crypto markets, with a large overseas worker population that regularly receives international remittances. Stablecoin payments offer Filipino merchants and freelancers a fast, low-cost alternative to traditional remittance channels. SeraPay accepts USDC, USDT, and other stablecoins — ideal for OFW families and international freelancers."
    faq={[
      ["Can I use SeraPay to receive international payments in the Philippines?", "Yes. SeraPay accepts USDC, USDT, and other stablecoins from any country. Funds arrive in your wallet in seconds — far faster than traditional remittance channels."],
      ["What is the cheapest way to receive USDC in the Philippines?", "Receiving USDC on Polygon or Base via SeraPay costs under $0.01 in gas fees — significantly cheaper than bank wires or remittance services."],
    ]}
  />;
}

export function CryptoPaymentsIndonesiaPage() {
  return <RegionPage
    country="Indonesia"
    coin="USDC"
    coinFull="USD Coin"
    context="Indonesia has one of the largest crypto user bases in Southeast Asia, with millions of active traders and a growing merchant adoption of digital payments. Stablecoin payments offer Indonesian businesses a fast, low-cost alternative to traditional payment processors, particularly for cross-border transactions. SeraPay accepts USDC, USDT, and other stablecoins with no integration required."
    faq={[
      ["Is crypto payment legal in Indonesia?", "Indonesia's regulatory framework for crypto is evolving. Crypto assets are regulated by OJK and Bappebti. Consult a local advisor for your specific business situation."],
      ["Can I accept payments from international customers?", "Yes. SeraPay accepts USDC, USDT, XSGD, EURC, and EURT from any country — ideal for Indonesian businesses with international customers."],
    ]}
  />;
}

export function CryptoPaymentsThailandPage() {
  return <RegionPage
    country="Thailand"
    coin="USDC"
    coinFull="USD Coin"
    context="Thailand's tourism industry and growing digital economy make it an ideal market for stablecoin payments. International tourists can pay in USDC or USDT without currency exchange friction, while local merchants receive instant settlement with no chargeback risk. SeraPay's multi-currency QR code is particularly well-suited for Thailand's hospitality and retail sectors."
    faq={[
      ["Can tourists pay with crypto in Thailand?", "Yes. SeraPay's QR code works for any customer with a crypto wallet. Tourists can pay in USDC, USDT, or other stablecoins directly from their mobile wallet."],
      ["What is the best stablecoin for Thai merchants?", "USDC and USDT are the most widely held stablecoins globally and are recommended for Thai merchants serving international customers. SeraPay accepts both simultaneously."],
    ]}
  />;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BY FEATURE PAGES
// ═══════════════════════════════════════════════════════════════════════════════

export function InstantCryptoSettlementPage() {
  return (
    <SeoLayout>
      <H1>Instant Crypto Settlement for Merchants</H1>
      <Lead>SeraPay settles payments in seconds, not days. When a customer pays in USDC, USDT, XSGD, or EURC, the funds arrive in your wallet on-chain — no waiting for a payment processor to batch and release funds, no payout schedules, no holds.</Lead>
      <Lead>Traditional payment processors settle in 1–3 business days. Some hold funds for weeks for new merchants. SeraPay has no settlement delay because it is non-custodial: the blockchain is the settlement layer, and it settles in seconds.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Zap />, title: "Seconds, not days", desc: "Funds arrive in your wallet in under 10 seconds on most networks." },
        { icon: <Icon.Lock />, title: "No holds", desc: "SeraPay never holds your funds — no payout schedules." },
        { icon: <Icon.Layers />, title: "Layer 2 speed", desc: "Base, Polygon, and Arbitrum settle in 1–3 seconds." },
        { icon: <Icon.Coins />, title: "Multi-currency", desc: "All stablecoins settle at the same speed — USDC, USDT, XSGD, EURC." },
        { icon: <Icon.Globe />, title: "24/7 settlement", desc: "Blockchain never closes — settle on weekends and holidays." },
        { icon: <Icon.Receipt />, title: "Instant confirmation", desc: "On-chain confirmation is immediate and publicly verifiable." },
      ]} />
      <H2>Why instant settlement matters</H2>
      <Lead>Cash flow is critical for small businesses. Waiting 3 days for card settlements means you cannot use that money to pay suppliers, restock inventory, or cover operating costs. SeraPay's instant settlement means your revenue is available immediately — every time, 24/7, including weekends and public holidays.</Lead>
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="How fast is settlement on different networks?" a="Base and Polygon typically settle in 1–3 seconds. Arbitrum and Optimism settle in 1–5 seconds. Ethereum mainnet settles in 12–30 seconds but has higher gas fees." />
      <FaqItem q="Are there any holds or delays?" a="No. SeraPay is non-custodial — funds go directly from the customer's wallet to yours. There are no holds, no payout schedules, and no minimum withdrawal amounts." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function NoKycCryptoPaymentsPage() {
  return (
    <SeoLayout>
      <H1>Accept Crypto Payments Without KYC</H1>
      <Lead>SeraPay requires no KYC (Know Your Customer) verification to start accepting stablecoin payments. Log in with your wallet or email, set your business name, and your multi-currency payment page is live — accepting USDC, USDT, XSGD, EURC, and more in under 60 seconds.</Lead>
      <Lead>Traditional payment processors require extensive KYC: government ID, proof of address, business registration, and sometimes weeks of review. SeraPay is permissionless — anyone with a wallet address can start accepting payments immediately.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.NoCard />, title: "No KYC required", desc: "Start accepting payments with just a wallet address." },
        { icon: <Icon.Clock />, title: "60-second setup", desc: "No review process — your payment page is live immediately." },
        { icon: <Icon.Globe />, title: "Available worldwide", desc: "No geographic restrictions — available in any country." },
        { icon: <Icon.Coins />, title: "Multi-currency", desc: "USDC, USDT, XSGD, EURC — all from one QR." },
        { icon: <Icon.Lock />, title: "Non-custodial", desc: "Your wallet, your funds — no account to freeze." },
        { icon: <Icon.Shield />, title: "Permissionless", desc: "No approval required from any financial institution." },
      ]} />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Why does SeraPay not require KYC?" a="SeraPay is non-custodial — it never holds your funds. Because SeraPay is not a custodian or money transmitter, it does not need to perform KYC on merchants. Payments go directly between wallets on the blockchain." />
      <FaqItem q="Are there any limits without KYC?" a="SeraPay imposes no transaction limits. The only limits are those of the underlying blockchain network, which are typically very high for stablecoin transfers." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function CryptoPaymentLinkPage() {
  return (
    <SeoLayout>
      <H1>Crypto Payment Link Generator</H1>
      <Lead>SeraPay generates shareable crypto payment links in seconds. Set an amount, choose your accepted stablecoins, and share the link via WhatsApp, email, SMS, or social media. Customers click, connect their wallet, and pay in USDC, USDT, XSGD, EURC, or any supported stablecoin.</Lead>
      <Lead>Unlike single-currency payment links, SeraPay's links open a multi-currency payment page. Customers choose their preferred stablecoin — you receive it directly in your wallet regardless of which coin they pick.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.Link2 />, title: "Shareable anywhere", desc: "Share via WhatsApp, email, SMS, social media, or invoice." },
        { icon: <Icon.Coins />, title: "Multi-currency", desc: "One link accepts USDC, USDT, XSGD, EURC, and more." },
        { icon: <Icon.Receipt />, title: "Fixed or open amount", desc: "Pre-fill the amount or let customers enter their own." },
        { icon: <Icon.Zap />, title: "Instant settlement", desc: "Funds arrive in your wallet in seconds after payment." },
        { icon: <Icon.Lock />, title: "Non-custodial", desc: "Payments go directly to your wallet — no intermediary." },
        { icon: <Icon.Repeat />, title: "Reusable or one-time", desc: "Use your permanent link or generate single-use links per order." },
      ]} />
      <MonetaCallout />
      <H2>Frequently asked questions</H2>
      <FaqItem q="Can I create a payment link with a specific amount?" a="Yes. SeraPay lets you generate payment links with a pre-filled amount. Share the link in your invoice or message and the customer pays the exact amount." />
      <FaqItem q="Can I track which payment links have been paid?" a="Yes. Your SeraPay transaction history shows every payment with the amount, currency, and on-chain transaction ID." />
      <CtaBanner />
    </SeoLayout>
  );
}

export function StablecoinQrCodeGeneratorPage() {
  return (
    <SeoLayout>
      <H1>Stablecoin QR Code Generator for Merchants</H1>
      <Lead>SeraPay generates a branded, multi-currency stablecoin QR code for your business in under 60 seconds. Customers scan it with any mobile wallet to pay in USDC, USDT, XSGD, EURC, or other stablecoins — one QR code, all currencies, no configuration.</Lead>
      <Lead>Most QR code generators produce a static address QR that only works for one specific token on one specific network. SeraPay's QR links to a smart payment page that handles currency selection, network detection, and wallet connection automatically.</Lead>
      <FeatureGrid features={[
        { icon: <Icon.QrCode />, title: "Multi-currency QR", desc: "One QR accepts USDC, USDT, XSGD, EURC, and more." },
        { icon: <Icon.Store />, title: "Custom branding", desc: "Add your logo to the QR code centre. Customise dot style and colour." },
        { icon: <Icon.Phone />, title: "Any wallet app", desc: "Works with MetaMask, Coinbase Wallet, Trust Wallet, and 300+ others." },
        { icon: <Icon.Zap />, title: "Smart payment page", desc: "QR links to a hosted page — no raw address exposure." },
        { icon: <Icon.Receipt />, title: "Printable", desc: "Download as PNG for printing at your counter or stall." },
        { icon: <Icon.Repeat />, title: "Permanent", desc: "Your QR code never expires — use it indefinitely." },
      ]} />
      <H2>Frequently asked questions</H2>
      <FaqItem q="What is the difference between a static address QR and SeraPay's QR?" a="A static address QR encodes your raw wallet address — customers must manually select the token and network, which causes errors. SeraPay's QR links to a smart payment page that guides customers through the payment automatically." />
      <FaqItem q="Can I customise the QR code design?" a="Yes. SeraPay lets you upload your business logo (embedded in the QR centre) and customise the dot style and colours to match your brand." />
      <CtaBanner />
    </SeoLayout>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPARISON PAGES
// ═══════════════════════════════════════════════════════════════════════════════

export function SeraPayVsStripePage() {
  return (
    <SeoLayout>
      <H1>SeraPay vs Stripe for Crypto Payments</H1>
      <Lead>Stripe is the world's leading card payment processor, but it is designed for fiat payments. SeraPay is designed specifically for stablecoin payments — and it does things Stripe simply cannot: non-custodial settlement, multi-currency stablecoins, no KYC, and zero platform fees.</Lead>
      <Lead>Stripe Crypto (now discontinued for most markets) required significant integration work and still routed payments through Stripe's custodial infrastructure. SeraPay is non-custodial by design — payments go directly from customer wallet to merchant wallet, with no intermediary.</Lead>
      <CompareTable rows={[
        ["Setup time", "60 seconds", "Hours to days (API integration)"],
        ["Transaction fee", "< $0.01 (gas only)", "2.9% + $0.30 per transaction"],
        ["Settlement time", "Seconds", "2 business days"],
        ["Chargebacks", "None", "Yes — significant fraud risk"],
        ["KYC required", "No", "Yes (extensive)"],
        ["Custody of funds", "Non-custodial", "Custodial"],
        ["Currencies accepted", "USDC, USDT, XSGD, EURC, EURT", "USD, EUR, GBP (fiat only)"],
        ["Integration required", "No", "Yes (developer required)"],
        ["Geographic availability", "Global", "Restricted in many countries"],
      ]} />
      <H2>When to use Stripe vs SeraPay</H2>
      <Lead>Use Stripe if your customers pay with credit cards and you need automated order fulfilment, subscription billing, and deep e-commerce integrations. Use SeraPay if you want to accept stablecoins with zero setup, zero platform fees, instant settlement, and no chargebacks — or if you operate in a country where Stripe is unavailable.</Lead>
      <MonetaCallout />
      <CtaBanner />
    </SeoLayout>
  );
}

export function SeraPayVsCoinbaseCommercePage() {
  return (
    <SeoLayout>
      <H1>SeraPay vs Coinbase Commerce</H1>
      <Lead>Coinbase Commerce is a well-known crypto payment tool, but it is custodial, single-chain, and requires integration. SeraPay is non-custodial, multi-currency, multi-chain, and requires zero integration — making it faster to set up and more flexible for merchants.</Lead>
      <CompareTable rows={[
        ["Setup time", "60 seconds", "30–60 minutes (integration)"],
        ["Custody of funds", "Non-custodial (direct to wallet)", "Custodial (Coinbase holds funds)"],
        ["Currencies accepted", "USDC, USDT, XSGD, EURC, EURT", "USDC, ETH, BTC (limited)"],
        ["Regional stablecoins", "Yes (XSGD)", "No"],
        ["Multi-chain", "Yes (6 EVM chains)", "Limited"],
        ["Integration required", "No", "Yes (plugin/API)"],
        ["KYC required", "No", "Yes (Coinbase account)"],
        ["Platform fee", "None", "1% on some transactions"],
      ]} />
      <H2>Key differences</H2>
      <Lead>The most important difference is custody. Coinbase Commerce holds your funds until you withdraw them to your wallet — creating counterparty risk and withdrawal delays. SeraPay sends funds directly to your wallet on every payment, with no intermediary and no withdrawal process.</Lead>
      <Lead>SeraPay also supports regional stablecoins like XSGD that Coinbase Commerce does not, making it a better fit for Southeast Asian merchants.</Lead>
      <MonetaCallout />
      <CtaBanner />
    </SeoLayout>
  );
}

export function SeraPayVsBitPayPage() {
  return (
    <SeoLayout>
      <H1>SeraPay vs BitPay</H1>
      <Lead>BitPay is one of the oldest crypto payment processors, but it was built for Bitcoin — not stablecoins. SeraPay is built specifically for stablecoin payments, offering multi-currency support, non-custodial settlement, and zero-integration setup that BitPay cannot match.</Lead>
      <CompareTable rows={[
        ["Primary focus", "Stablecoins (USDC, USDT, XSGD, EURC)", "Bitcoin, Bitcoin Cash"],
        ["Volatility risk", "None (stablecoins are pegged)", "High (BTC price fluctuates)"],
        ["Setup time", "60 seconds", "Days (KYC + integration)"],
        ["Integration required", "No", "Yes (plugin/API)"],
        ["KYC required", "No", "Yes (extensive business KYC)"],
        ["Custody of funds", "Non-custodial", "Custodial"],
        ["Platform fee", "None", "1% per transaction"],
        ["Regional stablecoins", "Yes (XSGD)", "No"],
      ]} />
      <H2>Why stablecoins beat Bitcoin for merchant payments</H2>
      <Lead>Bitcoin's price volatility makes it impractical for everyday merchant payments: a customer might pay 0.001 BTC for a $60 meal, but by the time the merchant converts it to fiat, the value could have changed significantly. Stablecoins eliminate this entirely — 60 USDC is always $60.</Lead>
      <MonetaCallout />
      <CtaBanner />
    </SeoLayout>
  );
}

export function SeraPayVsNowPaymentsPage() {
  return (
    <SeoLayout>
      <H1>SeraPay vs NOWPayments</H1>
      <Lead>NOWPayments supports hundreds of cryptocurrencies, but this breadth comes at a cost: custodial infrastructure, integration requirements, and fees. SeraPay focuses on stablecoins — the currencies that actually make sense for merchant payments — with non-custodial settlement, zero integration, and no platform fees.</Lead>
      <CompareTable rows={[
        ["Focus", "Stablecoins (stable value)", "100+ cryptocurrencies (volatile)"],
        ["Setup time", "60 seconds", "Hours (API integration)"],
        ["Integration required", "No", "Yes (API/plugin)"],
        ["Custody of funds", "Non-custodial", "Custodial"],
        ["Platform fee", "None", "0.5–1% per transaction"],
        ["KYC required", "No", "Yes"],
        ["Multi-currency stablecoins", "USDC, USDT, XSGD, EURC, EURT", "USDC, USDT (limited stablecoin focus)"],
        ["Regional stablecoins", "Yes (XSGD)", "No"],
      ]} />
      <H2>Why fewer, better currencies beats hundreds of volatile coins</H2>
      <Lead>NOWPayments' breadth is appealing, but most of those 100+ cryptocurrencies are volatile assets that fluctuate in value. For merchant payments, stablecoins are the only practical choice. SeraPay focuses on the stablecoins that matter — including regional ones like XSGD that most competitors ignore.</Lead>
      <MonetaCallout />
      <CtaBanner />
    </SeoLayout>
  );
}
