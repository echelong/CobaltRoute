/**
 * Auto-Combo barrel export
 */
export {
  calculateScore,
  calculateTierScore,
  scorePool,
  validateWeights,
  DEFAULT_WEIGHTS,
  type ScoringWeights,
  type ScoringFactors,
  type ProviderCandidate,
  type ScoredProvider,
} from "./scoring";
export { getTaskFitness, getTaskTypes } from "./taskFitness";
export { SelfHealingManager, getSelfHealingManager } from "./selfHealing";
export { MODE_PACKS, getModePack, getModePackNames } from "./modePacks";
export { selectProvider, type AutoComboConfig, type SelectionResult } from "./engine";
export {
  selectAdaptiveCandidate,
  recordAdaptiveOutcome,
  getAdaptiveLearningSnapshot,
  getAdaptiveStorePath,
  flushAdaptiveLearningNow,
  resetAdaptiveLearning,
  type AdaptiveRoutingContext,
  type AdaptiveLearningEntry,
  type AdaptiveOutcomeInput,
  type AdaptiveSelection,
} from "./adaptiveRouter";
export {
  runChaosPanel,
  handleChaosChat,
  serializeChaosPart,
  CHAOS_DEFAULTS,
  type ChaosTuning,
  type ChaosPart,
} from "./chaosEngine";
