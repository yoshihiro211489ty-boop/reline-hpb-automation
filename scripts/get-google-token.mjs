#!/usr/bin/env node
/**
 * Google OAuth2 refresh_token 取得スクリプト（localhost リダイレクト方式）
 * 認可後に自動で Keychain に保存して終了する
 */
import { google } from 'googleapis';
import * as http from 'http';
import { URL } from 'url';
import { execFileSync, execSync } from 'child_process';

const CLIENT_ID = execSync("security find-generic-password -s reline-google -a client-id -w").toString().trim();
const CLIENT_SECRET = execSync("security find-generic-password -s reline-google -a client-secret -w").toString().trim();
const REDIRECT_URI = 'http://localhost:8080';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/business.manage'],
  prompt: 'consent',
});

console.log('\n==============================');
console.log('AUTH_URL_START');
console.log(authUrl);
console.log('AUTH_URL_END');
console.log('==============================\n');
console.log('Waiting for OAuth callback on http://localhost:8080 ...');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost:8080');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      console.error('OAuth error:', error);
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>エラー: ${error}</h1>`);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.writeHead(404);
      res.end('No code');
      return;
    }

    console.log('Authorization code received. Exchanging for tokens...');
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      throw new Error('refresh_token が取得できませんでした');
    }

    // Keychain に保存
    try {
      execFileSync('security', ['delete-generic-password', '-s', 'reline-google', '-a', 'refresh-token'], { stdio: 'pipe' });
    } catch {}
    execFileSync('security', ['add-generic-password', '-s', 'reline-google', '-a', 'refresh-token', '-w', tokens.refresh_token, '-U']);

    console.log('✓ refresh_token saved to Keychain');
    console.log('TOKEN_SAVED_OK');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>✅ 認証完了！</h1><p>このページを閉じてください。</p></body></html>');

    server.close(() => {
      console.log('\nSetup complete. You can close this terminal.');
      process.exit(0);
    });
  } catch (err) {
    console.error('Error:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>エラー</h1><p>${err.message}</p>`);
    server.close();
    process.exit(1);
  }
});

server.listen(8080, () => {
  console.log('Server ready.\n');
});
