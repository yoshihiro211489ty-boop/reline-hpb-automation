import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { logger } from '../lib/logger.js';
import { auditLog } from '../lib/db.js';
import type { AgentResult, ImageCategory, GeneratedImage } from '../types/index.js';

const AGENT = 'imageGenerator';

/** Unsplash カテゴリ別検索キーワード（複数から週次ローテーション） */
const UNSPLASH_QUERIES: Record<ImageCategory, string[]> = {
  kodawari: [
    'massage therapy treatment room',
    'chiropractic treatment session',
    'physical therapy back treatment',
    'osteopathy spine treatment',
    'wellness therapy private room',
    'physiotherapy hands on back',
  ],
  gallery: [
    'wellness clinic interior',
    'spa treatment room interior',
    'massage therapy room',
    'private clinic room minimalist',
    'health studio interior japan',
    'japandi spa room',
  ],
  salon: [
    'wellness studio exterior',
    'health clinic building',
    'spa exterior entrance',
    'medical clinic exterior japan',
    'beauty salon exterior modern',
    'wellness center building',
  ],
};

function getUnsplashApiKey(): string {
  return execSync('security find-generic-password -s reline-unsplash -a api-key -w', {
    encoding: 'utf8',
  }).trim();
}

function ensureImageDirs(): void {
  const categories: ImageCategory[] = ['kodawari', 'gallery', 'salon'];
  for (const cat of categories) {
    const dir = path.join(process.cwd(), 'data', 'images', cat);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/** 週番号＋カテゴリでクエリをローテーション */
function getQueryForWeek(category: ImageCategory, offset: number = 0): string {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.floor((now.getTime() - startOfYear.getTime()) / (7 * 24 * 60 * 60 * 1000));
  const categoryHash = category.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const queries = UNSPLASH_QUERIES[category];
  return queries[(weekNum + categoryHash + offset) % queries.length];
}

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (!redirectUrl) { reject(new Error('Redirect without location')); return; }
        file.close();
        fs.unlinkSync(destPath);
        downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/** Unsplash APIで画像を検索してランダムに1枚取得 */
async function fetchUnsplashImage(
  query: string,
  accessKey: string
): Promise<{ downloadUrl: string; description: string; photographer: string }> {
  const encodedQuery = encodeURIComponent(query);
  const apiUrl = `https://api.unsplash.com/search/photos?query=${encodedQuery}&per_page=30&orientation=landscape&content_filter=high`;

  return new Promise((resolve, reject) => {
    https.get(apiUrl, {
      headers: {
        'Authorization': `Client-ID ${accessKey}`,
        'Accept-Version': 'v1',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data) as {
            results?: Array<{
              urls: { regular: string; full: string };
              description: string | null;
              alt_description: string | null;
              user: { name: string };
            }>;
            errors?: string[];
          };

          if (json.errors) {
            reject(new Error(`Unsplash API error: ${json.errors.join(', ')}`));
            return;
          }

          const results = json.results ?? [];
          if (results.length === 0) {
            reject(new Error(`Unsplash: no results for query "${query}"`));
            return;
          }

          // ランダムに1枚選ぶ
          const photo = results[Math.floor(Math.random() * results.length)];
          resolve({
            downloadUrl: photo.urls.regular,
            description: photo.description ?? photo.alt_description ?? query,
            photographer: photo.user.name,
          });
        } catch (e) {
          reject(new Error(`Failed to parse Unsplash response: ${String(e)}`));
        }
      });
    }).on('error', reject);
  });
}

export async function generateImage(category: ImageCategory, index: number): Promise<GeneratedImage> {
  const accessKey = getUnsplashApiKey();
  const query = getQueryForWeek(category, index);
  const timestamp = Date.now();

  logger.info({ agent: AGENT, category, query }, `Fetching Unsplash image for category: ${category}`);

  const { downloadUrl, description, photographer } = await fetchUnsplashImage(query, accessKey);

  const localPath = path.join(process.cwd(), 'data', 'images', category, `${timestamp}.jpg`);
  await downloadFile(downloadUrl, localPath);

  logger.info({ agent: AGENT, category, localPath, photographer }, 'Unsplash image downloaded');

  return {
    localPath,
    category,
    prompt: `Unsplash: "${query}" by ${photographer} — ${description}`,
    generatedAt: new Date().toISOString(),
  };
}

export async function runImageGenerator(categories: ImageCategory[]): Promise<AgentResult> {
  const start = Date.now();
  logger.info({ agent: AGENT, categories }, 'ImageGenerator (Unsplash) started');
  ensureImageDirs();

  // Unsplash APIキーが設定されているか確認
  let hasApiKey = false;
  try {
    getUnsplashApiKey();
    hasApiKey = true;
  } catch {
    logger.warn({ agent: AGENT }, 'Unsplash API key not set, skipping image generation');
    return {
      agent: AGENT,
      status: 'warn',
      data: { generated: [], errors: ['Unsplash APIキーが未設定です'] },
      error: 'Unsplash APIキーが未設定です。setup-keychain.sh を実行してください。',
      durationMs: Date.now() - start,
    };
  }

  if (!hasApiKey) {
    return {
      agent: AGENT,
      status: 'warn',
      data: { generated: [], errors: [] },
      durationMs: Date.now() - start,
    };
  }

  const generated: GeneratedImage[] = [];
  const errors: string[] = [];

  for (let i = 0; i < categories.length; i++) {
    const category = categories[i];
    try {
      const image = await generateImage(category, i);
      generated.push(image);
      auditLog({ agent: AGENT, event: 'image_fetched', status: 'ok' });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error({ agent: AGENT, category, error: err }, 'Image fetch failed');
      errors.push(`${category}: ${err}`);
      auditLog({ agent: AGENT, event: 'image_fetch_failed', status: 'error', error: err });
    }
  }

  const status: AgentResult['status'] = errors.length === 0 ? 'ok' : generated.length > 0 ? 'warn' : 'error';

  logger.info({ agent: AGENT, generated: generated.length, errors: errors.length }, 'ImageGenerator completed');
  auditLog({ agent: AGENT, event: 'completed', status });

  return {
    agent: AGENT,
    status,
    data: { generated, errors },
    error: errors.length > 0 ? errors.join('; ') : undefined,
    durationMs: Date.now() - start,
  };
}
