import { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Signal, SignalSeverity } from "@intelradar/supabase";
import { askClaudeJson } from "./claude-client";

interface ScoreResult {
  significance_score: number;
  severity: SignalSeverity;
  ai_analysis: string;
  strategic_tags: string[];
}

/**
 * SignalScorer - uses Claude to assess the strategic significance of each signal.
 *
 * Provides:
 * - Numeric significance score (0-100)
 * - Severity classification
 * - Brief strategic analysis
 * - Strategic tags for categorization
 */
export class SignalScorer {
  private supabase: SupabaseClient<Database>;

  constructor(supabase: SupabaseClient<Database>) {
    this.supabase = supabase;
  }

  /**
   * Score a batch of unscored signals.
   */
  async scoreBatch(workspaceId: string, limit = 50): Promise<void> {
    // Get signals that haven't been AI-analyzed
    const { data: signals, error } = await this.supabase
      .from("signals")
      .select("*, competitors!inner(name, industry)")
      .eq("workspace_id", workspaceId)
      .is("ai_analysis", null)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(`Failed to fetch signals: ${error.message}`);
    if (!signals?.length) return;

    // Get workspace context
    const { data: workspace } = await this.supabase
      .from("workspaces")
      .select("name")
      .eq("id", workspaceId)
      .single();

    // Score in batches of 5 to manage API rate limits
    const batchSize = 5;
    for (let i = 0; i < signals.length; i += batchSize) {
      const batch = signals.slice(i, i + batchSize);

      const results = await Promise.allSettled(
        batch.map((signal) =>
          this.scoreSignal(signal as unknown as Signal & { competitors: { name: string; industry: string | null } }, workspace?.name ?? "Our Company")
        )
      );

      for (let j = 0; j < batch.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          await this.supabase
            .from("signals")
            .update({
              significance_score: result.value.significance_score,
              severity: result.value.severity,
              ai_analysis: result.value.ai_analysis,
            })
            .eq("id", batch[j].id);
        } else {
          console.error(`Failed to score signal ${batch[j].id}:`, result.reason);
        }
      }
    }
  }

  /**
   * Score a single signal using Claude.
   */
  async scoreSignal(
    signal: Signal & { competitors: { name: string; industry: string | null } },
    ourCompanyName: string
  ): Promise<ScoreResult> {
    const result = await askClaudeJson<ScoreResult>({
      system: `You are a competitive intelligence analyst working for "${ourCompanyName}".
Your job is to assess the strategic significance of competitive intelligence signals.

Score each signal on a 0-100 scale:
- 0-20: Noise, routine changes with no strategic import
- 21-40: Minor, worth noting but not actionable
- 41-60: Moderate, may require attention
- 61-80: Significant, likely requires strategic response
- 81-100: Critical, immediate attention needed

Classify severity as: "low", "medium", "high", or "critical"

Provide strategic_tags from: ["pricing_threat", "product_competition", "talent_war", "market_expansion", "technology_shift", "brand_risk", "partnership_threat", "fundraising", "downmarket_move", "upmarket_move", "feature_parity", "new_vertical"]`,

      prompt: `Analyze this competitive signal:

Competitor: ${signal.competitors.name} (${signal.competitors.industry ?? "Unknown industry"})
Signal Type: ${signal.type}
Title: ${signal.title}
Summary: ${signal.summary}
Source: ${signal.source_name}
Current Score: ${signal.significance_score}
Raw Data: ${JSON.stringify(signal.raw_data).substring(0, 2000)}

Return JSON with: { "significance_score": number, "severity": string, "ai_analysis": string (2-3 sentences of strategic analysis), "strategic_tags": string[] }`,
      maxTokens: 512,
    });

    // Validate and clamp score
    result.significance_score = Math.min(100, Math.max(0, Math.round(result.significance_score)));

    return result;
  }
}
