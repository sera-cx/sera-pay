import { useEffect, useRef } from "react";
import { ArrowDown, Check, ChevronRight, ClipboardCopy } from "lucide-react";
import { useCopyToClipboard } from "../swap-guide/hooks";
import { jumpTo } from "../swap-guide/navigation";
import type { Flow } from "./catalog";
import { GuideIntro, GuideManualHeading } from "./GuideIntro";
import { WalletSigningGuide } from "./WalletSigningGuide";

function PromptActions({ prompt }: { prompt: string }) {
  const { copy, state } = useCopyToClipboard();
  const preview = useRef<HTMLDetailsElement>(null);
  const text = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (state !== "failed" || !preview.current || !text.current) return;
    preview.current.open = true;
    text.current.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(text.current);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [state]);

  return (
    <>
      <div className="si-actions si-guide-start-actions">
        <button
          type="button"
          className="si-button si-primary"
          onClick={() => copy(prompt)}
          aria-live="polite"
        >
          {state === "copied" ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <ClipboardCopy size={16} aria-hidden="true" />
          )}
          {state === "copied" ? "Copied" : "Copy integration prompt"}
        </button>
        <a
          href="#manual"
          className="si-guide-manual-link"
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            jumpTo(event, "manual");
            document.getElementById("manual")?.focus({ preventScroll: true });
          }}
        >
          Manual integration <ArrowDown size={15} aria-hidden="true" />
        </a>
      </div>
      {state === "failed" && (
        <p role="status">
          Clipboard access is unavailable. Copy the selected prompt below.
        </p>
      )}
      <details className="si-prompt-preview" ref={preview}>
        <summary>
          <ChevronRight size={15} aria-hidden="true" />
          Preview prompt
        </summary>
        <pre ref={text} tabIndex={0} aria-label="Integration prompt">
          {prompt}
        </pre>
      </details>
    </>
  );
}

export function GuideStart({
  flow,
  prompt,
}: {
  flow: Flow;
  prompt: string;
}) {
  return (
    <>
      <GuideIntro flow={flow}>
        <PromptActions key={prompt} prompt={prompt} />
      </GuideIntro>
      <GuideManualHeading />
      <WalletSigningGuide flow={flow} />
    </>
  );
}
