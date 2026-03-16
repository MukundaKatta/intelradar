import { SupabaseClient } from "@supabase/supabase-js";
import type {
  Database,
  Signal,
  Competitor,
  IntelligenceBrief,
  BriefFinding,
  CompetitorBriefSummary,
} from "@intelradar/supabase";
import { askClaude, askClaudeJson } from "./claude-client";

interface BriefStructure {
  executive_summary: string;
  key_findings: BriefFinding[];
  competitor_summaries: CompetitorBriefSummary[];
  strategic_recommendations: string[];
  market_trends: string[];
}

/**
 * BriefGenerator - creates weekly AI-generated intelligence briefs.
 *
 * Aggregates all signals from the past week, clusters them by competitor
 * and theme, then uses Claude to produce an executive-ready brief.
 */
export class BriefGenerator {
  private supabase: SupabaseClient<Database>;

  constructor(supabase: SupabaseClient<Database>) {
    this.supabase = supabase;
  }

  /**
   * Generate a weekly intelligence brief for a workspace.
   */
  async generate(workspaceId: string): Promise<IntelligenceBrief> {
    const periodEnd = new Date();
    const periodStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Fetch all signals from the period
    const { data: signals, error: signalsError } = await this.supabase
      .from("signals")
      .select("*")
      .eq("workspace_id", workspaceId)
      .gte("created_at", periodStart.toISOString())
      .lte("created_at", periodEnd.toISOString())
      .order("significance_score", { ascending: false });

    if (signalsError) throw new Error(`Failed to fetch signals: ${signalsError.message}`);

    // Fetch competitors
    const { data: competitors, error: competitorsError } = await this.supabase
      .from("competitors")
      .select("*")
      .eq("workspace_id", workspaceId);

    if (competitorsError) throw new Error(`Failed to fetch competitors: ${competitorsError.message}`);

    const competitorMap = new Map((competitors ?? []).map((c) => [c.id, c as Competitor]));

    // Get workspace name
    const { data: workspace } = await this.supabase
      .from("workspaces")
      .select("name")
      .eq("id", workspaceId)
      .single();

    // Group signals by competitor
    const signalsByCompetitor = new Map<string, Signal[]>();
    for (const signal of (signals ?? []) as Signal[]) {
      const existing = signalsByCompetitor.get(signal.competitor_id) ?? [];
      existing.push(signal);
      signalsByCompetitor.set(signal.competitor_id, existing);
    }

    // Build the context for Claude
    const signalContext = this.buildSignalContext(signalsByCompetitor, competitorMap);

    // Generate structured brief
    const briefStructure = await askClaudeJson<BriefStructure>({
      system: `You are a senior competitive intelligence analyst producing a weekly intelligence brief for "${workspace?.name ?? "the company"}".

Your brief should be:
- Executive-ready: clear, concise, actionable
- Data-driven: reference specific signals and evidence
- Strategic: focus on what matters for business decisions
- Forward-looking: identify emerging trends and predict next moves

For competitor_summaries, assess threat_level as "low", "medium", or "high" based on signal volume and severity.
For key_findings, include the competitor_id and competitor_name from the data provided.`,

      prompt: `Generate a weekly intelligence brief for the period ${periodStart.toISOString().split("T")[0]} to ${periodEnd.toISOString().split("T")[0]}.

Here are the competitive signals collected:

${signalContext}

Total signals: ${signals?.length ?? 0}
Competitors monitored: ${competitors?.length ?? 0}

Return JSON matching this structure:
{
  "executive_summary": "2-3 paragraph executive summary",
  "key_findings": [
    {
      "title": "Finding title",
      "description": "Detailed finding",
      "severity": "low|medium|high|critical",
      "competitor_id": "uuid",
      "competitor_name": "Name",
      "signal_ids": ["uuid1", "uuid2"]
    }
  ],
  "competitor_summaries": [
    {
      "competitor_id": "uuid",
      "competitor_name": "Name",
      "signal_count": number,
      "top_signals": ["signal summary 1", "signal summary 2"],
      "threat_level": "low|medium|high",
      "summary": "2-3 sentence competitor summary"
    }
  ],
  "strategic_recommendations": ["Recommendation 1", "Recommendation 2"],
  "market_trends": ["Trend 1", "Trend 2"]
}`,
      maxTokens: 4096,
    });

    // Generate the full markdown version
    const markdown = await this.generateMarkdown(
      briefStructure,
      workspace?.name ?? "Company",
      periodStart,
      periodEnd
    );

    // Construct the title
    const weekNum = this.getWeekNumber(periodEnd);
    const title = `Week ${weekNum} Intelligence Brief — ${periodStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} to ${periodEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

    // Store in database
    const { data: brief, error: insertError } = await this.supabase
      .from("intelligence_briefs")
      .insert({
        workspace_id: workspaceId,
        title,
        period_start: periodStart.toISOString(),
        period_end: periodEnd.toISOString(),
        executive_summary: briefStructure.executive_summary,
        key_findings: briefStructure.key_findings as unknown as IntelligenceBrief["key_findings"],
        competitor_summaries: briefStructure.competitor_summaries as unknown as IntelligenceBrief["competitor_summaries"],
        strategic_recommendations: briefStructure.strategic_recommendations,
        market_trends: briefStructure.market_trends,
        raw_markdown: markdown,
      })
      .select()
      .single();

    if (insertError) throw new Error(`Failed to store brief: ${insertError.message}`);

    return brief as unknown as IntelligenceBrief;
  }

  private buildSignalContext(
    signalsByCompetitor: Map<string, Signal[]>,
    competitorMap: Map<string, Competitor>
  ): string {
    const sections: string[] = [];

    for (const [competitorId, signals] of signalsByCompetitor) {
      const competitor = competitorMap.get(competitorId);
      if (!competitor) continue;

      const signalLines = signals
        .slice(0, 20) // cap per competitor
        .map(
          (s) =>
            `  - [${s.type}] (severity: ${s.severity}, score: ${s.significance_score}) ${s.title}\n    ${s.summary}\n    Source: ${s.source_name} | ID: ${s.id}`
        )
        .join("\n");

      sections.push(
        `## ${competitor.name} (${competitor.domain})\nID: ${competitor.id}\nIndustry: ${competitor.industry ?? "N/A"}\nSignals (${signals.length}):\n${signalLines}`
      );
    }

    return sections.join("\n\n") || "No signals collected this period.";
  }

  private async generateMarkdown(
    structure: BriefStructure,
    companyName: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<string> {
    const markdown = await askClaude({
      system: `You are a technical writer creating a polished intelligence brief document in Markdown format for "${companyName}". Use clear headers, bullet points, and emphasis for key information.`,

      prompt: `Convert this structured intelligence brief into a polished Markdown document:

Period: ${periodStart.toISOString().split("T")[0]} to ${periodEnd.toISOString().split("T")[0]}

${JSON.stringify(structure, null, 2)}

Format it as a professional intelligence brief with:
1. Title and period
2. Executive Summary
3. Key Findings (with severity badges)
4. Competitor-by-Competitor Analysis
5. Strategic Recommendations
6. Market Trends
7. Methodology note`,

      maxTokens: 4096,
    });

    return markdown;
  }

  private getWeekNumber(date: Date): number {
    const start = new Date(date.getFullYear(), 0, 1);
    const diff = date.getTime() - start.getTime();
    return Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
  }
}
