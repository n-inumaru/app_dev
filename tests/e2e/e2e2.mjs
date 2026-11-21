// 追加のテスト：再ロック、狭い画面、警告、特殊な入力（架空のデータ）
// 実行：npm run e2e
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, PREFIX } from './serve.mjs';

const OUT = process.argv[2] || join(tmpdir(), 'kanzai-e2e', 'extra');
mkdirSync(OUT, { recursive: true });
const PORT = 8125;
const server = await startServer(PORT);
const BASE = `http://localhost:${PORT}${PREFIX}`;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP' });
const page = await context.newPage();
const problems = [];
let dialogs = 0;
page.on('dialog', async (d) => {
  dialogs += 1;
  await d.dismiss();
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
});
const step = (s) => console.log(`\n▶ ${s}`);
const ok = (cond, msg) => {
  if (!cond) throw new Error(`NG: ${msg}`);
  console.log(`  ✓ ${msg}`);
};
const text = (sel) => page.locator(sel).first().innerText();
const sheetClosed = () => page.waitForFunction(() => !document.getElementById('sheet').open);
const answer = async (yes) => {
  await page.waitForFunction(() => document.getElementById('modal').open);
  await page.click(`#modal [data-answer="${yes ? 'yes' : 'no'}"]`);
  await page.waitForFunction(() => !document.getElementById('modal').open);
};
async function addDebt(name, bal, rate, pay) {
  await page.click('.view [data-action="add-debt"]');
  await page.fill('#d-name', name);
  await page.fill('#d-balance', bal);
  await page.fill('#d-rate', rate);
  await page.fill('#d-payment', pay);
  await page.click('#debt-form button[type="submit"]');
  await sheetClosed();
}

await page.goto(BASE);
await page.waitForSelector('#app:not([hidden])');

step('会社名にHTMLを入れても、文字として表示される');
const evil = '<b>太</b><img src=x>"&テ';
await addDebt(evil, '200000', '15', '8000');
console.log('   表示:', await text('.debt-name')); ok((await text('.debt-name')) === evil, '会社名がそのまま文字で表示される'); ok((await page.locator('.debt-name b').count()) === 0, '太字タグとしても解釈されていない');
ok((await page.locator('.view img').count()) === 0, '画像タグとして解釈されていない');

step('1社だけ・余剰金なし');
await page.click('[data-tab="plan"]');
ok((await text('.reco .card-title')) === '余剰金を入れてみましょう', '提案は「余剰金を入れてみましょう」');
await page.click('[data-tab="forecast"]');
ok((await page.locator('#chart polyline').count()) === 1, 'グラフは「今のまま」の1本');
ok((await page.locator('.legend').count()) === 0, '1本なので凡例の箱は出さない');
ok((await page.locator('[data-action="scenario"]').count()) === 0, '切り替えボタンも出さない');

step('返済額が利息以下の会社');
await page.click('[data-tab="home"]');
await addDebt('テスト高金利社', '1000000', '18', '15000');
ok((await text('.debt:nth-of-type(2) .warn')).includes('このままでは残高が減りません'), 'カードに警告が出る');
ok((await text('.summary .warn')).includes('完済できない会社があります'), 'まとめにも警告が出る');
await page.screenshot({ path: `${OUT}/a-stuck-360.png`, fullPage: true });
await page.click('[data-tab="plan"]');
await page.fill('#plan-extra', '30000');
await page.waitForTimeout(100);
ok((await text('.reco .card-title')).includes('に返す'), '余剰金を入れると、完済できる計画が出る');
await page.screenshot({ path: `${OUT}/b-plan-360.png`, fullPage: true });

step('一括の余剰金が、借金の合計より多い');
await page.fill('#plan-lump', '2000000');
await page.waitForTimeout(100);
ok((await text('#plan-result')).includes('全社を完済しても'), '余る額を知らせる');
ok((await text('#plan-result')).includes('一括の余剰金で、全社を完済できます'), '一括で全部返せると知らせる');
await page.click('[data-tab="forecast"]');
await page.waitForSelector('#chart svg');
ok(true, '予測の画面も表示できる（0か月で完済）');
await page.click('[data-tab="plan"]');
await page.fill('#plan-lump', '');
await page.fill('#plan-extra', '');

step('アプリから離れて1分たつと、もう一度ロック');
await page.evaluate(() => {
  const real = Date.now.bind(Date);
  window.__shift = 0;
  Date.now = () => real() + window.__shift;
});
await page.click('[data-action="open-settings"]');
await page.click('[data-action="lock-setup"]');
for (const pin of ['2580', '2580']) {
  await page.waitForFunction(() => document.getElementById('pinpad').open);
  for (const d of pin) await page.click(`#pinpad [data-key="${d}"]`);
  await page.waitForTimeout(300);
}
await page.waitForFunction(
  () => document.getElementById('modal').open || document.querySelector('#settings-root')?.textContent.includes('パスコードを変える'),
);
if (await page.evaluate(() => document.getElementById('modal').open)) {
  console.log('   （この端末では指紋・顔認証が使えると判定 →「あとで」を選ぶ）');
  await answer(false);
}
await page.waitForFunction(() => document.querySelector('#settings-root')?.textContent.includes('パスコードを変える'));
await page.click('[data-action="close-sheet"]');
await sheetClosed();

// 画面なしのブラウザではタブを切り替えても「隠れた」にならないので、ページに直接知らせる
await page.evaluate(() => {
  let state = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  window.__setVis = (s) => {
    state = s;
    document.dispatchEvent(new Event('visibilitychange'));
  };
});
await page.evaluate(() => window.__setVis('hidden'));
ok(await page.evaluate(() => document.body.classList.contains('covered')), '離れている間は、中身を隠す');
await page.evaluate(() => {
  window.__shift = 20000;
  window.__setVis('visible');
});
ok(await page.locator('#lock').isHidden(), '20秒で戻ったときはロックしない');
ok(!(await page.evaluate(() => document.body.classList.contains('covered'))), '戻ったら中身をまた見せる');

await page.evaluate(() => {
  window.__shift = 0;
  window.__setVis('hidden');
  window.__shift = 61000;
  window.__setVis('visible');
});
await page.waitForSelector('#lock:not([hidden])');
ok(true, '61秒たって戻ると、ロック画面になる');
for (const d of '2580') await page.click(`#lock [data-key="${d}"]`);
await page.waitForSelector('#app:not([hidden])');
ok(true, 'パスコードで解除');

step('パスコードを変える・ロックをやめる');
await page.click('[data-action="open-settings"]');
await page.click('[data-action="pin-change"]');
await page.waitForFunction(() => document.getElementById('pinpad').open);
for (const d of '1111') await page.click(`#pinpad [data-key="${d}"]`);
await page.waitForFunction(() => document.querySelector('#pinpad .pin-message')?.textContent.includes('違います'));
ok(true, '今のパスコードが違うと進めない');
for (const d of '2580') await page.click(`#pinpad [data-key="${d}"]`);
for (const pin of ['3690', '3690']) {
  await page.waitForFunction((p) => document.getElementById('pinpad').open && document.querySelectorAll('#pinpad .pin-dots span.filled').length === 0, pin);
  await page.waitForTimeout(200);
  for (const d of pin) await page.click(`#pinpad [data-key="${d}"]`);
  await page.waitForTimeout(300);
}
await page.waitForFunction(() => !document.getElementById('pinpad').open);
await page.click('[data-action="lock-off"]');
await page.waitForFunction(() => document.getElementById('pinpad').open);
for (const d of '3690') await page.click(`#pinpad [data-key="${d}"]`);
await page.waitForFunction(() => document.querySelector('#settings-root')?.textContent.includes('パスコードを設定する'));
ok(true, '新しいパスコードでロックをやめられた');
ok((await page.evaluate(() => localStorage.getItem('kanzai-navi:lock'))) === null, 'ロックの設定が消えた');
await page.click('[data-action="close-sheet"]');
await sheetClosed();

step('会社の削除');
await page.click('[data-tab="home"]');
await page.click('.debt:nth-of-type(2) [data-action="edit-debt"]');
await page.click('[data-action="delete-debt"]');
await answer(true);
ok((await page.locator('.debt').count()) === 1, '削除できた');

console.log('\n---- ブラウザ標準のダイアログ（alert など） ----');
console.log(dialogs === 0 ? '（なし）' : `${dialogs}回`);
console.log('---- コンソールのエラー・警告 ----');
console.log(problems.length ? problems.join('\n') : '（なし）');
await browser.close();
server.close();
console.log('\nALL DONE');
