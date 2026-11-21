// 保存データの検証（sanitize）とバックアップのテスト。実行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_FORMAT, BUDGET_LIMITS, emptyBudget, emptyData, loadData, makeBackup, readBackup, saveData, sanitizeBudget, sanitizeData } from '../js/storage.js';
import { FIXED_CATEGORIES, SPEND_CATEGORIES } from '../js/budget.js';
import { debt, deepFreeze, entry, fixed, income, NOW, resetIds, scenario, spend } from './fixtures.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));

/** 保存・バックアップに載るものをすべて入れたデータ */
function fullData() {
  const { data, bonus, rent, lunch } = scenario();
  data.budget.spends.push(spend({ date: '2026-12-01', amount: 3000, category: 'food', memo: 'テストの昼' }), spend({ date: '2026-12-02', amount: 800 }));
  data.budget.overrides['2026-11-25'] = { income: { [bonus.id]: 550000 }, fixed: { [rent.id]: 82000 }, uses: { [lunch.id]: 20 } };
  data.budget.snapshots['2026-10-23'] = { start: '2026-10-23', end: '2026-11-24', income: 250000, fixed: 100000, savings: 20000, extra: 5000, free: 125000, spent: 130000, leftover: -5000, closedAt: NOW };
  data.records = [];
  return data;
}

// ---------------- 初期値 ----------------

test('初期値：家計（budget）は空で、給料日25日・前倒しON・貯金0円', () => {
  assert.deepEqual(emptyBudget(), {
    settings: { payday: 25, shiftEarly: true, savings: { mode: 'amount', value: 0 }, since: null },
    incomes: [],
    fixed: [],
    entries: [],
    overrides: {},
    spends: [],
    snapshots: {},
  });
  assert.deepEqual(emptyData().budget, emptyBudget());
  assert.notEqual(emptyBudget(), emptyBudget()); // 毎回新しいもの（使い回さない）
});

test('budget がない古い保存データを読むと、家計は初期値になり、借入のデータはそのまま', () => {
  resetIds();
  const old = { version: 1, debts: [debt({ name: 'テストA社' })], records: [], plan: { lumpSum: 1000, monthlyExtra: 2000 }, meta: { createdAt: NOW, updatedAt: NOW, lastBackupAt: null } };
  const d = sanitizeData(old);
  assert.deepEqual(d.budget, emptyBudget());
  assert.equal(d.debts.length, 1);
  assert.deepEqual(d.plan, { lumpSum: 1000, monthlyExtra: 2000 });
});

// ---------------- sanitize：正しいものは変えない ----------------

test('正しい家計のデータは、そのまま通る（往復しても同じ）', () => {
  const data = fullData();
  const once = sanitizeData(clone(data));
  assert.deepEqual(once.budget, data.budget);
  assert.deepEqual(sanitizeData(clone(once)).budget, once.budget); // 2回通しても同じ
});

test('sanitize は、渡されたデータを書き換えない', () => {
  const data = deepFreeze(fullData());
  sanitizeData(data);
  sanitizeBudget(data.budget, NOW);
});

// ---------------- sanitize：壊れた行は捨てる ----------------

test('壊れた行は捨てる（収入・固定費）', () => {
  resetIds();
  const ok = income({ amount: 1000 });
  const b = sanitizeBudget(
    {
      incomes: [
        ok,
        null,
        'x',
        42,
        [],
        income({ name: '' }),
        income({ name: '   ' }),
        income({ name: 123 }),
        income({ amount: -1 }),
        income({ amount: 1.5 }),
        income({ amount: 'abc' }),
        income({ amount: NaN }),
        income({ amount: null }),
        income({ amount: undefined }),
        income({ amount: BUDGET_LIMITS.yen + 1 }),
        income({ kind: 'months', months: [] }), // 支給の月がない
        income({ kind: 'months', months: [0, 13, 'x'] }), // 使える月がない
      ],
      fixed: [fixed({ amount: 500 }), undefined, fixed({ amount: -5 }), fixed({ name: '' }), fixed({ amount: {} })],
    },
    NOW,
  );
  assert.deepEqual(b.incomes.map((i) => i.id), [ok.id]);
  assert.equal(b.fixed.length, 1);
});

test('壊れた行は捨てる（変わる収入・出費は、日付が実在しないものも捨てる）', () => {
  resetIds();
  const b = sanitizeBudget(
    {
      entries: [entry({ date: '2026-12-05', amount: 100 }), entry({ date: '2026-02-30' }), entry({ date: '2026/12/05' }), entry({ date: 20261205 }), entry({ amount: -1 }), entry({ amount: '' }), null],
      spends: [spend({ amount: 100 }), spend({ date: '2026-13-01', amount: 1 }), spend({ date: '', amount: 1 }), spend({ amount: 0.5 }), spend({ amount: Infinity }), 'x'],
    },
    NOW,
  );
  assert.equal(b.entries.length, 1);
  assert.equal(b.spends.length, 1);
  assert.equal(b.spends[0].amount, 100);
});

test('配列でないものが来ても止まらない', () => {
  for (const bad of [null, undefined, 'x', 5, [], { incomes: 'x', fixed: 3, entries: {}, spends: null, overrides: [], snapshots: 'x', settings: 'x' }]) {
    assert.deepEqual(sanitizeBudget(bad, NOW), emptyBudget());
  }
});

// ---------------- sanitize：直せるものは直す ----------------

test('設定：給料日・前倒し・貯金・since。範囲外は初期値に戻す', () => {
  const s = (settings) => sanitizeBudget({ settings }, NOW).settings;
  assert.deepEqual(s({ payday: 0, shiftEarly: false, savings: { mode: 'percent', value: 10 }, since: '2026-11-25' }), { payday: 0, shiftEarly: false, savings: { mode: 'percent', value: 10 }, since: '2026-11-25' });
  assert.equal(s({ payday: 31 }).payday, 31);
  assert.equal(s({ payday: 32 }).payday, 25);
  assert.equal(s({ payday: -1 }).payday, 25);
  assert.equal(s({ payday: 15.5 }).payday, 25);
  assert.equal(s({ payday: 'x' }).payday, 25);
  assert.equal(s({ payday: '10' }).payday, 10); // 数字の文字列は読める
  assert.equal(s({ shiftEarly: 'no' }).shiftEarly, true);
  assert.equal(s({ since: '2026-02-30' }).since, null);
  assert.equal(s({ since: '2026-11-25T00:00' }).since, null);
  assert.deepEqual(s({ savings: { mode: 'percent', value: 101 } }).savings, { mode: 'percent', value: 0 }); // 100%を超える
  assert.deepEqual(s({ savings: { mode: 'percent', value: 100 } }).savings, { mode: 'percent', value: 100 });
  assert.deepEqual(s({ savings: { mode: 'amount', value: 123456 } }).savings, { mode: 'amount', value: 123456 });
  assert.deepEqual(s({ savings: { mode: 'weird', value: 5 } }).savings, { mode: 'amount', value: 5 });
  assert.deepEqual(s({ savings: { mode: 'amount', value: -5 } }).savings, { mode: 'amount', value: 0 });
});

test('項目の種類・カテゴリ・間隔・月・曜日。使えない値は初期値に直る', () => {
  resetIds();
  const b = sanitizeBudget(
    {
      incomes: [income({ kind: 'weird', amount: 1, months: [12, 6, 6, 99, '3'], day: 40 })],
      fixed: [
        fixed({ amount: 1, category: 'nope', kind: 'weird', every: 5, dueMonth: 13, dueDay: 0, mode: 'weird', uses: { by: 'weird', days: [1, 1, 9, 'x', 6], skipHolidays: 'yes', count: 400 } }),
        fixed({ amount: 2, kind: 'uses', uses: undefined }),
        fixed({ amount: 3, kind: 'uses', uses: { by: 'count', days: [], skipHolidays: false, count: 4 } }),
        fixed({ amount: 4, kind: 'periodic', every: 6, dueMonth: 11, dueDay: 30, mode: 'spread', category: 'insurance' }),
      ],
    },
    NOW,
  );
  const i = b.incomes[0];
  assert.deepEqual([i.kind, i.months, i.day], ['monthly', [3, 6, 12], 1]);
  const [f1, f2, f3, f4] = b.fixed;
  assert.deepEqual([f1.category, f1.kind, f1.every, f1.dueMonth, f1.dueDay, f1.mode], ['other', 'monthly', 12, 1, 1, 'lump']);
  assert.deepEqual(f1.uses, { by: 'weekdays', days: [1, 6], skipHolidays: true, count: 0 });
  assert.deepEqual(f2.uses, { by: 'weekdays', days: [1, 2, 3, 4, 5], skipHolidays: true, count: 0 }); // 月〜金・祝日を除く
  assert.deepEqual(f3.uses, { by: 'count', days: [], skipHolidays: false, count: 4 });
  assert.deepEqual([f4.kind, f4.every, f4.dueMonth, f4.dueDay, f4.mode, f4.category], ['periodic', 6, 11, 30, 'spread', 'insurance']);
});

test('カテゴリ：固定費は一覧にあるものだけ（なければ「その他」）、出費は一覧にあるものだけ（なければ「なし」）', () => {
  resetIds();
  const b = sanitizeBudget(
    {
      fixed: FIXED_CATEGORIES.map((c) => fixed({ amount: 1, category: c.key })).concat([fixed({ amount: 1, category: '住居' })]),
      spends: SPEND_CATEGORIES.map((c) => spend({ amount: 1, category: c.key })).concat([spend({ amount: 1, category: 'x' }), spend({ amount: 1, category: undefined }), spend({ amount: 1 })]),
    },
    NOW,
  );
  assert.deepEqual(b.fixed.map((f) => f.category), [...FIXED_CATEGORIES.map((c) => c.key), 'other']);
  assert.deepEqual(b.spends.map((s) => s.category), [...SPEND_CATEGORIES.map((c) => c.key), '', '', '']);
});

test('文字：前後の空白を取り、長さを制限する（絵文字を途中で切らない）', () => {
  resetIds();
  const b = sanitizeBudget(
    {
      incomes: [income({ name: '  テスト給与  ', amount: 1 }), income({ name: 'あ'.repeat(50), amount: 1 }), income({ name: '😀'.repeat(40), amount: 1 })],
      entries: [entry({ amount: 1, memo: 'メ'.repeat(150) }), entry({ amount: 1, memo: 5 })],
    },
    NOW,
  );
  assert.equal(b.incomes[0].name, 'テスト給与');
  assert.equal(b.incomes[1].name, 'あ'.repeat(30));
  assert.equal(b.incomes[2].name, '😀'.repeat(30)); // 30文字（サロゲートペアの途中で切れない）
  assert.equal(b.entries[0].memo, 'メ'.repeat(100));
  assert.equal(b.entries[1].memo, '');
  // HTML の記号は、保存では変えない（画面に出すときに esc() で無害にする）
  assert.equal(sanitizeBudget({ fixed: [fixed({ name: '<b>"A"&\'B\'</b>', amount: 1 })] }, NOW).fixed[0].name, '<b>"A"&\'B\'</b>');
});

test('id：使えない・重なった id は新しく振る（__proto__ も使わせない）', () => {
  resetIds();
  const b = sanitizeBudget(
    {
      incomes: [income({ id: 'same', amount: 1 }), income({ id: 'same', amount: 2 }), income({ id: 'bad id!', amount: 3 }), income({ id: '__proto__', amount: 4 }), income({ id: '', amount: 5 }), income({ id: 'a'.repeat(65), amount: 6 }), income({ id: 123, amount: 7 })],
    },
    NOW,
  );
  const ids = b.incomes.map((i) => i.id);
  assert.equal(ids[0], 'same');
  assert.equal(new Set(ids).size, 7);
  assert.ok(ids.slice(1).every((id) => id !== 'same' && id !== '__proto__' && /^[A-Za-z0-9_-]{1,64}$/.test(id)));
  assert.equal(Object.getPrototypeOf(b.incomes[3]), Object.prototype);
});

test('日時（createdAt など）が壊れていたら、読み込んだ時刻に直す', () => {
  resetIds();
  const b = sanitizeBudget({ incomes: [income({ amount: 1, createdAt: 'あした', updatedAt: undefined })], spends: [spend({ amount: 1, createdAt: 5 })] }, NOW);
  assert.equal(b.incomes[0].createdAt, NOW);
  assert.equal(b.incomes[0].updatedAt, NOW);
  assert.equal(b.spends[0].createdAt, NOW);
});

// ---------------- sanitize：上書きと履歴 ----------------

test('上書き：見つからない項目・形の違う値・実在しない期間キーは捨て、空になった期間は残さない', () => {
  resetIds();
  const inc = income({ amount: 1 });
  const fx = fixed({ amount: 1 });
  const uses = fixed({ amount: 1, kind: 'uses' });
  const b = sanitizeBudget(
    {
      incomes: [inc],
      fixed: [fx, uses],
      overrides: {
        '2026-11-25': { income: { [inc.id]: 5, ghost: 9, [fx.id]: 7 }, fixed: { [fx.id]: '6', [uses.id]: 1, [inc.id]: 3 }, uses: { [uses.id]: 20, [fx.id]: 2, ghost: 1 } },
        '2026-12-25': { income: { [inc.id]: -1 }, fixed: { [fx.id]: 1.5 }, uses: { [uses.id]: 400 } }, // どれも使えない → 期間ごと捨てる
        '2026-02-30': { income: { [inc.id]: 1 }, fixed: {}, uses: {} },
        '2027-01-25': 'x',
        '2027-02-25': null,
        '2027-03-25': { fixed: { [fx.id]: 0 } }, // 0円への上書きは有効。income・uses がなくてもよい
      },
    },
    NOW,
  );
  assert.deepEqual(b.overrides, {
    '2026-11-25': { income: { [inc.id]: 5 }, fixed: { [fx.id]: 6, [uses.id]: 1 }, uses: { [uses.id]: 20 } },
    '2027-03-25': { income: {}, fixed: { [fx.id]: 0 }, uses: {} },
  });
});

test('履歴：正しいものは通し、必要な数字が欠けた・期間が逆・日付が実在しないものは捨てる。マイナスの使えた額・余りは残す', () => {
  // 開始日（キー）から1か月後の前日までの、正しい履歴の1行
  const snap = (start, end, over = {}) => ({ start, end, income: 1, fixed: 2, savings: 3, extra: 4, free: -5, spent: 6, leftover: -11, closedAt: NOW, ...over });
  const ok = snap('2026-10-23', '2026-11-24');
  const b = sanitizeBudget(
    {
      snapshots: {
        '2026-10-23': ok,
        '2026-11-25': snap('ignored', '2026-12-24'), // start は、キーに合わせる
        '2026-12-25': snap('2026-12-25', '2026-12-01'), // 終了日が開始日より前
        '2027-01-25': snap('2027-01-25', '2027-02-30'), // 終了日が実在しない
        '2027-02-25': snap('2027-02-25', '2027-03-24', { income: undefined }),
        '2027-03-25': snap('2027-03-25', '2027-04-24', { spent: -1 }), // 使った額はマイナスにならない
        '2027-04-25': snap('2027-04-25', '2027-05-24', { free: 'x' }),
        '2027-05-25': snap('2027-05-25', '2027-06-24', { closedAt: 'broken' }), // 日時は直せる
        '2027-13-25': snap('2027-13-25', '2027-14-24'), // キーが実在しない
        '2027-06-25': null,
        '2027-07-25': 'x',
      },
    },
    NOW,
  );
  assert.deepEqual(Object.keys(b.snapshots), ['2026-10-23', '2026-11-25', '2027-05-25']);
  assert.deepEqual(b.snapshots['2026-10-23'], ok);
  assert.equal(b.snapshots['2026-11-25'].start, '2026-11-25');
  assert.equal(b.snapshots['2027-05-25'].closedAt, NOW);
});

// ---------------- sanitize：上限 ----------------

test('上限：収入・固定費は200件まで（先頭を残す）', () => {
  resetIds();
  const many = Array.from({ length: 250 }, (_, i) => income({ name: `テスト${i}`, amount: 1 }));
  const b = sanitizeBudget({ incomes: many, fixed: Array.from({ length: 250 }, () => fixed({ amount: 1 })) }, NOW);
  assert.equal(b.incomes.length, 200);
  assert.equal(b.incomes[0].name, 'テスト0');
  assert.equal(b.incomes[199].name, 'テスト199');
  assert.equal(b.fixed.length, 200);
});

test('上限：変わる収入は2000件、出費は20000件まで（記録は新しい方＝後ろを残す）。25000件でも速い', () => {
  resetIds();
  const entries = Array.from({ length: 2100 }, (_, i) => entry({ date: '2026-12-05', amount: i, memo: `${i}` }));
  const spends = Array.from({ length: 25000 }, (_, i) => spend({ date: '2026-12-05', amount: i % 5000, memo: `${i}` }));
  const t0 = performance.now();
  const b = sanitizeBudget({ entries, spends }, NOW);
  const ms = performance.now() - t0;
  assert.equal(b.entries.length, 2000);
  assert.equal(b.entries[0].memo, '100');
  assert.equal(b.entries.at(-1).memo, '2099');
  assert.equal(b.spends.length, 20000);
  assert.equal(b.spends[0].memo, '5000');
  assert.equal(b.spends.at(-1).memo, '24999');
  assert.ok(ms < 5000, `25,000件の検証に ${Math.round(ms)}ms かかった`);
});

test('上限：上書き・履歴は600期間まで（新しい期間を残す）', () => {
  resetIds();
  const inc = income({ amount: 1 });
  const overrides = {};
  const snapshots = {};
  const snap = (start, end) => ({ start, end, income: 1, fixed: 1, savings: 0, extra: 0, free: 0, spent: 0, leftover: 0, closedAt: NOW });
  for (let i = 0; i < 700; i += 1) {
    const y = 1980 + Math.floor(i / 12);
    const m = String((i % 12) + 1).padStart(2, '0');
    overrides[`${y}-${m}-25`] = { income: { [inc.id]: 1 }, fixed: {}, uses: {} };
    snapshots[`${y}-${m}-25`] = snap(`${y}-${m}-25`, `${y}-${m}-26`);
  }
  const b = sanitizeBudget({ incomes: [inc], overrides, snapshots }, NOW);
  assert.equal(Object.keys(b.overrides).length, 600);
  assert.equal(Object.keys(b.snapshots).length, 600);
  assert.ok(!('1980-01-25' in b.overrides) && '2037-12-25' in b.overrides); // 1980年1月が古い方から消え、最後の月は残る
});

test('金額の上限は10億円まで', () => {
  resetIds();
  const b = sanitizeBudget({ incomes: [income({ amount: BUDGET_LIMITS.yen }), income({ amount: BUDGET_LIMITS.yen + 1 })] }, NOW);
  assert.equal(b.incomes.length, 1);
});

// ---------------- バックアップ ----------------

test('バックアップ：format 2。家計を含み、ロックの設定・保存時の情報（meta）は含まない', () => {
  assert.equal(BACKUP_FORMAT, 2);
  const data = fullData();
  const obj = JSON.parse(makeBackup(data));
  assert.equal(obj.app, 'kanzai-navi');
  assert.equal(obj.format, 2);
  assert.deepEqual(Object.keys(obj.data).sort(), ['budget', 'debts', 'plan', 'records']);
  assert.deepEqual(obj.data.budget, data.budget);
  assert.ok(!/passcode|passkey|credential|lock|salt|hash/i.test(makeBackup(data).replace(/"app": "kanzai-navi"/, '')));
});

test('バックアップ：書き出して読み込むと、同じ家計・借入に戻る', () => {
  const data = fullData();
  data.debts = [debt({ name: 'テストA社' })];
  data.plan = { lumpSum: 30000, monthlyExtra: 5000 };
  const read = readBackup(makeBackup(data));
  assert.equal(read.format, 2); // 画面が「format 1 のファイルには家計が入っていない」と知らせるのに使う
  const back = read.data;
  assert.deepEqual(back.budget, data.budget);
  assert.deepEqual(back.debts, data.debts);
  assert.deepEqual(back.plan, data.plan);
});

test('バックアップ：format 1（家計なし）のファイルも読める。家計は初期値になる', () => {
  resetIds();
  const v1 = {
    app: 'kanzai-navi',
    format: 1,
    exportedAt: '2026-11-20T12:00:00.000Z',
    data: { debts: [debt({ name: 'テストA社', balance: 80000, payment: 5000 })], records: [], plan: { lumpSum: 0, monthlyExtra: 3000 } },
  };
  const r = readBackup(JSON.stringify(v1));
  assert.equal(r.format, 1);
  assert.equal(r.exportedAt, '2026-11-20T12:00:00.000Z');
  assert.equal(r.data.debts.length, 1);
  assert.equal(r.data.debts[0].name, 'テストA社');
  assert.equal(r.data.plan.monthlyExtra, 3000);
  assert.deepEqual(r.data.budget, emptyBudget());
});

test('バックアップ：format の数字がないファイルも読める（今までどおり）', () => {
  const r = readBackup(JSON.stringify({ app: 'kanzai-navi', data: { debts: [], records: [], plan: {} } }));
  assert.equal(r.format, 1); // 数字がなければ 1 とみなす
  assert.deepEqual(r.data.budget, emptyBudget());
});

test('バックアップ：新しい format（3以上）・別のアプリ・壊れたファイルは、わかる言葉のエラーにする', () => {
  assert.throws(() => readBackup(JSON.stringify({ app: 'kanzai-navi', format: 3, data: {} })), /新しいバージョン/);
  assert.throws(() => readBackup(JSON.stringify({ app: 'other', format: 2, data: {} })), /完済ナビのバックアップファイルではありません/);
  assert.throws(() => readBackup(JSON.stringify({ app: 'kanzai-navi', format: 2 })), /完済ナビのバックアップファイルではありません/);
  assert.throws(() => readBackup('これはJSONではない'), /読み取れませんでした/);
  assert.throws(() => readBackup('null'), /完済ナビのバックアップファイルではありません/);
});

test('バックアップ：format 2 でも、家計が壊れていれば直して読む（止まらない）', () => {
  const r = readBackup(JSON.stringify({ app: 'kanzai-navi', format: 2, data: { debts: [], records: [], plan: {}, budget: { incomes: 'x', spends: [{ amount: 'x' }], settings: { payday: 99 } } } }));
  assert.deepEqual(r.data.budget, emptyBudget());
});

// ---------------- 保存と読み込み（localStorage の代わりの入れ物で） ----------------

function withFakeStorage(fn) {
  const store = new Map();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      key: (i) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  try {
    return fn(store);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
}

test('保存して読み込むと、家計も同じに戻る', () => {
  withFakeStorage(() => {
    const data = fullData();
    saveData(data);
    assert.deepEqual(loadData().budget, data.budget);
  });
});

test('今まで保存されていたデータ（家計なし）を読んでも、そのまま使える', () => {
  withFakeStorage((store) => {
    resetIds();
    store.set('kanzai-navi:data', JSON.stringify({ version: 1, debts: [debt({ name: 'テストA社' })], records: [], plan: { lumpSum: 0, monthlyExtra: 0 }, meta: { createdAt: NOW, updatedAt: NOW, lastBackupAt: null } }));
    const d = loadData();
    assert.equal(d.debts[0].name, 'テストA社');
    assert.deepEqual(d.budget, emptyBudget());
  });
});
