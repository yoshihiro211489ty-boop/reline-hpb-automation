import { execSync } from 'child_process';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../lib/logger.js';
import { auditLog } from '../lib/db.js';
import type { AgentResult, ImageCategory, GeneratedImage, ImageQualityResult } from '../types/index.js';

const AGENT = 'imageQualityChecker';

const SYSTEM_PROMPT = `あなたは日本の整体・骨盤矯正サロンのマーケティング画像品質チェッカーです。
以下の基準で画像を評価し、JSONのみで回答してください。

評価基準:
1. AI生成感: 指の歪み・光の不自然さ・テキストの乱れ・不自然なボケなどがあるか
2. 適切性: 日本の医療・ウェルネス業界のコンテンツとして不適切なものがないか
3. ブランド適合: リライン（清潔・プロフェッショナル・温かみ）のイメージに合っているか
4. 使用可否: HPBサロンページに掲載して問題ないか

出力JSON形式:
{
  "passed": true/false,
  "aiScore": 0-10,
  "issues": ["問題点1"],
  "suggestion": "改善のためのプロンプト修正案（問題ある場合のみ）"
}`;

function getAnthropicClient(): Anthropic {
  const apiKey = execSync(
    'security find-generic-password -s reline-anthropic -a api-key -w',
    { encoding: 'utf8' }
  ).trim();
  return new Anthropic({ apiKey });
}

function parseQualityResult(text: string): ImageQualityResult {
  // コードブロック内のJSONを優先的に抽出
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonStr = codeBlockMatch
    ? codeBlockMatch[1].trim()
    : text.match(/\{[\s\S]*\}/s)?.[0] ?? '';

  if (!jsonStr) throw new Error(`No JSON found in Claude response: ${text.slice(0, 300)}`);

  const parsed = JSON.parse(jsonStr) as {
    passed?: boolean;
    aiScore?: number;
    issues?: string[];
    suggestion?: string;
  };

  const aiScore = parsed.aiScore ?? 10;
  const issues = parsed.issues ?? [];

  // passed の自動補正: aiScore <= 5 かつ issues が空なら true
  const passed = parsed.passed !== undefined
    ? parsed.passed
    : aiScore <= 5 && issues.length === 0;

  return {
    passed,
    aiScore,
    issues,
    suggestion: parsed.suggestion,
  };
}

export async function checkImageQuality(
  imagePath: string,
  category: ImageCategory
): Promise<ImageQualityResult> {
  const client = getAnthropicClient();
  const imageData = fs.readFileSync(imagePath);
  const base64 = imageData.toString('base64');

  logger.info({ agent: AGENT, imagePath, category }, 'Checking image quality');

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: base64,
            },
          },
          {
            type: 'text',
            text: `カテゴリ: ${category}\nこの画像をHPBサロンページ掲載用として品質チェックしてください。`,
          },
        ],
      },
    ],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');

  return parseQualityResult(text);
}

export async function runImageQualityChecker(images: GeneratedImage[]): Promise<AgentResult> {
  const start = Date.now();
  logger.info({ agent: AGENT, count: images.length }, 'ImageQualityChecker started');

  const approved: GeneratedImage[] = [];
  const rejected: Array<GeneratedImage & { qualityResult: ImageQualityResult }> = [];
  const errors: string[] = [];

  for (const image of images) {
    try {
      const result = await checkImageQuality(image.localPath, image.category);
      logger.info({ agent: AGENT, imagePath: image.localPath, passed: result.passed, aiScore: result.aiScore }, 'Image quality checked');

      if (result.passed) {
        approved.push(image);
        auditLog({ agent: AGENT, event: 'image_approved', status: 'ok' });
      } else {
        rejected.push({ ...image, qualityResult: result });
        auditLog({
          agent: AGENT,
          event: 'image_rejected',
          status: 'warn',
          error: result.issues.join('; '),
        });
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error({ agent: AGENT, imagePath: image.localPath, error: err }, 'Quality check failed');
      errors.push(`${image.localPath}: ${err}`);
      auditLog({ agent: AGENT, event: 'quality_check_error', status: 'error', error: err });
    }
  }

  const status: AgentResult['status'] =
    errors.length > 0 ? 'error' :
    rejected.length > 0 ? 'warn' :
    'ok';

  logger.info(
    { agent: AGENT, approved: approved.length, rejected: rejected.length, errors: errors.length },
    'ImageQualityChecker completed'
  );
  auditLog({ agent: AGENT, event: 'completed', status });

  return {
    agent: AGENT,
    status,
    data: { approved, rejected, errors },
    error: errors.length > 0 ? errors.join('; ') : undefined,
    durationMs: Date.now() - start,
  };
}
