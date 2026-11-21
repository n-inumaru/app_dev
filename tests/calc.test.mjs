// 計算部分のテスト。実行：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, buildPlan, monthlyInterest, isStuck, MAX_MONTHS } from '../js/calc.js';

const D = (id, balance, rate, payment) => ({ id, name: id, balance, rate, payment });
const sumValues = (o) => Object.values(o).reduce((s, v) => s + v, 0);

// 再現できる乱数（テストのたびに同じ値）
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDebts(rand, n) {
  const rates = [0, 3, 4.5, 9.9, 12, 14.5, 15, 17.8, 18, 20];
  return Array.from({ length: n }, (_, i) => {
    const balance = Math.round((10000 + rand() * 1990000) / 1000) * 1000;
    const rate = rates[Math.floor(rand() * rates.length)];
    const minPay = monthlyInterest(balance, rate) + 1000;
    const payment = Math.max(minPay, Math.round((balance * (0.01 + rand() * 0.05)) / 1000) * 1000);
    return D(`d${i}`, balance, rate, payment);
  });
}

test('利息は「残高×年利÷12」で1円未満切り捨て', () => {
  assert.equal(monthlyInterest(100000, 15), 1250);
  assert.equal(monthlyInterest(120000, 14.6), 1460); // 小数の誤差で 1459 にならない
  assert.equal(monthlyInterest(99999, 18), 1499); // 1499.985 → 1499
  assert.equal(monthlyInterest(0, 18), 0);
  assert.equal(monthlyInterest(500000, 0), 0);
});

test('年利0%なら「残高÷返済額」を切り上げた月数で完済', () => {
  const r = simulate([D('a', 100000, 0, 30000)]);
  assert.equal(r.finished, true);
  assert.equal(r.months, 4);
  assert.equal(r.totalInterest, 0);
  assert.equal(r.totalPaid, 100000);
});

test('1社だけなら、手計算どおりに利息がつく', () => {
  // 1か月目：利息 1,500 → 101,500 − 50,000 = 51,500
  // 2か月目：利息 772 → 52,272 − 50,000 = 2,272
  // 3か月目：利息 34 → 2,306 を払って完済
  const r = simulate([D('a', 100000, 18, 50000)]);
  assert.equal(r.months, 3);
  assert.deepEqual(r.timeline.map((t) => t.total), [100000, 51500, 2272, 0]);
  assert.equal(r.totalInterest, 1500 + 772 + 34);
  assert.equal(r.timeline[3].payments.a, 2306);
});

test('返済額が利息以下なら「完済できない」になる', () => {
  const d = D('a', 1000000, 18, 15000); // 利息 15,000
  assert.equal(isStuck(d), true);
  const r = simulate([d]);
  assert.equal(r.finished, false);
  assert.equal(r.months, null);
  assert.equal(r.timeline.length, MAX_MONTHS + 1);
  assert.equal(isStuck(D('b', 1000000, 18, 15001)), false);
});

test('一括の余剰金は、利率の高い会社から順に入れる', () => {
  const debts = [D('low', 300000, 3, 10000), D('high', 50000, 18, 5000), D('mid', 200000, 15, 8000)];
  const r = simulate(debts, { strategy: 'avalanche', lumpSum: 80000, rollover: true });
  assert.deepEqual(r.lumpAllocation, [
    { id: 'high', amount: 50000, paysOff: true },
    { id: 'mid', amount: 30000, paysOff: false },
  ]);
  assert.equal(r.perDebt.high.payoffMonth, 0);
  assert.deepEqual(r.order, ['high', 'mid', 'low']);
});

test('残高の少ない順は、残高の小さい会社から入れる', () => {
  const debts = [D('big', 900000, 18, 20000), D('small', 40000, 3, 5000), D('mid', 200000, 15, 8000)];
  const r = simulate(debts, { strategy: 'snowball', lumpSum: 60000, rollover: true });
  assert.deepEqual(r.order, ['small', 'mid', 'big']);
  assert.deepEqual(r.lumpAllocation, [
    { id: 'small', amount: 40000, paysOff: true },
    { id: 'mid', amount: 20000, paysOff: false },
  ]);
});

test('利率が同じなら、残高の少ない会社を先にする', () => {
  const r = simulate([D('a', 500000, 15, 10000), D('b', 100000, 15, 5000)], { strategy: 'avalanche' });
  assert.deepEqual(r.order, ['b', 'a']);
});

test('一括で全部返せるなら0か月で完済、余りも返す', () => {
  const r = simulate([D('a', 30000, 18, 5000), D('b', 20000, 15, 5000)], { strategy: 'avalanche', lumpSum: 70000 });
  assert.equal(r.finished, true);
  assert.equal(r.months, 0);
  assert.equal(r.lumpUsed, 50000);
  assert.equal(r.lumpLeft, 20000);
  assert.equal(r.totalInterest, 0);
});

test('完済した会社の分を次に回すと、毎月の支払総額が一定になる', () => {
  const debts = [D('a', 300000, 18, 10000), D('b', 150000, 15, 8000), D('c', 80000, 9.9, 6000)];
  const r = simulate(debts, { strategy: 'avalanche', rollover: true, monthlyExtra: 5000 });
  const budget = 10000 + 8000 + 6000 + 5000;
  const months = r.timeline.slice(1, -1); // 最後の月は端数
  assert.ok(months.length > 10);
  for (const t of months) assert.equal(sumValues(t.payments), budget, `${t.month}か月目`);
  assert.ok(sumValues(r.timeline.at(-1).payments) <= budget);
});

test('次に回さない設定では、完済した会社の分は使わない', () => {
  const debts = [D('a', 50000, 18, 10000), D('b', 300000, 15, 8000)];
  const r = simulate(debts, { strategy: 'avalanche', rollover: false, monthlyExtra: 2000 });
  const afterA = r.timeline.filter((t) => t.month > r.perDebt.a.payoffMonth && t.month < r.months);
  assert.ok(afterA.length > 0);
  for (const t of afterA) assert.equal(sumValues(t.payments), 8000 + 2000);
});

test('上乗せの開始月を記録する', () => {
  const debts = [D('a', 100000, 18, 10000), D('b', 300000, 15, 10000)];
  const r = simulate(debts, { strategy: 'avalanche', rollover: true });
  assert.equal(r.perDebt.a.extraFrom, null); // a は自分の返済だけで完済
  assert.equal(r.perDebt.b.extraFrom, r.perDebt.a.payoffMonth); // a の完済月の余りから b へ
});

test('ランダムな1000通りで、お金の出入りがつり合っている', () => {
  const rand = rng(1);
  for (let k = 0; k < 1000; k++) {
    const debts = randomDebts(rand, 1 + Math.floor(rand() * 5));
    const opts = {
      strategy: rand() < 0.5 ? 'avalanche' : 'snowball',
      lumpSum: rand() < 0.5 ? Math.round(rand() * 300000) : 0,
      monthlyExtra: rand() < 0.5 ? Math.round(rand() * 30000) : 0,
      rollover: rand() < 0.7,
    };
    const r = simulate(debts, opts);
    assert.equal(r.finished, true, JSON.stringify({ debts, opts }));
    const start = debts.reduce((s, d) => s + d.balance, 0);
    assert.equal(r.totalPaid, start + r.totalInterest, JSON.stringify({ debts, opts }));
    for (const t of r.timeline) {
      for (const v of Object.values(t.balances)) assert.ok(v >= 0);
    }
  }
});

test('ランダムな2000通りで、利率の高い順の利息は残高の少ない順以下', () => {
  const rand = rng(42);
  let worse = 0;
  let maxDiff = 0;
  for (let k = 0; k < 2000; k++) {
    const debts = randomDebts(rand, 2 + Math.floor(rand() * 4));
    const settings = {
      lumpSum: rand() < 0.4 ? Math.round(rand() * 200000) : 0,
      monthlyExtra: Math.round(rand() * 30000),
    };
    const p = buildPlan(debts, settings);
    const diff = p.avalanche.totalInterest - p.snowball.totalInterest;
    if (diff > 0) {
      worse += 1;
      maxDiff = Math.max(maxDiff, diff);
    }
  }
  // 切り捨ての端数で数円負けることはあっても、大きく負けることはない
  assert.ok(maxDiff <= 50, `最大 ${maxDiff}円 負けた（${worse}件）`);
});

test('利率の高い順は、ありうるすべての順番と比べても利息がほぼ最少', () => {
  const perms = (a) =>
    a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
  const rand = rng(7);
  let maxDiff = 0;
  for (let k = 0; k < 150; k++) {
    const debts = randomDebts(rand, 2 + Math.floor(rand() * 4));
    const opts = { lumpSum: rand() < 0.4 ? Math.round(rand() * 200000) : 0, monthlyExtra: Math.round(rand() * 30000), rollover: true };
    const av = simulate(debts, { ...opts, strategy: 'avalanche' }).totalInterest;
    let best = Infinity;
    for (const order of perms(debts.map((d) => d.id))) best = Math.min(best, simulate(debts, { ...opts, order }).totalInterest);
    maxDiff = Math.max(maxDiff, av - best);
  }
  // 差は毎月の1円未満切り捨てによる端数だけ
  assert.ok(maxDiff <= 50, `最少の順番より ${maxDiff}円 多い`);
});

test('参考：次に回さない前提なら、利率の高い順が最善とは限らない', () => {
  // 年18%でもすぐ終わる会社に入れると、その後の効果が続かない。
  // そのため提案は「毎月の総額を変えずに次へ回す」前提で計算している。
  const debts = [D('short', 60000, 18, 30000), D('long', 1500000, 15, 25000)];
  const opts = { lumpSum: 50000, rollover: false };
  const toShort = simulate(debts, { ...opts, strategy: 'avalanche' });
  const toLong = simulate(debts, { ...opts, order: ['long', 'short'] });
  assert.ok(toLong.totalInterest < toShort.totalInterest);
});

test('余剰金を入れると、今のままより利息が減り完済も早い', () => {
  const debts = [D('a', 500000, 18, 15000), D('b', 300000, 15, 10000), D('c', 100000, 14.5, 5000)];
  const p = buildPlan(debts, { lumpSum: 100000, monthlyExtra: 10000 });
  assert.equal(p.recommended, 'avalanche');
  assert.ok(p.avalanche.totalInterest < p.base.totalInterest);
  assert.ok(p.avalanche.months < p.base.months);
  assert.ok(p.avalanche.totalInterest <= p.snowball.totalInterest);
  assert.equal(p.monthlyTotal, 15000 + 10000 + 5000 + 10000);
});

test('完済済みの会社は計算に入れない', () => {
  const debts = [D('done', 0, 18, 7000), D('a', 300000, 15, 10000)];
  const p = buildPlan(debts, {});
  assert.deepEqual(p.active.map((d) => d.id), ['a']);
  assert.equal(p.monthlyTotal, 10000);
  assert.equal(p.avalanche.timeline[1].payments.a, 10000);
  assert.equal(p.avalanche.perDebt.done, undefined);
});

test('余剰金がなくても、完済した会社の分を次に回すだけで利息が減る', () => {
  const debts = [D('a', 100000, 18, 15000), D('b', 600000, 15, 10000)];
  const p = buildPlan(debts, {});
  assert.equal(p.hasSurplus, false);
  assert.ok(p.avalanche.totalInterest < p.base.totalInterest);
  assert.equal(p.planSameAsBase, false);
});

test('1社だけで余剰金もなければ、提案は今のままと同じ', () => {
  const p = buildPlan([D('a', 500000, 18, 15000)], {});
  assert.equal(p.planSameAsBase, true);
  assert.equal(p.sameOrder, true);
});
