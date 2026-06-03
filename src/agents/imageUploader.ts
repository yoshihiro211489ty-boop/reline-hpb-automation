import path from 'path';
import fs from 'fs';
import { loginToSalonboard, humanDelay } from '../lib/browser.js';
import { isDryRun } from '../lib/config.js';
import { auditLog } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { getLogDir } from '../lib/logger.js';
import type { AgentResult, ImageCategory, GeneratedImage } from '../types/index.js';
import type { Page } from 'playwright';

const AGENT = 'imageUploader';

/** カテゴリ別のサロンボード管理画面URL */
const UPLOAD_URLS: Record<ImageCategory, string> = {
  kodawari: 'https://salonboard.com/KLP/draft/salonInfoKodawari/',
  gallery: 'https://salonboard.com/KLP/draft/salonPhotoGallery/',
  salon: 'https://salonboard.com/KLP/draft/salonInfo/',
};

/** カテゴリ別のキャプション生成 */
function generateCaption(category: ImageCategory, index: number): string {
  const captions: Record<ImageCategory, string[]> = {
    kodawari: [
      '国家資格を持つ院長による丁寧な施術。iPad視覚化診断で根本から整えます。',
      '姿勢・骨盤矯正の専門家が、一人ひとりに合わせた施術を提供します。',
      '累計施術7万回以上の実績。科学的アプローチで根本改善を目指します。',
    ],
    gallery: [
      '清潔感あふれる完全個室の施術スペース。リラックスできる空間をご用意しています。',
      '落ち着いた雰囲気のサロン内。プライバシーを守りながら施術を受けられます。',
      '明るく清潔な院内。心地よい空間で施術を受けていただけます。',
    ],
    salon: [
      '米子市西福原6丁目。駐車場完備で通いやすい立地です。',
      'リライン（ReLINE）の外観。アクセスしやすい場所にあります。',
      '米子市の姿勢・骨盤矯正専門サロン「リライン」。お気軽にお越しください。',
    ],
  };
  const list = captions[category];
  return list[index % list.length];
}

function getImagesLogDir(): string {
  const logDir = getLogDir();
  const imagesDir = path.join(logDir, 'images');
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }
  return imagesDir;
}

async function uploadImageToSalonboard(
  page: Page,
  image: GeneratedImage,
  index: number
): Promise<{ success: boolean; error?: string; screenshotPath?: string }> {
  const imagesDir = getImagesLogDir();
  const screenshotPath = path.join(imagesDir, `upload-${image.category}-${Date.now()}.png`);

  try {
    const uploadUrl = UPLOAD_URLS[image.category];
    await page.goto(uploadUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(1000, 2000);

    // ファイル入力要素を探してファイルをセット
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      logger.warn({ agent: AGENT, category: image.category }, 'File input not found, trying alternate selector');
      // セレクターが見つからない場合は別の方法を試みる
      const altInput = await page.$('input[accept*="image"], input[accept*="jpg"], input[accept*="png"]');
      if (!altInput) throw new Error(`ファイル入力フィールドが見つかりません (${uploadUrl})`);
      await altInput.setInputFiles(image.localPath);
    } else {
      await fileInput.setInputFiles(image.localPath);
    }
    await humanDelay(1000, 2000);

    // キャプション入力（存在する場合）
    const caption = generateCaption(image.category, index);
    const captionInput = await page.$(
      'input[name*="caption"], textarea[name*="caption"], input[name*="comment"], textarea[name*="comment"], input[name*="alt"], input[name*="text"]'
    );
    if (captionInput) {
      await captionInput.click();
      await captionInput.fill(caption);
      await humanDelay(500, 800);
    }

    // 保存・アップロードボタンをクリック
    const saveBtn = await page.$(
      'button[type="submit"], input[type="submit"], a:has-text("保存"), a:has-text("登録"), button:has-text("アップロード"), a:has-text("アップロード")'
    );
    if (saveBtn) {
      await saveBtn.click();
      await humanDelay(1500, 2500);
    }

    await page.screenshot({ path: screenshotPath });
    logger.info({ agent: AGENT, category: image.category, screenshotPath }, 'Image uploaded');

    return { success: true, screenshotPath };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    await page.screenshot({ path: screenshotPath }).catch(() => {});
    logger.error({ agent: AGENT, category: image.category, error: err }, 'Image upload failed');
    return { success: false, error: err, screenshotPath };
  }
}

export async function runImageUploader(approvedImages: GeneratedImage[]): Promise<AgentResult> {
  const start = Date.now();
  const dryRun = isDryRun();
  logger.info({ agent: AGENT, count: approvedImages.length, dryRun }, 'ImageUploader started');

  if (approvedImages.length === 0) {
    logger.info({ agent: AGENT }, 'No approved images to upload');
    return {
      agent: AGENT,
      status: 'ok',
      data: { uploaded: 0, skipped: 0, errors: [] },
      durationMs: Date.now() - start,
    };
  }

  if (dryRun) {
    logger.info({ agent: AGENT, dryRun: true, images: approvedImages.map(i => i.localPath) }, '[DRY RUN] Would upload images');
    auditLog({ agent: AGENT, event: 'dry_run', status: 'dry_run' });
    return {
      agent: AGENT,
      status: 'ok',
      data: { status: 'dry_run', images: approvedImages },
      durationMs: 0,
    };
  }

  let page: Awaited<ReturnType<typeof loginToSalonboard>> | null = null;
  const results: Array<{ image: GeneratedImage; success: boolean; error?: string; screenshotPath?: string }> = [];

  try {
    page = await loginToSalonboard();

    for (let i = 0; i < approvedImages.length; i++) {
      const image = approvedImages[i];
      const result = await uploadImageToSalonboard(page, image, i);
      results.push({ image, ...result });

      auditLog({
        agent: AGENT,
        event: result.success ? 'image_uploaded' : 'upload_failed',
        screenshotPaths: result.screenshotPath ? [result.screenshotPath] : [],
        status: result.success ? 'ok' : 'error',
        error: result.error,
      });

      // 連続リクエスト間に待機
      if (i < approvedImages.length - 1) {
        await humanDelay(2000, 4000);
      }
    }

    const uploaded = results.filter(r => r.success).length;
    const errors = results.filter(r => !r.success).map(r => r.error ?? 'unknown error');

    const status: AgentResult['status'] =
      errors.length === 0 ? 'ok' :
      uploaded > 0 ? 'warn' :
      'error';

    logger.info({ agent: AGENT, uploaded, errors: errors.length }, 'ImageUploader completed');
    auditLog({ agent: AGENT, event: 'completed', status });

    return {
      agent: AGENT,
      status,
      data: { uploaded, errors, results },
      error: errors.length > 0 ? errors.join('; ') : undefined,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.error({ agent: AGENT, error: err }, 'Unexpected error in imageUploader');
    auditLog({ agent: AGENT, event: 'error', status: 'error', error: err });
    return { agent: AGENT, status: 'error', error: err, durationMs: Date.now() - start };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
