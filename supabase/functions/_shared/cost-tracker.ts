// The Agora Project — Cost Tracker
// Accumulates per-round costs and updates the deliberation record

import type {
  CostRecord,
  ModelCallCost,
  RoundCost,
  RoundNumber,
} from "./types.ts";

export class CostTracker {
  private currentRound: RoundNumber;
  private modelCalls: ModelCallCost[] = [];

  constructor(round: RoundNumber) {
    this.currentRound = round;
  }

  /** Record a single model call's cost */
  addCall(call: ModelCallCost): void {
    this.modelCalls.push(call);
  }

  /** Build a RoundCost from accumulated calls */
  buildRoundCost(): RoundCost {
    const totals = this.modelCalls.reduce(
      (acc, c) => ({
        tokens: acc.tokens + c.prompt_tokens + c.completion_tokens,
        prompt_tokens: acc.prompt_tokens + c.prompt_tokens,
        completion_tokens: acc.completion_tokens + c.completion_tokens,
        estimated_cost_usd: acc.estimated_cost_usd + c.estimated_cost_usd,
      }),
      { tokens: 0, prompt_tokens: 0, completion_tokens: 0, estimated_cost_usd: 0 }
    );

    return {
      round: this.currentRound,
      ...totals,
      model_calls: [...this.modelCalls],
    };
  }

  /**
   * Merge this round's cost into the existing deliberation cost record.
   * Returns the updated CostRecord to persist.
   */
  mergeInto(existing: CostRecord): CostRecord {
    const roundCost = this.buildRoundCost();

    return {
      total_tokens: existing.total_tokens + roundCost.tokens,
      prompt_tokens: existing.prompt_tokens + roundCost.prompt_tokens,
      completion_tokens:
        existing.completion_tokens + roundCost.completion_tokens,
      estimated_cost_usd:
        existing.estimated_cost_usd + roundCost.estimated_cost_usd,
      per_round: [...existing.per_round, roundCost],
    };
  }
}
