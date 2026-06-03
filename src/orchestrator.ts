import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { isDryRun, isBlogDay, isMonday, isFirstOfMonth, todayDayName } from './lib/config.js';
import { closeBrowser } from './lib/browser.js';
import { notify, notifyError } from './lib/line.js';
import { logger } from './lib/logger.js';
import type { Review, AgentResult } from './types/index.js';

import { runReviewWatcher } from './agents/reviewWatcher.js';
import { runSafetyClassifier } from './agents/safetyClassifier.js';
import { runReplyDrafter } from './agents/replyDrafter.js';
import { runReplyPoster } from './agents/replyPoster.js';
import { runBlogIdeator } from './agents/blogIdeator.js';
import { runBlogWriter } from './agents/blogWriter.js';
import { runBlogPoster } from './agents/blogPoster.js';
import { runCompetitorScraper } from './agents/competitorScraper.js';
import { runRankWatcher } from './agents/rankWatcher.js';
import { runWeeklyReporter } from './agents/weeklyReporter.js';
import { runGoogleReviewWatcher } from './agents/googleReviewWatcher.js';
import { runGoogleReplyPoster } from './agents/googleReplyPoster.js';
import { runPostingStatusChecker } from './agents/postingStatusChecker.js';
import { runImageGenerator } from './agents/imageGenerator.js';
import { runImageQualityChecker } from './agents/imageQualityChecker.js';
import { runImageUploader } from './agents/imageUploader.js';
import { runSalonboardSupervisor } from './agents/salonboardSupervisor.js';
import type { GeneratedImage } from './types/index.js';

const TZ = 'Asia/Tokyo';

function parseAgentFilter(): string[] | null {
  const idx = process.argv.indexOf('--agents');
  if (idx === -1) return null;
  const val = process.argv[idx + 1];
  return val ? val.split(',').map(s => s.trim()) : null;
}

async function runWithTimer<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ result: T | null; durationMs: number; error: string | null }> {
  const start = Date.now();
  try {
    const result = await fn();
    return { result, durationMs: Date.now() - start, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: null, durationMs: Date.now() - start, error: msg };
  }
}

async function main(): Promise<void> {
  const now = toZonedTime(new Date(), TZ);
  const dateStr = format(now, 'yyyy年MM月dd日');
  const dayName = todayDayName();
  const dryRun = isDryRun();
  const agentFilter = parseAgentFilter();

  const prefix = dryRun ? '[DRY RUN] ' : '';
  logger.info({ event: 'orchestrator_start', date: dateStr, dayName, dryRun }, `${prefix}Orchestrator started`);
  console.log(`\n🤖 ${prefix}リライン HPB自動化 - ${dateStr}\n`);

  const results: AgentResult[] = [];
  const errors: string[] = [];

  const shouldRun = (name: string) => !agentFilter || agentFilter.includes(name);

  // ─────────────── 毎日実行: 口コミ監視・返信 ───────────────
  let newReviews: Review[] = [];
  let autoPostCount = 0;
  let warnCount = 0;
  let dangerCount = 0;

  if (shouldRun('reviewWatcher')) {
    const { result } = await runWithTimer('reviewWatcher', runReviewWatcher);
    if (result) {
      results.push(result);
      if (result.status === 'ok') {
        newReviews = (result.data as { total: number; newReviews: Review[] }).newReviews;
      } else {
        errors.push(`reviewWatcher: ${result.error}`);
        await notifyError('reviewWatcher', result.error ?? '不明なエラー');
      }
    }
  }

  if (newReviews.length > 0 && shouldRun('safetyClassifier')) {
    const { result } = await runWithTimer('safetyClassifier', () => runSafetyClassifier(newReviews));
    if (result) {
      results.push(result);
      const classified = (result.data as { classified: never[] }).classified ?? [];

      if (shouldRun('replyDrafter')) {
        const { result: drafterResult } = await runWithTimer('replyDrafter', () => runReplyDrafter(classified));
        if (drafterResult) {
          results.push(drafterResult);
          const data = drafterResult.data as { autoPostDrafts: never[]; warnDrafts: never[]; dangerCount: number } | undefined;
          const autoPostDrafts = data?.autoPostDrafts ?? [];
          warnCount = data?.warnDrafts.length ?? 0;
          dangerCount = data?.dangerCount ?? 0;

          if (shouldRun('replyPoster')) {
            const { result: posterResult } = await runWithTimer('replyPoster', () => runReplyPoster(autoPostDrafts));
            if (posterResult) {
              results.push(posterResult);
              autoPostCount = (posterResult.data as { successCount?: number })?.successCount ?? 0;
              if (posterResult.status === 'error') {
                errors.push(`replyPoster: ${posterResult.error}`);
                await notifyError('replyPoster', posterResult.error ?? '不明なエラー');
              }
            }
          }
        }
      }
    }
  }

  // ─────────────── 毎日実行: Google口コミ監視・返信 ───────────────
  let googleAutoPostCount = 0;
  let googleWarnCount = 0;
  let googleDangerCount = 0;
  let googleNewReviews: Review[] = [];

  if (shouldRun('googleReviewWatcher')) {
    const { result: gWatcherResult } = await runWithTimer('googleReviewWatcher', runGoogleReviewWatcher);
    if (gWatcherResult) {
      results.push(gWatcherResult);
      if (gWatcherResult.status === 'ok') {
        const data = gWatcherResult.data as { newReviews: Review[] };
        googleNewReviews = data.newReviews;
      } else {
        // Google設定未完了の場合は静かにスキップ（設定前は error になる）
        const isSetupError = gWatcherResult.error?.includes('google_location_name') ||
                             gWatcherResult.error?.includes('Keychain');
        if (!isSetupError) {
          errors.push(`googleReviewWatcher: ${gWatcherResult.error}`);
          await notifyError('googleReviewWatcher', gWatcherResult.error ?? '不明なエラー');
        } else {
          logger.info({ agent: 'orchestrator' }, 'Google口コミ: 未設定のためスキップ');
        }
      }
    }
  }

  if (googleNewReviews.length > 0 && shouldRun('googleSafetyClassifier')) {
    // HPBと同じ safetyClassifier を再利用
    const { result: gClassResult } = await runWithTimer('googleSafetyClassifier', () =>
      runSafetyClassifier(googleNewReviews),
    );
    if (gClassResult) {
      results.push({ ...gClassResult, agent: 'googleSafetyClassifier' });
      const classified = (gClassResult.data as { classified: never[] }).classified ?? [];

      if (shouldRun('googleReplyDrafter')) {
        // HPBと同じ replyDrafter を再利用（ペルソナ・ロジックは共通）
        const { result: gDrafterResult } = await runWithTimer('googleReplyDrafter', () =>
          runReplyDrafter(classified),
        );
        if (gDrafterResult) {
          results.push({ ...gDrafterResult, agent: 'googleReplyDrafter' });
          const data = gDrafterResult.data as { autoPostDrafts: never[]; warnDrafts: never[]; dangerCount: number } | undefined;
          const autoPostDrafts = data?.autoPostDrafts ?? [];
          googleWarnCount = data?.warnDrafts.length ?? 0;
          googleDangerCount = data?.dangerCount ?? 0;

          if (shouldRun('googleReplyPoster')) {
            const { result: gPosterResult } = await runWithTimer('googleReplyPoster', () =>
              runGoogleReplyPoster(autoPostDrafts),
            );
            if (gPosterResult) {
              results.push(gPosterResult);
              googleAutoPostCount = (gPosterResult.data as { successCount?: number })?.successCount ?? 0;
              if (gPosterResult.status === 'error') {
                errors.push(`googleReplyPoster: ${gPosterResult.error}`);
                await notifyError('googleReplyPoster', gPosterResult.error ?? '不明なエラー');
              }
            }
          }
        }
      }
    }
  }

  // ─────────────── 月・水・金: ブログ投稿 ───────────────
  let blogPosted = false;

  if (isBlogDay(dayName) && shouldRun('blogIdeator')) {
    const { result: ideaResult } = await runWithTimer('blogIdeator', runBlogIdeator);
    if (ideaResult?.status === 'ok') {
      results.push(ideaResult);
      const idea = (ideaResult.data as { idea: never })?.idea;

      if (idea && shouldRun('blogWriter')) {
        const { result: writerResult } = await runWithTimer('blogWriter', () => runBlogWriter(idea));
        if (writerResult?.status !== 'error') {
          results.push(writerResult!);
          const data = writerResult!.data as { draft: never; draftId: number } | undefined;
          const draft = data?.draft;
          const draftId = data?.draftId ?? 0;

          if (draft && shouldRun('blogPoster')) {
            const { result: posterResult } = await runWithTimer('blogPoster', () => runBlogPoster(draft, draftId));
            if (posterResult) {
              results.push(posterResult);
              blogPosted = posterResult.status === 'ok';
              if (posterResult.status === 'error') {
                errors.push(`blogPoster: ${posterResult.error}`);
                await notifyError('blogPoster', posterResult.error ?? '不明なエラー');
              }
            }
          }
        }
      }
    } else if (ideaResult) {
      errors.push(`blogIdeator: ${ideaResult.error}`);
    }
  }

  // ─────────────── 毎日: 投稿反映チェック ───────────────
  if (shouldRun('postingStatusChecker')) {
    const { result } = await runWithTimer('postingStatusChecker', runPostingStatusChecker);
    if (result) {
      results.push(result);
      if (result.status === 'error') {
        errors.push(`postingStatusChecker: ${result.error}`);
        await notifyError('postingStatusChecker', result.error ?? '不明なエラー');
      } else if (result.status === 'warn') {
        // warn は通知のみ（エラーカウントには入れない）
        logger.warn({ agent: 'orchestrator', data: result.data }, '投稿反映チェック: 要確認あり');
      }
    }
  }

  // ─────────────── 月曜: 画像生成・チェック・アップロード ───────────────
  if (isMonday() && shouldRun('imageGenerator')) {
    const IMAGE_CATEGORIES = ['kodawari', 'gallery', 'salon'] as const;
    const { result: genResult } = await runWithTimer('imageGenerator', () =>
      runImageGenerator([...IMAGE_CATEGORIES]),
    );

    if (genResult?.status === 'ok') {
      results.push(genResult);
      const generatedImages = (genResult.data as { generated: GeneratedImage[] })?.generated ?? [];

      if (generatedImages.length > 0 && shouldRun('imageQualityChecker')) {
        const { result: checkResult } = await runWithTimer('imageQualityChecker', () =>
          runImageQualityChecker(generatedImages),
        );
        if (checkResult) {
          results.push(checkResult);
          const approvedImages = (checkResult.data as { approved: GeneratedImage[] })?.approved ?? [];

          if (approvedImages.length > 0 && shouldRun('imageUploader')) {
            const { result: uploadResult } = await runWithTimer('imageUploader', () =>
              runImageUploader(approvedImages),
            );
            if (uploadResult) {
              results.push(uploadResult);
              if (uploadResult.status === 'error') {
                errors.push(`imageUploader: ${uploadResult.error}`);
                await notifyError('imageUploader', uploadResult.error ?? '不明なエラー');
              }
            }
          }
        }
      }
    } else if (genResult) {
      // OpenAIキー未設定など設定起因エラーは静かにスキップ
      const isSetupError = genResult.error?.includes('Keychain') || genResult.error?.includes('api-key');
      if (!isSetupError) {
        errors.push(`imageGenerator: ${genResult.error}`);
      } else {
        logger.info({ agent: 'orchestrator' }, '画像生成: OpenAI APIキー未設定のためスキップ');
      }
    }
  }

  // ─────────────── 月曜: 競合調査・順位確認・週次レポート ───────────────
  if (isMonday()) {
    if (shouldRun('competitorScraper')) {
      const { result } = await runWithTimer('competitorScraper', runCompetitorScraper);
      if (result) {
        results.push(result);
        if (result.status === 'error') {
          errors.push(`competitorScraper: ${result.error}`);
        }
      }
    }

    if (shouldRun('rankWatcher')) {
      const { result } = await runWithTimer('rankWatcher', runRankWatcher);
      if (result) results.push(result);
    }

    if (shouldRun('weeklyReporter')) {
      const { result } = await runWithTimer('weeklyReporter', runWeeklyReporter);
      if (result) results.push(result);
    }

    // ─────────────── 月曜: サロンボード全体監視・改善提案 ───────────────
    if (shouldRun('salonboardSupervisor')) {
      const { result } = await runWithTimer('salonboardSupervisor', runSalonboardSupervisor);
      if (result) {
        results.push(result);
        if (result.status === 'error') {
          errors.push(`salonboardSupervisor: ${result.error}`);
        }
      }
    }
  }

  // ─────────────── 日次 LINE 通知サマリー ───────────────
  const allOk = errors.length === 0;
  const summaryLines = [
    `${dateStr} の実行結果`,
    ``,
    `【HPB口コミ】`,
    `  新着 ${newReviews.length}件`,
    autoPostCount > 0 ? `  自動返信済み ${autoPostCount}件` : null,
    warnCount > 0 ? `  承認待ち ${warnCount}件 (別途通知済み)` : null,
    dangerCount > 0 ? `  要対応 ${dangerCount}件 (別途通知済み)` : null,
    ``,
    `【Google口コミ】`,
    `  新着 ${googleNewReviews.length}件`,
    googleAutoPostCount > 0 ? `  自動返信済み ${googleAutoPostCount}件` : null,
    googleWarnCount > 0 ? `  承認待ち ${googleWarnCount}件 (別途通知済み)` : null,
    googleDangerCount > 0 ? `  要対応 ${googleDangerCount}件 (別途通知済み)` : null,
    isBlogDay(dayName) ? `\nブログ: ${blogPosted ? '投稿完了' : dryRun ? '[DRY] 生成のみ' : '投稿失敗'}` : null,
    isMonday() ? `競合調査・順位確認・画像更新・改善提案: 完了` : null,
    ``,
    errors.length > 0 ? `エラー ${errors.length}件:\n${errors.map(e => `  - ${e}`).join('\n')}` : `エラー: 0件`,
  ].filter(Boolean).join('\n');

  await notify(allOk ? 'info' : 'error', summaryLines);

  logger.info({ event: 'orchestrator_done', errors: errors.length }, 'Orchestrator completed');
  console.log(`\n✅ 完了 (${results.length}エージェント実行, エラー${errors.length}件)\n`);
}

main()
  .catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ event: 'orchestrator_fatal', error: msg }, 'Fatal error');
    console.error('Fatal error:', msg);
    try {
      await notifyError('orchestrator', `致命的エラーが発生しました:\n${msg}`);
    } catch {}
    process.exit(1);
  })
  .finally(async () => {
    await closeBrowser();
  });
