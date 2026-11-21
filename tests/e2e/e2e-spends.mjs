// 出費の記録（家計タブ「今月」）の通しテスト。保存データを直接入れて、画面から操作する（架空のデータだけ）
// 実行：npm run e2e（単独なら node tests/e2e/e2e-spends.mjs [スクリーンショットのフォルダー]）
// 「今日」は 2026-11-26（木）の10時に固定する。給料日25日の期間：11月25日〜12月24日（30日間）。
//   前の期間：10月23日〜11月24日（10/25 が日曜なので前倒し）、その前：9月25日〜10月22日
// 数字は、テスト側で手計算した答えと照らし合わせる（アプリの計算関数は使わない）。
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, PREFIX } from './serve.mjs';

const OUT = process.argv[2] || join(tmpdir(), 'kanzai-e2e', 'spends');
mkdirSync(OUT, { recursive: true });
const PORT = 8127;
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
/**
 * スマホのキーボードを真似る：見える範囲（visualViewport）の高さだけを小さくする（Android の Chrome と同じ。画面の高さは変わらない）。
 * height＝キーボードを除いた見える高さ。null なら元に戻す。本物のキーボードは出せないので、仕組みだけを確かめる
 */
async function fakeKeyboard(p, height) {
  await p.evaluate((h) => {
    const vv = window.visualViewport;
    if (h === null) delete vv.height;
    else Object.defineProperty(vv, 'height', { configurable: true, get: () => h });
    vv.dispatchEvent(new Event('resize'));
  }, height);
  await p.waitForTimeout(120);
}
/** 「−46,697円」「3,803円」→ 数字（マイナスは U+2212 の「−」） */
const yenNum = (s) => {
  const v = Number(s.replace(/[^\d]/g, ''));
  return /[−-]/.test(s) ? -v : v;
};

// ---------------------------------------------------------------
// 保存データ（架空）。収入 25万 − 家賃 7万 ＝ 毎期 18万円（自由に使える額）。借入なし
// ---------------------------------------------------------------
const DATA_KEY = 'kanzai-navi:data';
const CAT = { food: 'food', daily: 'daily', transport: 'transport', social: 'social', fun: 'fun' };
const T0 = '2026-11-01T00:00:00.000Z';
const sp = (id, date, amount, category = '', memo = '') => ({ id, date, amount, category, memo, createdAt: T0 });

function baseData() {
  return {
    version: 1,
    debts: [],
    records: [],
    plan: { lumpSum: 0, monthlyExtra: 0 },
    budget: {
      settings: { payday: 25, shiftEarly: true, savings: { mode: 'amount', value: 0 }, since: '2026-09-01' },
      incomes: [{ id: 'inc-1', name: 'テスト給料', kind: 'monthly', amount: 250000, months: [], day: 1, enabled: true, createdAt: T0, updatedAt: T0 }],
      fixed: [
        { id: 'fix-1', name: 'テスト家賃', category: 'housing', kind: 'monthly', amount: 70000, every: 12, dueMonth: 1, dueDay: 1, mode: 'lump', uses: { by: 'weekdays', days: [1, 2, 3, 4, 5], skipHolidays: true, count: 0 }, enabled: true, createdAt: T0, updatedAt: T0 },
      ],
      entries: [],
      overrides: {},
      spends: [
        // 9/25〜10/22（確定する期間）
        sp('s-a', '2026-10-05', 5000, CAT.food, 'テスト食材'),
        // 10/23〜11/24（確定する期間）
        sp('s-b', '2026-10-30', 3000, CAT.daily, 'テスト日用品'),
        sp('s-c', '2026-11-10', 12000, CAT.fun, 'テスト娯楽'),
        // 11/25〜12/24（今の期間）。今日は 11/26
        sp('s-d', '2026-11-25', 3000, CAT.food, 'テスト夕食'),
        sp('s-e', '2026-11-26', 1500, CAT.food, 'テスト昼食'),
        sp('s-f', '2026-11-26', 800, CAT.transport, ''),
        sp('s-g', '2026-12-05', 7000, CAT.social, 'テスト飲み会'),
      ],
      // 9/25〜10/22 の履歴だけ、わざと古い「使った額」（999）にしておく。起動時に 5,000 へ直るはず。10/23〜11/24 は無いので、起動時に作られる
      snapshots: {
        '2026-09-25': { start: '2026-09-25', end: '2026-10-22', income: 250000, fixed: 70000, savings: 0, extra: 0, free: 180000, spent: 999, leftover: 179001, closedAt: T0 },
      },
    },
    meta: { createdAt: T0, updatedAt: T0, lastBackupAt: null },
  };
}

/** 2000件（または count 件）の出費を、今の期間（11/25〜12/24）に入れたデータ。1件 10〜99円 */
function bigData(count) {
  const d = baseData();
  d.budget.spends = [];
  const cats = ['food', 'daily', 'transport', 'social', 'fun', 'beauty', 'medical', 'other', ''];
  const start = Date.UTC(2026, 10, 25);
  for (let i = 0; i < count; i += 1) {
    const day = new Date(start + (i % 30) * 86400000).toISOString().slice(0, 10);
    d.budget.spends.push(sp(`big-${i}`, day, 10 + ((i * 7) % 90), cats[i % cats.length], i % 4 === 0 ? `テストメモ${i}` : ''));
  }
  return d;
}

async function openApp(p, data) {
  await p.addInitScript(
    ({ key, json }) => {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, json);
      localStorage.setItem('kanzai-navi:tab', 'budget');
      localStorage.setItem('kanzai-navi:budget-tab', 'month');
    },
    { key: DATA_KEY, json: JSON.stringify(data) },
  );
  await p.goto(BASE);
  await p.waitForSelector('#app:not([hidden])');
  await p.waitForSelector('#today-card');
}

// ---------------------------------------------------------------
const { context, page } = await newPage();
const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), DATA_KEY);
const text = (sel) => page.locator(sel).first().innerText();
const sheetOpen = () => page.waitForFunction(() => document.getElementById('sheet').open);
const sheetClosed = () => page.waitForFunction(() => !document.getElementById('sheet').open);
const answer = async (yes) => {
  await page.waitForFunction(() => document.getElementById('modal').open);
  await page.click(`#modal [data-answer="${yes ? 'yes' : 'no'}"]`);
  await page.waitForFunction(() => !document.getElementById('modal').open);
};
const statBox = (p, label) => p.locator('.today-card .stat').filter({ has: p.locator('.stat-label', { hasText: new RegExp(`^${label}$`) }) });
const statValue = async (label) => (await statBox(page, label).locator('.stat-value').innerText()).replace(/\s/g, '');
const toastText = () => page.locator('#toast').innerText();
const rowAmounts = async () => (await page.locator('#spend-list .brow .brow-amt').allInnerTexts()).map((s) => s.trim());
const snap = async (key) => (await stored()).budget.snapshots[key];
const spendById = async (id) => (await stored()).budget.spends.find((s) => s.id === id);

step('起動：履歴を直す（古い「使った額」が直り、無い期間が作られる）');
await openApp(page, baseData());
{
  const s = await stored();
  const p2 = s.budget.snapshots['2026-09-25'];
  ok(p2.spent === 5000 && p2.leftover === 175000, `9/25〜10/22 の古い履歴（使った額 999）が、起動時に直る：使った額 ${p2.spent}・余り ${p2.leftover}`);
  const p1 = s.budget.snapshots['2026-10-23'];
  ok(p1 && p1.spent === 15000 && p1.leftover === 165000 && p1.free === 180000, `10/23〜11/24 の履歴が作られる：使った額 ${p1?.spent}（3,000＋12,000）・余り ${p1?.leftover}`);
  ok(!s.budget.snapshots['2026-11-25'], '今の期間（11/25〜）はまだ確定しない');
  ok(!s.budget.snapshots['2026-08-25'], 'since（9/1）より前に始まった期間（8/25〜）は作らない');
}

step('今月：今日あと・使った額・余り（今日 11/26。残り29日）');
ok((await text('.pnav-range')) === '11月25日〜12月24日', '期間は 11月25日〜12月24日');
// 自由に使える額 18万。今日より前の出費 3,000（11/25）。今日の目安＝floor((180,000−3,000)÷29)＝floor(6103.4)＝6,103
// 今日の出費 1,500＋800＝2,300 → 今日あと 3,803。使った額 3,000＋2,300＋7,000（12/5）＝12,300、余り 167,700
// 明日以降の1日あたり＝floor(167,700÷28)＝floor(5989.3)＝5,989
ok(((await text('.hero-value')).replace(/\s/g, '')) === '180,000円', '自由に使える額：180,000円');
ok(yenNum(await text('#today-left')) === 3803, '今日あと：3,803円（6,103 − 2,300）');
ok((await text('.today-note')).includes('今日の目安 6,103円 のうち 2,300円 使いました'), '説明：今日の目安 6,103円のうち 2,300円 使いました');
ok((await statValue('明日以降の1日あたり')) === '5,989円', '明日以降の1日あたり：5,989円');
ok((await statValue('残り日数')) === '29日', '残り日数：29日（今日を含む）');
ok((await statValue('使った額')) === '12,300円', '使った額：12,300円（今日より先の 12/5 の 7,000円も入る）');
ok((await statValue('余り')) === '167,700円', '余り：167,700円');
ok((await page.locator('#today-left.is-neg').count()) === 0, '使いすぎていないので、赤くない');
ok((await text('.today-card .hint')).includes('固定費（単価×回数）に入れたものは、出費として記録しなくて大丈夫'), '一言ヒント：固定費に入れたものは記録しなくてよい');
ok((await text('.today-card .btn-primary')).includes('出費を記録'), '「出費を記録」ボタン');
{
  const y = await page.evaluate(() => ({ btn: document.querySelector('[data-action="b-spend-add"]').getBoundingClientRect().bottom, today: document.querySelector('#today-left').getBoundingClientRect().bottom, vh: innerHeight }));
  ok(y.today < y.vh && y.btn < y.vh, `スクロールしなくても「今日あと」（下端 ${Math.round(y.today)}）と記録ボタン（下端 ${Math.round(y.btn)}）が見える（画面の高さ ${y.vh}）`);
}

step('出費の一覧：日ごと（新しい日が先）。日の合計つき');
const heads = await page.locator('#spend-list .day-head').allInnerTexts();
ok(heads.length === 3, `日の見出しが3つ（12/5・11/26・11/25）：${heads.map((h) => h.replace(/\s+/g, ' ')).join(' / ')}`);
ok(heads[0].includes('12月5日（土）') && heads[0].includes('7,000円'), '12月5日（土）7,000円');
ok(heads[1].includes('11月26日（木）') && heads[1].includes('今日') && heads[1].includes('2,300円'), '11月26日（木）に「今日」の印、合計 2,300円（1,500＋800）');
ok(heads[2].includes('11月25日（水）') && heads[2].includes('3,000円'), '11月25日（水）3,000円');
ok((await rowAmounts()).join('|') === '7,000円|800円|1,500円|3,000円', '行の並び：同じ日はあとから記録したものが先（800円 → 1,500円）');
ok((await text('#spend-list [data-id="s-f"]')).includes('交通'), 'メモなしの行は、カテゴリ名（交通）が名前になる');
ok((await text('#spend-list [data-id="s-g"]')).includes('テスト飲み会') && (await text('#spend-list [data-id="s-g"]')).includes('交際'), 'メモつきの行は、メモが名前でカテゴリが補足');
ok((await text('#spend-list .card-sub')).includes('4件・合計 12,300円'), '4件・合計 12,300円');
{
  // 設計書「6」の並び（積み上げ棒・くわしい内訳のあとに今日あと）にすると、記録ボタンが画面の外になることの確認
  const r = await page.evaluate(() => ({ breakdownBottom: document.querySelector('.breakdown').getBoundingClientRect().bottom, vh: innerHeight }));
  ok(r.breakdownBottom > r.vh, `もし「今日あと」を内訳のあとに置くと、その上端は約${Math.round(r.breakdownBottom)}px（画面の高さ ${r.vh}px の外）になる → 自由に使える額のすぐ下に置いた理由`);
}

step('カテゴリ別の内訳：多い順の横棒。値は棒の先。カテゴリなしも数える');
{
  const rows = await page.locator('#spend-category .hbar-row').allInnerTexts();
  ok(rows.length === 3, `3カテゴリ：${rows.map((r) => r.replace(/\s+/g, ' ')).join(' / ')}`);
  ok(rows[0].includes('交際') && rows[0].includes('7,000円'), '1位 交際 7,000円');
  ok(rows[1].includes('食費') && rows[1].includes('4,500円') && rows[1].includes('2件'), '2位 食費 4,500円（3,000＋1,500）2件');
  ok(rows[2].includes('交通') && rows[2].includes('800円'), '3位 交通 800円');
  const w = await page.locator('#spend-category .hbar').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  ok(w[0] > w[1] && w[1] > w[2], `棒は多い順に短くなる：${w.map((x) => Math.round(x)).join(' > ')}`);
  ok(Math.abs(w[1] / w[0] - 4500 / 7000) < 0.02 && Math.abs(w[2] / w[0] - 800 / 7000) < 0.02, '棒の長さは金額に比例（1位を基準に 64%・11%）');
  const colors = await page.locator('#spend-category .hbar').evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).backgroundColor))]);
  ok(colors.length === 1 && colors[0] === 'rgb(42, 120, 214)', '棒は1色だけ（スロット1の青 #2a78d6。検証済みの値）');
  ok((await page.locator('#spend-category .legend, #spend-category .lsw').count()) === 0, '凡例は置かない（1つの系列）');
  await page.click('#spend-category .table-view summary');
  const trs = await page.locator('#spend-category tbody tr').allInnerTexts();
  ok(trs.length === 3 && trs[0].replace(/\s+/g, ' ').includes('交際 7,000円 1件'), `「表で見る」に同じ値が出る：${trs[0].replace(/\s+/g, ' ')}`);
  await page.click('#spend-category .table-view summary');
}
await shot('w393-light-month', page);
ok(await noOverflow(page), '今月は横にはみ出さない');

step('出費を記録：金額（全角数字）・日付（初期は今日）・カテゴリ・メモ。「続けて入力」で連続して入れる');
await page.click('[data-action="b-spend-add"]');
await sheetOpen();
ok((await page.inputValue('#sp-date')) === '2026-11-26', '日付の初期値は今日（11/26）');
const focused = (sel) => page.locator(sel).evaluate((el) => el === document.activeElement);
ok(!(await focused('#sp-amount')), '開いただけでは、金額の欄にカーソルは入らない（数字キーボードが勝手に出ない）');
ok((await page.getAttribute('#sp-amount', 'enterkeyhint')) === 'done' && (await page.getAttribute('#sp-memo', 'enterkeyhint')) === 'done', 'キーボードの Enter のキーは「完了」（enterkeyhint=done）');
// Enter では記録しない：キーボードを閉じるだけ（日付やカテゴリを選んでから「記録する」を押す）
const spendCount = async () => (await stored()).budget.spends.length;
ok((await spendCount()) === 7, '記録前は出費7件');
await page.fill('#sp-amount', '5万');
await page.press('#sp-amount', 'Enter');
ok(await page.evaluate(() => document.getElementById('sheet').open), '金額で Enter：シートは開いたまま（記録されない）');
ok((await spendCount()) === 7, '金額で Enter：保存されていない');
ok(!(await focused('#sp-amount')), '金額で Enter：カーソルが外れる（キーボードが閉じる）');
ok((await page.inputValue('#sp-amount')) === '50,000', '金額で Enter：「5万」が 50,000 に直る');
await page.fill('#sp-memo', 'テストEnter');
await page.press('#sp-memo', 'Enter');
ok((await page.evaluate(() => document.getElementById('sheet').open)) && (await spendCount()) === 7 && !(await focused('#sp-memo')), 'メモで Enter：記録されず、キーボードだけ閉じる');
{
  // 日本語の変換中の Enter（文字の確定）には、手を出さない
  const r = await page.evaluate(() => {
    const el = document.getElementById('sp-memo');
    el.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, focused: document.activeElement === el };
  });
  ok(!r.prevented && r.focused, '変換中の Enter は、そのまま通す（カーソルも外れない）');
}
await page.fill('#sp-amount', '');
await page.fill('#sp-memo', '');

step('キーボードが出たら、シートが上に持ち上がる（見える高さを小さくして、キーボードを真似る）');
await fakeKeyboard(page, 540); // 画面の高さ852のうち、下の312pxがキーボード
await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--kb') === '312px');
{
  const r = await page.evaluate(() => {
    const sheet = document.getElementById('sheet').getBoundingClientRect();
    const inner = document.querySelector('.sheet-inner');
    return { top: sheet.top, bottom: sheet.bottom, scrolls: inner.scrollHeight > inner.clientHeight };
  });
  ok(Math.abs(r.bottom - 540) <= 1 && r.top >= 0, `シートの下端が、キーボードの上（540px）にある：${Math.round(r.top)}〜${Math.round(r.bottom)}px`);
  ok(r.scrolls, 'シートの中は、スクロールして全部の欄に届く');
  await page.locator('#b-spend-form button[type="submit"]').scrollIntoViewIfNeeded();
  const b = await page.evaluate(() => document.querySelector('#b-spend-form button[type="submit"]').getBoundingClientRect().bottom);
  ok(b <= 541, `スクロールすると、「記録する」もキーボードの上に出る（下端 ${Math.round(b)}px）`);
  await shot('w393-light-spend-sheet-keyboard', page, false);
}
await fakeKeyboard(page, 792); // アドレスバーの出入り程度（60px）は、キーボードとは見なさない
ok((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--kb'))) === '0px', '60pxの差は、キーボードとは見なさない');
await fakeKeyboard(page, null); // キーボードが閉じる
ok(Math.abs((await page.evaluate(() => document.getElementById('sheet').getBoundingClientRect().bottom)) - 852) <= 1, 'キーボードが閉じると、シートは元の位置（画面の下）に戻る');

step('出費を記録：入力ミスのチェック・カテゴリ・「続けて入力」');
await page.click('#b-spend-form button[type="submit"]');
ok((await text('#sp-amount-err')).includes('金額を入れてください'), '金額が空だと、エラー');
await page.fill('#sp-amount', 'あいう');
ok((await text('#sp-amount-err')).includes('数字で'), '数字以外は、エラー');
await page.fill('#sp-amount', '０');
ok((await text('#sp-amount-err')).includes('1円以上'), '0円は、エラー');
await shot('w393-light-spend-sheet-error', page, false);
await page.fill('#sp-amount', '２００'); // 全角
await page.click('[data-action="b-spend-cat"][data-v="daily"]');
ok((await page.getAttribute('[data-action="b-spend-cat"][data-v="daily"]', 'aria-pressed')) === 'true', 'カテゴリ「日用品」を選ぶ');
await page.click('[data-action="b-spend-cat"][data-v="fun"]');
ok((await page.locator('[data-spend-cats] [aria-pressed="true"]').count()) === 1 && (await page.getAttribute('[data-action="b-spend-cat"][data-v="fun"]', 'aria-pressed')) === 'true', 'カテゴリは1つだけ選べる（娯楽に変わる）');
await page.click('[data-action="b-spend-cat"][data-v="fun"]');
ok((await page.locator('[data-spend-cats] [aria-pressed="true"]').count()) === 0, '選んでいるものをもう一度押すと、カテゴリなしに戻る');
await page.click('[data-action="b-spend-cat"][data-v="daily"]');
await page.fill('#sp-memo', 'テストA');
await page.click('[data-action="b-spend-continue"]');
ok(await page.evaluate(() => document.getElementById('sheet').open), '「続けて入力」：記録したあとも、シートは開いたまま');
ok((await page.inputValue('#sp-amount')) === '' && (await page.inputValue('#sp-memo')) === '', '金額とメモが空になる');
ok((await page.inputValue('#sp-date')) === '2026-11-26', '日付はそのまま');
ok((await page.locator('[data-spend-cats] [aria-pressed="true"]').count()) === 0, 'カテゴリは選んでいない状態に戻る');
ok((await text('#sp-status')).includes('200円 を記録しました'), `メッセージ：${await text('#sp-status')}`);
ok(!(await focused('#sp-amount')), '続けて入力でも、キーボードは勝手に出ない（金額の欄を押すと出る）');
ok((await page.locator('#sp-amount-err').innerText()) === '', 'エラーは出ていない');
await shot('w393-light-spend-sheet-continued', page, false);
await page.fill('#sp-amount', '300');
await page.fill('#sp-memo', 'テストB');
await page.click('[data-action="b-spend-continue"]');
ok((await text('#sp-status')).includes('300円 を記録しました'), '2件目も続けて記録できる');
await page.fill('#sp-amount', '5万'); // 「5万」
await page.click('#b-spend-form button[type="submit"]');
await sheetClosed();
ok((await toastText()) === '記録しました', `「記録する」で閉じ、トースト：${await toastText()}`);
{
  const s = await stored();
  const mine = s.budget.spends.filter((x) => x.date === '2026-11-26' && !['s-e', 's-f'].includes(x.id));
  ok(mine.length === 3, '保存データに3件増えた');
  ok(mine.map((x) => x.amount).join(',') === '200,300,50000', '金額：200（全角）・300・50000（5万）');
  ok(mine[0].category === 'daily' && mine[0].memo === 'テストA' && mine[1].memo === 'テストB' && mine[1].category === '' && mine[2].category === '', 'カテゴリ・メモが保存される（カテゴリなしは空）');
}

step('使いすぎ：赤＋アイコン＋責めない言葉。数字は手計算と合わせる');
// 今日の出費 2,300＋200＋300＋50,000＝52,800。今日の目安は 6,103 のまま（今日の出費は引かない）→ 今日あと 6,103−52,800＝−46,697
// 使った額 12,300＋50,500＝62,800、余り 117,200。明日以降＝floor(117,200÷28)＝floor(4185.7)＝4,185
ok(yenNum(await text('#today-left')) === -46697, `今日あと：${(await text('#today-left')).trim()}（−46,697円）`);
ok((await page.locator('#today-left.is-neg svg').count()) === 1, '赤い数字にアイコンがつく（色だけに頼らない）');
{
  const color = await page.locator('#today-left').evaluate((el) => getComputedStyle(el).color);
  ok(color === 'rgb(180, 40, 40)', `色は赤（${color}）`);
}
const note = await text('.today-note');
ok(note.includes('目安の 6,103円 より 46,697円 多く使っています') && note.includes('明日以降は、1日あたり 4,185円 でならせます'), `責めない言葉：${note}`);
ok(!/ダメ|失敗|使いすぎです|ひどい/.test(note), '責める言葉は使わない');
ok((await statValue('明日以降の1日あたり')) === '4,185円' && (await statValue('使った額')) === '62,800円' && (await statValue('余り')) === '117,200円', '明日以降 4,185円・使った額 62,800円・余り 117,200円');
await shot('w393-light-month-over', page);

step('編集：5万 → 800円に直す。削除：確認してから消える');
await page.click('#spend-list .brow:has-text("50,000円")');
await sheetOpen();
ok((await page.inputValue('#sp-amount')) === '50,000', '編集：金額が入っている（50,000）');
ok((await page.locator('[data-action="b-spend-continue"]').count()) === 0, '編集には「続けて入力」は出ない');
await page.fill('#sp-amount', '８００');
await page.click('[data-action="b-spend-cat"][data-v="food"]');
await page.fill('#sp-memo', 'テスト直した');
await page.click('#b-spend-form button[type="submit"]');
await sheetClosed();
ok((await toastText()) === '保存しました', '保存のトースト');
{
  const s = await stored();
  const e = s.budget.spends.find((x) => x.memo === 'テスト直した');
  ok(e && e.amount === 800 && e.category === 'food', '保存データ：800円・食費');
}
// 今日の出費 2,300＋200＋300＋800＝3,600 → 今日あと 6,103−3,600＝2,503
ok(yenNum(await text('#today-left')) === 2503, '今日あと：2,503円（赤くなくなる）');
ok((await page.locator('#today-left.is-neg').count()) === 0, '赤が消える');
await page.click('#spend-list .brow:has-text("テストB")');
await sheetOpen();
await page.click('[data-action="b-spend-delete"]');
await answer(false);
ok((await stored()).budget.spends.some((x) => x.memo === 'テストB'), '確認で「キャンセル」すると、消えない');
await page.click('[data-action="b-spend-delete"]');
await answer(true);
await sheetClosed();
ok(!(await stored()).budget.spends.some((x) => x.memo === 'テストB'), '「削除する」で、保存データからも消える');
ok((await toastText()) === '削除しました', '削除のトースト');
// 今日の出費 2,300＋200＋800＝3,300 → 今日あと 2,803
ok(yenNum(await text('#today-left')) === 2803, '今日あと：2,803円');
// 今日のテスト用の出費（テストA・直した）を片づけて、基本のデータに戻す
for (const memo of ['テストA', 'テスト直した']) {
  await page.click(`#spend-list .brow:has-text("${memo}")`);
  await sheetOpen();
  await page.click('[data-action="b-spend-delete"]');
  await answer(true);
  await sheetClosed();
}
ok(yenNum(await text('#today-left')) === 3803 && (await statValue('余り')) === '167,700円', '基本のデータに戻った（今日あと 3,803円・余り 167,700円）');

step('見ている期間の外の日付で記録 → トーストで知らせる。次の期間は「今日あと」を出さない');
await page.click('[data-action="b-spend-add"]');
await sheetOpen();
await page.fill('#sp-amount', '1000');
await page.fill('#sp-date', '2026-12-26');
await page.click('#b-spend-form button[type="submit"]');
await sheetClosed();
ok((await toastText()) === '記録しました（12月26日は、別の期間です）', `トースト：${await toastText()}`);
ok((await statValue('使った額')) === '12,300円', 'この期間の使った額は変わらない');
await page.click('[data-action="b-next"]');
ok((await text('.pnav-range')) === '12月25日〜1月24日', '次の期間：12月25日〜1月24日');
ok((await page.locator('#today-left').count()) === 0 && (await page.locator('.today-card .stat').count()) === 2, '今日が入っていない期間は、「今日あと」などは出さず、使った額と余りだけ');
ok((await text('.today-card')).includes('「今日あと」は出しません'), '理由を一言で示す');
ok((await statValue('使った額')) === '1,000円' && (await statValue('余り')) === '179,000円', '使った額 1,000円・余り 179,000円（18万−1,000）');
ok((await text('#spend-list')).includes('12月26日（土）'), '一覧には、その日の出費が出る');
ok((await text('.today-card .btn-primary')).includes('出費を記録'), 'この期間でも記録ボタンは使える');
await shot('w393-light-month-next', page);
// 片づける
await page.click('#spend-list .brow');
await sheetOpen();
await page.click('[data-action="b-spend-delete"]');
await answer(true);
await sheetClosed();
ok((await text('#spend-list')).includes('この期間の出費は、まだありません'), '出費がない期間の案内');
ok((await page.locator('#spend-category').count()) === 0, '出費がなければ、カテゴリ別は出さない');

step('確定した期間の出費：追加・編集・削除・日付変更で、履歴の「使った額」「余り」が変わる');
await page.click('[data-action="b-now"]');
await page.click('[data-action="b-prev"]');
ok((await text('.pnav-range')) === '10月23日〜11月24日', '前の期間：10月23日〜11月24日');
ok((await page.locator('#today-left').count()) === 0, '過去の期間は「今日あと」を出さない');
ok((await statValue('使った額')) === '15,000円' && (await statValue('余り')) === '165,000円', '過去の期間：使った額 15,000円・余り 165,000円');
ok((await rowAmounts()).join('|') === '12,000円|3,000円', '一覧：11/10 の 12,000円・10/30 の 3,000円');
await shot('w393-light-month-past', page);
const keep = (s) => [s.start, s.end, s.income, s.fixed, s.savings, s.extra, s.free, s.closedAt].join(',');
const before = await snap('2026-10-23');
// 追加：11/05 に 20,000円
await page.click('[data-action="b-spend-add"]');
await sheetOpen();
await page.fill('#sp-amount', '20000');
await page.fill('#sp-date', '2026-11-05');
await page.fill('#sp-memo', 'テスト過去分');
await page.click('#b-spend-form button[type="submit"]');
await sheetClosed();
ok((await toastText()) === '記録しました', '見ている期間の中の日付なら、トーストに「別の期間」は付かない');
let s1 = await snap('2026-10-23');
ok(s1.spent === 35000 && s1.leftover === 145000, `追加：履歴の使った額 35,000円・余り 145,000円（${s1.spent}・${s1.leftover}）`);
ok(keep(s1) === keep(before), '収入・固定費・貯金・上乗せ・自由に使える額・確定日時は、確定のまま');
ok((await statValue('使った額')) === '35,000円', '画面の使った額も 35,000円');
// 編集：12,000 → 2,000
await page.click('#spend-list .brow:has-text("テスト娯楽")');
await sheetOpen();
await page.fill('#sp-amount', '2000');
await page.click('#b-spend-form button[type="submit"]');
await sheetClosed();
s1 = await snap('2026-10-23');
ok(s1.spent === 25000 && s1.leftover === 155000, `編集（12,000→2,000）：使った額 25,000円・余り 155,000円（${s1.spent}・${s1.leftover}）`);
// 削除：10/30 の 3,000円
await page.click('#spend-list .brow:has-text("テスト日用品")');
await sheetOpen();
await page.click('[data-action="b-spend-delete"]');
await answer(true);
await sheetClosed();
s1 = await snap('2026-10-23');
ok(s1.spent === 22000 && s1.leftover === 158000, `削除（3,000円）：使った額 22,000円・余り 158,000円（${s1.spent}・${s1.leftover}）`);
// 日付変更：11/05 の 20,000円 を 10/05（9/25〜10/22 の期間）へ → 両方の期が直る
const p2before = await snap('2026-09-25');
await page.click('#spend-list .brow:has-text("テスト過去分")');
await sheetOpen();
await page.fill('#sp-date', '2026-10-05');
await page.click('#b-spend-form button[type="submit"]');
await sheetClosed();
ok((await toastText()) === '保存しました（10月5日は、別の期間です）', `別の期間へ動かすと、トーストで知らせる：${await toastText()}`);
s1 = await snap('2026-10-23');
const s2 = await snap('2026-09-25');
ok(s1.spent === 2000 && s1.leftover === 178000, `日付変更：元の期（10/23〜）は 使った額 2,000円・余り 178,000円（${s1.spent}・${s1.leftover}）`);
ok(s2.spent === 25000 && s2.leftover === 155000, `日付変更：移った先（9/25〜）は 使った額 25,000円（5,000＋20,000）・余り 155,000円（${s2.spent}・${s2.leftover}）`);
ok(keep(s2) === keep(p2before), '移った先も、収入・固定費などは確定のまま');
{
  const cur = await stored();
  ok(cur.budget.snapshots['2026-11-25'] === undefined, '今の期間の履歴は、まだ作られない');
  ok(cur.budget.settings.since === '2026-09-01', 'since は変わらない');
}
// 起動のたびに直る（再読み込み）
await page.reload();
await page.waitForSelector('#app:not([hidden])');
{
  const s = await stored();
  ok(s.budget.snapshots['2026-10-23'].spent === 2000 && s.budget.snapshots['2026-09-25'].spent === 25000, '再読み込みしても、履歴はそのまま');
}

step('見た目：幅393・360、ライト・ダーク（目で確認する）');
async function review(label, opts, width, data) {
  const c = await newPage({ viewport: { width, height: 800 }, ...opts });
  const p = c.page;
  await openApp(p, data);
  ok(await noOverflow(p), `${label}：今月は横にはみ出さない`);
  const clipped = await p.evaluate(() =>
    [...document.querySelectorAll('.today-card .stat, .today-card .today-value, .hbar-row, .day-head, #spend-list .brow')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className),
  );
  ok(clipped.length === 0, `${label}：数字や文字が切れていない${clipped.length ? `（${clipped.join(',')}）` : ''}`);
  await shot(`${label}-month`, p);
  await p.click('[data-action="b-spend-add"]');
  await p.waitForFunction(() => document.getElementById('sheet').open);
  await p.fill('#sp-amount', '１２００');
  await p.click('[data-action="b-spend-cat"][data-v="beauty"]');
  await p.fill('#sp-memo', 'テストの長いメモ：これは長い文字を入れたときに、画面からはみ出さないかを見るための文です');
  ok(await noOverflow(p), `${label}：入力のシートも横にはみ出さない`);
  await shot(`${label}-spend-sheet`, p, false);
  // キーボード（下の320px）が出たとき：シートがその上に収まり、中をスクロールして「記録する」まで届く
  await fakeKeyboard(p, 480);
  const lift = await p.evaluate(() => {
    const r = document.getElementById('sheet').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  await p.locator('#b-spend-form button[type="submit"]').scrollIntoViewIfNeeded();
  const submitBottom = await p.evaluate(() => document.querySelector('#b-spend-form button[type="submit"]').getBoundingClientRect().bottom);
  ok(Math.abs(lift.bottom - 480) <= 1 && lift.top >= 0 && submitBottom <= 481, `${label}：キーボードが出ても、シートはその上（480px）に収まり、「記録する」まで届く（シート ${Math.round(lift.top)}〜${Math.round(lift.bottom)}px）`);
  await shot(`${label}-spend-sheet-keyboard`, p, false);
  await fakeKeyboard(p, null);
  await p.click('[data-action="b-spend-continue"]');
  await shot(`${label}-spend-sheet-continued`, p, false);
  await p.click('[data-action="close-sheet"]');
  await p.waitForFunction(() => !document.getElementById('sheet').open);
  await p.click('#spend-category .table-view summary');
  ok(await noOverflow(p), `${label}：表で見るを開いても、横にはみ出さない`);
  await shot(`${label}-month-table`, p);
  await c.context.close();
}
// 使いすぎの画面を見るため、今日の出費を大きくしたデータ（今日あと・余りとも赤）
const overData = baseData();
overData.budget.spends.push(sp('s-over', '2026-11-26', 190000, CAT.food, 'テスト大きな出費'));
await review('w393-dark', { colorScheme: 'dark' }, 393, baseData());
await review('w360-light', {}, 360, baseData());
await review('w360-dark', { colorScheme: 'dark' }, 360, baseData());
await review('w393-light-over', {}, 393, overData);
await review('w360-dark-over', { colorScheme: 'dark' }, 360, overData);
{
  const c = await newPage({ colorScheme: 'dark' });
  await openApp(c.page, baseData());
  const dc = await c.page.locator('#spend-category .hbar').evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).backgroundColor))]);
  ok(dc.length === 1 && dc[0] === 'rgb(57, 135, 229)', 'ダークの棒の色：#3987e5（検証済みの値）');
  await c.context.close();
}
{
  // 余りも今日あともマイナス：赤・アイコン・「◯円オーバー」
  const c = await newPage();
  await openApp(c.page, overData);
  const left = await c.page.locator('#today-left').innerText();
  ok(yenNum(left) < 0 && (await c.page.locator('#today-left svg').count()) === 1, `使いすぎの今日あと：赤＋アイコン（${left.trim()}）`);
  // 出費 190,000 は今日の出費（今日の目安は 6,103）。余り＝180,000−(3,000＋2,300＋7,000＋190,000)＝−22,300
  const stat = await statBox(c.page, '余り').innerText();
  ok(stat.includes('−22,300円') && stat.includes('22,300円オーバー'), `余り：−22,300円 ＋「22,300円オーバー」（${stat.replace(/\s+/g, ' ')}）`);
  ok((await c.page.locator('.today-card .stat .stat-value.is-neg svg').count()) === 1, '余りの赤にもアイコンがつく');
  const overNote = await c.page.locator('.today-note').innerText();
  ok(overNote.includes('目安の 6,103円 より 186,197円 多く使っています') && overNote.includes('この期間の余りがないため、明日以降の目安は 0円 です。') && !overNote.includes('でならせます'), `余りもマイナスのときは、「ならせます」とは言わない：${overNote}`);
  await c.context.close();
}

step('出費2000件：「今月」と一覧が重くならない（描画1秒以内の目安）');
async function heavy(count, label, limitMs, { atLimit = false } = {}) {
  const c = await newPage();
  const p = c.page;
  await p.addInitScript(
    ({ key, json }) => {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, json);
      localStorage.setItem('kanzai-navi:tab', 'home');
      localStorage.setItem('kanzai-navi:budget-tab', 'month');
    },
    { key: DATA_KEY, json: JSON.stringify(bigData(count)) },
  );
  const t0 = performance.now();
  await p.goto(BASE);
  await p.waitForSelector('#app:not([hidden])');
  const boot = performance.now() - t0;
  // 家計タブを開いて、今月と一覧が出るまで（ブラウザの中で測る）
  const ms = await p.evaluate(() => {
    const t = performance.now();
    document.querySelector('.tabbar [data-tab="budget"]').click();
    return performance.now() - t;
  });
  await p.waitForSelector('#spend-list .brow');
  ok(ms < limitMs, `${label}：「今月」を開いて描き終えるまで ${Math.round(ms)}ms（${limitMs}ms 未満）。起動は ${Math.round(boot)}ms`);
  const rows = await p.locator('#spend-list .brow').count();
  ok(rows === 100, `${label}：一覧は100件だけ出す（${rows}件）`);
  ok((await text0(p, '[data-action="b-spend-show-more"]')).includes(`あと${count - 100}件`), `${label}：「もっと見る（あと${count - 100}件）」`);
  ok((await text0(p, '#spend-list .card-sub')).includes(`${count}件`), `${label}：全部で ${count}件`);
  ok(await noOverflow(p), `${label}：横にはみ出さない`);
  const cats = await p.locator('#spend-category .hbar-row').count();
  ok(cats === 9, `${label}：カテゴリ別は9本（8カテゴリ＋カテゴリなし）`);
  // 件数の合計が合う
  const tableCount = (await p.locator('#spend-category tbody tr td:nth-child(3)').allTextContents()).reduce((a, s) => a + yenNum(s), 0);
  ok(tableCount === count, `${label}：カテゴリ別の件数の合計が ${count}件と合う`);
  await p.click('[data-action="b-spend-show-more"]');
  ok((await p.locator('#spend-list .brow').count()) === 200, `${label}：「もっと見る」で200件になる`);
  if (atLimit) {
    // 上限（20,000件）に達していたら、増やさずにトーストで知らせる
    await p.click('[data-action="b-spend-add"]');
    await p.waitForTimeout(300);
    ok(!(await p.evaluate(() => document.getElementById('sheet').open)), `${label}：上限なので、入力のシートは開かない`);
    ok((await p.locator('#toast').innerText()).includes('20,000件までです'), `${label}：トースト：${await p.locator('#toast').innerText()}`);
    await c.context.close();
    return;
  }
  // 1件追加する（保存〜描き直し）
  const t1 = performance.now();
  await p.click('[data-action="b-spend-add"]');
  await p.waitForFunction(() => document.getElementById('sheet').open);
  await p.fill('#sp-amount', '123');
  await p.click('#b-spend-form button[type="submit"]');
  await p.waitForFunction(() => !document.getElementById('sheet').open);
  const add = performance.now() - t1;
  ok(add < limitMs * 2, `${label}：1件記録して閉じるまで ${Math.round(add)}ms`);
  const saved = await p.evaluate((k) => JSON.parse(localStorage.getItem(k)).budget.spends.length, DATA_KEY);
  ok(saved === count + 1, `${label}：保存された（${saved}件）`);
  await shot(`${label}`, p, false);
  await c.context.close();
}
const text0 = (p, sel) => p.locator(sel).first().innerText();
await heavy(2000, '2000件', 1000);
await heavy(19999, '19999件（上限の手前）', 3000);
await heavy(20000, '20000件（上限）', 3000, { atLimit: true });

console.log('\n---- コンソールのエラー・警告 ----');
console.log(problems.length ? problems.join('\n') : '（なし）');
if (problems.length) throw new Error('NG: コンソールにエラー・警告が出ている');
await context.close();
await browser.close();
server.close();
console.log('\nALL DONE');
