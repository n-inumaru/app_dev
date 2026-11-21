// データの保存と読み込み（このスマホのブラウザの中だけ。外部には送らない）

import { isValidISO } from './dates.js';
import { EVERY_CHOICES, FIXED_CATEGORIES, SPEND_CATEGORIES, WEEKDAYS_DEFAULT } from './budget.js';

const DATA_KEY = 'kanzai-navi:data';
const LOCK_KEY = 'kanzai-navi:lock';
const PREFIX = 'kanzai-navi:';
// 1：借入だけ。2：家計（budget）を追加。1のファイルも読める
export const BACKUP_FORMAT = 2;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 家計の上限（壊れた・大きすぎるファイルで、アプリが重くならないように）
export const BUDGET_LIMITS = {
  items: 200, // 収入・固定費
  entries: 2000, // 変わる収入の記録
  spends: 20000, // 出費
  periods: 600, // 上書き・履歴の期間（50年分）
  yen: 1000000000, // 1つの金額（10億円）
  total: 10000000000000, // 履歴に残す合計の金額
  nameLen: 30,
  memoLen: 100,
};

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const intOrNull = (v, min = 0) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= min ? n : null;
};
const isoOr = (v, fallback) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fallback);

export function emptyData() {
  const now = new Date().toISOString();
  return {
    version: 1,
    debts: [],
    records: [],
    plan: { lumpSum: 0, monthlyExtra: 0 },
    budget: emptyBudget(),
    meta: { createdAt: now, updatedAt: now, lastBackupAt: null },
  };
}

/** 家計の初期値（設計書「5. データモデル」） */
export function emptyBudget() {
  return {
    settings: {
      payday: 25, // 0＝月末、1〜31
      shiftEarly: true, // 土日祝なら前の平日へ
      savings: { mode: 'amount', value: 0 }, // 'amount'（円）| 'percent'（収入の◯%）
      since: null, // 家計を最初に使い始めた日（YYYY-MM-DD）
    },
    incomes: [],
    fixed: [],
    entries: [],
    overrides: {},
    spends: [],
    snapshots: {},
  };
}

// ---- 家計の検証（budget） ----

/** 整数だけ通す（数字の文字列も可）。範囲外・小数・数字でないものは null */
function bInt(v, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}
const yenOf = (v) => bInt(v, 0, BUDGET_LIMITS.yen);
const text = (v, max) => (typeof v === 'string' ? Array.from(v.trim()).slice(0, max).join('') : '');
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const plainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const rowsOf = (v) => (Array.isArray(v) ? v : []);

/** id をそろえる。使えない・重なっている id は新しく振る（__proto__ は使わせない） */
function takeId(raw, seen) {
  const ok = typeof raw === 'string' && ID_RE.test(raw) && raw !== '__proto__' && !seen.has(raw);
  const id = ok ? raw : uid();
  seen.add(id);
  return id;
}

/** 期間のキー（YYYY-MM-DD）の新しい方から limit 件だけ残す */
function keepNewestKeys(obj, limit) {
  const keys = Object.keys(obj).sort();
  if (keys.length <= limit) return obj;
  const out = {};
  for (const k of keys.slice(-limit)) out[k] = obj[k];
  return out;
}

const FIXED_KEYS = new Set(FIXED_CATEGORIES.map((c) => c.key));
const SPEND_KEYS = new Set(SPEND_CATEGORIES.map((c) => c.key));

function sanitizeIncome(r, ids, now) {
  const o = plainObject(r);
  if (!o) return null;
  const name = text(o.name, BUDGET_LIMITS.nameLen);
  const amount = yenOf(o.amount);
  if (!name || amount === null) return null;
  const kind = o.kind === 'months' ? 'months' : 'monthly';
  const months = [...new Set(rowsOf(o.months).map((m) => bInt(m, 1, 12)).filter((m) => m !== null))].sort((a, b) => a - b);
  if (kind === 'months' && months.length === 0) return null; // 支給の月がなければ、使えない
  return {
    id: takeId(o.id, ids),
    name,
    kind,
    amount,
    months,
    day: bInt(o.day, 1, 31) ?? 1,
    enabled: bool(o.enabled, true),
    createdAt: isoOr(o.createdAt, now),
    updatedAt: isoOr(o.updatedAt, now),
  };
}

function sanitizeFixed(r, ids, now) {
  const o = plainObject(r);
  if (!o) return null;
  const name = text(o.name, BUDGET_LIMITS.nameLen);
  const amount = yenOf(o.amount);
  if (!name || amount === null) return null;
  const u = plainObject(o.uses) || {};
  const days = [...new Set(rowsOf(u.days).map((d) => bInt(d, 0, 6)).filter((d) => d !== null))].sort((a, b) => a - b);
  return {
    id: takeId(o.id, ids),
    name,
    category: FIXED_KEYS.has(o.category) ? o.category : 'other',
    kind: o.kind === 'periodic' || o.kind === 'uses' ? o.kind : 'monthly',
    amount,
    every: EVERY_CHOICES.includes(o.every) ? o.every : 12,
    dueMonth: bInt(o.dueMonth, 1, 12) ?? 1,
    dueDay: bInt(o.dueDay, 1, 31) ?? 1,
    mode: o.mode === 'spread' ? 'spread' : 'lump',
    uses: {
      by: u.by === 'count' ? 'count' : 'weekdays',
      days: Array.isArray(u.days) ? days : WEEKDAYS_DEFAULT.slice(),
      skipHolidays: bool(u.skipHolidays, true),
      count: bInt(u.count, 0, 366) ?? 0,
    },
    enabled: bool(o.enabled, true),
    createdAt: isoOr(o.createdAt, now),
    updatedAt: isoOr(o.updatedAt, now),
  };
}

/** 保存データやバックアップの家計を、正しい形にそろえる（壊れた行は捨てる） */
export function sanitizeBudget(raw, now = new Date().toISOString()) {
  const out = emptyBudget();
  const b = plainObject(raw);
  if (!b) return out;
  const L = BUDGET_LIMITS;

  const s = plainObject(b.settings);
  if (s) {
    out.settings.payday = bInt(s.payday, 0, 31) ?? out.settings.payday;
    out.settings.shiftEarly = bool(s.shiftEarly, out.settings.shiftEarly);
    const sv = plainObject(s.savings);
    if (sv) {
      const mode = sv.mode === 'percent' ? 'percent' : 'amount';
      out.settings.savings = { mode, value: (mode === 'percent' ? bInt(sv.value, 0, 100) : yenOf(sv.value)) ?? 0 };
    }
    out.settings.since = isValidISO(s.since) ? s.since : null;
  }

  const incomeIds = new Set();
  for (const r of rowsOf(b.incomes)) {
    if (out.incomes.length >= L.items) break;
    const it = sanitizeIncome(r, incomeIds, now);
    if (it) out.incomes.push(it);
  }
  const fixedIds = new Set();
  for (const r of rowsOf(b.fixed)) {
    if (out.fixed.length >= L.items) break;
    const it = sanitizeFixed(r, fixedIds, now);
    if (it) out.fixed.push(it);
  }

  // 記録は新しいものが大事なので、多すぎるときは後ろ（新しい方）を残す
  const entryIds = new Set();
  for (const r of rowsOf(b.entries)) {
    const o = plainObject(r);
    if (!o || !isValidISO(o.date)) continue;
    const amount = yenOf(o.amount);
    if (amount === null) continue;
    out.entries.push({ id: takeId(o.id, entryIds), date: o.date, amount, memo: text(o.memo, L.memoLen), createdAt: isoOr(o.createdAt, now) });
  }
  if (out.entries.length > L.entries) out.entries = out.entries.slice(-L.entries);

  const spendIds = new Set();
  for (const r of rowsOf(b.spends)) {
    const o = plainObject(r);
    if (!o || !isValidISO(o.date)) continue;
    const amount = yenOf(o.amount);
    if (amount === null) continue;
    out.spends.push({
      id: takeId(o.id, spendIds),
      date: o.date,
      amount,
      category: SPEND_KEYS.has(o.category) ? o.category : '',
      memo: text(o.memo, L.memoLen),
      createdAt: isoOr(o.createdAt, now),
    });
  }
  if (out.spends.length > L.spends) out.spends = out.spends.slice(-L.spends);

  // 期間ごとの上書き（項目が見つからないものは捨てる）
  const ovs = plainObject(b.overrides) || {};
  const usesIds = new Set(out.fixed.filter((f) => f.kind === 'uses').map((f) => f.id));
  const pick = (src, valid, max) => {
    const res = {};
    for (const [id, v] of Object.entries(plainObject(src) || {})) {
      const n = valid.has(id) ? bInt(v, 0, max) : null;
      if (n !== null) res[id] = n;
    }
    return res;
  };
  for (const [key, ov] of Object.entries(ovs)) {
    const o = plainObject(ov);
    if (!isValidISO(key) || !o) continue;
    const entry = {
      income: pick(o.income, incomeIds, L.yen),
      fixed: pick(o.fixed, fixedIds, L.yen),
      uses: pick(o.uses, usesIds, 366),
    };
    if (Object.keys(entry.income).length + Object.keys(entry.fixed).length + Object.keys(entry.uses).length > 0) out.overrides[key] = entry;
  }
  out.overrides = keepNewestKeys(out.overrides, L.periods);

  // 履歴（確定した期間）
  for (const [key, sn] of Object.entries(plainObject(b.snapshots) || {})) {
    const o = plainObject(sn);
    if (!isValidISO(key) || !o || !isValidISO(o.end) || o.end < key) continue;
    const plus = (v) => bInt(v, 0, L.total);
    const any = (v) => bInt(v, -L.total, L.total);
    const snap = { start: key, end: o.end, income: plus(o.income), fixed: plus(o.fixed), savings: plus(o.savings), extra: plus(o.extra), free: any(o.free), spent: plus(o.spent), leftover: any(o.leftover) };
    if (Object.values(snap).includes(null)) continue;
    out.snapshots[key] = { ...snap, closedAt: isoOr(o.closedAt, now) };
  }
  out.snapshots = keepNewestKeys(out.snapshots, L.periods);
  return out;
}

/** 保存データやバックアップを、正しい形にそろえる（壊れた行は捨てる） */
export function sanitizeData(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('データの形式が正しくありません');
  const out = emptyData();
  const now = out.meta.createdAt;
  const ids = new Set();

  for (const d of Array.isArray(raw.debts) ? raw.debts : []) {
    if (!d || typeof d !== 'object') continue;
    const name = typeof d.name === 'string' ? d.name.trim().slice(0, 30) : '';
    const balance = intOrNull(d.balance);
    const payment = intOrNull(d.payment, 1);
    const rate = Number(d.rate);
    if (!name || balance === null || payment === null || !(rate >= 0 && rate <= 100)) continue;
    const id = typeof d.id === 'string' && ID_RE.test(d.id) && !ids.has(d.id) ? d.id : uid();
    ids.add(id);
    out.debts.push({
      id,
      name,
      balance,
      rate: Math.round(rate * 1000) / 1000,
      payment,
      startBalance: Math.max(intOrNull(d.startBalance) ?? balance, balance),
      createdAt: isoOr(d.createdAt, now),
      updatedAt: isoOr(d.updatedAt, now),
    });
  }

  const recIds = new Set();
  for (const r of Array.isArray(raw.records) ? raw.records : []) {
    if (!r || typeof r !== 'object' || !ids.has(r.debtId)) continue;
    const amount = intOrNull(r.amount);
    const interest = intOrNull(r.interest);
    const balanceAfter = intOrNull(r.balanceAfter);
    if (amount === null || interest === null || interest > amount || balanceAfter === null) continue;
    if (typeof r.date !== 'string' || !DATE_RE.test(r.date)) continue;
    const id = typeof r.id === 'string' && ID_RE.test(r.id) && !recIds.has(r.id) ? r.id : uid();
    recIds.add(id);
    out.records.push({
      id,
      debtId: r.debtId,
      date: r.date,
      type: r.type === 'extra' ? 'extra' : 'regular',
      amount,
      interest,
      principal: amount - interest,
      balanceAfter,
      createdAt: isoOr(r.createdAt, now),
    });
  }

  if (raw.plan && typeof raw.plan === 'object') {
    out.plan.lumpSum = intOrNull(raw.plan.lumpSum) ?? 0;
    out.plan.monthlyExtra = intOrNull(raw.plan.monthlyExtra) ?? 0;
  }
  out.budget = sanitizeBudget(raw.budget, now); // 古い保存データ・format 1 のバックアップには無い → 初期値
  if (raw.meta && typeof raw.meta === 'object') {
    out.meta.createdAt = isoOr(raw.meta.createdAt, now);
    out.meta.updatedAt = isoOr(raw.meta.updatedAt, now);
    out.meta.lastBackupAt = isoOr(raw.meta.lastBackupAt, null);
  }
  return out;
}

export function loadData() {
  const text = localStorage.getItem(DATA_KEY);
  if (!text) return emptyData();
  try {
    return sanitizeData(JSON.parse(text));
  } catch {
    // 壊れていたら、念のため別の名前で残してから空で始める
    localStorage.setItem(`${DATA_KEY}:broken:${Date.now()}`, text);
    return emptyData();
  }
}

export function saveData(data) {
  localStorage.setItem(DATA_KEY, JSON.stringify(data));
}

let persistAsked = false;
/** ブラウザが容量不足のときに勝手に消さないよう頼む */
export async function requestPersist() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  try {
    if (!(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* 対応していなければ何もしない */
  }
}

// ---- バックアップ ----

export function makeBackup(data) {
  const payload = {
    app: 'kanzai-navi',
    format: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    data: { debts: data.debts, records: data.records, plan: data.plan, budget: data.budget },
  };
  return JSON.stringify(payload, null, 2);
}

export function readBackup(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('ファイルを読み取れませんでした。書き出したバックアップのファイルを選んでください。');
  }
  if (!obj || obj.app !== 'kanzai-navi' || !obj.data) {
    throw new Error('完済ナビのバックアップファイルではありません。');
  }
  if (Number(obj.format) > BACKUP_FORMAT) {
    throw new Error('新しいバージョンで作られたファイルです。アプリを更新してから読み込んでください。');
  }
  return { data: sanitizeData(obj.data), exportedAt: isoOr(obj.exportedAt, null) };
}

// ---- ロックの設定（バックアップには含めない） ----

export function loadLock() {
  try {
    const v = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export function saveLock(value) {
  localStorage.setItem(LOCK_KEY, JSON.stringify(value));
}

export function clearLock() {
  localStorage.removeItem(LOCK_KEY);
}

// ---- 小さな設定 ----

export const getFlag = (name) => localStorage.getItem(PREFIX + name) === '1';
export const setFlag = (name) => localStorage.setItem(PREFIX + name, '1');

/** このアプリが保存したものを、すべて消す */
export function removeAllStorage() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  }
}
