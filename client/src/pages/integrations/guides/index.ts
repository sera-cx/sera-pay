import { accept } from "./accept";
import { setRate } from "./set-rate";
import { transfer } from "./transfer";
import type { GuideContent } from "./types";

export const guides = {
  transfer,
  "set-rate": setRate,
  accept,
} satisfies Record<string, GuideContent>;
