import path from 'path';
import { loginToSalonboard, humanDelay } from '../lib/browser.js';
import { isDryRun } from '../lib/config.js';
import { blogRepo, auditLog } from '../lib/db.js';
import { getBlogsDir } from '../lib/logger.js';
import { logger } from '../lib/logger.js';
import type { BlogDraft, BlogPostResult, AgentResult } from '../types/index.js';
import type { Page } from 'playwright';

const SALONBOARD_BLOG_NEW_URL = 'https://salonboard.com/KLP/blog/blog/';

/** マークダウンをプレーンテキストに変換（コードブロック・装飾・禁止文字除去） */
function markdownToPlainText(md: string): string {
  return md
    // コードブロック除去（```markdown ... ``` 形式）
    .replace(/^```[\w]*\n?/gm, '')
    .replace(/```\s*$/gm, '')
    // 見出し行を完全除去（タイトル重複防止）
    .replace(/^#+\s+.*$/gm, '')
    // 太字・斜体除去
    .replace(/\*\*(.*?)\*\*/gs, '$1')
    .replace(/\*(.*?)\*/gs, '$1')
    // 水平線除去
    .replace(/^---+$/gm, '')
    .replace(/^===+$/gm, '')
    // リスト記号除去
    .replace(/^[-・]\s+/gm, '')
    // SalonBoard 利用不可文字除去（①②③ など丸数字 / 特殊記号）
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/g, '')
    // 連続改行を最大1行に圧縮（改行80回制限対策）
    .replace(/\n{2,}/g, '\n')
    // 先頭末尾の空白除去
    .trim();
}

/** SalonBoard の本文上限（全角1000字）に合わせてトランケート */
function truncateBody(text: string, max = 950): string {
  if (text.length <= max) return text;
  // 文の境界で切る（。で終わる箇所）
  const truncated = text.slice(0, max);
  const lastSentence = truncated.lastIndexOf('。');
  return lastSentence > max * 0.7 ? truncated.slice(0, lastSentence + 1) : truncated.trim();
}

/** タイトルを25文字以内に収める */
function truncateTitle(title: string, max = 25): string {
  return title.length <= max ? title : title.slice(0, max);
}

async function postBlogToSalonboard(page: Page, draft: BlogDraft): Promise<BlogPostResult> {
  const blogsDir = getBlogsDir();
  const screenshotPath = path.join(blogsDir, `blog-${Date.now()}-after.png`);

  try {
    // ブログ新規投稿ページへ直接移動
    await page.goto(SALONBOARD_BLOG_NEW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(1000, 2000);

    // 投稿者を選択（武田 嘉浩 / value: F000777262）
    const authorSelect = await page.$('#staffId, select[name="staffId"]');
    if (authorSelect) {
      await authorSelect.selectOption({ value: 'F000777262' }).catch(() =>
        authorSelect.selectOption({ label: '武田 嘉浩' })
      );
      await humanDelay(500, 800);
    }

    // カテゴリを「サロンのNEWS」（KL02）に設定
    const categorySelect = await page.$('#blogCategoryCd, select[name="blogCategoryCd"]');
    if (categorySelect) {
      await categorySelect.selectOption({ value: 'KL02' }).catch(() =>
        categorySelect.selectOption({ label: 'サロンのNEWS' })
      );
      await humanDelay(300, 600);
    }

    // タイトルを入力（#blogTitle）
    const titleInput = await page.$('#blogTitle, input[name="title"]');
    if (!titleInput) throw new Error('タイトルフィールドが見つかりません(#blogTitle)');
    const title = truncateTitle(draft.idea.title);
    await titleInput.click();
    await titleInput.fill(title);
    await humanDelay(500, 1000);

    // 本文を NicEdit(.nicEdit-main) と hidden textarea(#blogContents1) 両方へ設定
    // SalonBoard は全角1000字制限なので950字以内にトランケート
    const bodyText = truncateBody(markdownToPlainText(draft.content));
    const bodyEl = await page.$('.nicEdit-main');
    if (!bodyEl) throw new Error('本文エディタ(.nicEdit-main)が見つかりません');

    await bodyEl.click();
    await humanDelay(300, 500);

    // execCommand 方式でテキスト挿入（HTML タグ不使用・改行カウント正確）
    await page.evaluate((text: string) => {
      const nicMain = document.querySelector('.nicEdit-main') as HTMLElement | null;
      const hiddenTA = document.getElementById('blogContents1') as HTMLTextAreaElement | null;
      if (!nicMain) return;

      // nicEdit-main フォーカス後、全選択して挿入
      nicMain.focus();
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);

      // hidden textarea にも書き込む（NicEdit の sync が遅れた場合の保険）
      if (hiddenTA) {
        hiddenTA.value = text;
        hiddenTA.dispatchEvent(new Event('input', { bubbles: true }));
        hiddenTA.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, bodyText);

    await humanDelay(1500, 2000);

    // 「確認する」ボタン（id="confirm"）をクリック
    const confirmBtn = await page.$('#confirm, a.mod_btn_confirm_03');
    if (!confirmBtn) throw new Error('確認するボタンが見つかりません(#confirm)');
    await confirmBtn.click();
    await page.waitForURL('**/confirm**', { timeout: 20000 });
    await humanDelay(1000, 1500);

    // 確認ページの「登録・反映する」ボタンをクリック
    const submitBtn = await page.$('a:has-text("登録・反映する"), a[id*="regist"], button:has-text("登録")');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.click('text=登録・反映する');
    }
    await page.waitForURL('**/complete**', { timeout: 20000 });
    await humanDelay(1000, 1500);

    await page.screenshot({ path: screenshotPath });
    logger.info({ agent: 'blogPoster', url: page.url(), screenshot: screenshotPath }, 'Blog posted');

    return {
      status: 'posted',
      url: page.url(),
      screenshotAfter: screenshotPath,
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.error({ agent: 'blogPoster', error: err }, 'Blog posting failed');
    await page.screenshot({ path: screenshotPath }).catch(() => {});
    return { status: 'failed', error: err, screenshotAfter: screenshotPath };
  }
}

export async function runBlogPoster(draft: BlogDraft, draftId: number): Promise<AgentResult> {
  const start = Date.now();
  const dryRun = isDryRun();

  logger.info({ agent: 'blogPoster', title: draft.idea.title, dryRun }, 'Posting blog');

  if (dryRun) {
    blogRepo.savePostResult(draftId, { status: 'dry_run' });
    auditLog({
      agent: 'blogPoster',
      event: 'dry_run',
      blogId: draftId,
      draftText: draft.content.slice(0, 200),
      status: 'dry_run',
    });
    logger.info({ agent: 'blogPoster', draftId, dryRun: true }, '[DRY RUN] Would post blog');
    return { agent: 'blogPoster', status: 'ok', data: { status: 'dry_run' }, durationMs: 0 };
  }

  let page: Awaited<ReturnType<typeof loginToSalonboard>> | null = null;

  try {
    page = await loginToSalonboard();
    const result = await postBlogToSalonboard(page, draft);
    blogRepo.savePostResult(draftId, result);

    auditLog({
      agent: 'blogPoster',
      event: result.status === 'posted' ? 'posted' : 'failed',
      blogId: draftId,
      postedText: draft.content.slice(0, 500),
      screenshotPaths: result.screenshotAfter ? [result.screenshotAfter] : [],
      status: result.status === 'posted' ? 'ok' : 'error',
      error: result.error,
    });

    return {
      agent: 'blogPoster',
      status: result.status === 'posted' ? 'ok' : 'error',
      error: result.error,
      data: result,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.error({ agent: 'blogPoster', error: err }, 'Unexpected error in blogPoster');
    blogRepo.savePostResult(draftId, { status: 'failed', error: err });
    auditLog({
      agent: 'blogPoster',
      event: 'failed',
      blogId: draftId,
      status: 'error',
      error: err,
    });
    return {
      agent: 'blogPoster',
      status: 'error',
      error: err,
      data: { error: err },
      durationMs: Date.now() - start,
    };
  } finally {
    if (page) await page.close();
  }
}
