import type { Competitor } from "@intelradar/supabase";
import { BaseMonitor, MonitorResult } from "./base-monitor";

interface Tweet {
  id: string;
  text: string;
  created_at: string;
  public_metrics: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
    impression_count?: number;
  };
  author_id: string;
}

interface TwitterSearchResponse {
  data?: Tweet[];
  meta?: {
    newest_id: string;
    oldest_id: string;
    result_count: number;
  };
}

interface TwitterUserResponse {
  data?: {
    id: string;
    name: string;
    username: string;
    public_metrics: {
      followers_count: number;
      following_count: number;
      tweet_count: number;
    };
  };
}

/**
 * SocialMonitor - monitors competitor activity on social media platforms.
 *
 * Currently supports Twitter/X via the v2 API. Tracks:
 * - Posts from competitor accounts
 * - Mentions of competitor in public discourse
 * - Engagement metrics and viral content
 */
export class SocialMonitor extends BaseMonitor {
  readonly monitorType = "social-monitor";

  private bearerToken: string;

  constructor(config: ConstructorParameters<typeof BaseMonitor>[0] & { twitterBearerToken?: string }) {
    super(config);
    this.bearerToken = config.twitterBearerToken ?? process.env.TWITTER_BEARER_TOKEN ?? "";
  }

  async check(competitor: Competitor): Promise<MonitorResult> {
    const signals: MonitorResult["signals"] = [];
    const errors: MonitorResult["errors"] = [];

    if (!this.bearerToken) {
      return { signals, errors: [{ competitor_id: competitor.id, error: "No Twitter bearer token configured" }] };
    }

    if (!competitor.twitter_handle) {
      return { signals, errors };
    }

    const handle = competitor.twitter_handle.replace("@", "");

    // Check competitor's own tweets
    try {
      const tweetSignals = await this.checkCompetitorTweets(competitor, handle);
      signals.push(...tweetSignals);
    } catch (err) {
      errors.push({
        competitor_id: competitor.id,
        error: `Twitter timeline error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Check mentions of competitor
    try {
      const mentionSignals = await this.checkMentions(competitor, handle);
      signals.push(...mentionSignals);
    } catch (err) {
      errors.push({
        competitor_id: competitor.id,
        error: `Twitter mentions error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return { signals, errors };
  }

  private async twitterGet<T>(endpoint: string): Promise<T> {
    const response = await fetch(`https://api.twitter.com/2${endpoint}`, {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Twitter API ${response.status}: ${errorBody}`);
    }

    return response.json() as Promise<T>;
  }

  private async checkCompetitorTweets(
    competitor: Competitor,
    handle: string
  ): Promise<MonitorResult["signals"]> {
    const signals: MonitorResult["signals"] = [];

    // Get user ID from handle
    const userRes = await this.twitterGet<TwitterUserResponse>(
      `/users/by/username/${handle}?user.fields=public_metrics`
    );
    if (!userRes.data) return signals;

    const userId = userRes.data.id;
    const sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Get recent tweets
    const tweetsRes = await this.twitterGet<TwitterSearchResponse>(
      `/users/${userId}/tweets?max_results=20&start_time=${sinceDate}&tweet.fields=created_at,public_metrics`
    );

    if (!tweetsRes.data?.length) return signals;

    // Get existing to deduplicate
    const { data: existing } = await this.supabase
      .from("signals")
      .select("raw_data")
      .eq("competitor_id", competitor.id)
      .eq("type", "social_media")
      .gte("created_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());

    const existingTweetIds = new Set(
      (existing ?? []).map((s) => (s.raw_data as Record<string, unknown>)?.tweet_id as string)
    );

    for (const tweet of tweetsRes.data) {
      if (existingTweetIds.has(tweet.id)) continue;

      const engagement = this.calculateEngagement(tweet);
      const isAnnouncement = this.detectAnnouncement(tweet.text);

      // Only create signals for noteworthy tweets
      if (engagement.score < 30 && !isAnnouncement) continue;

      signals.push(
        this.buildSignal({
          competitor_id: competitor.id,
          type: "social_media",
          severity: isAnnouncement ? "medium" : engagement.score >= 70 ? "medium" : "low",
          title: isAnnouncement
            ? `${competitor.name} announcement on X`
            : `${competitor.name} viral post on X (${engagement.label})`,
          summary: tweet.text.substring(0, 500),
          source_url: `https://x.com/${handle}/status/${tweet.id}`,
          source_name: "X (Twitter)",
          significance_score: Math.max(engagement.score, isAnnouncement ? 55 : 0),
          raw_data: {
            tweet_id: tweet.id,
            text: tweet.text,
            metrics: tweet.public_metrics,
            engagement_score: engagement.score,
            is_announcement: isAnnouncement,
            created_at: tweet.created_at,
          },
        })
      );
    }

    return signals;
  }

  private async checkMentions(
    competitor: Competitor,
    handle: string
  ): Promise<MonitorResult["signals"]> {
    const signals: MonitorResult["signals"] = [];
    const sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Search for mentions (excluding retweets from the competitor)
    const query = encodeURIComponent(
      `"${competitor.name}" -from:${handle} -is:retweet lang:en`
    );

    const searchRes = await this.twitterGet<TwitterSearchResponse>(
      `/tweets/search/recent?query=${query}&max_results=20&start_time=${sinceDate}&tweet.fields=created_at,public_metrics,author_id`
    );

    if (!searchRes.data?.length) return signals;

    // Only surface high-engagement mentions
    const viralMentions = searchRes.data.filter((tweet) => {
      const engagement = this.calculateEngagement(tweet);
      return engagement.score >= 50;
    });

    if (viralMentions.length > 0) {
      const topMention = viralMentions.sort(
        (a, b) => this.calculateEngagement(b).score - this.calculateEngagement(a).score
      )[0];

      signals.push(
        this.buildSignal({
          competitor_id: competitor.id,
          type: "social_media",
          severity: "low",
          title: `${competitor.name} trending in ${viralMentions.length} high-engagement mentions on X`,
          summary: `Top mention: "${topMention.text.substring(0, 300)}" — ${viralMentions.length} total viral mentions in the last 24h.`,
          source_url: `https://x.com/search?q=${encodeURIComponent(competitor.name)}`,
          source_name: "X (Twitter) Mentions",
          significance_score: Math.min(75, 35 + viralMentions.length * 5),
          raw_data: {
            mention_count: viralMentions.length,
            top_mention: {
              tweet_id: topMention.id,
              text: topMention.text,
              metrics: topMention.public_metrics,
            },
          },
        })
      );
    }

    return signals;
  }

  private calculateEngagement(tweet: Tweet): { score: number; label: string } {
    const m = tweet.public_metrics;
    const total = m.retweet_count + m.reply_count + m.like_count + m.quote_count;

    let score = 0;
    if (total >= 1000) score = 90;
    else if (total >= 500) score = 75;
    else if (total >= 100) score = 60;
    else if (total >= 50) score = 45;
    else if (total >= 20) score = 30;
    else score = 15;

    const label =
      total >= 1000
        ? "viral"
        : total >= 100
          ? "high engagement"
          : total >= 20
            ? "moderate engagement"
            : "low engagement";

    return { score, label };
  }

  private detectAnnouncement(text: string): boolean {
    const announcementKeywords = [
      "announcing", "we're launching", "introducing", "now available",
      "we just shipped", "big news", "excited to share", "new feature",
      "just launched", "we've released", "now live", "rolling out",
    ];
    const textLower = text.toLowerCase();
    return announcementKeywords.some((k) => textLower.includes(k));
  }
}
