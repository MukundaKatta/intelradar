import { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Signal, SignalType } from "@intelradar/supabase";
import { askClaudeJson } from "./claude-client";

export interface TrendAnalysis {
  trends: Trend[];
  market_moves: MarketMove[];
  predictions: Prediction[];
  threat_assessment: ThreatAssessment;
}

export interface Trend {
  name: string;
  description: string;
  direction: "accelerating" | "stable" | "decelerating";
  confidence: number; // 0-100
  supporting_signals: string[];
  competitors_involved: string[];
}

export interface MarketMove {
  description: string;
  competitors: string[];
  implication: string;
  urgency: "monitor" | "plan" | "act_now";
}

export interface Prediction {
  prediction: string;
  timeframe: string;
  confidence: number;
  basis: string;
}

export interface ThreatAssessment {
  overall_threat_level: "low" | "moderate" | "elevated" | "high" | "critical";
  summary: string;
  top_threats: { competitor: string; threat: string; severity: string }[];
}

/**
 * TrendAnalyzer - performs strategic trend analysis across all competitors.
 *
 * Identifies patterns, market movements, and emerging threats by
 * analyzing signals over configurable time windows.
 */
export class TrendAnalyzer {
  private supabase: SupabaseClient<Database>;

  constructor(supabase: SupabaseClient<Database>) {
    this.supabase = supabase;
  }

  /**
   * Analyze trends across a time period.
   */
  async analyze(
    workspaceId: string,
    options: { days?: number } = {}
  ): Promise<TrendAnalysis> {
    const days = options.days ?? 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Fetch all signals in the period
    const { data: signals, error: signalsErr } = await this.supabase
      .from("signals")
      .select("*, competitors!inner(name, domain, industry)")
      .eq("workspace_id", workspaceId)
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false });

    if (signalsErr) throw new Error(`Failed to fetch signals: ${signalsErr.message}`);

    // Fetch workspace info
    const { data: workspace } = await this.supabase
      .from("workspaces")
      .select("name")
      .eq("id", workspaceId)
      .single();

    // Build analytics context
    const analytics = this.buildAnalytics(signals as unknown as EnrichedSignal[]);

    // Generate trend analysis via Claude
    const analysis = await askClaudeJson<TrendAnalysis>({
      system: `You are a strategic intelligence analyst for "${workspace?.name ?? "the company"}".
Your role is to identify patterns, trends, and strategic implications from competitive intelligence data.

Be specific and data-driven. Reference actual signals. Assign confidence levels honestly.
Predictions should be grounded in observable evidence, not speculation.`,

      prompt: `Analyze these competitive intelligence signals from the last ${days} days and identify trends, market moves, and threats.

SIGNAL ANALYTICS:
${JSON.stringify(analytics, null, 2)}

RAW SIGNALS (top 50 by significance):
${(signals as unknown as EnrichedSignal[])
  ?.slice(0, 50)
  .map(
    (s) =>
      `- [${s.type}] ${s.competitors?.name}: ${s.title} (severity: ${s.severity}, score: ${s.significance_score})\n  ${s.summary}`
  )
  .join("\n")}

Return JSON:
{
  "trends": [
    {
      "name": "Trend name",
      "description": "What's happening",
      "direction": "accelerating|stable|decelerating",
      "confidence": 0-100,
      "supporting_signals": ["signal title 1", "signal title 2"],
      "competitors_involved": ["Competitor A", "Competitor B"]
    }
  ],
  "market_moves": [
    {
      "description": "What move is happening",
      "competitors": ["name"],
      "implication": "What it means for us",
      "urgency": "monitor|plan|act_now"
    }
  ],
  "predictions": [
    {
      "prediction": "What we predict will happen",
      "timeframe": "e.g., 1-3 months",
      "confidence": 0-100,
      "basis": "Evidence supporting this prediction"
    }
  ],
  "threat_assessment": {
    "overall_threat_level": "low|moderate|elevated|high|critical",
    "summary": "Overall assessment summary",
    "top_threats": [{"competitor": "name", "threat": "description", "severity": "low|medium|high|critical"}]
  }
}`,
      maxTokens: 4096,
    });

    return analysis;
  }

  private buildAnalytics(signals: EnrichedSignal[]): Record<string, unknown> {
    // Signal count by type
    const byType: Record<string, number> = {};
    // Signal count by competitor
    const byCompetitor: Record<string, number> = {};
    // Signal count by severity
    const bySeverity: Record<string, number> = {};
    // Average significance by competitor
    const significanceByCompetitor: Record<string, { total: number; count: number }> = {};
    // Signal velocity (count by week)
    const byWeek: Record<string, number> = {};

    for (const signal of signals ?? []) {
      // By type
      byType[signal.type] = (byType[signal.type] ?? 0) + 1;

      // By competitor
      const compName = signal.competitors?.name ?? "Unknown";
      byCompetitor[compName] = (byCompetitor[compName] ?? 0) + 1;

      // By severity
      bySeverity[signal.severity] = (bySeverity[signal.severity] ?? 0) + 1;

      // Significance tracking
      if (!significanceByCompetitor[compName]) {
        significanceByCompetitor[compName] = { total: 0, count: 0 };
      }
      significanceByCompetitor[compName].total += signal.significance_score;
      significanceByCompetitor[compName].count += 1;

      // Weekly velocity
      const weekKey = this.getWeekKey(new Date(signal.created_at));
      byWeek[weekKey] = (byWeek[weekKey] ?? 0) + 1;
    }

    const avgSignificance: Record<string, number> = {};
    for (const [comp, data] of Object.entries(significanceByCompetitor)) {
      avgSignificance[comp] = Math.round(data.total / data.count);
    }

    return {
      total_signals: signals?.length ?? 0,
      signals_by_type: byType,
      signals_by_competitor: byCompetitor,
      signals_by_severity: bySeverity,
      avg_significance_by_competitor: avgSignificance,
      weekly_velocity: byWeek,
    };
  }

  private getWeekKey(date: Date): string {
    const year = date.getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const weekNum = Math.ceil(((date.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
    return `${year}-W${String(weekNum).padStart(2, "0")}`;
  }
}

type EnrichedSignal = Signal & {
  competitors: { name: string; domain: string; industry: string | null } | null;
};
