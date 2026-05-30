import * as cheerio from 'cheerio';
import { competitorRepo, auditLog } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import type { CompetitorSnapshot, AgentResult } from '../types/index.js';

const HPB_SEARCH_URL = 'https://beauty.hotpepper.jp/svcST/editR/search/?keyword=%E9%AA%A8%E7%9B%A4%E7%9F%AF%E6%AD%A3&sa=H3200&siteB=all';

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'ja-JP,ja;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function parseRating(text: string): number | null {
  const m = text.match(/(\d+\.\d+)/);
  return m ? parseFloat(m[1]) : null;
}

function parseCount(text: string): number {
  const m = text.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

async function scrapeSearchResults(): Promise<Array<{ name: string; url: string }>> {
  const html = await fetchPage(HPB_SEARCH_URL);
  const $ = cheerio.load(html);
  const results: Array<{ name: string; url: string }> = [];

  $('.salonList li, .mT10.mB10, [class*="salonBlock"]').each((_, el) => {
    const $el = $(el);
    const link = $el.find('a[href*="/kr/"], a[href*="/slnH"]').first();
    const name = link.text().trim() || $el.find('.salonName, .shopName').text().trim();
    const href = link.attr('href') ?? '';
    if (name && href && results.length < 10) {
      const url = href.startsWith('http') ? href : `https://beauty.hotpepper.jp${href}`;
      results.push({ name, url });
    }
  });

  return results;
}

async function scrapeSalonDetail(name: string, url: string): Promise<CompetitorSnapshot> {
  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  const avgText = $('.reviewCnt .hpbComStars, .salonStar, [class*="star"]').first().text();
  const reviewCountText = $('.reviewCnt, .kuchikomiCount, [class*="review-count"]').first().text();
  const blogCountText = $('.blogCnt, [class*="blog-count"]').first().text();

  const coupons: { label: string; price: number }[] = [];
  $('.couponList li, .couponBlock, [class*="coupon-item"]').each((_, el) => {
    const label = $(el).find('.couponName, .couponTitle').text().trim();
    const priceText = $(el).find('.couponPrice, .price').text();
    const priceMatch = priceText.match(/[\d,]+/);
    if (label) {
      coupons.push({ label, price: priceMatch ? parseInt(priceMatch[0].replace(',', ''), 10) : 0 });
    }
  });

  return {
    name,
    hpbUrl: url,
    reviewCount: parseCount(reviewCountText),
    avgRating: parseRating(avgText),
    blogCount: parseCount(blogCountText),
    coupons: coupons.slice(0, 10),
    capturedAt: new Date().toISOString(),
  };
}

export async function runCompetitorScraper(): Promise<AgentResult> {
  const start = Date.now();
  logger.info({ agent: 'competitorScraper', event: 'start' }, 'Scraping competitors');

  try {
    const searchResults = await scrapeSearchResults();
    if (searchResults.length === 0) {
      throw new Error('競合店が1件も見つかりませんでした（HPB検索結果のHTML構造が変わった可能性あり）');
    }

    const snapshots: CompetitorSnapshot[] = [];
    for (const { name, url } of searchResults) {
      try {
        const snapshot = await scrapeSalonDetail(name, url);
        snapshots.push(snapshot);
        await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
      } catch (e) {
        logger.warn({ agent: 'competitorScraper', name, error: String(e) }, 'Failed to scrape salon detail');
      }
    }

    competitorRepo.save(snapshots);
    auditLog({ agent: 'competitorScraper', event: 'completed', status: 'ok' });
    logger.info({ agent: 'competitorScraper', count: snapshots.length }, 'Competitor scraping done');

    return { agent: 'competitorScraper', status: 'ok', data: { snapshots }, durationMs: Date.now() - start };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    auditLog({ agent: 'competitorScraper', event: 'error', status: 'error', error: err });
    return { agent: 'competitorScraper', status: 'error', error: err, durationMs: Date.now() - start };
  }
}
