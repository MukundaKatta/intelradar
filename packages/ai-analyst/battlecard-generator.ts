import { SupabaseClient } from "@supabase/supabase-js";
import type {
  Database,
  Signal,
  Competitor,
  Battlecard,
  BattlecardObjection,
  PricingComparison,
} from "@intelradar/supabase";
import { askClaude, askClaudeJson } from "./claude-client";

interface BattlecardStructure {
  overview: string;
  strengths: string[];
  weaknesses: string[];
  pricing_comparison: PricingComparison | null;
  key_differentiators: string[];
  common_objections: BattlecardObjection[];
  win_strategies: string[];
  talk_track: string;
}

/**
 * BattlecardGenerator - creates and updates AI-generated sales battlecards.
 *
 * Synthesizes signal data, website content, and competitive positioning
 * into actionable battlecards for sales teams.
 */
export class BattlecardGenerator {
  private supabase: SupabaseClient<Database>;

  constructor(supabase: SupabaseClient<Database>) {
    this.supabase = supabase;
  }

  /**
   * Generate or update a battlecard for a specific competitor.
   */
  async generate(workspaceId: string, competitorId: string): Promise<Battlecard> {
    // Fetch competitor
    const { data: competitor, error: compError } = await this.supabase
      .from("competitors")
      .select("*")
      .eq("id", competitorId)
      .single();

    if (compError || !competitor) throw new Error(`Competitor not found: ${compError?.message}`);

    // Fetch workspace
    const { data: workspace } = await this.supabase
      .from("workspaces")
      .select("name")
      .eq("id", workspaceId)
      .single();

    // Fetch recent signals (last 30 days)
    const { data: signals } = await this.supabase
      .from("signals")
      .select("*")
      .eq("competitor_id", competitorId)
      .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order("significance_score", { ascending: false })
      .limit(50);

    // Fetch latest pricing snapshot
    const { data: pricingSnapshot } = await this.supabase
      .from("pricing_snapshots")
      .select("*")
      .eq("competitor_id", competitorId)
      .order("captured_at", { ascending: false })
      .limit(1)
      .single();

    // Fetch job postings for hiring insight
    const { data: activeJobs } = await this.supabase
      .from("job_postings")
      .select("*")
      .eq("competitor_id", competitorId)
      .eq("is_active", true);

    // Check for existing battlecard to update
    const { data: existingBattlecard } = await this.supabase
      .from("battlecards")
      .select("*")
      .eq("competitor_id", competitorId)
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    const comp = competitor as Competitor;
    const signalList = (signals ?? []) as Signal[];

    // Build context
    const context = this.buildContext(
      comp,
      signalList,
      pricingSnapshot?.plans as unknown as PricingComparison["competitor_plans"] | null,
      activeJobs?.length ?? 0
    );

    // Generate battlecard structure via Claude
    const structure = await askClaudeJson<BattlecardStructure>({
      system: `You are a competitive intelligence analyst creating a sales battlecard for "${workspace?.name ?? "our company"}" to use against "${comp.name}".

The battlecard should be practical and action-oriented for sales reps:
- Focus on what helps close deals
- Provide specific talk tracks and objection handling
- Be honest about competitor strengths (credibility matters)
- Emphasize differentiation and value propositions
- Include concrete pricing and feature comparisons where possible`,

      prompt: `Create a comprehensive sales battlecard based on this intelligence:

${context}

Return JSON:
{
  "overview": "2-3 sentence positioning overview of the competitor",
  "strengths": ["Their genuine strength 1", "Their genuine strength 2"],
  "weaknesses": ["Their weakness 1", "Their weakness 2"],
  "pricing_comparison": {
    "our_plans": [{"name": "Plan", "price": "$X/mo", "billing_period": "monthly", "features": ["feature1"]}],
    "competitor_plans": [{"name": "Plan", "price": "$X/mo", "billing_period": "monthly", "features": ["feature1"]}],
    "analysis": "Pricing comparison analysis"
  },
  "key_differentiators": ["Our differentiator 1", "Our differentiator 2"],
  "common_objections": [
    {"objection": "Customer objection about choosing them over us", "response": "How to respond"}
  ],
  "win_strategies": ["Strategy 1 to win against this competitor", "Strategy 2"],
  "talk_track": "A conversational script for sales calls when this competitor comes up..."
}

If pricing data is unavailable, set pricing_comparison to null.`,
      maxTokens: 4096,
    });

    // Generate markdown version
    const markdown = await this.generateMarkdown(comp, structure, workspace?.name ?? "Our Company");

    const version = existingBattlecard ? (existingBattlecard as Battlecard).version + 1 : 1;
    const signalIds = signalList.slice(0, 20).map((s) => s.id);

    if (existingBattlecard) {
      // Update existing battlecard
      const { data: updated, error: updateError } = await this.supabase
        .from("battlecards")
        .update({
          overview: structure.overview,
          strengths: structure.strengths,
          weaknesses: structure.weaknesses,
          pricing_comparison: structure.pricing_comparison as unknown as Battlecard["pricing_comparison"],
          key_differentiators: structure.key_differentiators,
          common_objections: structure.common_objections as unknown as Battlecard["common_objections"],
          win_strategies: structure.win_strategies,
          talk_track: structure.talk_track,
          last_updated_signals: signalIds,
          version,
          raw_markdown: markdown,
        })
        .eq("id", existingBattlecard.id)
        .select()
        .single();

      if (updateError) throw new Error(`Failed to update battlecard: ${updateError.message}`);
      return updated as unknown as Battlecard;
    } else {
      // Create new battlecard
      const { data: created, error: createError } = await this.supabase
        .from("battlecards")
        .insert({
          workspace_id: workspaceId,
          competitor_id: competitorId,
          title: `${comp.name} Battlecard`,
          overview: structure.overview,
          strengths: structure.strengths,
          weaknesses: structure.weaknesses,
          pricing_comparison: structure.pricing_comparison as unknown as Battlecard["pricing_comparison"],
          key_differentiators: structure.key_differentiators,
          common_objections: structure.common_objections as unknown as Battlecard["common_objections"],
          win_strategies: structure.win_strategies,
          talk_track: structure.talk_track,
          last_updated_signals: signalIds,
          version: 1,
          raw_markdown: markdown,
        })
        .select()
        .single();

      if (createError) throw new Error(`Failed to create battlecard: ${createError.message}`);
      return created as unknown as Battlecard;
    }
  }

  private buildContext(
    competitor: Competitor,
    signals: Signal[],
    pricingPlans: PricingComparison["competitor_plans"] | null,
    activeJobCount: number
  ): string {
    const sections: string[] = [];

    sections.push(`COMPETITOR PROFILE:
Name: ${competitor.name}
Domain: ${competitor.domain}
Industry: ${competitor.industry ?? "Unknown"}
Description: ${competitor.description ?? "N/A"}
Employee Range: ${competitor.employee_count_range ?? "Unknown"}
Funding Stage: ${competitor.funding_stage ?? "Unknown"}
LinkedIn: ${competitor.linkedin_url ?? "N/A"}
Twitter: ${competitor.twitter_handle ?? "N/A"}`);

    if (pricingPlans && Array.isArray(pricingPlans) && pricingPlans.length > 0) {
      sections.push(`PRICING DATA:\n${JSON.stringify(pricingPlans, null, 2)}`);
    }

    sections.push(`ACTIVE JOB POSTINGS: ${activeJobCount}`);

    if (signals.length > 0) {
      const signalSummary = signals
        .slice(0, 25)
        .map((s) => `- [${s.type}, ${s.severity}, score:${s.significance_score}] ${s.title}: ${s.summary}`)
        .join("\n");
      sections.push(`RECENT INTELLIGENCE SIGNALS (last 30 days):\n${signalSummary}`);
    }

    return sections.join("\n\n");
  }

  private async generateMarkdown(
    competitor: Competitor,
    structure: BattlecardStructure,
    ourName: string
  ): Promise<string> {
    return askClaude({
      system: "You are a technical writer creating a professional sales battlecard in Markdown format.",
      prompt: `Convert this battlecard data into a clean, scannable Markdown document for "${ourName}" vs "${competitor.name}":

${JSON.stringify(structure, null, 2)}

Format with:
- Clear section headers with emojis for quick scanning
- Strengths/weaknesses as checklists
- Objection handling as Q&A pairs
- Talk track in a highlighted block
- "Last updated" timestamp at the bottom`,
      maxTokens: 3000,
    });
  }
}
