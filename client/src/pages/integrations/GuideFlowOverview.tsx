import {
  ChartNoAxesColumnIncreasing, ChevronRight, Link2, MonitorSmartphone, Server,
  Wallet, type LucideIcon,
} from "lucide-react";
import { IconBubble } from "../swap-guide/components/ui";
import type { Flow } from "./catalog";
import "./guide-flow-overview.css";

type GuideFlow = Exclude<Flow, "swap">;

interface Handoff {
  actor: string;
  icon: LucideIcon;
  action: string;
  sends?: string;
  endpoints?: string[];
}

const routes: Record<GuideFlow, { steps: Handoff[]; outcome: string }> = {
  transfer: {
    steps: [
      { actor: "Your app", icon: MonitorSmartphone, action: "Ask Sera to build the transfer. Check the recipient, amount and fee.", sends: "Unsigned transfer", endpoints: ["POST /transfer"] },
      { actor: "Sender’s wallet", icon: Wallet, action: "Sign the reviewed transaction and return the signed bytes to your app.", sends: "Signed bytes" },
      { actor: "Sera API", icon: Server, action: "Broadcast the transaction your backend submits and return its hash.", endpoints: ["POST /transfer/send"] },
    ],
    outcome: "A matching hash means Submitted. The Sera API has no receipt lookup for direct transfers.",
  },
  "set-rate": {
    steps: [
      { actor: "Your app", icon: MonitorSmartphone, action: "Show the exact amounts to sell and receive at the maker’s chosen rate.", sends: "Order terms" },
      { actor: "Maker’s wallet", icon: Wallet, action: "Fund the Vault if needed, then sign the reviewed limit order.", sends: "Signed order" },
      { actor: "Sera orderbook", icon: ChartNoAxesColumnIncreasing, action: "Match the submitted order at the limit price or better when liquidity is available.", endpoints: ["POST /orders"] },
    ],
    outcome: "An order can fill in parts. Read the order and its fills to track what remains open and what has settled.",
  },
  accept: {
    steps: [
      { actor: "Your backend", icon: Link2, action: "Sign a link for the merchant’s wallet and token. Include an amount if the merchant sets one.", sends: "Checkout link" },
      { actor: "Customer’s wallet", icon: Wallet, action: "At your checkout, the customer reviews the payment and signs it.", sends: "Signed payment" },
      { actor: "Sera API", icon: Server, action: "Broadcast a direct transfer or execute the signed swap for a conversion.", endpoints: ["POST /transfer/send", "POST /swap"] },
    ],
    outcome: "A direct transfer yields a submission hash. Mark a conversion paid once verified settlement covers the signed invoice.",
  },
};

export function GuideFlowOverview({ flow }: { flow: GuideFlow }) {
  const { steps, outcome } = routes[flow];
  return (
    <figure className="si-flow-overview">
      <ol role="list" aria-label="Who does what" className="si-flow-actors">
        {steps.map(({ actor, icon, action, sends, endpoints }) => (
          <li key={actor} className="si-flow-actor">
            <span className="si-flow-actor-icon" aria-hidden="true">
              <IconBubble icon={icon} size={40} color="#086747" />
            </span>
            <div>
              <strong>{actor}</strong>
              <p>{action}</p>
              {endpoints && <div className="si-flow-endpoints">
                {endpoints.map(endpoint => <code key={endpoint}>{endpoint}</code>)}
              </div>}
            </div>
            {sends && (
              <span className="si-flow-handoff">
                <span className="si-flow-arrow" aria-hidden="true"><ChevronRight size={12} /></span>
                <span className="sr-only">Passes along </span>
                {sends}
              </span>
            )}
          </li>
        ))}
      </ol>
      <figcaption>{outcome}</figcaption>
    </figure>
  );
}
