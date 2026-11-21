// テストで使う部品（架空のデータだけ）。*.test.mjs ではないので、単独では実行されない。
import { emptyBudget } from '../js/storage.js';

export const NOW = '2026-11-21T00:00:00.000Z';

let seq = 0;
export const resetIds = () => {
  seq = 0;
};

/** 収入の項目（毎月） */
export const income = (o = {}) => ({
  id: `inc${++seq}`,
  name: 'テスト給与',
  kind: 'monthly',
  amount: 0,
  months: [],
  day: 1,
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...o,
});

/** 固定費の項目（毎月） */
export const fixed = (o = {}) => ({
  id: `fix${++seq}`,
  name: 'テスト固定費',
  category: 'other',
  kind: 'monthly',
  amount: 0,
  every: 12,
  dueMonth: 1,
  dueDay: 1,
  mode: 'lump',
  uses: { by: 'weekdays', days: [1, 2, 3, 4, 5], skipHolidays: true, count: 0 },
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...o,
});

export const entry = (o = {}) => ({ id: `ent${++seq}`, date: '2026-12-05', amount: 0, memo: '', createdAt: NOW, ...o });
export const spend = (o = {}) => ({ id: `sp${++seq}`, date: '2026-12-05', amount: 0, category: '', memo: '', createdAt: NOW, ...o });

export const debt = (o = {}) => ({ id: `debt${++seq}`, name: 'テストA社', balance: 100000, rate: 15, payment: 10000, startBalance: 100000, createdAt: NOW, updatedAt: NOW, ...o });

/** アプリのデータ全体。settings・plan・debts と、budget の各配列を上書きできる */
export function makeData({ settings = {}, plan = {}, debts = [], ...budget } = {}) {
  const b = emptyBudget();
  return {
    version: 1,
    debts,
    records: [],
    plan: { lumpSum: 0, monthlyExtra: 0, ...plan },
    budget: { ...b, ...budget, settings: { ...b.settings, ...settings } },
    meta: { createdAt: NOW, updatedAt: NOW, lastBackupAt: null },
  };
}

/** 中まで書き換え禁止にする（計算が元のデータを変えていないことの確認用） */
export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * 確認用の通しデータ（給料日25日）。手計算の答えは tests/budget.test.mjs にある。
 *   期間 2026-11-25〜2026-12-24 と 2026-12-25〜2027-01-24
 */
export function scenario() {
  resetIds();
  const salary = income({ name: 'テスト給与', amount: 250000 });
  const bonus = income({ name: 'テスト賞与', kind: 'months', months: [6, 12], day: 10, amount: 600000 });
  const rent = fixed({ name: 'テスト家賃', category: 'housing', amount: 80000 });
  const insurance = fixed({ name: 'テスト保険（年払い）', category: 'insurance', kind: 'periodic', every: 12, dueMonth: 12, dueDay: 15, amount: 120000 });
  const gym = fixed({ name: 'テストジム（3か月ごと）', kind: 'periodic', every: 3, dueMonth: 11, dueDay: 30, amount: 9000 });
  const lunch = fixed({ name: 'テスト昼食', category: 'food', kind: 'uses', amount: 500 });
  const sub = fixed({ name: 'テスト配信（無効）', category: 'subscription', amount: 1500, enabled: false });
  const data = makeData({
    settings: { payday: 25, shiftEarly: true, savings: { mode: 'amount', value: 20000 }, since: '2026-11-25' },
    plan: { monthlyExtra: 5000 },
    debts: [debt({ name: 'テストA社', balance: 100000, payment: 10000 }), debt({ name: 'テストB社', balance: 0, payment: 5000 })],
    incomes: [salary, bonus],
    fixed: [rent, insurance, gym, lunch, sub],
    entries: [
      entry({ date: '2026-12-05', amount: 30000, memo: 'テスト副業' }),
      entry({ date: '2026-11-24', amount: 5000, memo: '前の期間' }),
      entry({ date: '2026-12-25', amount: 7000, memo: '次の期間' }),
    ],
  });
  return { data, salary, bonus, rent, insurance, gym, lunch, sub };
}
