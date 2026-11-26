export interface ChecklistGroup {
  group: string;
  items: { q: string; expect: string }[];
}

export const TESTNET_CHECKS: ChecklistGroup[] = [
  {
    group: "Before the swap",
    items: [
      {
        q: "Press Swap with no amount.",
        expect: 'Nothing is sent. The button says "Enter an amount".',
      },
      {
        q: "Type less than Sera's minimum.",
        expect: '"Minimum amount is X" appears.',
      },
      {
        q: "Try to swap more than the wallet holds.",
        expect: '"Insufficient balance" appears.',
      },
      {
        q: "Type a bad receiving address.",
        expect: '"Enter a valid ETH wallet address" appears.',
      },
    ],
  },
  {
    group: "The price",
    items: [
      {
        q: "Leave the price on screen for a minute.",
        expect: "It refreshes by itself about every 25 seconds.",
      },
      {
        q: "Pick an amount so small it receives 0.",
        expect: "The app blocks it and asks for a bigger amount.",
      },
      {
        q: "The price gets worse right before signing.",
        expect:
          '"Rate changed" appears. Nothing is signed until the customer presses "Swap at new rate".',
      },
    ],
  },
  {
    group: "The wallet",
    items: [
      {
        q: "Swap a token whose quote asks for a supported permit.",
        expect:
          "The wallet asks for a gasless permit signature, then the swap signature.",
      },
      {
        q: "Try a quote that needs approval and reports no permit support.",
        expect:
          "The app asks for an approval first. If there is no ETH, it says so.",
      },
      {
        q: "Press Reject in the wallet.",
        expect: '"Swap cancelled. Nothing was submitted."',
      },
    ],
  },
  {
    group: "Sending and after",
    items: [
      {
        q: "Turn off the internet right after pressing Swap.",
        expect:
          "The app does NOT send again. It says the status is unknown and checks the order history.",
      },
      {
        q: "Let a swap finish.",
        expect:
          "Progress shows Submitted, Matched, Confirming, Settled, using the order and its fills.",
      },
      {
        q: "A swap is still pending after 5 minutes.",
        expect:
          'The app stops checking and says it may still settle. It does not say "failed".',
      },
      {
        q: "A swap fails.",
        expect:
          "The app reports the failed swap and refreshes wallet balances and any earlier approvals.",
      },
    ],
  },
];

export const PRODUCTION_CHECKS: ChecklistGroup[] = [
  {
    group: "One small real swap on production",
    items: [
      {
        q: "The API address is api.sera.cx.",
        expect: "The coin list and prices are the real mainnet ones.",
      },
      {
        q: "Swap a small amount, just above the minimum.",
        expect: "It goes Submitted, Matched, Confirming, Settled.",
      },
      {
        q: "Compare the screen with the CLOB settlement economics.",
        expect: "The amounts match the owner’s settled balance debits and credits.",
      },
      {
        q: "Refresh the settled trade.",
        expect: "The order and all fills still match the saved mainnet trade and signed terms.",
      },
      {
        q: "If your integration supports the on-chain approval path, test it with a small swap.",
        expect:
          "A quote that needs a separate approval prompts for it and checks current_allowance_raw on a fresh quote before signing.",
      },
    ],
  },
];

export const countChecks = (groups: ChecklistGroup[]) =>
  groups.reduce((n, g) => n + g.items.length, 0);
