import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

interface SalonConfig {
  safety: {
    forbidden_phrases: string[];
    max_emoji_per_reply: number;
    max_exclamation_per_reply: number;
    reply_max_chars: number;
    blog_min_chars: number;
    blog_max_chars: number;
  };
}

function loadConfig(): SalonConfig {
  const raw = fs.readFileSync(path.join(process.cwd(), 'config', 'salon.yaml'), 'utf8');
  return yaml.parse(raw) as SalonConfig;
}

const HPB_FORBIDDEN = [
  'http://', 'https://', 'www.',
  'LINE', 'Instagram', 'Twitter', 'Facebook',
  '差別', '人種', '宗教', '政治',
];

const HEALTH_FORBIDDEN = [
  '治る', '治癒', '治療', '完治',
  '世界一', '日本一の効果', '再発しない', 'に効く',
  '治せます', '完全に治',
];

export interface SafetyCheckResult {
  passed: boolean;
  issues: string[];
}

export function checkReplyText(text: string): SafetyCheckResult {
  const config = loadConfig();
  const issues: string[] = [];

  for (const phrase of config.safety.forbidden_phrases) {
    if (text.includes(phrase)) {
      issues.push(`禁止フレーズ「${phrase}」が含まれています`);
    }
  }

  for (const phrase of HPB_FORBIDDEN) {
    if (text.toLowerCase().includes(phrase.toLowerCase())) {
      issues.push(`HPB禁止コンテンツ「${phrase}」が含まれています`);
    }
  }

  for (const phrase of HEALTH_FORBIDDEN) {
    if (text.includes(phrase)) {
      issues.push(`健康効果保証フレーズ「${phrase}」が含まれています`);
    }
  }

  const emojiCount = (text.match(/\p{Emoji}/gu) ?? []).length;
  if (emojiCount > config.safety.max_emoji_per_reply) {
    issues.push(`絵文字が${emojiCount}個（上限${config.safety.max_emoji_per_reply}個）`);
  }

  const exclamCount = (text.match(/！|!/g) ?? []).length;
  if (exclamCount > config.safety.max_exclamation_per_reply) {
    issues.push(`「！」が${exclamCount}個（上限${config.safety.max_exclamation_per_reply}個）`);
  }

  if (text.length > config.safety.reply_max_chars) {
    issues.push(`文字数が${text.length}字（上限${config.safety.reply_max_chars}字）`);
  }

  return { passed: issues.length === 0, issues };
}

export function checkBlogText(text: string): SafetyCheckResult {
  const config = loadConfig();
  const issues: string[] = [];

  for (const phrase of HEALTH_FORBIDDEN) {
    if (text.includes(phrase)) {
      issues.push(`健康効果保証フレーズ「${phrase}」が含まれています`);
    }
  }

  if (text.length < config.safety.blog_min_chars) {
    issues.push(`文字数が${text.length}字（最低${config.safety.blog_min_chars}字）`);
  }

  if (text.length > config.safety.blog_max_chars) {
    issues.push(`文字数が${text.length}字（上限${config.safety.blog_max_chars}字）`);
  }

  return { passed: issues.length === 0, issues };
}
