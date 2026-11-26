type ExampleFact = { label: string; value: string };

interface GuideExampleCase {
  label: string;
  facts: [ExampleFact, ExampleFact];
  guidance: string;
  fill?: { matched: number; total: number; unit: string };
}

interface GuideExample {
  stepId: string;
  title: string;
  context: string;
  cases: GuideExampleCase[];
}

export const guideExamples: Record<"transfer" | "set-rate" | "accept", GuideExample> = {
  transfer: {
    stepId: "verify",
    title: "What should the sender see?",
    context: "Example transfer of 25 USDC.",
    cases: [
      {
        label: "Hash matches",
        facts: [
          { label: "Sera returns", value: "The signed transaction’s hash" },
          { label: "Show the sender", value: "Submitted" },
        ],
        guidance: "Record the submission once. The Sera API cannot confirm delivery of a direct transfer.",
      },
      {
        label: "Response lost",
        facts: [
          { label: "Sera response", value: "Timed out after signing" },
          { label: "Show the sender", value: "Submission unconfirmed" },
        ],
        guidance: "Restore the saved hash if the page reloads. Block a second send while the outcome is unknown.",
      },
      {
        label: "Wallet declined",
        facts: [
          { label: "Wallet response", value: "Signature declined before broadcast" },
          { label: "Show the sender", value: "Not sent" },
        ],
        guidance: "Keep the draft so the sender can review it again.",
      },
    ],
  },
  "set-rate": {
    stepId: "manage",
    title: "Read a limit order as it fills",
    context: "Example order to sell 100 USDC at a limit price.",
    cases: [
      {
        label: "Open",
        fill: { matched: 0, total: 100, unit: "USDC" },
        facts: [
          { label: "Remaining", value: "100 USDC" },
          { label: "Fill settlement", value: "No fills yet" },
        ],
        guidance: "The full order is available to match at the limit price or better.",
      },
      {
        label: "Partially filled",
        fill: { matched: 40, total: 100, unit: "USDC" },
        facts: [
          { label: "Remaining", value: "60 USDC" },
          { label: "Fill settlement", value: "One fill still settling" },
        ],
        guidance: "Cancelling the remaining 60 USDC leaves the earlier fill to settle. Keep tracking it.",
      },
      {
        label: "Settled",
        fill: { matched: 100, total: 100, unit: "USDC" },
        facts: [
          { label: "Remaining", value: "0 USDC" },
          { label: "Fill settlement", value: "All fills settled" },
        ],
        guidance: "Use the settled fills’ net debits and credits to show what the trader spent and received.",
      },
    ],
  },
  accept: {
    stepId: "checkout",
    title: "One invoice, two ways to pay",
    context: "Example invoice for 10 USDC. Your app signs a reusable link for the merchant’s wallet.",
    cases: [
      {
        label: "Pay in USDC",
        facts: [
          { label: "Customer pays", value: "10 USDC plus the network fee in ETH" },
          { label: "Payment route", value: "Direct transfer to the merchant" },
        ],
        guidance: "Show Submitted when Sera returns the matching hash. Keep automatic fulfillment off for this route.",
      },
      {
        label: "Pay in XSGD",
        facts: [
          { label: "Customer reviews", value: "Maximum XSGD spend from a fresh quote" },
          { label: "Required minimum", value: "10 USDC to the merchant" },
        ],
        guidance: "Match the signed recipient to the merchant. Mark paid only after the order and its settled fills account for at least 10 USDC.",
      },
    ],
  },
};
