import type { Competitor } from "@intelradar/supabase";
import { BaseMonitor, MonitorResult } from "./base-monitor";

interface NewsApiArticle {
  source: { id: string | null; name: string };
  author: string | null;
  title: string;
  description: string | null;
  url: string;
  urlToImage: string | null;
  publishedAt: string;
  content: string | null;
}

interface NewsApiResponse {
  status: string;
  totalResults: number;
  articles: NewsApiArticle[];
}

/**
 * NewsMonitor - tracks press mentions, blog posts, and news articles
 * about competitors using NewsAPI and direct blog scraping.
 */
export class NewsMonitor extends BaseMonitor {
  readonly monitorType = "news-monitor";

  private apiKey: string;

  constructor(config: ConstructorParameters<typeof BaseMonitor>[0] & { newsApiKey?: string }) {
    super(config);
    this.apiKey = config.newsApiKey ?? process.env.NEWS_API_KEY ?? "";
  }

  async check(competitor: Competitor): Promise<MonitorResult> {
    const signals: MonitorResult["signals"] = [];
    const errors: MonitorResult["errors"] = [];

    // Check NewsAPI
    if (this.apiKey) {
      try {
        const newsSignals = await this.checkNewsApi(competitor);
        signals.push(...newsSignals);
      } catch (err) {
        errors.push({
          competitor_id: competitor.id,
          error: `NewsAPI error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Check competitor blog
    try {
      const blogSignals = await this.checkBlog(competitor);
      signals.push(...blogSignals);
    } catch (err) {
      errors.push({
        competitor_id: competitor.id,
        error: `Blog scrape error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return { signals, errors };
  }

  private async checkNewsApi(competitor: Competitor): Promise<MonitorResult["signals"]> {
    const signals: MonitorResult["signals"] = [];

    // Search for competitor by name and domain
    const query = encodeURIComponent(`"${competitor.name}" OR "${competitor.domain}"`);
    const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const url = `https://newsapi.org/v2/everything?q=${query}&from=${fromDate}&sortBy=publishedAt&pageSize=20&language=en`;

    const response = await fetch(url, {
      headers: { "X-Api-Key": this.apiKey },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`NewsAPI returned ${response.status}`);
    }

    const data: NewsApiResponse = await response.json();

    // Get existing signal source_urls to deduplicate
    const { data: existingSignals } = await this.supabase
      .from("signals")
      .select("source_url")
      .eq("competitor_id", competitor.id)
      .eq("type", "news_mention")
      .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    const existingUrls = new Set((existingSignals ?? []).map((s) => s.source_url));

    for (const article of data.articles) {
      if (existingUrls.has(article.url)) continue;

      const severity = this.assessNewsSeverity(article);
      const significance = this.assessNewsSignificance(article, competitor);

      signals.push(
        this.buildSignal({
          competitor_id: competitor.id,
          type: "news_mention",
          severity,
          title: article.title,
          summary:
            article.description ??
            `${competitor.name} was mentioned in ${article.source.name}.`,
          source_url: article.url,
          source_name: article.source.name ?? "News",
          significance_score: significance,
          raw_data: {
            author: article.author,
            published_at: article.publishedAt,
            source_name: article.source.name,
            image_url: article.urlToImage,
            content_preview: article.content?.substring(0, 500),
          },
        })
      );
    }

    return signals;
  }

  private async checkBlog(competitor: Competitor): Promise<MonitorResult["signals"]> {
    const signals: MonitorResult["signals"] = [];
    const blogPaths = ["/blog", "/news", "/updates", "/changelog", "/announcements"];

    for (const path of blogPaths) {
      try {
        const blogUrl = new URL(path, competitor.website_url).toString();
        const response = await fetch(blogUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
            Accept: "text/html",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) continue;

        const html = await response.text();
        const { load } = await import("cheerio");
        const $ = load(html);

        // Look for RSS/Atom feed link
        const feedUrl =
          $('link[type="application/rss+xml"]').attr("href") ??
          $('link[type="application/atom+xml"]').attr("href");

        if (feedUrl) {
          const feedSignals = await this.parseFeed(
            new URL(feedUrl, competitor.website_url).toString(),
            competitor
          );
          signals.push(...feedSignals);
          break;
        }

        // Scrape blog post list
        const posts = this.scrapeBlogPosts($, blogUrl, competitor);
        if (posts.length > 0) {
          // Get existing to deduplicate
          const { data: existing } = await this.supabase
            .from("signals")
            .select("source_url")
            .eq("competitor_id", competitor.id)
            .eq("type", "blog_post")
            .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

          const existingUrls = new Set((existing ?? []).map((s) => s.source_url));

          for (const post of posts) {
            if (!existingUrls.has(post.url)) {
              signals.push(
                this.buildSignal({
                  competitor_id: competitor.id,
                  type: "blog_post",
                  severity: "low",
                  title: `${competitor.name} published: ${post.title}`,
                  summary: post.excerpt ?? `New blog post from ${competitor.name}.`,
                  source_url: post.url,
                  source_name: `${competitor.name} Blog`,
                  significance_score: 40,
                  raw_data: { date: post.date },
                })
              );
            }
          }
          break;
        }
      } catch {
        // path not found, try next
      }
    }

    return signals;
  }

  private async parseFeed(
    feedUrl: string,
    competitor: Competitor
  ): Promise<MonitorResult["signals"]> {
    const signals: MonitorResult["signals"] = [];

    try {
      const response = await fetch(feedUrl, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return signals;

      const xml = await response.text();
      const { load } = await import("cheerio");
      const $ = load(xml, { xmlMode: true });

      // Get existing to deduplicate
      const { data: existing } = await this.supabase
        .from("signals")
        .select("source_url")
        .eq("competitor_id", competitor.id)
        .in("type", ["blog_post", "news_mention"])
        .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

      const existingUrls = new Set((existing ?? []).map((s) => s.source_url));

      // RSS items
      $("item").each((i, el) => {
        if (i >= 10) return false; // limit to 10 most recent
        const title = $(el).find("title").text().trim();
        const link = $(el).find("link").text().trim();
        const description = $(el).find("description").text().trim();
        const pubDate = $(el).find("pubDate").text().trim();

        if (link && !existingUrls.has(link)) {
          // Only include posts from last 48 hours
          const postDate = new Date(pubDate);
          if (Date.now() - postDate.getTime() < 48 * 60 * 60 * 1000) {
            signals.push(
              this.buildSignal({
                competitor_id: competitor.id,
                type: "blog_post",
                severity: "low",
                title: `${competitor.name}: ${title}`,
                summary: description.substring(0, 500) || `New post from ${competitor.name}.`,
                source_url: link,
                source_name: `${competitor.name} Blog`,
                significance_score: 40,
                raw_data: { pub_date: pubDate, feed_url: feedUrl },
              })
            );
          }
        }
      });

      // Atom entries
      $("entry").each((i, el) => {
        if (i >= 10) return false;
        const title = $(el).find("title").text().trim();
        const link = $(el).find('link[rel="alternate"]').attr("href") ?? $(el).find("link").attr("href") ?? "";
        const summary = $(el).find("summary").text().trim();
        const published = $(el).find("published").text().trim() || $(el).find("updated").text().trim();

        if (link && !existingUrls.has(link)) {
          const postDate = new Date(published);
          if (Date.now() - postDate.getTime() < 48 * 60 * 60 * 1000) {
            signals.push(
              this.buildSignal({
                competitor_id: competitor.id,
                type: "blog_post",
                severity: "low",
                title: `${competitor.name}: ${title}`,
                summary: summary.substring(0, 500) || `New post from ${competitor.name}.`,
                source_url: link,
                source_name: `${competitor.name} Blog`,
                significance_score: 40,
                raw_data: { published, feed_url: feedUrl },
              })
            );
          }
        }
      });
    } catch {
      // feed parsing failed
    }

    return signals;
  }

  private scrapeBlogPosts(
    $: cheerio.CheerioAPI,
    baseUrl: string,
    competitor: Competitor
  ): { title: string; url: string; excerpt: string | null; date: string | null }[] {
    const posts: { title: string; url: string; excerpt: string | null; date: string | null }[] = [];

    // Common blog post selectors
    const selectors = [
      "article", ".post", ".blog-post", ".entry",
      '[class*="post-card"]', '[class*="blog-card"]',
      '[class*="article-card"]',
    ];

    for (const selector of selectors) {
      $(selector).each((i, el) => {
        if (i >= 10) return false;
        const titleEl = $(el).find("h2 a, h3 a, .post-title a, .entry-title a").first();
        if (!titleEl.length) return;

        const title = titleEl.text().trim();
        const href = titleEl.attr("href");
        if (!title || !href) return;

        const excerpt = $(el).find("p, .excerpt, .summary").first().text().trim() || null;
        const date = $(el).find("time").attr("datetime") ??
          $(el).find(".date, .post-date, .published").first().text().trim() ?? null;

        posts.push({
          title,
          url: new URL(href, baseUrl).toString(),
          excerpt: excerpt?.substring(0, 300) ?? null,
          date,
        });
      });
      if (posts.length > 0) break;
    }

    return posts;
  }

  private assessNewsSeverity(article: NewsApiArticle): "low" | "medium" | "high" | "critical" {
    const text = `${article.title} ${article.description ?? ""}`.toLowerCase();
    const criticalKeywords = ["acquisition", "acquired", "ipo", "merger", "bankrupt"];
    const highKeywords = ["funding", "raised", "series", "valuation", "partnership", "launch"];
    const mediumKeywords = ["hire", "expansion", "revenue", "growth", "update"];

    if (criticalKeywords.some((k) => text.includes(k))) return "critical";
    if (highKeywords.some((k) => text.includes(k))) return "high";
    if (mediumKeywords.some((k) => text.includes(k))) return "medium";
    return "low";
  }

  private assessNewsSignificance(article: NewsApiArticle, competitor: Competitor): number {
    let score = 40;
    const text = `${article.title} ${article.description ?? ""}`.toLowerCase();

    // Boost for high-profile sources
    const topSources = ["techcrunch", "bloomberg", "reuters", "wsj", "nytimes", "verge", "wired"];
    if (topSources.some((s) => (article.source.name ?? "").toLowerCase().includes(s))) {
      score += 25;
    }

    // Boost for strategic keywords
    const strategicKeywords = ["funding", "acquisition", "launch", "pivot", "layoff", "partnership"];
    for (const keyword of strategicKeywords) {
      if (text.includes(keyword)) score += 10;
    }

    // Boost if competitor name is in the title (primary subject)
    if (article.title.toLowerCase().includes(competitor.name.toLowerCase())) {
      score += 15;
    }

    return Math.min(100, score);
  }
}
