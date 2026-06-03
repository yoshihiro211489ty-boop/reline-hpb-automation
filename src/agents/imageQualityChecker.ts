import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../lib/logger.js';
import { auditLog } from '../lib/db.js';
import type { AgentResult, ImageCategory, GeneratedImage, ImageQualityResult } from '../types/index.js';

const AGENT = 'imageQualityChecker';

const SYSTEM_PROMPT = `あなたは日本の整体・骨盤矯正サロンのマーケティング画像品質チェッカーです。
以下の基準で画像を評価し、JSONのみで回答してください。

評価基準:
1. 文字・テキスト混入: 画像内に文字・数字・記号・看板テキスト・ポスター文字・解剖図テキスト・ロゴ等が一切ないか（最重要・1文字でも不合格）
2. AI生成感: 指の歪み・光の不自然さ・不自然なボケ・現実的でない素材感などがあるか
3. 適切性: 日本の医療・ウェルネス業界のコンテンツとして不適切なものがないか（暴力・成人・不快感等）
4. ブランド適合: リライン（清潔・プロフェッショナル・温かみ）のイメージに合っているか
5. 使用可否: HPBサロンページに掲載して問題ないか

出力JSON形式:
{
  "passed": true/false,
  "hasText": true/false,
  "textDescription": "検出した文字・テキストの説明（なければnull）",
  "aiScore": 0-10,
  "issues": ["問題点1", "問題点2"],
  "suggestion": "改善のためのプロンプト修正案（問題ある場合のみ）"
}

重要: hasTextがtrueの場合は必ずpassedをfalseにしてください。`;

function getAnthropicClient(): Anthropic {
  const apiKey = execSync(
    'security find-generic-password -s reline-anthropic -a api-key -w',
    { encoding: 'utf8' }
  ).trim();
  return new Anthropic({ apiKey });
}

function parseQualityResult(text: string): ImageQualityResult & { hasText: boolean; textDescription: string | null } {
  // コードブロック内のJSONを優先的に抽出
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonStr = codeBlockMatch
    ? codeBlockMatch[1].trim()
    : text.match(/\{[\s\S]*\}/s)?.[0] ?? '';

  if (!jsonStr) throw new Error(`No JSON found in Claude response: ${text.slice(0, 300)}`);

  const parsed = JSON.parse(jsonStr) as {
    passed?: boolean;
    hasText?: boolean;
    textDescription?: string | null;
    aiScore?: number;
    issues?: string[];
    suggestion?: string;
  };

  const aiScore = parsed.aiScore ?? 10;
  const hasText = parsed.hasText ?? false;
  const issues = parsed.issues ?? [];

  // hasTextがtrueなら必ず不合格
  if (hasText && !issues.some(i => i.includes('文字') || i.includes('テキスト'))) {
    issues.unshift(`画像に文字・テキストが含まれています: ${parsed.textDescription ?? '不明'}`);
  }

  // passed の自動補正
  const passed = hasText
    ? false
    : parsed.passed !== undefined
      ? parsed.passed
      : aiScore <= 5 && issues.length === 0;

  return {
    passed,
    hasText,
    textDescription: parsed.textDescription ?? null,
    aiScore,
    issues,
    suggestion: parsed.suggestion,
  };
}

/**
 * 同カテゴリの過去画像と比較して重複していないか確認する
 * 直近3枚をClaudeで比較。類似度が高すぎる場合はfailedを返す
 */
async function checkDuplicate(
  client: Anthropic,
  newImagePath: string,
  category: ImageCategory
): Promise<{ isDuplicate: boolean; reason: string | null }> {
  const imagesDir = path.join(process.cwd(), 'data', 'images', category);
  if (!fs.existsSync(imagesDir)) return { isDuplicate: false, reason: null };

  // 直近3枚（新しい画像を除く）を取得
  const existingFiles = fs.readdirSync(imagesDir)
    .filter(f => f.endsWith('.png') && path.join(imagesDir, f) !== newImagePath)
    .sort()
    .reverse()
    .slice(0, 3);

  if (existingFiles.length === 0) return { isDuplicate: false, reason: null };

  // 新画像のbase64
  const newImageData = fs.readFileSync(newImagePath).toString('base64');

  // 比較画像のbase64（最大3枚）
  const compareImages = existingFiles.map(f => ({
    name: f,
    data: fs.readFileSync(path.join(imagesDir, f)).toString('base64'),
  }));

  const content: Anthropic.MessageParam['content'] = [
    {
      type: 'text',
      text: '以下は新しく生成した画像です：',
    },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: newImageData },
    },
    {
      type: 'text',
      text: `以下は過去に生成した${compareImages.length}枚の画像です：`,
    },
    ...compareImages.flatMap((img, i) => [
      { type: 'text' as const, text: `過去画像${i + 1}：` },
      {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png' as const, data: img.data },
      },
    ]),
    {
      type: 'text',
      text: '新しい画像が過去の画像と構図・内容が非常に似ている（重複）かどうか判定してください。少しの違いがあれば重複なしとして構いません。完全に同じか、ほぼ区別がつかないほど似ている場合のみ重複とみなします。以下のJSON形式で回答してください：\n{"isDuplicate": true/false, "reason": "重複の場合の説明またはnull"}',
    },
  ];

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 256,
      temperature: 0,
      messages: [{ role: 'user', content }],
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('');

    const jsonMatch = text.match(/\{[\s\S]*\}/s);
    if (!jsonMatch) return { isDuplicate: false, reason: null };

    const result = JSON.parse(jsonMatch[0]) as { isDuplicate?: boolean; reason?: string | null };
    return {
      isDuplicate: result.isDuplicate ?? false,
      reason: result.reason ?? null,
    };
  } catch (err) {
    // 重複チェック失敗は警告のみ（画像は通す）
    logger.warn({ agent: AGENT, error: String(err) }, 'Duplicate check failed, skipping');
    return { isDuplicate: false, reason: null };
  }
}

export async function checkImageQuality(
  imagePath: string,
  category: ImageCategory
): Promise<ImageQualityResult> {
  const client = getAnthropicClient();
  const imageData = fs.readFileSync(imagePath);
  const base64 = imageData.toString('base64');

  logger.info({ agent: AGENT, imagePath, category }, 'Checking image quality');

  // ── 1. 品質チェック（文字混入・AI感・適切性） ─────────────────────────
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
            text: `カテゴリ: ${category}\nこの画像をHPBサロンページ掲載用として品質チェックしてください。特に画像内に文字・テキスト・数字・記号が一切含まれていないか厳密に確認してください。`,
          },
        ],
      },
    ],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');

  const qualityResult = parseQualityResult(text);

  // テキスト混入で不合格の場合は重複チェックをスキップして早期リターン
  if (!qualityResult.passed) {
    logger.info(
      { agent: AGENT, imagePath, hasText: qualityResult.hasText, issues: qualityResult.issues },
      'Image failed quality check'
    );
    return {
      passed: false,
      aiScore: qualityResult.aiScore,
      issues: qualityResult.issues,
      suggestion: qualityResult.suggestion,
    };
  }

  // ── 2. 重複チェック ──────────────────────────────────────────────────
  const dupResult = await checkDuplicate(client, imagePath, category);
  if (dupResult.isDuplicate) {
    logger.info({ agent: AGENT, imagePath, reason: dupResult.reason }, 'Image rejected as duplicate');
    return {
      passed: false,
      aiScore: qualityResult.aiScore,
      issues: [`過去の画像と重複しています: ${dupResult.reason ?? '構図が酷似'}`],
      suggestion: '異なる構図・アングル・照明条件でプロンプトを変えて再生成してください',
    };
  }

  return {
    passed: true,
    aiScore: qualityResult.aiScore,
    issues: qualityResult.issues,
    suggestion: qualityResult.suggestion,
  };
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
