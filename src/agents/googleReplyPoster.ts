import { postReply } from '../lib/googleBusiness.js';
import { googleReviewRepo, auditLog } from '../lib/db.js';
import { isDryRun } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import type { ReviewDraft, AgentResult, GooglePostResult } from '../types/index.js';

/**
 * Google口コミへの返信を Google Business Profile API 経由で投稿する。
 * HPB の replyPoster と異なり Playwright 不要（REST API 直接呼び出し）。
 */
export async function runGoogleReplyPoster(drafts: ReviewDraft[]): Promise<AgentResult> {
  const start = Date.now();
  const dryRun = isDryRun();

  logger.info({ agent: 'googleReplyPoster', count: drafts.length, dryRun }, 'Google口コミ返信 開始');

  if (drafts.length === 0) {
    return {
      agent: 'googleReplyPoster',
      status: 'ok',
      data: { successCount: 0, results: [] },
      durationMs: Date.now() - start,
    };
  }

  const results: GooglePostResult[] = [];
  let successCount = 0;

  for (const draft of drafts) {
    const reviewId = draft.id;

    // 既投稿チェック
    if (googleReviewRepo.isPosted(reviewId)) {
      logger.info({ agent: 'googleReplyPoster', reviewId }, '返信済みスキップ');
      results.push({ reviewId, status: 'skipped' });
      continue;
    }

    // DB から name（APIリソース名）を取得
    const googleReview = googleReviewRepo.getByReviewId(reviewId);
    if (!googleReview) {
      const err = `reviewId=${reviewId} のGoogle口コミがDBに見つかりません`;
      logger.error({ agent: 'googleReplyPoster', reviewId, error: err });
      results.push({ reviewId, status: 'failed', error: err });
      continue;
    }

    if (dryRun) {
      logger.info({ agent: 'googleReplyPoster', reviewId, dryRun: true }, '[DRY RUN] 投稿スキップ');
      googleReviewRepo.savePostResult({ reviewId, status: 'dry_run' });
      auditLog({
        agent: 'googleReplyPoster',
        event: 'dry_run',
        reviewId,
        draftText: draft.draftText.slice(0, 200),
        status: 'dry_run',
      });
      results.push({ reviewId, status: 'dry_run' });
      successCount++;
      continue;
    }

    try {
      await postReply(googleReview.name, draft.draftText);
      googleReviewRepo.savePostResult({ reviewId, status: 'posted' });
      auditLog({
        agent: 'googleReplyPoster',
        event: 'posted',
        reviewId,
        postedText: draft.draftText.slice(0, 500),
        status: 'ok',
      });
      results.push({ reviewId, status: 'posted' });
      successCount++;
      logger.info({ agent: 'googleReplyPoster', reviewId }, 'Google口コミ返信 投稿完了');

      // API レート制限対策（1秒待機）
      await new Promise(res => setTimeout(res, 1000));
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error({ agent: 'googleReplyPoster', reviewId, error: err }, 'Google口コミ返信 失敗');
      googleReviewRepo.savePostResult({ reviewId, status: 'failed', error: err });
      auditLog({ agent: 'googleReplyPoster', event: 'failed', reviewId, status: 'error', error: err });
      results.push({ reviewId, status: 'failed', error: err });
    }
  }

  const hasError = results.some(r => r.status === 'failed');
  return {
    agent: 'googleReplyPoster',
    status: hasError ? 'error' : 'ok',
    data: { successCount, results },
    error: hasError ? `${results.filter(r => r.status === 'failed').length}件の投稿に失敗しました` : undefined,
    durationMs: Date.now() - start,
  };
}
