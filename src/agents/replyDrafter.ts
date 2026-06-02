import { askClaude } from '../lib/claude.js';
import { buildReplyPrompt } from '../lib/persona.js';
import { checkReplyText } from '../lib/safety.js';
import { checkReplyGrounding } from '../lib/groundingCheck.js';
import { reviewRepo, auditLog } from '../lib/db.js';
import { notifyDanger, notifyWarnDraft } from '../lib/line.js';
import { logger } from '../lib/logger.js';
import type { ClassifiedReview, ReviewDraft, AgentResult } from '../types/index.js';

async function generateReply(review: ClassifiedReview): Promise<string> {
  const systemPrompt = buildReplyPrompt(review.starRating);
  const user = `以下の口コミへの返信文を書いてください。

★${review.starRating} / 投稿者: ${review.authorNickname}さま
口コミ本文:
${review.body}

${review.estimatedVisitCount === 'repeat' ? '※ 投稿者は既存のリピート顧客と思われます。' : ''}
${review.estimatedVisitCount === 'first' ? '※ 投稿者は初回のお客様と思われます。' : ''}

返信文のみ出力してください（前置き・説明は不要）。`;

  const result = await askClaude({ system: systemPrompt, user, temperature: 0.7, maxTokens: 800 });
  return result.text.trim();
}

export async function runReplyDrafter(classified: ClassifiedReview[]): Promise<AgentResult> {
  const start = Date.now();

  if (classified.length === 0) {
    return { agent: 'replyDrafter', status: 'ok', data: { drafts: [] }, durationMs: 0 };
  }

  logger.info({ agent: 'replyDrafter', event: 'start', count: classified.length }, 'Drafting replies');

  const drafts: ReviewDraft[] = [];
  const dangerReviews: ClassifiedReview[] = [];
  const warnDrafts: ReviewDraft[] = [];

  for (const review of classified) {
    if (review.riskLevel === 'danger') {
      dangerReviews.push(review);
      auditLog({ agent: 'replyDrafter', event: 'danger_escalated', reviewId: review.id, status: 'warn' });
      await notifyDanger(review.summary, review.body);
      continue;
    }

    try {
      const draftText = await generateReply(review);
      const safetyCheck = checkReplyText(draftText);

      if (!safetyCheck.passed) {
        logger.warn({ agent: 'replyDrafter', reviewId: review.id, issues: safetyCheck.issues }, 'Safety check failed, escalating to warn');
        const draft: ReviewDraft = { ...review, draftText, generatedAt: new Date().toISOString() };
        reviewRepo.saveDraft({ ...draft, riskLevel: 'warn', reasons: [...review.reasons, ...safetyCheck.issues] });
        warnDrafts.push(draft);
        continue;
      }

      // ── グラウンディングチェック: 口コミに書かれていないことを引用していないか ──
      const groundingCheck = await checkReplyGrounding(review.body, draftText);
      if (!groundingCheck.passed) {
        logger.warn(
          { agent: 'replyDrafter', reviewId: review.id, issues: groundingCheck.issues },
          'Grounding check failed — escalating to warn for human review',
        );
        const draft: ReviewDraft = { ...review, draftText, generatedAt: new Date().toISOString() };
        reviewRepo.saveDraft({
          ...draft,
          riskLevel: 'warn',
          reasons: [...review.reasons, ...groundingCheck.issues],
        });
        warnDrafts.push(draft);
        await notifyWarnDraft(
          `[グラウンディング問題] ${review.authorNickname}さまへの返信に要確認箇所があります:\n` +
          groundingCheck.issues.map(i => `・${i}`).join('\n'),
          draftText,
          review.id,
        );
        continue;
      }

      const draft: ReviewDraft = { ...review, draftText, generatedAt: new Date().toISOString() };
      reviewRepo.saveDraft(draft);
      drafts.push(draft);

      auditLog({
        agent: 'replyDrafter',
        event: 'draft_created',
        reviewId: review.id,
        draftText,
        status: review.riskLevel === 'warn' ? 'warn' : 'ok',
      });

      if (review.riskLevel === 'warn') {
        warnDrafts.push(draft);
        await notifyWarnDraft(review.summary, draftText, review.id);
      } else {
        drafts.push(draft);
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error({ agent: 'replyDrafter', reviewId: review.id, error: err }, 'Draft generation failed');
    }
  }

  const autoPostDrafts = drafts.filter(d => d.riskLevel === 'safe');
  logger.info(
    { agent: 'replyDrafter', event: 'done', autoPost: autoPostDrafts.length, warn: warnDrafts.length, danger: dangerReviews.length },
    'Reply drafting complete'
  );

  return {
    agent: 'replyDrafter',
    status: 'ok',
    data: { autoPostDrafts, warnDrafts, dangerCount: dangerReviews.length },
    durationMs: Date.now() - start,
  };
}
