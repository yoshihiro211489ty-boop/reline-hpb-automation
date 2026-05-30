/**
 * ブログを1本今すぐ生成・投稿するスクリプト
 * 使い方: node dist/scripts/post-blog-now.js [target] [dryrun]
 *   target: postpartum | deskwork | beauty (省略時=自動判定)
 *   dryrun: --dry で投稿しない（内容確認のみ）
 */
import '../lib/db.js';
import { askClaude } from '../lib/claude.js';
import { buildBlogWriterPrompt, buildBlogIdeatorPrompt } from '../lib/persona.js';
import { askClaudeJson } from '../lib/claude.js';
import { blogRepo, auditLog } from '../lib/db.js';
import { getConfig } from '../lib/config.js';
import { loginToSalonboard, humanDelay, closeBrowser } from '../lib/browser.js';
import { checkBlogText } from '../lib/safety.js';
import fs from 'fs';
import path from 'path';
import type { BlogIdea, BlogDraft, TargetId } from '../types/index.js';

const config = getConfig();

function detectTarget(): { id: TargetId; label: string; keywords: string[] } {
  const arg = process.argv[2];
  if (arg && ['postpartum', 'deskwork', 'beauty'].includes(arg)) {
    return config.targets.find(t => t.id === arg) as { id: TargetId; label: string; keywords: string[] };
  }
  // 時間帯で判定: 午前→産後, 昼→デスクワーク, 夕方→美容
  const hour = new Date().getHours();
  if (hour < 11) return config.targets.find(t => t.id === 'postpartum') as { id: TargetId; label: string; keywords: string[] };
  if (hour < 16) return config.targets.find(t => t.id === 'deskwork') as { id: TargetId; label: string; keywords: string[] };
  return config.targets.find(t => t.id === 'beauty') as { id: TargetId; label: string; keywords: string[] };
}

function markdownToHtml(md: string): string {
  return md
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^---+$/gm, '<hr>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^<p>/, '<p>')
    .trim();
}

function markdownToPlain(md: string): string {
  return md
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/---+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function generateBlogIdea(target: { id: TargetId; label: string; keywords: string[] }): Promise<BlogIdea> {
  const recentTitles = blogRepo.recentTitles(90);
  const now = new Date();
  const month = String(now.getMonth() + 1);
  const today = now.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  const systemPrompt = buildBlogIdeatorPrompt({
    today, targetLabel: target.label, month,
    recentTitles, competitorBlogs: '',
  });

  const idea = await askClaudeJson<{
    title: string; title_candidates: string[]; target_id: string;
    main_keyword: string; sub_keywords: string[]; structure: string[];
    tone_note: string; unique_angle: string; seasonal_hook: string;
  }>({
    system: 'HPBブログのテーマを選定し、JSON形式で出力してください。',
    user: systemPrompt, temperature: 0.8, maxTokens: 1024,
  });

  return {
    title: idea.title, titleCandidates: idea.title_candidates,
    targetId: target.id, mainKeyword: idea.main_keyword,
    subKeywords: idea.sub_keywords, structure: idea.structure,
    toneNote: idea.tone_note, uniqueAngle: idea.unique_angle,
    seasonalHook: idea.seasonal_hook,
  };
}

async function generateBlogContent(idea: BlogIdea): Promise<string> {
  const target = config.targets.find(t => t.id === idea.targetId);
  const systemPrompt = buildBlogWriterPrompt({
    title: idea.title, targetLabel: target?.label ?? idea.targetId,
    mainKeyword: idea.mainKeyword, subKeywords: idea.subKeywords,
    structure: idea.structure, uniqueAngle: idea.uniqueAngle,
    seasonalHook: idea.seasonalHook,
  });

  const result = await askClaude({
    system: '武田嘉浩の一人称でHPBブログ記事を執筆してください。Markdown形式で出力。',
    user: systemPrompt, temperature: 0.75, maxTokens: 2500,
  });

  return result.text.trim();
}

async function postToSalonboard(idea: BlogIdea, content: string): Promise<void> {
  const isDry = process.argv.includes('--dry');
  const plainText = markdownToPlain(content);

  if (isDry) {
    console.log('\n====== [DRY RUN] 投稿しません ======');
    console.log(`タイトル: ${idea.title}`);
    console.log(`本文（最初の200字）:\n${plainText.slice(0, 200)}...`);
    return;
  }

  console.log('\nサロンボードにログイン中...');
  const page = await loginToSalonboard();

  try {
    // ブログ管理画面へ
    await page.goto('https://salonboard.com/CNT/edit/blogEdit/detail/', { waitUntil: 'networkidle' });
    await humanDelay(1500, 2500);

    // タイトル
    const titleSel = 'input[name="blogTitle"], input[name="title"], #blog-title, input[placeholder*="タイトル"]';
    await page.fill(titleSel, idea.title);
    await humanDelay(800, 1200);

    // 本文
    const bodySel = 'textarea[name="blogBody"], textarea[name="body"], #blog-body';
    await page.fill(bodySel, plainText);
    await humanDelay(1200, 2000);

    // 投稿ボタン
    const submitSel = 'input[type="submit"][value*="登録"], input[type="submit"][value*="公開"], button[type="submit"]';
    await page.click(submitSel);
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 });
    await humanDelay(1000, 1500);

    const blogsDir = path.join(process.cwd(), 'logs', new Date().toISOString().slice(0, 10), 'blogs');
    fs.mkdirSync(blogsDir, { recursive: true });
    const ss = path.join(blogsDir, `blog-${Date.now()}.png`);
    await page.screenshot({ path: ss });
    console.log(`✅ 投稿完了! スクリーンショット: ${ss}`);
    console.log(`現在のURL: ${page.url()}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const target = detectTarget();
  console.log(`\n📝 ブログ生成開始 (ターゲット: ${target.label})`);

  console.log('🤖 テーマを考案中...');
  const idea = await generateBlogIdea(target as { id: TargetId; label: string; keywords: string[] });
  console.log(`✅ タイトル決定: 「${idea.title}」`);

  console.log('✍️  本文を執筆中...');
  const content = await generateBlogContent(idea);

  const check = checkBlogText(content);
  if (!check.passed) {
    console.warn('⚠️  品質チェック:', check.issues.join(', '));
  }

  console.log(`✅ 本文完成 (${content.length}字)`);

  // DBに保存
  const draft: BlogDraft = {
    idea, content, charCount: content.length,
    generatedAt: new Date().toISOString(),
  };
  const draftId = blogRepo.saveDraft(draft);
  console.log(`💾 DB保存完了 (ID: ${draftId})`);

  // ファイルにも保存（確認用）
  const outDir = path.join(process.cwd(), 'logs', new Date().toISOString().slice(0, 10), 'blogs');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `blog-draft-${draftId}.md`);
  fs.writeFileSync(outFile, `# ${idea.title}\n\n${content}`, 'utf8');
  console.log(`📄 下書きファイル: ${outFile}`);

  // 投稿
  await postToSalonboard(idea, content);
}

main().catch(console.error).finally(closeBrowser);
