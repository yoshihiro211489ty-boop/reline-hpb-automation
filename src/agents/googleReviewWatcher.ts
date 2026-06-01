import { listReviews } from '../lib/googleBusiness.js';
import { googleReviewRepo, auditLog } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { getConfig } from '../lib/config.js';
import type { GoogleReview, AgentResult, Review } from '../types/index.js';

/**
 * Google口コミを監視し、新着を検知して返す。
 * 返す Review[] は HPB reviewWatcher と同じ型なので
 * safetyClassifier / replyDrafter をそのまま再利用できる。
 */
export async function runGoogleReviewWatcher(): Promise<AgentResult> {
  const start = Date.now();
  logger.info({ agent: 'googleReviewWatcher', event: 'start' }, 'Google口コミ監視 開始');

  try {
    const config = getConfig();
    const locationName: string | undefined = config.salon?.google_location_name;
    if (!locationName) {
      throw new Error(
        'config/salon.yaml に google_location_name が設定されていません。\n' +
        'npm run google:setup を実行してアカウント情報を確認してください。',
      );
    }

    // Google APIから全口コミ取得
    const allReviews = await listReviews(locationName);
    logger.info({ agent: 'googleReviewWatcher', total: allReviews.length }, '口コミ取得完了');

    // DB済みIDと照合して新着だけ抽出
    const seenIds = googleReviewRepo.seenIds();
    const newGoogleReviews = allReviews.filter(r => !seenIds.has(r.reviewId));

    // 全件を DB に upsert（既存のhas_reply状態を更新するため）
    for (const review of allReviews) {
      googleReviewRepo.upsert(review);
    }

    logger.info(
      { agent: 'googleReviewWatcher', total: allReviews.length, newCount: newGoogleReviews.length },
      `Google新着口コミ ${newGoogleReviews.length}件`,
    );

    auditLog({
      agent: 'googleReviewWatcher',
      event: 'completed',
      status: 'ok',
    });

    // GoogleReview → Review 変換（safetyClassifier/replyDrafter と共用するため）
    const newReviews: Review[] = newGoogleReviews.map(gr => ({
      id: gr.reviewId,
      starRating: gr.starRating,
      body: gr.body,
      authorNickname: gr.authorName,
      postedAt: gr.postedAt,
      hasReply: gr.hasReply,
    }));

    return {
      agent: 'googleReviewWatcher',
      status: 'ok',
      data: {
        total: allReviews.length,
        newReviews,
        newGoogleReviews,  // name フィールド付きの生データも保持（poster が使う）
      },
      durationMs: Date.now() - start,
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.error({ agent: 'googleReviewWatcher', error: err }, 'Google口コミ監視 失敗');
    auditLog({ agent: 'googleReviewWatcher', event: 'error', status: 'error', error: err });
    return { agent: 'googleReviewWatcher', status: 'error', error: err, durationMs: Date.now() - start };
  }
}
