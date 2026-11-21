/**
 * 日本の祝日の計算（画面に依存しない純粋な関数）
 *
 * 内閣府の定義どおりに計算する。
 * - 固定日：元日、建国記念の日、天皇誕生日、昭和の日、憲法記念日、みどりの日、こどもの日、山の日、文化の日、勤労感謝の日
 * - ハッピーマンデー：成人の日（1月第2月曜）、海の日（7月第3月曜）、敬老の日（9月第3月曜）、スポーツの日（10月第2月曜）
 * - 春分の日・秋分の日：1980〜2099年に使える近似式
 * - 振替休日：祝日が日曜なら、その後で最初の「祝日でない日」
 * - 国民の休日：前日と翌日が祝日の平日（日曜を除く）
 *
 * 対象は 2022年以降（スポーツの日・山の日・天皇誕生日が今の形になって以降）。
 * それより前の年は、当時の法律と違う結果になることがある（2019〜2021年の特例も入れていない）。
 * 2022〜2027年は内閣府の祝日CSVと一致することをテストで確かめている（tests/holidays.test.mjs）。
 * 春分・秋分の日は、実際には前年2月の官報で決まる。2100年以降は近似式が使えない。
 */

import { addDays, daysInMonth, toDays, toISO, weekday } from './dates.js';

const cache = new Map();

/** 春分の日・秋分の日の「日」（1980〜2099年） */
export function springEquinoxDay(year) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}
export function autumnEquinoxDay(year) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** month 月の第 n 月曜日の「日」 */
function nthMonday(year, month, n) {
  const toFirstMonday = (8 - weekday(toISO(year, month, 1))) % 7; // 1日から最初の月曜までの日数
  return 1 + toFirstMonday + 7 * (n - 1);
}

/**
 * その年の祝日（振替休日・国民の休日を含む）。Map<'YYYY-MM-DD', 名前>
 * 戻り値は使い回すので、書き換えないこと。
 */
export function holidaysOf(year) {
  const hit = cache.get(year);
  if (hit) return hit;

  const base = new Map();
  const add = (m, d, name) => base.set(toISO(year, m, d), name);
  add(1, 1, '元日');
  add(1, nthMonday(year, 1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  add(2, 23, '天皇誕生日');
  add(3, springEquinoxDay(year), '春分の日');
  add(4, 29, '昭和の日');
  add(5, 3, '憲法記念日');
  add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');
  add(7, nthMonday(year, 7, 3), '海の日');
  add(8, 11, '山の日');
  add(9, nthMonday(year, 9, 3), '敬老の日');
  add(9, autumnEquinoxDay(year), '秋分の日');
  add(10, nthMonday(year, 10, 2), 'スポーツの日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');

  const all = new Map(base);

  // 振替休日：日曜の祝日は、その後で最初の祝日でない日
  for (const iso of base.keys()) {
    if (weekday(iso) !== 0) continue;
    let d = addDays(iso, 1);
    while (base.has(d)) d = addDays(d, 1);
    all.set(d, '振替休日');
  }

  // 国民の休日：前日と翌日が祝日で、自分は祝日でも日曜でもない日
  for (let m = 1; m <= 12; m += 1) {
    for (let d = 2; d < daysInMonth(year, m); d += 1) {
      const iso = toISO(year, m, d);
      if (all.has(iso) || weekday(iso) === 0) continue;
      if (base.has(addDays(iso, -1)) && base.has(addDays(iso, 1))) all.set(iso, '国民の休日');
    }
  }

  // 日付順にそろえる
  const sorted = new Map([...all].sort((a, b) => toDays(a[0]) - toDays(b[0])));
  cache.set(year, sorted);
  return sorted;
}

/** 祝日の名前。祝日でなければ null */
export function holidayName(iso) {
  return holidaysOf(Number(iso.slice(0, 4))).get(iso) ?? null;
}

export const isHoliday = (iso) => holidayName(iso) !== null;

/** 土日か祝日か */
export function isDayOff(iso) {
  const w = weekday(iso);
  return w === 0 || w === 6 || isHoliday(iso);
}
