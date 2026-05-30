import fs from 'fs';
import path from 'path';

const PROMPTS_DIR = path.join(process.cwd(), 'prompts');

function readPrompt(filename: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, filename), 'utf8');
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

export function buildReplyPrompt(starRating: number): string {
  const persona = readPrompt('persona_takeda.md');
  const guardrails = readPrompt('system_guardrails.md');
  const starFile = `reply_${starRating}star.md`;
  const starPrompt = readPrompt(starFile);

  const usecaseInstructions = starPrompt.replace('{{PERSONA_BASE}}\n\n', '');
  const personaWithUsecase = renderTemplate(persona, {
    USECASE_SPECIFIC_INSTRUCTIONS: usecaseInstructions,
  });

  return `${personaWithUsecase}\n\n---\n## 追加のガードレール\n${guardrails}`;
}

export function buildBlogIdeatorPrompt(vars: {
  today: string;
  targetLabel: string;
  month: string;
  recentTitles: string[];
  competitorBlogs: string;
}): string {
  const template = readPrompt('blog_ideator.md');
  return renderTemplate(template, {
    today: vars.today,
    target_label: vars.targetLabel,
    month: vars.month,
    recent_titles: vars.recentTitles.length > 0
      ? vars.recentTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')
      : '（まだ投稿なし）',
    competitor_blogs: vars.competitorBlogs || '（データなし）',
  });
}

export function buildBlogWriterPrompt(vars: {
  title: string;
  targetLabel: string;
  mainKeyword: string;
  subKeywords: string[];
  structure: string[];
  uniqueAngle: string;
  seasonalHook: string;
}): string {
  const persona = readPrompt('persona_takeda.md');
  const guardrails = readPrompt('system_guardrails.md');
  const blogWriterTemplate = readPrompt('blog_writer.md');

  const usecaseContent = blogWriterTemplate.replace('{{PERSONA_BASE}}\n\n', '');
  const rendered = renderTemplate(usecaseContent, {
    title: vars.title,
    target_label: vars.targetLabel,
    main_keyword: vars.mainKeyword,
    sub_keywords: vars.subKeywords.join('、'),
    structure: vars.structure.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    unique_angle: vars.uniqueAngle,
    seasonal_hook: vars.seasonalHook || '特になし',
  });

  const personaWithUsecase = renderTemplate(persona, {
    USECASE_SPECIFIC_INSTRUCTIONS: rendered,
  });

  return `${personaWithUsecase}\n\n---\n## 追加のガードレール\n${guardrails}`;
}
