import { KeyRound, Server, Wallet } from "lucide-react";
import * as code from "../content/code-samples";
import { jumpTo } from "../navigation";
import { ArchitectureDiagram, SequenceDiagram } from "../components/diagrams";
import {
  B,
  Bullets,
  C,
  Code,
  CodeToggle,
  Grid,
  H3,
  IconCard,
  InlineLink,
  P,
  Section,
} from "../components/ui";

export function HowItWorks() {
  return (
    <Section id="how" eyebrow="The big picture" title="How it works">
      <P>
        <B>Your app</B> gets the price from <B>Sera’s API</B>. The customer
        authorizes the swap in their wallet. Your backend submits the signed
        quote and tracks it through settlement.
      </P>
      <ArchitectureDiagram />
      <H3>Who talks to whom, in order</H3>
      <SequenceDiagram />
    </Section>
  );
}

export function BeforeYouStart() {
  return (
    <Section id="setup" eyebrow="5 minutes" title="Before you start">
      <Grid min={220} style={{ marginBottom: 16 }}>
        <IconCard icon={Server} title="Sera API (start on testnet)">
          Testnet: <C>api.testnet.sera.cx/api/v1</C>
          <br />
          Production: <C>api.sera.cx/api/v1</C>
          <br />
          <span style={{ fontSize: 12.5 }}>
            Switch only after all tests pass.{" "}
            <InlineLink href="#golive" onClick={(e) => jumpTo(e, "golive")}>
              How
            </InlineLink>
          </span>
        </IconCard>
        <IconCard icon={Wallet} title="A wallet that can sign">
          Use a wallet that signs EIP-712 messages. When a token needs
          an on-chain approval, the wallet must also support raw transaction signing.
        </IconCard>
        <IconCard icon={KeyRound} title="Wallet access for private data">
          Anyone can request a quote. When the customer wants to see their
          balances or track settlement, reuse their key for this network.
          Follow the steps to{" "}
          <InlineLink href="#api-key-signing" onClick={(e) => jumpTo(e, "api-key-signing")}>
            sign for an API key
          </InlineLink>
          .
        </IconCard>
      </Grid>
      <H3>When your app opens, load 3 things</H3>
      <Bullets
        items={[
          <>
            <B>Settings</B> from <C>/config</C>: contract addresses. Never type
            them into your code; they can change.
          </>,
          <>
            <B>Sera's clock</B> from <C>/system/time</C>: use it for every
            deadline, not the phone's clock.
          </>,
          <>
            <B>Coin list</B> from <C>/tokens</C>: addresses, decimals and
            minimum amounts. If it fails to load, block swaps and show "Token
            list unavailable. Please try again."
          </>,
        ]}
      />
      <CodeToggle>
        <Code title="setup.ts">{code.SETUP}</Code>
      </CodeToggle>
    </Section>
  );
}
