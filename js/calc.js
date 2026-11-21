/**
 * 返済シミュレーションの計算（画面とは独立した純粋な関数）
 *
 * 計算のきまり
 * - 利息は毎月「残高 × 年利 ÷ 12」（1円未満は切り捨て）
 * - 毎月の返済額は一定
 * - 毎月の順番：利息がつく → 各社に毎月の返済額を払う → 余りを優先順に上乗せ
 */

export const MAX_MONTHS = 600; // 50年で計算を打ち切る

export const STRATEGY_LABEL = {
  avalanche: '利率の高い順',
  snowball: '残高の少ない順',
  base: '今のまま',
};

const toInt = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** 年利(%)を 1/1000% 単位の整数にする（小数の誤差で1円ずれないようにする） */
const toMilli = (rate) => Math.round(Number(rate) * 1000);

/** 1か月分の利息の目安（年利÷12、1円未満切り捨て） */
export function monthlyInterest(balance, rate) {
  return Math.floor((toInt(balance) * toMilli(rate)) / 1200000);
}

/** 毎月の返済額が利息以下で、このままでは残高が減らない */
export function isStuck(debt) {
  return debt.balance > 0 && toInt(debt.payment) <= monthlyInterest(debt.balance, debt.rate);
}

/** 余剰金を入れる優先順 */
export function priorityOrder(list, strategy) {
  const arr = list.slice();
  if (strategy === 'avalanche') {
    arr.sort((a, b) => b.milli - a.milli || a.start - b.start || a.index - b.index);
  } else if (strategy === 'snowball') {
    arr.sort((a, b) => a.start - b.start || b.milli - a.milli || a.index - b.index);
  }
  return arr; // 'none' は登録順
}

/**
 * 完済までを1か月ずつ計算する
 * @param {Array<{id:string, balance:number, rate:number, payment:number}>} debts
 * @param {{strategy?:'avalanche'|'snowball'|'none', lumpSum?:number, monthlyExtra?:number, rollover?:boolean, order?:string[]}} opts
 *   lumpSum      今すぐ一括で返す額
 *   monthlyExtra 毎月上乗せする額
 *   rollover     true なら、完済した会社に払っていた額も次の会社へ回す（毎月の総額が一定）
 *   order        優先順を会社のidで直接指定する（テスト用。strategy より優先）
 */
export function simulate(debts, opts = {}) {
  const strategy = opts.strategy || 'none';
  const rollover = !!opts.rollover;
  const lumpSum = toInt(opts.lumpSum);
  const extra = toInt(opts.monthlyExtra);

  const list = debts
    .filter((d) => toInt(d.balance) > 0)
    .map((d, index) => ({
      id: d.id,
      index,
      milli: toMilli(d.rate),
      payment: toInt(d.payment),
      start: toInt(d.balance),
    }));
  const order = opts.order
    ? opts.order.map((id) => list.find((d) => d.id === id)).filter(Boolean)
    : priorityOrder(list, strategy);

  const bal = {};
  const per = {};
  for (const d of list) {
    bal[d.id] = d.start;
    per[d.id] = { interest: 0, paid: 0, lump: 0, payoffMonth: null, extraFrom: null };
  }

  // 1) 一括の余剰金を、優先順に入れる
  let lumpLeft = lumpSum;
  const lumpAllocation = [];
  for (const d of order) {
    if (lumpLeft <= 0) break;
    const x = Math.min(bal[d.id], lumpLeft);
    if (x <= 0) continue;
    bal[d.id] -= x;
    lumpLeft -= x;
    per[d.id].paid += x;
    per[d.id].lump = x;
    const paysOff = bal[d.id] === 0;
    if (paysOff) per[d.id].payoffMonth = 0;
    lumpAllocation.push({ id: d.id, amount: x, paysOff });
  }
  const lumpUsed = lumpSum - lumpLeft;

  const budget = list.reduce((s, d) => s + d.payment, 0) + extra;
  const totalBalance = () => list.reduce((s, d) => s + bal[d.id], 0);

  let remaining = totalBalance();
  const timeline = [{ month: 0, total: remaining, balances: { ...bal }, payments: {}, interest: {} }];
  let totalInterest = 0;
  let totalPaid = lumpUsed;
  let month = 0;

  // 2) 1か月ずつ進める
  while (remaining > 0 && month < MAX_MONTHS) {
    month += 1;
    const payments = {};
    const interest = {};
    let used = 0;

    for (const d of list) {
      if (bal[d.id] <= 0) continue;
      const i = Math.floor((bal[d.id] * d.milli) / 1200000);
      bal[d.id] += i;
      interest[d.id] = i;
      per[d.id].interest += i;
      totalInterest += i;
    }

    for (const d of list) {
      if (bal[d.id] <= 0) continue;
      const x = Math.min(d.payment, bal[d.id]);
      bal[d.id] -= x;
      payments[d.id] = x;
      used += x;
    }

    let pool = rollover ? budget - used : extra;
    for (const d of order) {
      if (pool <= 0) break;
      if (bal[d.id] <= 0) continue;
      const x = Math.min(pool, bal[d.id]);
      bal[d.id] -= x;
      pool -= x;
      payments[d.id] = (payments[d.id] || 0) + x;
      used += x;
      if (per[d.id].extraFrom === null) per[d.id].extraFrom = month;
    }

    totalPaid += used;
    for (const d of list) {
      if (payments[d.id]) per[d.id].paid += payments[d.id];
      if (bal[d.id] === 0 && per[d.id].payoffMonth === null) per[d.id].payoffMonth = month;
    }
    remaining = totalBalance();
    timeline.push({ month, total: remaining, balances: { ...bal }, payments, interest });
  }

  const finished = remaining === 0;
  const payoffs = Object.values(per)
    .map((p) => p.payoffMonth)
    .filter((m) => m !== null);

  return {
    strategy,
    finished,
    months: finished ? month : null,
    totalInterest,
    totalPaid,
    lumpUsed,
    lumpLeft,
    lumpAllocation,
    order: order.map((d) => d.id),
    perDebt: per,
    timeline,
    firstPayoffMonth: payoffs.length ? Math.min(...payoffs) : null,
  };
}

/** 2つの返し方のうち、利息の合計が少ない方（同じなら利率の高い順） */
function pickRecommended(av, sb) {
  if (av.finished !== sb.finished) return av.finished ? 'avalanche' : 'snowball';
  if (!av.finished) return 'avalanche';
  return sb.totalInterest < av.totalInterest ? 'snowball' : 'avalanche';
}

const sameResult = (a, b) => a.months === b.months && a.totalInterest === b.totalInterest;

/**
 * 提案に必要な計算をまとめて行う
 *
 * 提案の返し方は、毎月の返済の総額を変えずに続ける前提（rollover）で計算する。
 * この前提では「利率の高い順」が利息を最も少なくする（tests/calc.test.mjs で確認）。
 * 「今のまま」は、余剰金なし・完済した会社の分も回さない場合。
 *
 * @param debts すべての会社（完済済みは計算から外す）
 * @param settings {lumpSum, monthlyExtra}
 */
export function buildPlan(debts, settings = {}) {
  const lumpSum = toInt(settings.lumpSum);
  const monthlyExtra = toInt(settings.monthlyExtra);
  const active = debts.filter((d) => toInt(d.balance) > 0);

  const opts = { lumpSum, monthlyExtra, rollover: true };
  const base = simulate(active, { strategy: 'none' });
  const avalanche = simulate(active, { ...opts, strategy: 'avalanche' });
  const snowball = simulate(active, { ...opts, strategy: 'snowball' });

  return {
    active,
    base,
    avalanche,
    snowball,
    recommended: pickRecommended(avalanche, snowball),
    sameOrder: avalanche.order.join('\n') === snowball.order.join('\n'),
    strategiesSame: sameResult(avalanche, snowball),
    planSameAsBase: sameResult(avalanche, base) && sameResult(snowball, base),
    lumpSum,
    monthlyExtra,
    hasSurplus: lumpSum > 0 || monthlyExtra > 0,
    monthlyTotal: active.reduce((s, d) => s + toInt(d.payment), 0) + monthlyExtra,
  };
}
