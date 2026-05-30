import fs from 'fs';
import path from 'path';
import { db, rankRepo } from '../lib/db.js';
import { notify } from '../lib/line.js';
import { logger } from '../lib/logger.js';
import { getConfig } from '../lib/config.js';
import type { AgentResult } from '../types/index.js';

interface WeeklyStats {
  reviewsTotal: number;
  reviewsThisWeek: number;
  avgRating: number | null;
  autoReplyCount: number;
  autoReplyRate: number;
  blogsThisWeek: number;
  topCompetitor: { name: string; reviewCount: number; avgRating: number | null } | null;
  rankSummary: Array<{ keyword: string; current: number | null; prev: number | null; delta: number | null }>;
}

function collectStats(): WeeklyStats {
  const reviewsTotal = (db.prepare('SELECT COUNT(*) as cnt FROM reviews').get() as { cnt: number }).cnt;
  const reviewsThisWeek = (db.prepare(`
    SELECT COUNT(*) as cnt FROM reviews WHERE captured_at >= datetime('now', '-7 days')
  `).get() as { cnt: number }).cnt;

  const avgRow = db.prepare('SELECT AVG(star_rating) as avg FROM reviews').get() as { avg: number | null };
  const avgRating = avgRow.avg ? Math.round(avgRow.avg * 10) / 10 : null;

  const autoReplyCount = (db.prepare(`
    SELECT COUNT(*) as cnt FROM review_posts WHERE status = 'posted' AND posted_at >= datetime('now', '-7 days')
  `).get() as { cnt: number }).cnt;
  const autoReplyRate = reviewsThisWeek > 0 ? Math.round((autoReplyCount / reviewsThisWeek) * 100) : 0;

  const blogsThisWeek = (db.prepare(`
    SELECT COUNT(*) as cnt FROM blog_posts WHERE status = 'posted' AND posted_at >= datetime('now', '-7 days')
  `).get() as { cnt: number }).cnt;

  const topCompetitor = db.prepare(`
    SELECT name, review_count, avg_rating FROM competitor_snapshots
    ORDER BY review_count DESC LIMIT 1
  `).get() as { name: string; review_count: number; avg_rating: number | null } | undefined;

  const config = getConfig();
  const keywords = (db.prepare('SELECT DISTINCT keyword FROM rank_results').all() as { keyword: string }[]).map(r => r.keyword);
  const rankSummary = keywords.slice(0, 5).map(keyword => {
    const history = rankRepo.history(keyword, 2);
    const current = history[0]?.rank ?? null;
    const prev = history[1]?.rank ?? null;
    const delta = current && prev ? prev - current : null;
    return { keyword, current, prev, delta };
  });

  return {
    reviewsTotal,
    reviewsThisWeek,
    avgRating,
    autoReplyCount,
    autoReplyRate,
    blogsThisWeek,
    topCompetitor: topCompetitor
      ? { name: topCompetitor.name, reviewCount: topCompetitor.review_count, avgRating: topCompetitor.avg_rating }
      : null,
    rankSummary,
  };
}

function generateHtmlReport(stats: WeeklyStats, weekLabel: string): string {
  const rankRows = stats.rankSummary.map(r => {
    const delta = r.delta !== null ? (r.delta > 0 ? `↑${r.delta}` : r.delta < 0 ? `↓${Math.abs(r.delta)}` : '→') : '-';
    const currentDisplay = r.current ?? '圏外';
    return `<tr><td>${r.keyword}</td><td>${currentDisplay}位</td><td>${r.prev ?? '-'}位</td><td>${delta}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>リライン 週次KPIレポート ${weekLabel}</title>
<style>
  body { font-family: sans-serif; max-width: 800px; margin: 40px auto; color: #333; }
  h1 { color: #2c5282; } h2 { color: #4a5568; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 24px 0; }
  .kpi-card { background: #f7fafc; border-radius: 8px; padding: 16px; text-align: center; }
  .kpi-value { font-size: 2em; font-weight: bold; color: #2b6cb0; }
  .kpi-label { font-size: 0.85em; color: #718096; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th { background: #ebf4ff; padding: 8px 12px; text-align: left; }
  td { padding: 8px 12px; border-bottom: 1px solid #e2e8f0; }
  .tag { display: inline-block; background: #ebf4ff; color: #2b6cb0; border-radius: 4px; padding: 2px 8px; font-size: 0.8em; }
</style>
</head>
<body>
<h1>☀ リライン 週次KPIレポート</h1>
<p>${weekLabel}</p>

<h2>口コミ</h2>
<div class="kpi-grid">
  <div class="kpi-card"><div class="kpi-value">${stats.reviewsTotal}</div><div class="kpi-label">口コミ累計</div></div>
  <div class="kpi-card"><div class="kpi-value">+${stats.reviewsThisWeek}</div><div class="kpi-label">今週の新着</div></div>
  <div class="kpi-card"><div class="kpi-value">${stats.avgRating ?? '-'}</div><div class="kpi-label">平均評価（★）</div></div>
  <div class="kpi-card"><div class="kpi-value">${stats.autoReplyCount}</div><div class="kpi-label">自動返信済み</div></div>
  <div class="kpi-card"><div class="kpi-value">${stats.autoReplyRate}%</div><div class="kpi-label">自動返信率</div></div>
  <div class="kpi-card"><div class="kpi-value">${stats.blogsThisWeek}</div><div class="kpi-label">今週ブログ投稿</div></div>
</div>

<h2>検索順位（上位5キーワード）</h2>
<table>
  <tr><th>キーワード</th><th>今週</th><th>前週</th><th>変動</th></tr>
  ${rankRows}
</table>

${stats.topCompetitor ? `
<h2>競合トップ</h2>
<p>${stats.topCompetitor.name}（口コミ${stats.topCompetitor.reviewCount}件 / 平均${stats.topCompetitor.avgRating ?? '-'}★）</p>
` : ''}

<hr>
<p style="font-size:0.8em;color:#a0aec0;">生成: ${new Date().toLocaleString('ja-JP')}</p>
</body>
</html>`;
}

export async function runWeeklyReporter(): Promise<AgentResult> {
  const start = Date.now();
  logger.info({ agent: 'weeklyReporter', event: 'start' }, 'Generating weekly report');

  try {
    const stats = collectStats();
    const weekLabel = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });

    const reportsDir = path.join(process.cwd(), 'reports', 'weekly');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

    const dateStr = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(reportsDir, `${dateStr}.html`);
    const html = generateHtmlReport(stats, weekLabel);
    fs.writeFileSync(reportPath, html, 'utf8');

    const rankLines = stats.rankSummary
      .map(r => `  「${r.keyword}」: ${r.current ?? '圏外'}位${r.delta ? ` (${r.delta > 0 ? '↑' : '↓'}${Math.abs(r.delta)})` : ''}`)
      .join('\n');

    const lineMessage = [
      `【週次レポート】${weekLabel}`,
      ``,
      `口コミ: 累計${stats.reviewsTotal}件 (今週+${stats.reviewsThisWeek}) / 平均${stats.avgRating ?? '-'}★`,
      `自動返信: ${stats.autoReplyCount}件 (${stats.autoReplyRate}%)`,
      `ブログ投稿: 今週${stats.blogsThisWeek}件`,
      ``,
      `検索順位:`,
      rankLines,
      ``,
      `詳細レポート: ${reportPath}`,
    ].join('\n');

    await notify('info', lineMessage);

    logger.info({ agent: 'weeklyReporter', reportPath }, 'Weekly report generated');
    return { agent: 'weeklyReporter', status: 'ok', data: { reportPath, stats }, durationMs: Date.now() - start };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.error({ agent: 'weeklyReporter', error: err }, 'WeeklyReporter failed');
    return { agent: 'weeklyReporter', status: 'error', error: err, durationMs: Date.now() - start };
  }
}
