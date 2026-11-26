import {
  widgetFlows as flows,
  type WidgetFlow,
} from "@shared/integration-widget";

export { flows };
export type Flow = WidgetFlow;

export function integrationPath(path: string) {
  const normalized = path.replace(/\/$/, "");
  for (const flow of flows) {
    if (normalized === `/${flow}/guide`) return { flow, guide: true };
  }
  return null;
}

export const catalog = {
  swap: {
    title: "Swap",
    guideIntro:
      "Let users swap stablecoins, approve the reviewed price in their wallet and track settlement in your app.",
    docs: "https://docs.testnet.sera.cx/api-reference/endpoints/swaps/",
  },
  transfer: {
    title: "Transfer",
    guideIntro:
      "Move a whitelisted ERC-20 token from the sender’s wallet to the recipient. The sender signs the transfer and Sera returns a transaction hash when it accepts the broadcast.",
    docs: "https://docs.testnet.sera.cx/api-reference/endpoints/account/#erc-20-transfer",
  },
  "set-rate": {
    title: "Set Rate",
    guideIntro:
      "Publish a limit order at your own price. Set Rate uses a funded Vault balance. Orders can rest, fill in parts, match and settle later, or be cancelled.",
    docs: "https://docs.testnet.sera.cx/api-reference/endpoints/orders/",
  },
  accept: {
    title: "Accept",
    guideIntro:
      "Choose the token you receive. Set an amount or let the customer enter one at checkout, then share the payment link.",
    docs: "https://docs.testnet.sera.cx/api-reference/endpoints/swaps/",
  },
} as const;
