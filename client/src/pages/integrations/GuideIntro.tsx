import type { ReactNode } from "react";
import { catalog, type Flow } from "./catalog";

export function GuideIntro({
  flow,
  loading = false,
  children,
}: {
  flow: Flow;
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <header className="si-guide-hero">
        <h1>Integrate Sera {catalog[flow].title}</h1>
        <p>{catalog[flow].guideIntro}</p>
      </header>
      <section
        id={loading ? undefined : "ai"}
        className="si-panel si-guide-section si-guide-start"
        aria-labelledby="ai-title"
      >
        <h2 id="ai-title">Let AI build it</h2>
        <p>
          Paste the prompt into your coding assistant with your project open. It
          includes the API calls and Sepolia tests for this integration.
        </p>
        {children}
      </section>
    </>
  );
}

export function GuideManualHeading({ loading = false }: { loading?: boolean }) {
  return (
    <h2 className="si-guide-manual-heading" id={loading ? undefined : "manual"} tabIndex={loading ? undefined : -1}>
      Manual integration
    </h2>
  );
}
