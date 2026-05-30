import { messagingApi } from '@line/bot-sdk';
import { keychain } from './keychain.js';
import type { NotifyLevel } from '../types/index.js';

let _client: messagingApi.MessagingApiClient | null = null;

function getClient(): messagingApi.MessagingApiClient | null {
  try {
    if (!_client) {
      _client = new messagingApi.MessagingApiClient({
        channelAccessToken: keychain.lineChannelToken(),
      });
    }
    return _client;
  } catch {
    return null; // LINEトークン未設定の場合はスキップ
  }
}

const EMOJI: Record<NotifyLevel, string> = {
  info: '☀',
  warn: '⚠️',
  danger: '🚨',
  error: '❌',
};

export async function notify(level: NotifyLevel, message: string): Promise<void> {
  const isDryRun = process.env.DRY_RUN === '1';
  const prefix = isDryRun ? '[DRY] ' : '';
  const text = `${EMOJI[level]} ${prefix}リライン 自動化システム\n─────────────────\n${message}`;

  if (isDryRun) {
    console.log('[LINE通知 DRY RUN]\n' + text);
    return;
  }

  const client = getClient();
  if (!client) {
    console.log('[LINE未設定のためコンソール出力]\n' + text);
    return;
  }

  try {
    const userId = keychain.lineTargetUserId();
    await client.pushMessage({
      to: userId,
      messages: [{ type: 'text', text }],
    });
  } catch (err) {
    console.warn('[LINE通知失敗・スキップ]', err);
  }
}

export async function notifyDanger(reviewSummary: string, reviewBody: string): Promise<void> {
  await notify(
    'danger',
    `対応が必要な口コミが届きました。\n\n` +
    `【要約】${reviewSummary}\n\n` +
    `【本文】\n${reviewBody.slice(0, 300)}${reviewBody.length > 300 ? '...' : ''}\n\n` +
    `→ サロンボードから直接返信してください。`
  );
}

export async function notifyWarnDraft(reviewSummary: string, draftText: string, reviewId: string): Promise<void> {
  await notify(
    'warn',
    `承認待ちの返信ドラフトがあります。\n\n` +
    `【口コミ要約】${reviewSummary}\n\n` +
    `【ドラフト返信文】\n${draftText}\n\n` +
    `✅ 承認する場合: この口コミIDをメモして次回バッチで自動投稿します\n` +
    `（ReviewID: ${reviewId}）\n` +
    `❌ 却下する場合: 手動でサロンボードから返信してください。`
  );
}

export async function notifyError(agentName: string, error: string): Promise<void> {
  await notify('error', `エージェント「${agentName}」でエラーが発生しました。\n\n${error}`);
}
