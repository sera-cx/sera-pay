import type { WidgetFlow } from "@shared/integration-widget";
import { Code, CodeToggle } from "../swap-guide/components/ui";
import { historyGuides } from "./guides/history";

export function TransactionHistoryGuide({ flow }: { flow: WidgetFlow }) {
  const guide = historyGuides[flow];
  return (
    <section id="transactions" className="si-panel si-guide-section" aria-labelledby="transactions-title">
      <h2 id="transactions-title">Transaction history</h2>
      <p>{guide.summary}</p>
      <p>{guide.display}</p>
      <CodeToggle label={guide.sampleTitle}>
        <Code title={guide.sampleTitle}>{guide.example}</Code>
      </CodeToggle>
      {guide.otherExample && (
        <CodeToggle label={guide.otherExample.title}>
          <Code title={guide.otherExample.title}>{guide.otherExample.code}</Code>
        </CodeToggle>
      )}
      <details className="si-guide-notes">
        <summary>Refresh and recovery</summary>
        <ul className="si-guide-rules">
          <li>{guide.check}</li>
          <li>List the newest entries first. Load older entries a page at a time and merge them by ID. Refresh after a submission and when the user returns.</li>
          <li>Guests see a sign-in action. Clear old rows when the wallet or network changes. Show “No transactions yet” only after a successful empty read. Offer a retry when a read fails.</li>
        </ul>
      </details>
      <a className="si-guide-docs-link" href={guide.reference}>Sera API reference</a>
    </section>
  );
}
