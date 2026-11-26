import type { CSSProperties, MouseEvent, ReactNode } from "react";
import {
  CircleCheck,
  ClipboardCopy,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useCopyToClipboard } from "../hooks";
import { STEP_COUNT } from "../sections";
import { card, colors, font, kicker, mono, pillButton } from "../theme";

const { green, text, muted, tint, border, white } = colors;

export function P({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        fontSize: 15,
        color: muted,
        lineHeight: 1.7,
        margin: "0 0 14px",
      }}
    >
      {children}
    </p>
  );
}

export function B({ children }: { children: ReactNode }) {
  return <strong style={{ color: text, fontWeight: 700 }}>{children}</strong>;
}

export function C({
  children,
  nowrap = false,
}: {
  children: ReactNode;
  nowrap?: boolean;
}) {
  return (
    <code
      style={{
        fontFamily: mono,
        fontSize: "0.88em",
        background: tint,
        color: text,
        padding: "1px 5px",
        borderRadius: 4,
        overflowWrap: "anywhere",
        whiteSpace: nowrap ? "nowrap" : undefined,
      }}
    >
      {children}
    </code>
  );
}

export function H3({ children }: { children: ReactNode }) {
  return (
    <h3
      style={{
        fontSize: 15,
        fontWeight: 800,
        color: text,
        margin: "22px 0 10px",
      }}
    >
      {children}
    </h3>
  );
}

export function InlineLink({
  href,
  onClick,
  children,
}: {
  href: string;
  onClick?: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <a href={href} onClick={onClick} style={{ color: green, fontWeight: 600 }}>
      {children}
    </a>
  );
}

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ ...card, padding: "14px 16px", ...style }}>{children}</div>
  );
}

export function Grid({
  min,
  gap = 12,
  children,
  style,
}: {
  min: number;
  gap?: number;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
        gap,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Pill({
  icon: Icon = CircleCheck,
  children,
}: {
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: white,
        border: `1px solid ${border}`,
        borderRadius: 999,
        padding: "6px 12px",
        fontSize: 13,
        fontWeight: 600,
        color: text,
      }}
    >
      <Icon size={14} color={green} /> {children}
    </span>
  );
}

export function IconBubble({
  icon: Icon,
  size = 40,
  color = green,
  bgColor = tint,
}: {
  icon: LucideIcon;
  size?: number;
  color?: string;
  bgColor?: string;
}) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 12,
        background: bgColor,
        color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Icon size={Math.round(size * 0.5)} strokeWidth={2.2} />
    </span>
  );
}

export function IconCard({
  icon,
  title,
  children,
  iconSize = 36,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  iconSize?: number;
}) {
  return (
    <Card>
      <IconBubble icon={icon} size={iconSize} />
      <p
        style={{
          margin: "10px 0 4px",
          fontSize: 15,
          fontWeight: 800,
          color: text,
        }}
      >
        {title}
      </p>
      <div style={{ fontSize: 13.5, color: muted, lineHeight: 1.55 }}>
        {children}
      </div>
    </Card>
  );
}

const sectionStyle: CSSProperties = { scrollMarginTop: 80, marginTop: 64 };
const h2Style: CSSProperties = {
  fontSize: 26,
  fontWeight: 900,
  color: text,
  letterSpacing: "-0.5px",
};

export function Section({
  id,
  title,
  eyebrow,
  children,
}: {
  id: string;
  title: string;
  eyebrow?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="g-reveal" style={sectionStyle}>
      {eyebrow && <p style={{ ...kicker, margin: "0 0 6px" }}>{eyebrow}</p>}
      <h2 style={{ ...h2Style, margin: "0 0 14px" }}>{title}</h2>
      {children}
    </section>
  );
}

export function StepHeading({ step, total, title, icon: Icon }: {
  step: number;
  total: number;
  title: string;
  icon: LucideIcon;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        marginBottom: 14,
      }}
    >
      <span aria-hidden="true"
        style={{
          width: 52,
          height: 52,
          borderRadius: 16,
          background: green,
          color: white,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          boxShadow: "0 6px 18px rgba(0,200,83,0.28)",
        }}
      >
        <Icon size={24} strokeWidth={2.2} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 2,
          }}
        >
          <span style={{ ...kicker, color: muted }}>
            Step {step} of {total}
          </span>
          <span aria-hidden style={{ display: "inline-flex", gap: 4 }}>
            {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
              <span
                key={n}
                style={{
                  width: n === step ? 16 : 6,
                  height: 6,
                  borderRadius: 3,
                  background: n <= step ? green : "rgba(10,31,26,0.12)",
                }}
              />
            ))}
          </span>
        </div>
        <h2 style={{ ...h2Style, margin: 0 }}>{title}</h2>
      </div>
    </div>
  );
}

export function StepSection({
  id,
  step,
  title,
  icon: Icon,
  summary,
  children,
}: {
  id: string;
  step: number;
  title: string;
  icon: LucideIcon;
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="g-reveal" style={sectionStyle}>
      <StepHeading icon={Icon} step={step} total={STEP_COUNT} title={title} />
      <Card
        style={{
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
          borderLeft: `4px solid ${green}`,
          marginBottom: 16,
        }}
      >
        <Sparkles
          size={18}
          color={green}
          style={{ flexShrink: 0, marginTop: 3 }}
        />
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: text }}>
          {summary}
        </p>
      </Card>
      {children}
    </section>
  );
}

export function Bullets({
  items,
  icon: Icon = CircleCheck,
}: {
  items: ReactNode[];
  icon?: LucideIcon;
}) {
  return (
    <ul style={{ listStyle: "none", margin: "0 0 14px", padding: 0 }}>
      {items.map((item, i) => (
        <li
          key={i}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            fontSize: 14.5,
            color: muted,
            lineHeight: 1.6,
            marginBottom: 9,
          }}
        >
          <Icon
            size={17}
            color={green}
            style={{ flexShrink: 0, marginTop: 3 }}
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

const CALLOUT_PALETTE = {
  info: { bg: tint, border: green, text },
  warn: { bg: "#FFF8E6", border: colors.amber, text: "#5A3E00" },
  danger: { bg: colors.redTint, border: colors.red, text: "#6B1A17" },
} as const;

export function Callout({
  kind = "info",
  title,
  children,
}: {
  kind?: keyof typeof CALLOUT_PALETTE;
  title?: string;
  children: ReactNode;
}) {
  const palette = CALLOUT_PALETTE[kind];
  return (
    <div
      style={{
        background: palette.bg,
        borderLeft: `4px solid ${palette.border}`,
        borderRadius: 12,
        padding: "12px 16px",
        margin: "12px 0 16px",
        fontSize: 14.5,
        color: palette.text,
        lineHeight: 1.6,
      }}
    >
      {title && <p style={{ margin: "0 0 4px", fontWeight: 800 }}>{title}</p>}
      <div>{children}</div>
    </div>
  );
}

export function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  const cell: CSSProperties = {
    padding: "10px 14px",
    textAlign: "left",
    verticalAlign: "top",
    lineHeight: 1.55,
  };
  return (
    <div
      style={{
        ...card,
        borderRadius: 12,
        overflowX: "auto",
        margin: "10px 0 16px",
      }}
    >
      <table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}
      >
        <thead>
          <tr style={{ background: tint }}>
            {head.map((h) => (
              <th
                key={h}
                style={{
                  ...cell,
                  fontWeight: 700,
                  color: text,
                  borderBottom: `1px solid ${border}`,
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              style={{
                borderBottom:
                  i === rows.length - 1 ? "none" : `1px solid ${border}`,
              }}
            >
              {row.map((value, j) => (
                <td
                  key={j}
                  style={{
                    ...cell,
                    color: j === 0 ? text : muted,
                    fontWeight: j === 0 ? 600 : 400,
                  }}
                >
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Code({
  title,
  children,
}: {
  title?: string;
  children: string;
}) {
  const { state, copy } = useCopyToClipboard();
  return (
    <div
      style={{
        position: "relative",
        margin: "10px 0 14px",
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid rgba(10,31,26,0.08)",
      }}
    >
      {title && (
        <div
          style={{
            background: "#161b22",
            color: "#8b949e",
            fontFamily: mono,
            fontSize: 11,
            padding: "6px 12px",
            borderBottom: "1px solid #30363d",
          }}
        >
          {title}
        </div>
      )}
      <pre
        style={{
          margin: 0,
          background: "#0d1117",
          color: "#e6edf3",
          padding: 14,
          fontSize: 12,
          lineHeight: 1.6,
          overflowX: "auto",
          fontFamily: mono,
        }}
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={() => copy(children)}
        aria-label={`Copy ${title ?? "code"}`}
        style={{
          position: "absolute",
          top: title ? 32 : 8,
          right: 8,
          background: "#21262d",
          color: "#e6edf3",
          border: "1px solid #30363d",
          borderRadius: 6,
          padding: "3px 8px",
          fontSize: 11,
          cursor: "pointer",
          fontFamily: font,
        }}
      >
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Copy failed"
            : "Copy"}
      </button>
    </div>
  );
}

export function CodeToggle({
  label = "Show the code",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <details className="g-code" style={{ margin: "6px 0 0" }}>
      <summary
        style={{
          listStyle: "none",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          fontWeight: 700,
          color: green,
          background: white,
          border: `1.5px solid ${green}`,
          borderRadius: 999,
          padding: "6px 14px",
        }}
      >
        <span style={{ fontFamily: mono }}>{"</>"}</span> {label}
      </summary>
      <div style={{ marginTop: 8 }}>{children}</div>
    </details>
  );
}

export function Collapsible({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="g-more" style={{ ...card, marginBottom: 10 }}>
      <summary
        style={{
          listStyle: "none",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 16px",
          fontSize: 15,
          fontWeight: 700,
          color: text,
        }}
      >
        {title}
        <span aria-hidden style={{ color: green }}>
          ▾
        </span>
      </summary>
      <div style={{ padding: "0 16px 14px" }}>{children}</div>
    </details>
  );
}

export function CopyButton({
  text: getText,
  label,
  primary = true,
}: {
  text: () => string;
  label: string;
  primary?: boolean;
}) {
  const { state, copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => copy(getText())}
      style={pillButton(primary)}
    >
      <ClipboardCopy size={16} />
      {state === "copied"
        ? "Copied!"
        : state === "failed"
          ? "Copy failed"
          : label}
    </button>
  );
}

export function ProgressBar({
  pct,
  height = 4,
}: {
  pct: number;
  height?: number;
}) {
  return (
    <div
      aria-hidden
      style={{
        height,
        borderRadius: height / 2,
        background: colors.track,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          borderRadius: height / 2,
          background: green,
          transition: "width .2s ease",
        }}
      />
    </div>
  );
}
