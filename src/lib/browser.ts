import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { keychain } from './keychain.js';
import { logger } from './logger.js';

const COOKIES_PATH = path.join(process.cwd(), 'data', 'cookies.json');

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!_browser) {
    // headless: false にしないとサロンボードのTLSフィンガープリント検知で弾かれる
    _browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
        '--window-position=0,0',
      ],
    });
  }
  return _browser;
}

export async function getContext(): Promise<BrowserContext> {
  if (!_context) {
    const browser = await getBrowser();
    _context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xhtml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    });
    // bot検知回避: webdriver フラグを隠す
    await _context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    if (fs.existsSync(COOKIES_PATH)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
        await _context.addCookies(cookies);
        logger.info({ event: 'cookies_loaded' }, 'Cookies loaded from disk');
      } catch {
        logger.warn('Failed to load cookies, will re-login');
      }
    }
  }
  return _context;
}

export async function saveCookies(): Promise<void> {
  if (!_context) return;
  const cookies = await _context.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  logger.info({ event: 'cookies_saved' }, 'Cookies saved to disk');
}

export async function closeBrowser(): Promise<void> {
  if (_context) {
    await saveCookies();
    await _context.close();
    _context = null;
  }
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

async function humanDelay(min = 800, max = 2500): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min) + min);
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  await humanDelay(300, 600);
  for (const char of text) {
    await page.keyboard.type(char);
    await new Promise(resolve => setTimeout(resolve, 60 + Math.random() * 120));
  }
}

export const SALONBOARD_URL = 'https://salonboard.com/';
export const SALONBOARD_LOGIN_URL = 'https://salonboard.com/login/';

export async function loginToSalonboard(): Promise<Page> {
  const context = await getContext();
  const page = await context.newPage();

  await page.goto(SALONBOARD_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await humanDelay(1000, 1500);

  // ログイン済みチェック（ログイン済みの場合はヘッダーにメニューが表示される）
  const isLoggedIn = await page.$('#postedHeaderMenu, #showPostedHeaderMenu, #globalNavi').catch(() => null);
  if (isLoggedIn) {
    logger.info({ event: 'salonboard_already_logged_in' }, 'Already logged in via session');
    return page;
  }

  // ログインフォームが表示されるまで待機（SPAのため遅延する場合あり）
  await page.waitForSelector('input[name="userId"]', { timeout: 15000 }).catch(() => {});

  const userId = keychain.salonboardUser();
  const password = keychain.salonboardPass();

  const loginIdField = await page.$('input[name="userId"], input[type="text"]');
  if (!loginIdField) throw new Error('サロンボードのログインIDフィールドが見つかりません');

  await humanType(page, 'input[name="userId"], input[type="text"]', userId);
  await humanDelay();
  await humanType(page, 'input[name="password"], #jsiPwInput', password);
  await humanDelay();

  // ログインボタンをクリック（a.loginBtnSize または「ログイン」テキストのリンク）
  const loginBtn = await page.$('a.loginBtnSize, a[onclick*="dologin"]');
  if (loginBtn) {
    await loginBtn.click();
  } else {
    await page.click('text=ログイン');
  }
  // ログイン後はログインページ以外に遷移するまで待つ
  await page.waitForURL(url => !url.toString().includes('/login/'), { timeout: 30000 }).catch(() =>
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 })
  );
  await saveCookies();

  logger.info({ event: 'salonboard_logged_in' }, 'Logged in to SalonBoard');
  return page;
}

export { humanDelay, humanType };
