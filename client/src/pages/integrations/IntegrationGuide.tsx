import { useMemo, type ReactNode } from "react";
import {
  Compass,
  FlaskConical,
  Hammer,
  Rocket,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import { Link } from "wouter";
import { Code, CodeToggle, StepHeading } from "../swap-guide/components/ui";
import { TestChecklist } from "../swap-guide/components/TestChecklist";
import type { TocGroup } from "../swap-guide/components/TableOfContents";
import { catalog } from "./catalog";
import { GuideLayout } from "./GuideLayout";
import { GuideFlowOverview } from "./GuideFlowOverview";
import { GuideWorkedExample } from "./GuideWorkedExample";
import { guides } from "./guides";
import { guideExamples } from "./guides/visual-examples";
import { API_SETUP } from "./guides/shared";
import { TransactionHistoryGuide } from "./TransactionHistoryGuide";
import { GuideStart } from "./GuideStart";
import { buildIntegrationPrompt } from "./guides/ai-prompt";
import { useWidgetNetwork } from "./WidgetNetwork";
import { widgetGuidePath } from "@shared/integration-widget";

type GuideFlow = keyof typeof guides;

function GuideSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="si-panel si-guide-section" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function RuleList({ items }: { items: string[] }) {
  return (
    <ul className="si-guide-rules">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export default function IntegrationGuide({ flow }: { flow: GuideFlow }) {
  const { network } = useWidgetNetwork();
  const guide = guides[flow];
  const config = catalog[flow];
  const groups = useMemo<TocGroup[]>(
    () => [
      {
        title: "Get started",
        icon: Sparkles,
        sections: [
          { id: "ai", label: "Let AI build it" },
          { id: "manual", label: "Manual integration" },
          { id: "api-key-signing", label: "When you need an API key" },
        ],
      },
      {
        title: "Overview",
        icon: Compass,
        sections: [
          { id: "overview", label: "How it works" },
          { id: "setup", label: "Testnet setup" },
        ],
      },
      {
        title: `Build in ${guide.steps.length} steps`,
        icon: Hammer,
        sections: guide.steps.map(({ id, title }, index) => ({
          id,
          label: title,
          step: index + 1,
        })),
      },
      { title: "Activity", icon: Workflow, sections: [{ id: "transactions", label: "Transaction history" }] },
      {
        title: "Stay safe",
        icon: ShieldCheck,
        sections: [{ id: "edge-cases", label: "What can go wrong" }],
      },
      {
        title: "Launch",
        icon: Rocket,
        sections: [{ id: "checklist", label: "Testnet checklist" }],
      },
    ],
    [guide.steps],
  );
  const prompt = buildIntegrationPrompt(flow, network ?? "sepolia");

  return (
    <GuideLayout flow={flow} groups={groups}>
      <GuideStart
        flow={flow}
        prompt={prompt}
      />
      <GuideSection id="overview" title="How it works">
        <GuideFlowOverview flow={flow} />
      </GuideSection>
      <GuideSection id="setup" title="Set up on testnet">
        <p>
          Start on Ethereum Sepolia. Use separate credentials, token addresses
          and order records for each environment.
        </p>
        <RuleList items={guide.setup} />
        <CodeToggle label="Show CLOB setup">
          <Code title="sera.js">{API_SETUP}</Code>
        </CodeToggle>
        <p className="si-account-sample">
          In the examples, <code>sera</code> calls the public API,{" "}
          <code>wallet</code> is your wallet client, and persistence and
          confirmation functions belong to your app.
        </p>
      </GuideSection>
      {guide.steps.map((step, index) => (
        <section className="si-panel si-guide-section" id={step.id} key={step.id}>
          <StepHeading step={index + 1} total={guide.steps.length} title={step.title} icon={step.icon} />
          <p>{step.summary}</p>
          {step.id === guideExamples[flow].stepId && <GuideWorkedExample key={flow} flow={flow} />}
          <details className="si-guide-notes">
            <summary>What to check</summary>
            <RuleList items={step.rules} />
          </details>
          {step.sample && (
            <CodeToggle label="Show request example">
              <Code title={step.sample.title}>{step.sample.code}</Code>
            </CodeToggle>
          )}
          {step.extraSamples?.map((sample) => (
            <CodeToggle key={sample.title} label={sample.title}>
              <Code>{sample.code}</Code>
            </CodeToggle>
          ))}
          {flow === "accept" && step.id === "checkout" && (
            <div className="si-actions si-account-sample">
              <Link
                className="si-button"
                href={widgetGuidePath("transfer", network ?? "sepolia")}
              >
                Transfer guide
              </Link>
              <Link
                className="si-button"
                href={widgetGuidePath("swap", network ?? "sepolia")}
              >
                Swap guide
              </Link>
            </div>
          )}
        </section>
      ))}
      <TransactionHistoryGuide flow={flow} />
      <GuideSection id="edge-cases" title="What can go wrong">
        <details className="si-guide-notes">
          <summary>Show retry and recovery cases</summary>
          <dl className="si-guide-edges">
            {guide.edgeCases.map(([title, guidance]) => (
              <div key={title}>
                <dt>{title}</dt>
                <dd>{guidance}</dd>
              </div>
            ))}
          </dl>
        </details>
      </GuideSection>
      <GuideSection id="checklist" title="Testnet checklist">
        <p className="si-eyebrow">
          <FlaskConical size={16} aria-hidden="true" /> Ethereum Sepolia
        </p>
        <TestChecklist
          groups={guide.checklist}
          doneText="Testnet checklist complete"
        />
        <p className="si-account-sample">
          <strong>After testnet passes.</strong> {guide.production}
        </p>
        <a className="si-guide-docs-link" href={config.docs}>
          Official testnet API reference
        </a>
      </GuideSection>
    </GuideLayout>
  );
}
