import { getContext } from '../lib/browser.js';
import { db, auditLog } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import type { AgentResult } from '../types/index.js';

const AGENT = 'postingStatusChecker';
const HPB_BLOG_URL = 'https://beauty.hotpepper.jp/kr/slnH000804013/blog/';
const HPB_REVIEW_URL = 'https://beauty.hotpepper.jp/kr/slnH000804013/review/';

/** DBにblog_postsテーブルが存在してレコードがあるか確認 */
function hasBlogPosts(): boolean {
  try {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM blog_posts').get() as { cnt: number } | undefined;
    return (row?.cnt ?? 0) > 0;
  } catch {
    return false;
  }
}

/** DBの最新blog_postのposted_atを取得 */
function getLatestDbBlogPostedAt(): string | null {
  try {
    const row = db.prepare(
      "SELECT posted_at FROM blog_posts WHERE status = 'posted' ORDER BY posted_at DESC LIMIT 1"
    ).get() as { posted_at: string } | undefined;
    return row?.posted_at ?? null;
  } catch {
    return null;
  }
}

/** DBの返信済みreview_idsを取得 */
function getPostedReviewIds(): Set<string> {
  try {
    const rows = db.prepare(
      "SELECT review_id FROM review_posts WHERE status = 'posted'"
    ).all() as { review_id: string }[];
    return new Set(rows.map(r => r.review_id));
  } catch {
    return new Set();
  }
}

export async function runPostingStatusChecker(): Promise<AgentResult> {
  const start = Date.now();
  logger.info({ agent: AGENT, event: 'start' }, 'PostingStatusChecker started');

  // スキップ条件: blog_postsテーブルが存在しないかレコード0件
  if (!hasBlogPosts()) {
    logger.info({ agent: AGENT, event: 'skip' }, 'No blog posts in DB, skipping');
    auditLog({ agent: AGENT, event: 'skipped_no_records', status: 'ok' });
    return {
      agent: AGENT,
      status: 'ok',
      data: { skipped: true, reason: 'no_blog_posts_in_db' },
      durationMs: Date.now() - start,
    };
  }

  const issues: string[] = [];
  let overallStatus: 'ok' | 'warn' | 'error' = 'ok';

  const context = await getContext();
  let blogPage: Awaited<ReturnType<typeof context.newPage>> | null = null;
  let reviewPage: Awaited<ReturnType<typeof context.newPage>> | null = null;

  try {
    // ── ブログチェック ──────────────────────────────────────────────────────
    blogPage = await context.newPage();
    await blogPage.goto(HPB_BLOG_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await blogPage.waitForTimeout(1500);

    // 最新ブログの投稿日時を取得（HPBのブログ一覧から）
    const latestBlogDateText = await blogPage.evaluate(() => {
      // HPBブログ一覧の日時セレクター候補
      const selectors = [
        '.blogList .date',
        '.blog-list .date',
        '.slnBlogList .date',
        'time',
        '.blogDate',
        '.postDate',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el.getAttribute('datetime') ?? el.textContent?.trim() ?? null;
      }
      return null;
    });

    const dbLatestPostedAt = getLatestDbBlogPostedAt();

    if (latestBlogDateText) {
      const hpbDate = new Date(latestBlogDateText);
      const now = new Date();
      const hoursElapsed = (now.getTime() - hpbDate.getTime()) / (1000 * 60 * 60);

      if (hoursElapsed > 24) {
        issues.push(`ブログ最終投稿から ${Math.round(hoursElapsed)} 時間経過（HPB: ${latestBlogDateText}）`);
        if (overallStatus === 'ok') overallStatus = 'warn';
      }

      // DBの投稿と照合
      if (dbLatestPostedAt) {
        const dbDate = new Date(dbLatestPostedAt);
        const diffMs = Math.abs(dbDate.getTime() - hpbDate.getTime());
        const diffHours = diffMs / (1000 * 60 * 60);
        if (diffHours > 2) {
          issues.push(`DBの最終投稿（${dbLatestPostedAt}）とHPBの最終ブログ日時（${latestBlogDateText}）が2時間以上ずれています`);
          overallStatus = 'error';
        }
      }
    } else {
      // ブログが見つからないがDBには投稿記録がある → エラー
      issues.push('HPBブログページでブログ日時を取得できませんでした（反映されていない可能性があります）');
      overallStatus = 'error';
    }

    // ── 口コミ返信チェック ────────────────────────────────────────────────
    reviewPage = await context.newPage();
    await reviewPage.goto(HPB_REVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await reviewPage.waitForTimeout(1500);

    // DBの返信済みIDを取得
    const postedReviewIds = getPostedReviewIds();

    // HPBの口コミ一覧から返信ありのレビューIDを取得
    const hpbRepliedIds = await reviewPage.evaluate(() => {
      const replied: string[] = [];
      document.querySelectorAll('[id*="review"], .review-item, .kuchikomi-item').forEach(el => {
        const hasReply = el.querySelector('.owner-reply, .reply-body, .salonReply, [class*="reply"]');
        if (hasReply) {
          const id = el.id || el.getAttribute('data-id') || '';
          if (id) replied.push(id);
        }
      });
      return replied;
    });

    // DBで投稿済みとされているがHPBに反映されていないケースを検知
    const unreflectedIds: string[] = [];
    for (const dbId of postedReviewIds) {
      if (hpbRepliedIds.length > 0 && !hpbRepliedIds.includes(dbId)) {
        unreflectedIds.push(dbId);
      }
    }

    if (unreflectedIds.length > 0) {
      issues.push(`DBでは返信済みだがHPBに未反映の口コミID: ${unreflectedIds.slice(0, 3).join(', ')}`);
      overallStatus = 'error';
    }

    logger.info({ agent: AGENT, event: 'done', overallStatus, issues }, 'PostingStatusChecker completed');
    auditLog({ agent: AGENT, event: 'completed', status: overallStatus });

    return {
      agent: AGENT,
      status: overallStatus,
      data: {
        issues,
        latestBlogDateOnHpb: latestBlogDateText,
        latestBlogDateInDb: dbLatestPostedAt,
        unreflectedReviewIds: unreflectedIds,
      },
      durationMs: Date.now() - start,
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.error({ agent: AGENT, error: err }, 'PostingStatusChecker failed');
    auditLog({ agent: AGENT, event: 'error', status: 'error', error: err });
    return { agent: AGENT, status: 'error', error: err, durationMs: Date.now() - start };
  } finally {
    if (blogPage) await blogPage.close().catch(() => {});
    if (reviewPage) await reviewPage.close().catch(() => {});
  }
}
