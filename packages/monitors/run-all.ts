/**
 * Run all monitors for a workspace. Designed to be invoked via cron or CLI.
 *
 * Usage:
 *   WORKSPACE_ID=xxx tsx packages/monitors/run-all.ts
 */
import { getSupabaseServerClient } from "@intelradar/supabase";
import { WebsiteMonitor } from "./website-monitor";
import { JobsMonitor } from "./jobs-monitor";
import { NewsMonitor } from "./news-monitor";
import { SocialMonitor } from "./social-monitor";
import { ProductMonitor } from "./product-monitor";
import { TechStackMonitor } from "./tech-stack-monitor";

async function main() {
  const workspaceId = process.env.WORKSPACE_ID;
  if (!workspaceId) {
    console.error("WORKSPACE_ID environment variable is required");
    process.exit(1);
  }

  const supabase = getSupabaseServerClient();

  const config = { supabase, workspaceId };

  const monitors = [
    new WebsiteMonitor(config),
    new JobsMonitor(config),
    new NewsMonitor(config),
    new SocialMonitor(config),
    new ProductMonitor(config),
    new TechStackMonitor(config),
  ];

  console.log(`[run-all] Starting ${monitors.length} monitors for workspace ${workspaceId}`);

  const results = await Promise.allSettled(
    monitors.map(async (monitor) => {
      const start = Date.now();
      const result = await monitor.runAll();
      const elapsed = Date.now() - start;
      console.log(
        `[run-all] ${monitor.monitorType} finished in ${elapsed}ms: ${result.signals.length} signals, ${result.errors.length} errors`
      );
      return { monitor: monitor.monitorType, ...result, elapsed };
    })
  );

  const summary = {
    totalSignals: 0,
    totalErrors: 0,
    monitors: [] as Array<{ name: string; signals: number; errors: number; elapsed: number }>,
  };

  for (const result of results) {
    if (result.status === "fulfilled") {
      summary.totalSignals += result.value.signals.length;
      summary.totalErrors += result.value.errors.length;
      summary.monitors.push({
        name: result.value.monitor,
        signals: result.value.signals.length,
        errors: result.value.errors.length,
        elapsed: result.value.elapsed,
      });
    } else {
      console.error("[run-all] Monitor failed:", result.reason);
      summary.totalErrors += 1;
    }
  }

  console.log("[run-all] Complete:", JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("[run-all] Fatal error:", err);
  process.exit(1);
});
