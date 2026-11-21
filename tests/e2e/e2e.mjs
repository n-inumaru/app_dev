// 完済ナビの通しテスト（架空のデータで操作する）
// 実行：npm run e2e（スクリーンショットは引数のフォルダー、なければ一時フォルダーの kanzai-e2e に保存）
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, PREFIX } from './serve.mjs';

const OUT = process.argv[2] || join(tmpdir(), 'kanzai-e2e', 'main');
mkdirSync(OUT, { recursive: true });
const PORT = 8124;
const server = await startServer(PORT);
const BASE = `http://localhost:${PORT}${PREFIX}`;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
console.log(`スクリーンショット：${OUT}`);

const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
  acceptDownloads: true,
});
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
});

let n = 0;
const shot = async (name, full = true) => {
  n += 1;
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${String(n).padStart(2, '0')}-${name}.png`, fullPage: full });
};
const step = (s) => console.log(`\n▶ ${s}`);
const ok = (cond, msg) => {
  if (!cond) throw new Error(`NG: ${msg}`);
  console.log(`  ✓ ${msg}`);
};
const sheetClosed = () => page.waitForFunction(() => !document.getElementById('sheet').open);
const modalOpen = () => page.waitForFunction(() => document.getElementById('modal').open);
const answer = async (yes) => {
  await modalOpen();
  await page.click(`#modal [data-answer="${yes ? 'yes' : 'no'}"]`);
  await page.waitForFunction(() => !document.getElementById('modal').open);
};
const text = (sel) => page.locator(sel).first().innerText();
const typePin = async (scope, pin) => {
  for (const d of pin) await page.click(`${scope} [data-key="${d}"]`);
};

// ---------------------------------------------------------------
step('はじめて開く');
await page.goto(BASE);
await page.waitForSelector('#app:not([hidden])');
ok((await text('.empty h2')).includes('会社を登録'), '空の画面が出る');
await shot('home-empty');

step('入力ミスのチェック');
await page.click('[data-action="add-debt"]');
await page.click('#debt-form button[type="submit"]');
ok((await text('#d-name-err')) === '会社名を入れてください', '会社名が空だとエラー');
ok((await text('#d-balance-err')) === '残高を入れてください', '残高が空だとエラー');
await page.fill('#d-balance', 'あいう');
ok((await text('#d-balance-err')).includes('数字で'), '数字以外はエラー');
await shot('form-errors', false);
await page.click('[data-action="close-sheet"]');
await sheetClosed();

step('会社を3社登録（全角数字・「万」も試す）');
async function addDebt(name, bal, rate, pay) {
  await page.click('.view [data-action="add-debt"]');
  await page.fill('#d-name', name);
  await page.fill('#d-balance', bal);
  await page.fill('#d-rate', rate);
  await page.fill('#d-payment', pay);
  await page.click('#debt-form button[type="submit"]');
  await sheetClosed();
}
await page.click('.view [data-action="add-debt"]');
await page.fill('#d-name', 'テストA社');
await page.fill('#d-balance', '50万');
await page.fill('#d-rate', '１８');
await page.fill('#d-payment', '１５０００');
ok((await text('#d-preview')).includes('7,500円'), '入力中に利息の目安（7,500円）が出る');
await shot('form-preview', false);
await page.click('#debt-form button[type="submit"]');
await sheetClosed();
await addDebt('テストB社', '300000', '15', '10,000');
await addDebt('テストC社', '100000', '14.5', '5000');
ok((await text('.hero-value')).replace(/\s/g, '') === '900,000円', 'ホームの残高合計が 900,000円');
ok((await page.locator('.debt:not(.is-done)').count()) === 3, '会社のカードが3枚');
await shot('home-3debts');

step('提案：余剰金を入れる');
await page.click('[data-tab="plan"]');
await page.fill('#plan-lump', '100000');
await page.fill('#plan-extra', '1万');
await page.waitForTimeout(100);
const firstAlloc = await text('.alloc li .alloc-name');
ok(firstAlloc.startsWith('テストA社'), `一括の余剰金は利率が一番高いA社へ（${firstAlloc.split('\n')[0]}）`);
ok((await text('.alloc li .alloc-amt')).startsWith('100,000円'), 'A社に 100,000円');
ok((await text('.reco .card-title')) === '利率の高い順に返す', 'おすすめは「利率の高い順」');
const orderNames = await page.locator('.order .order-name').allInnerTexts();
ok(orderNames[0].startsWith('テストA社') && orderNames[1].startsWith('テストB社') && orderNames[2].startsWith('テストC社'), `返す順番は A→B→C（${orderNames.map((s) => s.split('\n')[0].slice(0, 5)).join('→')}）`);
const nextRows = await page.locator('.pay-table tbody tr').allInnerTexts();
ok(nextRows[0].includes('25,000円') && nextRows[0].includes('上乗せ'), `次の返済でA社に上乗せ（${nextRows[0].replace(/\s+/g, ' ')}）`);
const compare = await page.locator('.compare tbody tr').allInnerTexts();
console.log('   比較表:', compare.map((r) => r.replace(/\s+/g, ' ')).join(' / '));
ok((await page.locator('.compare .is-rec').count()) === 1, '比較表におすすめの行が1つ');
await shot('plan');

step('予測：グラフ');
await page.click('[data-tab="forecast"]');
await page.waitForSelector('#chart svg');
ok((await page.locator('#chart polyline').count()) === 3, '折れ線が3本');
ok((await page.locator('.legend li').count()) === 3, '凡例が3つ');
const box = await page.locator('#chart svg').boundingBox();
await page.touchscreen.tap(box.x + box.width * 0.4, box.y + box.height * 0.5);
await page.waitForTimeout(100);
ok((await text('#chart-readout')).includes('の残高'), 'グラフをタップすると、その月の残高が出る');
await shot('forecast');
await page.click('[data-action="scenario"][data-key="snowball"]');
ok((await page.getAttribute('[data-action="scenario"][data-key="snowball"]', 'aria-pressed')) === 'true', '「残高の少ない順」に切り替わる');
const before = await page.locator('.sched').count();
await page.click('[data-action="show-more"]');
ok((await page.locator('.sched').count()) > before, '「もっと見る」で月が増える');
await page.click('.table-view summary');
ok((await page.locator('.data-table tbody tr').count()) > 1, '表で見る');

step('記録：1件記録して、削除して元に戻す');
await page.click('[data-tab="home"]');
await page.click('.debt:nth-of-type(1) [data-action="add-record"]');
await page.waitForSelector('#record-form');
ok((await page.inputValue('#r-amount')) === '15,000', '払った額に毎月の返済額が入っている');
ok((await page.inputValue('#r-interest')) === '7,500', '利息の目安 7,500円が入っている');
ok((await text('#r-preview')).includes('492,500円'), '返済後の残高 492,500円の見込み');
await shot('record-form', false);
await page.click('#record-form button[type="submit"]');
await sheetClosed();
ok((await text('.debt .debt-balance')).replace(/\s/g, '') === '492,500円', 'A社の残高が 492,500円に減る');
await page.click('[data-tab="records"]');
ok((await page.locator('.rec').count()) === 1, '記録が1件');
await page.click('[data-action="delete-record"]');
await answer(true);
ok((await page.locator('.rec').count()) === 0, '記録を削除できる');
await page.click('[data-tab="home"]');
ok((await text('.debt .debt-balance')).replace(/\s/g, '') === '500,000円', '削除すると残高が元に戻る');

step('提案から一括返済を記録');
await page.click('[data-tab="plan"]');
await page.click('[data-action="record-lump"]');
await answer(true);
ok((await page.inputValue('#plan-lump')) === '', '今ある余剰金が0円に戻る');
await page.click('[data-tab="home"]');
ok((await text('.debt .debt-balance')).replace(/\s/g, '') === '400,000円', 'A社の残高が 400,000円');

step('今月分をまとめて記録');
await page.click('[data-tab="records"]');
await page.click('[data-action="bulk-record"]');
await page.waitForSelector('#bulk-form');
const bulkVals = await page.locator('[data-bulk]').evaluateAll((els) => els.map((e) => e.value));
ok(bulkVals.join('/') === '25,000/10,000/5,000', `提案どおりの額が入っている（${bulkVals.join(' / ')}）`);
await shot('bulk-form', false);
await page.click('#bulk-form button[type="submit"]');
await sheetClosed();
ok((await page.locator('.rec').count()) === 4, '記録が合計4件（一括1件＋まとめて3件）');
await shot('records');

step('完済のお祝いと、浮いたお金の確認');
await page.click('[data-tab="home"]');
await page.click('.debt:nth-of-type(3) [data-action="add-record"]');
await page.waitForSelector('#record-form');
await page.click('[data-rtype="extra"]');
const cBalance = Number((await page.locator('#r-debt option:checked').innerText()).match(/残高 ([\d,]+)円/)[1].replace(/,/g, ''));
await page.fill('#r-amount', String(cBalance));
ok((await text('#r-preview')).includes('完済'), `C社の残高 ${cBalance}円を全額返すと「完済」と出る`);
await page.click('#record-form button[type="submit"]');
await modalOpen();
ok((await text('#modal .modal-title')).includes('テストC社 を完済しました'), 'お祝いのダイアログが出る');
await shot('celebrate', false);
await answer(true);
await page.click('[data-tab="plan"]');
ok((await page.inputValue('#plan-extra')) === '15,000', '毎月の余剰金が 10,000円 → 15,000円 に増える');
await page.click('[data-tab="home"]');
ok((await page.locator('.debt.is-done').count()) === 1, '完済したカードが出る');

step('ロック：パスコードと指紋・顔認証（仮想の認証器）');
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
await page.click('[data-action="open-settings"]');
await page.click('[data-action="lock-setup"]');
await page.waitForFunction(() => document.getElementById('pinpad').open);
await shot('pin-setup', false);
await typePin('#pinpad', '1234');
await page.waitForFunction(() => document.querySelector('#pinpad .pin-title')?.textContent === 'もう一度入力');
await typePin('#pinpad', '9999');
await page.waitForFunction(() => document.querySelector('#pinpad .pin-message')?.textContent.includes('違います'));
ok(true, '2回目が違うとエラー');
await typePin('#pinpad', '1234');
await modalOpen();
ok((await text('#modal .modal-title')).includes('指紋・顔認証も使いますか'), '指紋・顔認証を使うか聞かれる');
await answer(true);
await page.waitForFunction(() => document.querySelector('#settings-root')?.textContent.includes('指紋・顔認証をやめる'));
const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
ok(creds.credentials.length === 1, 'パスキーが1つ登録された');
const lockSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('kanzai-navi:lock')));
ok(lockSaved.hash && !JSON.stringify(lockSaved).includes('1234'), 'パスコードはそのまま保存されていない');
ok(lockSaved.passkey.alg === -7 && !!lockSaved.passkey.publicKey, '公開鍵（ES256）を保存した');
await shot('settings-locked', false);

step('開き直すと、指紋・顔認証で自動で解除される');
// ロック画面が出てから、指紋・顔認証を呼ぶまでの時間を測る仕掛け（以前は、固定で0.3秒待っていた）
await page.addInitScript(() => {
  const t = (window.__lockTiming = {});
  const orig = navigator.credentials.get.bind(navigator.credentials);
  navigator.credentials.get = (...a) => {
    t.getCalled ??= performance.now();
    return orig(...a);
  };
  document.addEventListener('DOMContentLoaded', () => {
    const lock = document.getElementById('lock');
    const check = () => {
      if (!lock.hidden && t.lockShown === undefined) t.lockShown = performance.now();
    };
    new MutationObserver(check).observe(lock, { attributes: true, attributeFilter: ['hidden'] });
    check();
  });
});
await page.reload();
await page.waitForSelector('#app:not([hidden])', { timeout: 8000 });
ok(true, 'パスキーで解除できた（署名の検証も通過）');
{
  const t = await page.evaluate(() => window.__lockTiming);
  const gap = t.getCalled - t.lockShown;
  ok(Number.isFinite(gap) && gap < 150, `ロック画面が出てから、指紋・顔認証を呼ぶまで ${Math.round(gap)}ms（150ms未満。固定の待ち時間を入れていない）`);
}
for (let i = 0; i < 5; i++) {
  await page.reload();
  await page.waitForSelector('#app:not([hidden])', { timeout: 8000 });
}
ok(true, 'さらに5回、パスキーで解除できた（署名の形式の違いにも対応）');

step('指紋が通らないときは、パスコードで解除');
await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
await page.reload();
await page.waitForSelector('#lock:not([hidden])');
await page.waitForTimeout(1200);
ok(await page.locator('#app').isHidden(), '本人確認できないと、ロックのまま');
ok((await page.locator('#view').innerHTML()) === '', 'ロック中は中身が画面に描かれていない');
await shot('lock-screen', false);
await typePin('#lock', '0000');
await page.waitForFunction(() => document.querySelector('#lock .pin-message')?.textContent.includes('違います'));
ok(true, '違うパスコードはエラー');
await typePin('#lock', '1234');
await page.waitForSelector('#app:not([hidden])');
ok(true, '正しいパスコードで解除');

step('5回間違えると30秒待ち');
await page.reload();
await page.waitForSelector('#lock:not([hidden])');
await page.waitForTimeout(800);
for (let i = 0; i < 5; i++) {
  await typePin('#lock', '0000');
  await page.waitForFunction(() => document.querySelectorAll('#lock .pin-dots span.filled').length === 0);
}
await page.waitForFunction(() => document.querySelector('#lock .pin-message')?.textContent.includes('秒待って'));
ok(true, '待ちのメッセージが出る');
await page.reload();
await page.waitForSelector('#lock:not([hidden])');
ok((await text('#lock .pin-message')).includes('秒待って'), '開き直しても待ちは続く');
await page.evaluate(() => {
  const l = JSON.parse(localStorage.getItem('kanzai-navi:lock'));
  l.lockedUntil = 0;
  l.fails = 0;
  localStorage.setItem('kanzai-navi:lock', JSON.stringify(l));
});
await page.reload();
await page.waitForSelector('#lock:not([hidden])');
await page.waitForTimeout(800);
await typePin('#lock', '1234');
await page.waitForSelector('#app:not([hidden])');
await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });

step('バックアップの書き出し');
await page.click('[data-action="open-settings"]');
const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]')]);
const backupPath = `${OUT}/backup.json`;
await download.saveAs(backupPath);
const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
ok(backup.app === 'kanzai-navi' && backup.data.debts.length === 3 && backup.data.records.length === 5, `ファイル ${download.suggestedFilename()}（会社3・記録5）`);
ok(!JSON.stringify(backup).includes('hash'), 'バックアップにロックの情報は入らない');
await page.click('[data-action="close-sheet"]');
await sheetClosed();

step('すべて消してから、バックアップを読み込む');
await page.click('[data-action="open-settings"]');
await page.click('[data-action="wipe"]');
await answer(true);
await page.waitForSelector('.empty');
ok((await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kanzai-navi:')).length)) === 0, 'データが全部消えた');
await page.setInputFiles('#import-file', backupPath);
await modalOpen();
ok((await text('#modal .modal-text')).includes('会社 3社・記録 5件'), '読み込む前に件数を確認できる');
await answer(true);
ok((await page.locator('.debt').count()) === 3, '読み込んで元に戻った');
await page.setInputFiles('#import-file', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
await modalOpen();
ok((await text('#modal .modal-text')).includes('バックアップファイルではありません'), '違うファイルは読み込まない');
await answer(true);

step('電波がなくても開ける（オフライン）');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload();
await page.waitForSelector('#app:not([hidden])');
ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'サービスワーカーが動いている');
await context.setOffline(true);
await page.reload();
await page.waitForSelector('#app:not([hidden])');
ok((await page.locator('.debt').count()) === 3, 'オフラインでも開けて、データも見える');
await context.setOffline(false);

step('インストールできるか（通常モードのChromeで判定）');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const profile = mkdtempSync(join(tmpdir(), 'kanzai-profile-'));
  const pc = await chromium.launchPersistentContext(profile, { executablePath: CHROME, viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const pp = pc.pages()[0] || (await pc.newPage());
  await pp.goto(BASE);
  await pp.waitForSelector('#app:not([hidden])');
  await pp.evaluate(() => navigator.serviceWorker.ready);
  await pp.reload();
  await pp.waitForSelector('#app:not([hidden])');
  const pcdp = await pc.newCDPSession(pp);
  const inst = await pcdp.send('Page.getInstallabilityErrors');
  ok(inst.installabilityErrors.length === 0, `インストールの条件を満たす ${JSON.stringify(inst.installabilityErrors)}`);
  const manifest = await pcdp.send('Page.getAppManifest');
  ok(!manifest.errors?.length, 'マニフェストにエラーなし');
  await pc.close();
}

step('画面の見た目（ダーク表示）');
const dark = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ja-JP' });
const dp = await dark.newPage();
dp.on('pageerror', (e) => problems.push(`pageerror(dark): ${e.message}`));
await dp.goto(BASE);
await dp.waitForSelector('#app:not([hidden])');
await dp.evaluate((b) => {
  localStorage.setItem('kanzai-navi:data', JSON.stringify(b.data));
}, backup);
await dp.reload();
await dp.waitForSelector('.debt');
await dp.waitForTimeout(300);
await dp.screenshot({ path: `${OUT}/90-dark-home.png`, fullPage: true });
await dp.click('[data-tab="plan"]');
await dp.fill('#plan-lump', '50000');
await dp.waitForTimeout(300);
await dp.screenshot({ path: `${OUT}/91-dark-plan.png`, fullPage: true });
await dp.click('[data-tab="forecast"]');
await dp.waitForSelector('#chart svg');
await dp.waitForTimeout(300);
await dp.screenshot({ path: `${OUT}/92-dark-forecast.png`, fullPage: true });
await dark.close();

console.log('\n---- コンソールのエラー・警告 ----');
console.log(problems.length ? problems.join('\n') : '（なし）');
await browser.close();
server.close();
console.log('\nALL DONE');
