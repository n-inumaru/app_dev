// 日付の道具のテスト。実行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, addMonths, daysInMonth, diffDays, fromDays, isLeapYear, isValidISO, parseISO, toDays, toISO, weekday } from '../js/dates.js';

test('実在する日付だけを正しいと判定する', () => {
  for (const ok of ['2026-11-21', '2028-02-29', '2000-02-29', '1900-01-01', '2026-12-31']) assert.equal(isValidISO(ok), true, ok);
  for (const ng of ['2026-02-30', '2027-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-11-00', '2026-11-31', '2026/11/21', '2026-1-1', '20261121', '', null, undefined, 20261121, '2026-11-21T00:00:00', ' 2026-11-21', '0000-01-01', '9999-12-31']) {
    assert.equal(isValidISO(ng), false, String(ng));
  }
});

test('うるう年と月の日数', () => {
  assert.deepEqual([2024, 2028, 2000].map(isLeapYear), [true, true, true]);
  assert.deepEqual([2026, 2100, 1900].map(isLeapYear), [false, false, false]);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2026, 11), 30);
  assert.equal(daysInMonth(2026, 12), 31);
});

test('parseISO と toISO は逆の関係', () => {
  assert.deepEqual(parseISO('2026-11-05'), { y: 2026, m: 11, d: 5 });
  assert.equal(parseISO('2026-02-30'), null);
  assert.equal(toISO(2026, 1, 5), '2026-01-05');
});

test('日数・曜日が、JavaScript の Date（UTC）と1970〜2100年の毎日で一致する', () => {
  let day = Date.UTC(1970, 0, 1);
  for (let n = 0; n <= 130 * 366; n += 1, day += 86400000) {
    const d = new Date(day);
    const iso = toISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    assert.equal(toDays(iso), n, iso);
    assert.equal(weekday(iso), d.getUTCDay(), iso);
    assert.equal(fromDays(n), iso);
  }
});

test('1970年より前でも、日数と曜日が合う', () => {
  assert.equal(toDays('1969-12-31'), -1);
  assert.equal(weekday('1969-12-31'), 3); // 水曜
  assert.equal(weekday('2026-11-21'), 6); // 土曜
  assert.equal(weekday('2026-11-22'), 0); // 日曜
  assert.equal(fromDays(toDays('1900-03-01') - 1), '1900-02-28'); // 1900年はうるう年ではない
});

test('日付の足し引き', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(addDays('2026-11-25', 29), '2026-12-24');
  assert.equal(diffDays('2026-11-25', '2026-12-25'), 30);
  assert.equal(diffDays('2026-12-25', '2026-11-25'), -30);
  assert.equal(diffDays('2026-11-25', '2026-11-25'), 0);
});

test('月の足し引き（年をまたぐ）', () => {
  assert.deepEqual(addMonths(2026, 11, 1), { y: 2026, m: 12 });
  assert.deepEqual(addMonths(2026, 12, 1), { y: 2027, m: 1 });
  assert.deepEqual(addMonths(2026, 1, -1), { y: 2025, m: 12 });
  assert.deepEqual(addMonths(2026, 3, -15), { y: 2024, m: 12 });
  assert.deepEqual(addMonths(2026, 3, 24), { y: 2028, m: 3 });
  assert.deepEqual(addMonths(2026, 6, 0), { y: 2026, m: 6 });
});

test('年の範囲（1900〜2200）は保存してよい日付かの判定だけ。計算は範囲の外でも止まらない', () => {
  assert.equal(isValidISO('1899-12-31'), false);
  assert.equal(isValidISO('2201-01-01'), false);
  assert.deepEqual(parseISO('1899-12-31'), { y: 1899, m: 12, d: 31 });
  assert.equal(addDays('1900-01-01', -1), '1899-12-31');
  assert.equal(addDays('2200-12-31', 1), '2201-01-01');
  assert.equal(weekday('1899-12-31'), 0); // 日曜
});

test('正しくない日付を日数にしようとするとエラー', () => {
  assert.throws(() => toDays('2026-02-30'), RangeError);
  assert.throws(() => toDays('abc'), RangeError);
});
