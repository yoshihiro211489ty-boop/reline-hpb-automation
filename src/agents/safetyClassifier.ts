import { askClaudeJson } from '../lib/claude.js';
import { reviewRepo, auditLog } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import fs from 'fs';
import path from 'path';
import type { Review, ClassifiedReview, RiskLevel, VisitCount, AgentResult } from '../types/index.js';

function buildClassifierSystem(): string {
  return fs.readFileSync(path.join(process.cwd(), 'prompts', 'safety_classifier.md'), 'utf8');
}

interface ClassifierOutput {
  label: RiskLevel;
  reasons: string[];
  key_phrases: string[];
  estimated_visit_count: VisitCount;
  star_rating: number;
  summary: string;
}

async function classifyReview(review: Review): Promise<ClassifiedReview> {
  const system = buildClassifierSystem();
  const user = `以下の口コミを分類してください:\n\n★${review.starRating}\n投稿者: ${review.authorNickname}\n本文: ${review.body}`;

  const result = await askClaudeJson<ClassifierOutput>({
    system,
    user,
    temperature: 0,
    maxTokens: 512,
  });

  return {
    ...review,
    riskLevel: result.label,
    reasons: result.reasons,
    keyPhrases: result.key_phrases,
    estimatedVisitCount: result.estimated_visit_count,
    summary: result.summary,
  };
}

export async function runSafetyClassifier(
  newReviews: Review[]
): Promise<AgentResult> {
  const start = Date.now();

  if (newReviews.length === 0) {
    return { agent: 'safetyClassifier', status: 'ok', data: { classified: [] }, durationMs: 0 };
  }

  logger.info({ agent: 'safetyClassifier', event: 'start', count: newReviews.length }, 'Classifying reviews');

  const classified: ClassifiedReview[] = [];
  const errors: string[] = [];

  for (const review of newReviews) {
    try {
      const result = await classifyReview(review);
      classified.push(result);
      auditLog({
        agent: 'safetyClassifier',
        event: 'classified',
        reviewId: review.id,
        status: result.riskLevel === 'danger' ? 'warn' : 'ok',
      });
      logger.info(
        { agent: 'safetyClassifier', reviewId: review.id, risk: result.riskLevel, summary: result.summary },
        `Review classified as ${result.riskLevel}`
      );
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      errors.push(`Review ${review.id}: ${err}`);
      logger.error({ agent: 'safetyClassifier', reviewId: review.id, error: err }, 'Classification failed');
    }
  }

  return {
    agent: 'safetyClassifier',
    status: errors.length > 0 ? 'warn' : 'ok',
    data: { classified },
    error: errors.length > 0 ? errors.join('\n') : undefined,
    durationMs: Date.now() - start,
  };
}
