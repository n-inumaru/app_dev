// 表示用の書式と、入力の読み取り

const nf = new Intl.NumberFormat('ja-JP');

/** HTMLに埋め込む文字を無害にする */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const num = (n) => nf.format(Math.round(n));
export const yen = (n) => `${num(n)}円`;

/** 年利の表示（18 → "18"、14.6 → "14.6"） */
export const rateText = (rate) => String(Number(Number(rate).toFixed(3)));

/** グラフの目盛り（0 / 50万 / 100万） */
export function axisYen(n) {
  if (n === 0) return '0';
  if (n >= 100000000) return `${trimNum(n / 100000000)}億`;
  if (n >= 10000) return `${trimNum(n / 10000)}万`;
  return num(n);
}
const trimNum = (x) => String(Math.round(x * 10) / 10);

/** 月数 → 「2年3か月」 */
export function duration(m) {
  if (m == null) return '—';
  if (m === 0) return '今すぐ';
  const y = Math.floor(m / 12);
  const r = m % 12;
  if (y === 0) return `${r}か月`;
  if (r === 0) return `${y}年`;
  return `${y}年${r}か月`;
}

/** グラフの横軸（経過した期間） */
export function elapsedShort(m) {
  if (m === 0) return '今';
  if (m < 12) return `${m}か月`;
  if (m % 12 === 0) return `${m / 12}年`;
  if (m % 6 === 0) return `${Math.floor(m / 12)}年半`;
  return `${Math.floor(m / 12)}年${m % 12}か月`;
}

/** 今月から m か月後の年月 → 「2027年3月」 */
export function monthLabel(m, base = new Date()) {
  const d = new Date(base.getFullYear(), base.getMonth() + m, 1);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

/** 全角の数字・記号を半角にする（音声入力・日本語入力の対策） */
export function toHalfWidth(s) {
  return String(s ?? '').replace(/[０-９．，－％]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * 金額の入力を読む。空なら null、読めなければ NaN。
 * 「12,000」「１２０００」「12000円」「5万」「1.5万」「12万3000」に対応
 */
export function parseYen(input) {
  const t = toHalfWidth(input).replace(/[,、\s円]/g, '');
  if (t === '') return null;
  const man = t.match(/^(\d+(?:\.\d+)?)万(\d{0,4})$/);
  if (man) {
    const v = Math.round(Number(man[1]) * 10000) + (man[2] ? Number(man[2]) : 0);
    return Number.isSafeInteger(v) ? v : NaN;
  }
  if (!/^\d+$/.test(t)) return NaN;
  const v = Number(t);
  return Number.isSafeInteger(v) ? v : NaN;
}

/** 年利の入力を読む。「15」「14.6」「15%」「１５．０」に対応。空なら null、読めなければ NaN */
export function parseRate(input) {
  const t = toHalfWidth(input).replace(/[%\s]/g, '').replace(/^年利/, '');
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  return Math.round(Number(t) * 1000) / 1000;
}

/** 入力欄に入れ直す金額の表示（空なら空） */
export function yenInputValue(input) {
  const v = parseYen(input);
  return v === null || Number.isNaN(v) ? String(input ?? '') : num(v);
}

const pad = (n) => String(n).padStart(2, '0');

/** 今日の日付（端末の時刻で YYYY-MM-DD） */
export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-11" → 「2026年11月」 */
export function yearMonthText(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${y}年${m}月`;
}

/** "2026-11-21" → 「21日」 */
export const dayText = (iso) => `${Number(iso.slice(8, 10))}日`;

/** ISO日時 → 「2026年11月21日」 */
export function dateText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** ファイル名用の日付（20261121） */
export const fileDate = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
