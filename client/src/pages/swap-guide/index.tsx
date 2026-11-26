import { GuideLayout } from "../integrations/GuideLayout";
import { TransactionHistoryGuide } from "../integrations/TransactionHistoryGuide";
import { GuideStart } from "../integrations/GuideStart";
import { useWidgetNetwork } from "../integrations/WidgetNetwork";
import { buildSwapPrompt } from "./content/ai-prompts";
import { useReveal } from "./hooks";
import { BeforeYouStart, HowItWorks } from "./parts/Overview";
import { DocsBanner, Extras } from "./parts/More";
import { GoldenRules, WhenThingsGoWrong } from "./parts/Safety";
import {
  StepGetPermission,
  StepGetPrice,
  StepSend,
  StepSign,
  StepTrack,
} from "./parts/Steps";
import { TestChecklistSection, TestnetThenLive } from "./parts/Launch";
import { TOC_GROUPS } from "./sections";
import { GUIDE_CSS } from "./styles";

export default function SeraSwapGuidePage() {
  const { network } = useWidgetNetwork();
  useReveal();
  return (
    <GuideLayout flow="swap" groups={TOC_GROUPS}>
      <style>{GUIDE_CSS}</style>
      <GuideStart
        flow="swap"
        prompt={buildSwapPrompt(network ?? "sepolia")}
      />
      <HowItWorks />
      <BeforeYouStart />
      <StepGetPrice />
      <StepGetPermission />
      <StepSign />
      <StepSend />
      <StepTrack />
      <TransactionHistoryGuide flow="swap" />
      <GoldenRules />
      <WhenThingsGoWrong />
      <TestnetThenLive />
      <TestChecklistSection />
      <Extras />
      <DocsBanner />
    </GuideLayout>
  );
}
