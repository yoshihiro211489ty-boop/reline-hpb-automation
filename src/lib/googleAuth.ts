import { google } from 'googleapis';
import { keychain } from './keychain.js';

/** OAuth2 クライアントを生成（refresh_token をキーチェーンから取得） */
export function getOAuth2Client() {
  const oauth2Client = new google.auth.OAuth2(
    keychain.googleClientId(),
    keychain.googleClientSecret(),
    'urn:ietf:wg:oauth:2.0:oob', // デスクトップアプリ用リダイレクト
  );
  oauth2Client.setCredentials({
    refresh_token: keychain.googleRefreshToken(),
  });
  return oauth2Client;
}

/** アクセストークンを取得（refresh_token から自動更新） */
export async function getAccessToken(): Promise<string> {
  const client = getOAuth2Client();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Google アクセストークンの取得に失敗しました。setup-google-auth.sh を再実行してください。');
  return token;
}

/** 初回セットアップ用: 認可URLを生成 */
export function getAuthorizationUrl(clientId: string, clientSecret: string): string {
  const client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'urn:ietf:wg:oauth:2.0:oob',
  );
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/business.manage'],
    prompt: 'consent', // 必ず refresh_token を返させる
  });
}

/** 初回セットアップ用: 認可コードから refresh_token を取得 */
export async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<{ refreshToken: string; accessToken: string }> {
  const client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'urn:ietf:wg:oauth:2.0:oob',
  );
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error('refresh_token が取得できませんでした。認可URLで prompt=consent を確認してください。');
  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? '',
  };
}
