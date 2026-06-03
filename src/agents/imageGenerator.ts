import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { logger } from '../lib/logger.js';
import { auditLog } from '../lib/db.js';
import type { AgentResult, ImageCategory, GeneratedImage } from '../types/index.js';

const AGENT = 'imageGenerator';

const IMAGE_PROMPTS: Record<ImageCategory, string> = {
  kodawari:
    'Professional Japanese osteopathy clinic treatment room, practitioner performing spinal alignment therapy on patient lying on treatment table, medical professional wearing white coat, bright professional lighting, 4K photorealistic, clean minimalist interior, no faces visible, shot from side angle',
  gallery:
    'Interior of modern Japanese wellness clinic, clean white walls, wooden accents, reception area with plants, bright natural lighting, waiting area with comfortable seating, professional and welcoming atmosphere, photorealistic 4K, no people',
  salon:
    'Exterior of Japanese wellness clinic building in Yonago Japan, professional signage, clean modern facade, daytime, blue sky, entrance visible, photorealistic 4K',
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

export async function generateImage(category: ImageCategory, index: number): Promise<GeneratedImage> {
  const client = getOpenAIClient();
  const prompt = IMAGE_PROMPTS[category];
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
