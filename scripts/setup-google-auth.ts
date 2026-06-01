#!/usr/bin/env ts-node
/**
 * Google Business Profile OAuth2 初回セットアップスクリプト
 *
 * 使い方:
 *   npx ts-node scripts/setup-google-auth.ts
 *
 * 事前に必要なこと:
 *   1. Google Cloud Console でプロジェクトを作成
 *   2. 「My Business Business Information API」「My Business Reviews API」を有効化
 *   3. 「認証情報」→「OAuth 2.0 クライアント ID」を作成（デスクトップアプリ）
 *   4. クライアントID・シークレットをメモ
 */
import * as readline from 'readline';
import { execFileSync } from 'child_process';
import { getAuthorizationUrl, exchangeCodeForTokens } from '../src/lib/googleAuth.js';
import { printAccountInfo } from '../src/lib/googleBusiness.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise(resolve => rl.question(q, ans => resolve(ans.trim())));

function saveToKeychain(service: string, account: string, password: string): void {
  try {
    execFileSync('security', ['delete-generic-password', '-s', service, '-a', account], { stdio: 'pipe' });
  } catch {}
  execFileSync('security', [
    'add-generic-password', '-s', service, '-a', account, '-w', password, '-U',
  ]);
  console.log(`  ✓ Keychain に保存: ${service}/${account}`);
}

async function main() {
  console.log('\n=== Google Business Profile OAuth2 セットアップ ===\n');
  console.log('【事前準備】Google Cloud Console で以下を完了してください:');
  console.log('  1. https://console.cloud.google.com/ にアクセス');
  console.log('  2. 新しいプロジェクトを作成（例: reline-automation）');
  console.log('  3. 「APIとサービス」→「ライブラリ」で以下を有効化:');
  console.log('     - My Business Business Information API');
  console.log('     - My Business Account Management API');
  console.log('  4. 「APIとサービス」→「認証情報」→「OAuth 2.0 クライアントID」を作成');
  console.log('     アプリケーションの種類:「デスクトップアプリ」');
  console.log('  5. クライアントIDとクライアントシークレットをコピー\n');

  const clientId = await ask('Google クライアントID: ');
  const clientSecret = await ask('Google クライアントシークレット: ');

  if (!clientId || !clientSecret) {
    console.error('クライアントID/シークレットが入力されていません');
    process.exit(1);
  }

  // 認可URLを生成してブラウザで開く
  const authUrl = getAuthorizationUrl(clientId, clientSecret);
  console.log('\n【手順】次のURLをブラウザで開いて、Googleアカウントでログインしてください:');
  console.log(`\n  ${authUrl}\n`);
  console.log('ログイン・許可後に表示される「認証コード」をコピーしてください。');

  const code = await ask('\n認証コード: ');
  if (!code) {
    console.error('認証コードが入力されていません');
    process.exit(1);
  }

  console.log('\nトークンを取得中...');
  const { refreshToken } = await exchangeCodeForTokens(clientId, clientSecret, code);
  console.log('✓ refresh_token を取得しました');

  // Keychain に保存
  console.log('\nKeychain に保存中...');
  saveToKeychain('reline-google', 'client-id', clientId);
  saveToKeychain('reline-google', 'client-secret', clientSecret);
  saveToKeychain('reline-google', 'refresh-token', refreshToken);

  console.log('\n✓ 認証情報の保存が完了しました\n');
  console.log('次のステップ: salon.yaml に google_location_name を設定します。\n');
  console.log('アカウント情報を取得中...');

  try {
    await printAccountInfo();
    console.log('\n上記の「ロケーション」の名前（accounts/.../locations/...）を');
    console.log('config/salon.yaml の google_location_name に設定してください。\n');
  } catch (e) {
    console.warn('アカウント情報の取得に失敗しました:', e);
    console.log('手動でロケーション名を確認してください。');
  }

  rl.close();
}

main().catch(e => {
  console.error('エラー:', e.message);
  process.exit(1);
});
