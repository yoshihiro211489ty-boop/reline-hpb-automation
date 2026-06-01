export type RiskLevel = 'safe' | 'warn' | 'danger';
export type VisitCount = 'first' | 'repeat' | 'unknown';
export type NotifyLevel = 'info' | 'warn' | 'danger' | 'error';
export type TargetId = 'postpartum' | 'deskwork' | 'beauty';

export interface Review {
  id: string;
  starRating: number;
  body: string;
  authorNickname: string;
  postedAt: string;
  hasReply: boolean;
}

export interface ClassifiedReview extends Review {
  riskLevel: RiskLevel;
  reasons: string[];
  keyPhrases: string[];
  estimatedVisitCount: VisitCount;
  summary: string;
}

export interface ReviewDraft extends ClassifiedReview {
  draftText: string;
  generatedAt: string;
}

export interface PostResult {
  reviewId: string;
  status: 'posted' | 'skipped_existing' | 'failed' | 'dry_run';
  screenshotBefore?: string;
  screenshotAfter?: string;
  error?: string;
}

export interface BlogIdea {
  title: string;
  titleCandidates: string[];
  targetId: TargetId;
  mainKeyword: string;
  subKeywords: string[];
  structure: string[];
  toneNote: string;
  uniqueAngle: string;
  seasonalHook: string;
}

export interface BlogDraft {
  idea: BlogIdea;
  content: string;
  charCount: number;
  generatedAt: string;
}

export interface BlogPostResult {
  status: 'posted' | 'failed' | 'dry_run';
  url?: string;
  screenshotAfter?: string;
  error?: string;
}

export interface CompetitorSnapshot {
  name: string;
  hpbUrl: string;
  reviewCount: number;
  avgRating: number | null;
  blogCount: number;
  coupons: { label: string; price: number }[];
  capturedAt: string;
}

export interface RankResult {
  keyword: string;
  rank: number | null;
  capturedAt: string;
}

export interface DailyReport {
  date: string;
  reviewsNew: number;
  reviewsAutoPosted: number;
  reviewsWarn: number;
  reviewsDanger: number;
  blogsPosted: number;
  rankChanges: { keyword: string; prev: number | null; current: number | null }[];
  errors: string[];
}

export interface AgentResult {
  agent: string;
  status: 'ok' | 'warn' | 'error';
  data?: unknown;
  error?: string;
  durationMs: number;
}

// ─── Google Business Profile ───────────────────────────────────────────────

/** Google の星評価文字列 → 数値 */
export const GOOGLE_STAR_MAP: Record<string, number> = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
};

export interface GoogleReview {
  /** Google APIのリソース名 (accounts/.../locations/.../reviews/...) */
  name: string;
  /** レビューID（name の末尾部分） */
  reviewId: string;
  starRating: number;
  body: string;
  authorName: string;
  isAnonymous: boolean;
  postedAt: string;
  hasReply: boolean;
}

export interface GooglePostResult {
  reviewId: string;
  status: 'posted' | 'failed' | 'dry_run' | 'skipped';
  error?: string;
}
