import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { countChecks, type ChecklistGroup } from "../content/checklists";
import { card, colors } from "../theme";
import { ProgressBar } from "./ui";

const { green, text, muted } = colors;

export function TestChecklist({
  groups,
  doneText,
}: {
  groups: ChecklistGroup[];
  doneText: string;
}) {
  const total = countChecks(groups);
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const pct = Math.round((done.size / total) * 100);

  const toggle = (key: string) =>
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div>
      <div style={{ padding: "8px 0 10px", marginBottom: 6 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            fontSize: 13,
            fontWeight: 700,
            color: text,
            marginBottom: 6,
          }}
        >
          <span style={{ whiteSpace: "nowrap" }}>
            {done.size} of {total} tested
          </span>
          <span
            style={{ color: pct === 100 ? green : muted, textAlign: "right" }}
          >
            {pct === 100 ? doneText : `${pct}%`}
          </span>
        </div>
        <ProgressBar pct={pct} height={8} />
      </div>
      {groups.map((group) => (
        <div
          key={group.group}
          style={{ ...card, padding: "14px 16px 6px", marginBottom: 12 }}
        >
          <p
            style={{
              fontSize: 12,
              fontWeight: 800,
              color: green,
              margin: "0 0 10px",
              textTransform: "uppercase",
              letterSpacing: "0.5px",
            }}
          >
            {group.group}
          </p>
          {group.items.map((item) => {
            const key = `${group.group}|${item.q}`;
            const checked = done.has(key);
            return (
              <label
                key={key}
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  marginBottom: 12,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(key)}
                  style={{
                    width: 18,
                    height: 18,
                    marginTop: 2,
                    accentColor: green,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    lineHeight: 1.5,
                    opacity: checked ? 0.6 : 1,
                    transition: "opacity .2s",
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      fontSize: 14.5,
                      color: text,
                      fontWeight: 600,
                      textDecoration: checked ? "line-through" : "none",
                    }}
                  >
                    {item.q}
                  </span>
                  <span
                    style={{ display: "block", fontSize: 13.5, color: muted }}
                  >
                    <ArrowRight
                      size={13}
                      color={green}
                      style={{
                        display: "inline",
                        verticalAlign: -2,
                        marginRight: 4,
                      }}
                    />
                    {item.expect}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}
