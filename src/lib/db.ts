import { DatabaseSync, StatementSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import type { Review, ReviewDraft, PostResult, BlogDraft, BlogPostResult, CompetitorSnapshot, RankResult, GoogleReview, GooglePostResult } from '../types/index.js';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'state.db');
export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    star_rating INTEGER NOT NULL,
    body TEXT NOT NULL,
    author_nickname TEXT NOT NULL,
    posted_at TEXT NOT NULL,
    has_reply INTEGER NOT NULL DEFAULT 0,
    captured_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS review_drafts (
    review_id TEXT PRIMARY KEY,
    risk_level TEXT NOT NULL,
    reasons TEXT NOT NULL,
    key_phrases TEXT NOT NULL,
    estimated_visit_count TEXT NOT NULL,
    summary TEXT NOT NULL,
    draft_text TEXT NOT NULL,
    generated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS review_posts (
    review_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    screenshot_before TEXT,
    screenshot_after TEXT,
    error TEXT,
    posted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blog_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    target_id TEXT NOT NULL,
    main_keyword TEXT NOT NULL,
    content TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    generated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS blog_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER,
    status TEXT NOT NULL,
    url TEXT,
    screenshot_after TEXT,
    error TEXT,
    posted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS competitor_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    hpb_url TEXT NOT NULL,
    review_count INTEGER NOT NULL,
    avg_rating REAL,
    blog_count INTEGER NOT NULL,
    coupons TEXT NOT NULL,
    captured_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rank_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    rank INTEGER,
    captured_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS google_reviews (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    star_rating INTEGER NOT NULL,
    body TEXT NOT NULL,
    author_name TEXT NOT NULL,
    is_anonymous INTEGER NOT NULL DEFAULT 0,
    posted_at TEXT NOT NULL,
    has_reply INTEGER NOT NULL DEFAULT 0,
    captured_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS google_review_drafts (
    review_id TEXT PRIMARY KEY,
    risk_level TEXT NOT NULL,
    reasons TEXT NOT NULL,
    key_phrases TEXT NOT NULL,
    estimated_visit_count TEXT NOT NULL,
    summary TEXT NOT NULL,
    draft_text TEXT NOT NULL,
    generated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS google_review_posts (
    review_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    error TEXT,
    posted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    agent TEXT NOT NULL,
    event TEXT NOT NULL,
    review_id TEXT,
    blog_id INTEGER,
    draft_text TEXT,
    posted_text TEXT,
    screenshot_paths TEXT,
    claude_input_tokens INTEGER,
    claude_output_tokens INTEGER,
    status TEXT NOT NULL,
    error TEXT
  );
`);

export const reviewRepo = {
  upsert(review: Review): void {
    db.prepare(`
      INSERT INTO reviews (id, star_rating, body, author_nickname, posted_at, has_reply)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET has_reply = excluded.has_reply
    `).run(review.id, review.starRating, review.body, review.authorNickname, review.postedAt, review.hasReply ? 1 : 0);
  },
  seenIds(): Set<string> {
    const rows = db.prepare('SELECT id FROM reviews').all() as { id: string }[];
    return new Set(rows.map(r => r.id));
  },
  isReplied(id: string): boolean {
    const row = db.prepare('SELECT status FROM review_posts WHERE review_id = ?').get(id) as { status: string } | undefined;
    return row?.status === 'posted';
  },
  saveDraft(draft: ReviewDraft): void {
    db.prepare(`
      INSERT OR REPLACE INTO review_drafts
        (review_id, risk_level, reasons, key_phrases, estimated_visit_count, summary, draft_text, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      draft.id,
      draft.riskLevel,
      JSON.stringify(draft.reasons),
      JSON.stringify(draft.keyPhrases),
      draft.estimatedVisitCount,
      draft.summary,
      draft.draftText,
      draft.generatedAt,
    );
  },
  savePostResult(result: PostResult): void {
    db.prepare(`
      INSERT OR REPLACE INTO review_posts
        (review_id, status, screenshot_before, screenshot_after, error)
      VALUES (?, ?, ?, ?, ?)
    `).run(result.reviewId, result.status, result.screenshotBefore ?? null, result.screenshotAfter ?? null, result.error ?? null);
  },
  pendingWarnDrafts(): ReviewDraft[] {
    const rows = db.prepare(`
      SELECT r.id, r.star_rating, r.body, r.author_nickname, r.posted_at, r.has_reply,
             d.risk_level, d.reasons, d.key_phrases, d.estimated_visit_count, d.summary, d.draft_text, d.generated_at
      FROM review_drafts d
      JOIN reviews r ON r.id = d.review_id
      WHERE d.risk_level = 'warn'
        AND d.review_id NOT IN (SELECT review_id FROM review_posts WHERE status = 'posted')
    `).all() as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r.id as string,
      starRating: r.star_rating as number,
      body: r.body as string,
      authorNickname: r.author_nickname as string,
      postedAt: r.posted_at as string,
      hasReply: Boolean(r.has_reply),
      riskLevel: r.risk_level as 'warn',
      reasons: JSON.parse(r.reasons as string),
      keyPhrases: JSON.parse(r.key_phrases as string),
      estimatedVisitCount: r.estimated_visit_count as 'first' | 'repeat' | 'unknown',
      summary: r.summary as string,
      draftText: r.draft_text as string,
      generatedAt: r.generated_at as string,
    }));
  },
};

export const blogRepo = {
  recentTitles(days = 90): string[] {
    const rows = db.prepare(`
      SELECT title FROM blog_drafts
      WHERE generated_at >= datetime('now', '-${days} days')
      ORDER BY generated_at DESC
    `).all() as { title: string }[];
    return rows.map(r => r.title);
  },
  saveDraft(draft: BlogDraft): number {
    const result = db.prepare(`
      INSERT INTO blog_drafts (title, target_id, main_keyword, content, char_count, generated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(draft.idea.title, draft.idea.targetId, draft.idea.mainKeyword, draft.content, draft.charCount, draft.generatedAt);
    return Number(result.lastInsertRowid);
  },
  savePostResult(draftId: number, result: BlogPostResult): void {
    db.prepare(`
      INSERT INTO blog_posts (draft_id, status, url, screenshot_after, error)
      VALUES (?, ?, ?, ?, ?)
    `).run(draftId, result.status, result.url ?? null, result.screenshotAfter ?? null, result.error ?? null);
  },
  todayPosted(): boolean {
    const row = db.prepare(`
      SELECT id FROM blog_posts
      WHERE status = 'posted' AND posted_at >= datetime('now', 'start of day')
    `).get();
    return Boolean(row);
  },
};

export const competitorRepo = {
  save(snapshots: CompetitorSnapshot[]): void {
    for (const s of snapshots) {
      db.prepare(`
        INSERT INTO competitor_snapshots (name, hpb_url, review_count, avg_rating, blog_count, coupons, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(s.name, s.hpbUrl, s.reviewCount, s.avgRating ?? null, s.blogCount, JSON.stringify(s.coupons), s.capturedAt);
    }
  },
  latest(): CompetitorSnapshot[] {
    const rows = db.prepare(`
      SELECT * FROM competitor_snapshots
      WHERE captured_at >= datetime('now', '-8 days')
      ORDER BY captured_at DESC
    `).all() as Array<Record<string, unknown>>;
    return rows.map(r => ({
      name: r.name as string,
      hpbUrl: r.hpb_url as string,
      reviewCount: r.review_count as number,
      avgRating: r.avg_rating as number | null,
      blogCount: r.blog_count as number,
      coupons: JSON.parse(r.coupons as string),
      capturedAt: r.captured_at as string,
    }));
  },
};

export const rankRepo = {
  save(results: RankResult[]): void {
    for (const r of results) {
      db.prepare('INSERT INTO rank_results (keyword, rank, captured_at) VALUES (?, ?, ?)').run(r.keyword, r.rank ?? null, r.capturedAt);
    }
  },
  history(keyword: string, weeks = 4): RankResult[] {
    const rows = db.prepare(`
      SELECT keyword, rank, captured_at FROM rank_results
      WHERE keyword = ? AND captured_at >= datetime('now', '-${weeks * 7} days')
      ORDER BY captured_at DESC
    `).all(keyword) as Array<Record<string, unknown>>;
    return rows.map(r => ({ keyword: r.keyword as string, rank: r.rank as number | null, capturedAt: r.captured_at as string }));
  },
  latest(): Map<string, number | null> {
    const rows = db.prepare(`
      SELECT keyword, rank FROM rank_results
      WHERE (keyword, captured_at) IN (
        SELECT keyword, MAX(captured_at) FROM rank_results GROUP BY keyword
      )
    `).all() as { keyword: string; rank: number | null }[];
    return new Map(rows.map(r => [r.keyword, r.rank]));
  },
};

export const googleReviewRepo = {
  upsert(review: GoogleReview): void {
    db.prepare(`
      INSERT INTO google_reviews (id, name, star_rating, body, author_name, is_anonymous, posted_at, has_reply)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET has_reply = excluded.has_reply
    `).run(
      review.reviewId, review.name, review.starRating, review.body,
      review.authorName, review.isAnonymous ? 1 : 0,
      review.postedAt, review.hasReply ? 1 : 0,
    );
  },
  seenIds(): Set<string> {
    const rows = db.prepare('SELECT id FROM google_reviews').all() as { id: string }[];
    return new Set(rows.map(r => r.id));
  },
  getByReviewId(reviewId: string): GoogleReview | undefined {
    const r = db.prepare('SELECT * FROM google_reviews WHERE id = ?').get(reviewId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      reviewId: r.id as string,
      name: r.name as string,
      starRating: r.star_rating as number,
      body: r.body as string,
      authorName: r.author_name as string,
      isAnonymous: Boolean(r.is_anonymous),
      postedAt: r.posted_at as string,
      hasReply: Boolean(r.has_reply),
    };
  },
  isPosted(reviewId: string): boolean {
    const row = db.prepare('SELECT status FROM google_review_posts WHERE review_id = ?').get(reviewId) as { status: string } | undefined;
    return row?.status === 'posted';
  },
  saveDraft(draft: ReviewDraft): void {
    db.prepare(`
      INSERT OR REPLACE INTO google_review_drafts
        (review_id, risk_level, reasons, key_phrases, estimated_visit_count, summary, draft_text, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      draft.id, draft.riskLevel,
      JSON.stringify(draft.reasons), JSON.stringify(draft.keyPhrases),
      draft.estimatedVisitCount, draft.summary, draft.draftText, draft.generatedAt,
    );
  },
  savePostResult(result: GooglePostResult): void {
    db.prepare(`
      INSERT OR REPLACE INTO google_review_posts (review_id, status, error)
      VALUES (?, ?, ?)
    `).run(result.reviewId, result.status, result.error ?? null);
  },
};

export function auditLog(entry: {
  agent: string;
  event: string;
  reviewId?: string;
  blogId?: number;
  draftText?: string;
  postedText?: string;
  screenshotPaths?: string[];
  claudeInputTokens?: number;
  claudeOutputTokens?: number;
  status: 'ok' | 'warn' | 'error' | 'skip' | 'dry_run';
  error?: string;
}): void {
  db.prepare(`
    INSERT INTO audit_log
      (agent, event, review_id, blog_id, draft_text, posted_text, screenshot_paths,
       claude_input_tokens, claude_output_tokens, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.agent, entry.event,
    entry.reviewId ?? null, entry.blogId ?? null,
    entry.draftText ?? null, entry.postedText ?? null,
    entry.screenshotPaths ? JSON.stringify(entry.screenshotPaths) : null,
    entry.claudeInputTokens ?? null, entry.claudeOutputTokens ?? null,
    entry.status, entry.error ?? null,
  );
}
