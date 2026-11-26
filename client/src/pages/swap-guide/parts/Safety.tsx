import { RuleCards } from "../components/diagrams";
import { B, C, P, Section, Table } from "../components/ui";
import { colors } from "../theme";

export function GoldenRules() {
  return (
    <Section id="rules" eyebrow="Print this" title="Golden rules">
      <P>If you remember nothing else, remember these six.</P>
      <RuleCards />
    </Section>
  );
}

export function WhenThingsGoWrong() {
  return (
    <Section id="errors" eyebrow="Error handling" title="When things go wrong">
      <Table
        head={["What happened", "Show the customer", "Try again?"]}
        rows={[
          [
            "Customer rejected in wallet",
            "Swap cancelled. Nothing was submitted.",
            "Only if they press Swap",
          ],
          [
            <>
              No liquidity <C>no_liquidity</C>
            </>,
            "This amount isn't available right now. Lower amount may work.",
            "With a lower amount",
          ],
          [
            <>
              Too small <C>AMOUNT_BELOW_MIN</C>
            </>,
            "Minimum amount is {amount} {token}.",
            "After they raise it",
          ],
          [
            <>
              Price expired <C>QUOTE_STALE</C> <C>INTENT_DEADLINE_EXPIRED</C>
            </>,
            "Refreshing the price. Review new terms before signing.",
            "With a fresh quote and signatures, up to twice",
          ],
          [
            <>
              Price moved <C>SLIPPAGE_EXCEEDED</C>
            </>,
            "Get a new price.",
            "Yes, with a new price",
          ],
          [
            <>
              Permission missing <C>ALLOWANCE_INSUFFICIENT</C>
            </>,
            "Go back to step 2.",
            "Yes, after step 2",
          ],
          [
            <>
              Open opposite order <C>STP_BLOCKED</C>
            </>,
            "Cancel your open order first.",
            "After they cancel it",
          ],
          [
            <>
              Settlement hiccup <C>TRANSIENT_SETTLEMENT_FAILURE</C>
            </>,
            "Checking the order’s settlement status.",
            "After verifying a terminal failure",
          ],
          [
            <>
              Price request throttled <C>429</C>
            </>,
            "Waiting for the next price update.",
            "After Retry-After",
          ],
          [
            <>Submit service unavailable <C>503</C></>,
            "Checking whether your swap was received.",
            "Reconcile the original attempt first",
          ],
          [
            <B>No answer at all (timeout)</B>,
            "Execution status is unknown. Do not submit it again.",
            <span style={{ color: colors.red, fontWeight: 800 }}>Never</span>,
          ],
        ]}
      />
      <P>
        Read the HTTP status and Sera’s structured error fields. A quote below
        the minimum returns <C>detail.code</C>. An unavailable pair can return
        <C> detail.error = "no_liquidity"</C>. Preserve the original response
        when reporting an unrecognized error.
      </P>
    </Section>
  );
}
