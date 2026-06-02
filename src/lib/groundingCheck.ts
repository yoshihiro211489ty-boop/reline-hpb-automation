/**
 * 口コミ返信グラウンディングチェッカー
 *
 * 返信文に「口コミに書かれていないことをお客様の言葉として引用・言及している箇所」が
 * ないかをチェックする。
 *
 * 2段階チェック:
 *   1. ルールベース: 「」で引用されているフレーズが口コミ本文に含まれているか
 *   2. Claudeベース: 意味的なハルシネーションがないかを temperature=0 で検査
 */

import { askClaudeJson } from './claude.js';
import { logger } from './logger.js';

export interface GroundingCheckResult {
  passed: boolean;
  issues: string[];
  /** 「」内引用フレーズの照合結果 */
  quotedPhrases: { phrase: string; foundInReview: boolean }[];
}

/** 返信文中の「〜」引用フレーズをすべて抽出 */
function extractQuotedPhrases(text: string): string[] {
  return [...text.matchAll(/「([^」]+)」/g)].map(m => m[1]);
}

/** 空白・句読点を無視したゆるい一致チェック */
function softMatch(phrase: string, reviewBody: string): boolean {
  const normalize = (s: string) =>
    s.replace(/\s+/g, '').replace(/[。、！？!?]/g, '').toLowerCase();
  return normalize(reviewBody).includes(normalize(phrase));
}

interface ClaudeGroundingResponse {
  passed: boolean;
  issues: string[];
}

async function claudeGroundingCheck(
  reviewBody: string,
  replyText: string,
): Promise<string[]> {
  const result = await askClaudeJson<ClaudeGroundingResponse>({
    system: `あなたは口コミ返信の品質チェッカーです。
返信文に「口コミ本文に書かれていないことをお客様の言葉・体験として扱っている箇所」がないかを検査し、JSON で結果を返してください。

【チェック基準（問題あり）】
- 「」で囲まれているが口コミに該当する記述がない引用
- お客様が体験・感想として述べていないことを、述べたかのように書いている
- 口コミに書かれていないサービス内容・設備をお客様の発言として扱っている

【チェック対象外（問題なし）】
- 店舗側からの一般的な説明・哲学（「整える」「iPad診断」「卒業」等）
- 返信者自身のお礼・提案・今後の案内
- お客様の言葉を正確に引用しているもの

必ず以下の JSON のみ出力してください（説明文不要）:
{
  "passed": true/false,
  "issues": ["問題1", "問題2"] // 問題なければ空配列
}`,
    user: `【口コミ本文】
${reviewBody}

【返信文】
${replyText}`,
    temperature: 0,
    maxTokens: 400,
  });

  return result.issues ?? [];
}

/**
 * 返信文のグラウンディングチェックを実施する。
 *
 * @param reviewBody  口コミ原文
 * @param replyText   生成された返信文
 * @returns チェック結果（passed=false なら issues に詳細が入る）
 */
export async function checkReplyGrounding(
  reviewBody: string,
  replyText: string,
): Promise<GroundingCheckResult> {
  const issues: string[] = [];

  // ── Step 1: ルールベース 「」引用チェック ─────────────────────────────
  const phrases = extractQuotedPhrases(replyText);
  const quotedPhrases = phrases.map(phrase => {
    const foundInReview = softMatch(phrase, reviewBody);
    if (!foundInReview) {
      issues.push(`返信に「${phrase}」と引用されていますが、口コミに該当する記述がありません`);
    }
    return { phrase, foundInReview };
  });

  // ── Step 2: Claudeによる意味的チェック ──────────────────────────────
  try {
    const semanticIssues = await claudeGroundingCheck(reviewBody, replyText);
    // ルールベースと重複しないものだけ追加
    for (const issue of semanticIssues) {
      const isDuplicate = issues.some(existing =>
        existing.includes(issue.slice(0, 10)),
      );
      if (!isDuplicate) issues.push(issue);
    }
  } catch (err) {
    logger.warn(
      { lib: 'groundingCheck', error: String(err) },
      'Claude grounding check failed (skipping semantic check)',
    );
  }

  const passed = issues.length === 0;
  if (!passed) {
    logger.warn(
      { lib: 'groundingCheck', issues },
      `グラウンディングチェック失敗: ${issues.length}件の問題`,
    );
  }

  return { passed, issues, quotedPhrases };
}
