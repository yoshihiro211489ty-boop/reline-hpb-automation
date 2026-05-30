import { askClaudeJson } from '../lib/claude.js';
import { buildBlogIdeatorPrompt } from '../lib/persona.js';
import { blogRepo, competitorRepo } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { getTargetForDay, todayDayName } from '../lib/config.js';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import type { BlogIdea, AgentResult, TargetId } from '../types/index.js';

const TZ = 'Asia/Tokyo';

export async function runBlogIdeator(): Promise<AgentResult> {
  const start = Date.now();
  const now = toZonedTime(new Date(), TZ);
  const today = format(now, 'yyyy年MM月dd日 (EEEE)', { locale: undefined });
  const month = format(now, 'M');
  const dayName = todayDayName();
  const target = getTargetForDay(dayName);

  logger.info({ agent: 'blogIdeator', event: 'start', target: target.id }, 'Generating blog idea');

  try {
    const recentTitles = blogRepo.recentTitles(90);
    const competitors = competitorRepo.latest();
    const competitorBlogInfo = competitors
      .map(c => `- ${c.name}: ブログ${c.blogCount}件`)
      .join('\n') || '（データなし）';

    const systemPrompt = buildBlogIdeatorPrompt({
      today,
      targetLabel: target.label,
      month,
      recentTitles,
      competitorBlogs: competitorBlogInfo,
    });

    const idea = await askClaudeJson<{
      title: string;
      title_candidates: string[];
      target_id: string;
      main_keyword: string;
      sub_keywords: string[];
      structure: string[];
      tone_note: string;
      unique_angle: string;
      seasonal_hook: string;
    }>({
      system: '以下の指示に従い、HPBブログのテーマを選定し、JSON形式で出力してください。',
      user: systemPrompt,
      temperature: 0.8,
      maxTokens: 4096,
    });

    const blogIdea: BlogIdea = {
      title: idea.title,
      titleCandidates: idea.title_candidates,
      targetId: (idea.target_id as TargetId) ?? target.id,
      mainKeyword: idea.main_keyword,
      subKeywords: idea.sub_keywords,
      structure: idea.structure,
      toneNote: idea.tone_note,
      uniqueAngle: idea.unique_angle,
      seasonalHook: idea.seasonal_hook,
    };

    logger.info({ agent: 'blogIdeator', title: blogIdea.title, keyword: blogIdea.mainKeyword }, 'Blog idea generated');

    return {
      agent: 'blogIdeator',
      status: 'ok',
      data: { idea: blogIdea },
      durationMs: Date.now() - start,
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.error({ agent: 'blogIdeator', error: err }, 'BlogIdeator failed');
    return { agent: 'blogIdeator', status: 'error', error: err, durationMs: Date.now() - start };
  }
}
