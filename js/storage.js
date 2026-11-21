// データの保存と読み込み（このスマホのブラウザの中だけ。外部には送らない）

const DATA_KEY = 'kanzai-navi:data';
const LOCK_KEY = 'kanzai-navi:lock';
const PREFIX = 'kanzai-navi:';
export const BACKUP_FORMAT = 1;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
    meta: { createdAt: now, updatedAt: now, lastBackupAt: null },
  };
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
    data: { debts: data.debts, records: data.records, plan: data.plan },
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
