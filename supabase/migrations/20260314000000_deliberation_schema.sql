-- The Agora Project — Phase 0 Schema
-- Deliberation Graph storage with state machine support

-- Enum for deliberation status
CREATE TYPE deliberation_status AS ENUM (
  'pending',
  'round_1_formation',
  'round_2_steelman',
  'round_3_critique',
  'round_4_cartographer',
  'round_5_neologism',
  'round_6_convergence',
  'completed',
  'failed'
);

-- Enum for topic categories
CREATE TYPE topic_category AS ENUM (
  'ontological',
  'normative',
  'causal',
  'epistemic',
  'liminal'
);

-- Main deliberations table — the core of Phase 0
CREATE TABLE deliberations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Topic
  topic TEXT NOT NULL,
  topic_category topic_category NOT NULL,
  topic_context TEXT,                       -- 2-3 sentence background
  tension_axes TEXT[],                      -- Core tensions this topic activates

  -- State machine
  status deliberation_status NOT NULL DEFAULT 'pending',
  current_round INTEGER NOT NULL DEFAULT 0, -- 0=not started, 1-6=active
  error_message TEXT,                        -- Populated on failure
  retry_count INTEGER NOT NULL DEFAULT 0,

  -- The Deliberation Graph (built up round by round)
  graph JSONB NOT NULL DEFAULT '{
    "rounds": [],
    "convergence_map": [],
    "residue": {"irreconcilable_tensions": [], "open_questions": [], "framework_limits": []},
    "neologisms": [],
    "quality_flags": []
  }'::jsonb,

  -- Computed scores (updated after each round)
  tension_score FLOAT,                      -- 0.0-1.0, from disagreement distribution
  entropy_scores JSONB DEFAULT '[]'::jsonb, -- Per-round entropy scores

  -- Cost tracking (per user instruction: from deliberation #1)
  cost JSONB NOT NULL DEFAULT '{
    "total_tokens": 0,
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "estimated_cost_usd": 0.0,
    "per_round": []
  }'::jsonb,

  -- Quality
  human_reviewed BOOLEAN NOT NULL DEFAULT false,
  review_score FLOAT,
  quality_flags JSONB DEFAULT '[]'::jsonb,

  -- Metadata
  voices_used TEXT[] NOT NULL DEFAULT '{}',
  models_used TEXT[] NOT NULL DEFAULT '{}',
  cartographer_model TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Neologisms extracted for fast query
CREATE TABLE neologisms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deliberation_id UUID NOT NULL REFERENCES deliberations(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  definition TEXT NOT NULL,
  proposing_voice TEXT NOT NULL,
  tension_id UUID,                          -- References a tension in the residue catalog
  irreconcilability_named TEXT,             -- What irreconcilability this term names
  vote_distribution JSONB,                  -- Per-voice votes
  accepted BOOLEAN,                         -- Majority positive?
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Epistemic moves for training data extraction
CREATE TABLE epistemic_moves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deliberation_id UUID NOT NULL REFERENCES deliberations(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  move_type TEXT NOT NULL,                  -- From the epistemic move taxonomy
  voice TEXT NOT NULL,
  source_node_id UUID,
  target_node_id UUID,
  content_span TEXT NOT NULL,               -- The specific text containing the move
  confidence FLOAT,                         -- 0.0-1.0, auto-assigned
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_deliberations_status ON deliberations(status);
CREATE INDEX idx_deliberations_topic_category ON deliberations(topic_category);
CREATE INDEX idx_deliberations_created_at ON deliberations(created_at DESC);
CREATE INDEX idx_neologisms_deliberation ON neologisms(deliberation_id);
CREATE INDEX idx_neologisms_term ON neologisms(term);
CREATE INDEX idx_epistemic_moves_deliberation ON epistemic_moves(deliberation_id);
CREATE INDEX idx_epistemic_moves_type ON epistemic_moves(move_type);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deliberations_updated_at
  BEFORE UPDATE ON deliberations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
