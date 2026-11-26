import type { CSSProperties } from "react";

export const font =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Display', Inter, sans-serif";
export const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export const colors = {
  green: "#00C853",
  greenDark: "#00A846",
  text: "#0A1F1A",
  muted: "#3D5A4F",
  tint: "#EAF7F0",
  border: "rgba(78,206,154,0.18)",
  track: "rgba(10,31,26,0.08)",
  amber: "#F5A623",
  amberTint: "#FFF3DC",
  red: "#E53935",
  redTint: "#FDECEC",
  blue: "#2F4BB3",
  blueTint: "#E8EEFF",
  white: "#fff",
} as const;

export const card: CSSProperties = {
  background: colors.white,
  border: `1px solid ${colors.border}`,
  borderRadius: 14,
};

export const kicker: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: colors.green,
  letterSpacing: "0.6px",
  textTransform: "uppercase",
};

export function pillButton(primary: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    justifyContent: "center",
    minHeight: 42,
    background: primary
      ? "linear-gradient(135deg, #087B58, #087050, #006445)"
      : colors.white,
    color: primary ? colors.white : colors.text,
    border: primary ? "1px solid transparent" : `1px solid ${colors.border}`,
    borderRadius: 14,
    padding: "8px 13px",
    fontSize: 14,
    fontWeight: 700,
    textDecoration: "none",
    cursor: "pointer",
    fontFamily: font,
  };
}
