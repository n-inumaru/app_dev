// 祝日の計算のテスト。実行：npm test
//
// 内閣府の祝日CSV（https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv、Shift_JIS）と照合する。
// CSV は一時フォルダー（OS の tmp の中の kanzai-navi-test-holidays）に取得し、リポジトリには入れない。
// 30日以内に取得したものがあれば、それを使う（電波がなくてもテストできる）。取得も古い写しもなければ、照合だけ飛ばす。
//
// 内閣府のCSVは翌年分までしかない（2026年11月時点で2027年まで）。それより先は、
// 「1日ずつ判定する別の書き方」と「天文計算（Meeus）の春分・秋分」で突き合わせる。
// この別の書き方は、CSV がある年（2022〜）で先に正しさを確かめてから使う。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autumnEquinoxDay, holidayName, holidaysOf, isDayOff, isHoliday, springEquinoxDay } from '../js/holidays.js';
import { fromDays } from '../js/dates.js';

const CSV_URL = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
const CSV_DIR = join(tmpdir(), 'kanzai-navi-test-holidays');
const CSV_FILE = join(CSV_DIR, 'syukujitsu.csv');
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const FIRST_RULE_YEAR = 2022; // スポーツの日・山の日・天皇誕生日（2月23日）が今の形になって以降

/** CSV の中身を 'YYYY-MM-DD' → 名前 の Map にする。形がおかしければ null */
function parseCsv(bytes) {
  const text = new TextDecoder('shift_jis').decode(bytes);
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2}),(.+)$/.exec(line);
    if (m) map.set(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, m[4].trim());
  }
  // 1955年から毎年あるので、少なくとも900行はあるはず（エラーページなどを取り込まない）
  return map.size >= 900 && map.get('1955-01-01') === '元日' ? map : null;
}

async function loadCsv() {
  let cached = null;
  try {
    const age = Date.now() - statSync(CSV_FILE).mtimeMs;
    cached = parseCsv(readFileSync(CSV_FILE));
    if (cached && age < MAX_AGE_MS) return cached;
  } catch {
    /* 写しがなければ取得する */
  }
  try {
    const res = await fetch(CSV_URL, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const map = parseCsv(bytes);
    if (!map) throw new Error('CSV の形が想定と違います');
    mkdirSync(CSV_DIR, { recursive: true });
    writeFileSync(`${CSV_FILE}.part`, bytes);
    renameSync(`${CSV_FILE}.part`, CSV_FILE);
    return map;
  } catch (e) {
    console.warn(`祝日CSVを取得できませんでした（${e.message}）。${cached ? '古い写しで照合します' : '照合を飛ばします'}`);
    return cached;
  }
}

const csv = await loadCsv();
const csvLastYear = csv ? Math.max(...[...csv.keys()].map((k) => Number(k.slice(0, 4)))) : 0;
const csvOfYear = (y) => new Map([...csv].filter(([k]) => k.startsWith(`${y}-`)));
// CSV では、振替休日も国民の休日も「休日」と書かれている
const csvName = (n) => (n === '振替休日' || n === '国民の休日' ? '休日' : n);

// ---- 内閣府のCSVとの照合 ----

test('内閣府の祝日CSVと、2022年〜CSVの最終年が日付・名前とも完全に一致する', { skip: csv ? false : 'CSV がないので飛ばす' }, () => {
  assert.ok(csvLastYear >= 2026, `CSV が2026年まで入っていません（最終年 ${csvLastYear}）`);
  for (let y = FIRST_RULE_YEAR; y <= csvLastYear; y += 1) {
    const mine = new Map([...holidaysOf(y)].map(([k, v]) => [k, csvName(v)]));
    assert.deepEqual([...mine], [...csvOfYear(y)], `${y}年`);
  }
});

test('2026〜2035年のうち、内閣府のCSVにある年（〜最終年）の祝日の数と日付が合う', { skip: csv ? false : 'CSV がないので飛ばす' }, () => {
  const years = [];
  for (let y = 2026; y <= Math.min(2035, csvLastYear); y += 1) {
    years.push(y);
    assert.deepEqual([...holidaysOf(y).keys()], [...csvOfYear(y).keys()], `${y}年`);
  }
  assert.ok(years.includes(2026) && years.includes(2027));
  console.log(`  ℹ CSV と照合した年：${years[0]}〜${years.at(-1)}年（${csvLastYear < 2035 ? `${csvLastYear + 1}〜2035年は内閣府がまだ公表していないので、下の別の書き方との照合で確かめる` : '2035年まで'}）`);
});

// ---- 手で確かめた年 ----

test('2026年の祝日（18日）。振替休日・国民の休日を含む', () => {
  const expected = [
    ['2026-01-01', '元日'],
    ['2026-01-12', '成人の日'],
    ['2026-02-11', '建国記念の日'],
    ['2026-02-23', '天皇誕生日'],
    ['2026-03-20', '春分の日'],
    ['2026-04-29', '昭和の日'],
    ['2026-05-03', '憲法記念日'],
    ['2026-05-04', 'みどりの日'],
    ['2026-05-05', 'こどもの日'],
    ['2026-05-06', '振替休日'], // 憲法記念日が日曜 → 4日・5日は祝日なので、6日
    ['2026-07-20', '海の日'],
    ['2026-08-11', '山の日'],
    ['2026-09-21', '敬老の日'],
    ['2026-09-22', '国民の休日'], // 敬老の日と秋分の日にはさまれた平日
    ['2026-09-23', '秋分の日'],
    ['2026-10-12', 'スポーツの日'],
    ['2026-11-03', '文化の日'],
    ['2026-11-23', '勤労感謝の日'],
  ];
  assert.deepEqual([...holidaysOf(2026)], expected);
});

test('2027年の祝日（17日）。春分の日が日曜なので振替休日', () => {
  assert.equal(holidayName('2027-03-21'), '春分の日');
  assert.equal(weekdayOf('2027-03-21'), 0);
  assert.equal(holidayName('2027-03-22'), '振替休日');
  assert.equal(holidaysOf(2027).size, 17);
});

test('日曜の祝日は翌日が振替休日になり、土曜の祝日には振替がない', () => {
  assert.equal(weekdayOf('2029-04-29'), 0);
  assert.equal(holidayName('2029-04-30'), '振替休日');
  assert.equal(weekdayOf('2028-01-01'), 6); // 土曜は振替なし
  assert.equal(isHoliday('2028-01-03'), false);
});

test('祝日の判定', () => {
  assert.equal(isHoliday('2026-11-23'), true);
  assert.equal(holidayName('2026-11-23'), '勤労感謝の日');
  assert.equal(holidayName('2026-11-24'), null);
  assert.equal(isDayOff('2026-11-21'), true); // 土曜
  assert.equal(isDayOff('2026-11-22'), true); // 日曜
  assert.equal(isDayOff('2026-11-23'), true); // 祝日
  assert.equal(isDayOff('2026-11-24'), false); // 平日
});

test('春分・秋分の近似式（2026〜2027年は内閣府の発表どおり）', () => {
  assert.deepEqual([springEquinoxDay(2026), autumnEquinoxDay(2026)], [20, 23]);
  assert.deepEqual([springEquinoxDay(2027), autumnEquinoxDay(2027)], [21, 23]);
});

// ---- 別の書き方との照合（CSV にない年のため） ----

function weekdayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 春分・秋分の日（JST）を天文計算で求める（Meeus "Astronomical Algorithms" 27章） */
function astronomicalEquinox(year, kind) {
  const Y = (year - 2000) / 1000;
  const jde0 =
    kind === 'spring'
      ? 2451623.80984 + 365242.37404 * Y + 0.05169 * Y ** 2 - 0.00411 * Y ** 3 - 0.00057 * Y ** 4
      : 2451810.21715 + 365242.01767 * Y - 0.11575 * Y ** 2 + 0.00337 * Y ** 3 + 0.00078 * Y ** 4;
  const T = (jde0 - 2451545.0) / 36525;
  const W = ((35999.373 * T - 2.47) * Math.PI) / 180;
  const dl = 1 + 0.0334 * Math.cos(W) + 0.0007 * Math.cos(2 * W);
  const A = [485, 203, 199, 182, 156, 136, 77, 74, 70, 58, 52, 50, 45, 44, 29, 18, 17, 16, 14, 12, 12, 12, 9, 8];
  const B = [324.96, 337.23, 342.08, 27.85, 73.14, 171.52, 222.54, 296.72, 243.58, 119.81, 297.17, 21.02, 247.54, 325.15, 60.93, 155.12, 288.79, 198.04, 199.76, 95.39, 287.11, 320.81, 227.73, 15.45];
  const C = [1934.136, 32964.467, 20.186, 445267.112, 45036.886, 22518.443, 65928.934, 3034.906, 9037.513, 33718.147, 150.678, 2281.226, 29929.562, 31555.956, 4443.417, 67555.328, 4562.452, 62894.029, 31436.921, 14577.848, 31931.756, 34777.259, 1222.114, 16859.074];
  let S = 0;
  for (let i = 0; i < 24; i += 1) S += A[i] * Math.cos(((B[i] + C[i] * T) * Math.PI) / 180);
  const jde = jde0 + (0.00001 * S) / dl; // 力学時（TT）
  const jst = jde - 70 / 86400 + 9 / 24; // ΔT≈70秒を引いて世界時（UT）にし、9時間足して日本時間にする
  const dayNumber = jst - 2440587.5; // 1970-01-01 0時（日本時間）からの日数
  const date = fromDays(Math.floor(dayNumber));
  const minutesFromMidnight = (dayNumber - Math.floor(dayNumber)) * 1440;
  return { date, day: Number(date.slice(8)), month: Number(date.slice(5, 7)), minutesFromMidnight };
}

/** 祝日を、1日ずつ「この日は祝日か」と判定して求める。holidays.js とは別の書き方 */
function oracleHolidays(year) {
  const spring = astronomicalEquinox(year, 'spring');
  const autumn = astronomicalEquinox(year, 'autumn');
  const fixedDays = { '1-1': '元日', '2-11': '建国記念の日', '2-23': '天皇誕生日', '4-29': '昭和の日', '5-3': '憲法記念日', '5-4': 'みどりの日', '5-5': 'こどもの日', '8-11': '山の日', '11-3': '文化の日', '11-23': '勤労感謝の日' };
  const days = [];
  for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 86400000) days.push(new Date(t));
  const key = (d) => `${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
  const iso = (d) => d.toISOString().slice(0, 10);

  // 本来の祝日（日曜でも、そのまま祝日）
  const base = (d) => {
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const w = d.getUTCDay();
    if (fixedDays[key(d)]) return fixedDays[key(d)];
    if (m === 1 && w === 1 && day >= 8 && day <= 14) return '成人の日';
    if (m === 7 && w === 1 && day >= 15 && day <= 21) return '海の日';
    if (m === 9 && w === 1 && day >= 15 && day <= 21) return '敬老の日';
    if (m === 10 && w === 1 && day >= 8 && day <= 14) return 'スポーツの日';
    if (spring.month === m && spring.day === day) return '春分の日';
    if (autumn.month === m && autumn.day === day) return '秋分の日';
    return null;
  };
  const baseOn = (t) => base(new Date(t));
  const out = new Map();
  for (const d of days) {
    const t = d.getTime();
    const name = base(d);
    if (name) {
      out.set(iso(d), name);
    } else if (d.getUTCDay() !== 0) {
      // 振替休日：直前の日曜（とその間の日）がすべて祝日なら、この日が振替
      let k = 1;
      while (baseOn(t - k * 86400000) && new Date(t - k * 86400000).getUTCDay() !== 0) k += 1;
      if (baseOn(t - k * 86400000) && new Date(t - k * 86400000).getUTCDay() === 0) out.set(iso(d), '振替休日');
      // 国民の休日：前日も翌日も祝日
      else if (baseOn(t - 86400000) && baseOn(t + 86400000)) out.set(iso(d), '国民の休日');
    }
  }
  return out;
}

test('別の書き方（1日ずつ判定＋天文計算）が、CSV のある2022年〜と一致する（この書き方自体の確認）', { skip: csv ? false : 'CSV がないので飛ばす' }, () => {
  for (let y = FIRST_RULE_YEAR; y <= csvLastYear; y += 1) {
    const mine = new Map([...oracleHolidays(y)].map(([k, v]) => [k, csvName(v)]));
    assert.deepEqual([...mine], [...csvOfYear(y)], `${y}年`);
  }
});

test('2026〜2035年の祝日が、別の書き方（1日ずつ判定＋天文計算の春分・秋分）と一致する', () => {
  for (let y = 2026; y <= 2035; y += 1) {
    assert.deepEqual([...holidaysOf(y)], [...oracleHolidays(y)], `${y}年`);
  }
});

test('春分・秋分の近似式が、天文計算と2026〜2035年で一致し、日付変更ぎりぎりの年は知らせる', () => {
  for (let y = 2026; y <= 2035; y += 1) {
    for (const [kind, approx] of [['spring', springEquinoxDay(y)], ['autumn', autumnEquinoxDay(y)]]) {
      const a = astronomicalEquinox(y, kind);
      assert.equal(a.day, approx, `${y}年 ${kind}（天文計算 ${a.date}）`);
      // 天文計算の誤差は数分。0時・24時の前後10分以内なら、日付が決めきれない年として気づけるようにする
      const margin = Math.min(a.minutesFromMidnight, 1440 - a.minutesFromMidnight);
      if (margin < 10) console.log(`  ℹ ${y}年 ${kind} は日付変更ぎりぎり（日本時間 ${a.date} の ${Math.floor(a.minutesFromMidnight / 60)}時${Math.round(a.minutesFromMidnight % 60)}分ごろ）。官報で確認が必要`);
    }
  }
});

test('祝日の結果は使い回される（同じ年は同じ Map）', () => {
  assert.equal(holidaysOf(2026), holidaysOf(2026));
});
