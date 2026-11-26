import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Ban,
  CircleCheck,
  Clock,
  KeyRound,
  Link2,
  MapPin,
  MonitorSmartphone,
  PenLine,
  Server,
  ShieldCheck,
  Timer,
  Wallet,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useInViewOnce, usePrefersReducedMotion } from "../hooks";
import { card, colors, font, mono } from "../theme";
import { Grid, IconBubble } from "./ui";

const { green, text, muted, tint, amber, white } = colors;

const ARCH_NODES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Wallet,
    title: "Customer's wallet",
    text: "Holds the coins. Signs two messages. Needs no ETH.",
  },
  {
    icon: MonitorSmartphone,
    title: "Your app",
    text: "Shows the price, asks the wallet to sign, sends it to Sera.",
  },
  {
    icon: Server,
    title: "Sera",
    text: "Prices the swap on its orderbook and matches it.",
  },
  {
    icon: Link2,
    title: "Ethereum",
    text: "Sera settles on-chain. Coins land in the wallet.",
  },
];
const ARCH_LINKS = ["signs", "price · send · status", "settles"];

export function ArchitectureDiagram() {
  const parts: ReactNode[] = [];
  ARCH_NODES.forEach((node, i) => {
    parts.push(
      <div key={node.title} className="g-node">
        <span className="g-node-icon">
          <IconBubble icon={node.icon} size={44} />
        </span>
        <div style={{ minWidth: 0 }}>
          <p
            style={{
              margin: "0 0 4px",
              fontSize: 14.5,
              fontWeight: 800,
              color: text,
            }}
          >
            {node.title}
          </p>
          <p
            style={{ margin: 0, fontSize: 12.5, color: muted, lineHeight: 1.5 }}
          >
            {node.text}
          </p>
        </div>
      </div>,
    );
    if (i < ARCH_LINKS.length) {
      parts.push(
        <div key={`link-${i}`} className="g-link" aria-hidden>
          <div className="g-link-line" />
          <div className="g-link-dot" />
          <span className="g-link-label">{ARCH_LINKS[i]}</span>
        </div>,
      );
    }
  });
  return (
    <figure
      style={{ margin: "6px 0 18px" }}
      aria-label="The customer's wallet signs, your app talks to Sera, and Sera settles on Ethereum"
    >
      <div className="g-arch">{parts}</div>
    </figure>
  );
}

const LANES = [
  { name: "Wallet", x: 52 },
  { name: "Your app", x: 180 },
  { name: "Sera", x: 308 },
];

const MESSAGES: {
  from: number;
  to: number;
  label: string;
  sub: string;
  step?: string;
}[] = [
  { from: 1, to: 2, label: "Get price", sub: "POST /swap/quote", step: "1" },
  { from: 2, to: 1, label: "Price + quote id", sub: "good for ~30 s" },
  {
    from: 1,
    to: 0,
    label: "Please sign",
    sub: "permission + swap",
    step: "2·3",
  },
  { from: 0, to: 1, label: "Signatures", sub: "free, no gas" },
  { from: 1, to: 2, label: "Send swap", sub: "POST /swap", step: "4" },
  { from: 2, to: 1, label: "trade_id", sub: "save it first" },
  {
    from: 1,
    to: 2,
    label: "How is it going?",
    sub: "GET /orders and /fills",
    step: "5",
  },
  { from: 2, to: 1, label: "Settled ✓", sub: "show the result" },
];

export function SequenceDiagram() {
  const headerHeight = 32;
  const firstRow = 92;
  const rowGap = 46;
  const height = firstRow + rowGap * (MESSAGES.length - 1) + 26;

  const ref = useRef<HTMLElement>(null);
  const play = useInViewOnce(ref);

  return (
    <figure
      ref={ref}
      className={play ? "g-seq-play" : undefined}
      style={{
        ...card,
        borderRadius: 16,
        margin: "8px 0 18px",
        padding: "16px 10px 6px",
      }}
    >
      <svg
        viewBox={`0 0 360 ${height}`}
        role="img"
        aria-label="Order of calls: get price, sign, send, track"
        style={{
          display: "block",
          width: "100%",
          maxWidth: 540,
          margin: "0 auto",
          fontFamily: font,
        }}
      >
        <defs>
          <marker
            id="g-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerUnits="userSpaceOnUse"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill={green} />
          </marker>
        </defs>
        {LANES.map((lane, i) => (
          <g key={lane.name}>
            <line
              x1={lane.x}
              y1={10 + headerHeight}
              x2={lane.x}
              y2={height - 4}
              stroke="rgba(10,31,26,0.15)"
              strokeDasharray="3 4"
            />
            <rect
              x={lane.x - 46}
              y={10}
              width={92}
              height={headerHeight}
              rx={10}
              fill={i === 1 ? green : tint}
            />
            <text
              x={lane.x}
              y={31}
              textAnchor="middle"
              fontSize={12.5}
              fontWeight={800}
              fill={i === 1 ? white : text}
            >
              {lane.name}
            </text>
          </g>
        ))}
        {MESSAGES.map((m, i) => {
          const y = firstRow + i * rowGap;
          const x1 = LANES[m.from].x;
          const x2 = LANES[m.to].x;
          const dir = x2 > x1 ? 1 : -1;
          const mid = (x1 + x2) / 2;
          return (
            <g
              key={m.label}
              className="g-seqm"
              style={{ "--i": i } as CSSProperties}
            >
              <text
                x={mid}
                y={y - 19}
                textAnchor="middle"
                fontSize={11.5}
                fontWeight={700}
                fill={text}
              >
                {m.label}
              </text>
              <text
                x={mid}
                y={y - 7}
                textAnchor="middle"
                fontSize={9.5}
                fill={muted}
                fontFamily={mono}
              >
                {m.sub}
              </text>
              <line
                x1={x1 + dir * (m.step ? 12 : 3)}
                y1={y}
                x2={x2 - dir * 3}
                y2={y}
                stroke={green}
                strokeWidth={1.6}
                strokeDasharray={m.step ? undefined : "5 4"}
                markerEnd="url(#g-arrow)"
              />
              {m.step && (
                <g>
                  <circle
                    cx={x1}
                    cy={y}
                    r={10}
                    fill={green}
                    stroke={white}
                    strokeWidth={2}
                  />
                  <text
                    x={x1}
                    y={y + 3.5}
                    textAnchor="middle"
                    fontSize={m.step.length > 1 ? 7.5 : 10}
                    fontWeight={800}
                    fill={white}
                  >
                    {m.step}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption
        style={{
          textAlign: "center",
          fontSize: 12,
          color: muted,
          margin: "4px 0 6px",
        }}
      >
        Numbers are the 5 steps. Solid line: you ask. Dashed line: you get an
        answer.
      </figcaption>
    </figure>
  );
}

const QUOTE_LIFETIME_SECONDS = 30;
const FRESH_SECONDS = 25;
const FRESH_SHARE = `${(FRESH_SECONDS / QUOTE_LIFETIME_SECONDS) * 100}%`;

export function FreshnessBar() {
  const swatch = (color: string) => (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: 3,
        background: color,
        marginRight: 6,
        verticalAlign: -1,
      }}
    />
  );
  return (
    <div style={{ ...card, padding: "14px 16px", margin: "10px 0 16px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
          fontSize: 13.5,
          fontWeight: 700,
          color: text,
        }}
      >
        <Timer size={16} color={green} /> A price lives about{" "}
        {QUOTE_LIFETIME_SECONDS} seconds
      </div>
      <div
        style={{
          position: "relative",
          height: 12,
          borderRadius: 6,
          background: `linear-gradient(90deg, #BDEFD3 0 ${FRESH_SHARE}, #FFDDA6 ${FRESH_SHARE} 100%)`,
        }}
      >
        <span
          className="g-sweep"
          style={{
            position: "absolute",
            top: -4,
            width: 4,
            height: 20,
            borderRadius: 2,
            background: text,
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "6px 16px",
          marginTop: 10,
          fontSize: 12.5,
          color: muted,
        }}
      >
        <span>
          {swatch("#BDEFD3")}0 to {FRESH_SECONDS} s: OK to sign
        </span>
        <span>
          {swatch("#FFDDA6")}After {FRESH_SECONDS} s: get a new price first
        </span>
      </div>
    </div>
  );
}

const STATUS_STAGES = [
  { label: "Submitted", api: "pending" },
  { label: "Matched", api: "matched" },
  { label: "Confirming", api: "confirming fill" },
  { label: "Settled", api: "settled" },
];

export function StatusTimeline() {
  const reduced = usePrefersReducedMotion();
  const last = STATUS_STAGES.length - 1;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (reduced) return;
    // One extra tick holds "Settled" on screen before the loop restarts.
    const timer = window.setInterval(
      () => setTick((t) => (t + 1) % (STATUS_STAGES.length + 1)),
      1300,
    );
    return () => window.clearInterval(timer);
  }, [reduced]);

  const shown = reduced ? last : Math.min(tick, last);
  const fill = (shown / last) * 100;
  const rail: CSSProperties = {
    position: "absolute",
    top: 11,
    left: 0,
    height: 4,
    borderRadius: 2,
  };

  return (
    <div
      style={{
        ...card,
        borderRadius: 16,
        padding: "20px 16px 14px",
        margin: "10px 0 16px",
      }}
    >
      <div style={{ position: "relative", margin: "0 8%" }}>
        <div style={{ ...rail, right: 0, background: colors.track }} />
        <div
          style={{
            ...rail,
            width: `${fill}%`,
            background: green,
            transition: "width .6s ease",
          }}
        />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${STATUS_STAGES.length}, 1fr)`,
          position: "relative",
        }}
      >
        {STATUS_STAGES.map((stage, i) => {
          const done = i <= shown;
          return (
            <div key={stage.label} style={{ textAlign: "center" }}>
              <span
                className={i === shown && i < last ? "g-pulse" : undefined}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  background: done ? green : white,
                  border: `3px solid ${done ? green : "rgba(10,31,26,0.15)"}`,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: white,
                  fontSize: 12,
                  fontWeight: 800,
                  transition: "background .4s, border-color .4s",
                  position: "relative",
                }}
              >
                {done && i === last ? "✓" : ""}
              </span>
              <p
                style={{
                  margin: "8px 0 2px",
                  fontSize: 13,
                  fontWeight: done ? 800 : 600,
                  color: done ? text : muted,
                }}
              >
                {stage.label}
              </p>
              <p
                style={{
                  margin: 0,
                  fontSize: 10.5,
                  color: muted,
                  fontFamily: mono,
                }}
              >
                {stage.api}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const PERMISSION_PATHS: {
  icon: LucideIcon;
  title: string;
  when: string;
  what: string;
  warn?: boolean;
}[] = [
  {
    icon: CircleCheck,
    title: "Nothing to do",
    when: "Vault equity covers the swap and the quote needs no deposit",
    what: "Skip to step 3.",
  },
  {
    icon: PenLine,
    title: "Free signature",
    when: "The quote requests a supported permit",
    what: "Customer signs one message. No gas.",
  },
  {
    icon: KeyRound,
    title: "Token approval",
    when: "The quote requires a deposit and the token has no permit support",
    what: "Check the quote’s allowance. If it is short, use /approve and /tx/send, then refresh the quote. This costs ETH.",
    warn: true,
  },
];

export function PermissionPaths() {
  return (
    <Grid min={200} style={{ margin: "6px 0 16px" }}>
      {PERMISSION_PATHS.map((p) => {
        const tone = p.warn ? amber : green;
        return (
          <div
            key={p.title}
            style={{
              ...card,
              borderTop: `4px solid ${tone}`,
              padding: "14px 16px",
            }}
          >
            <IconBubble
              icon={p.icon}
              size={36}
              color={tone}
              bgColor={p.warn ? colors.amberTint : tint}
            />
            <p
              style={{
                margin: "10px 0 4px",
                fontSize: 15,
                fontWeight: 800,
                color: text,
              }}
            >
              {p.title}
            </p>
            <p style={{ margin: "0 0 6px", fontSize: 12.5, color: muted }}>
              When: {p.when}
            </p>
            <p
              style={{
                margin: 0,
                fontSize: 13.5,
                color: text,
                lineHeight: 1.5,
              }}
            >
              {p.what}
            </p>
          </div>
        );
      })}
    </Grid>
  );
}

const RULES: {
  icon: LucideIcon;
  title: string;
  text: string;
  danger?: boolean;
}[] = [
  {
    icon: WifiOff,
    title: "Never send a swap twice",
    text: "If you sent it and no answer came back, look it up. Do not send it again.",
    danger: true,
  },
  {
    icon: Clock,
    title: "Only sign a fresh price",
    text: "Older than 25 seconds? Get a new price before the wallet opens.",
  },
  {
    icon: Ban,
    title: "Never sign a zero",
    text: "If the customer would receive 0, stop and ask them to raise the amount.",
    danger: true,
  },
  {
    icon: PenLine,
    title: "Sign exactly what Sera sent",
    text: "Do not round, reorder or change any field of the quote.",
  },
  {
    icon: ShieldCheck,
    title: "Ask before a worse price",
    text: 'If the price got worse, show "Rate changed" and let the customer decide.',
  },
  {
    icon: MapPin,
    title: "Read addresses live",
    text: "Coin and contract addresses come from Sera's API, never typed into your code.",
  },
];

export function RuleCards() {
  return (
    <Grid min={240}>
      {RULES.map((rule, i) => (
        <div
          key={rule.title}
          style={{
            ...card,
            borderRadius: 16,
            padding: "16px 16px 14px",
            position: "relative",
          }}
        >
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 14,
              right: 16,
              fontSize: 28,
              fontWeight: 900,
              color: "rgba(10,31,26,0.06)",
            }}
          >
            {i + 1}
          </span>
          <IconBubble
            icon={rule.icon}
            size={40}
            color={rule.danger ? colors.red : green}
            bgColor={rule.danger ? colors.redTint : tint}
          />
          <p
            style={{
              margin: "12px 0 6px",
              fontSize: 16,
              fontWeight: 800,
              color: text,
            }}
          >
            {rule.title}
          </p>
          <p
            style={{ margin: 0, fontSize: 14, color: muted, lineHeight: 1.55 }}
          >
            {rule.text}
          </p>
        </div>
      ))}
    </Grid>
  );
}

export function LaunchPath({
  phases,
}: {
  phases: {
    env: "testnet" | "switch" | "production";
    icon: LucideIcon;
    title: string;
    text: ReactNode;
  }[];
}) {
  const badge = {
    testnet: {
      label: "Testnet",
      bg: colors.amberTint,
      fg: "#8A5A00",
      ring: amber,
    },
    switch: {
      label: "Switch",
      bg: colors.blueTint,
      fg: colors.blue,
      ring: colors.blue,
    },
    production: { label: "Production", bg: tint, fg: "#00873A", ring: green },
  } as const;

  return (
    <div style={{ position: "relative", margin: "8px 0 18px" }}>
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 21,
          top: 22,
          bottom: 22,
          width: 3,
          overflow: "hidden",
        }}
      >
        <div className="g-link-line g-vertical" />
      </div>
      <span aria-hidden className="g-rail-dot" />
      {phases.map((phase, i) => {
        const b = badge[phase.env];
        const filled = phase.env === "production";
        const Icon = phase.icon;
        return (
          <div
            key={phase.title}
            style={{
              display: "flex",
              gap: 14,
              alignItems: "flex-start",
              marginBottom: i === phases.length - 1 ? 0 : 12,
              position: "relative",
            }}
          >
            <span
              style={{
                width: 45,
                height: 45,
                borderRadius: "50%",
                background: filled ? green : white,
                border: `3px solid ${b.ring}`,
                color: filled ? white : text,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                fontWeight: 900,
                fontSize: 16,
                position: "relative",
                zIndex: 1,
              }}
            >
              {i + 1}
            </span>
            <div
              style={{ ...card, flex: 1, minWidth: 0, padding: "12px 14px" }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                  marginBottom: 4,
                }}
              >
                <Icon size={17} color={green} />
                <span style={{ fontSize: 15.5, fontWeight: 800, color: text }}>
                  {phase.title}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 800,
                    letterSpacing: "0.4px",
                    textTransform: "uppercase",
                    background: b.bg,
                    color: b.fg,
                    borderRadius: 999,
                    padding: "2px 9px",
                  }}
                >
                  {b.label}
                </span>
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 14,
                  color: muted,
                  lineHeight: 1.55,
                }}
              >
                {phase.text}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
