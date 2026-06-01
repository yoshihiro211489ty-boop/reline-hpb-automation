import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

const CONFIG_DIR = path.join(process.cwd(), 'config');

interface SalonConfig {
  salon: {
    name: string;
    name_en: string;
    hpb_salon_id: string;
    hpb_url: string;
    address: string;
    hours: string;
    closed: string[];
    line_reservation: string;
    hp: string;
    google_location_name?: string;
  };
  owner: {
    name: string;
    honorific: string;
    qualifications: string[];
    experience: string;
  };
  philosophy: {
    tagline: string;
    signature_method: string;
    customer_journey: string;
    facility: string;
  };
  targets: Array<{
    id: string;
    label: string;
    age?: string;
    keywords: string[];
  }>;
  posting: {
    blog_days: string[];
    blog_post_time: string;
    reply_window_hours: number;
    dry_run: boolean;
  };
  safety: {
    danger_keywords: string[];
    forbidden_phrases: string[];
    max_emoji_per_reply: number;
    max_exclamation_per_reply: number;
    reply_max_chars: number;
    blog_min_chars: number;
    blog_max_chars: number;
  };
}

let _config: SalonConfig | null = null;

export function getConfig(): SalonConfig {
  if (!_config) {
    const raw = fs.readFileSync(path.join(CONFIG_DIR, 'salon.yaml'), 'utf8');
    _config = yaml.parse(raw) as SalonConfig;
  }
  return _config;
}

export function isDryRun(): boolean {
  if (process.env.DRY_RUN === '1') return true;
  return getConfig().posting.dry_run;
}

export function isBlogDay(dayName: string): boolean {
  return getConfig().posting.blog_days.includes(dayName);
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function todayDayName(): string {
  return DAY_NAMES[new Date().getDay()];
}

export function isMonday(): boolean { return todayDayName() === 'mon'; }
export function isFirstOfMonth(): boolean { return new Date().getDate() === 1; }

export function getTargetForDay(dayName: string): { id: string; label: string; keywords: string[] } {
  const config = getConfig();
  const dayTargetMap: Record<string, string> = {
    mon: 'postpartum',
    wed: 'deskwork',
    fri: 'beauty',
  };
  const targetId = dayTargetMap[dayName] ?? 'postpartum';
  return config.targets.find(t => t.id === targetId) ?? config.targets[0];
}
