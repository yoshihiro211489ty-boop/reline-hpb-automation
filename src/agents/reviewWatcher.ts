import * as cheerio from 'cheerio';
import { getConfig } from '../lib/config.js';
import { reviewRepo, auditLog } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import type { Review, AgentResult } from '../types/index.js';

const HPB_REVIEW_SELECTOR = '.reviewCnt, .review-block, [data-review-id]';

function parseReviewsFromHtml(html: string, salonId: string): Review[] {
  const $ = cheerio.load(html);
  const reviews: Review[] = [];

  $('.reviews-list-item, .kuchikomi-list li, [class*="review"]').each((_, el) => {
    const $el = $(el);
    const id = $el.attr('id') ?? $el.attr('data-review-id') ?? `${salonId}-${reviews.length}`;
    const starText = $el.find('.star, [class*="star"], .hpbComStars').text().trim();
    const starMatch = starText.match(/(\d+(?:\.\d+)?)/);
    const starRating = starMatch ? parseFloat(starMatch[1]) : 0;
    const body = $el.find('.review-body, .kuchikomi-body, p').first().text().trim();
    const author = $el.find('.review-author, .kuchikomi-author, .nick').first().text().trim() || '匿名';
    const postedAt = $el.find('.review-date, time').first().attr('datetime') ?? new Date().toISOString();
    const hasReply = $el.find('.review-reply, .reply-body, .owner-reply').length > 0;

    if (body.length > 0 && starRating > 0) {
      reviews.push({ id, starRating, body, authorNickname: author, postedAt, hasReply });
    }
  });

  return reviews;
}

async function fetchHpbReviewPage(salonUrl: string): Promise<string> {
  const response = await fetch(salonUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'ja-JP,ja;q=0.9',
    },
  });
  if (!response.ok) throw new Error(`HPB fetch failed: ${response.status}`);
  return response.text();
}

export async function runReviewWatcher(): Promise<AgentResult> {
  const start = Date.now();
  const config = getConfig();
  const salonUrl = config.salon.hpb_url;

  logger.info({ agent: 'reviewWatcher', event: 'start' }, 'ReviewWatcher started');

  try {
    const seenIds = reviewRepo.seenIds();
    const html = await fetchHpbReviewPage(salonUrl);
    const reviews = parseReviewsFromHtml(html, config.salon.hpb_salon_id);

    const newReviews: Review[] = [];
    for (const review of reviews) {
      reviewRepo.upsert(review);
      if (!seenIds.has(review.id)) {
        newReviews.push(review);
      }
    }

    logger.info(
      { agent: 'reviewWatcher', event: 'done', total: reviews.length, new: newReviews.length },
      `Found ${reviews.length} reviews, ${newReviews.length} new`
    );

    auditLog({
      agent: 'reviewWatcher',
      event: 'completed',
      status: 'ok',
    });

    return {
      agent: 'reviewWatcher',
      status: 'ok',
      data: { total: reviews.length, newReviews },
      durationMs: Date.now() - start,
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.error({ agent: 'reviewWatcher', event: 'error', error: err }, 'ReviewWatcher failed');
    auditLog({ agent: 'reviewWatcher', event: 'error', status: 'error', error: err });
    return { agent: 'reviewWatcher', status: 'error', error: err, durationMs: Date.now() - start };
  }
}
