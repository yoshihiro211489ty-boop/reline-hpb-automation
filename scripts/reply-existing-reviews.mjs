#!/usr/bin/env node
/**
 * 全Googleビジネスプロフィールの未返信口コミに一括返信する
 *
 * 使い方:
 *   node scripts/reply-existing-reviews.mjs              # 本番（実際に投稿）
 *   node scripts/reply-existing-reviews.mjs --dry-run    # ドライラン（返信文だけ確認）
 */
import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

// ===== 設定 =====
const ACCOUNT_MGMT_URL = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const MYBUSINESS_URL   = 'https://mybusiness.googleapis.com/v4';

const STAR_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const DANGER_KEYWORDS = ['弁護士', '訴える', '訴訟', '警察', '消費者センター', '国民生活センター', '金返せ', '返金', '悪化した', '骨折', '青あざ'];

// ===== Keychain から認証情報取得 =====
function getSecret(service, account) {
  return execSync(`security find-generic-password -s ${service} -a ${account} -w`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
}

const CLIENT_ID     = getSecret('reline-google', 'client-id');
const CLIENT_SECRET = getSecret('reline-google', 'client-secret');
const REFRESH_TOKEN = getSecret('reline-google', 'refresh-token');
const ANTHROPIC_KEY = getSecret('reline-anthropic', 'api-key');

// ===== OAuth2 アクセストークン =====
async function getAccessToken() {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('アクセストークン取得失敗: ' + JSON.stringify(data));
  return data.access_token;
}

// ===== API 共通フェッチ =====
async function apiFetch(url, token, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API エラー ${resp.status} [${url}]: ${body.slice(0, 300)}`);
  }
  if (resp.status === 204) return {};
  return resp.json();
}

// ===== GBP API 操作 =====
async function listAccounts(token) {
  const data = await apiFetch(`${ACCOUNT_MGMT_URL}/accounts`, token);
  return data.accounts ?? [];
}

async function listLocations(accountName, token) {
  const data = await apiFetch(
    `${ACCOUNT_MGMT_URL}/${accountName}/locations?readMask=name,title,storefrontAddress,websiteUri,metadata`,
    token,
  );
  return data.locations ?? [];
}

async function listReviews(locationName, token) {
  try {
    const data = await apiFetch(
      `${MYBUSINESS_URL}/${locationName}/reviews?pageSize=100&orderBy=updateTime%20desc`,
      token,
    );
    return data.reviews ?? [];
  } catch (e) {
    console.log(`     ⚠️  口コミ取得不可（未確認 or アクセス権なし）`);
    return [];
  }
}

async function postReplyToReview(reviewName, replyText, token) {
  await apiFetch(`${MYBUSINESS_URL}/${reviewName}/reply`, token, {
    method: 'PUT',
    body: JSON.stringify({ comment: replyText }),
  });
}

// ===== 署名のマッピング =====
function getSignature(storeTitle) {
  if (storeTitle.includes('リライン'))        return 'リライン代表 武田嘉浩';
  if (storeTitle.includes('たけだ整骨院'))    return 'たけだ整骨院 院長 武田嘉浩';
  if (storeTitle.includes('Roots'))           return 'パーソナルジムRoots 武田嘉浩';
  if (storeTitle.includes('LEAVES'))          return 'LEAVES 武田嘉浩';
  return '武田嘉浩';
}

// ===== 返信文生成（Claude） =====
const personaMd = readFileSync(resolve(__dirname, '../prompts/persona_takeda.md'), 'utf-8')
  .replace('{{USECASE_SPECIFIC_INSTRUCTIONS}}', '');

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

async function generateReply(review, storeTitle, stars) {
  const signature = getSignature(storeTitle);
  const author    = review.reviewer?.displayName ?? '匿名ユーザー';
  const body      = review.comment ?? '（本文なし）';
  const starLine  = '★'.repeat(stars) + '☆'.repeat(5 - stars);

  // 星別の文字数・構成指示
  const instructions = {
    5: '【5★】御礼 → お客様の言葉を引用して共感 → 哲学（整える/iPad診断/卒業/完全個室のいずれか）と接続 → 次回来店への布石 → 署名。180〜250字。',
    4: '【4★】感謝 → 満足点への共感 → 「まだ改善できる部分がある」という前向きな認識 → 改善宣言 → 再来歓迎 → 署名。200〜270字。',
    3: '【3★】丁寧な感謝 → 両面（良い点・課題）を受け止め → 原因への仮説と改善提案 → 次回ご来院のご提案 → 署名。230〜310字。',
    2: '【2★】謝意と責任引受け → 状況を推察 → 院内での共有 → 直接対話の導線（LINE等） → 署名。250〜330字。反論ゼロ。',
    1: '【1★】深い謝罪（反論ゼロ） → 否定せず受け止め → 個別連絡の意思表示 → 「ご指摘に感謝」で締める → 署名。270〜350字。',
  }[stars] ?? '【3★】230〜310字。';

  const prompt = `${personaMd}

---

## 今回の口コミ返信タスク

【店舗名】${storeTitle}
【評価】${stars}星 (${starLine})
【投稿者】${author} さま
【口コミ本文】
${body}

## 返信要件
${instructions}
署名は「${signature}」で固定。
禁止: 「治る」「治療」「完治」「またのご来店心よりお待ちしております」他店比較・URL掲載。
絵文字最大1個、！最大2個。

返信文のみ出力してください（前置きや説明は不要）。`;

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 700,
    temperature: 0.7,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '';
}

// ===== メイン =====
async function main() {
  console.log('\n' + '═'.repeat(62));
  console.log(DRY_RUN
    ? '🔍 ドライラン: 返信案を生成します（実際には投稿しません）'
    : '🚀 全ロケーションの未返信口コミに返信します');
  console.log('═'.repeat(62));

  const token    = await getAccessToken();
  const accounts = await listAccounts(token);
  if (!accounts.length) { console.log('アカウントが見つかりませんでした'); return; }

  const summaryRows = [];  // 最後にサマリー表示用

  for (const account of accounts) {
    const locations = await listLocations(account.name, token);
    console.log(`\n📋 アカウント: ${account.accountName ?? account.name}  (${locations.length} ロケーション)`);

    for (const loc of locations) {
      const locId  = loc.name.split('/').pop();
      const mapsUrl   = loc.metadata?.mapsUri ?? `https://www.google.com/maps?q=${encodeURIComponent(loc.title)}`;
      const reviewUrl = `https://business.google.com/dashboard/l/${locId}/reviews`;

      console.log(`\n  ┌─ ${loc.title}`);
      console.log(`  │  管理画面: ${reviewUrl}`);
      console.log(`  │  Googleマップ: ${mapsUrl}`);

      const reviews   = await listReviews(loc.name, token);
      const unanswered = reviews.filter(r => !r.reviewReply);
      console.log(`  │  口コミ合計: ${reviews.length}件  未返信: ${unanswered.length}件`);

      if (!unanswered.length) {
        console.log('  └─ ✅ 全件返信済み');
        summaryRows.push({ store: loc.title, reviewUrl, mapsUrl, total: reviews.length, replied: 0, skipped: 0 });
        continue;
      }

      let repliedCount = 0;
      let skippedCount = 0;

      for (let i = 0; i < unanswered.length; i++) {
        const review = unanswered[i];
        const stars  = STAR_MAP[review.starRating] ?? 3;
        const author = review.reviewer?.displayName ?? '匿名';
        const body   = review.comment ?? '（本文なし）';

        const isDanger = DANGER_KEYWORDS.some(w => body.includes(w));
        if (isDanger) {
          console.log(`  │  [${i + 1}/${unanswered.length}] ⚠️  危険ワード検出 → スキップ（手動対応要）: ${author}さま (${stars}★)`);
          skippedCount++;
          continue;
        }

        console.log(`  │`);
        console.log(`  │  [${i + 1}/${unanswered.length}] ✏️  ${author} さま (${stars}★)`);
        console.log(`  │  口コミ: ${body.slice(0, 80)}${body.length > 80 ? '…' : ''}`);
        console.log(`  │  返信を生成中...`);

        const replyText = await generateReply(review, loc.title, stars);

        console.log(`  │  ┌─ 生成された返信 ${'─'.repeat(35)}`);
        replyText.split('\n').forEach(line => console.log(`  │  │ ${line}`));
        console.log(`  │  └${'─'.repeat(42)}`);

        if (!DRY_RUN) {
          await postReplyToReview(review.name, replyText, token);
          console.log(`  │  ✅ 投稿完了`);
          await new Promise(r => setTimeout(r, 1500)); // レート制限対策
        }

        repliedCount++;
      }

      console.log(`  └─ ${DRY_RUN ? '📝 ドライラン' : '✅ 完了'}: ${repliedCount}件返信, ${skippedCount}件スキップ`);
      summaryRows.push({ store: loc.title, reviewUrl, mapsUrl, total: reviews.length, replied: repliedCount, skipped: skippedCount });
    }
  }

  // ===== サマリー =====
  console.log('\n' + '═'.repeat(62));
  console.log('📊 完了サマリー');
  console.log('═'.repeat(62));

  for (const row of summaryRows) {
    if (row.replied === 0 && row.skipped === 0) continue;  // 全件済みはスキップ
    console.log(`\n${row.store}`);
    if (row.replied > 0) console.log(`  ${DRY_RUN ? '📝 返信案生成' : '✅ 返信投稿'}: ${row.replied}件`);
    if (row.skipped > 0) console.log(`  ⚠️  スキップ (要手動): ${row.skipped}件`);
    console.log(`  🔗 返信確認URL:`);
    console.log(`     管理画面  → ${row.reviewUrl}`);
    console.log(`     マップ表示 → ${row.mapsUrl}`);
  }

  if (summaryRows.every(r => r.replied === 0 && r.skipped === 0)) {
    console.log('\n✅ 全ロケーションの口コミが既に返信済みです！');
  }

  console.log('\n' + '─'.repeat(62));
  console.log('💡 Googleマップ上の返信反映には数分かかる場合があります');
  console.log('─'.repeat(62) + '\n');
}

main().catch(err => {
  console.error('\n❌ エラー:', err.message);
  process.exit(1);
});
