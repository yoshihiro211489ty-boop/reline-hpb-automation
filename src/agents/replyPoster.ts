import path from 'path';
import { loginToSalonboard, humanDelay, humanType } from '../lib/browser.js';
import { isDryRun } from '../lib/config.js';
import { reviewRepo, auditLog } from '../lib/db.js';
import { getRepliesDir } from '../lib/logger.js';
import { logger } from '../lib/logger.js';
import type { ReviewDraft, PostResult, AgentResult } from '../types/index.js';
import type { Page } from 'playwright';

const SALONBOARD_REVIEW_URL = 'https://salonboard.com/CNT/edit/reviewEdit/list/';

async function postReplyOnSalonboard(page: Page, draft: ReviewDraft): Promise<PostResult> {
  const repliesDir = getRepliesDir();
  const beforePath = path.join(repliesDir, `${draft.id}-before.png`);
  const afterPath = path.join(repliesDir, `${draft.id}-after.png`);

  try {
    await page.goto(SALONBOARD_REVIEW_URL, { waitUntil: 'networkidle' });
    await humanDelay();

    await page.screenshot({ path: beforePath });

    const reviewEl = await page.$(`[data-review-id="${draft.id}"], #review-${draft.id}`);
    if (!reviewEl) {
      const altEl = await page.$('.review-item:not(.replied)');
      if (!altEl) {
        return {
          reviewId: draft.id,
          status: 'skipped_existing',
          screenshotBefore: beforePath,
        };
      }
    }

    const replyBtn = await page.$('.reply-btn, .answer-btn, [class*="reply-button"]');
    if (!replyBtn) throw new Error('返信ボタンが見つかりません');

    await replyBtn.click();
    await humanDelay(1000, 2000);

    const textarea = await page.$('textarea, .reply-textarea, [name*="reply"]');
    if (!textarea) throw new Error('テキストエリアが見つかりません');

    await humanType(page, 'textarea, .reply-textarea', draft.draftText);
    await humanDelay();

    const submitBtn = await page.$('button[type="submit"], .submit-btn, .confirm-btn');
    if (!submitBtn) throw new Error('送信ボタンが見つかりません');

    await submitBtn.click();
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
    await humanDelay();

    await page.screenshot({ path: afterPath });

    return {
      reviewId: draft.id,
      status: 'posted',
      screenshotBefore: beforePath,
      screenshotAfter: afterPath,
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return { reviewId: draft.id, status: 'failed', screenshotBefore: beforePath, error: err };
  }
}

export async function runReplyPoster(autoPostDrafts: ReviewDraft[]): Promise<AgentResult> {
  const start = Date.now();
  const dryRun = isDryRun();

  if (autoPostDrafts.length === 0) {
    return { agent: 'replyPoster', status: 'ok', data: { results: [] }, durationMs: 0 };
  }

  logger.info(
    { agent: 'replyPoster', event: 'start', count: autoPostDrafts.length, dryRun },
    `Posting ${autoPostDrafts.length} replies (dry_run=${dryRun})`
  );

  if (dryRun) {
    const results: PostResult[] = autoPostDrafts.map(d => ({
      reviewId: d.id,
      status: 'dry_run' as const,
    }));

    for (const draft of autoPostDrafts) {
      logger.info({ agent: 'replyPoster', reviewId: draft.id, dryRun: true }, '[DRY RUN] Would post reply');
      reviewRepo.savePostResult({ reviewId: draft.id, status: 'dry_run' });
      auditLog({
        agent: 'replyPoster',
        event: 'dry_run',
        reviewId: draft.id,
        postedText: draft.draftText,
        status: 'dry_run',
      });
    }

    return { agent: 'replyPoster', status: 'ok', data: { results }, durationMs: Date.now() - start };
  }

  let page: Awaited<ReturnType<typeof loginToSalonboard>> | null = null;
  const results: PostResult[] = [];

  try {
    page = await loginToSalonboard();

    for (const draft of autoPostDrafts) {
      if (reviewRepo.isReplied(draft.id)) {
        logger.info({ agent: 'replyPoster', reviewId: draft.id }, 'Already replied, skipping');
        results.push({ reviewId: draft.id, status: 'skipped_existing' });
        continue;
      }

      const result = await postReplyOnSalonboard(page, draft);
      results.push(result);
      reviewRepo.savePostResult(result);

      auditLog({
        agent: 'replyPoster',
        event: result.status === 'posted' ? 'posted' : 'failed',
        reviewId: draft.id,
        postedText: draft.draftText,
        screenshotPaths: [result.screenshotBefore, result.screenshotAfter].filter(Boolean) as string[],
        status: result.status === 'posted' ? 'ok' : 'error',
        error: result.error,
      });

      if (result.status === 'posted') {
        logger.info({ agent: 'replyPoster', reviewId: draft.id }, 'Reply posted successfully');
      } else {
        logger.warn({ agent: 'replyPoster', reviewId: draft.id, error: result.error }, 'Reply posting failed');
      }

      await humanDelay(2000, 4000);
    }
  } finally {
    if (page) await page.close();
  }

  const successCount = results.filter(r => r.status === 'posted').length;
  const failCount = results.filter(r => r.status === 'failed').length;

  return {
    agent: 'replyPoster',
    status: failCount > 0 ? 'warn' : 'ok',
    data: { results, successCount, failCount },
    durationMs: Date.now() - start,
  };
}
