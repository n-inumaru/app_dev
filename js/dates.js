// 日付の道具（画面にも端末のタイムゾーンにも依存しない）
//
// 日付は 'YYYY-MM-DD' の文字列で扱う。new Date('YYYY-MM-DD') は UTC として解釈されて
// 日本では前日にずれることがあるので使わない。ここでは整数の計算だけで、暦を扱う。
// 「今日」だけは端末の日付が必要なので、format.js の todayISO() を使う。

export const MIN_YEAR = 1900;
export const MAX_YEAR = 2200;

const pad = (n, w = 2) => String(n).padStart(w, '0');
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function daysInMonth(y, m) {
  return m === 2 && isLeapYear(y) ? 29 : MONTH_DAYS[m - 1];
}

/**
 * 'YYYY-MM-DD' → { y, m, d }。暦に実在する日付（4けたの年）でなければ null（2026-02-30 や 2026-13-01 は null）。
 * 年の範囲は見ない。計算が MIN_YEAR・MAX_YEAR の端で、前後の月に触れても止まらないようにするため
 */
export function parseISO(s) {
  if (typeof s !== 'string') return null;
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo) ? { y, m: mo, d } : null;
}

/** 保存してよい日付か：実在する 'YYYY-MM-DD' で、年が MIN_YEAR〜MAX_YEAR（入力・バックアップの検証用） */
export function isValidISO(s) {
  const p = parseISO(s);
  return p !== null && p.y >= MIN_YEAR && p.y <= MAX_YEAR;
}

export const toISO = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

// 1970-01-01 からの日数（Howard Hinnant の civil 日付アルゴリズム）
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(n) {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return { y, m, d };
}

/** 'YYYY-MM-DD' → 1970-01-01 からの日数 */
export function toDays(iso) {
  const p = parseISO(iso);
  if (!p) throw new RangeError(`日付が正しくありません: ${iso}`);
  return daysFromCivil(p.y, p.m, p.d);
}

export function fromDays(n) {
  const { y, m, d } = civilFromDays(n);
  return toISO(y, m, d);
}

export const addDays = (iso, n) => fromDays(toDays(iso) + n);

/** b − a（日数）。a と b は 'YYYY-MM-DD' */
export const diffDays = (a, b) => toDays(b) - toDays(a);

/** 曜日（0＝日 … 6＝土） */
export const weekday = (iso) => (((toDays(iso) + 4) % 7) + 7) % 7;

/** 年月に n か月を足す（m は 1〜12）→ { y, m } */
export function addMonths(y, m, n) {
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (((idx % 12) + 12) % 12) + 1 };
}
