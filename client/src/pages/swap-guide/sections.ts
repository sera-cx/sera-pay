import { Compass, Hammer, Rocket, ShieldCheck, Sparkles } from "lucide-react";
import type { TocGroup } from "./components/TableOfContents";

export type SectionId =
  | "manual"
  | "api-key-signing"
  | "how"
  | "setup"
  | "step1"
  | "step2"
  | "step3"
  | "step4"
  | "step5"
  | "transactions"
  | "rules"
  | "errors"
  | "golive"
  | "test"
  | "ai"
  | "extras";

export interface SectionInfo {
  id: SectionId;
  label: string;
  step?: number;
}

export const SECTIONS: SectionInfo[] = [
  { id: "ai", label: "Let AI build it" },
  { id: "manual", label: "Manual integration" },
  { id: "api-key-signing", label: "When you need an API key" },
  { id: "how", label: "How it works" },
  { id: "setup", label: "Before you start" },
  { id: "step1", label: "Get a price", step: 1 },
  { id: "step2", label: "Get permission", step: 2 },
  { id: "step3", label: "Sign", step: 3 },
  { id: "step4", label: "Send", step: 4 },
  { id: "step5", label: "Track", step: 5 },
  { id: "transactions", label: "Transaction history" },
  { id: "rules", label: "Golden rules" },
  { id: "errors", label: "When things go wrong" },
  { id: "golive", label: "Testnet, then live" },
  { id: "test", label: "Test checklist" },
  { id: "extras", label: "Extras" },
];

export const STEP_COUNT = SECTIONS.filter((s) => s.step).length;
const sections = (...ids: SectionId[]) =>
  SECTIONS.filter(({ id }) => ids.includes(id));

// Groups must list sections in page order so the scroll highlight moves downwards.
export const TOC_GROUPS: TocGroup[] = [
  {
    title: "Get started",
    icon: Sparkles,
    sections: sections("ai", "manual", "api-key-signing"),
  },
  {
    title: "Overview",
    icon: Compass,
    sections: sections("how", "setup"),
  },
  {
    title: `Build in ${STEP_COUNT} steps`,
    icon: Hammer,
    sections: sections("step1", "step2", "step3", "step4", "step5"),
  },
  { title: "Activity", icon: Compass, sections: sections("transactions") },
  {
    title: "Stay safe",
    icon: ShieldCheck,
    sections: sections("rules", "errors"),
  },
  { title: "Launch", icon: Rocket, sections: sections("golive", "test") },
  { title: "More", icon: Sparkles, sections: sections("extras") },
];
