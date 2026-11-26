import { useEffect, useRef, type MouseEvent } from "react";
import { jumpTo, MOBILE_MENU_CLASS } from "../navigation";
import type { LucideIcon } from "lucide-react";
import { colors } from "../theme";
import { ProgressBar } from "./ui";

const { green, text, muted, tint, border, white } = colors;

export type TocSection = { id: string; label: string; step?: number };
export type TocGroup = {
  title: string;
  icon: LucideIcon;
  sections: TocSection[];
};

interface TocProps {
  activeId: string;
  progress: number;
  groups: TocGroup[];
}

function TocList({
  activeId,
  groups,
  onPick,
  large = false,
}: {
  activeId: string;
  groups: TocGroup[];
  onPick: (e: MouseEvent, id: string) => void;
  large?: boolean;
}) {
  return (
    <div>
      {groups.map((group) => {
        const groupActive = group.sections.some(({ id }) => id === activeId);
        const Icon = group.icon;
        return (
          <div key={group.title} style={{ marginBottom: large ? 10 : 12 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
                color: groupActive ? text : muted,
              }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 7,
                  background: groupActive ? green : tint,
                  color: groupActive ? white : green,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  transition: "background .2s, color .2s",
                }}
              >
                <Icon size={13} strokeWidth={2.4} />
              </span>
              <span style={{ fontSize: large ? 13 : 12.5, fontWeight: 800 }}>
                {group.title}
              </span>
            </div>
            <div
              style={{
                marginLeft: 10,
                paddingLeft: 12,
                borderLeft: `2px solid ${groupActive ? "rgba(0,200,83,0.25)" : colors.track}`,
              }}
            >
              {group.sections.map((section) => {
                const { id } = section;
                const isActive = id === activeId;
                return (
                  <a
                    key={id}
                    href={`#${id}`}
                    onClick={(e) => onPick(e, id)}
                    aria-current={isActive ? "location" : undefined}
                    style={{
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: large ? 14 : 13,
                      textDecoration: "none",
                      padding: large ? "8px 10px" : "5px 10px",
                      borderRadius: 8,
                      color: isActive ? text : muted,
                      fontWeight: isActive ? 700 : 450,
                      background: isActive ? tint : "transparent",
                      transition: "background .15s, color .15s",
                    }}
                  >
                    {isActive && (
                      <span
                        aria-hidden
                        style={{
                          position: "absolute",
                          left: -14,
                          top: 6,
                          bottom: 6,
                          width: 2,
                          borderRadius: 1,
                          background: green,
                        }}
                      />
                    )}
                    {section.step && (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 800,
                          color: isActive ? green : "rgba(10,31,26,0.35)",
                          width: 10,
                          flexShrink: 0,
                        }}
                      >
                        {section.step}
                      </span>
                    )}
                    <span>{section.label}</span>
                  </a>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DesktopToc({ activeId, progress, groups }: TocProps) {
  return (
    <nav
      className="guide-toc"
      aria-label="On this page"
      style={{
        position: "sticky",
        top: 84,
        alignSelf: "start",
        maxHeight: "calc(100vh - 100px)",
        overflowY: "auto",
        paddingRight: 4,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          margin: "0 0 8px",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            color: muted,
            letterSpacing: "0.6px",
            textTransform: "uppercase",
          }}
        >
          On this page
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: green }}>
          {progress}%
        </span>
      </div>
      <div style={{ marginBottom: 16 }}>
        <ProgressBar pct={progress} />
      </div>
      <TocList groups={groups} activeId={activeId} onPick={jumpTo} />
      <a
        href="https://docs.sera.cx"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-block",
          marginTop: 6,
          fontSize: 12,
          color: green,
          fontWeight: 700,
          textDecoration: "none",
        }}
      >
        Full API docs ↗
      </a>
    </nav>
  );
}

export function MobileToc({ activeId, progress, groups }: TocProps) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const close = () => menuRef.current?.removeAttribute("open");

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const menu = menuRef.current;
      if (menu?.open && !menu.contains(e.target as Node))
        menu.removeAttribute("open");
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const section = groups
    .flatMap((group) => group.sections)
    .find(({ id }) => id === activeId);

  return (
    <details
      ref={menuRef}
      className={MOBILE_MENU_CLASS}
      style={{
        position: "sticky",
        top: "var(--si-guide-menu-top, 70px)",
        zIndex: 20,
        background: white,
        border: `1px solid ${border}`,
        borderRadius: 12,
        boxShadow: "0 4px 14px rgba(10,31,26,0.06)",
      }}
    >
      <summary
        aria-label="On this page"
        style={{
          position: "relative",
          listStyle: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "11px 14px 13px",
          fontSize: 13,
          fontWeight: 700,
          color: text,
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ color: muted, fontWeight: 600 }}>On this page</span>
          {section && <span> › {section.label}</span>}
        </span>
        <span
          aria-hidden
          className="g-caret"
          style={{
            color: green,
            fontSize: 16,
            lineHeight: 1,
            marginLeft: 10,
            transition: "transform .2s ease",
          }}
        >
          ▾
        </span>
        <span
          aria-hidden
          style={{ position: "absolute", left: 14, right: 14, bottom: 0 }}
        >
          <ProgressBar pct={progress} />
        </span>
      </summary>
      {/* Absolutely positioned so opening the menu never pushes the page content down. */}
      <div
        style={{
          position: "absolute",
          top: "calc(100% + 6px)",
          left: 0,
          right: 0,
          background: white,
          border: `1px solid ${border}`,
          borderRadius: 12,
          boxShadow: "0 12px 32px rgba(10,31,26,0.16)",
          padding: "12px 12px 6px",
          maxHeight: "65vh",
          overflowY: "auto",
          overscrollBehavior: "contain",
        }}
      >
        <TocList
          large
          groups={groups}
          activeId={activeId}
          onPick={(e, id) => {
            close();
            jumpTo(e, id);
          }}
        />
      </div>
    </details>
  );
}
