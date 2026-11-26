import type { LucideIcon } from "lucide-react";
import type { ChecklistGroup } from "../../swap-guide/content/checklists";

export interface GuideStep {
  id: string;
  icon: LucideIcon;
  title: string;
  summary: string;
  rules: string[];
  sample?: { title: string; code: string };
  extraSamples?: { title: string; code: string }[];
}

export interface GuideContent {
  setup: string[];
  steps: GuideStep[];
  edgeCases: [string, string][];
  checklist: ChecklistGroup[];
  promptRules: string[];
  production: string;
}
