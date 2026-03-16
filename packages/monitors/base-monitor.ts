import { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@intelradar/supabase";
import type { Competitor, Signal, SignalType, SignalSeverity } from "@intelradar/supabase";

export interface MonitorResult {
  signals: Omit<Signal, "id" | "workspace_id" | "created_at" | "embedding" | "is_read">[];
  errors: { competitor_id: string; error: string }[];
}

export interface MonitorConfig {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
}

export abstract class BaseMonitor {
  protected supabase: SupabaseClient<Database>;
  protected workspaceId: string;

  constructor(config: MonitorConfig) {
    this.supabase = config.supabase;
    this.workspaceId = config.workspaceId;
  }

  abstract readonly monitorType: string;

  /**
   * Run the monitor for a single competitor.
   */
  abstract check(competitor: Competitor): Promise<MonitorResult>;

  /**
   * Run the monitor for all active competitors in the workspace.
   */
  async runAll(): Promise<MonitorResult> {
    const { data: competitors, error } = await this.supabase
      .from("competitors")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .eq("monitoring_enabled", true);

    if (error) {
      throw new Error(`Failed to fetch competitors: ${error.message}`);
    }

    const allSignals: MonitorResult["signals"] = [];
    const allErrors: MonitorResult["errors"] = [];

    for (const competitor of competitors ?? []) {
      try {
        const result = await this.check(competitor as Competitor);
        allSignals.push(...result.signals);
        allErrors.push(...result.errors);
      } catch (err) {
        allErrors.push({
          competitor_id: competitor.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Persist signals to database
    if (allSignals.length > 0) {
      const { error: insertError } = await this.supabase
        .from("signals")
        .insert(
          allSignals.map((s) => ({
            ...s,
            workspace_id: this.workspaceId,
          }))
        );

      if (insertError) {
        console.error(`[${this.monitorType}] Failed to insert signals:`, insertError.message);
      }
    }

    console.log(
      `[${this.monitorType}] Completed: ${allSignals.length} signals, ${allErrors.length} errors`
    );

    return { signals: allSignals, errors: allErrors };
  }

  /**
   * Utility: build a signal object with defaults.
   */
  protected buildSignal(params: {
    competitor_id: string;
    type: SignalType;
    severity: SignalSeverity;
    title: string;
    summary: string;
    source_url?: string | null;
    source_name: string;
    significance_score: number;
    raw_data?: Record<string, unknown>;
    ai_analysis?: string | null;
  }): MonitorResult["signals"][number] {
    return {
      competitor_id: params.competitor_id,
      type: params.type,
      severity: params.severity,
      title: params.title,
      summary: params.summary,
      source_url: params.source_url ?? null,
      source_name: params.source_name,
      significance_score: Math.min(100, Math.max(0, params.significance_score)),
      raw_data: params.raw_data ?? {},
      ai_analysis: params.ai_analysis ?? null,
    };
  }
}
