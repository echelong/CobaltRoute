import RouterBrainClient from "./RouterBrainClient";
import CodingFeedbackPanel from "./CodingFeedbackPanel";
import FreeQuotaIntelligencePanel from "./FreeQuotaIntelligencePanel";
import MultiModelRacePanel from "./MultiModelRacePanel";

export const dynamic = "force-dynamic";

export default function RouterBrainPage() {
  return (
    <>
      <RouterBrainClient />
      <CodingFeedbackPanel />
      <FreeQuotaIntelligencePanel />
      <MultiModelRacePanel />
    </>
  );
}
