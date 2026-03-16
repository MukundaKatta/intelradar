import * as cheerio from "cheerio";
import type { Competitor } from "@intelradar/supabase";
import { BaseMonitor, MonitorResult } from "./base-monitor";

/**
 * ProductMonitor - tracks product updates, feature releases, and changelogs.
 *
 * Scrapes changelog pages, release notes, and "what's new" sections.
 * Detects patterns across multiple common changelog formats.
 */
export class ProductMonitor extends BaseMonitor {
  readonly monitorType = "product-monitor";

  private static readonly CHANGELOG_PATHS = [
    "/changelog",
    "/whats-new",
    "/releases",
    "/updates",
    "/release-notes",
    "/product-updates",
    "/what-s-new",
  ];

  async check(competitor: Competitor): Promise<MonitorResult> {
    const signals: MonitorResult["signals"] = [];
    const errors: MonitorResult["errors"] = [];

    // Try changelog page scraping
    let foundChangelog = false;
    for (const path of ProductMonitor.CHANGELOG_PATHS) {
      try {
        const url = new URL(path, competitor.website_url).toString();
        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
            Accept: "text/html",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) continue;

        const html = await response.text();
        const entries = this.parseChangelog(html, url);

        if (entries.length > 0) {
          foundChangelog = true;
          const newEntries = await this.filterNewEntries(competitor, entries);

          for (const entry of newEntries) {
            const severity = this.assessProductSeverity(entry);
            signals.push(
              this.buildSignal({
                competitor_id: competitor.id,
                type: entry.isLaunch ? "product_launch" : "feature_update",
                severity,
                title: `${competitor.name}: ${entry.title}`,
                summary: entry.description.substring(0, 500),
                source_url: entry.url ?? url,
                source_name: `${competitor.name} Changelog`,
                significance_score: this.assessProductSignificance(entry),
                raw_data: {
                  changelog_url: url,
                  entry_title: entry.title,
                  entry_date: entry.date,
                  entry_tags: entry.tags,
                  entry_description: entry.description,
                },
              })
            );
          }
          break;
        }
      } catch {
        // path not found
      }
    }

    // Try GitHub releases as fallback
    if (!foundChangelog) {
      try {
        const githubSignals = await this.checkGitHubReleases(competitor);
        signals.push(...githubSignals);
      } catch (err) {
        errors.push({
          competitor_id: competitor.id,
          error: `GitHub releases: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return { signals, errors };
  }

  private parseChangelog(
    html: string,
    baseUrl: string
  ): ChangelogEntry[] {
    const $ = cheerio.load(html);
    const entries: ChangelogEntry[] = [];

    // Strategy 1: <article> or <section> with dates
    $("article, section, [class*='changelog-entry'], [class*='release'], [class*='update-entry']").each(
      (i, el) => {
        if (i >= 15) return false;
        const titleEl = $(el).find("h1, h2, h3").first();
        const title = titleEl.text().trim();
        if (!title || title.length < 3) return;

        const dateEl = $(el).find("time, [class*='date'], [datetime]").first();
        const date = dateEl.attr("datetime") ?? dateEl.text().trim() ?? null;

        const description = $(el).find("p, [class*='body'], [class*='content']").text().trim();
        const link = titleEl.find("a").attr("href") ?? titleEl.closest("a").attr("href") ?? null;

        const tags: string[] = [];
        $(el).find("[class*='tag'], [class*='badge'], [class*='label']").each((_, tagEl) => {
          tags.push($(tagEl).text().trim().toLowerCase());
        });

        entries.push({
          title,
          description: description || title,
          date,
          url: link ? new URL(link, baseUrl).toString() : null,
          tags,
          isLaunch: this.isProductLaunch(title, tags),
        });
      }
    );

    // Strategy 2: date-based headers (h2/h3 with dates)
    if (entries.length === 0) {
      const datePattern = /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}\b/i;

      $("h2, h3").each((i, el) => {
        if (i >= 15) return false;
        const text = $(el).text().trim();
        const dateMatch = text.match(datePattern);
        if (!dateMatch) return;

        // Collect all content until next heading
        let content = "";
        let nextEl = $(el).next();
        while (nextEl.length && !["h2", "h3"].includes(nextEl.prop("tagName")?.toLowerCase() ?? "")) {
          content += nextEl.text().trim() + " ";
          nextEl = nextEl.next();
        }

        const titleClean = text.replace(datePattern, "").trim() || content.substring(0, 80);

        entries.push({
          title: titleClean,
          description: content.trim() || titleClean,
          date: dateMatch[0],
          url: null,
          tags: [],
          isLaunch: this.isProductLaunch(titleClean, []),
        });
      });
    }

    return entries;
  }

  private async filterNewEntries(
    competitor: Competitor,
    entries: ChangelogEntry[]
  ): Promise<ChangelogEntry[]> {
    // Get existing product signals to deduplicate
    const { data: existing } = await this.supabase
      .from("signals")
      .select("title")
      .eq("competitor_id", competitor.id)
      .in("type", ["product_launch", "feature_update"])
      .gte("created_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());

    const existingTitles = new Set(
      (existing ?? []).map((s) => s.title.toLowerCase())
    );

    return entries.filter((e) => {
      const fullTitle = `${competitor.name}: ${e.title}`.toLowerCase();
      return !existingTitles.has(fullTitle);
    });
  }

  private async checkGitHubReleases(competitor: Competitor): Promise<MonitorResult["signals"]> {
    const signals: MonitorResult["signals"] = [];

    // Try to find GitHub org
    const orgGuesses = [
      competitor.domain.split(".")[0],
      competitor.name.toLowerCase().replace(/\s+/g, ""),
      competitor.name.toLowerCase().replace(/\s+/g, "-"),
    ];

    for (const org of orgGuesses) {
      try {
        const response = await fetch(
          `https://api.github.com/orgs/${org}/repos?sort=pushed&per_page=5`,
          {
            headers: { Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(10000),
          }
        );
        if (!response.ok) continue;

        const repos = (await response.json()) as Array<{ full_name: string; name: string }>;
        if (repos.length === 0) continue;

        for (const repo of repos.slice(0, 3)) {
          const releasesRes = await fetch(
            `https://api.github.com/repos/${repo.full_name}/releases?per_page=5`,
            {
              headers: { Accept: "application/vnd.github+json" },
              signal: AbortSignal.timeout(10000),
            }
          );
          if (!releasesRes.ok) continue;

          const releases = (await releasesRes.json()) as Array<{
            id: number;
            tag_name: string;
            name: string;
            body: string;
            html_url: string;
            published_at: string;
            prerelease: boolean;
          }>;

          for (const release of releases) {
            const publishedAt = new Date(release.published_at);
            if (Date.now() - publishedAt.getTime() > 48 * 60 * 60 * 1000) continue;
            if (release.prerelease) continue;

            signals.push(
              this.buildSignal({
                competitor_id: competitor.id,
                type: "feature_update",
                severity: "medium",
                title: `${competitor.name} released ${release.tag_name} (${repo.name})`,
                summary: (release.body ?? "New release published.").substring(0, 500),
                source_url: release.html_url,
                source_name: "GitHub Releases",
                significance_score: 55,
                raw_data: {
                  repo: repo.full_name,
                  tag: release.tag_name,
                  release_name: release.name,
                },
              })
            );
          }
        }
        break; // found the right org
      } catch {
        // org not found
      }
    }

    return signals;
  }

  private isProductLaunch(title: string, tags: string[]): boolean {
    const launchKeywords = ["launch", "introducing", "new product", "announcing", "v1", "1.0"];
    const text = `${title} ${tags.join(" ")}`.toLowerCase();
    return launchKeywords.some((k) => text.includes(k));
  }

  private assessProductSeverity(entry: ChangelogEntry): "low" | "medium" | "high" | "critical" {
    if (entry.isLaunch) return "high";
    const text = `${entry.title} ${entry.description}`.toLowerCase();
    if (text.includes("breaking") || text.includes("major")) return "high";
    if (text.includes("new") || text.includes("feature") || text.includes("improvement")) return "medium";
    return "low";
  }

  private assessProductSignificance(entry: ChangelogEntry): number {
    let score = 40;
    if (entry.isLaunch) score += 30;
    const text = `${entry.title} ${entry.description}`.toLowerCase();
    if (text.includes("ai") || text.includes("machine learning")) score += 15;
    if (text.includes("api") || text.includes("integration")) score += 10;
    if (text.includes("enterprise")) score += 10;
    if (text.includes("pricing") || text.includes("plan")) score += 10;
    return Math.min(100, score);
  }
}

interface ChangelogEntry {
  title: string;
  description: string;
  date: string | null;
  url: string | null;
  tags: string[];
  isLaunch: boolean;
}
