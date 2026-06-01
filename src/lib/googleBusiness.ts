/**
 * Google Business Profile API v4 ラッパー
 *
 * ドキュメント: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews
 * エンドポイント: https://mybusiness.googleapis.com/v4
 */
import { getAccessToken } from './googleAuth.js';
import { logger } from './logger.js';
import type { GoogleReview } from '../types/index.js';
import { GOOGLE_STAR_MAP } from '../types/index.js';

const BASE_URL = 'https://mybusiness.googleapis.com/v4';

async function apiFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const token = await getAccessToken();
  const url = path.startsWith('http') ? path : `${BASE_URL}/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google API エラー ${res.status}: ${body}`);
  }
  // 204 No Content (DELETEなど) の場合は空オブジェクトを返す
  if (res.status === 204) return {};
  return res.json();
}

/** アカウント一覧を取得（通常は1件） */
export async function listAccounts(): Promise<{ name: string; accountName: string }[]> {
  const data = await apiFetch('accounts') as { accounts?: Array<{ name: string; accountName: string }> };
  return data.accounts ?? [];
}

/**
 * 指定アカウントのロケーション一覧を取得
 * accountName 例: "accounts/123456789"
 */
export async function listLocations(accountName: string): Promise<{ name: string; title: string }[]> {
  const data = await apiFetch(`${accountName}/locations?readMask=name,title`) as {
    locations?: Array<{ name: string; title: string }>;
  };
  return data.locations ?? [];
}

interface GoogleReviewRaw {
  name: string;
  reviewId: string;
  reviewer: { displayName?: string; isAnonymous?: boolean };
  starRating: string;
  comment?: string;
  createTime: string;
  reviewReply?: { comment: string; updateTime: string };
}

/**
 * 指定ロケーションの口コミ一覧を取得（最新100件）
 * locationName 例: "accounts/123456789/locations/987654321"
 */
export async function listReviews(locationName: string): Promise<GoogleReview[]> {
  const data = await apiFetch(
    `${locationName}/reviews?pageSize=100&orderBy=updateTime%20desc`,
  ) as { reviews?: GoogleReviewRaw[] };

  return (data.reviews ?? []).map((r) => ({
    name: r.name,
    reviewId: r.reviewId,
    starRating: GOOGLE_STAR_MAP[r.starRating] ?? 3,
    body: r.comment ?? '（本文なし）',
    authorName: r.reviewer?.displayName ?? '匿名ユーザー',
    isAnonymous: r.reviewer?.isAnonymous ?? false,
    postedAt: r.createTime,
    hasReply: Boolean(r.reviewReply?.comment),
  }));
}

/**
 * 口コミに返信を投稿（または既存返信を更新）
 * reviewName 例: "accounts/.../locations/.../reviews/..."
 */
export async function postReply(reviewName: string, replyText: string): Promise<void> {
  await apiFetch(`${reviewName}/reply`, {
    method: 'PUT',
    body: JSON.stringify({ comment: replyText }),
  });
  logger.info({ googleReview: reviewName }, 'Google 口コミ返信を投稿しました');
}

/**
 * 初回セットアップ用: アカウントとロケーション情報を表示
 */
export async function printAccountInfo(): Promise<void> {
  const accounts = await listAccounts();
  console.log('\n=== Google ビジネスプロフィール アカウント ===');
  for (const account of accounts) {
    console.log(`アカウント: ${account.name}  (${account.accountName})`);
    const locations = await listLocations(account.name);
    for (const loc of locations) {
      console.log(`  ロケーション: ${loc.name}  (${loc.title})`);
    }
  }
}
