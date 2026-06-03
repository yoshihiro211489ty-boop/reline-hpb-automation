import { getContext } from '../lib/browser.js';
import { askClaudeJson } from '../lib/claude.js';
import { notify } from '../lib/line.js';
import { auditLog } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import type { AgentResult } from '../types/index.js';

const AGENT = 'salonboardSupervisor';
const HPB_SALON_URL = 'https://beauty.hotpepper.jp/kr/slnH000804013/';
const HPB_BLOG_URL = 'https://beauty.hotpepper.jp/kr/slnH000804013/blog/';
const HPB_REVIEW_URL = 'https://beauty.hotpepper.jp/kr/slnH000804013/review/';

interface SalonCheckResult {
  blog: {
    latestDateText: string | null;
    daysSinceLastPost: number | null;
    score: number;
    issues: string[];
  };
  review: {
    unrepliedCount: number;
    avgRating: number | null;
    totalCount: number;
    score: number;
    issues: string[];
  };
  photos: {
    count: number;
    score: number;
    issues: string[];
  };
  coupons: {
    hasCoupons: boolean;
    couponTexts: string[];
    score: number;
    issues: string[];
  };
  menu: {
    itemCount: number;
    score: number;
    issues: string[];
  };
  kodawari: {
    hasContent: boolean;
    score: number;
    issues: string[];
  };
  totalScore: number;
}

interface ClaudeAnalysis {
  suggestions: Array<{
    priority: number;
    title: string;
    detail: string;
  }>;
  summary: string;
}

async function checkSalonPage(): Promise<SalonCheckResult> {
  const context = await getContext();
  const result: SalonCheckResult = {
    blog: { latestDateText: null, daysSinceLastPost: null, score: 100, issues: [] },
    review: { unrepliedCount: 0, avgRating: null, totalCount: 0, score: 100, issues: [] },
    photos: { count: 0, score: 100, issues: [] },
    coupons: { hasCoupons: false, couponTexts: [], score: 100, issues: [] },
    menu: { itemCount: 0, score: 100, issues: [] },
    kodawari: { hasContent: false, score: 100, issues: [] },
    totalScore: 0,
  };

  const mainPage = await context.newPage();
  const blogPage = await context.newPage();
  const reviewPage = await context.newPage();

  try {
    // ── メインページチェック（写真・クーポン・メニュー・こだわり） ──────────
    await mainPage.goto(HPB_SALON_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await mainPage.waitForTimeout(2000);

    const mainData = await mainPage.evaluate(() => {
      // 写真枚数
      const photoEls = document.querySelectorAll(
        '.photoGallery img, .gallery img, [class*="photo"] img, .slnPhoto img'
      );

      // クーポン
      const couponEls = document.querySelectorAll(
        '.coupon, [class*="coupon"], .couponList li, .coupons .item'
      );
      const couponTexts = Array.from(couponEls)
        .map(el => el.textContent?.trim() ?? '')
        .filter(t => t.length > 0)
        .slice(0, 5);

      // メニュー項目数
      const menuEls = document.querySelectorAll(
        '.menuList li, .menu-item, [class*="menu"] li, .courseList li'
      );

      // こだわり
      const kodawariSection = document.querySelector(
        '[id*="kodawari"], [class*="kodawari"], .salonKodawari, section:has(h2:has-text("こだわり"))'
      );
      const kodawariText = kodawariSection?.textContent?.trim() ?? '';

      return {
        photoCount: photoEls.length,
        hasCoupons: couponEls.length > 0,
        couponTexts,
        menuItemCount: menuEls.length,
        hasKodawari: kodawariText.length > 20,
      };
    });

    // 写真チェック
    result.photos.count = mainData.photoCount;
    if (mainData.photoCount < 5) {
      result.photos.score = Math.max(0, mainData.photoCount * 15);
      result.photos.issues.push(`フォトギャラリーが ${mainData.photoCount} 枚（推奨: 5枚以上）`);
    }

    // クーポンチェック
    result.coupons.hasCoupons = mainData.hasCoupons;
    result.coupons.couponTexts = mainData.couponTexts;
    if (!mainData.hasCoupons) {
      result.coupons.score = 50;
      result.coupons.issues.push('クーポンが設定されていません');
    }

    // メニューチェック
    result.menu.itemCount = mainData.menuItemCount;
    if (mainData.menuItemCount < 3) {
      result.menu.score = Math.max(0, mainData.menuItemCount * 25);
      result.menu.issues.push(`メニュー項目が ${mainData.menuItemCount} 件（推奨: 3件以上）`);
    }

    // こだわりチェック
    result.kodawari.hasContent = mainData.hasKodawari;
    if (!mainData.hasKodawari) {
      result.kodawari.score = 40;
      result.kodawari.issues.push('こだわり情報が記載されていません');
    }

    // ── ブログチェック ──────────────────────────────────────────────────────
    await blogPage.goto(HPB_BLOG_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await blogPage.waitForTimeout(1500);

    const blogData = await blogPage.evaluate(() => {
      const dateSelectors = ['.blogList .date', '.blog-list .date', '.slnBlogList .date', 'time', '.blogDate', '.postDate'];
      for (const sel of dateSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          return el.getAttribute('datetime') ?? el.textContent?.trim() ?? null;
        }
      }
      return null;
    });

    result.blog.latestDateText = blogData;
    if (blogData) {
      const blogDate = new Date(blogData);
      const daysDiff = (Date.now() - blogDate.getTime()) / (1000 * 60 * 60 * 24);
      result.blog.daysSinceLastPost = Math.round(daysDiff);
      if (daysDiff > 7) {
        result.blog.score = Math.max(0, 100 - Math.floor(daysDiff - 7) * 5);
        result.blog.issues.push(`最終ブログ投稿から ${result.blog.daysSinceLastPost} 日経過（推奨: 7日以内）`);
      }
    } else {
      result.blog.score = 20;
      result.blog.issues.push('ブログの最終投稿日が取得できませんでした');
    }

    // ── 口コミチェック ────────────────────────────────────────────────────
    await reviewPage.goto(HPB_REVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await reviewPage.waitForTimeout(1500);

    const reviewData = await reviewPage.evaluate(() => {
      // 未返信口コミ数
      const reviewItems = document.querySelectorAll(
        '.reviewList li, .review-item, .kuchikomi-item, [class*="review"] li'
      );
      let unreplied = 0;
      let totalStars = 0;
      let starCount = 0;

      reviewItems.forEach(el => {
        const hasReply = el.querySelector('.owner-reply, .reply-body, .salonReply, [class*="reply"]');
        if (!hasReply) unreplied++;

        const starEl = el.querySelector('.star, [class*="star"], .hpbComStars');
        if (starEl) {
          const starText = starEl.textContent?.trim() ?? '';
          const match = starText.match(/(\d+(?:\.\d+)?)/);
          if (match) {
            totalStars += parseFloat(match[1]);
            starCount++;
          }
        }
      });

      return {
        totalCount: reviewItems.length,
        unreplied,
        avgRating: starCount > 0 ? totalStars / starCount : null,
      };
    });

    result.review.unrepliedCount = reviewData.unreplied;
    result.review.avgRating = reviewData.avgRating;
    result.review.totalCount = reviewData.totalCount;

    if (reviewData.unreplied > 0) {
      result.review.score = Math.max(0, 100 - reviewData.unreplied * 20);
      result.review.issues.push(`未返信の口コミが ${reviewData.unreplied} 件あります`);
    }
    if (reviewData.avgRating !== null && reviewData.avgRating < 4.0) {
      result.review.issues.push(`平均評価が ${reviewData.avgRating.toFixed(1)} （4.0未満）`);
    }

    // トータルスコア計算
    const weights = {
      blog: 0.25,
      review: 0.25,
      photos: 0.15,
      coupons: 0.15,
      menu: 0.10,
      kodawari: 0.10,
    };
    result.totalScore = Math.round(
      result.blog.score * weights.blog +
      result.review.score * weights.review +
      result.photos.score * weights.photos +
      result.coupons.score * weights.coupons +
      result.menu.score * weights.menu +
      result.kodawari.score * weights.kodawari
    );

  } finally {
    await mainPage.close().catch(() => {});
    await blogPage.close().catch(() => {});
    await reviewPage.close().catch(() => {});
  }

  return result;
}

async function analyzeWithClaude(checkResult: SalonCheckResult): Promise<ClaudeAnalysis> {
  const response = await askClaudeJson<ClaudeAnalysis>({
    system: 'あなたはホットペッパービューティーのSEO・集客の専門家です。サロンページの改善提案を日本語で行ってください。優先度（1=最重要）付きで3〜5個の具体的な改善提案をJSON形式で返してください。',
    user: `以下はリライン（米子市の姿勢・骨盤矯正サロン）のHPBページチェック結果です。
トータルスコア: ${checkResult.totalScore}/100

チェック結果:
${JSON.stringify(checkResult, null, 2)}

以下のJSON形式で回答してください:
{
  "suggestions": [
    {"priority": 1, "title": "改善項目タイトル", "detail": "具体的な改善内容"},
    ...
  ],
  "summary": "全体的な評価の一言コメント"
}`,
    temperature: 0.3,
    maxTokens: 1024,
  });

  return response;
}

export async function runSalonboardSupervisor(): Promise<AgentResult> {
  const start = Date.now();
  logger.info({ agent: AGENT, event: 'start' }, 'SalonboardSupervisor started');

  try {
    // ページチェック実行
    const checkResult = await checkSalonPage();

    logger.info({ agent: AGENT, totalScore: checkResult.totalScore }, 'Salon page check completed');

    // Claude分析
    const analysis = await analyzeWithClaude(checkResult);

    // すべての問題点を収集
    const allIssues = [
      ...checkResult.blog.issues,
      ...checkResult.review.issues,
      ...checkResult.photos.issues,
      ...checkResult.coupons.issues,
      ...checkResult.menu.issues,
      ...checkResult.kodawari.issues,
    ];

    // LINE通知メッセージ作成
    const suggestionText = analysis.suggestions
      .sort((a, b) => a.priority - b.priority)
      .map(s => `[優先度${s.priority}] ${s.title}\n  ${s.detail}`)
      .join('\n\n');

    const issueText = allIssues.length > 0
      ? `\n■ 検出した問題点:\n${allIssues.map(i => `• ${i}`).join('\n')}`
      : '';

    const lineMessage =
      `【週次サロンボード診断】\n` +
      `スコア: ${checkResult.totalScore}/100\n` +
      `${analysis.summary}${issueText}\n\n` +
      `■ 改善提案:\n${suggestionText}`;

    await notify('info', lineMessage);

    const status: AgentResult['status'] =
      checkResult.totalScore >= 80 ? 'ok' :
      checkResult.totalScore >= 60 ? 'warn' :
      'error';

    auditLog({
      agent: AGENT,
      event: 'supervisor_completed',
      status,
    });

    logger.info({ agent: AGENT, event: 'done', totalScore: checkResult.totalScore }, 'SalonboardSupervisor completed');

    return {
      agent: AGENT,
      status,
      data: {
        totalScore: checkResult.totalScore,
        checkResult,
        analysis,
        allIssues,
      },
      durationMs: Date.now() - start,
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.error({ agent: AGENT, error: err }, 'SalonboardSupervisor failed');
    auditLog({ agent: AGENT, event: 'error', status: 'error', error: err });
    return { agent: AGENT, status: 'error', error: err, durationMs: Date.now() - start };
  }
}
