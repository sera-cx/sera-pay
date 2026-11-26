import { useEffect, useMemo, type ReactNode } from "react";
import {
  DesktopToc,
  MobileToc,
  type TocGroup,
} from "../swap-guide/components/TableOfContents";
import { useScrollPosition } from "../swap-guide/hooks";
import { scrollToSection } from "../swap-guide/navigation";
import type { Flow } from "./catalog";
import { IntegrationHeader } from "./Navigation";

export function GuideLayout({
  flow,
  groups,
  children,
}: {
  flow: Flow;
  groups: TocGroup[];
  children: ReactNode;
}) {
  const ids = useMemo(
    () => groups.flatMap((group) => group.sections.map(({ id }) => id)),
    [groups],
  );
  const { activeId, progress } = useScrollPosition(ids);

  useEffect(() => {
    let frame = 0;
    function followFragment() {
      window.cancelAnimationFrame(frame);
      const id = window.location.hash.slice(1);
      if (!ids.includes(id)) return;
      frame = window.requestAnimationFrame(() => {
        if (window.location.hash.slice(1) === id) scrollToSection(id, false);
      });
    }

    followFragment();
    window.addEventListener("popstate", followFragment);
    window.addEventListener("hashchange", followFragment);
    window.addEventListener("pageshow", followFragment);
    window.addEventListener("pushState", followFragment);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("popstate", followFragment);
      window.removeEventListener("hashchange", followFragment);
      window.removeEventListener("pageshow", followFragment);
      window.removeEventListener("pushState", followFragment);
    };
  }, [ids]);

  return (
    <div className="si-page">
      <IntegrationHeader flow={flow} />
      <div className="si-wrap si-guide">
        <DesktopToc activeId={activeId} progress={progress} groups={groups} />
        <main className="si-guide-content">
          <MobileToc activeId={activeId} progress={progress} groups={groups} />
          {children}
        </main>
      </div>
    </div>
  );
}
