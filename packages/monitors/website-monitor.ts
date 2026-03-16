import * as cheerio from "cheerio";
import * as crypto from "crypto";
import { diffLines, Change } from "diff";
import type { Competitor } from "@intelradar/supabase";
import { BaseMonitor, MonitorResult } from "./base-monitor";

/**
 * WebsiteMonitor - detects changes in competitor websites and pricing pages.
 *
 * For each competitor, it:
 * 1. Fetches the website HTML
 * 2. Extracts meaningful text content
 * 3. Compares against the last snapshot via content hash
 * 4. If changed, computes a diff and creates a signal
 * 5. Stores the new snapshot
 */
export class WebsiteMonitor extends BaseMonitor {
  readonly monitorType = "website-monitor";

  async check(competitor: Competitor): Promise<MonitorResult> {
    const signals: MonitorResult["signals"] = [];
    const errors: MonitorResult["errors"] = [];

    const urlsToCheck = [competitor.website_url];

    // Try to detect pricing page
    const pricingVariants = ["/pricing", "/plans", "/price"];
    for (const path of pricingVariants) {
      try {
        const pricingUrl = new URL(path, competitor.website_url).toString();
        const headRes = await fetch(pricingUrl, { method: "HEAD", redirect: "follow" });
        if (headRes.ok) {
          urlsToCheck.push(pricingUrl);
          break;
        }
      } catch {
        // pricing page not found at this path, continue
      }
    }

    for (const url of urlsToCheck) {
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          errors.push({
            competitor_id: competitor.id,
            error: `HTTP ${response.status} fetching ${url}`,
          });
          continue;
        }

        const html = await response.text();
        const textContent = this.extractText(html);
        const contentHash = crypto.createHash("sha256").update(textContent).digest("hex");

        // Get previous snapshot
        const { data: previousSnapshot } = await this.supabase
          .from("website_snapshots")
          .select("*")
          .eq("competitor_id", competitor.id)
          .eq("url", url)
          .order("captured_at", { ascending: false })
          .limit(1)
          .single();

        const hasChanged = !previousSnapshot || previousSnapshot.content_hash !== contentHash;

        let diffText: string | null = null;
        if (previousSnapshot && hasChanged) {
          const changes: Change[] = diffLines(
            previousSnapshot.text_content,
            textContent
          );
          diffText = changes
            .filter((c) => c.added || c.removed)
            .map((c) => `${c.added ? "+" : "-"} ${c.value.trim()}`)
            .join("\n");
        }

        // Store new snapshot
        await this.supabase.from("website_snapshots").insert({
          competitor_id: competitor.id,
          workspace_id: this.workspaceId,
          url,
          content_hash: contentHash,
          text_content: textContent.substring(0, 50000), // cap storage
          diff_from_previous: diffText,
        });

        if (hasChanged && previousSnapshot) {
          const isPricing = url.includes("pricing") || url.includes("plans") || url.includes("price");
          const diffLength = diffText?.length ?? 0;
          const severity = isPricing
            ? "high"
            : diffLength > 2000
              ? "high"
              : diffLength > 500
                ? "medium"
                : "low";

          const significance = isPricing ? 85 : Math.min(80, 30 + Math.floor(diffLength / 50));

          signals.push(
            this.buildSignal({
              competitor_id: competitor.id,
              type: isPricing ? "pricing_change" : "website_change",
              severity,
              title: isPricing
                ? `${competitor.name} updated their pricing page`
                : `${competitor.name} updated their website`,
              summary: this.summarizeDiff(diffText ?? "", competitor.name),
              source_url: url,
              source_name: "Website Monitor",
              significance_score: significance,
              raw_data: {
                url,
                content_hash: contentHash,
                previous_hash: previousSnapshot.content_hash,
                diff_length: diffLength,
                diff_preview: diffText?.substring(0, 2000),
              },
            })
          );
        }
      } catch (err) {
        errors.push({
          competitor_id: competitor.id,
          error: `Error monitoring ${url}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return { signals, errors };
  }

  /**
   * Extract readable text from HTML, stripping scripts, styles, and nav.
   */
  private extractText(html: string): string {
    const $ = cheerio.load(html);

    // Remove non-content elements
    $("script, style, nav, footer, header, noscript, svg, iframe").remove();

    // Get text from main content areas, falling back to body
    const mainContent =
      $("main").text() || $("article").text() || $('[role="main"]').text() || $("body").text();

    return mainContent
      .replace(/\s+/g, " ")
      .replace(/\n\s*\n/g, "\n")
      .trim();
  }

  /**
   * Build a human-readable summary of the diff.
   */
  private summarizeDiff(diff: string, competitorName: string): string {
    const addedLines = diff.split("\n").filter((l) => l.startsWith("+")).length;
    const removedLines = diff.split("\n").filter((l) => l.startsWith("-")).length;

    if (addedLines === 0 && removedLines === 0) {
      return `Minor formatting changes detected on ${competitorName}'s website.`;
    }

    const parts: string[] = [];
    if (addedLines > 0) parts.push(`${addedLines} section(s) added`);
    if (removedLines > 0) parts.push(`${removedLines} section(s) removed`);

    return `Website changes detected for ${competitorName}: ${parts.join(", ")}. Review the diff for details.`;
  }
}
