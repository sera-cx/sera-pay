import {
  Coins,
  FlaskConical,
  ListChecks,
  Rocket,
  ToggleRight,
} from "lucide-react";
import {
  countChecks,
  PRODUCTION_CHECKS,
  TESTNET_CHECKS,
} from "../content/checklists";
import * as code from "../content/code-samples";
import { jumpTo } from "../navigation";
import { LaunchPath } from "../components/diagrams";
import { TestChecklist } from "../components/TestChecklist";
import {
  B,
  C,
  Callout,
  Code,
  CodeToggle,
  H3,
  InlineLink,
  P,
  Section,
  Table,
} from "../components/ui";

const TESTNET_TOTAL = countChecks(TESTNET_CHECKS);

export function TestnetThenLive() {
  return (
    <Section
      id="golive"
      eyebrow="Safe launch"
      title="Test on testnet first, then go live"
    >
      <P>
        Testnet is a practice copy of Sera that uses free test coins. Build and
        test everything there. Switch to real money only when every test passes.
      </P>
      <Table
        head={["", "Testnet (practice)", "Production (real money)"]}
        rows={[
          [
            "API address",
            <C>api.testnet.sera.cx/api/v1</C>,
            <C>api.sera.cx/api/v1</C>,
          ],
          ["Network", "Sepolia", "Ethereum mainnet"],
          ["Chain ID", <C>11155111</C>, <C>1</C>],
          ["Coins", "Free test coins, worth nothing", "Real coins"],
          ["API key", "Its own key", "Make a new one"],
          ["Docs", "docs.testnet.sera.cx", "docs.sera.cx"],
        ]}
      />
      <H3>Your launch path</H3>
      <LaunchPath
        phases={[
          {
            env: "testnet",
            icon: FlaskConical,
            title: "Build on testnet",
            text: (
              <>
                Use the testnet API address. Put the wallet on the Sepolia
                network. Get free test coins (see docs.testnet.sera.cx), and a
                little Sepolia ETH if you test an on-chain token approval.
              </>
            ),
          },
          {
            env: "testnet",
            icon: ListChecks,
            title: "Pass every test",
            text: (
              <>
                Run the whole{" "}
                <InlineLink href="#test" onClick={(e) => jumpTo(e, "test")}>
                  test checklist
                </InlineLink>
                . Fix anything that fails. Do not move on until it shows{" "}
                {TESTNET_TOTAL} of {TESTNET_TOTAL}.
              </>
            ),
          },
          {
            env: "switch",
            icon: ToggleRight,
            title: "Switch to production",
            text: (
              <>
                Select the mainnet API and chain 1. Load its <C>/config</C> and <C>/tokens</C>,
                then enable a separate wallet credential. Keep testnet and mainnet
                sessions, balances and pending swaps separate.
              </>
            ),
          },
          {
            env: "production",
            icon: Coins,
            title: "One small real swap",
            text: (
              <>
                Swap a small amount of real money, just above the minimum. Run
                the short production checklist below.
              </>
            ),
          },
          {
            env: "production",
            icon: Rocket,
            title: "Go live",
            text: (
              <>Open it to your customers. Watch the first few swaps closely.</>
            ),
          },
        ]}
      />
      <H3>How to switch</H3>
      <P>
        Keep the API address in one place. Changing that one line is the whole
        switch.
      </P>
      <CodeToggle label="Show the code">
        <Code title="api.ts">{code.SWITCH_TO_PRODUCTION}</Code>
      </CodeToggle>
      <Callout kind="danger" title="Never mix testnet and production">
        Coin and contract addresses are different on each network. Never reuse a
        testnet API key, quote or address on production, or the other way round.
        Always load <C>/config</C> and <C>/tokens</C> from the same API address
        you send swaps to.
      </Callout>
      <Callout kind="warn" title="Wallet on the wrong network?">
        Before any signature, check the wallet is on the network <C>/config</C>{" "}
        names. If not, ask the customer to switch first. A signature made for
        the wrong network is refused.
      </Callout>
      <H3>Production checklist (phase 4)</H3>
      <TestChecklist
        groups={PRODUCTION_CHECKS}
        doneText="Production works. You can go live 🚀"
      />
    </Section>
  );
}

export function TestChecklistSection() {
  return (
    <Section id="test" eyebrow="Run on testnet" title="Test checklist">
      <P>
        Do this on <B>testnet</B> before you touch real money. Try each one in
        your app and tick it when the app does what the arrow says.
      </P>
      <TestChecklist
        groups={TESTNET_CHECKS}
        doneText="All passed on testnet. You can switch to production 🎉"
      />
    </Section>
  );
}
