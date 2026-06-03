import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { logger } from '../lib/logger.js';
import { auditLog } from '../lib/db.js';
import type { AgentResult, ImageCategory, GeneratedImage } from '../types/index.js';

const AGENT = 'imageGenerator';

/** カテゴリ別・バリエーション別プロンプト（毎週ローテーションして構図が被らないようにする） */
const IMAGE_PROMPT_VARIANTS: Record<ImageCategory, string[]> = {
  kodawari: [
    'Professional Japanese posture correction clinic, empty treatment room, beige massage table centered, soft warm overhead lighting, light wood floor, white walls, minimal decor, small potted green plant in corner, calm and serene atmosphere, photorealistic, ultra high detail, absolutely NO text NO letters NO signs NO writing NO labels NO posters NO charts of any kind anywhere in the image',
    'Japanese osteopathy clinic interior, treatment bed with clean white pillow and beige cover, gentle natural light from frosted window, wooden shelves with neatly folded white towels, tranquil private room feel, photorealistic, ultra high detail, absolutely NO text NO letters NO signs NO writing NO labels NO charts NO posters anywhere in the image',
    'Minimalist Japanese wellness clinic treatment room, overhead view angle, padded treatment table, neutral beige and cream tones, wooden accent wall, soft ambient lighting, small succulent on shelf, private and professional atmosphere, photorealistic, ultra high detail, strictly NO text NO letters NO words NO signs NO writing NO diagrams anywhere in the image',
    'Cozy Japanese chiropractic clinic room, treatment table with fresh white cover, warm LED lighting, pale wood flooring, clean white ceiling, small green plant beside window, professional and welcoming, photorealistic, ultra high detail, no text no letters no signs no writing no labels no posters no charts anywhere',
  ],
  gallery: [
    'Interior of modern Japanese wellness clinic reception area, clean white desk, light wood accents, small indoor plants, bright natural light from large windows, comfortable waiting chairs in neutral tones, professional and warm atmosphere, photorealistic, ultra high detail, absolutely NO text NO letters NO signs NO writing NO labels NO logos anywhere in the image',
    'Japanese posture clinic lobby interior, minimalist design, white and beige palette, wooden bench seating, potted leafy plant, soft indirect ceiling lighting, calm and welcoming space, photorealistic, ultra high detail, absolutely NO text NO letters NO words NO signs NO writing anywhere in the image',
    'Modern Japanese clinic hallway, clean corridor with white walls and wood floor, gentle ambient lighting, small decorative plant at end of hall, private room doors closed, serene professional environment, photorealistic, ultra high detail, strictly NO text NO letters NO signs NO writing NO labels anywhere in the image',
    'Peaceful Japanese health clinic interior, cream colored walls, natural wood furniture, single comfortable chair by window, sheer curtain with soft natural light, small green plant, clean and uncluttered, photorealistic, ultra high detail, no text no letters no signs no writing no labels no logos anywhere',
  ],
  salon: [
    'Exterior of a small modern Japanese health clinic building, clean white facade, simple architectural lines, manicured small shrub by entrance, clear blue sky, daytime, suburban Japan, photorealistic, ultra high detail, absolutely NO text NO letters NO signs NO writing NO logos NO storefront text anywhere in the image',
    'Front view of a tidy Japanese wellness clinic exterior, light gray exterior walls, glass entrance door, small potted plant by doorstep, sunny day, clean neighborhood street, professional appearance, photorealistic, ultra high detail, absolutely NO text NO letters NO words NO signs NO writing NO logos anywhere in the image',
    'Japanese clinic building entrance close-up, frosted glass door, clean tile entryway, potted green plant beside door, warm sunlight, calm residential area, photorealistic, ultra high detail, strictly NO text NO letters NO signs NO writing NO logos NO building names anywhere in the image',
    'Exterior side angle of a small Japanese medical clinic, white stucco walls, tidy landscaping with low green bushes, paved parking area, blue sky with light clouds, photorealistic, ultra high detail, no text no letters no signs no writing no logos no storefront text anywhere in the image',
  ],
};

function getOpenAIClient(): OpenAI {
  const apiKey = execSync('security find-generic-password -s reline-openai -a api-key -w', {
    encoding: 'utf8',
  }).trim();
  return new OpenAI({ apiKey });
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

/** 今週の週番号を返す（0始まり）。バリアント選択に使用 */
function getWeekVariantIndex(category: ImageCategory, offset: number = 0): number {
  const now = new Date();
  // ISO週番号 + カテゴリのハッシュ + offset でバリアントを選ぶ
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.floor((now.getTime() - startOfYear.getTime()) / (7 * 24 * 60 * 60 * 1000));
  const categoryHash = category.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const variants = IMAGE_PROMPT_VARIANTS[category];
  return (weekNum + categoryHash + offset) % variants.length;
}

export async function generateImage(category: ImageCategory, index: number): Promise<GeneratedImage> {
  const client = getOpenAIClient();
  const variantIndex = getWeekVariantIndex(category, index);
  const prompt = IMAGE_PROMPT_VARIANTS[category][variantIndex];
  const timestamp = Date.now();

  logger.info({ agent: AGENT, category, index }, `Generating image for category: ${category}`);

  const response = await client.images.generate({
    model: 'gpt-image-1',
    prompt,
    size: '1024x1024',
    quality: 'high',
    n: 1,
  });

  const data = response.data ?? [];
  const item = data[0];
  if (!item) throw new Error(`gpt-image-1 returned no image data for category: ${category}`);

  const localPath = path.join(process.cwd(), 'data', 'images', category, `${timestamp}.png`);

  if (item.b64_json) {
    // gpt-image-1 returns base64-encoded PNG
    const buf = Buffer.from(item.b64_json, 'base64');
    fs.writeFileSync(localPath, buf);
    logger.info({ agent: AGENT, category, localPath }, 'Image saved from base64');
  } else {
    throw new Error(`gpt-image-1 returned no image content for category: ${category}`);
  }

  return {
    localPath,
    category,
    prompt,
    generatedAt: new Date().toISOString(),
  };
}

export async function runImageGenerator(categories: ImageCategory[]): Promise<AgentResult> {
  const start = Date.now();
  logger.info({ agent: AGENT, categories }, 'ImageGenerator started');
  ensureImageDirs();

  const generated: GeneratedImage[] = [];
  const errors: string[] = [];

  for (let i = 0; i < categories.length; i++) {
    const category = categories[i];
    try {
      const image = await generateImage(category, i);
      generated.push(image);
      auditLog({
        agent: AGENT,
        event: 'image_generated',
        status: 'ok',
      });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error({ agent: AGENT, category, error: err }, 'Image generation failed');
      errors.push(`${category}: ${err}`);
      auditLog({ agent: AGENT, event: 'image_generation_failed', status: 'error', error: err });
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
