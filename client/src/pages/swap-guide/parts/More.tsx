import { useWidgetNetwork } from "../../integrations/WidgetNetwork";
import { COMPACT_RULES, auditSwapPrompt } from "../content/ai-prompts";
import {
  Collapsible,
  CopyButton,
  P,
  Section,
  Table,
} from "../components/ui";
import { colors } from "../theme";

export function Extras() {
  const { network } = useWidgetNetwork();
  return (
    <Section id="extras" eyebrow="Reference" title="Extras">
      <Collapsible title="Audit an existing swap integration">
        <P>
          Copy the audit prompt to check an existing implementation against the
          swap rules.
        </P>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <CopyButton
            text={() => auditSwapPrompt(network ?? "sepolia")}
            label="Copy audit prompt"
          />
          <CopyButton
            primary={false}
            text={() => COMPACT_RULES}
            label="Copy rules only"
          />
        </div>
      </Collapsible>
      <Collapsible title="All messages to show customers">
        <Table
          head={["Moment", "Text"]}
          rows={[
            ["Button", "Swap / Approve {token} then swap"],
            [
              "Progress",
              "Fetching quote… / Approving… / Sign on wallet / Swapping…",
            ],
            [
              "Rate moved",
              "Rate changed. Quote moved while confirming. Refresh and review the new rate before signing the swap.",
            ],
            [
              "Wallet silent",
              "Your wallet did not respond in time. Check whether the swap was submitted before trying again.",
            ],
            [
              "Needs ETH",
              "Your wallet needs ETH for this approval’s network fee.",
            ],
            [
              "Network cost tooltip",
              "This is a blockchain network fee paid to validators. It is not charged by Sera.",
            ],
            [
              "Slow",
              "Swap is taking longer than expected. We've stopped checking after 5 minutes. The order may still settle on-chain.",
            ],
            [
              "Success",
              "Swap settled. The recipient received {amount} {symbol}.",
            ],
            [
              "Failed",
              "This swap failed to settle. Refresh your wallet to see current balances and any earlier token approvals.",
            ],
            [
              "Cancelled",
              "This swap was cancelled before settling. Check your wallet for any earlier token approval.",
            ],
          ]}
        />
      </Collapsible>
    </Section>
  );
}

export function DocsBanner() {
  return (
    <div
      className="g-reveal"
      style={{
        background: `linear-gradient(135deg, ${colors.green}, ${colors.greenDark})`,
        borderRadius: 20,
        padding: "28px 24px",
        textAlign: "center",
        marginTop: 56,
      }}
    >
      <h2
        style={{
          fontSize: 22,
          fontWeight: 900,
          color: colors.white,
          margin: "0 0 8px",
        }}
      >
        Need every field and endpoint?
      </h2>
      <p
        style={{
          fontSize: 14.5,
          color: "rgba(255,255,255,0.88)",
          margin: "0 0 18px",
        }}
      >
        The full API reference lives on docs.sera.cx.
      </p>
      <a
        href="https://docs.sera.cx"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          background: colors.white,
          color: colors.green,
          borderRadius: 999,
          padding: "12px 28px",
          fontSize: 14.5,
          fontWeight: 800,
          textDecoration: "none",
          display: "inline-block",
        }}
      >
        Open docs.sera.cx
      </a>
    </div>
  );
}
