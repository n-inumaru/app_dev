// 家計タブの「履歴」「もしも」、完済ナビとの連携、バックアップの通しテスト（架空のデータだけ）
// 実行：npm run e2e（単独なら node tests/e2e/e2e-history.mjs [スクリーンショットのフォルダー]）
// 「今日」は 2026-11-26（木）の10時に固定する。保存データを localStorage に直接入れて、画面から操作する。
// 数字は、テスト側で手計算した答えと照らし合わせる（アプリの計算関数は使わない）。
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, PREFIX } from './serve.mjs';

const OUT = process.argv[2] || join(tmpdir(), 'kanzai-e2e', 'history');
mkdirSync(OUT, { recursive: true });
const PORT = 8128;
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

let n = 0;
const shot = async (name, p, full = true) => {
  n += 1;
  await p.waitForTimeout(350);
  await p.screenshot({ path: `${OUT}/${String(n).padStart(2, '0')}-${name}.png`, fullPage: full });
};
const step = (s) => console.log(`\n▶ ${s}`);
const ok = (cond, msg) => {
  if (!cond) throw new Error(`NG: ${msg}`);
  console.log(`  ✓ ${msg}`);
};
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
/** 「−46,697円」「3,803円」→ 数字（マイナスは U+2212 の「−」） */
const yenNum = (s) => {
  const v = Number(s.replace(/[^\d]/g, ''));
  return /[−-]/.test(s) ? -v : v;
};
const flat = (s) => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------
// 保存データ（架空）
// ---------------------------------------------------------------
const DATA_KEY = 'kanzai-navi:data';
const T0 = '2026-11-01T00:00:00.000Z';
const sp = (id, date, amount, category = '', memo = '') => ({ id, date, amount, category, memo, createdAt: T0 });
const pad2 = (v) => String(v).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const snapOf = (start, end, free, spent, closedAt = T0) => ({ start, end, income: free + 70000, fixed: 70000, savings: 0, extra: 0, free, spent, leftover: free - spent, closedAt });

function emptyBudgetData() {
  return {
    version: 1,
    debts: [],
    records: [],
    plan: { lumpSum: 0, monthlyExtra: 0 },
    budget: {
      settings: { payday: 1, shiftEarly: true, savings: { mode: 'amount', value: 0 }, since: null },
      incomes: [],
      fixed: [],
      entries: [],
      overrides: {},
      spends: [],
      snapshots: {},
    },
    meta: { createdAt: T0, updatedAt: T0, lastBackupAt: null },
  };
}

/** 収入25万・家賃7万＝毎期18万円（自由に使える額）。給料日は1日（暦の月）。借入なし */
function baseData(settings = {}) {
  const d = emptyBudgetData();
  d.budget.settings = { payday: 1, shiftEarly: true, savings: { mode: 'amount', value: 0 }, since: '2025-09-01', ...settings };
  d.budget.incomes = [{ id: 'inc-1', name: 'テスト給料', kind: 'monthly', amount: 250000, months: [], day: 1, enabled: true, createdAt: T0, updatedAt: T0 }];
  d.budget.fixed = [
    { id: 'fix-1', name: 'テスト家賃', category: 'housing', kind: 'monthly', amount: 70000, every: 12, dueMonth: 1, dueDay: 1, mode: 'lump', uses: { by: 'weekdays', days: [1, 2, 3, 4, 5], skipHolidays: true, count: 0 }, enabled: true, createdAt: T0, updatedAt: T0 },
  ];
  return d;
}

// 2025年9月〜2026年10月の14期間（暦の月）の「使った額」。使えた額は毎期 180,000円。
//   余り：9月30,000 10月20,000 11月10,000 12月40,000 1月50,000 2月5,000 3月−20,000 4月30,000 5月60,000 6月20,000 7月−10,000 8月80,000 9月90,000 10月70,000
const SPENT = [150000, 160000, 170000, 140000, 130000, 175000, 200000, 150000, 120000, 160000, 190000, 100000, 90000, 110000];

/** 履歴14期間つき。各期間に出費を1件ずつ（15日）置いて、使った額が履歴の値と合うようにする */
function historyData() {
  const d = baseData();
  SPENT.forEach((spent, i) => {
    const y = 2025 + Math.floor((8 + i) / 12);
    const m = ((8 + i) % 12) + 1;
    const start = iso(y, m, 1);
    d.budget.snapshots[start] = snapOf(start, iso(y, m, lastDay(y, m)), 180000, spent);
    d.budget.spends.push(sp(`h-${i}`, iso(y, m, 15), spent, 'food', `テスト出費${y}-${m}`));
  });
  // 今の期間（11/1〜11/30）：途中
  d.budget.spends.push(sp('h-now-1', '2026-11-10', 8000, 'daily', 'テスト日用品'), sp('h-now-2', '2026-11-26', 1500, 'food', 'テスト昼食'));
  return d;
}

/** 給料日を25日 → 10日に変えたあと。古い区切り（9/25〜、10/23〜）と、新しい区切り（9/10〜、10/10〜）が重なっている */
function splitData() {
  const d = baseData({ payday: 10, shiftEarly: false, since: '2026-09-01' });
  d.budget.snapshots = {
    '2026-09-25': snapOf('2026-09-25', '2026-10-22', 180000, 5000, '2026-10-23T00:00:00.000Z'),
    '2026-10-23': snapOf('2026-10-23', '2026-11-24', 180000, 9000, '2026-11-25T00:00:00.000Z'),
    '2026-09-10': snapOf('2026-09-10', '2026-10-09', 180000, 3000, '2026-11-26T00:00:00.000Z'),
    '2026-10-10': snapOf('2026-10-10', '2026-11-09', 180000, 7000, '2026-11-26T00:00:00.000Z'),
  };
  d.budget.spends = [
    sp('x-1', '2026-09-12', 1000, 'food', 'テストA'), // 9/10〜10/9 だけ
    sp('x-2', '2026-09-28', 2000, 'food', 'テストB'), // 9/25〜 と 9/10〜
    sp('x-3', '2026-10-15', 3000, 'food', 'テストC'), // 9/25〜 と 10/10〜
    sp('x-4', '2026-10-30', 4000, 'food', 'テストD'), // 10/23〜 と 10/10〜
    sp('x-5', '2026-11-12', 5000, 'food', 'テストE'), // 10/23〜 と 今の期間（11/10〜12/9）
  ];
  return d;
}

/** 確定した期間を600件（暦の月で、2026年10月から600か月さかのぼる）。各期間に出費1件 */
function longData() {
  const d = baseData({ since: '1976-01-01' });
  for (let i = 0; i < 600; i += 1) {
    const idx = 2026 * 12 + 9 - i; // 2026年10月（0始まりの月＝9）から古い方へ
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    const spent = 50000 + ((i * 7919) % 150000); // 5万〜20万。ときどき使えた額（18万）を超える
    const start = iso(y, m, 1);
    d.budget.snapshots[start] = snapOf(start, iso(y, m, lastDay(y, m)), 180000, spent);
    d.budget.spends.push(sp(`l-${i}`, iso(y, m, 15), spent, '', ''));
  }
  return d;
}

async function openApp(p, data, sub = 'history', waitFor = '#hist-list') {
  await p.addInitScript(
    ({ key, json, sub: s }) => {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, json);
      localStorage.setItem('kanzai-navi:tab', 'budget');
      localStorage.setItem('kanzai-navi:budget-tab', s);
    },
    { key: DATA_KEY, json: JSON.stringify(data), sub },
  );
  await p.goto(BASE);
  await p.waitForSelector('#app:not([hidden])');
  if (waitFor) await p.waitForSelector(waitFor);
}

// ---------------------------------------------------------------
const { context, page } = await newPage();
const stored = (p = page) => p.evaluate((k) => JSON.parse(localStorage.getItem(k)), DATA_KEY);
const text = (sel, p = page) => p.locator(sel).first().innerText();
const sheetOpen = (p = page) => p.waitForFunction(() => document.getElementById('sheet').open);
const sheetClosed = (p = page) => p.waitForFunction(() => !document.getElementById('sheet').open);
const answer = async (yes, p = page) => {
  await p.waitForFunction(() => document.getElementById('modal').open);
  await p.click(`#modal [data-answer="${yes ? 'yes' : 'no'}"]`);
  await p.waitForFunction(() => !document.getElementById('modal').open);
};
const rows = (p = page) => p.locator('#hist-list .hs-row');
const rowText = async (i, p = page) => flat(await rows(p).nth(i).innerText());

// =====================================================================
// 1. 履歴
// =====================================================================

step('履歴：期間ごとの一覧（新しい期間が上。値は確定した値。今の期間は「途中」）');
await openApp(page, historyData());
{
  const s = await stored();
  ok(Object.keys(s.budget.snapshots).length === 14, `起動しても、確定した履歴は14期間のまま（${Object.keys(s.budget.snapshots).length}）`);
  ok(s.budget.snapshots['2026-03-01'].spent === 200000 && s.budget.snapshots['2026-03-01'].leftover === -20000, '履歴の値は、書き換わらない（3月：使った額 200,000円・余り −20,000円）');
  ok((await page.locator('.subtabs [aria-pressed="true"]').innerText()) === '履歴', '履歴の小タブが選ばれている');
  ok((await rows().count()) === 15, `一覧は15行（今の期間＋確定した14期間）：${await rows().count()}`);
  const now = await rowText(0);
  ok(now.includes('今の期間') && now.includes('11月1日〜11月30日') && now.includes('途中'), `先頭は今の期間：${now}`);
  // 今の期間：使えた額 180,000、使った額 8,000＋1,500＝9,500、余り 170,500
  ok(now.includes('使えた額 180,000円') && now.includes('使った額 9,500円') && now.includes('余り 170,500円'), '今の期間：使えた額 180,000円・使った額 9,500円・余り 170,500円');
  ok(now.includes('11月30日までの途中の値です') && !now.includes('前の期間'), '途中の期間には、前の期間との比べを出さない');
  ok((await page.locator('#hist-list .hs-row.is-now .tag.accent').innerText()) === '途中', '「途中」の印');
  const oct = await rowText(1);
  ok(oct.startsWith('10月1日〜10月31日') && oct.includes('使えた額 180,000円') && oct.includes('使った額 110,000円') && oct.includes('余り 70,000円'), `直近の確定期間（10月）：${oct}`);
  // 10月は 9月（使った額 90,000・余り 90,000）より、使った額 +20,000、余り −20,000
  ok(oct.includes('前の期間（9月1日〜）より') && oct.includes('使った額 +20,000円') && oct.includes('余り −20,000円'), '前の期間との比べ：使った額 +20,000円・余り −20,000円（＋／−と矢印）');
  ok((await rows().nth(1).locator('.hs-d svg').count()) === 2, '比べの数字には、矢印のアイコンがつく');
  const mar = await rowText(1 + 7); // 10月から数えて 3月は 7つ下
  ok(mar.startsWith('3月1日〜3月31日') && mar.includes('余り −20,000円') && mar.includes('20,000円オーバー'), `余りがマイナスの期（3月）：「20,000円オーバー」と出る：${mar}`);
  ok((await rows().nth(8).locator('.is-neg svg').count()) === 1, 'オーバーの期は、赤い文字だけでなく警告アイコンがつく');
  ok((await rows().nth(8).locator('.is-neg').count()) === 1 && (await rows().nth(2).locator('.is-neg').count()) === 0, 'オーバーでない期は赤くならない');
  const first = await rowText(14);
  ok(first.startsWith('2025年9月1日〜9月30日') && first.includes('余り 30,000円') && !first.includes('前の期間'), `いちばん古い期間（2025年9月）：年が出る。比べる相手がないので、比べは出ない：${first}`);
  ok((await page.locator('[data-action="b-hist-more"]').count()) === 0, '14期間なので「もっと見る」は出ない');
  ok((await page.locator('#hist-list .tag', { hasText: '給料日を変える前の区切り' }).count()) === 0 && (await page.locator('#hist-list .note').count()) === 0, '給料日を変えていないので、重なりの印・注意は出ない');
}

step('履歴：最近12期間の棒グラフ（余り。ゼロの線から、＋は上・オーバーは下）');
{
  ok((await page.locator('#hist-chart .hs-col').count()) === 12, '棒は12本');
  ok((await text('#hist-chart .card-title')) === '最近12期間の余り', `見出し：${await text('#hist-chart .card-title')}`);
  const axis = (await page.locator('.hs-axis span').allInnerTexts()).join(',');
  ok(axis === '11,12,1,2,3,4,5,6,7,8,9,10', `横軸は、期間が始まった月：${axis}`);
  // 最近12期間は 2025年11月〜2026年10月。上は最大 90,000（9月）、下は最大 20,000（3月）。全体 110,000 → ゼロの線は上から 90,000/110,000
  const g = await page.evaluate(() => {
    const plot = document.querySelector('.hs-plot').getBoundingClientRect();
    const zero = document.querySelector('.hs-zero').getBoundingClientRect();
    const ups = [...document.querySelectorAll('.hs-up')].map((e) => e.getBoundingClientRect().height);
    const downs = [...document.querySelectorAll('.hs-down')].map((e) => e.getBoundingClientRect().height);
    const maxUp = document.querySelectorAll('.hs-col')[10].querySelector('.hs-up').getBoundingClientRect();
    const downEl = document.querySelectorAll('.hs-col')[4].querySelector('.hs-down').getBoundingClientRect();
    return { plotH: plot.height, zeroY: zero.top - plot.top, ups, downs, maxUpBottom: maxUp.bottom - plot.top, downTop: downEl.top - plot.top };
  });
  ok(Math.abs(g.zeroY - (g.plotH * 90) / 110) <= 2, `ゼロの線の位置：上から ${g.zeroY.toFixed(1)}px（${g.plotH}px × 90/110 ＝ ${((g.plotH * 90) / 110).toFixed(1)}px）`);
  ok(g.ups.length === 10 && g.downs.length === 2, `上へ伸びる棒10本・下へ伸びる棒2本（${g.ups.length}・${g.downs.length}）`);
  ok(Math.abs(Math.max(...g.ups) - (g.plotH * 90) / 110) <= 2, `いちばん長い上の棒（9月の余り 90,000円）：${Math.max(...g.ups).toFixed(1)}px`);
  ok(Math.abs(Math.max(...g.downs) - (g.plotH * 20) / 110) <= 2, `いちばん長い下の棒（3月の −20,000円）：${Math.max(...g.downs).toFixed(1)}px（${((g.plotH * 20) / 110).toFixed(1)}px）`);
  ok(Math.abs(g.maxUpBottom - g.zeroY) <= 2 && Math.abs(g.downTop - g.zeroY) <= 2, '上の棒はゼロの線に乗り、下の棒はゼロの線から下がる');
  const colors = await page.evaluate(() => ({ up: getComputedStyle(document.querySelector('.hs-up')).backgroundColor, down: getComputedStyle(document.querySelector('.hs-down')).backgroundColor }));
  ok(colors.up === 'rgb(42, 120, 214)' && colors.down === 'rgb(208, 59, 59)', `ライトの色：青 #2a78d6（余り）・赤 #d03b3b（オーバー）＝検証済みの値（${colors.up}・${colors.down}）`);
  ok((await page.locator('.hs-legend li').count()) === 2 && (await text('.hs-legend')).includes('オーバー') && (await page.locator('.hs-legend li svg').count()) === 1, '凡例：余り／オーバー（オーバーには警告アイコン）');
  // 最初は、いちばん新しい期間（10月）が選ばれて、値が出ている
  const ro = flat(await text('#hs-readout'));
  ok(ro.includes('10月1日〜10月31日') && ro.includes('使えた額 180,000円') && ro.includes('使った額 110,000円') && ro.includes('余り 70,000円'), `最初の読み出し：${ro}`);
  ok((await page.locator('.hs-col[aria-pressed="true"]').count()) === 1 && (await page.locator('.hs-col').nth(11).getAttribute('aria-pressed')) === 'true', '最後の棒が選ばれている');
  ok((await page.locator('[data-action="b-hist-step"][data-dir="1"]').isDisabled()) && !(await page.locator('[data-action="b-hist-step"][data-dir="-1"]').isDisabled()), '「ひとつ後」は押せない・「ひとつ前」は押せる');
  // 3月の棒をタップ
  await page.locator('.hs-col').nth(4).click();
  const ro3 = flat(await text('#hs-readout'));
  ok(ro3.includes('3月1日〜3月31日') && ro3.includes('使った額 200,000円') && ro3.includes('余り −20,000円') && ro3.includes('（20,000円オーバー）'), `3月の棒をタップ：${ro3}`);
  ok((await page.locator('#hs-readout .is-neg svg').count()) === 1, 'オーバーの読み出しには、警告アイコンがつく');
  ok((await page.locator('.hs-col').nth(4).getAttribute('aria-pressed')) === 'true' && (await page.locator('.hs-col[aria-pressed="true"]').count()) === 1, '選んだ棒だけが目立つ');
  ok((await page.locator('.hs-col').nth(4).getAttribute('aria-label')) === '3月1日〜3月31日、20,000円オーバー', `棒のボタンの名前：${await page.locator('.hs-col').nth(4).getAttribute('aria-label')}`);
  await page.click('[data-action="b-hist-step"][data-dir="1"]');
  ok(flat(await text('#hs-readout')).includes('4月1日〜4月30日') && flat(await text('#hs-readout')).includes('余り 30,000円'), `「ひとつ後」で4月へ：${flat(await text('#hs-readout'))}`);
  await page.locator('.hs-col').nth(0).click();
  ok(flat(await text('#hs-readout')).includes('2025年11月1日〜11月30日') && (await page.locator('[data-action="b-hist-step"][data-dir="-1"]').isDisabled()), '先頭の棒：年が出る・「ひとつ前」は押せない');
  await page.locator('.hs-col').nth(11).click();
  // 表で見る
  ok((await page.locator('#hist-chart tbody tr').count()) === 12, '表で見る：12行');
  await page.click('#hist-chart .table-view summary');
  const t0 = (await page.locator('#hist-chart tbody tr').nth(0).innerText()).replace(/\s+/g, ' ');
  const t8 = (await page.locator('#hist-chart tbody tr').nth(7).innerText()).replace(/\s+/g, ' ');
  ok(t0.includes('10月1日〜10月31日') && t0.includes('110,000円') && t0.includes('70,000円'), `表の先頭（新しい順）：${t0}`);
  ok(t8.includes('3月1日〜3月31日') && t8.includes('−20,000円') && t8.includes('オーバー'), `表のオーバーの行：${t8}`);
  ok(await noOverflow(page), '横にはみ出さない');
  await shot('history-393-light', page);
}

step('履歴：出費を直すと、履歴の値も変わる（画面は「変わった」とは知らせず、開くたびに最新を出す）');
{
  await page.click('[data-action="b-sub"][data-key="month"]');
  await page.waitForSelector('#today-card');
  await page.click('[data-action="b-prev"]'); // 10月
  await page.click('#spend-list .brow:has-text("テスト出費2026-10")');
  await sheetOpen();
  await page.fill('#sp-amount', '100000');
  await page.click('#b-spend-form button[type="submit"]');
  await sheetClosed();
  await page.click('[data-action="b-sub"][data-key="history"]');
  await page.waitForSelector('#hist-list');
  const oct = await rowText(1);
  ok(oct.includes('使った額 100,000円') && oct.includes('余り 80,000円'), `10月の履歴が直っている：${oct}`);
  ok(oct.includes('使った額 +10,000円') && oct.includes('余り −10,000円'), '前の期間との比べも、直った値で出る（+10,000円・−10,000円）');
  ok((await page.locator('#toast.show').count()) === 0 || !(await text('#toast')).includes('履歴'), '「履歴が変わった」というお知らせは出さない');
  ok(flat(await text('#hs-readout')).includes('使った額 100,000円'), '棒グラフの読み出しも、直った値');
}

step('履歴：履歴がないとき（家計に何も入れていない／入れたばかり／1期間だけ）');
{
  const c = await newPage();
  await openApp(c.page, emptyBudgetData(), 'history', '.card.empty');
  ok((await text('.card.empty h2', c.page)).includes('収入と固定費を入れましょう'), '家計に何も入っていない：入れる案内を出す');
  ok((await c.page.locator('#hist-list, #hist-chart').count()) === 0, '一覧もグラフも出さない');
  await c.context.close();
}
{
  const c = await newPage();
  const d = baseData({ since: '2026-11-26' }); // 今日から使い始めた：終わった期間がまだない
  await openApp(c.page, d, 'history', '#hist-list');
  const h = await text('.card.empty', c.page);
  ok(h.includes('履歴は、期間が終わると記録されます') && h.includes('11月30日 に終わります'), `入れたばかり：案内を出す（${flat(h)}）`);
  ok((await c.page.locator('#hist-chart').count()) === 0 && (await c.page.locator('#hist-list .hs-row').count()) === 1, '棒グラフは出さない。今の期間（途中）の行だけは出す');
  ok(await noOverflow(c.page), '横にはみ出さない');
  await shot('history-empty-393', c.page, false);
  await c.context.close();
}
{
  const c = await newPage();
  const d = baseData({ since: '2026-10-01' });
  d.budget.snapshots['2026-10-01'] = snapOf('2026-10-01', '2026-10-31', 180000, 110000);
  d.budget.spends.push(sp('o-1', '2026-10-15', 110000, 'food', 'テスト10月'));
  await openApp(c.page, d, 'history', '#hist-list');
  ok((await c.page.locator('#hist-chart').count()) === 0 && (await c.page.locator('#hist-list .hs-row').count()) === 2, '1期間だけのときは、棒グラフを出さない（1本の棒は数字で見る）。一覧は今の期間＋1期間');
  ok(flat(await text('#hist-list .hs-row:nth-child(2)', c.page)).includes('余り 70,000円') && !flat(await text('#hist-list .hs-row:nth-child(2)', c.page)).includes('前の期間'), '1期間だけの行：余り 70,000円。比べは出ない');
  ok((await c.page.locator('.card.empty').count()) === 0, '履歴が1件あれば、「履歴がない」案内は出ない');
  await c.context.close();
}

step('履歴：給料日を変えたあとの、重なった期間（印をつけて、そのまま並べる。消さない・作り直さない）');
{
  const c = await newPage();
  const p = c.page;
  const data = splitData();
  await openApp(p, data, 'history', '#hist-list');
  const before = JSON.stringify(data.budget.snapshots);
  const s = await stored(p);
  ok(JSON.stringify(s.budget.snapshots) === before, '起動しても、4つの履歴は1つも書き換わらない（重なった日の出費も、どちらにも数えている）');
  const lines = [];
  for (let i = 0; i < (await rows(p).count()); i += 1) lines.push(await rowText(i, p));
  ok(lines.length === 5, `一覧は5行（今の期間＋4期間）：${lines.length}`);
  ok(lines[0].includes('今の期間') && lines[0].includes('11月10日〜12月9日') && lines[0].includes('使った額 5,000円'), `今の期間（11/10〜12/9）：${lines[0]}`);
  const order = lines.slice(1).map((l) => l.slice(0, 12).replace(/\s.*/, ''));
  ok(lines[1].startsWith('10月23日〜11月24日') && lines[2].startsWith('10月10日〜11月9日') && lines[3].startsWith('9月25日〜10月22日') && lines[4].startsWith('9月10日〜10月9日'), `開始日の新しい順に、そのまま並ぶ（${order.join(' / ')}）`);
  ok(lines[1].includes('給料日を変える前の区切り') && lines[3].includes('給料日を変える前の区切り'), '古い区切り（10/23〜・9/25〜）に、「給料日を変える前の区切り」の印');
  ok(!lines[2].includes('給料日を変える前の区切り') && !lines[4].includes('給料日を変える前の区切り'), '新しい区切り（10/10〜・9/10〜）には、印がない');
  ok(lines[1].includes('使った額 9,000円') && lines[3].includes('使った額 5,000円'), '印のついた期間も、確定した値のまま（9,000円・5,000円）');
  ok(lines[1].includes('前の期間とは比べません') && lines[3].includes('前の期間とは比べません'), '印のついた期間は、前の期間と比べない');
  // 新しい区切りどうしは比べる：10/10〜（使った額 7,000・余り 173,000）は 9/10〜（3,000・177,000）より +4,000・−4,000
  ok(lines[2].includes('前の期間（9月10日〜）より') && lines[2].includes('使った額 +4,000円') && lines[2].includes('余り −4,000円'), `新しい区切りどうしは比べる：${lines[2]}`);
  ok((await text('#hist-list .note', p)).includes('給料日を変えたため、期間が重なっている'), '一覧の上に、重なりの説明');
  ok((await p.locator('#hist-chart .hs-col').count()) === 2, '棒グラフには、印のない2期間だけを入れる');
  ok((await text('#hist-chart .hs-split-note', p)).includes('（2期間）は、棒に入れていません'), `棒グラフの注意：${await text('#hist-chart .hs-split-note', p)}`);
  ok(await noOverflow(p), '横にはみ出さない');
  await shot('history-split-393', p);
  await c.context.close();
}

// ---- 見た目：幅393・360、ライト・ダーク ----
step('履歴：見た目（幅393・360、ライト・ダーク）');
async function reviewHistory(label, opts, width, data) {
  const c = await newPage({ viewport: { width, height: 800 }, ...opts });
  const p = c.page;
  await openApp(p, data);
  ok(await noOverflow(p), `${label}：履歴は横にはみ出さない`);
  const clipped = await p.evaluate(() => [...document.querySelectorAll('.hs-row, .hs-nums dd, .hs-head, .hs-readout, .hs-ro-body, .hs-legend li')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className));
  ok(clipped.length === 0, `${label}：数字や文字が切れていない${clipped.length ? `（${clipped.join(',')}）` : ''}`);
  const sizes = await p.evaluate(() => ({
    col: Math.min(...[...document.querySelectorAll('.hs-col')].map((e) => e.getBoundingClientRect().width)),
    colH: document.querySelector('.hs-col').getBoundingClientRect().height,
    step: Math.min(...[...document.querySelectorAll('.hs-readout .icon-btn')].map((e) => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height))),
  }));
  ok(sizes.col >= 24 && sizes.colH >= 44, `${label}：棒のタップの大きさ ${sizes.col.toFixed(1)}×${sizes.colH.toFixed(0)}px（幅24px以上）`);
  ok(sizes.step >= 44, `${label}：「ひとつ前／後」ボタンは44px以上（${sizes.step}px）。小さい棒の代わりに、これでも切り替えられる`);
  if (opts.colorScheme === 'dark') {
    const colors = await p.evaluate(() => ({ up: getComputedStyle(document.querySelector('.hs-up')).backgroundColor, down: getComputedStyle(document.querySelector('.hs-down')).backgroundColor }));
    ok(colors.up === 'rgb(57, 135, 229)' && colors.down === 'rgb(230, 103, 103)', `${label}：ダークの色：青 #3987e5・赤 #e66767＝検証済みの値`);
  }
  await p.locator('.hs-col').nth(4).click(); // オーバーの棒を選んだ画面
  await shot(label + '-top', p, false);
  await p.evaluate(() => document.querySelector('#hist-list').scrollIntoView());
  await shot(label + '-list', p, false);
  await p.click('#hist-chart .table-view summary');
  ok(await noOverflow(p), `${label}：表で見るを開いても、横にはみ出さない`);
  await c.context.close();
}
await reviewHistory('history-393-dark', { colorScheme: 'dark' }, 393, historyData());
await reviewHistory('history-360-light', {}, 360, historyData());
await reviewHistory('history-360-dark', { colorScheme: 'dark' }, 360, historyData());

// ---- 履歴600期間 ----
step('履歴：確定した期間が600件でも、1秒以内に出る');
{
  const c = await newPage();
  const p = c.page;
  await p.addInitScript(
    ({ key, json }) => {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, json);
      localStorage.setItem('kanzai-navi:tab', 'home');
      localStorage.setItem('kanzai-navi:budget-tab', 'month');
    },
    { key: DATA_KEY, json: JSON.stringify(longData()) },
  );
  const t0 = performance.now();
  await p.goto(BASE);
  await p.waitForSelector('#app:not([hidden])');
  const boot = performance.now() - t0;
  const ms = await p.evaluate(() => {
    document.querySelector('.tabbar [data-tab="budget"]').click(); // 家計タブ（今月）
    const t = performance.now();
    document.querySelector('[data-action="b-sub"][data-key="history"]').click();
    return performance.now() - t;
  });
  await p.waitForSelector('#hist-list');
  ok(ms < 1000, `履歴（600期間）を開いて描き終えるまで ${Math.round(ms)}ms（1000ms 未満）。起動は ${Math.round(boot)}ms`);
  const s = await stored(p);
  ok(Object.keys(s.budget.snapshots).length === 600, `履歴は600期間のまま（${Object.keys(s.budget.snapshots).length}）`);
  ok((await rows(p).count()) === 1 + 24, `一覧は、今の期間＋24期間だけ出す（${await rows(p).count()}行）`);
  ok((await text('[data-action="b-hist-more"]', p)).includes('あと576期間'), `「もっと見る（あと576期間）」：${await text('[data-action="b-hist-more"]', p)}`);
  ok((await text('#hist-list .card-sub', p)).includes('600期間'), '全部で600期間');
  ok((await p.locator('#hist-chart .hs-col').count()) === 12, '棒グラフは最近12期間');
  const ms2 = await p.evaluate(() => {
    const t = performance.now();
    document.querySelector('[data-action="b-hist-more"]').click();
    return performance.now() - t;
  });
  ok((await rows(p).count()) === 1 + 48, `「もっと見る」で48期間になる（${await rows(p).count()}行・${Math.round(ms2)}ms）`);
  ok(await noOverflow(p), '横にはみ出さない');
  // 一番古い期間までたどれる
  for (let i = 0; i < 24; i += 1) {
    if (await p.locator('[data-action="b-hist-more"]').count()) await p.click('[data-action="b-hist-more"]');
  }
  ok((await rows(p).count()) === 601, `最後まで出すと、今の期間＋600期間（${await rows(p).count()}行）`);
  ok((await p.locator('[data-action="b-hist-more"]').count()) === 0, '全部出したら「もっと見る」は消える');
  ok(flat(await rows(p).last().innerText()).startsWith('1976年11月1日〜11月30日'), `いちばん古い期間：${flat(await rows(p).last().innerText()).slice(0, 24)}`);
  await c.context.close();
}

// =====================================================================
// 3. 完済ナビとの連携
// =====================================================================

const debtOf = (id, name, balance, rate, payment) => ({ id, name, balance, rate, payment, startBalance: balance, createdAt: T0, updatedAt: T0 });
/**
 * 借入2社（A社 残高10万・年利15%・毎月1万円、B社 残高20万・年利18%・毎月1.2万円）＋毎月の余剰金 5,000円。給料日1日（11/1〜11/30）
 * 収入25万 − 固定費（家賃7万＋返済 1万＋1.2万＝9.2万）＝ 上乗せの前の自由に使える額 158,000円、上乗せ 5,000円を引いて 153,000円
 * 出費：11/10 に 8,000円、11/26 に 1,500円 ＝ 使った額 9,500円 → 余り 143,500円
 */
function linkData(opts = {}) {
  const d = baseData({ since: '2026-11-01' });
  d.debts = [debtOf('d-a', 'テストA社', 100000, 15, 10000), debtOf('d-b', 'テストB社', 200000, 18, 12000)];
  if (opts.single) d.debts.pop();
  d.plan = { lumpSum: 0, monthlyExtra: 5000 };
  d.budget.spends = [sp('k-1', '2026-11-10', 8000, 'daily', 'テスト日用品'), sp('k-2', '2026-11-26', 1500, 'food', 'テスト昼食')];
  if (opts.noBudget) d.budget = emptyBudgetData().budget;
  return d;
}
const heroText = (p) => text('.hero-value', p).then((s) => yenNum(s));
const statText = async (p, label) => (await p.locator('.today-card .stat').filter({ has: p.locator('.stat-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.stat-value').innerText()).replace(/\s/g, '');

step('提案画面：家計の「自由に使える額（返済への上乗せの前）」を目安に出す。毎月の余剰金が超えたら注意する');
{
  const c = await newPage();
  const p = c.page;
  await openApp(p, linkData(), 'month', '#today-card');
  await p.click('[data-tab="plan"]');
  await p.waitForSelector('#plan-guide-text');
  let g = flat(await text('#plan-guide-text', p));
  ok(g.includes('158,000円') && g.includes('11月1日〜11月30日') && g.includes('返済への上乗せの前'), `目安：158,000円（今の期間 11月1日〜11月30日）：${g}`);
  ok((await p.locator('#plan-guide-text.warn').count()) === 0 && (await p.locator('#plan-guide-text.note').count()) === 1, '毎月の余剰金 5,000円は目安以内：注意は出ない');
  ok((await p.locator('#plan-guide-text [data-goto="budget"]').count()) === 1, '「家計を見る」の入口がある');
  await p.fill('#plan-extra', '158000');
  await p.waitForTimeout(100);
  ok((await p.locator('#plan-guide-text.warn').count()) === 0, '余剰金が目安と同じ額（158,000円）なら、超えていない');
  await p.fill('#plan-extra', '200000');
  await p.waitForTimeout(100);
  g = flat(await text('#plan-guide-text', p));
  ok((await p.locator('#plan-guide-text.warn').count()) === 1, '余剰金 200,000円は目安を超える：注意（赤）が出る');
  ok(g.includes('200,000円') && g.includes('158,000円') && g.includes('42,000円 超えています') && g.includes('確かめてみてください'), `超えた額と、責めない言葉：${g}`);
  ok((await p.locator('#plan-guide-text.warn svg').count()) === 2 || (await p.locator('#plan-guide-text.warn > svg').count()) === 1, '赤だけでなく、警告アイコンがつく');
  ok(!g.includes('いけません') && !g.includes('ダメ') && !g.includes('使いすぎ'), '責める言葉を使っていない');
  const s = await stored(p);
  ok(s.plan.monthlyExtra === 200000, '入力はそのまま保存される（毎月の余剰金 200,000円）');
  await shot('plan-guide-over-393', p, false);
  await p.fill('#plan-extra', '1万');
  await p.waitForTimeout(100);
  ok((await p.locator('#plan-guide-text.warn').count()) === 0, '余剰金を 10,000円に戻すと、注意は消える');
  ok(await noOverflow(p), '横にはみ出さない');
  await c.context.close();
}
{
  // 上乗せの前でもマイナス（収入10万・家賃15万・返済 2.2万 → −72,000円）
  const c = await newPage();
  const d = linkData();
  d.budget.incomes[0].amount = 100000;
  d.budget.fixed[0].amount = 150000;
  await openApp(c.page, d, 'month', '#today-card');
  await c.page.click('[data-tab="plan"]');
  await c.page.waitForSelector('#plan-guide-text');
  const g = flat(await text('#plan-guide-text', c.page));
  ok((await c.page.locator('#plan-guide-text.warn').count()) === 1 && g.includes('−72,000円') && g.includes('5,000円'), `目安がマイナス＋余剰金あり：注意が出る：${g}`);
  await shot('plan-guide-negative-360', c.page, false);
  await c.context.close();
}
{
  // 家計に何も入れていないときは、目安を出さない
  const c = await newPage();
  await openApp(c.page, linkData({ noBudget: true }), 'month', '.empty');
  await c.page.click('[data-tab="plan"]');
  await c.page.waitForSelector('#plan-guide', { state: 'attached' });
  ok((await c.page.locator('#plan-guide-text').count()) === 0 && (await text('#plan-guide', c.page)) === '', '家計に何も入れていない：目安は出ない');
  await c.page.fill('#plan-extra', '300000');
  await c.page.waitForTimeout(100);
  ok((await c.page.locator('#plan-guide-text').count()) === 0, '余剰金をどれだけ入れても、注意は出ない');
  await c.context.close();
}
{
  // 出費だけ入れていて、収入・固定費がないとき：目安は出す（収入0・返済だけ → マイナス）
  const c = await newPage();
  const d = linkData();
  d.budget.incomes = [];
  d.budget.fixed = [];
  await openApp(c.page, d, 'month', '#today-card');
  await c.page.click('[data-tab="plan"]');
  await c.page.waitForSelector('#plan-guide-text');
  ok(flat(await text('#plan-guide-text', c.page)).includes('−22,000円'), `出費だけの家計：目安は 収入0 − 返済 22,000円 ＝ −22,000円：${flat(await text('#plan-guide-text', c.page))}`);
  await c.context.close();
}

step('返済の記録は出費ではない：記録しても、家計の使った額・余りは変わらない');
{
  const c = await newPage();
  const p = c.page;
  await openApp(p, linkData(), 'month', '#today-card');
  ok((await statText(p, '使った額')) === '9,500円' && (await statText(p, '余り')) === '143,500円', '記録の前：使った額 9,500円・余り 143,500円');
  ok((await heroText(p)) === 153000, '記録の前：自由に使える額 153,000円');
  const before = await stored(p);
  await p.click('[data-tab="home"]');
  await p.click('.debt:has-text("テストA社") [data-action="add-record"]');
  await p.waitForSelector('#record-form');
  await p.fill('#r-amount', '30000'); // 毎月の返済より多く払う
  await p.click('#record-form button[type="submit"]');
  await sheetClosed(p);
  await p.click('[data-tab="records"]');
  ok((await p.locator('.rec').count()) === 1, '返済の記録が1件できた（記録タブ）');
  await p.click('[data-tab="budget"]');
  await p.waitForSelector('#today-card');
  ok((await statText(p, '使った額')) === '9,500円' && (await statText(p, '余り')) === '143,500円', '記録のあと：使った額 9,500円・余り 143,500円のまま');
  ok((await heroText(p)) === 153000, '記録のあとも：自由に使える額 153,000円のまま（返済額は変わらないので）');
  const after = await stored(p);
  ok(after.budget.spends.length === before.budget.spends.length && after.records.length === 1, `家計の出費は増えない（${after.budget.spends.length}件）。返済の記録だけが1件増える`);
  ok(JSON.stringify(after.budget.snapshots) === JSON.stringify(before.budget.snapshots), '履歴（確定した期間）も変わらない');
  await p.click('[data-action="b-sub"][data-key="history"]');
  await p.waitForSelector('#hist-list');
  ok(flat(await rowText(0, p)).includes('使った額 9,500円'), '履歴の画面の「今の期間」も、使った額 9,500円のまま');
  await c.context.close();
}

step('完済のお祝い：「余剰金に足す」と「自由に使う（足さない）」の意味がわかる文言');
async function payOffA(p) {
  await p.click('[data-tab="home"]');
  await p.click('.debt:has-text("テストA社") [data-action="add-record"]');
  await p.waitForSelector('#record-form');
  await p.click('[data-rtype="extra"]');
  const balance = Number((await p.locator('#r-debt option:checked').innerText()).match(/残高 ([\d,]+)円/)[1].replace(/,/g, ''));
  await p.fill('#r-amount', String(balance));
  await p.click('#record-form button[type="submit"]');
  await p.waitForFunction(() => document.getElementById('modal').open);
}
{
  const c = await newPage();
  const p = c.page;
  await openApp(p, linkData(), 'month', '#today-card');
  await payOffA(p);
  const title = await text('#modal .modal-title', p);
  const msg = await text('#modal .modal-text', p);
  ok(title.includes('テストA社 を完済しました'), `タイトル：${title}`);
  ok(msg.includes('毎月払っていた 10,000円 が、浮きます'), '浮くお金（毎月の返済額）を言っている');
  ok(msg.includes('・余剰金に足す：「毎月の余剰金」に 10,000円 を足して、ほかの会社の返済に回します'), '「余剰金に足す」の意味');
  ok(msg.includes('・自由に使う（足さない）：返済には回さず、自由に使えるお金にします。家計の「自由に使える額」が、10,000円 増えます'), '「自由に使う（足さない）」の意味と、家計への影響');
  const labels = (await p.locator('#modal .modal-actions .btn').allInnerTexts()).map((s) => s.trim());
  ok(labels.join('/') === '自由に使う/余剰金に足す', `ボタン：${labels.join(' / ')}`);
  const btnH = await p.locator('#modal .modal-actions .btn').evaluateAll((els) => Math.min(...els.map((e) => e.getBoundingClientRect().height)));
  ok(btnH >= 44, `ボタンの高さ ${btnH}px（44px以上）`);
  await shot('celebrate-393', p, false);
  await answer(false, p); // 自由に使う
  ok((await text('#toast', p)) === '足さずに、自由に使えるお金にしました', `トースト：${await text('#toast', p)}`);
  const s = await stored(p);
  ok(s.plan.monthlyExtra === 5000, '「自由に使う」：毎月の余剰金は 5,000円のまま');
  await p.click('[data-tab="budget"]');
  await p.waitForSelector('#today-card');
  // 固定費 7万＋B社 1.2万＝8.2万 → 25万 − 8.2万 − 上乗せ 5,000 ＝ 163,000円（A社の 10,000円が自由に使えるお金になった）
  ok((await heroText(p)) === 163000, '家計の自由に使える額：153,000円 → 163,000円（A社の分 10,000円が増えた）');
  await c.context.close();
}
{
  const c = await newPage();
  const p = c.page;
  await openApp(p, linkData(), 'month', '#today-card');
  await payOffA(p);
  await answer(true, p); // 余剰金に足す
  ok((await text('#toast', p)) === '毎月の余剰金を 15,000円 にしました', `トースト：${await text('#toast', p)}`);
  const s = await stored(p);
  ok(s.plan.monthlyExtra === 15000, '「余剰金に足す」：毎月の余剰金 5,000円 → 15,000円');
  await p.click('[data-tab="budget"]');
  await p.waitForSelector('#today-card');
  ok((await heroText(p)) === 153000, '家計の自由に使える額は 153,000円のまま（返済から外れたぶんを、上乗せに回したので）');
  await c.context.close();
}
{
  // 家計に何も入れていないときは、家計の話をしない
  const c = await newPage();
  const p = c.page;
  await openApp(p, linkData({ noBudget: true }), 'month', '.empty');
  await payOffA(p);
  const msg = await text('#modal .modal-text', p);
  ok(msg.includes('・余剰金に足す：') && msg.includes('・自由に使う（足さない）：返済には回さず、自由に使えるお金にします。') && !msg.includes('家計'), `家計が空なら、家計の話はしない：${flat(msg)}`);
  await c.context.close();
}
{
  // 全部完済したとき
  const c = await newPage();
  const p = c.page;
  await openApp(p, linkData({ single: true }), 'month', '#today-card');
  await payOffA(p);
  const msg = await text('#modal .modal-text', p);
  ok((await text('#modal .modal-title', p)).includes('すべての会社を完済しました') && msg.includes('家計の「自由に使える額」は、返済と返済への上乗せがなくなったぶん、増えます'), `全部完済：家計の一言つき：${flat(msg)}`);
  await answer(true, p);
  await p.click('[data-tab="budget"]');
  await p.waitForSelector('#today-card');
  // 収入25万 − 家賃7万 ＝ 18万円。返済も上乗せもなくなった
  ok((await heroText(p)) === 180000, '全部完済したあとの自由に使える額：180,000円');
  await c.context.close();
}

// >>> 追記する工程：2. もしも ／ 4. バックアップ ／ 5. 仕上げ <<<

console.log('\n---- コンソールのエラー・警告 ----');
console.log(problems.length ? problems.join('\n') : '（なし）');
if (problems.length) throw new Error('NG: コンソールにエラー・警告が出ている');
await context.close();
await browser.close();
server.close();
console.log('\nALL DONE');
