import * as cheerio from "cheerio";
import type { Competitor } from "@intelradar/supabase";
import { BaseMonitor, MonitorResult } from "./base-monitor";

interface ParsedJob {
  title: string;
  department: string | null;
  location: string | null;
  url: string;
}

/**
 * JobsMonitor - tracks new job postings from competitors.
 *
 * Scrapes common job board patterns (Greenhouse, Lever, Ashby, Workable)
 * and the competitor's own careers page. New postings generate signals;
 * removed postings are marked inactive.
 */
export class JobsMonitor extends BaseMonitor {
  readonly monitorType = "jobs-monitor";

  private static readonly JOB_BOARD_PATTERNS: {
    pattern: RegExp;
    urlTemplate: (domain: string) => string;
    parser: (html: string, baseUrl: string) => ParsedJob[];
  }[] = [
    {
      // Greenhouse
      pattern: /greenhouse/i,
      urlTemplate: (domain) => `https://boards.greenhouse.io/${domain.replace(/\./g, "")}`,
      parser: (html, baseUrl) => {
        const $ = cheerio.load(html);
        const jobs: ParsedJob[] = [];
        $(".opening").each((_, el) => {
          const titleEl = $(el).find("a");
          const dept = $(el).closest(".department-container").find(".department-name").text().trim();
          const loc = $(el).find(".location").text().trim();
          jobs.push({
            title: titleEl.text().trim(),
            department: dept || null,
            location: loc || null,
            url: new URL(titleEl.attr("href") ?? "", baseUrl).toString(),
          });
        });
        return jobs;
      },
    },
    {
      // Lever
      pattern: /lever/i,
      urlTemplate: (domain) => `https://jobs.lever.co/${domain.replace(/\./g, "")}`,
      parser: (html, baseUrl) => {
        const $ = cheerio.load(html);
        const jobs: ParsedJob[] = [];
        $(".posting").each((_, el) => {
          const titleEl = $(el).find(".posting-title a, h5 a").first();
          const dept = $(el).find(".posting-categories .sort-by-team").text().trim();
          const loc = $(el).find(".posting-categories .sort-by-location").text().trim();
          jobs.push({
            title: titleEl.text().trim(),
            department: dept || null,
            location: loc || null,
            url: new URL(titleEl.attr("href") ?? "", baseUrl).toString(),
          });
        });
        return jobs;
      },
    },
    {
      // Ashby
      pattern: /ashby/i,
      urlTemplate: (domain) => `https://jobs.ashbyhq.com/${domain.replace(/\./g, "")}`,
      parser: (html, baseUrl) => {
        const $ = cheerio.load(html);
        const jobs: ParsedJob[] = [];
        $("[data-testid='job-posting']").each((_, el) => {
          const titleEl = $(el).find("a").first();
          const loc = $(el).find("[data-testid='location']").text().trim();
          jobs.push({
            title: titleEl.text().trim(),
            department: null,
            location: loc || null,
            url: new URL(titleEl.attr("href") ?? "", baseUrl).toString(),
          });
        });
        return jobs;
      },
    },
  ];

  async check(competitor: Competitor): Promise<MonitorResult> {
    const signals: MonitorResult["signals"] = [];
    const errors: MonitorResult["errors"] = [];

    // Try each job board pattern
    let allJobs: ParsedJob[] = [];

    for (const board of JobsMonitor.JOB_BOARD_PATTERNS) {
      try {
        const boardUrl = board.urlTemplate(competitor.domain);
        const response = await fetch(boardUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            Accept: "text/html",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          const html = await response.text();
          const jobs = board.parser(html, boardUrl);
          if (jobs.length > 0) {
            allJobs = jobs;
            break; // found the right board
          }
        }
      } catch {
        // board not found, try next
      }
    }

    // Also try the competitor's own careers page
    if (allJobs.length === 0) {
      const careersPaths = ["/careers", "/jobs", "/join", "/team"];
      for (const path of careersPaths) {
        try {
          const careersUrl = new URL(path, competitor.website_url).toString();
          const response = await fetch(careersUrl, {
            headers: { "User-Agent": "Mozilla/5.0" },
            redirect: "follow",
            signal: AbortSignal.timeout(10000),
          });
          if (response.ok) {
            const html = await response.text();
            const jobs = this.parseGenericCareersPage(html, careersUrl);
            if (jobs.length > 0) {
              allJobs = jobs;
              break;
            }
          }
        } catch {
          // continue
        }
      }
    }

    if (allJobs.length === 0) {
      return { signals, errors };
    }

    // Get existing active job postings
    const { data: existingJobs } = await this.supabase
      .from("job_postings")
      .select("*")
      .eq("competitor_id", competitor.id)
      .eq("is_active", true);

    const existingUrls = new Set((existingJobs ?? []).map((j) => j.url));
    const currentUrls = new Set(allJobs.map((j) => j.url));

    // Find new postings
    const newJobs = allJobs.filter((j) => !existingUrls.has(j.url));

    // Mark removed postings as inactive
    const removedUrls = [...existingUrls].filter((u) => !currentUrls.has(u));
    if (removedUrls.length > 0) {
      await this.supabase
        .from("job_postings")
        .update({ is_active: false })
        .eq("competitor_id", competitor.id)
        .in("url", removedUrls);
    }

    // Update last_seen_at for still-active postings
    const stillActiveUrls = [...existingUrls].filter((u) => currentUrls.has(u));
    if (stillActiveUrls.length > 0) {
      await this.supabase
        .from("job_postings")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("competitor_id", competitor.id)
        .in("url", stillActiveUrls);
    }

    // Insert new postings
    if (newJobs.length > 0) {
      await this.supabase.from("job_postings").insert(
        newJobs.map((j) => ({
          competitor_id: competitor.id,
          workspace_id: this.workspaceId,
          title: j.title,
          department: j.department,
          location: j.location,
          url: j.url,
        }))
      );

      // Analyze hiring patterns
      const departments = this.analyzeDepartments(newJobs);
      const significance = this.calculateSignificance(newJobs.length, departments);

      signals.push(
        this.buildSignal({
          competitor_id: competitor.id,
          type: "job_posting",
          severity: newJobs.length >= 10 ? "high" : newJobs.length >= 5 ? "medium" : "low",
          title: `${competitor.name} posted ${newJobs.length} new job${newJobs.length === 1 ? "" : "s"}`,
          summary: this.buildHiringSummary(competitor.name, newJobs, departments),
          source_url: null,
          source_name: "Jobs Monitor",
          significance_score: significance,
          raw_data: {
            new_jobs: newJobs,
            removed_count: removedUrls.length,
            total_active: currentUrls.size,
            departments,
          },
        })
      );
    }

    return { signals, errors };
  }

  private parseGenericCareersPage(html: string, baseUrl: string): ParsedJob[] {
    const $ = cheerio.load(html);
    const jobs: ParsedJob[] = [];

    // Look for common job listing patterns
    const selectors = [
      'a[href*="job"], a[href*="position"], a[href*="career"]',
      ".job-listing a, .job-post a, .career-listing a",
      'li a[href*="apply"], li a[href*="role"]',
    ];

    for (const selector of selectors) {
      $(selector).each((_, el) => {
        const href = $(el).attr("href");
        const text = $(el).text().trim();
        if (href && text.length > 3 && text.length < 200) {
          jobs.push({
            title: text,
            department: null,
            location: null,
            url: new URL(href, baseUrl).toString(),
          });
        }
      });
      if (jobs.length > 0) break;
    }

    return jobs;
  }

  private analyzeDepartments(jobs: ParsedJob[]): Record<string, number> {
    const deptMap: Record<string, number> = {};
    const keywordDeptMap: Record<string, string> = {
      engineer: "Engineering",
      developer: "Engineering",
      backend: "Engineering",
      frontend: "Engineering",
      fullstack: "Engineering",
      devops: "Engineering",
      sre: "Engineering",
      "machine learning": "AI/ML",
      "data scientist": "AI/ML",
      ai: "AI/ML",
      design: "Design",
      ux: "Design",
      product: "Product",
      marketing: "Marketing",
      growth: "Marketing",
      sales: "Sales",
      account: "Sales",
      support: "Support",
      success: "Support",
      finance: "Finance",
      legal: "Legal",
      hr: "People",
      people: "People",
      recruiter: "People",
    };

    for (const job of jobs) {
      let dept = job.department;
      if (!dept) {
        const titleLower = job.title.toLowerCase();
        for (const [keyword, deptName] of Object.entries(keywordDeptMap)) {
          if (titleLower.includes(keyword)) {
            dept = deptName;
            break;
          }
        }
      }
      dept = dept ?? "Other";
      deptMap[dept] = (deptMap[dept] ?? 0) + 1;
    }
    return deptMap;
  }

  private calculateSignificance(
    newCount: number,
    departments: Record<string, number>
  ): number {
    let score = Math.min(50, newCount * 5);

    // Boost for engineering/AI hiring (strategic signals)
    if (departments["Engineering"]) score += Math.min(20, departments["Engineering"] * 4);
    if (departments["AI/ML"]) score += Math.min(20, departments["AI/ML"] * 8);
    if (departments["Sales"]) score += Math.min(10, departments["Sales"] * 3);

    return Math.min(100, score);
  }

  private buildHiringSummary(
    name: string,
    jobs: ParsedJob[],
    departments: Record<string, number>
  ): string {
    const deptSummary = Object.entries(departments)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 4)
      .map(([dept, count]) => `${dept} (${count})`)
      .join(", ");

    return `${name} has ${jobs.length} new open position${jobs.length === 1 ? "" : "s"}. Hiring focus: ${deptSummary}. This may indicate expansion or new product investment in these areas.`;
  }
}
