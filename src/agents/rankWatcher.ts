import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { rankRepo, auditLog } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { getConfig } from '../lib/config.js';
import type { RankResult, AgentResult } from '../types/index.js';

function loadKeywords(): string[] {
  const raw = fs.readFileSync(path.join(process.cwd(), 'config', 'keywords.yaml'), 'utf8');
  const config = yaml.parse(raw) as { rank_keywords: string[] };
  return config.rank_keywords;
}

async function searchHpbKeyword(keyword: string, salonId: string): Promise<number | null> {
  const encoded = encodeURIComponent(keyword);
  const url = `https://beauty.hotpepper.jp/svcST/editR/search/?keyword=${encoded}&siteB=all`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'ja-JP,ja;q=0.9',
    },
  });

  if (!res.ok) return null;
  const html = await res.text();
  const $ = cheerio.load(html);

  let rank = 0;
  let found = false;
  $('.salonList li, [class*="salonBlock"]').each((_, el) => {
    rank++;
    const href = $(el).find('a').attr('href') ?? '';
    if (href.includes(salonId)) {
      found = true;
      return false;
    }
  });

  return found ? rank : null;
}

export async function runRankWatcher(): Promise<AgentResult> {
  const start = Date.now();
  const config = getConfig();
  const salonId = config.salon.hpb_salon_id;
  const keywords = loadKeywords();

  logger.info({ agent: 'rankWatcher', event: 'start', keywordCount: keywords.length }, 'Watching ranks');

  const results: RankResult[] = [];
  const capturedAt = new Date().toISOString();

  for (const keyword of keywords) {
    try {
      const rank = await searchHpbKeyword(keyword, salonId);
      results.push({ keyword, rank, capturedAt });
      logger.info({ agent: 'rankWatcher', keyword, rank }, `Rank: ${rank ?? 'not found (>30)'}`);
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
    } catch (error) {
      logger.warn({ agent: 'rankWatcher', keyword, error: String(error) }, 'Rank check failed');
      results.push({ keyword, rank: null, capturedAt });
    }
  }

  rankRepo.save(results);
  auditLog({ agent: 'rankWatcher', event: 'completed', status: 'ok' });

  return { agent: 'rankWatcher', status: 'ok', data: { results }, durationMs: Date.now() - start };
}
