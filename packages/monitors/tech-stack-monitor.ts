import type { Competitor } from "@intelradar/supabase";
import { BaseMonitor, MonitorResult } from "./base-monitor";

interface TechSignature {
  name: string;
  category: string;
  patterns: {
    headers?: Record<string, RegExp>;
    html?: RegExp[];
    scripts?: RegExp[];
    meta?: { name: RegExp; content?: RegExp }[];
    cookies?: RegExp[];
  };
}

/**
 * TechStackMonitor - detects technology changes in competitor web stacks.
 *
 * Analyzes HTTP headers, HTML source, JavaScript includes, and meta tags
 * to fingerprint the technology stack. Compares against previous snapshots.
 */
export class TechStackMonitor extends BaseMonitor {
  readonly monitorType = "tech-stack-monitor";

  private static readonly SIGNATURES: TechSignature[] = [
    // Frameworks
    { name: "React", category: "Frontend Framework", patterns: { html: [/react/i, /__next/i, /data-reactroot/i], scripts: [/react\.production/i, /react-dom/i] } },
    { name: "Next.js", category: "Frontend Framework", patterns: { html: [/__next/i, /_next\//i], headers: { "x-powered-by": /Next\.js/i } } },
    { name: "Vue.js", category: "Frontend Framework", patterns: { html: [/vue\.js/i, /data-v-[a-f0-9]/i, /__vue/i], scripts: [/vue\.runtime/i, /vue\.global/i] } },
    { name: "Nuxt", category: "Frontend Framework", patterns: { html: [/__nuxt/i, /_nuxt\//i], headers: { "x-powered-by": /Nuxt/i } } },
    { name: "Angular", category: "Frontend Framework", patterns: { html: [/ng-version/i, /ng-app/i], scripts: [/angular/i] } },
    { name: "Svelte", category: "Frontend Framework", patterns: { html: [/svelte/i], scripts: [/svelte/i] } },

    // CMS / Platforms
    { name: "WordPress", category: "CMS", patterns: { html: [/wp-content/i, /wp-includes/i], meta: [{ name: /generator/i, content: /WordPress/i }] } },
    { name: "Webflow", category: "CMS", patterns: { html: [/webflow/i], meta: [{ name: /generator/i, content: /Webflow/i }] } },
    { name: "Shopify", category: "E-commerce", patterns: { html: [/cdn\.shopify\.com/i, /shopify/i], headers: { "x-shopid": /.+/ } } },
    { name: "Squarespace", category: "CMS", patterns: { html: [/squarespace/i], scripts: [/squarespace/i] } },

    // Analytics
    { name: "Google Analytics", category: "Analytics", patterns: { html: [/google-analytics\.com/i, /gtag\//i, /GA-\d+/i, /G-[A-Z0-9]+/i], scripts: [/googletagmanager/i] } },
    { name: "Segment", category: "Analytics", patterns: { scripts: [/segment\.com\/analytics/i, /cdn\.segment\.com/i] } },
    { name: "Mixpanel", category: "Analytics", patterns: { scripts: [/mixpanel/i, /cdn\.mxpnl\.com/i] } },
    { name: "Amplitude", category: "Analytics", patterns: { scripts: [/amplitude\.com/i, /cdn\.amplitude/i] } },
    { name: "Hotjar", category: "Analytics", patterns: { scripts: [/hotjar\.com/i, /static\.hotjar/i] } },
    { name: "PostHog", category: "Analytics", patterns: { scripts: [/posthog/i, /app\.posthog\.com/i] } },

    // Marketing / Support
    { name: "Intercom", category: "Support", patterns: { scripts: [/intercom/i, /widget\.intercom/i] } },
    { name: "Drift", category: "Support", patterns: { scripts: [/drift\.com/i, /js\.driftt\.com/i] } },
    { name: "Zendesk", category: "Support", patterns: { scripts: [/zendesk/i, /zdassets/i] } },
    { name: "HubSpot", category: "Marketing", patterns: { scripts: [/hubspot/i, /hs-scripts/i, /js\.hs-analytics/i] } },
    { name: "Marketo", category: "Marketing", patterns: { scripts: [/marketo/i, /munchkin/i] } },

    // Infrastructure
    { name: "Cloudflare", category: "CDN/Security", patterns: { headers: { server: /cloudflare/i, "cf-ray": /.+/ } } },
    { name: "AWS CloudFront", category: "CDN", patterns: { headers: { "x-amz-cf-id": /.+/, via: /CloudFront/i } } },
    { name: "Vercel", category: "Hosting", patterns: { headers: { server: /Vercel/i, "x-vercel-id": /.+/ } } },
    { name: "Netlify", category: "Hosting", patterns: { headers: { server: /Netlify/i } } },
    { name: "Heroku", category: "Hosting", patterns: { headers: { via: /heroku/i } } },

    // Payments
    { name: "Stripe", category: "Payments", patterns: { scripts: [/stripe\.com/i, /js\.stripe/i] } },
    { name: "Paddle", category: "Payments", patterns: { scripts: [/paddle\.com/i, /cdn\.paddle/i] } },

    // Auth
    { name: "Auth0", category: "Authentication", patterns: { scripts: [/auth0/i, /cdn\.auth0/i] } },
    { name: "Clerk", category: "Authentication", patterns: { scripts: [/clerk/i] } },
  ];

  async check(competitor: Competitor): Promise<MonitorResult> {
    const signals: MonitorResult["signals"] = [];
    const errors: MonitorResult["errors"] = [];

    try {
      const currentStack = await this.detectStack(competitor.website_url);

      // Get previous tech stack snapshot from signals
      const { data: previousSignal } = await this.supabase
        .from("signals")
        .select("raw_data")
        .eq("competitor_id", competitor.id)
        .eq("type", "tech_stack_change")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      const previousStack: Record<string, string[]> =
        (previousSignal?.raw_data as Record<string, unknown>)?.detected_stack as Record<string, string[]> ?? {};

      const previousTechs = new Set(Object.values(previousStack).flat());
      const currentTechs = new Set(Object.values(currentStack).flat());

      const added = [...currentTechs].filter((t) => !previousTechs.has(t));
      const removed = [...previousTechs].filter((t) => !currentTechs.has(t));

      // If this is first scan or no changes, store snapshot only
      if (previousTechs.size === 0 && currentTechs.size > 0) {
        signals.push(
          this.buildSignal({
            competitor_id: competitor.id,
            type: "tech_stack_change",
            severity: "low",
            title: `${competitor.name} tech stack baseline captured`,
            summary: `Detected technologies: ${[...currentTechs].join(", ")}`,
            source_url: competitor.website_url,
            source_name: "Tech Stack Monitor",
            significance_score: 20,
            raw_data: { detected_stack: currentStack, is_baseline: true },
          })
        );
      } else if (added.length > 0 || removed.length > 0) {
        const changeParts: string[] = [];
        if (added.length > 0) changeParts.push(`Added: ${added.join(", ")}`);
        if (removed.length > 0) changeParts.push(`Removed: ${removed.join(", ")}`);

        const severity = this.assessTechChangeSeverity(added, removed);
        const significance = this.assessTechChangeSignificance(added, removed);

        signals.push(
          this.buildSignal({
            competitor_id: competitor.id,
            type: "tech_stack_change",
            severity,
            title: `${competitor.name} changed their tech stack`,
            summary: `Technology changes detected. ${changeParts.join(". ")}. This may indicate a platform migration or new capabilities.`,
            source_url: competitor.website_url,
            source_name: "Tech Stack Monitor",
            significance_score: significance,
            raw_data: {
              detected_stack: currentStack,
              added,
              removed,
              previous_stack: previousStack,
            },
          })
        );
      }
    } catch (err) {
      errors.push({
        competitor_id: competitor.id,
        error: `Tech stack detection: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return { signals, errors };
  }

  private async detectStack(websiteUrl: string): Promise<Record<string, string[]>> {
    const stack: Record<string, string[]> = {};

    const response = await fetch(websiteUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        Accept: "text/html",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const headers = Object.fromEntries(response.headers.entries());
    const html = await response.text();

    for (const sig of TechStackMonitor.SIGNATURES) {
      let detected = false;

      // Check headers
      if (sig.patterns.headers) {
        for (const [headerName, pattern] of Object.entries(sig.patterns.headers)) {
          const headerValue = headers[headerName.toLowerCase()];
          if (headerValue && pattern.test(headerValue)) {
            detected = true;
            break;
          }
        }
      }

      // Check HTML content
      if (!detected && sig.patterns.html) {
        detected = sig.patterns.html.some((pattern) => pattern.test(html));
      }

      // Check script sources
      if (!detected && sig.patterns.scripts) {
        detected = sig.patterns.scripts.some((pattern) => pattern.test(html));
      }

      // Check meta tags
      if (!detected && sig.patterns.meta) {
        for (const metaPattern of sig.patterns.meta) {
          const metaRegex = new RegExp(
            `<meta[^>]*name=["']?${metaPattern.name.source}["']?[^>]*content=["']?([^"'>]+)["']?`,
            "i"
          );
          const match = html.match(metaRegex);
          if (match && (!metaPattern.content || metaPattern.content.test(match[1]))) {
            detected = true;
            break;
          }
        }
      }

      if (detected) {
        if (!stack[sig.category]) stack[sig.category] = [];
        stack[sig.category].push(sig.name);
      }
    }

    return stack;
  }

  private assessTechChangeSeverity(
    added: string[],
    removed: string[]
  ): "low" | "medium" | "high" | "critical" {
    const strategicTechs = ["Stripe", "Paddle", "Auth0", "Clerk", "Intercom"];
    const hasStrategicChange = [...added, ...removed].some((t) => strategicTechs.includes(t));
    if (hasStrategicChange) return "high";
    if (added.length + removed.length >= 3) return "medium";
    return "low";
  }

  private assessTechChangeSignificance(added: string[], removed: string[]): number {
    let score = 30 + (added.length + removed.length) * 10;
    const strategicTechs = ["Stripe", "Paddle", "Auth0", "Clerk"];
    if ([...added, ...removed].some((t) => strategicTechs.includes(t))) score += 20;
    return Math.min(100, score);
  }
}
