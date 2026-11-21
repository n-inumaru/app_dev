// 家計タブの通しテスト（架空のデータで操作する）
// 実行：npm run e2e（単独なら node tests/e2e/e2e-budget.mjs [スクリーンショットのフォルダー]）
// 「今日」は 2026-11-26 に固定する（給料日25日の期間：11月25日〜12月24日）。
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, PREFIX } from './serve.mjs';

const OUT = process.argv[2] || join(tmpdir(), 'kanzai-e2e', 'budget');
mkdirSync(OUT, { recursive: true });
const PORT = 8126;
const server = await startServer(PORT);
const BASE = `http://localhost:${PORT}${PREFIX}`;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NOW = new Date('2026-11-26T10:00:00+09:00');
console.log(`スクリーンショット：${OUT}`);

const browser = await chromium.launch({ executablePath: CHROME });
const problems = [];

async function newPage(opts = {}) {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    acceptDownloads: true,
    ...opts,
  });
  await context.clock.setFixedTime(NOW);
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  return { context, page };
}

const { context, page } = await newPage();
let n = 0;
const shot = async (name, p = page, full = true) => {
  n += 1;
  await p.waitForTimeout(350);
  await p.screenshot({ path: `${OUT}/${String(n).padStart(2, '0')}-${name}.png`, fullPage: full });
};
const step = (s) => console.log(`\n▶ ${s}`);
const ok = (cond, msg) => {
  if (!cond) throw new Error(`NG: ${msg}`);
  console.log(`  ✓ ${msg}`);
};
const text = (sel, p = page) => p.locator(sel).first().innerText();
const sheetOpen = () => page.waitForFunction(() => document.getElementById('sheet').open);
const sheetClosed = () => page.waitForFunction(() => !document.getElementById('sheet').open);
const modalOpen = () => page.waitForFunction(() => document.getElementById('modal').open);
const answer = async (yes) => {
  await modalOpen();
  await page.click(`#modal [data-answer="${yes ? 'yes' : 'no'}"]`);
  await page.waitForFunction(() => !document.getElementById('modal').open);
};
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('kanzai-navi:data')));
const num = (s) => Number(s.replace(/[^\d]/g, ''));
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const subTab = (key) => page.click(`.subtabs [data-key="${key}"]`);
const heroText = async () => (await text('.hero-value')).replace(/\s/g, '');

// 平日の数（テスト用の別の書き方。アプリのコードは使わない）
function weekdaysBetween(start, end) {
  let count = 0;
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86400000) {
    const w = new Date(t).getUTCDay();
    if (w >= 1 && w <= 5) count += 1;
  }
  return count;
}

async function addIncome({ name, amount, months = null, day = null }) {
  await page.click('[data-action="b-income-add"]');
  await sheetOpen();
  if (months) await page.click('[data-seg="kind"] [data-v="months"]');
  await page.fill('#bi-name', name);
  await page.fill('#bi-amount', amount);
  if (months) {
    for (const m of [...Array(12).keys()].map((i) => i + 1)) {
      const pressed = (await page.getAttribute(`[data-chips="months"] [data-v="${m}"]`, 'aria-pressed')) === 'true';
      if (pressed !== months.includes(m)) await page.click(`[data-chips="months"] [data-v="${m}"]`);
    }
    if (day) await page.selectOption('#bi-day', String(day));
  }
  await page.click('#b-income-form button[type="submit"]');
  await sheetClosed();
}

// ---------------------------------------------------------------
step('はじめて開く：下のタブが5つ、家計タブ');
await page.goto(BASE);
await page.waitForSelector('#app:not([hidden])');
ok((await page.locator('.tabbar [data-tab]').count()) === 5, '下のタブが5つ');
ok((await text('.tabbar [data-tab="budget"]')) === '家計', '5つ目は「家計」');
ok((await page.locator('.tabbar [data-tab="budget"] svg').count()) === 1, '家計タブにアイコンがある（wallet）');
ok((await text('.view')).includes('まずは会社を登録'), '最初はホームが開く');
await page.click('[data-tab="budget"]');
ok((await text('#page-title')) === '家計', '見出しが「家計」');
ok((await page.locator('.subtabs button').count()) === 4, '小タブが4つ');
ok((await page.locator('.subtabs button').allInnerTexts()).join('/') === '今月/収支/履歴/もしも', '今月／収支／履歴／もしも');
ok((await text('.empty h2')).includes('収入と固定費を入れましょう'), '何も入れていないときの案内が出る');
await shot('month-empty');

step('履歴・もしも：何も入れていないときは、入れる案内');
await subTab('history');
ok((await text('.empty h2')).includes('収入と固定費を入れましょう'), '履歴：何も入れていないときは、入れる案内（履歴の中身は e2e-history.mjs）');
await subTab('whatif');
ok((await text('.empty h2')).includes('収入と固定費を入れましょう'), 'もしも：何も入れていないときは、入れる案内（もしもの中身は e2e-history.mjs）');
await shot('whatif-empty');
await subTab('month');

step('案内から「収支」へ。給料日の設定');
await page.click('.empty [data-action="b-sub"]');
ok((await page.getAttribute('.subtabs [data-key="items"]', 'aria-pressed')) === 'true', '収支の画面になる');
ok((await text('.pnav-range')) === '11月25日〜12月24日', '今日（11/26）を含む期間：11月25日〜12月24日');
ok((await text('.pnav .tag')) === '今の期間', '「今の期間」と出る');
ok((await text('[data-action="b-payday"]')).includes('毎月 25日'), '給料日は毎月25日（初期）');
await page.click('[data-action="b-payday"]');
await sheetOpen();
await page.selectOption('#bp-day', '0');
ok((await text('#bp-preview')).includes('11月27日〜12月28日') === false && (await text('#bp-preview')).includes('月'), '月末にすると、期間の説明が変わる');
// 月末払い：10月30日（10/31は土曜なので前倒し）〜11月29日の期間に「今日(11/26)」がある
ok((await text('#bp-preview')).includes('10月30日〜11月29日'), '月末（土日は前倒し）：10月30日〜11月29日');
await shot('payday-sheet', page, false);
await page.selectOption('#bp-day', '25');
ok((await text('#bp-preview')).includes('11月25日〜12月24日'), '25日に戻すと、11月25日〜12月24日');
await page.click('#b-payday-form button[type="submit"]');
await sheetClosed();
ok((await stored()).budget.settings.since === '2026-11-26', '最初に保存した日（since）が今日になる');

step('収入：入力ミスのチェック');
await page.click('[data-action="b-income-add"]');
await sheetOpen();
await page.click('#b-income-form button[type="submit"]');
ok((await text('#bi-name-err')) === '名前を入れてください', '名前が空だとエラー');
ok((await text('#bi-amount-err')).includes('金額を入れてください'), '金額が空だとエラー');
await page.fill('#bi-amount', 'あいう');
ok((await text('#bi-amount-err')).includes('数字で'), '数字以外はエラー');
await page.click('[data-seg="kind"] [data-v="months"]');
for (const m of [6, 12]) await page.click(`[data-chips="months"] [data-v="${m}"]`);
await page.fill('#bi-name', 'テストボーナス');
await page.fill('#bi-amount', '400000');
ok((await text('#bi-months-err')).includes('1つ以上'), '月を1つも選ばないとエラー');
await shot('income-form-errors', page, false);
await page.click('[data-action="close-sheet"]');
await sheetClosed();

step('収入を追加（毎月・決まった月）。全角数字も使える');
await addIncome({ name: 'テスト給料', amount: '２５００００' });
await addIncome({ name: 'テストボーナス', amount: '40万', months: [6, 12], day: 10 });
const incomeRows = await page.locator('[data-action="b-income-edit"]').allInnerTexts();
ok(incomeRows.length === 2, '収入が2件');
ok(incomeRows[0].includes('テスト給料') && incomeRows[0].includes('250,000円') && incomeRows[0].includes('毎月'), '給料：毎月 250,000円');
ok(incomeRows[1].includes('6月・12月の10日に支給') && incomeRows[1].includes('400,000円'), 'ボーナス：6月・12月の10日に支給、この期間（12/10を含む）に 400,000円');

step('変わる収入を記録');
await page.click('[data-action="b-entry-add"]');
await sheetOpen();
ok((await page.inputValue('#be-date')) === '2026-11-26', '入金日の初期値は今日');
await page.fill('#be-amount', '3万');
await page.fill('#be-memo', 'テスト残業代');
await page.click('#b-entry-form button[type="submit"]');
await sheetClosed();
ok((await text('[data-action="b-entry-edit"]')).includes('テスト残業代') && (await text('[data-action="b-entry-edit"]')).includes('30,000円'), '変わる収入が1件（30,000円）');

step('固定費：毎月・年払い・単価×回数');
await page.click('[data-action="b-fixed-add"]');
await sheetOpen();
await page.fill('#bx-name', 'テスト家賃');
await page.selectOption('#bx-cat', 'housing');
await page.fill('#bx-amount', '70000');
await page.click('#b-fixed-form button[type="submit"]');
await sheetClosed();

await page.click('[data-action="b-fixed-add"]');
await sheetOpen();
await page.click('[data-seg="kind"] [data-v="periodic"]');
ok(await page.locator('#bx-every').isVisible(), '「◯か月ごと」を選ぶと、間隔の欄が出る');
await page.fill('#bx-name', 'テスト保険（年払い）');
await page.selectOption('#bx-cat', 'insurance');
await page.fill('#bx-amount', '60000');
await page.selectOption('#bx-every', '12');
await page.selectOption('#bx-month', '12');
await page.selectOption('#bx-day', '1');
ok((await text('#bx-preview')).includes('払う月：12月') && (await text('#bx-preview')).includes('60,000円'), '年払いのプレビュー：12月に 60,000円（この期間に入る）');
ok((await page.getAttribute('[data-seg="mode"] [data-v="lump"]', 'aria-pressed')) === 'true', '初期は「払う月にまとめて」');
await shot('fixed-form-periodic', page, false);
await page.click('#b-fixed-form button[type="submit"]');
await sheetClosed();

await page.click('[data-action="b-fixed-add"]');
await sheetOpen();
await page.click('[data-seg="kind"] [data-v="uses"]');
await page.fill('#bx-name', 'テスト昼食');
await page.selectOption('#bx-cat', 'food');
await page.fill('#bx-amount', '700');
const expectCount = weekdaysBetween('2026-11-25', '2026-12-24');
ok(expectCount === 22, `テスト側の数え方でも、期間の平日は22日（${expectCount}）`);
ok((await text('#bx-preview')).includes(`${expectCount}回`) && (await text('#bx-preview')).includes('15,400円'), '単価×回数のプレビュー：22回 → 15,400円');
await page.click('[data-chips="days"] [data-v="1"]'); // 月曜を外す
ok((await text('#bx-preview')).includes('回') && !(await text('#bx-preview')).includes('22回'), '曜日を外すと回数が変わる');
await page.click('[data-chips="days"] [data-v="1"]'); // 戻す
await shot('fixed-form-uses', page, false);
await page.click('#b-fixed-form button[type="submit"]');
await sheetClosed();
ok((await page.locator('[data-action="b-fixed-edit"]').count()) === 3, '固定費が3件');
ok((await text('.view')).includes('住居') && (await text('.view')).includes('保険') && (await text('.view')).includes('食費'), 'カテゴリごとに並ぶ');
const lunchRow = await page.locator('[data-action="b-fixed-edit"]', { hasText: 'テスト昼食' }).innerText();
ok(lunchRow.includes('15,400円') && lunchRow.includes('700円 × 22回'), '昼食：700円 × 22回 = 15,400円');

step('借入の返済は固定費に自動で入る（ホームで会社を登録）');
await page.click('[data-tab="home"]');
await page.click('.view [data-action="add-debt"]');
await page.fill('#d-name', 'テストA社');
await page.fill('#d-balance', '300000');
await page.fill('#d-rate', '15');
await page.fill('#d-payment', '10000');
await page.click('#debt-form button[type="submit"]');
await sheetClosed();
await page.click('[data-tab="budget"]');
ok((await page.getAttribute('.subtabs [data-key="items"]', 'aria-pressed')) === 'true', '家計に戻ると、さっきの小タブ（収支）が開く');
ok((await text('.view')).includes('借入の返済（自動）') && (await text('.view')).includes('10,000円'), '固定費に「借入の返済（自動）10,000円」が入る');
ok((await page.locator('.brow[data-goto="home"]').count()) === 1, '返済の行は、タップするとホームへ');

step('貯金の取り分（収入の10%）と、返済への上乗せ');
await page.click('[data-action="b-savings-edit"]');
await sheetOpen();
await page.click('[data-seg="smode"] [data-v="percent"]');
await page.fill('#bs-value', '10');
ok((await text('#bs-preview')).includes('68,000円'), '収入680,000円の10% = 68,000円');
await page.fill('#bs-value', '101');
await page.click('#b-savings-form button[type="submit"]');
ok((await text('#bs-value-err')).includes('大きすぎます') && (await page.evaluate(() => document.getElementById('sheet').open)), '100%を超えると、保存できずエラー');
await page.fill('#bs-value', '10');
ok((await text('#bs-value-err')) === '', '直すと、エラーが消える');
await page.click('#b-savings-form button[type="submit"]');
await sheetClosed();
ok((await text('[data-action="b-savings-edit"]')).includes('収入の 10%') && (await text('[data-action="b-savings-edit"]')).includes('68,000円'), '貯金の取り分：収入の 10% → 68,000円');
await page.fill('#bz-extra', '2万');
await page.waitForTimeout(100);
ok((await stored()).plan.monthlyExtra === 20000, '上乗せ2万円が、提案の「毎月の余剰金」と同じ値として保存される');
const totals = (await text('#b-totals')).replace(/\s+/g, ' ');
console.log('   合計:', totals);
ok(totals.includes('収入 680,000円') && totals.includes('固定費 155,400円') && totals.includes('貯金の取り分 68,000円') && totals.includes('返済への上乗せ 20,000円'), '合計：収入680,000 − 固定費155,400 − 貯金68,000 − 上乗せ20,000');
ok(totals.includes('自由に使える額 436,600円'), '＝ 自由に使える額 436,600円');
await shot('items');
await page.click('[data-tab="plan"]');
ok((await page.inputValue('#plan-extra')) === '20,000', '提案の画面にも 20,000 が入っている');
await page.click('[data-tab="budget"]');

step('今月：自由に使える額と、収入の使い道の積み上げ棒');
await subTab('month');
ok((await heroText()) === '436,600円', '自由に使える額（大きく）：436,600円');
ok((await page.locator('.hero-value').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))) >= 34, '数字は大きい（34px以上）');
const blocks = await page.locator('.sbar-block').evaluateAll((els) => els.map((e) => e.className.replace('sbar-block', '').trim()));
ok(blocks.join(',') === 'sb-save,sb-fixed,sb-extra,sb-free', `棒の並び：貯金 → 固定費 → 返済への上乗せ → 自由（${blocks.join(',')}）`);
const widths = await page.locator('.sbar-block').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
const wsum = widths.reduce((s, v) => s + v, 0);
ok(Math.abs(widths[3] / wsum - 436600 / 680000) < 0.01, `棒の幅は金額に比例する（自由 ${(widths[3] / wsum * 100).toFixed(1)}% ≒ 64.2%）`);
ok(Math.abs(widths[0] / wsum - 68000 / 680000) < 0.01, '貯金は10%');
ok(await page.locator('.sb-free .sbar-label').isVisible() && (await text('.sb-free .sbar-label')) === '64%', '幅が足りる部分には、割合（64%）を出す');
ok(await page.locator('.sb-extra .sbar-label').isHidden(), '幅が足りない部分（上乗せ）は、割合を出さず、切れた文字も出さない');
const legend = (await page.locator('.legend-parts li').allInnerTexts()).map((s) => s.replace(/\s+/g, ' '));
ok(legend.length === 4 && legend[0].includes('貯金の取り分') && legend[3].includes('436,600円'), `凡例が4つ（名前と金額）：${legend.join(' / ')}`);
ok((await text('.view')).includes('固定費には、借入の返済 10,000円（1社）が入っています'), '固定費に返済が入っていることを知らせる');
await page.click('.sb-free');
ok((await text('#bar-readout')).includes('自由に使える額') && (await text('#bar-readout')).includes('436,600円') && (await text('#bar-readout')).includes('64%'), '棒をタップすると、名前・額・割合が出る');
await page.click('.table-view summary');
const tableText = (await text('.table-view table')).replace(/\s+/g, ' ');
ok(tableText.includes('固定費 155,400円 23%') && tableText.includes('自由に使える額 436,600円 64%') && tableText.includes('返済への上乗せ 20,000円 3%'), '表で見る：割合の合計が100%（10・23・3・64）');
// 色（CSS変数）：検証したとおりの値が当たっている
const colors = await page.locator('.sbar-block').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
ok(colors.join('|') === 'rgb(235, 104, 52)|rgb(27, 175, 122)|rgb(237, 161, 0)|rgb(42, 120, 214)', `ライトの色：オレンジ・水色・黄色・青（検証済みの値）`);
await shot('month-positive');
await page.click('.breakdown summary');
const bl = (await text('.breakdown')).replace(/\s+/g, ' ');
ok(bl.includes('テストボーナス') && bl.includes('12月10日') && bl.includes('テスト保険（年払い）') && bl.includes('12月1日'), '内訳：ボーナス（12月10日）と年払い（12月1日）が、まとめて入る・払うものとして見える');
await shot('month-breakdown');

step('期間を前後に移動');
await page.click('[data-action="b-next"]');
ok((await text('.pnav-range')) === '12月25日〜1月24日', '次の期間：12月25日〜1月24日');
ok((await text('.pnav-sub')).includes('2026年〜2027年'), '年をまたぐ表示');
ok((await text('.pnav .tag')) === '次の期間', '「次の期間」と出る');
ok((await heroText()) !== '436,600円', '次の期間は、別の額になる（ボーナス・年払いが入らない）');
await page.click('.breakdown summary');
ok(!(await text('.breakdown')).includes('テストボーナス'), '次の期間には、ボーナスが入らない');
await page.click('[data-action="b-prev"]');
await page.click('[data-action="b-prev"]');
ok((await text('.pnav-range')) === '10月23日〜11月24日', '前の期間：10月23日〜11月24日（10/25は日曜なので前倒し）');
ok((await text('.pnav-now button')) === '今の期間に戻る', '「今の期間に戻る」が出る');
await page.click('[data-action="b-now"]');
ok((await text('.pnav-range')) === '11月25日〜12月24日', '戻ると今の期間');

step('この期間だけ変える（上書き）');
await subTab('items');
await page.click('[data-action="b-fixed-edit"]:has-text("テスト家賃")');
await sheetOpen();
ok((await text('.ov-title')).includes('11月25日〜12月24日'), '「この期間（11月25日〜12月24日）だけ変える」の欄がある');
await page.fill('#bx-ov', '80000');
await page.click('#b-fixed-form button[type="submit"]');
await sheetClosed();
let row = await page.locator('[data-action="b-fixed-edit"]', { hasText: 'テスト家賃' }).innerText();
ok(row.includes('80,000円') && row.includes('この期間だけ変更') && row.includes('元は 70,000円'), '家賃の行：80,000円（この期間だけ変更・元は70,000円）');
let st = await stored();
ok(Object.values(st.budget.overrides['2026-11-25'].fixed).includes(80000), '上書きは、期間の開始日（2026-11-25）で保存される');
ok((await text('#b-totals')).replace(/\s+/g, ' ').includes('自由に使える額 426,600円'), '自由に使える額が 426,600円 になる');
await page.click('[data-action="b-next"]');
row = await page.locator('[data-action="b-fixed-edit"]', { hasText: 'テスト家賃' }).innerText();
ok(row.includes('70,000円') && !row.includes('この期間だけ変更'), '次の期間は、元の 70,000円 のまま');
await page.click('[data-action="b-now"]');
// 回数の上書き
await page.click('[data-action="b-fixed-edit"]:has-text("テスト昼食")');
await sheetOpen();
ok((await page.getAttribute('#bx-ov', 'placeholder')).includes('22回'), '回数の上書き欄には、元の回数（22回）が目安で出る');
await page.fill('#bx-ov', '20');
await page.click('#b-fixed-form button[type="submit"]');
await sheetClosed();
row = await page.locator('[data-action="b-fixed-edit"]', { hasText: 'テスト昼食' }).innerText();
ok(row.includes('14,000円') && row.includes('700円 × 20回'), '昼食：20回に変更 → 14,000円');
st = await stored();
ok(Object.values(st.budget.overrides['2026-11-25'].uses).includes(20), '回数の上書きは、uses に保存される');
// 元に戻す
await page.click('[data-action="b-fixed-edit"]:has-text("テスト昼食")');
await sheetOpen();
await page.click('[data-action="b-ov-clear"]');
ok((await page.inputValue('#bx-ov')) === '', '「元に戻す」で欄が空になる');
await page.click('#b-fixed-form button[type="submit"]');
await sheetClosed();
row = await page.locator('[data-action="b-fixed-edit"]', { hasText: 'テスト昼食' }).innerText();
ok(row.includes('15,400円') && !row.includes('この期間だけ変更'), '空にして保存すると、元の 22回・15,400円 に戻る');
ok(!(await stored()).budget.overrides['2026-11-25']?.uses || Object.keys((await stored()).budget.overrides['2026-11-25'].uses).length === 0, '回数の上書きが消えている');

step('マイナスのとき：棒にせず警告');
await page.click('[data-action="b-fixed-edit"]:has-text("テスト家賃")');
await sheetOpen();
await page.fill('#bx-ov', '900000');
await page.click('#b-fixed-form button[type="submit"]');
await sheetClosed();
ok((await text('#b-totals')).includes('393,400円'), '合計にも、超えた額が出る');
await subTab('month');
ok((await heroText()) === '−393,400円', '自由に使える額：−393,400円（マイナス）');
ok((await page.locator('.hero-value.is-neg svg').count()) === 1, 'マイナスはアイコンつき（色だけに頼らない）');
ok((await page.locator('.sbar').count()) === 0, 'マイナスのときは、棒にしない');
ok((await text('.warn')).includes('固定費などが収入を 393,400円 上回っています'), '「固定費などが収入を 393,400円 上回っています」と警告');
ok((await page.locator('.warn svg').count()) === 1, '警告にもアイコンがある');
await shot('month-negative');
await subTab('items');
await page.click('[data-action="b-fixed-edit"]:has-text("テスト家賃")');
await sheetOpen();
await page.click('[data-action="b-ov-clear"]');
await page.click('#b-fixed-form button[type="submit"]');
await sheetClosed();
ok(!(await stored()).budget.overrides['2026-11-25'], '上書きを全部消すと、その期間の入れ物も消える');
ok((await text('#b-totals')).replace(/\s+/g, ' ').includes('自由に使える額 436,600円'), '436,600円 に戻る');

step('「計算に含める」スイッチ');
await page.click('[data-action="b-income-edit"]:has-text("テストボーナス")');
await sheetOpen();
ok((await page.locator('.ov-title').count()) === 1, '収入にも「この期間だけ変える」の欄');
await page.click('label.switch-row:has(#bi-enabled)');
await page.click('#b-income-form button[type="submit"]');
await sheetClosed();
row = await page.locator('[data-action="b-income-edit"]', { hasText: 'テストボーナス' }).innerText();
ok(row.includes('計算に含めない'), 'ボーナスの行に「計算に含めない」と出る');
ok((await text('#b-totals')).replace(/\s+/g, ' ').includes('収入 280,000円'), 'オフにすると、収入は 280,000円（給料＋残業代）');
await page.click('[data-action="b-income-edit"]:has-text("テストボーナス")');
await sheetOpen();
await page.click('label.switch-row:has(#bi-enabled)');
await page.click('#b-income-form button[type="submit"]');
await sheetClosed();
ok((await text('#b-totals')).replace(/\s+/g, ' ').includes('収入 680,000円'), 'オンに戻すと 680,000円');

step('ユーザーの文字は、HTMLとして解釈されない');
const evil = '<b>太</b><img src=x>"&テ';
await addIncome({ name: evil, amount: '1000' });
const evilRow = page.locator('[data-action="b-income-edit"]', { hasText: '太' });
ok((await evilRow.locator('.brow-name').innerText()) === evil, '名前がそのまま文字で表示される');
ok((await page.locator('.view b, .view img').count()) === 0, '太字・画像のタグとして解釈されていない');
await subTab('month');
await page.click('.breakdown summary');
ok((await page.locator('.view b, .view img').count()) === 0, '今月の内訳でも、タグにならない');
await subTab('items');
await page.click('[data-action="b-income-edit"]:has-text("太")');
await sheetOpen();
ok((await page.inputValue('#bi-name')) === evil, '編集画面の入力欄にも、そのまま入る');
await page.click('[data-action="b-income-delete"]');
await answer(true);
await sheetClosed();
ok((await page.locator('[data-action="b-income-edit"]').count()) === 2, '削除できた');

step('固定費の削除で、その項目の上書きも消える');
await page.click('[data-action="b-fixed-edit"]:has-text("テスト昼食")');
await sheetOpen();
await page.fill('#bx-ov', '18');
await page.click('#b-fixed-form button[type="submit"]');
await sheetClosed();
const lunchId = (await stored()).budget.fixed.find((f) => f.name === 'テスト昼食').id;
ok((await stored()).budget.overrides['2026-11-25'].uses[lunchId] === 18, '回数の上書き（18回）が入っている');
await page.click('[data-action="b-fixed-edit"]:has-text("テスト昼食")');
await sheetOpen();
await page.click('[data-action="b-fixed-delete"]');
await answer(true);
await sheetClosed();
ok((await page.locator('[data-action="b-fixed-edit"]').count()) === 2, '昼食を削除');
ok(!(await stored()).budget.overrides['2026-11-25'], 'その上書きも消えた');

step('昼食を入れ直す（あとの確認用）');
await page.click('[data-action="b-fixed-add"]');
await sheetOpen();
await page.click('[data-seg="kind"] [data-v="uses"]');
await page.fill('#bx-name', 'テスト昼食');
await page.selectOption('#bx-cat', 'food');
await page.fill('#bx-amount', '700');
await page.click('#b-fixed-form button[type="submit"]');
await sheetClosed();
ok((await text('#b-totals')).replace(/\s+/g, ' ').includes('自由に使える額 436,600円'), '436,600円 に戻った');

// ---------------------------------------------------------------
step('開き直しても、最後に開いていたタブ（家計の収支）から始まる');
const seed = await page.evaluate(() => localStorage.getItem('kanzai-navi:data'));
await page.reload();
await page.waitForSelector('#app:not([hidden])');
ok((await page.getAttribute('.tabbar [data-tab="budget"]', 'aria-current')) === 'page', '家計タブが開く');
ok((await page.getAttribute('.subtabs [data-key="items"]', 'aria-pressed')) === 'true', '小タブも「収支」');
ok((await text('#b-totals')).replace(/\s+/g, ' ').includes('436,600円'), 'データも残っている');
await page.click('[data-tab="forecast"]');
await page.reload();
await page.waitForSelector('#app:not([hidden])');
ok((await page.getAttribute('.tabbar [data-tab="forecast"]', 'aria-current')) === 'page', '予測タブで閉じたら、予測タブが開く');

step('終わった期間は、起動時に履歴として確定される');
await page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('kanzai-navi:data'));
  d.budget.settings.since = '2026-08-01';
  localStorage.setItem('kanzai-navi:data', JSON.stringify(d));
});
await page.reload();
await page.waitForSelector('#app:not([hidden])');
st = await stored();
const snapKeys = Object.keys(st.budget.snapshots).sort();
ok(snapKeys.join(',') === '2026-08-25,2026-09-25,2026-10-23', `since（8/1）以降に始まった、終わった3期間が確定（${snapKeys.join(', ')}）`);
const sn = st.budget.snapshots['2026-10-23'];
ok(sn.end === '2026-11-24' && sn.income === 250000 && sn.free === sn.income - sn.fixed - sn.savings - sn.extra && sn.spent === 0 && sn.leftover === sn.free, '10/23〜11/24 の結果：収入250,000円（11/26の残業代は別の期間）、自由に使える額＝収入−固定費−貯金−上乗せ');
await page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('kanzai-navi:data'));
  d.budget.settings.since = '2026-11-26';
  d.budget.snapshots = {};
  localStorage.setItem('kanzai-navi:data', JSON.stringify(d));
});

// ---------------------------------------------------------------
step('バックアップ：家計も入る。format 1 のファイルは警告つき');
await page.click('[data-tab="home"]');
await page.click('[data-action="open-settings"]');
const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]')]);
const backupPath = `${OUT}/backup.json`;
await download.saveAs(backupPath);
const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
ok(backup.format === 2 && backup.data.budget.incomes.length === 2 && backup.data.budget.fixed.length === 3 && backup.data.budget.entries.length === 1, 'format 2：収入2・固定費3・変わる収入1が入っている');
await page.click('[data-action="close-sheet"]');
await sheetClosed();
// format 1 のファイル（家計なし）を読み込もうとする
const v1 = { app: 'kanzai-navi', format: 1, exportedAt: '2026-11-20T12:00:00.000Z', data: { debts: backup.data.debts, records: [], plan: backup.data.plan } };
writeFileSync(`${OUT}/backup-v1.json`, JSON.stringify(v1));
await page.setInputFiles('#import-file', `${OUT}/backup-v1.json`);
await modalOpen();
let msg = await text('#modal .modal-text');
ok(msg.includes('古い形式') && msg.includes('今の家計は空になります'), 'format 1 のファイルは「家計が入っていない・今の家計は空になる」と知らせる');
ok(msg.includes('収入2件・固定費3件・変わる収入1件'), '今の家計の件数が出る');
await shot('import-v1-dialog', page, false);
await answer(false);
ok((await stored()).budget.incomes.length === 2, 'やめると、家計はそのまま');
await page.setInputFiles('#import-file', backupPath);
await modalOpen();
msg = await text('#modal .modal-text');
ok(msg.includes('家計（収入2件・固定費3件・変わる収入1件）を読み込みます'), 'format 2 のファイルは、家計の件数を見せる');
await answer(false);

step('すべて消す → 家計も消えて、バックアップから戻せる');
await page.click('[data-action="open-settings"]');
await page.click('[data-action="wipe"]');
await answer(true);
await page.waitForSelector('.empty');
ok((await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kanzai-navi:')).length)) === 0, '保存データがすべて消えた（最後に開いていたタブの記録も）');
ok((await page.getAttribute('.tabbar [data-tab="home"]', 'aria-current')) === 'page', 'ホームに戻る');
await page.setInputFiles('#import-file', backupPath);
await modalOpen();
await answer(true);
await page.click('[data-tab="budget"]');
await subTab('items');
ok((await text('#b-totals')).replace(/\s+/g, ' ').includes('自由に使える額 436,600円'), '読み込むと、家計も元どおり（436,600円）');

// ---------------------------------------------------------------
step('ロック：解除しても、最後に開いていたタブ（家計）から始まる');
await page.click('[data-action="open-settings"]');
await page.click('[data-action="lock-setup"]');
for (const pin of ['2580', '2580']) {
  await page.waitForFunction(() => document.getElementById('pinpad').open);
  for (const d of pin) await page.click(`#pinpad [data-key="${d}"]`);
  await page.waitForTimeout(300);
}
await page.waitForFunction(() => document.getElementById('modal').open || document.querySelector('#settings-root')?.textContent.includes('パスコードを変える'));
if (await page.evaluate(() => document.getElementById('modal').open)) await answer(false);
await page.waitForFunction(() => document.querySelector('#settings-root')?.textContent.includes('パスコードを変える'));
await page.click('[data-action="close-sheet"]');
await sheetClosed();
await subTab('month'); // 最後に開いたのは「家計の今月」
await page.reload();
await page.waitForSelector('#lock:not([hidden])');
ok(await page.locator('#app').isHidden() && (await page.locator('#view').innerHTML()) === '', 'ロック中は、家計の中身が画面に描かれていない');
await page.waitForTimeout(500);
for (const d of '2580') await page.click(`#lock [data-key="${d}"]`);
await page.waitForSelector('#app:not([hidden])');
ok((await page.getAttribute('.tabbar [data-tab="budget"]', 'aria-current')) === 'page', '解除後は、家計タブが開く');
ok((await page.getAttribute('.subtabs [data-key="month"]', 'aria-pressed')) === 'true', '小タブも「今月」');
ok((await heroText()) === '436,600円', '家計の数字も出る');

// ---------------------------------------------------------------
step('幅393のダーク表示と、幅360のライト・ダーク（保存データを入れて、目で確認する）');
const negSeed = (() => {
  const d = JSON.parse(seed);
  d.budget.fixed.find((f) => f.name === 'テスト家賃').amount = 900000;
  return JSON.stringify(d);
})();

async function review(label, opts, width) {
  const { context: c, page: p } = await newPage({ viewport: { width, height: 800 }, ...opts });
  await p.addInitScript((s) => {
    if (!localStorage.getItem('kanzai-navi:data')) localStorage.setItem('kanzai-navi:data', s);
  }, seed);
  await p.goto(BASE);
  await p.waitForSelector('#app:not([hidden])');
  await p.click('[data-tab="budget"]');
  await p.waitForSelector('.sbar');
  ok(await noOverflow(p), `${label}：今月は横にはみ出さない`);
  await shot(`${label}-month`, p);
  await p.click('.breakdown summary');
  await p.click('.table-view summary');
  ok(await noOverflow(p), `${label}：内訳と表を開いても、横にはみ出さない`);
  await shot(`${label}-month-open`, p);
  await p.click('.subtabs [data-key="items"]');
  ok(await noOverflow(p), `${label}：収支は横にはみ出さない`);
  await shot(`${label}-items`, p);
  await p.click('[data-action="b-fixed-edit"]:has-text("テスト昼食")');
  await p.waitForFunction(() => document.getElementById('sheet').open);
  ok(await noOverflow(p), `${label}：入力のシートも横にはみ出さない`);
  await shot(`${label}-fixed-sheet`, p, false);
  await p.click('[data-action="close-sheet"]');
  await p.waitForFunction(() => !document.getElementById('sheet').open);
  await p.click('.subtabs [data-key="history"]');
  await shot(`${label}-history-soon`, p, false);
  // 下のタブ：5つが収まり、文字が折り返さない
  const tabs = await p.locator('.tabbar button').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      const label = e.querySelector('span:last-child');
      return { left: r.left, right: r.right, labelHeight: label.getBoundingClientRect().height, labelOverflow: label.scrollWidth > label.clientWidth };
    }),
  );
  ok(tabs.length === 5 && tabs.every((t) => t.left >= 0 && t.right <= width + 0.5 && !t.labelOverflow && t.labelHeight < 24), `${label}：下のタブ5つが収まり、文字が崩れない`);
  await c.close();
  // マイナスの画面
  const neg = await newPage({ viewport: { width, height: 800 }, ...opts });
  await neg.page.addInitScript((s) => {
    if (!localStorage.getItem('kanzai-navi:data')) localStorage.setItem('kanzai-navi:data', s);
  }, negSeed);
  await neg.page.goto(BASE);
  await neg.page.waitForSelector('#app:not([hidden])');
  await neg.page.click('[data-tab="budget"]');
  await neg.page.waitForSelector('.warn');
  ok(await noOverflow(neg.page), `${label}：マイナスの画面も横にはみ出さない`);
  await shot(`${label}-month-negative`, neg.page);
  await neg.context.close();
}
await review('w393-dark', { colorScheme: 'dark' }, 393);
await review('w360-light', {}, 360);
await review('w360-dark', { colorScheme: 'dark' }, 360);
{
  // ダークの色（検証済みの値）
  const { context: c, page: p } = await newPage({ colorScheme: 'dark' });
  await p.addInitScript((s) => localStorage.setItem('kanzai-navi:data', s), seed);
  await p.goto(BASE);
  await p.waitForSelector('#app:not([hidden])');
  await p.click('[data-tab="budget"]');
  await p.waitForSelector('.sbar');
  const dc = await p.locator('.sbar-block').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
  ok(dc.join('|') === 'rgb(217, 89, 38)|rgb(25, 158, 112)|rgb(201, 133, 0)|rgb(57, 135, 229)', 'ダークの色：オレンジ・水色・黄色・青（検証済みの値）');
  await c.close();
}

console.log('\n---- コンソールのエラー・警告 ----');
console.log(problems.length ? problems.join('\n') : '（なし）');
if (problems.length) throw new Error('NG: コンソールにエラー・警告が出ている');
await browser.close();
server.close();
console.log('\nALL DONE');
