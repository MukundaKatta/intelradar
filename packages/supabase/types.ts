// ─── Core domain types for IntelRadar ───

export type PlanTier = "free" | "pro" | "enterprise";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  plan: PlanTier;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  max_competitors: number;
  max_monitors: number;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  role: "owner" | "admin" | "member" | "viewer";
  invited_email: string | null;
  accepted_at: string | null;
  created_at: string;
}

export interface Competitor {
  id: string;
  workspace_id: string;
  name: string;
  domain: string;
  logo_url: string | null;
  description: string | null;
  website_url: string;
  linkedin_url: string | null;
  twitter_handle: string | null;
  crunchbase_url: string | null;
  industry: string | null;
  employee_count_range: string | null;
  funding_stage: string | null;
  tags: string[];
  monitoring_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type SignalType =
  | "website_change"
  | "pricing_change"
  | "job_posting"
  | "news_mention"
  | "blog_post"
  | "social_media"
  | "product_launch"
  | "feature_update"
  | "tech_stack_change"
  | "leadership_change"
  | "funding_round"
  | "partnership"
  | "acquisition";

export type SignalSeverity = "low" | "medium" | "high" | "critical";

export interface Signal {
  id: string;
  workspace_id: string;
  competitor_id: string;
  type: SignalType;
  severity: SignalSeverity;
  title: string;
  summary: string;
  raw_data: Record<string, unknown>;
  source_url: string | null;
  source_name: string;
  ai_analysis: string | null;
  significance_score: number; // 0-100
  embedding: number[] | null; // pgvector
  is_read: boolean;
  created_at: string;
}

export interface IntelligenceBrief {
  id: string;
  workspace_id: string;
  title: string;
  period_start: string;
  period_end: string;
  executive_summary: string;
  key_findings: BriefFinding[];
  competitor_summaries: CompetitorBriefSummary[];
  strategic_recommendations: string[];
  market_trends: string[];
  raw_markdown: string;
  created_at: string;
}

export interface BriefFinding {
  title: string;
  description: string;
  severity: SignalSeverity;
  competitor_id: string;
  competitor_name: string;
  signal_ids: string[];
}

export interface CompetitorBriefSummary {
  competitor_id: string;
  competitor_name: string;
  signal_count: number;
  top_signals: string[];
  threat_level: "low" | "medium" | "high";
  summary: string;
}

export interface Battlecard {
  id: string;
  workspace_id: string;
  competitor_id: string;
  title: string;
  overview: string;
  strengths: string[];
  weaknesses: string[];
  pricing_comparison: PricingComparison | null;
  key_differentiators: string[];
  common_objections: BattlecardObjection[];
  win_strategies: string[];
  talk_track: string;
  last_updated_signals: string[];
  version: number;
  raw_markdown: string;
  created_at: string;
  updated_at: string;
}

export interface PricingComparison {
  our_plans: PricingPlan[];
  competitor_plans: PricingPlan[];
  analysis: string;
}

export interface PricingPlan {
  name: string;
  price: string;
  billing_period: string;
  features: string[];
}

export interface BattlecardObjection {
  objection: string;
  response: string;
}

export interface AlertRule {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  competitor_ids: string[]; // empty = all competitors
  signal_types: SignalType[];
  min_severity: SignalSeverity;
  min_significance_score: number;
  channels: AlertChannel[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AlertChannel {
  type: "email" | "slack" | "discord" | "webhook";
  config: Record<string, string>;
}

export interface AlertHistory {
  id: string;
  alert_rule_id: string;
  signal_id: string;
  channel_type: string;
  status: "sent" | "failed" | "pending";
  error_message: string | null;
  sent_at: string;
}

export interface PricingSnapshot {
  id: string;
  competitor_id: string;
  workspace_id: string;
  plans: PricingPlan[];
  raw_html: string | null;
  screenshot_url: string | null;
  captured_at: string;
}

export interface JobPosting {
  id: string;
  competitor_id: string;
  workspace_id: string;
  title: string;
  department: string | null;
  location: string | null;
  description: string | null;
  url: string;
  first_seen_at: string;
  last_seen_at: string;
  is_active: boolean;
}

export interface WebsiteSnapshot {
  id: string;
  competitor_id: string;
  workspace_id: string;
  url: string;
  content_hash: string;
  text_content: string;
  diff_from_previous: string | null;
  captured_at: string;
}

// ─── API request/response types ───

export interface CreateCompetitorInput {
  name: string;
  domain: string;
  website_url: string;
  description?: string;
  linkedin_url?: string;
  twitter_handle?: string;
  crunchbase_url?: string;
  industry?: string;
  tags?: string[];
}

export interface SignalFilters {
  competitor_ids?: string[];
  types?: SignalType[];
  severities?: SignalSeverity[];
  min_significance?: number;
  is_read?: boolean;
  from_date?: string;
  to_date?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface DashboardStats {
  total_competitors: number;
  active_signals_today: number;
  critical_signals_week: number;
  briefs_generated: number;
  top_competitor_by_signals: { name: string; count: number } | null;
}
