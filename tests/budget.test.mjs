// 家計の計算のテスト。実行：npm test
// 答えは、すべて手計算（コメントに式）。データは架空のもの。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countWeekdays,
  extraGuide,
  fixedLines,
  historyOf,
  incomeLines,
  isBudgetEmpty,
  makeSnapshot,
  paydayOf,
  pendingSnapshots,
  periodAmounts,
  periodOf,
  savingsOf,
  shiftPeriod,
  spendCategoryLabel,
  spendsByCategory,
  spendsByDay,
  syncSnapshotSpent,
  todayGuide,
  usesCount,
  whatIf,
} from '../js/budget.js';
import { addDays } from '../js/dates.js';
import { isHoliday } from '../js/holidays.js';
import { debt, deepFreeze, entry, fixed, income, makeData, NOW, resetIds, scenario, spend } from './fixtures.mjs';

const S = (o = {}) => ({ payday: 25, shiftEarly: true, savings: { mode: 'amount', value: 0 }, since: null, ...o });
const P1 = { start: '2026-11-25', end: '2026-12-24', key: '2026-11-25', days: 30 };
const P2 = { start: '2026-12-25', end: '2027-01-24', key: '2026-12-25', days: 31 };

// ---------------- 4.1 期間（給料日サイクル） ----------------

test('期間：給料日25日。今日（11/21）は、前月の給料日 10/23 から 11/24 まで', () => {
  // 10/25 は日曜 → 金曜の 10/23 に前倒し。10/23〜10/31 が9日、11/1〜11/24 が24日で、計33日
  assert.deepEqual(periodOf(S(), '2026-11-21'), { start: '2026-10-23', end: '2026-11-24', key: '2026-10-23', days: 33 });
});

test('期間の境界：給料日の前日までが前の期間、給料日から次の期間', () => {
  assert.equal(periodOf(S(), '2026-11-24').start, '2026-10-23');
  assert.deepEqual(periodOf(S(), '2026-11-25'), P1);
  assert.deepEqual(periodOf(S(), '2026-12-24'), P1);
  assert.deepEqual(periodOf(S(), '2026-12-25'), P2);
  assert.equal(periodOf(S(), '2026-10-22').end, '2026-10-22'); // 10/23 が給料日なので、前の期間は 10/22 まで
});

test('期間は年をまたぐ（12/25〜1/24）', () => {
  assert.deepEqual(periodOf(S(), '2027-01-03'), P2);
  assert.deepEqual(periodOf(S(), '2026-12-31'), P2);
});

test('前倒し：土日祝なら前の平日まで戻す（初期ON）。OFFなら戻さない', () => {
  assert.equal(paydayOf(S(), 2026, 10), '2026-10-23'); // 25日が日曜
  assert.equal(paydayOf(S(), 2026, 7), '2026-07-24'); // 25日が土曜
  assert.equal(paydayOf(S(), 2026, 11), '2026-11-25'); // 水曜
  assert.equal(paydayOf(S({ shiftEarly: false }), 2026, 10), '2026-10-25');
  assert.equal(paydayOf(S({ payday: 23 }), 2026, 11), '2026-11-20'); // 23日は月曜の祝日（勤労感謝の日）→ 土日をはさんで金曜
  assert.equal(paydayOf(S({ payday: 3 }), 2026, 11), '2026-11-02'); // 文化の日（火）→ 月曜
  assert.equal(paydayOf(S({ payday: 5 }), 2026, 5), '2026-05-01'); // 5/5 こどもの日・5/4・5/3・5/2（土）を戻って金曜
});

test('給料日＝1日は、暦の月として扱い、前倒ししない', () => {
  assert.equal(paydayOf(S({ payday: 1 }), 2026, 11), '2026-11-01'); // 日曜
  assert.equal(paydayOf(S({ payday: 1 }), 2027, 1), '2027-01-01'); // 元日
  assert.deepEqual(periodOf(S({ payday: 1 }), '2026-11-15'), { start: '2026-11-01', end: '2026-11-30', key: '2026-11-01', days: 30 });
  assert.deepEqual(periodOf(S({ payday: 1 }), '2026-12-31'), { start: '2026-12-01', end: '2026-12-31', key: '2026-12-01', days: 31 });
});

test('月末払い（0）：その月の末日。土日祝は前倒し。うるう年も', () => {
  const m = S({ payday: 0 });
  assert.equal(paydayOf(m, 2026, 11), '2026-11-30'); // 月曜
  assert.equal(paydayOf(m, 2026, 10), '2026-10-30'); // 31日が土曜 → 金曜
  assert.equal(paydayOf(m, 2027, 2), '2027-02-26'); // 28日が日曜 → 金曜
  assert.equal(paydayOf(m, 2028, 2), '2028-02-29'); // うるう年の火曜
  assert.deepEqual(periodOf(m, '2026-11-05'), { start: '2026-10-30', end: '2026-11-29', key: '2026-10-30', days: 31 });
});

test('給料日が31日で、31日がない月は、その月の末日', () => {
  const m = S({ payday: 31 });
  assert.equal(paydayOf(m, 2026, 11), '2026-11-30');
  assert.equal(paydayOf(m, 2026, 12), '2026-12-31');
  assert.equal(paydayOf(m, 2027, 2), '2027-02-26'); // 28日（日曜）→ 金曜
  assert.equal(paydayOf(S({ payday: 31, shiftEarly: false }), 2027, 2), '2027-02-28');
});

test('前倒しで前の月にずれる給料日（2日払いで1/2が土曜、1/1が祝日）', () => {
  const m = S({ payday: 2 });
  assert.equal(paydayOf(m, 2027, 1), '2026-12-31');
  assert.deepEqual(periodOf(m, '2026-12-31'), { start: '2026-12-31', end: '2027-02-01', key: '2026-12-31', days: 33 }); // 次の給料日は 2/2（火）
  assert.deepEqual(periodOf(m, '2026-12-30'), { start: '2026-12-02', end: '2026-12-30', key: '2026-12-02', days: 29 });
});

test('期間は隙間も重なりもなく並ぶ（給料日いろいろ×前倒しON/OFF×2026〜2029年の毎日）', () => {
  for (const payday of [0, 1, 2, 10, 15, 25, 28, 31]) {
    for (const shiftEarly of [true, false]) {
      const s = S({ payday, shiftEarly });
      for (let d = '2026-01-01'; d <= '2029-12-31'; d = addDays(d, 1)) {
        const p = periodOf(s, d);
        const label = `payday=${payday} shift=${shiftEarly} ${d}`;
        assert.ok(p.start <= d && d <= p.end, label);
        assert.ok(p.days >= 25 && p.days <= 37, `${label} days=${p.days}`);
        assert.deepEqual(periodOf(s, p.start), p, label);
        assert.deepEqual(periodOf(s, p.end), p, label);
        assert.equal(periodOf(s, addDays(p.end, 1)).start, addDays(p.end, 1), label);
      }
    }
  }
});

test('前後の期間への移動', () => {
  assert.deepEqual(shiftPeriod(S(), P1, 1), P2);
  assert.deepEqual(shiftPeriod(S(), P2, -1), P1);
  assert.deepEqual(shiftPeriod(S(), P1, 0), P1);
  assert.equal(shiftPeriod(S(), P1, 12).start, '2027-11-25');
  assert.equal(shiftPeriod(S(), P1, -2).start, '2026-09-25');
});

// ---------------- 4.2 収入 ----------------

test('収入：毎月の収入と、決まった月の収入（支給日が期間内のときだけ）', () => {
  resetIds();
  const b = makeData({ incomes: [income({ amount: 250000 }), income({ name: 'テスト賞与', kind: 'months', months: [6, 12], day: 10, amount: 600000 })] }).budget;
  assert.deepEqual(incomeLines(b, P1).map((l) => [l.name, l.amount]), [['テスト給与', 250000], ['テスト賞与', 600000]]); // 12/10 は P1 の中
  assert.deepEqual(incomeLines(b, P2).map((l) => [l.name, l.amount]), [['テスト給与', 250000]]);
  assert.deepEqual(incomeLines(b, shiftPeriod(S(), P1, -6)).map((l) => l.name), ['テスト給与', 'テスト賞与']); // 5/25〜6/24 に 6/10 が入る
  assert.deepEqual(incomeLines(b, shiftPeriod(S(), P1, -5)).map((l) => l.name), ['テスト給与']); // 6/25〜7/23 には入らない
});

test('ボーナスの支給日が期間の最終日・初日のとき', () => {
  resetIds();
  const last = makeData({ incomes: [income({ kind: 'months', months: [12], day: 24, amount: 1000 })] }).budget;
  const first = makeData({ incomes: [income({ kind: 'months', months: [12], day: 25, amount: 1000 })] }).budget;
  assert.equal(incomeLines(last, P1).length, 1); // 12/24 は P1 の最終日
  assert.equal(incomeLines(last, P2).length, 0);
  assert.equal(incomeLines(first, P1).length, 0);
  assert.equal(incomeLines(first, P2).length, 1); // 12/25 は P2 の初日
});

test('支給日が月末を超えるときは月末（6月31日 → 6月30日）', () => {
  resetIds();
  const b = makeData({ incomes: [income({ kind: 'months', months: [6], day: 31, amount: 1000 })] }).budget;
  const june = { start: '2026-06-25', end: '2026-07-24', key: '2026-06-25', days: 30 };
  assert.equal(incomeLines(b, june)[0].dates[0], '2026-06-30');
});

test('変わる収入（記録）は、日付が期間内のものだけ入る。期間の初日・最終日も入る', () => {
  resetIds();
  const b = makeData({
    entries: [entry({ date: '2026-11-24', amount: 1 }), entry({ date: '2026-11-25', amount: 10 }), entry({ date: '2026-12-24', amount: 100 }), entry({ date: '2026-12-25', amount: 1000 })],
  }).budget;
  assert.deepEqual(incomeLines(b, P1).map((l) => l.amount), [10, 100]);
  assert.deepEqual(incomeLines(b, P2).map((l) => l.amount), [1000]);
  assert.equal(incomeLines(b, P1)[0].kind, 'entry');
});

test('無効の収入は入らない。上書きは、その期間だけ金額を置き換える', () => {
  resetIds();
  const a = income({ amount: 250000 });
  const off = income({ amount: 99999, enabled: false });
  const data = makeData({ incomes: [a, off], overrides: { [P1.key]: { income: { [a.id]: 270000 }, fixed: {}, uses: {} } } });
  const l1 = incomeLines(data.budget, P1);
  assert.deepEqual(l1.map((l) => [l.amount, l.baseAmount, l.overridden]), [[270000, 250000, true]]);
  assert.deepEqual(incomeLines(data.budget, P2).map((l) => [l.amount, l.overridden]), [[250000, false]]);
});

// ---------------- 4.2 固定費 ----------------

test('固定費：毎月の項目。無効の項目は入らない', () => {
  resetIds();
  const data = makeData({ fixed: [fixed({ amount: 80000 }), fixed({ amount: 1500, enabled: false })] });
  assert.deepEqual(fixedLines(data, P1).map((l) => l.amount), [80000]);
});

test('◯か月ごと（まとめて）：払う日が期間内の期にだけ、全額が入る', () => {
  resetIds();
  const yearly = fixed({ kind: 'periodic', every: 12, dueMonth: 12, dueDay: 15, amount: 120000 });
  const data = makeData({ fixed: [yearly] });
  assert.deepEqual(fixedLines(data, P1).map((l) => [l.amount, l.dates]), [[120000, ['2026-12-15']]]);
  assert.equal(fixedLines(data, P2).length, 0);
  assert.equal(fixedLines(data, shiftPeriod(S(), P1, 12)).length, 1); // 1年後の 12/15 にもう一度
  assert.equal(fixedLines(data, shiftPeriod(S(), P1, 6)).length, 0);
});

test('◯か月ごと（まとめて）：3か月ごと・半年ごと・2か月ごと・4か月ごとの払う月', () => {
  resetIds();
  const monthsDue = (every, dueMonth) => {
    const data = makeData({ settings: { payday: 1 }, fixed: [fixed({ kind: 'periodic', every, dueMonth, dueDay: 10, amount: 1000 })] });
    const out = [];
    for (let m = 1; m <= 12; m += 1) {
      const p = periodOf(data.budget.settings, `2027-${String(m).padStart(2, '0')}-15`);
      if (fixedLines(data, p).length) out.push(m);
    }
    return out;
  };
  assert.deepEqual(monthsDue(3, 11), [2, 5, 8, 11]);
  assert.deepEqual(monthsDue(6, 11), [5, 11]);
  assert.deepEqual(monthsDue(2, 3), [1, 3, 5, 7, 9, 11]);
  assert.deepEqual(monthsDue(4, 2), [2, 6, 10]);
  assert.deepEqual(monthsDue(12, 4), [4]);
});

test('◯か月ごとの払う日が月末を超えるとき（11月30日、2月は28日）', () => {
  resetIds();
  const gym = fixed({ kind: 'periodic', every: 3, dueMonth: 11, dueDay: 30, amount: 9000 });
  const data = makeData({ fixed: [gym] });
  assert.equal(fixedLines(data, P1).length, 1); // 11/30
  const feb = periodOf(S(), '2027-02-28'); // 2/25〜3/24
  assert.deepEqual(fixedLines(data, feb).map((l) => l.dates), [['2027-02-28']]);
});

test('◯か月ごと（月割り）：毎期 floor(金額 ÷ 間隔) を積み立てる', () => {
  resetIds();
  const data = makeData({ fixed: [fixed({ kind: 'periodic', mode: 'spread', every: 12, dueMonth: 12, amount: 100000 })] });
  assert.deepEqual(fixedLines(data, P1).map((l) => l.amount), [8333]); // 100000 ÷ 12 = 8333.33…
  assert.deepEqual(fixedLines(data, P2).map((l) => l.amount), [8333]); // 払う月でなくても毎期
  const half = makeData({ fixed: [fixed({ kind: 'periodic', mode: 'spread', every: 6, amount: 30000 })] });
  assert.deepEqual(fixedLines(half, P1).map((l) => l.amount), [5000]);
  const up = makeData({ fixed: [fixed({ kind: 'periodic', mode: 'spread', every: 12, amount: 20000 })] });
  assert.deepEqual(fixedLines(up, P1).map((l) => l.amount), [1666]); // 1666.67 を四捨五入ではなく切り捨て
});

test('単価×回数：曜日（月〜金）の日数から祝日を除く', () => {
  const sep = { start: '2026-09-01', end: '2026-09-30', key: '2026-09-01', days: 30 };
  const nov = { start: '2026-11-01', end: '2026-11-30', key: '2026-11-01', days: 30 };
  // 2026年9月：平日22日。うち 9/21（敬老の日）・9/22（国民の休日）・9/23（秋分の日）が祝日 → 19日
  assert.equal(countWeekdays(sep, [1, 2, 3, 4, 5], false), 22);
  assert.equal(countWeekdays(sep, [1, 2, 3, 4, 5], true), 19);
  // 11月：平日21日。11/3（火）・11/23（月）が祝日 → 19日
  assert.equal(countWeekdays(nov, [1, 2, 3, 4, 5], true), 19);
  // 月曜だけ：9月は 7・14・21・28 の4日、21日が祝日 → 3日
  assert.equal(countWeekdays(sep, [1], false), 4);
  assert.equal(countWeekdays(sep, [1], true), 3);
  // 土日を含めれば、暦の日数すべて（祝日を除かなければ）
  assert.equal(countWeekdays(sep, [0, 1, 2, 3, 4, 5, 6], false), 30);
  assert.equal(countWeekdays(sep, [], true), 0);
});

test('単価×回数：金額＝単価×回数。「祝日を除く」のON/OFFで変わる', () => {
  resetIds();
  const sepData = (skipHolidays) =>
    makeData({ settings: { payday: 1 }, fixed: [fixed({ kind: 'uses', amount: 500, uses: { by: 'weekdays', days: [1, 2, 3, 4, 5], skipHolidays, count: 0 } })] });
  const sep = { start: '2026-09-01', end: '2026-09-30', key: '2026-09-01', days: 30 };
  assert.deepEqual(fixedLines(sepData(true), sep).map((l) => [l.count, l.amount]), [[19, 9500]]);
  assert.deepEqual(fixedLines(sepData(false), sep).map((l) => [l.count, l.amount]), [[22, 11000]]);
});

test('単価×回数：「期間に◯回」', () => {
  resetIds();
  const data = makeData({ fixed: [fixed({ kind: 'uses', amount: 1000, uses: { by: 'count', days: [], skipHolidays: true, count: 4 } })] });
  assert.deepEqual(fixedLines(data, P1).map((l) => [l.count, l.amount]), [[4, 4000]]);
});

test('単価×回数：P1 は22日、P2 は19日（年末年始の祝日を除く）', () => {
  const { data, lunch } = scenario();
  // P1 11/25〜12/24：11/25〜11/30 が4日（水木金月）、12/1〜12/24 が18日 → 22日
  assert.equal(usesCount(lunch, P1), 22);
  // P2 12/25〜1/24：12月は 25・28・29・30・31 の5日。1月は 1/1（元日）と 1/11（成人の日）を除いて 4〜8 の5日・12〜15 の4日・18〜22 の5日で14日 → 19日
  assert.equal(usesCount(lunch, P2), 19);
  assert.equal(usesCount({ ...lunch, uses: { ...lunch.uses, skipHolidays: false } }, P2), 21);
  assert.equal(fixedLines(data, P2).find((l) => l.id === lunch.id).amount, 9500);
});

test('単価×回数の上書きは「回数」（有給・在宅・年末年始用）。0回も上書きとして働く', () => {
  const { data, lunch } = scenario();
  const withOv = (n) => ({ ...data, budget: { ...data.budget, overrides: { [P2.key]: { income: {}, fixed: {}, uses: { [lunch.id]: n } } } } });
  const l = fixedLines(withOv(15), P2).find((x) => x.id === lunch.id);
  assert.deepEqual([l.count, l.baseCount, l.amount, l.baseAmount, l.overridden], [15, 19, 7500, 9500, true]);
  const zero = fixedLines(withOv(0), P2).find((x) => x.id === lunch.id);
  assert.deepEqual([zero.count, zero.amount, zero.overridden], [0, 0, true]);
  assert.equal(fixedLines(withOv(15), P1).find((x) => x.id === lunch.id).overridden, false); // 別の期間には効かない
});

test('固定費の上書きは、その期間にその項目が計上される額を置き換える（毎月・まとめて・月割り）', () => {
  resetIds();
  const rent = fixed({ amount: 80000 });
  const yearly = fixed({ kind: 'periodic', every: 12, dueMonth: 12, dueDay: 15, amount: 120000 });
  const spread = fixed({ kind: 'periodic', mode: 'spread', every: 12, amount: 12000 });
  const data = makeData({
    fixed: [rent, yearly, spread],
    overrides: { [P1.key]: { income: {}, fixed: { [rent.id]: 82000, [yearly.id]: 118000, [spread.id]: 500 }, uses: {} } },
  });
  assert.deepEqual(fixedLines(data, P1).map((l) => [l.amount, l.baseAmount, l.overridden]), [[82000, 80000, true], [118000, 120000, true], [500, 1000, true]]);
  assert.deepEqual(fixedLines(data, P2).map((l) => [l.amount, l.overridden]), [[80000, false], [1000, false]]); // 年払いは払う月ではない
});

test('借入の返済：返済中の会社（残高あり）の返済額の合計が自動で1行入り、完済した会社は入らない', () => {
  resetIds();
  const data = makeData({ debts: [debt({ balance: 100000, payment: 10000 }), debt({ balance: 50000, payment: 7000 }), debt({ balance: 0, payment: 5000 })] });
  const lines = fixedLines(data, P1);
  assert.deepEqual(lines.map((l) => [l.kind, l.auto, l.amount, l.companies]), [['debt', true, 17000, 2]]);
  assert.equal(fixedLines(makeData({ debts: [debt({ balance: 0 })] }), P1).length, 0);
});

// ---------------- 4.2 自由に使える額 ----------------

test('通しの手計算：P1（賞与・変わる収入・年払い・3か月ごと・昼食・返済・貯金・上乗せ）', () => {
  const { data } = scenario();
  const a = periodAmounts(data, P1);
  // 収入 = 給与 250,000 + 賞与 600,000（12/10）+ 変わる収入 30,000（12/5。11/24 と 12/25 のぶんは別の期間）
  assert.equal(a.income, 880000);
  // 固定費 = 家賃 80,000 + 保険 120,000（12/15）+ ジム 9,000（11/30）+ 昼食 500×22 = 11,000 + 借入の返済 10,000（A社だけ。B社は完済）
  //   ※ 無効の「配信」1,500 は入らない
  assert.equal(a.fixed, 230000);
  assert.equal(a.savings, 20000);
  assert.equal(a.extra, 5000);
  assert.equal(a.freeBeforeExtra, 630000); // 880,000 − 230,000 − 20,000
  assert.equal(a.free, 625000); // − 5,000
  assert.equal(a.spent, 0);
  assert.equal(a.leftover, 625000);
});

test('通しの手計算：P2（賞与なし・年払いなし・昼食19日）', () => {
  const { data } = scenario();
  const a = periodAmounts(data, P2);
  assert.equal(a.income, 257000); // 給与 250,000 + 変わる収入 7,000（12/25）
  assert.equal(a.fixed, 99500); // 80,000 + 500×19 = 9,500 + 返済 10,000
  assert.equal(a.free, 132500); // 257,000 − 99,500 − 20,000 − 5,000
});

test('通しの手計算：P1 に上書き（賞与の実額・家賃・保険・昼食の回数）', () => {
  const { data, bonus, rent, insurance, lunch } = scenario();
  data.budget.overrides[P1.key] = { income: { [bonus.id]: 550000 }, fixed: { [rent.id]: 82000, [insurance.id]: 118000 }, uses: { [lunch.id]: 20 } };
  const a = periodAmounts(data, P1);
  assert.equal(a.income, 830000); // 250,000 + 550,000 + 30,000
  assert.equal(a.fixed, 229000); // 82,000 + 118,000 + 9,000 + 500×20 = 10,000 + 10,000
  assert.equal(a.free, 576000); // 830,000 − 229,000 − 20,000 − 5,000
  assert.equal(periodAmounts(data, P2).free, 132500); // 別の期間は変わらない
});

test('貯金の取り分：金額、または収入の◯%（円未満は切り捨て）', () => {
  assert.equal(savingsOf(S({ savings: { mode: 'amount', value: 20000 } }), 880000), 20000);
  assert.equal(savingsOf(S({ savings: { mode: 'percent', value: 10 } }), 880000), 88000);
  assert.equal(savingsOf(S({ savings: { mode: 'percent', value: 10 } }), 257999), 25799); // 25799.9
  assert.equal(savingsOf(S({ savings: { mode: 'percent', value: 0 } }), 880000), 0);
  assert.equal(savingsOf(S({ savings: { mode: 'percent', value: 10 } }), 0), 0);
  const { data } = scenario();
  data.budget.settings.savings = { mode: 'percent', value: 10 };
  assert.equal(periodAmounts(data, P1).savings, 88000);
  assert.equal(periodAmounts(data, P1).free, 880000 - 230000 - 88000 - 5000);
});

test('返済への上乗せは、返済中の会社があるときだけ引く。全部完済したら0', () => {
  resetIds();
  const noDebt = makeData({ plan: { monthlyExtra: 5000 }, incomes: [income({ amount: 100000 })] });
  assert.deepEqual([periodAmounts(noDebt, P1).extra, periodAmounts(noDebt, P1).free], [0, 100000]);
  const paidOff = makeData({ plan: { monthlyExtra: 5000 }, debts: [debt({ balance: 0 })], incomes: [income({ amount: 100000 })] });
  assert.equal(periodAmounts(paidOff, P1).extra, 0);
  const active = makeData({ plan: { monthlyExtra: 5000 }, debts: [debt({ balance: 10, payment: 3000 })], incomes: [income({ amount: 100000 })] });
  assert.deepEqual([periodAmounts(active, P1).extra, periodAmounts(active, P1).fixed, periodAmounts(active, P1).free], [5000, 3000, 92000]);
});

test('自由に使える額はマイナスになりうる。使った額・余りは、期間内の出費で数える', () => {
  resetIds();
  const data = makeData({
    incomes: [income({ amount: 100000 })],
    fixed: [fixed({ amount: 120000 })],
    spends: [spend({ date: '2026-11-24', amount: 999 }), spend({ date: '2026-11-25', amount: 1000 }), spend({ date: '2026-12-24', amount: 200 }), spend({ date: '2026-12-25', amount: 999 })],
  });
  const a = periodAmounts(data, P1);
  assert.deepEqual([a.free, a.spent, a.leftover], [-20000, 1200, -21200]);
});

test('何も入っていなければ、案内を出す判定になる', () => {
  assert.equal(isBudgetEmpty(makeData().budget), true);
  resetIds();
  assert.equal(isBudgetEmpty(makeData({ incomes: [income({ amount: 1 })] }).budget), false);
  assert.equal(isBudgetEmpty(makeData({ spends: [spend({ amount: 1 })] }).budget), false);
  assert.equal(periodAmounts(makeData(), P1).free, 0);
});

test('計算しても、元のデータは書き換わらない（書き換え禁止のデータで確認）', () => {
  const { data } = scenario();
  data.budget.spends.push(spend({ date: '2026-12-01', amount: 3000 }));
  deepFreeze(data);
  periodAmounts(data, P1);
  todayGuide(data, '2026-12-05');
  pendingSnapshots(data, '2027-03-01', NOW);
  whatIf(data, [{ type: 'extra', value: 20000 }], P1);
});

// ---------------- 4.3 今日の目安 ----------------

function guideData() {
  resetIds();
  return makeData({
    incomes: [income({ amount: 100000 })],
    spends: [spend({ date: '2026-12-01', amount: 3000 }), spend({ date: '2026-12-05', amount: 1500 }), spend({ date: '2026-12-10', amount: 7000 })],
  });
}

test('今日あと：今日（12/5）は残り20日。今日の目安＝(10万−今日より前の3,000)÷20、今日あと＝そこから今日の出費を引く', () => {
  const g = todayGuide(guideData(), '2026-12-05');
  assert.equal(g.daysLeft, 20); // 12/5〜12/24
  assert.equal(g.spentBefore, 3000);
  assert.equal(g.todayBudget, 4850); // 97,000 ÷ 20
  assert.equal(g.todaySpent, 1500);
  assert.equal(g.todayLeft, 3350);
  // 未来（12/10）の7,000 も、使った額と余りには入る（今日の目安には入れない）
  assert.deepEqual([g.free, g.spent, g.leftover], [100000, 11500, 88500]);
  assert.equal(g.tomorrowPerDay, 4657); // 88,500 ÷ 19 = 4657.89
});

test('今日の目安は、期間の最終日（残り1日）なら余り全部。明日以降の1日あたりは出さない', () => {
  const g = todayGuide(guideData(), '2026-12-24');
  assert.equal(g.daysLeft, 1);
  assert.equal(g.todayBudget, 88500); // 10万 − 今日より前の 3,000+1,500+7,000
  assert.equal(g.tomorrowPerDay, null);
});

test('期間の初日：残り30日。今日より前の出費はないので 10万 ÷ 30。明日以降は、先の出費も引いた余りを29日で割る', () => {
  const g = todayGuide(guideData(), '2026-11-25');
  assert.equal(g.daysLeft, 30);
  assert.equal(g.todayBudget, 3333); // 100,000 ÷ 30 = 3333.3
  assert.equal(g.todayLeft, 3333); // 今日（11/25）の出費はない
  assert.equal(g.tomorrowPerDay, 3051); // 余り 88,500（12/1・12/5・12/10 の出費は期間内なので入る）÷ 29 = 3051.7
});

test('使いすぎ：今日の目安は0で止まり、今日あとはマイナス。明日以降の1日あたりも0', () => {
  resetIds();
  const data = makeData({ incomes: [income({ amount: 10000 })], spends: [spend({ date: '2026-12-01', amount: 12000 }), spend({ date: '2026-12-05', amount: 500 })] });
  const g = todayGuide(data, '2026-12-05');
  assert.equal(g.todayBudget, 0); // (10,000 − 12,000) ÷ 20 はマイナス → 0
  assert.equal(g.todayLeft, -500);
  assert.equal(g.leftover, -2500);
  assert.equal(g.tomorrowPerDay, 0);
});

test('自由に使える額がマイナスなら、今日の目安は0', () => {
  resetIds();
  const data = makeData({ incomes: [income({ amount: 10000 })], fixed: [fixed({ amount: 50000 })] });
  const g = todayGuide(data, '2026-12-05');
  assert.deepEqual([g.free, g.todayBudget, g.todayLeft, g.tomorrowPerDay], [-40000, 0, 0, 0]);
});

test('今日が表示する期間の外なら null。期間を指定しなければ今日を含む期間', () => {
  const data = guideData();
  assert.equal(todayGuide(data, '2026-12-05', P2), null);
  assert.equal(todayGuide(data, '2026-12-25', P1), null);
  assert.equal(todayGuide(data, '2026-12-25').daysLeft, 31);
});

// ---------------- 4.4 履歴（スナップショット） ----------------

test('スナップショット：終了した期間（終了日 < 今日）だけ、since 以降に始まった期間を作る', () => {
  const { data } = scenario(); // since 2026-11-25
  const list = pendingSnapshots(data, '2027-02-10', NOW);
  assert.deepEqual(list.map((s) => [s.start, s.end]), [['2026-11-25', '2026-12-24'], ['2026-12-25', '2027-01-24']]); // 1/25〜2/24 は今の期間
  assert.deepEqual(list[0], {
    start: '2026-11-25',
    end: '2026-12-24',
    income: 880000,
    fixed: 230000,
    savings: 20000,
    extra: 5000,
    free: 625000,
    spent: 0,
    leftover: 625000,
    closedAt: NOW,
  });
  assert.deepEqual([list[1].income, list[1].fixed, list[1].free], [257000, 99500, 132500]);
});

test('スナップショット：期間の最終日はまだ終わっていない。翌日に確定する', () => {
  const { data } = scenario();
  assert.deepEqual(pendingSnapshots(data, '2026-12-24', NOW), []);
  assert.deepEqual(pendingSnapshots(data, '2026-12-25', NOW).map((s) => s.start), ['2026-11-25']);
});

test('スナップショット：期間の開始日が since より前の期間は作らない（since が期間の途中なら、次の期間から）', () => {
  const { data } = scenario();
  data.budget.settings.since = '2026-11-26';
  assert.deepEqual(pendingSnapshots(data, '2027-02-10', NOW).map((s) => s.start), ['2026-12-25']);
  data.budget.settings.since = '2026-12-25'; // 期間の初日ちょうど
  assert.deepEqual(pendingSnapshots(data, '2027-02-10', NOW).map((s) => s.start), ['2026-12-25']);
});

test('スナップショット：since がない・未来なら作らない。確定済みの期間は作り直さない', () => {
  const { data } = scenario();
  data.budget.settings.since = null;
  assert.deepEqual(pendingSnapshots(data, '2027-02-10', NOW), []);
  data.budget.settings.since = '2027-03-01';
  assert.deepEqual(pendingSnapshots(data, '2027-02-10', NOW), []);

  data.budget.settings.since = '2026-11-25';
  data.budget.snapshots['2026-11-25'] = { ...makeSnapshot(data, P1, NOW), income: 1, free: 1 }; // あとで設定を変えても、確定した値は変わらない
  assert.deepEqual(pendingSnapshots(data, '2027-02-10', NOW).map((s) => s.start), ['2026-12-25']);
  assert.equal(data.budget.snapshots['2026-11-25'].income, 1);
});

test('スナップショット：出費・上書きも反映する。しばらく開かなかった期間も、まとめて確定できる', () => {
  const { data, bonus } = scenario();
  data.budget.spends.push(spend({ date: '2026-12-01', amount: 3000 }), spend({ date: '2026-12-31', amount: 500 }));
  data.budget.overrides[P1.key] = { income: { [bonus.id]: 550000 }, fixed: {}, uses: {} };
  const [s1, s2] = pendingSnapshots(data, '2027-06-01', NOW);
  assert.deepEqual([s1.income, s1.spent, s1.leftover], [830000, 3000, 625000 - 50000 - 3000]);
  assert.deepEqual([s2.spent, s2.leftover], [500, 132500 - 500]);
  assert.equal(pendingSnapshots(data, '2027-06-01', NOW).length, 6); // 11/25 から 5/24 までの6期間（今の期間 5/25〜6/24 は含まない）
});

test('スナップショット：since が大昔でも、新しい方から600期間までで止まる（古い期間は作らない）', () => {
  const { data } = scenario();
  data.budget.settings.since = '1900-01-01';
  const list = pendingSnapshots(data, '2026-12-25', NOW);
  assert.equal(list.length, 600);
  assert.equal(list.at(-1).start, '2026-11-25'); // 直近に終わった期間
  assert.ok(list[0].start < list[1].start); // 古い順
});

test('日付の端（1900年・2200年）でも、期間の計算が止まらない', () => {
  const lo = periodOf(S(), '1900-01-01'); // 前の期間は、1899年にはみ出す
  assert.deepEqual([lo.start, lo.end], ['1899-12-25', '1900-01-24']);
  const hi = periodOf(S(), '2200-12-31'); // 次の期間は、2201年にはみ出す
  assert.ok(hi.start <= '2200-12-31' && hi.end >= '2200-12-31' && hi.end.startsWith('2201-'));
});

test('確定した期間の出費を直すと、使った額と余りだけが作り直される（収入・固定費・自由に使える額は確定のまま）', () => {
  const { data } = scenario();
  for (const s of pendingSnapshots(data, '2027-02-10', NOW)) data.budget.snapshots[s.start] = s; // P1・P2 を確定
  assert.deepEqual(syncSnapshotSpent(data), []); // 出費がなければ何も変わらない
  const a = spend({ date: '2026-12-01', amount: 3000 });
  const b = spend({ date: '2026-12-25', amount: 500 }); // P2 の初日
  const open = spend({ date: '2027-02-01', amount: 999 }); // 今の期間（未確定）は対象外
  data.budget.spends.push(a, b, open);
  const [s1, s2, ...rest] = syncSnapshotSpent(data);
  assert.equal(rest.length, 0);
  assert.deepEqual([s1.start, s1.spent, s1.leftover], ['2026-11-25', 3000, 625000 - 3000]);
  assert.deepEqual([s2.start, s2.spent, s2.leftover], ['2026-12-25', 500, 132500 - 500]);
  for (const [s, before] of [[s1, data.budget.snapshots['2026-11-25']], [s2, data.budget.snapshots['2026-12-25']]]) {
    assert.deepEqual([s.income, s.fixed, s.savings, s.extra, s.free, s.closedAt], [before.income, before.fixed, before.savings, before.extra, before.free, before.closedAt]);
  }
  assert.equal(data.budget.snapshots['2026-11-25'].spent, 0); // data は書き換えない
  for (const s of [s1, s2]) data.budget.snapshots[s.start] = s;
  assert.deepEqual(syncSnapshotSpent(data), []); // 保存したあとは、もう変わらない

  a.date = '2026-12-24'; // 期間の最終日に日付を変える → P1 のまま
  a.amount = 4000;
  b.date = '2026-12-24'; // P2 から P1 へ移す → 2つの期間が両方変わる
  const moved = syncSnapshotSpent(data);
  assert.deepEqual(moved.map((s) => [s.start, s.spent, s.leftover]), [['2026-11-25', 4500, 625000 - 4500], ['2026-12-25', 0, 132500]]);
  data.budget.spends.length = 0; // 全部消す → 0 に戻る
  for (const s of moved) data.budget.snapshots[s.start] = s;
  assert.deepEqual(syncSnapshotSpent(data).map((s) => [s.start, s.spent, s.leftover]), [['2026-11-25', 0, 625000]]);
});

test('出費の同期：確定した期間がなければ空。期間の外の出費は、どの期間にも入れない。大量でも速い', () => {
  const { data } = scenario();
  data.budget.spends.push(spend({ date: '2026-12-01', amount: 1 }));
  assert.deepEqual(syncSnapshotSpent(data), []); // 確定した期間がまだない
  data.budget.spends.length = 0;
  const snap = makeSnapshot(data, P1, NOW); // 出費なしで確定
  data.budget.snapshots[P1.key] = snap;
  data.budget.spends.push(spend({ date: '2026-11-24', amount: 7 }), spend({ date: '2026-12-25', amount: 9 })); // P1 の前日と翌日
  assert.deepEqual(syncSnapshotSpent(data), []);
  deepFreeze(data);
  syncSnapshotSpent(data); // 書き換え禁止でも動く
  const big = scenario().data;
  for (let i = 0, p = P1; i < 600; i += 1, p = shiftPeriod(S(), p, -1)) {
    big.budget.snapshots[p.key] = { ...snap, start: p.start, end: p.end, spent: 0, leftover: snap.free };
  }
  for (let i = 0; i < 20000; i += 1) big.budget.spends.push(spend({ date: addDays('2026-11-25', -(i % 3000)), amount: 1 }));
  const t0 = performance.now();
  const out = syncSnapshotSpent(big);
  const ms = performance.now() - t0;
  assert.ok(out.length > 0, '出費のある期間が更新される');
  assert.ok(ms < 500, `600期間×出費20000件の同期に ${Math.round(ms)}ms かかった`);
});

// ---------------- 出費の一覧・カテゴリ別（画面用のまとめ） ----------------

function spendListData() {
  resetIds();
  return makeData({
    spends: [
      spend({ id: 'a', date: '2026-12-02', amount: 1000, category: 'food' }),
      spend({ id: 'b', date: '2026-12-05', amount: 300, category: 'food' }),
      spend({ id: 'c', date: '2026-12-02', amount: 500, category: '' }),
      spend({ id: 'd', date: '2026-12-05', amount: 2000, category: 'fun' }),
      spend({ id: 'e', date: '2026-12-05', amount: 700, category: 'food' }),
      spend({ id: 'x', date: '2026-11-24', amount: 9999, category: 'food' }), // P1 の前日（入らない）
      spend({ id: 'y', date: '2026-12-25', amount: 9999, category: 'food' }), // P1 の翌日（入らない）
      spend({ id: 'z', date: '2026-11-25', amount: 40, category: 'daily' }), // P1 の初日（入る）
    ],
  });
}

test('出費の一覧：日ごとにまとめる。新しい日が先、同じ日はあとから記録したものが先。日の合計と件数つき', () => {
  const r = spendsByDay(spendListData().budget, P1);
  assert.deepEqual(r.days.map((d) => [d.date, d.total, d.count, d.items.map((s) => s.id)]), [
    ['2026-12-05', 3000, 3, ['e', 'd', 'b']], // 700 + 2000 + 300
    ['2026-12-02', 1500, 2, ['c', 'a']], // 500 + 1000
    ['2026-11-25', 40, 1, ['z']],
  ]);
  assert.deepEqual([r.count, r.shown], [6, 6]); // 期間の外の2件は数えない
});

test('出費の一覧：limit 件で打ち切る。日の合計は、打ち切られた分も含む1日の全部', () => {
  const r = spendsByDay(spendListData().budget, P1, 4);
  assert.deepEqual([r.count, r.shown], [6, 4]);
  assert.deepEqual(r.days.map((d) => [d.date, d.total, d.count, d.items.length]), [
    ['2026-12-05', 3000, 3, 3],
    ['2026-12-02', 1500, 2, 1], // 2件のうち1件だけ見せる。合計は 1,500円のまま
  ]);
  const none = spendsByDay(spendListData().budget, P1, 0);
  assert.deepEqual([none.days.length, none.count, none.shown], [0, 6, 0]); // 見せる件数が0なら、日も出さない
});

test('出費の一覧：出費がなければ空。出費の日付が同じなら、同じ日の中の順序は登録順の逆', () => {
  resetIds();
  assert.deepEqual(spendsByDay(makeData().budget, P1), { days: [], count: 0, shown: 0 });
  const data = makeData({ spends: [spend({ id: '1', date: '2026-12-05', amount: 1 }), spend({ id: '2', date: '2026-12-05', amount: 2 }), spend({ id: '3', date: '2026-12-05', amount: 3 })] });
  assert.deepEqual(spendsByDay(data.budget, P1).days[0].items.map((s) => s.id), ['3', '2', '1']);
});

test('カテゴリ別：多い順。カテゴリなしは「カテゴリなし」。期間の外は数えない。ratio は最大を1とした割合', () => {
  const r = spendsByCategory(spendListData().budget, P1);
  // 食費 1000+300+700=2000、娯楽 2000、カテゴリなし 500、日用品 40
  assert.deepEqual(r.rows.map((x) => [x.key, x.label, x.total, x.count]), [
    ['food', '食費', 2000, 3], // 同額（娯楽と2,000円）は、カテゴリの並び順（食費が先）
    ['fun', '娯楽', 2000, 1],
    ['', 'カテゴリなし', 500, 1],
    ['daily', '日用品', 40, 1],
  ]);
  assert.deepEqual([r.total, r.count], [4540, 6]);
  assert.deepEqual(r.rows.map((x) => x.ratio), [1, 1, 0.25, 0.02]); // 500/2000, 40/2000
});

test('カテゴリ別：知らないカテゴリは「カテゴリなし」に入れる。出費がなければ空', () => {
  resetIds();
  assert.deepEqual(spendsByCategory(makeData().budget, P1), { rows: [], total: 0, count: 0 });
  const data = makeData({ spends: [spend({ date: '2026-12-05', amount: 100, category: 'nothing' }), spend({ date: '2026-12-05', amount: 50, category: '' })] });
  const r = spendsByCategory(data.budget, P1);
  assert.deepEqual(r.rows.map((x) => [x.key, x.total, x.count]), [['', 150, 2]]);
  assert.equal(spendCategoryLabel('beauty'), '衣服・美容');
  assert.equal(spendCategoryLabel(''), 'カテゴリなし');
  assert.equal(spendCategoryLabel('nothing'), 'カテゴリなし');
});

test('出費のまとめ：データを書き換えない。出費20000件でも速い', () => {
  const data = spendListData();
  deepFreeze(data);
  spendsByDay(data.budget, P1);
  spendsByCategory(data.budget, P1);
  const big = spendListData();
  for (let i = 0; i < 20000; i += 1) big.budget.spends.push(spend({ date: addDays('2026-11-25', i % 30), amount: 1 + (i % 500), category: i % 3 ? 'food' : 'fun' }));
  const t0 = performance.now();
  const byDay = spendsByDay(big.budget, P1, 100);
  const byCat = spendsByCategory(big.budget, P1);
  const ms = performance.now() - t0;
  assert.equal(byDay.shown, 100);
  assert.ok(byCat.rows.length > 0);
  assert.ok(ms < 200, `出費20000件のまとめに ${Math.round(ms)}ms かかった`);
});

// ---------------- 4.4 履歴の画面用のまとめ ----------------

/** 確定した期間（架空）。余り＝自由に使える額 − 使った額 */
const snapOf = (start, end, free, spent, closedAt = '2026-11-25T00:00:00.000Z') => ({ start, end, income: free + 70000, fixed: 70000, savings: 0, extra: 0, free, spent, leftover: free - spent, closedAt });
const withSnaps = (list, settings = {}) => {
  resetIds();
  const data = makeData({ settings: { since: '2026-09-01', ...settings }, incomes: [income({ amount: 250000 })], fixed: [fixed({ amount: 70000 })] });
  for (const s of list) data.budget.snapshots[s.start] = s;
  return data;
};
// 給料日25日・今日 11/26 の期間：9/25〜10/22、10/23〜11/24（10/25 が日曜なので前倒し）、今の期間 11/25〜12/24
const H_A = snapOf('2026-09-25', '2026-10-22', 180000, 5000); // 余り 175,000
const H_B = snapOf('2026-10-23', '2026-11-24', 180000, 15000); // 余り 165,000

test('履歴：新しい期間が上。値は確定した値のまま。前の期間との差（使った額・余り）が付く', () => {
  const h = historyOf(withSnaps([H_A, H_B]), '2026-11-26');
  assert.deepEqual(h.rows.map((r) => r.start), ['2026-10-23', '2026-09-25']);
  assert.deepEqual(h.rows.map((r) => [r.free, r.spent, r.leftover, r.split]), [[180000, 15000, 165000, false], [180000, 5000, 175000, false]]);
  assert.deepEqual(h.rows[0].prev, { start: '2026-09-25', spentDiff: 10000, leftoverDiff: -10000 }); // 15,000−5,000 と 165,000−175,000
  assert.equal(h.rows[1].prev, null); // いちばん古い期間は、比べる相手がない
  assert.equal(h.splitCount, 0);
});

test('履歴：今の期間（途中）は rows に入れず、current に分ける。棒グラフにも入れない', () => {
  const data = withSnaps([H_A, H_B]);
  data.budget.spends.push(spend({ date: '2026-11-26', amount: 1200 }));
  const h = historyOf(data, '2026-11-26');
  assert.equal(h.rows.length, 2);
  // 今の期間：収入 250,000 − 固定費 70,000 ＝ 180,000、使った額 1,200、余り 178,800
  assert.deepEqual([h.current.period.start, h.current.free, h.current.spent, h.current.leftover], ['2026-11-25', 180000, 1200, 178800]);
  assert.deepEqual(h.chart.bars.map((b) => b.start), ['2026-09-25', '2026-10-23']);
});

test('履歴：棒グラフは余りで描く。マイナス（オーバー）がなければ、ゼロの線は下端（zero＝1）', () => {
  const h = historyOf(withSnaps([H_A, H_B]), '2026-11-26');
  assert.equal(h.chart.zero, 1);
  assert.deepEqual(h.chart.bars.map((b) => [b.up, b.down]), [[1, 0], [165000 / 175000, 0]]); // 最大の余り（175,000）が 1
});

test('履歴：余りがマイナスの期は、ゼロの線より下へ伸びる（zero＝上の長さ ÷ 全体の長さ）', () => {
  const over = snapOf('2026-10-23', '2026-11-24', 180000, 230000); // 余り −50,000
  const good = snapOf('2026-09-25', '2026-10-22', 180000, 80000); // 余り 100,000
  const h = historyOf(withSnaps([good, over]), '2026-11-26');
  assert.equal(h.chart.zero, 100000 / 150000); // 上 100,000・下 50,000 の合計 150,000
  assert.deepEqual(h.chart.bars.map((b) => [b.start, b.up, b.down]), [['2026-09-25', 100000 / 150000, 0], ['2026-10-23', 0, 50000 / 150000]]);
  assert.equal(h.rows[0].leftover, -50000); // 一覧の値は、そのまま
  assert.deepEqual([h.rows[0].prev.spentDiff, h.rows[0].prev.leftoverDiff], [150000, -150000]);
});

test('履歴：余りが全部0・履歴がない・今の期間だけのとき（棒なし）', () => {
  const zero = historyOf(withSnaps([snapOf('2026-10-23', '2026-11-24', 100, 100)]), '2026-11-26');
  assert.deepEqual([zero.chart.zero, zero.chart.bars[0].up, zero.chart.bars[0].down], [1, 0, 0]);
  const none = historyOf(withSnaps([]), '2026-11-26');
  assert.deepEqual([none.rows, none.chart.bars, none.chart.zero, none.splitCount], [[], [], 1, 0]);
  assert.equal(none.current.period.start, '2026-11-25');
});

test('履歴：棒グラフは最近12期間（古い順）。一覧には全部ある', () => {
  const list = [];
  for (let i = 0, p = shiftPeriod(S(), P1, -1); i < 15; i += 1, p = shiftPeriod(S(), p, -1)) list.push(snapOf(p.start, p.end, 100000, 1000 * (i + 1)));
  const h = historyOf(withSnaps(list, { since: '2020-01-01' }), '2026-11-26');
  assert.equal(h.rows.length, 15);
  assert.equal(h.chart.bars.length, 12);
  assert.deepEqual([h.chart.bars[0].start, h.chart.bars[11].start], [list[11].start, list[0].start]); // 古い→新しい
  assert.equal(historyOf(withSnaps(list, { since: '2020-01-01' }), '2026-11-26', 5).chart.bars.length, 5);
});

test('履歴：給料日を変えて重なった期間は、先に確定した方に「給料日を変える前の区切り」の印（split）。消さない。比べ・棒グラフには入れない', () => {
  // 給料日25日 → 10日に変更（前倒しなし）。今日 11/26 の今の期間は 11/10〜12/9
  const old1 = snapOf('2026-09-25', '2026-10-22', 180000, 5000, '2026-10-23T00:00:00.000Z');
  const old2 = snapOf('2026-10-23', '2026-11-24', 180000, 15000, '2026-11-25T00:00:00.000Z');
  const new1 = snapOf('2026-09-10', '2026-10-09', 180000, 7000, '2026-11-26T00:00:00.000Z'); // 変更後に、新しい区切りで確定した分
  const new2 = snapOf('2026-10-10', '2026-11-09', 180000, 9000, '2026-11-26T00:00:00.000Z');
  const data = withSnaps([old1, old2, new1, new2], { payday: 10, shiftEarly: false });
  const h = historyOf(data, '2026-11-26');
  assert.deepEqual(h.rows.map((r) => [r.start, r.split]), [['2026-10-23', true], ['2026-10-10', false], ['2026-09-25', true], ['2026-09-10', false]]); // 開始日順にそのまま並ぶ
  assert.equal(h.splitCount, 2);
  assert.deepEqual(h.rows.map((r) => r.prev && r.prev.start), [null, '2026-09-10', null, null]); // split の行は比べない。new2 は new1（split でない前の期間）と比べる
  assert.deepEqual([h.rows[1].prev.spentDiff, h.rows[1].prev.leftoverDiff], [2000, -2000]);
  assert.deepEqual(h.chart.bars.map((b) => b.start), ['2026-09-10', '2026-10-10']); // 棒グラフには split を入れない
  assert.deepEqual(h.rows.map((r) => r.spent), [15000, 9000, 5000, 7000]); // 確定した値は、そのまま
  assert.equal(Object.keys(data.budget.snapshots).length, 4); // 消さない・作り直さない
});

test('履歴：今の期間と重なる確定済みの期間も split（新しい区切りの履歴がまだないとき）', () => {
  const old2 = snapOf('2026-10-23', '2026-11-24', 180000, 15000, '2026-11-25T00:00:00.000Z'); // 今の期間 11/10〜12/9 と重なる
  const h = historyOf(withSnaps([old2], { payday: 10, shiftEarly: false }), '2026-11-26');
  assert.deepEqual(h.rows.map((r) => [r.start, r.split]), [['2026-10-23', true]]);
  assert.deepEqual(h.chart.bars, []);
  const same = historyOf(withSnaps([old2]), '2026-11-26'); // 給料日が同じなら、今の期間（11/25〜）とは重ならない
  assert.equal(same.rows[0].split, false);
});

test('出費の同期：期間が重なっていても、その日を含む期間のすべてに出費を数える（確定した値が書き換わらない）', () => {
  // 履歴の split のテストと同じ4期間。出費は、各期間の合計が確定した値と合うように置く
  const old1 = snapOf('2026-09-25', '2026-10-22', 180000, 5000, '2026-10-23T00:00:00.000Z'); // 2,000 + 3,000
  const old2 = snapOf('2026-10-23', '2026-11-24', 180000, 9000, '2026-11-25T00:00:00.000Z'); // 4,000 + 5,000
  const new1 = snapOf('2026-09-10', '2026-10-09', 180000, 3000, '2026-11-26T00:00:00.000Z'); // 1,000 + 2,000
  const new2 = snapOf('2026-10-10', '2026-11-09', 180000, 7000, '2026-11-26T00:00:00.000Z'); // 3,000 + 4,000
  const data = withSnaps([old1, old2, new1, new2], { payday: 10, shiftEarly: false });
  data.budget.spends.push(
    spend({ date: '2026-09-12', amount: 1000 }), // new1 だけ
    spend({ date: '2026-09-28', amount: 2000 }), // old1 と new1
    spend({ date: '2026-10-15', amount: 3000 }), // old1 と new2
    spend({ date: '2026-10-30', amount: 4000 }), // old2 と new2
    spend({ date: '2026-11-12', amount: 5000 }), // old2 だけ（new2 は 11/9 まで）
    spend({ date: '2026-12-01', amount: 9999 }), // どの期間にも入らない
  );
  assert.deepEqual(syncSnapshotSpent(data), []); // 全部、確定した値のまま
  data.budget.spends.push(spend({ date: '2026-10-25', amount: 100 })); // old2 と new2 の重なり（10/23〜11/9）
  assert.deepEqual(syncSnapshotSpent(data).map((s) => [s.start, s.spent, s.leftover]), [['2026-10-10', 7100, 172900], ['2026-10-23', 9100, 170900]]);
});

test('履歴：同じ時刻に確定した重なりでも止まらない（開始日が早い方に印）。データは書き換えない。600期間でも速い', () => {
  const a = snapOf('2026-10-01', '2026-10-31', 1, 0, 'T');
  const b = snapOf('2026-10-20', '2026-11-19', 1, 0, 'T');
  assert.deepEqual(historyOf(withSnaps([a, b]), '2026-11-26').rows.map((r) => [r.start, r.split]), [['2026-10-20', false], ['2026-10-01', true]]);
  const data = deepFreeze(withSnaps([H_A, H_B]));
  historyOf(data, '2026-11-26'); // 書き換え禁止でも動く
  const list = [];
  for (let i = 0, p = shiftPeriod(S(), P1, -1); i < 600; i += 1, p = shiftPeriod(S(), p, -1)) list.push(snapOf(p.start, p.end, 100000, i % 7 === 0 ? 120000 : 50000));
  const big = withSnaps(list, { since: '1990-01-01' });
  const t0 = performance.now();
  const h = historyOf(big, '2026-11-26');
  const ms = performance.now() - t0;
  assert.equal(h.rows.length, 600);
  assert.ok(ms < 200, `履歴600期間のまとめに ${Math.round(ms)}ms かかった`);
});

// ---------------- 7. 完済ナビとの連携（提案画面の目安） ----------------

test('提案の目安：上乗せの前の自由に使える額（今の期間）。毎月の余剰金がそれ以下なら、超えていない', () => {
  const { data } = scenario(); // 今の期間 P1：自由に使える額 625,000（上乗せ 5,000 を引いたあと）→ 上乗せの前は 630,000
  const g = extraGuide(data, '2026-11-26');
  assert.deepEqual([g.period.start, g.free, g.extra, g.negative, g.over, g.overBy], ['2026-11-25', 630000, 5000, false, false, 0]);
  data.plan.monthlyExtra = 630000; // ちょうど同じ額は、超えていない
  assert.equal(extraGuide(data, '2026-11-26').over, false);
});

test('提案の目安：毎月の余剰金が目安を超えたら over。超えた額も出る', () => {
  const { data } = scenario();
  data.plan.monthlyExtra = 700000;
  const g = extraGuide(data, '2026-11-26');
  assert.deepEqual([g.free, g.extra, g.over, g.overBy], [630000, 700000, true, 70000]); // 700,000 − 630,000
});

test('提案の目安：上乗せの前でもマイナスなら negative。余剰金が0でなければ、全額が超えている', () => {
  resetIds();
  const data = makeData({ debts: [debt({ payment: 10000 })], incomes: [income({ amount: 100000 })], fixed: [fixed({ amount: 150000 })] }); // 100,000 − 150,000 − 返済 10,000 ＝ −60,000
  const g0 = extraGuide(data, '2026-11-26');
  assert.deepEqual([g0.free, g0.negative, g0.over, g0.overBy], [-60000, true, false, 0]); // 余剰金0なら、超えてはいない
  data.plan.monthlyExtra = 10000;
  const g1 = extraGuide(data, '2026-11-26');
  assert.deepEqual([g1.negative, g1.over, g1.overBy], [true, true, 10000]);
});

test('提案の目安：家計に何も入れていなければ null（目安を出さない）。出費だけでも出す。データは書き換えない', () => {
  resetIds();
  assert.equal(extraGuide(makeData({ debts: [debt()], plan: { monthlyExtra: 5000 } }), '2026-11-26'), null);
  const onlySpend = makeData({ debts: [debt({ payment: 10000 })], plan: { monthlyExtra: 5000 }, spends: [spend({ date: '2026-11-26', amount: 100 })] });
  assert.equal(extraGuide(onlySpend, '2026-11-26').free, -10000); // 収入なし・返済 10,000 だけ
  extraGuide(deepFreeze(scenario().data), '2026-11-26');
});

// ---------------- 4.5 「もしも」 ----------------

test('もしも：金額を変える（家賃 8万 → 7万）。期あたり＋1万円、年あたりはその12倍', () => {
  const { data, rent } = scenario();
  const r = whatIf(data, [{ type: 'amount', target: 'fixed', id: rent.id, amount: 70000 }], P1);
  assert.deepEqual([r.base.free, r.changed.free], [625000, 635000]);
  assert.equal(r.perPeriod, 10000);
  assert.equal(r.perYear, 120000);
  assert.equal(r.plan, null);
});

test('もしも：項目をオフにする（昼食をやめる）。単価×回数の年の変化は、1年分の「祝日を除く平日」×単価', () => {
  const { data, lunch } = scenario();
  const r = whatIf(data, [{ type: 'off', target: 'fixed', id: lunch.id }], P1);
  assert.equal(r.perPeriod, 11000); // 500×22
  // 12期分は 2026-11-25〜2027-11-24 の365日。JavaScript の Date で1日ずつ数える
  let workdays = 0;
  for (let t = Date.UTC(2026, 10, 25); t <= Date.UTC(2027, 10, 24); t += 86400000) {
    const d = new Date(t);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && !isHoliday(d.toISOString().slice(0, 10))) workdays += 1;
  }
  assert.equal(r.perYear, 500 * workdays);
  assert.notEqual(r.perYear, r.perPeriod * 12); // 期ごとに回数が違うので、単純な12倍とはずれる
});

test('もしも：仮の項目を足す（収入・固定費）。同じ形の項目をそのまま足せる', () => {
  const { data } = scenario();
  const r1 = whatIf(data, [{ type: 'add', target: 'fixed', item: fixed({ name: 'テスト習い事', amount: 8000 }) }], P1);
  assert.equal(r1.perPeriod, -8000);
  assert.equal(r1.perYear, -96000);
  const r2 = whatIf(data, [{ type: 'add', target: 'income', item: income({ name: 'テスト副業', amount: 30000 }) }, { type: 'add', target: 'fixed', item: fixed({ amount: 8000 }) }], P1);
  assert.equal(r2.perPeriod, 22000); // 変更は重ねて適用される
  assert.equal(r2.changed.free - r2.base.free, 22000);
});

test('もしも：賞与をオフにすると、賞与のない期では期あたり0でも、年あたりには年2回分が入る', () => {
  const { data, bonus } = scenario();
  const off = [{ type: 'off', target: 'income', id: bonus.id }];
  const r1 = whatIf(data, off, P1); // 賞与のある期（12/10）
  assert.deepEqual([r1.perPeriod, r1.perYear], [-600000, -1200000]); // 2026/12/10 と 2027/6/10
  const r2 = whatIf(data, off, P2); // 賞与のない期
  assert.deepEqual([r2.perPeriod, r2.perYear], [0, -1200000]); // 2027/6/10 と 2027/12/10
});

test('もしも：返済への上乗せを変える（5,000 → 20,000）。自由に使える額が減り、完済と利息が改善する', () => {
  resetIds();
  const a = debt({ name: 'テストA社', balance: 300000, rate: 15, payment: 15000 });
  const b = debt({ name: 'テストB社', balance: 200000, rate: 18, payment: 12000 });
  const data = makeData({ debts: [a, b], plan: { monthlyExtra: 5000 }, incomes: [income({ amount: 300000 })] });
  const r = whatIf(data, [{ type: 'extra', value: 20000 }], P1);
  assert.equal(r.base.extra, 5000);
  assert.equal(r.changed.extra, 20000);
  assert.equal(r.perPeriod, -15000);
  assert.equal(r.perYear, -180000);
  assert.deepEqual([r.plan.before.monthlyExtra, r.plan.after.monthlyExtra], [5000, 20000]);
  assert.equal(r.plan.before.finished && r.plan.after.finished, true);
  assert.ok(r.plan.after.months < r.plan.before.months, `${r.plan.after.months} < ${r.plan.before.months}`);
  assert.equal(r.plan.monthsSaved, r.plan.before.months - r.plan.after.months);
  assert.ok(r.plan.interestSaved > 0);
  assert.equal(r.plan.interestSaved, r.plan.before.totalInterest - r.plan.after.totalInterest);
});

test('もしも：返済中の会社がなければ、上乗せを変えても自由に使える額は変わらず、完済の比較も出ない', () => {
  resetIds();
  const data = makeData({ plan: { monthlyExtra: 5000 }, incomes: [income({ amount: 100000 })] });
  const r = whatIf(data, [{ type: 'extra', value: 30000 }], P1);
  assert.deepEqual([r.perPeriod, r.perYear, r.plan], [0, 0, null]);
});

test('もしも：見つからない項目の変更は無視する。変更なしなら差は0', () => {
  const { data } = scenario();
  const r = whatIf(data, [{ type: 'off', target: 'fixed', id: 'nothing' }, { type: 'amount', target: 'income', id: 'nothing', amount: 1 }], P1);
  assert.deepEqual([r.perPeriod, r.perYear], [0, 0]);
  assert.equal(whatIf(data, [], P1).perPeriod, 0);
  assert.equal(whatIf(data, undefined, P1).perPeriod, 0);
});

test('もしも：実データは変わらない（返済・金額・オフ・追加のあとも元のまま）', () => {
  const { data, rent, lunch } = scenario();
  const before = JSON.stringify(data);
  whatIf(data, [{ type: 'amount', target: 'fixed', id: rent.id, amount: 1 }, { type: 'off', target: 'fixed', id: lunch.id }, { type: 'add', target: 'fixed', item: fixed({ amount: 5 }) }, { type: 'extra', value: 99999 }], P1);
  assert.equal(JSON.stringify(data), before);
});

// ---------------- そのほか ----------------

test('usesCount：曜日の指定がなくても壊れない', () => {
  assert.equal(usesCount({ uses: undefined }, P1), 22); // 初期値（月〜金・祝日を除く）
  assert.equal(usesCount({ uses: { by: 'count', count: -3 } }, P1), 0);
});

test('金額に変な値が入っていても、計算は止まらない（0として扱う）', () => {
  resetIds();
  const data = makeData({ incomes: [income({ amount: 'abc' }), income({ amount: 1000.9 })], fixed: [fixed({ amount: undefined })] });
  const a = periodAmounts(data, P1);
  assert.deepEqual([a.income, a.fixed], [1000, 0]);
});
