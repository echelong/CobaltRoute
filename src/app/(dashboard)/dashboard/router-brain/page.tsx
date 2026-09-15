import RouterBrainClient from "./RouterBrainClient";
import CodingFeedbackPanel from "./CodingFeedbackPanel";
import FreeQuotaIntelligencePanel from "./FreeQuotaIntelligencePanel";
import MultiModelRacePanel from "./MultiModelRacePanel";
import FreeModelDiscoveryPanel from "./FreeModelDiscoveryPanel";
import ProtocolCompatibilityPanel from "./ProtocolCompatibilityPanel";
import HybridLocalCloudPanel from "./HybridLocalCloudPanel";

export const dynamic = "force-dynamic";

export default function RouterBrainPage() {
  return (
    <>
      <RouterBrainClient />
      <CodingFeedbackPanel />
      <FreeQuotaIntelligencePanel />
      <MultiModelRacePanel />
      <FreeModelDiscoveryPanel />
      <ProtocolCompatibilityPanel />
      <HybridLocalCloudPanel />
    </>
  );
}
