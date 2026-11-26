import { catalog, type Flow } from "./catalog";
import { GuideIntro, GuideManualHeading } from "./GuideIntro";

export function GuideLoadingContent({ flow }: { flow: Flow }) {
  return (
    <div className="si-wrap si-guide si-guide-loading">
      <span className="sr-only" role="status">Loading the {catalog[flow].title} guide</span>
      <div className="guide-toc si-guide-loading-rail" aria-hidden="true">
        <span className="si-guide-loading-eyebrow">On this page</span>
        {[3, 2, 4].map((count) => (
          <div className="si-guide-loading-group" key={count}>
            <span className="si-guide-placeholder" />
            <div>
              {Array.from({ length: count }, (_, i) => <span className="si-guide-placeholder" key={i} />)}
            </div>
          </div>
        ))}
      </div>
      <main className="si-guide-content" aria-busy="true">
        <div className="guide-toc-mobile si-guide-loading-menu" aria-hidden="true">
          On this page <span className="si-guide-placeholder" />
        </div>
        <GuideIntro flow={flow} loading>
          <div className="si-actions si-guide-start-actions si-guide-loading-actions" aria-hidden="true">
            <span className="si-guide-placeholder" />
            <span className="si-guide-placeholder" />
          </div>
          <div className="si-prompt-preview si-guide-loading-preview" aria-hidden="true">
            <span className="si-guide-placeholder" />
          </div>
        </GuideIntro>
        <GuideManualHeading loading />
        <div className="si-panel si-guide-section" aria-hidden="true">
          <h2>When you need an API key</h2>
          <div className="si-guide-access si-guide-loading-access">
            {[0, 1, 2].map((row) => (
              <div key={row}>
                <span className="si-guide-placeholder" />
                <span className="si-guide-placeholder" />
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
