/**
 * 家計の計算（画面とは独立した純粋な関数）。設計書 docs/budget-design.md の「4. 計算のきまり」のとおり。
 *
 * 入力は、アプリのデータ全体 data（data.budget・data.debts・data.plan）と、期間 period。
 * 日付は 'YYYY-MM-DD'（端末の日付）。「今日」は引数で受け取る（この中では new Date() を使わない）。
 * 金額は円。円未満は切り捨て。data は書き換えない。
 *
 * 用語：
 * - 期間（period）＝ 給料日 〜 次の給料日の前日。{ start, end, key, days }。key は start
 * - 自由に使える額（free）＝ 収入 − 固定費 − 貯金の取り分 − 返済への上乗せ（マイナスになりうる）
 * - 余り（leftover）＝ 自由に使える額 − 使った額
 */

import { addDays, addMonths, daysInMonth, diffDays, parseISO, toISO, weekday } from './dates.js';
import { isDayOff, isHoliday } from './holidays.js';
import { buildPlan } from './calc.js';

export const FIXED_CATEGORIES = [
  { key: 'housing', label: '住居' },
  { key: 'utilities', label: '水道光熱' },
  { key: 'telecom', label: '通信' },
  { key: 'insurance', label: '保険' },
  { key: 'subscription', label: 'サブスク' },
  { key: 'food', label: '食費' },
  { key: 'transport', label: '交通' },
  { key: 'other', label: 'その他' },
];

/** 出費のカテゴリ（カテゴリなしは ''） */
export const SPEND_CATEGORIES = [
  { key: 'food', label: '食費' },
  { key: 'daily', label: '日用品' },
  { key: 'transport', label: '交通' },
  { key: 'social', label: '交際' },
  { key: 'fun', label: '娯楽' },
  { key: 'beauty', label: '衣服・美容' },
  { key: 'medical', label: '医療' },
  { key: 'other', label: 'その他' },
];

/** ◯か月ごとの固定費で選べる間隔（12の約数だけ。年をまたいでもずれない） */
export const EVERY_CHOICES = [2, 3, 4, 6, 12];

/** 昼食などの「単価×回数」で選べる曜日の初期値（月〜金） */
export const WEEKDAYS_DEFAULT = [1, 2, 3, 4, 5];

/** 履歴を一度に作る期間数の上限（since が大昔でも、新しい方から数えて600期間＝50年分まで） */
const MAX_SNAPSHOT_PERIODS = 600;

const toInt = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : 0;
};
const toYen = (v) => Math.max(0, toInt(v));
const inRange = (iso, period) => iso >= period.start && iso <= period.end;
const byStart = (a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0); // 期間（{start}）を開始日の古い順に

// ---- 4.1 期間（給料日サイクル） ----

/** y年m月の給料日。土日祝にあたるときは前の平日まで戻す（settings.shiftEarly。給料日＝1 は戻さない） */
export function paydayOf(settings, y, m) {
  const p = toInt(settings.payday);
  const dim = daysInMonth(y, m);
  let iso = toISO(y, m, p <= 0 ? dim : Math.min(p, dim));
  if (settings.shiftEarly && p !== 1) {
    while (isDayOff(iso)) iso = addDays(iso, -1);
  }
  return iso;
}

/** 日付 iso を含む期間 */
export function periodOf(settings, iso) {
  const { y, m } = parseISO(iso);
  // 前月・当月・翌月（と、その次）の給料日。前倒しで月をまたぐことがあっても、この4つで足りる
  const paydays = [-1, 0, 1, 2].map((k) => {
    const t = addMonths(y, m, k);
    return paydayOf(settings, t.y, t.m);
  });
  let i = 0;
  while (i < 2 && paydays[i + 1] <= iso) i += 1; // iso 以前で最新の給料日
  const start = paydays[i];
  const next = paydays[i + 1];
  return { start, end: addDays(next, -1), key: start, days: diffDays(start, next) };
}

/** n 期あと（負なら前）の期間 */
export function shiftPeriod(settings, period, n) {
  let p = period;
  for (let i = 0; i < Math.abs(n); i += 1) {
    p = periodOf(settings, n > 0 ? addDays(p.end, 1) : addDays(p.start, -1));
  }
  return p;
}

/** period に重なる暦の月（{y, m}）の一覧 */
function monthsOf(period) {
  const a = parseISO(period.start);
  const b = parseISO(period.end);
  const out = [];
  for (let t = { y: a.y, m: a.m }; t.y * 12 + t.m <= b.y * 12 + b.m; t = addMonths(t.y, t.m, 1)) out.push(t);
  return out;
}

/** 毎年 months の月の day 日（月末を超えたら月末）のうち、period に入る日付 */
function datesInPeriod(period, months, day) {
  const out = [];
  for (const { y, m } of monthsOf(period)) {
    if (!months.includes(m)) continue;
    const iso = toISO(y, m, Math.min(Math.max(1, toInt(day)), daysInMonth(y, m)));
    if (inRange(iso, period)) out.push(iso);
  }
  return out;
}

// ---- 4.2 期間ごとの金額 ----

/** 期間内の、曜日が days に含まれる日の数。skipHolidays が true なら祝日を除く */
export function countWeekdays(period, days, skipHolidays) {
  const set = new Set(days);
  let n = 0;
  for (let d = period.start; d <= period.end; d = addDays(d, 1)) {
    if (set.has(weekday(d)) && !(skipHolidays && isHoliday(d))) n += 1;
  }
  return n;
}

/** 「単価×回数」の回数（上書きは含まない） */
export function usesCount(item, period) {
  const u = item.uses || {};
  if (u.by === 'count') return Math.max(0, toInt(u.count));
  return countWeekdays(period, Array.isArray(u.days) ? u.days : WEEKDAYS_DEFAULT, u.skipHolidays !== false);
}

const monthsOfItem = (item) => (Array.isArray(item.months) ? item.months : []);

/** ◯か月ごとの固定費を払う月の一覧（dueMonth から every か月ごと。every は12の約数）。画面の表示用にも使う */
export function dueMonths(item) {
  const every = EVERY_CHOICES.includes(item.every) ? item.every : 12;
  const first = Math.min(Math.max(1, toInt(item.dueMonth) || 1), 12);
  const out = [];
  for (let m = 1; m <= 12; m += 1) {
    if (((m - first) % every + every) % every === 0) out.push(m);
  }
  return out;
}

/** 返済中の会社（残高がある会社） */
export const activeDebts = (data) => (data.debts || []).filter((d) => toInt(d.balance) > 0);

/** 借入の返済（毎月の返済額の合計） */
export const debtPayment = (data) => activeDebts(data).reduce((s, d) => s + toYen(d.payment), 0);

/** 返済への上乗せ（返済中の会社があるときだけ。提案画面の「毎月の余剰金」と同じ値） */
export const extraOf = (data) => (activeDebts(data).length > 0 ? toYen(data.plan?.monthlyExtra) : 0);

/** 貯金の取り分 */
export function savingsOf(settings, income) {
  const s = settings.savings || {};
  const v = toYen(s.value);
  return s.mode === 'percent' ? Math.floor((income * Math.min(v, 100)) / 100) : v;
}

/**
 * この期間に入る収入の行。{ id, name, kind('monthly'|'months'|'entry'), amount, baseAmount, overridden }
 * 無効（enabled が false）の項目と、支給日が期間外の「決まった月」の収入は入らない。
 */
export function incomeLines(budget, period) {
  const ov = budget.overrides?.[period.key]?.income || {};
  const lines = [];
  for (const it of budget.incomes) {
    if (it.enabled === false) continue;
    let base;
    let dates = [];
    if (it.kind === 'months') {
      dates = datesInPeriod(period, monthsOfItem(it), it.day);
      if (dates.length === 0) continue;
      base = toYen(it.amount) * dates.length;
    } else {
      base = toYen(it.amount);
    }
    const overridden = Object.hasOwn(ov, it.id);
    lines.push({
      id: it.id,
      name: it.name,
      kind: it.kind === 'months' ? 'months' : 'monthly',
      amount: overridden ? toYen(ov[it.id]) : base,
      baseAmount: base,
      overridden,
      ...(dates.length ? { dates } : {}),
    });
  }
  for (const e of budget.entries) {
    if (!inRange(e.date, period)) continue;
    lines.push({ id: e.id, name: e.memo || '変わる収入', kind: 'entry', amount: toYen(e.amount), baseAmount: toYen(e.amount), overridden: false, date: e.date });
  }
  return lines;
}

/**
 * この期間に払う固定費の行。{ id, name, category, kind('monthly'|'periodic'|'uses'|'debt'), amount, baseAmount, overridden, ... }
 * - periodic の「まとめて」は、払う日が期間内の期だけ。「月割り」は毎期 floor(amount ÷ every)
 * - uses は amount × 回数（count＝回数、baseCount＝上書き前の回数）
 * - 借入の返済は、返済中の会社があるとき自動で1行入る（kind: 'debt'、auto: true、編集不可）
 */
export function fixedLines(data, period) {
  const budget = data.budget;
  const ov = budget.overrides?.[period.key] || {};
  const lines = [];
  for (const it of budget.fixed) {
    if (it.enabled === false) continue;
    const amount = toYen(it.amount);
    const line = { id: it.id, name: it.name, category: it.category };
    if (it.kind === 'uses') {
      const baseCount = usesCount(it, period);
      const overridden = Object.hasOwn(ov.uses || {}, it.id);
      const count = overridden ? Math.max(0, toInt(ov.uses[it.id])) : baseCount;
      lines.push({ ...line, kind: 'uses', unit: amount, count, baseCount, amount: amount * count, baseAmount: amount * baseCount, overridden });
      continue;
    }
    let base;
    let kind = 'monthly';
    const extra = {};
    if (it.kind === 'periodic') {
      kind = 'periodic';
      const every = EVERY_CHOICES.includes(it.every) ? it.every : 12;
      if (it.mode === 'spread') {
        base = Math.floor(amount / every);
        extra.mode = 'spread';
      } else {
        const dates = datesInPeriod(period, dueMonths(it), it.dueDay);
        if (dates.length === 0) continue;
        base = amount * dates.length;
        extra.mode = 'lump';
        extra.dates = dates;
      }
    } else {
      base = amount;
    }
    const overridden = Object.hasOwn(ov.fixed || {}, it.id);
    lines.push({ ...line, kind, ...extra, amount: overridden ? toYen(ov.fixed[it.id]) : base, baseAmount: base, overridden });
  }
  const debts = activeDebts(data);
  if (debts.length > 0) {
    const sum = debtPayment(data);
    lines.push({ id: 'auto-debt', name: '借入の返済', category: 'debt', kind: 'debt', auto: true, companies: debts.length, amount: sum, baseAmount: sum, overridden: false });
  }
  return lines;
}

const sumBy = (lines) => lines.reduce((s, l) => s + l.amount, 0);

/** 期間内の出費 */
export const spendsIn = (budget, period) => budget.spends.filter((s) => inRange(s.date, period));

export const NO_CATEGORY_LABEL = 'カテゴリなし';

/** 出費のカテゴリの表示名（カテゴリなし・知らないキーは「カテゴリなし」） */
export const spendCategoryLabel = (key) => SPEND_CATEGORIES.find((c) => c.key === key)?.label ?? NO_CATEGORY_LABEL;

/**
 * 期間内の出費を、日ごとにまとめる（新しい日が先。同じ日は、あとから記録したものが先）。
 * limit 件までだけ items に入れる（多いときの「もっと見る」用）。日の合計 total・件数 count は、打ち切られた分も含めた1日の全部。
 * @returns {{days: {date, total, count, items}[], count, shown}} count＝期間内の出費の全件数、shown＝items に入れた件数
 */
export function spendsByDay(budget, period, limit = Infinity) {
  const list = spendsIn(budget, period).map((s, i) => ({ s, i }));
  list.sort((a, b) => (a.s.date === b.s.date ? b.i - a.i : a.s.date < b.s.date ? 1 : -1));
  const days = [];
  let shown = 0;
  for (const { s } of list) {
    let day = days[days.length - 1];
    if (!day || day.date !== s.date) {
      day = { date: s.date, total: 0, count: 0, items: [] };
      days.push(day);
    }
    day.total += toYen(s.amount);
    day.count += 1;
    if (shown < limit) {
      day.items.push(s);
      shown += 1;
    }
  }
  return { days: days.filter((d) => d.items.length > 0), count: list.length, shown };
}

/**
 * 期間内の出費を、カテゴリごとに集めて、多い順に並べる（ランキングの横棒用）。
 * カテゴリなしは「カテゴリなし」として数える。同額なら、カテゴリの並び順（食費…その他、カテゴリなし）。
 * @returns {{rows: {key, label, total, count, ratio}[], total, count}} ratio＝いちばん多いカテゴリを 1 としたときの割合（棒の長さ用）
 */
export function spendsByCategory(budget, period) {
  const order = [...SPEND_CATEGORIES.map((c) => c.key), ''];
  const byKey = new Map();
  let total = 0;
  let count = 0;
  for (const s of spendsIn(budget, period)) {
    const key = order.includes(s.category) ? s.category : '';
    const row = byKey.get(key) ?? { key, label: spendCategoryLabel(key), total: 0, count: 0, ratio: 0 };
    row.total += toYen(s.amount);
    row.count += 1;
    byKey.set(key, row);
    total += toYen(s.amount);
    count += 1;
  }
  const rows = [...byKey.values()].sort((a, b) => b.total - a.total || order.indexOf(a.key) - order.indexOf(b.key));
  const max = rows[0]?.total ?? 0;
  for (const r of rows) r.ratio = max > 0 ? r.total / max : 0;
  return { rows, total, count };
}

/**
 * 期間の金額をまとめて計算する（設計書 4.2）
 * @returns {{period, income, fixed, savings, extra, freeBeforeExtra, free, spent, leftover, incomeLines, fixedLines}}
 *   freeBeforeExtra＝返済への上乗せを引く前の自由に使える額（提案画面の目安に使う）
 */
export function periodAmounts(data, period) {
  const budget = data.budget;
  const inLines = incomeLines(budget, period);
  const fxLines = fixedLines(data, period);
  const income = sumBy(inLines);
  const fixed = sumBy(fxLines);
  const savings = savingsOf(budget.settings, income);
  const extra = extraOf(data);
  const freeBeforeExtra = income - fixed - savings;
  const free = freeBeforeExtra - extra;
  const spent = spendsIn(budget, period).reduce((s, x) => s + toYen(x.amount), 0);
  return { period, income, fixed, savings, extra, freeBeforeExtra, free, spent, leftover: free - spent, incomeLines: inLines, fixedLines: fxLines };
}

/** 収入・固定費・出費・記録が何もない（「何も入れていないときの案内」を出す） */
export function isBudgetEmpty(budget) {
  return !budget.incomes.length && !budget.fixed.length && !budget.entries.length && !budget.spends.length;
}

// ---- 4.3 今日の目安 ----

/**
 * 今日あといくら使えるか。今日が period の中にないときは null
 * @returns {{today, daysLeft, free, spent, leftover, spentBefore, todayBudget, todaySpent, todayLeft, tomorrowPerDay}}
 *   todayBudget＝今日の目安、todayLeft＝今日あと（マイナスになりうる）、
 *   tomorrowPerDay＝明日以降の1日あたり（今日が最終日なら null）
 */
export function todayGuide(data, today, period) {
  const p = period || periodOf(data.budget.settings, today);
  if (!inRange(today, p)) return null;
  const a = periodAmounts(data, p);
  const daysLeft = diffDays(today, p.end) + 1;
  let spentBefore = 0;
  let todaySpent = 0;
  for (const s of spendsIn(data.budget, p)) {
    if (s.date < today) spentBefore += toYen(s.amount);
    else if (s.date === today) todaySpent += toYen(s.amount);
  }
  const todayBudget = Math.max(0, Math.floor((a.free - spentBefore) / daysLeft));
  return {
    today,
    daysLeft,
    free: a.free,
    spent: a.spent,
    leftover: a.leftover,
    spentBefore,
    todayBudget,
    todaySpent,
    todayLeft: todayBudget - todaySpent,
    tomorrowPerDay: daysLeft > 1 ? Math.max(0, Math.floor(a.leftover / (daysLeft - 1))) : null,
  };
}

// ---- 4.4 履歴（スナップショット） ----

/** 期間の結果を確定した形にする */
export function makeSnapshot(data, period, now = new Date().toISOString()) {
  const a = periodAmounts(data, period);
  return {
    start: period.start,
    end: period.end,
    income: a.income,
    fixed: a.fixed,
    savings: a.savings,
    extra: a.extra,
    free: a.free,
    spent: a.spent,
    leftover: a.leftover,
    closedAt: now,
  };
}

/**
 * まだ確定していない、終了した期間のスナップショット（settings.since 以降に始まった期間だけ）。
 * data は書き換えない。保存するには、戻り値を data.budget.snapshots[s.start] = s で入れる。
 * アプリを開かなかった期間は、そのときの設定で計算する（近似）。
 */
export function pendingSnapshots(data, today, now = new Date().toISOString()) {
  const { settings, snapshots } = data.budget;
  if (!settings.since) return [];
  const out = [];
  // 直近に終わった期間から過去へたどる（今の期間の1つ前は、必ず今日より前に終わっている）
  let p = shiftPeriod(settings, periodOf(settings, today), -1);
  for (let i = 0; i < MAX_SNAPSHOT_PERIODS && p.start >= settings.since; i += 1) {
    if (!snapshots[p.start]) out.push(makeSnapshot(data, p, now));
    p = shiftPeriod(settings, p, -1);
  }
  return out.reverse();
}

/**
 * 確定した期間の「使った額」「余り」を、今の出費に合わせて作り直す。
 * 確定したあとも、出費はあとから直せる（追加・編集・削除・日付の変更）。そのとき、
 * 収入・固定費・貯金・上乗せ・自由に使える額は確定のまま、spent と leftover（＝free − spent）だけ更新する。
 * 変わったスナップショットだけを、新しいオブジェクトで返す（data は書き換えない）。
 * 保存するには、戻り値を data.budget.snapshots[s.start] = s で入れる。出費を変えるたびと、起動時に呼ぶ。
 *
 * 給料日を変えると、確定した期間どうしが重なることがある（historyOf の split）。重なった日の出費は、
 * その日を含む期間のすべてに数える（どれか1つにだけ入れると、確定した値が起動のたびに書き換わってしまう）。
 */
export function syncSnapshotSpent(data) {
  const snaps = Object.values(data.budget.snapshots).sort(byStart);
  if (snaps.length === 0) return [];
  // 出費を日付順にして、累計から「期間の初日〜最終日」の合計を引き算で出す（期間が重なっていても、1期間ずつ正しく数えられる）
  const list = data.budget.spends.map((sp) => ({ date: sp.date, amount: toYen(sp.amount) })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const prefix = new Array(list.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < list.length; i += 1) prefix[i + 1] = prefix[i] + list[i].amount;
  // iso 以上（strict なら、iso より後）の最初の位置
  const firstFrom = (iso, strict) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (strict ? list[mid].date <= iso : list[mid].date < iso) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const changed = [];
  for (const s of snaps) {
    const spent = prefix[firstFrom(s.end, true)] - prefix[firstFrom(s.start, false)];
    if (s.spent !== spent) changed.push({ ...s, spent, leftover: s.free - spent });
  }
  return changed;
}

// ---- 4.4 履歴の画面用のまとめ ----

/** 履歴の棒グラフに出す期間の数（最近12期間） */
export const HISTORY_CHART_COUNT = 12;

/**
 * 履歴の画面に出すものをまとめる。確定したスナップショットの値は、そのまま使う（作り直さない・消さない）。
 * data は書き換えない。「今日」は引数で受け取る。
 *
 * 給料日を変えると、確定済みの履歴（古い区切り）と、新しい区切りで確定した期間が重なる（設計書「13」の次のフェーズ）。
 * 重なった組のうち、先に確定した方（closedAt が小さい方）に split を付ける＝「給料日を変える前の区切り」。
 * 今の期間（まだ確定していない）と重なる確定済みの期間も、同じ扱い。split の行は、棒グラフと「前の期間との比べ」には入れない
 * （同じ日の出費を二重に数えるため）。一覧には、そのまま並べる。
 *
 * @returns {{rows, current, chart, splitCount}}
 *   rows＝確定した期間（開始日の新しい順）。各行は スナップショット＋ { split, prev }。
 *     prev＝前の期間（split でない、ひとつ前の期間）との差 { start, spentDiff, leftoverDiff }（使った額・余りの増減）。なければ null。split の行は null
 *   current＝今の期間（途中）{ period, income, fixed, free, spent, leftover }
 *   chart＝{ bars, zero }。bars＝split でない最近 chartCount 期間（古い順）に { up, down }（余りが＋なら up、−なら down。棒の長さの割合。
 *     up＋down の最大が、zero を境に上下で 1 になる）、zero＝ゼロの線の位置（上端から 0〜1。マイナスがなければ 1）
 *   splitCount＝split の期間の数
 */
export function historyOf(data, today, chartCount = HISTORY_CHART_COUNT) {
  const { settings, snapshots } = data.budget;
  const snaps = Object.values(snapshots).sort(byStart);
  const period = periodOf(settings, today);

  // 期間の重なりを調べる。開始日順に並べて、「次の期間の開始日 ≦ この期間の終了日」の間だけ見る
  const all = [...snaps.map((s) => ({ start: s.start, end: s.end, closedAt: s.closedAt })), { start: period.start, end: period.end, closedAt: '￿', current: true }].sort(byStart);
  const split = new Set();
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length && all[j].start <= all[i].end; j += 1) {
      const older = all[i].closedAt <= all[j].closedAt ? all[i] : all[j];
      if (!older.current) split.add(older.start);
    }
  }

  const chain = snaps.filter((s) => !split.has(s.start)); // 比べ・棒グラフに使う期間（古い順）
  const prevOf = new Map();
  chain.forEach((s, i) => {
    if (i > 0) prevOf.set(s.start, chain[i - 1]);
  });
  const rows = snaps
    .map((s) => {
      const p = prevOf.get(s.start);
      return { ...s, split: split.has(s.start), prev: p ? { start: p.start, spentDiff: s.spent - p.spent, leftoverDiff: s.leftover - p.leftover } : null };
    })
    .reverse();

  const recent = chain.slice(-chartCount);
  let posMax = 0;
  let negMax = 0;
  for (const s of recent) {
    if (s.leftover > posMax) posMax = s.leftover;
    if (-s.leftover > negMax) negMax = -s.leftover;
  }
  const span = posMax + negMax;
  const bars = recent.map((s) => ({ ...s, up: span && s.leftover > 0 ? s.leftover / span : 0, down: span && s.leftover < 0 ? -s.leftover / span : 0 }));

  const a = periodAmounts(data, period);
  return {
    rows,
    current: { period, income: a.income, fixed: a.fixed, free: a.free, spent: a.spent, leftover: a.leftover },
    chart: { bars, zero: span ? posMax / span : 1 },
    splitCount: split.size,
  };
}

// ---- 7. 完済ナビとの連携 ----

/**
 * 提案画面の目安：返済への上乗せの前の「自由に使える額」（今の期間）と、毎月の余剰金がそれを超えているか。
 * 家計に何も入れていないとき（isBudgetEmpty）は null（目安を出さない）。data は書き換えない。
 * @returns {null | {period, free, extra, negative, over, overBy}}
 *   free＝上乗せの前の自由に使える額、negative＝それがマイナス、over＝毎月の余剰金（extra）が、free（マイナスなら0）を超えている、
 *   overBy＝超えている額（over でなければ 0）
 */
export function extraGuide(data, today) {
  if (isBudgetEmpty(data.budget)) return null;
  const period = periodOf(data.budget.settings, today);
  const free = periodAmounts(data, period).freeBeforeExtra;
  const extra = toYen(data.plan?.monthlyExtra);
  const room = Math.max(0, free);
  return { period, free, extra, negative: free < 0, over: extra > room, overBy: Math.max(0, extra - room) };
}

// ---- 4.5 「もしも」 ----

/**
 * 変更を重ねて、自由に使える額がどう変わるかを比べる。実データは変えない。
 *
 * changes（配列。上から順に適用）：
 *   { type: 'amount', target: 'income'|'fixed', id, amount }   項目の金額を変える（単価×回数は単価）
 *   { type: 'off',    target: 'income'|'fixed', id }            項目をオフにする
 *   { type: 'add',    target: 'income'|'fixed', item }          仮の項目を足す（item は収支の項目と同じ形）
 *   { type: 'extra',  value }                                   返済への上乗せを変える
 *
 * @returns {{period, base, changed, perPeriod, perYear, plan}}
 *   perPeriod＝period 1期あたりの変化、perYear＝その期から12期分の合計
 *   （毎月の項目なら perPeriod の12倍と同じ。年払い・ボーナスもその年の分が入る）
 *   plan＝返済への上乗せを変えたときだけ、完済時期と利息の変化（buildPlan の「おすすめ」どうしで比べる）。なければ null
 */
export function whatIf(data, changes, period) {
  const p = period;
  const mod = {
    ...data,
    plan: { ...data.plan },
    budget: { ...data.budget, incomes: data.budget.incomes.map((x) => ({ ...x })), fixed: data.budget.fixed.map((x) => ({ ...x })) },
  };
  let tempId = 0;
  for (const c of changes || []) {
    if (c.type === 'extra') {
      mod.plan.monthlyExtra = toYen(c.value);
      continue;
    }
    const key = c.target === 'income' ? 'incomes' : 'fixed';
    if (c.type === 'add') {
      tempId += 1;
      mod.budget[key] = [...mod.budget[key], { enabled: true, ...c.item, id: `whatif-${tempId}` }];
      continue;
    }
    const item = mod.budget[key].find((x) => x.id === c.id);
    if (!item) continue;
    if (c.type === 'amount') item.amount = toYen(c.amount);
    else if (c.type === 'off') item.enabled = false;
  }

  const base = periodAmounts(data, p);
  const changed = periodAmounts(mod, p);
  let perYear = 0;
  let q = p;
  for (let i = 0; i < 12; i += 1) {
    perYear += periodAmounts(mod, q).free - periodAmounts(data, q).free;
    q = shiftPeriod(data.budget.settings, q, 1);
  }
  return { period: p, base, changed, perPeriod: changed.free - base.free, perYear, plan: extraPlanChange(data, mod) };
}

/** 返済への上乗せを変えたときの、完済時期と利息の変化。上乗せが変わっていない・返済中の会社がなければ null */
function extraPlanChange(data, mod) {
  const beforeExtra = toYen(data.plan?.monthlyExtra);
  const afterExtra = toYen(mod.plan.monthlyExtra);
  if (activeDebts(data).length === 0 || beforeExtra === afterExtra) return null;
  const lumpSum = toYen(data.plan?.lumpSum);
  const pick = (monthlyExtra) => {
    const r = buildPlan(data.debts, { lumpSum, monthlyExtra });
    const s = r[r.recommended];
    return { monthlyExtra, finished: s.finished, months: s.months, totalInterest: s.totalInterest };
  };
  const b = pick(beforeExtra);
  const a = pick(afterExtra);
  const both = b.finished && a.finished;
  return { before: b, after: a, monthsSaved: both ? b.months - a.months : null, interestSaved: both ? b.totalInterest - a.totalInterest : null };
}
