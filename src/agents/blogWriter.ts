import { askClaude } from '../lib/claude.js';
import { buildBlogWriterPrompt } from '../lib/persona.js';
import { checkBlogText } from '../lib/safety.js';
import { blogRepo, auditLog } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { getConfig } from '../lib/config.js';
import type { BlogIdea, BlogDraft, AgentResult } from '../types/index.js';

export async function runBlogWriter(idea: BlogIdea): Promise<AgentResult> {
  const start = Date.now();
  const config = getConfig();

  logger.info({ agent: 'blogWriter', title: idea.title }, 'Writing blog post');

  try {
    const systemPrompt = buildBlogWriterPrompt({
      title: idea.title,
      targetLabel: config.targets.find(t => t.id === idea.targetId)?.label ?? idea.targetId,
      mainKeyword: idea.mainKeyword,
      subKeywords: idea.subKeywords,
      structure: idea.structure,
      uniqueAngle: idea.uniqueAngle,
      seasonalHook: idea.seasonalHook,
    });

    const result = await askClaude({
      system: '以下の指示に従い、武田嘉浩の一人称でHPBブログ記事を執筆してください。Markdown形式で出力してください。',
      user: systemPrompt,
      temperature: 0.75,
      maxTokens: 2500,
    });

    const content = result.text.trim();
    const charCount = content.length;
    const safetyCheck = checkBlogText(content);

    if (!safetyCheck.passed) {
      logger.warn(
        { agent: 'blogWriter', issues: safetyCheck.issues },
        `Safety check failed: ${safetyCheck.issues.join(', ')}`
      );
    }

    const draft: BlogDraft = {
      idea,
      content,
      charCount,
      generatedAt: new Date().toISOString(),
    };

    const draftId = blogRepo.saveDraft(draft);

    auditLog({
      agent: 'blogWriter',
      event: 'draft_created',
      blogId: draftId,
      draftText: content.slice(0, 500),
      claudeInputTokens: result.inputTokens,
      claudeOutputTokens: result.outputTokens,
      status: safetyCheck.passed ? 'ok' : 'warn',
    });

    logger.info(
      { agent: 'blogWriter', draftId, charCount, safetyPassed: safetyCheck.passed },
      `Blog draft created (${charCount} chars)`
    );

    return {
      agent: 'blogWriter',
      status: safetyCheck.passed ? 'ok' : 'warn',
      data: { draft, draftId, safetyCheck },
      durationMs: Date.now() - start,
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.error({ agent: 'blogWriter', error: err }, 'BlogWriter failed');
    return { agent: 'blogWriter', status: 'error', error: err, durationMs: Date.now() - start };
  }
}
