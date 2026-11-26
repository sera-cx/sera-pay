import {
  Hourglass,
  KeyRound,
  PenLine,
  Radar,
  Send,
  ShieldCheck,
  Tag,
} from "lucide-react";
import * as code from "../content/code-samples";
import {
  FreshnessBar,
  PermissionPaths,
  StatusTimeline,
} from "../components/diagrams";
import {
  B,
  Bullets,
  C,
  Callout,
  Code,
  CodeToggle,
  H3,
  Pill,
  StepSection,
  Table,
} from "../components/ui";

export function StepGetPrice() {
  return (
    <StepSection
      id="step1"
      step={1}
      title="Get a price"
      icon={Tag}
      summary={
        <>
          Ask Sera: "If my customer pays 100 USDC, how much USDT do they get?"
          Sera answers with a price that is good for about 30 seconds.
        </>
      }
    >
      <H3>Check these first, then ask</H3>
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}
      >
        <Pill>Amount is above 0</Pill>
        <Pill>Two different coins</Pill>
        <Pill>At least Sera's minimum</Pill>
        <Pill>Enough coins in the wallet</Pill>
        <Pill>Valid receiving address</Pill>
      </div>
      <H3>Pick who pays the network cost</H3>
      <Table
        head={["Option", "What happens", "Use it for"]}
        rows={[
          [
            <C nowrap>receive_less</C>,
            "Customer pays exactly 100, receives a little less.",
            "Normal swaps (default)",
          ],
          [
            <C nowrap>pay_more</C>,
            "Gas increases the input budget. Check the quoted minimum covers the receiver’s target.",
            "Checkouts and invoices",
          ],
        ]}
      />
      <FreshnessBar />
      <Bullets
        icon={ShieldCheck}
        items={[
          <>
            If the new price is worse than the one on screen by more than{" "}
            <B>0.01 %</B>, stop and show <B>"Rate changed"</B> with a{" "}
            <B>"Swap at new rate"</B> button.
          </>,
          <>
            If the customer would receive <B>0</B>, never continue. Show "Amount
            is not enough to cover network cost, please raise your amount."
          </>,
        ]}
      />
      <CodeToggle>
        <Code title="POST /swap/quote">{code.QUOTE_REQUEST}</Code>
        <Code title="Verify the quote">{code.VERIFY_QUOTE}</Code>
        <Code title="Sera answers">{code.QUOTE_RESPONSE}</Code>
      </CodeToggle>
    </StepSection>
  );
}

export function StepGetPermission() {
  return (
    <StepSection
      id="step2"
      step={2}
      title="Get permission"
      icon={KeyRound}
      summary={
        <>
          Sera needs permission to move the coin out of the wallet. The price
          from step 1 already tells you which of these three cases you are in.
        </>
      }
    >
      <PermissionPaths />
      <Bullets
        icon={ShieldCheck}
        items={[
          <>
            The permission must be for Sera's router address from <C>/config</C>
            . If it is not, stop.
          </>,
          <>
            If the quote changes, check its permission again. Sign a fresh
            permit for the new quote when required.
          </>,
        ]}
      />
      <CodeToggle label="Show the decision tree">
        <Code title="decision tree">{code.PERMIT_DECISION_TREE}</Code>
      </CodeToggle>
      <CodeToggle label="Show permit signing">
        <Code title="Sign a supported permit">{code.SIGN_PERMIT}</Code>
      </CodeToggle>
    </StepSection>
  );
}

export function StepSign() {
  return (
    <StepSection
      id="step3"
      step={3}
      title="Sign"
      icon={PenLine}
      summary={
        <>
          The customer signs the exact deal Sera offered. It is free and costs
          no gas.
        </>
      }
    >
      <Bullets
        items={[
          <>
            Right before the wallet opens, check the price is still fresh. If
            not, go back to step 1 for a new one.
          </>,
          <>
            Sign the quote <B>exactly</B> as Sera sent it. Change nothing.
          </>,
          <>
            Customer presses Reject? Show "Swap cancelled. Nothing was
            submitted."
          </>,
        ]}
      />
      <CodeToggle>
        <Code title="sign.ts (viem)">{code.SIGN_INTENT}</Code>
      </CodeToggle>
    </StepSection>
  );
}

export function StepSend() {
  return (
    <StepSection
      id="step4"
      step={4}
      title="Send"
      icon={Send}
      summary={
        <>
          Send the signatures to Sera. Sera answers with a <C>trade_id</C>. Save
          it straight away, before anything else.
        </>
      }
    >
      <Callout kind="danger" title="Internet dropped and no answer came back?">
        Do <B>not</B> send it again. The swap may already be going through. Show
        "Execution status is unknown. Do not submit it again; check your order
        history." Keep it pending while you look it up. If polling stops after 5
        minutes, keep the attempt available for reconciliation.
      </Callout>
      <Bullets
        icon={Hourglass}
        items={[
          <>
            Sera says the price expired (<C>QUOTE_STALE</C> or{" "}
            <C>INTENT_DEADLINE_EXPIRED</C>)? This is the only safe retry: get a
            new price, sign, send. Twice at most.
          </>,
        ]}
      />
      <CodeToggle>
        <Code title="POST /swap">{code.SUBMIT}</Code>
      </CodeToggle>
    </StepSection>
  );
}

export function StepTrack() {
  return (
    <StepSection
      id="step5"
      step={5}
      title="Track"
      icon={Radar}
      summary={
        <>
          Ask Sera every few seconds how the swap is going, and show the
          customer the progress. Stop asking after 5 minutes.
        </>
      }
    >
      <StatusTimeline />
      <Bullets
        items={[
          <>
            Still pending after 5 minutes is <B>not</B> a failure. Say it may
            still settle and offer a Refresh button.
          </>,
          <>
            Failed or cancelled? Show that outcome, refresh Sera balances and
            request a fresh quote before the next attempt.
          </>,
          <>
            Paying a merchant? Bind the signed recipient to the invoice, then
            check Sera’s settled order, fills and net amounts.
          </>,
        ]}
      />
      <CodeToggle>
        <Code title="Check the order and its fills">{code.TRACK}</Code>
      </CodeToggle>
    </StepSection>
  );
}
