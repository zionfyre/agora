// The Agora Project — Phase 0 Type Definitions
// Maps directly to the Deliberation Graph schema in the spec

// ── Voice & Model ──────────────────────────────────────────────

export type VoiceName =
  | "falsificationist"
  | "formal_reasoner"
  | "trickster"
  | "aesthetic_reasoner"
  // Tier 1 deferred:
  | "relational_ontologist"
  // Tier 2 voices (PENDING_ACTIVATION):
  | "east_asian_mind"
  | "arab_mind"
  | "south_asian_mind"
  | "latin_american_mind"
  // Future:
  | "phenomenologist"
  | "systems_dynamicist"
  | "power_analyst";

export type ModelTier = "opus" | "sonnet" | "lightweight";

export type RoundNumber = 1 | 2 | 3 | 4 | 5 | 6;

export type RoundType =
  | "formation"
  | "steelman"
  | "critique"
  | "cartographer"
  | "neologism"
  | "convergence";

export const ROUND_CONFIG: Record<
  RoundNumber,
  { type: RoundType; modelTier: ModelTier; scoringTier?: ModelTier }
> = {
  1: { type: "formation", modelTier: "sonnet" },
  2: { type: "steelman", modelTier: "sonnet", scoringTier: "lightweight" },
  3: { type: "critique", modelTier: "sonnet" },
  4: { type: "cartographer", modelTier: "opus" },
  5: { type: "neologism", modelTier: "sonnet" },
  6: { type: "convergence", modelTier: "opus" },
};

// ── Deliberation Status (state machine) ────────────────────────

export type DeliberationStatus =
  | "pending"
  | "round_1_formation"
  | "round_2_steelman"
  | "round_3_critique"
  | "round_4_cartographer"
  | "round_5_neologism"
  | "round_6_convergence"
  | "completed"
  | "failed"
  | "cancelled";

export const STATUS_FOR_ROUND: Record<RoundNumber, DeliberationStatus> = {
  1: "round_1_formation",
  2: "round_2_steelman",
  3: "round_3_critique",
  4: "round_4_cartographer",
  5: "round_5_neologism",
  6: "round_6_convergence",
};

// ── Topic ──────────────────────────────────────────────────────

export type TopicCategory =
  | "ontological"
  | "normative"
  | "causal"
  | "epistemic"
  | "liminal";

export interface Topic {
  statement: string;
  category: TopicCategory;
  context: string;
  tension_axes: string[];
}

// ── Deliberation Graph ─────────────────────────────────────────

export interface DeliberationGraph {
  rounds: Round[];
  convergence_map: ConvergenceSignature[];
  residue: ResidueCatalog;
  neologisms: Neologism[];
  quality_flags: QualityFlag[];
}

export interface Round {
  round_number: RoundNumber;
  round_type: RoundType;
  nodes: Node[];
  epistemic_moves: EpistemicMove[];
  entropy_score: number | null;
}

export interface Node {
  id: string;
  voice: VoiceName;
  content: string;
  node_type: "thesis" | "steelman" | "critique" | "neologism_proposal";
  target_voice: VoiceName | null;
  steelman_score: 1 | 2 | 3 | 4 | 5 | null;
  critique_type: "internal" | "external" | null;
  confidence_markers: ConfidenceMarker[];
  tags: string[];
}

export interface ConfidenceMarker {
  type: "high" | "moderate" | "low" | "uncertain";
  reason: string;
  span: string;
}

// ── Epistemic Moves ────────────────────────────────────────────

export type EpistemicMoveType =
  | "crux_isolation"
  | "scope_reframe"
  | "false_binary_dissolution"
  | "principled_uncertainty"
  | "steelman_construction"
  | "hidden_premise_exposure"
  | "internal_critique"
  | "convergence_recognition"
  | "neologism_proposal"
  | "epistemic_humility_marker"
  | "incommensurability_declaration";

export interface EpistemicMove {
  move_type: EpistemicMoveType;
  source_node: string;
  target_node: string | null;
  voice: VoiceName;
  content_span: string;
  confidence: number;
}

// ── Cartographer Output ────────────────────────────────────────

export type DisagreementType =
  | "empirical"
  | "conceptual"
  | "normative"
  | "epistemic"
  | "ontological"
  | "incommensurable";

export interface DisagreementClassification {
  id: string;
  positions: { voice: VoiceName; position: string }[];
  type: DisagreementType;
  resolution_path: string | null; // What data/definition would resolve it
  irreconcilability_reason: string | null; // If incommensurable
  epistemic_loss: string | null; // What is lost in forced resolution
}

export interface ConvergenceSignature {
  id: string;
  voices: VoiceName[];
  routes: string[]; // How each voice arrived
  shared_conclusion: string;
  significance: string;
}

export interface ROAuthenticity {
  present: boolean;
  assessment: "enacting" | "performing" | "absent";
  evidence: string;
  gap_remains_open: boolean;
}

export interface CartographerOutput {
  disagreements: DisagreementClassification[];
  convergence_signatures: ConvergenceSignature[];
  stealth_consensus: { description: string; voices: VoiceName[] }[];
  framework_limits: { description: string }[];
  ro_authenticity?: ROAuthenticity;
}

// ── Residue & Neologisms ───────────────────────────────────────

export interface ResidueCatalog {
  irreconcilable_tensions: IrreconcilableTension[];
  open_questions: string[];
  framework_limits: { voice: VoiceName; limit_description: string }[];
  ro_authenticity?: ROAuthenticity;
}

export interface IrreconcilableTension {
  tension_id: string;
  description: string;
  voice_a: VoiceName;
  voice_b: VoiceName;
  voice_a_position: string;
  voice_b_position: string;
  irreconcilability_reason: string;
  what_would_resolve_it: string;
  neologism_ids: string[];
}

export interface Neologism {
  id: string;
  term: string;
  definition: string;
  proposing_voice: VoiceName;
  tension_id: string;
  vote_distribution: Record<VoiceName, "yes" | "no" | "partial">;
  refinements: { voice: VoiceName; text: string }[];
}

export interface QualityFlag {
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  round: RoundNumber | null;
}

// ── Cost Tracking ──────────────────────────────────────────────

export interface CostRecord {
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost_usd: number;
  per_round: RoundCost[];
}

export interface RoundCost {
  round: RoundNumber;
  tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost_usd: number;
  model_calls: ModelCallCost[];
}

export interface ModelCallCost {
  model: string;
  voice: VoiceName | "cartographer";
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost_usd: number;
}

// ── Database Row ───────────────────────────────────────────────

export interface DeliberationRow {
  id: string;
  topic: string;
  topic_category: TopicCategory;
  topic_context: string | null;
  tension_axes: string[];
  status: DeliberationStatus;
  current_round: number;
  error_message: string | null;
  retry_count: number;
  graph: DeliberationGraph;
  tension_score: number | null;
  entropy_scores: number[];
  cost: CostRecord;
  human_reviewed: boolean;
  review_score: number | null;
  quality_flags: QualityFlag[];
  voices_used: string[];
  models_used: string[];
  cartographer_model: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
