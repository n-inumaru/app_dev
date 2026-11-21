// 家計タブの画面（今月・収支・履歴・もしも）
//
// 計算は js/budget.js の関数を呼ぶだけにして、ここには書かない（ここにあるのは、表示用の整形と、入力の読み取りだけ）。
// 画面の作り方は app.js と同じ：data-action、openSheet、ユーザーの文字は必ず esc() でエスケープする。
// 家計の操作は、data-action の名前を "b-" で始める。app.js の onClick・onSubmit・onInput・onChange から呼ばれる。

import { esc, num, yen, parseYen, todayISO } from './format.js';
import { isValidISO, parseISO } from './dates.js';
import {
  EVERY_CHOICES,
  FIXED_CATEGORIES,
  WEEKDAYS_DEFAULT,
  activeDebts,
  dueMonths,
  fixedLines,
  isBudgetEmpty,
  pendingSnapshots,
  periodAmounts,
  periodOf,
  savingsOf,
  shiftPeriod,
  syncSnapshotSpent,
} from './budget.js';
import { BUDGET_LIMITS, getPref, setPref, uid } from './storage.js';
import { icon } from './icons.js';
import { closeSheet, confirmDialog, openSheet, setError, sheetHead, toast, yenField } from './ui.js';
import { createSpendsView } from './budget-spends.js';
import { createHistoryView } from './budget-history.js';
import { createWhatIfView } from './budget-whatif.js';

const SUBS = [
  ['month', '今月'],
  ['items', '収支'],
  ['history', '履歴'],
  ['whatif', 'もしも'],
];
const MAX_OFFSET = 60; // 前後に移動できる期間の数（5年分くらい）
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 積み上げ棒の部分。並びと色は dataviz スキルの validate_palette.js で検証して決めた（設計書 11 の「棒の色」）。
 * 並び：貯金 → 固定費 → 返済への上乗せ → 自由に使える額。
 * 「返済への上乗せ」があるときは借入の返済が固定費に必ず入るので、オレンジ（貯金）と黄色（上乗せ）は
 * 間に固定費（水色）をはさんで、隣り合わない。全組み合わせの検証に通らない唯一の組（オレンジ×黄色）が、棒の上で触れない。
 */
const PARTS = [
  { key: 'savings', label: '貯金の取り分', cls: 'sb-save' },
  { key: 'fixed', label: '固定費', cls: 'sb-fixed' },
  { key: 'extra', label: '返済への上乗せ', cls: 'sb-extra' },
  { key: 'free', label: '自由に使える額', cls: 'sb-free' },
];

const state = {
  sub: SUBS.some(([k]) => k === getPref('budget-tab')) ? getPref('budget-tab') : 'month',
  offset: 0, // 今の期間から、何期ずれているか（負なら過去）
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const nowISO = () => new Date().toISOString();
const money = (n) => `${n < 0 ? '−' : ''}${num(Math.abs(n))}`; // マイナスは「−」で表す
const moneyYen = (n) => `${money(n)}円`;
const md = (iso) => {
  const p = parseISO(iso);
  return `${p.m}月${p.d}日`;
};
const monthsText = (months) => months.map((m) => `${m}月`).join('・');

// ---- 入力欄の部品（フォームの見た目は app.js のフォームと同じ） ----

const textField = (id, label, value = '', placeholder = '', max = BUDGET_LIMITS.nameLen) => `
  <label class="field">
    <span class="field-label">${label}</span>
    <input class="input input-text" id="${id}" maxlength="${max}" autocomplete="off" enterkeyhint="next" placeholder="${esc(placeholder)}" value="${esc(value)}">
    <span class="field-error" id="${id}-err"></span>
  </label>`;

const selectField = (id, label, options, value, attrs = '') => `
  <label class="field" ${attrs}>
    <span class="field-label">${label}</span>
    <select class="input" id="${id}">${options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
  </label>`;

const segField = (name, label, options, value, attrs = '') => `
  <div class="field" ${attrs}>
    <span class="field-label">${label}</span>
    <div class="segmented" role="group" aria-label="${esc(label)}" data-seg="${name}">
      ${options.map(([v, t]) => `<button type="button" data-action="b-seg" data-name="${name}" data-v="${esc(v)}" aria-pressed="${v === value}">${esc(t)}</button>`).join('')}
    </div>
  </div>`;

const chipsField = (name, label, items, selected, attrs = '', errId = '') => `
  <div class="field" ${attrs}>
    <span class="field-label">${label}</span>
    <div class="chips chips-${items.length}" data-chips="${name}" role="group" aria-label="${esc(label)}">
      ${items.map(([v, t]) => `<button type="button" class="chip" data-action="b-chip" data-v="${v}" aria-pressed="${selected.includes(v)}">${esc(t)}</button>`).join('')}
    </div>
    ${errId ? `<span class="field-error" id="${errId}"></span>` : ''}
  </div>`;

const switchRow = (id, label, checked, hint = '', attrs = '') => `
  <label class="switch-row" ${attrs}>
    <span class="switch-text"><span class="switch-label">${label}</span>${hint ? `<span class="switch-hint">${hint}</span>` : ''}</span>
    <input type="checkbox" role="switch" class="switch" id="${id}" ${checked ? 'checked' : ''}>
  </label>`;

const dayOptions = (withEnd = false) => [...(withEnd ? [[0, '月末']] : []), ...Array.from({ length: 31 }, (_, i) => [i + 1, `${i + 1}日`])];
const monthOptions = Array.from({ length: 12 }, (_, i) => [i + 1, `${i + 1}月`]);

/** 金額（円）の入力を読む。{ value } か { error } */
function readYen(id, { min = 0, required = true, label = '金額', max = BUDGET_LIMITS.yen, unit = '円' } = {}) {
  const v = parseYen($(`#${id}`).value);
  if (v === null) return required ? { error: `${label}を入れてください` } : { value: null };
  if (Number.isNaN(v)) return { error: '数字で入れてください（例：50000 または 5万）' };
  if (v < min) return { error: min === 1 ? `1${unit}以上にしてください` : `${min}${unit}以上にしてください` };
  if (v > max) return { error: `大きすぎます（${num(max)}${unit}まで）` };
  return { value: v };
}

/**
 * 入力シートの Enter のキー：保存せずに、キーボードを閉じるだけにする（Android の Chrome で、Enter を押すたびに保存されるのを防ぐ）。
 * 保存は「保存する」ボタンだけ。日本語の変換中の Enter（文字の確定）は、そのまま通す。入力欄の Enter のキーは「完了」の表示にする。
 * 出費のシートと同じ動き（フェーズ3の「14」の12）。スイッチ（チェックボックス）の Enter は、今までどおり。
 */
function calmEnter(form) {
  for (const input of $$('input.input', form)) input.setAttribute('enterkeyhint', 'done');
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.target.tagName !== 'INPUT' || e.target.type === 'checkbox') return;
    e.preventDefault();
    e.target.blur();
  });
}

const segValue = (form, name) => $(`[data-seg="${name}"] [aria-pressed="true"]`, form)?.dataset.v;
const chipValues = (form, name) => $$(`[data-chips="${name}"] [aria-pressed="true"]`, form).map((b) => Number(b.dataset.v));

/** フォームの data-kind などに合わせて、項目を出し入れする（data-show-kind="uses periodic" など） */
function applyVisibility(form) {
  for (const name of ['kind', 'by', 'mode', 'smode']) {
    for (const el of $$(`[data-show-${name}]`, form)) {
      el.hidden = !el.getAttribute(`data-show-${name}`).split(' ').includes(form.dataset[name]);
    }
  }
}

// =====================================================================

export function createBudgetView({ getData, persist, rerender }) {
  const settings = () => getData().budget.settings;
  const currentPeriod = () => {
    const s = settings();
    return shiftPeriod(s, periodOf(s, todayISO()), state.offset);
  };
  const periodByKey = (key) => periodOf(settings(), key);

  // ---- 履歴（期間が終わったら結果を確定する） ----

  /** 終わった期間を確定して、出費に合わなくなった履歴を直す。変えたら true（保存は呼ぶ側） */
  function applyClosedPeriods() {
    const data = getData();
    const changes = [...pendingSnapshots(data, todayISO()), ...syncSnapshotSpent(data)];
    for (const s of changes) data.budget.snapshots[s.start] = s;
    return changes.length > 0;
  }

  /** 起動時と家計タブを開いたときに呼ぶ。履歴ができたら保存する */
  function closePeriods() {
    if (applyClosedPeriods()) persist({ touch: false });
  }

  /**
   * 家計のデータを変えたあとの保存。最初に保存した日（since）を入れ、終わった期間の履歴も直す
   * （確定した期間の出費を変えたときは、その期の使った額と余りが作り直される）。keep なら、シートを閉じない（出費の「続けて入力」）
   */
  function commit(message, { keep = false } = {}) {
    const b = getData().budget;
    if (!b.settings.since) b.settings.since = todayISO();
    applyClosedPeriods();
    if (!persist()) return false;
    if (!keep) closeSheet();
    rerender();
    if (message) toast(message);
    return true;
  }

  /** 「この期間だけ変える」の上書きを入れる／消す（value が null なら消す） */
  function setOverride(group, periodKey, id, value) {
    const ovs = getData().budget.overrides;
    if (value === null) {
      const ov = ovs[periodKey];
      if (!ov) return;
      if (ov[group]) delete ov[group][id];
      if (!Object.keys(ov.income || {}).length && !Object.keys(ov.fixed || {}).length && !Object.keys(ov.uses || {}).length) delete ovs[periodKey];
      return;
    }
    ovs[periodKey] ??= { income: {}, fixed: {}, uses: {} };
    ovs[periodKey][group] ??= {};
    ovs[periodKey][group][id] = value;
  }

  /** 項目を消すとき、その項目の上書きもすべて消す */
  function dropOverrides(id) {
    const ovs = getData().budget.overrides;
    for (const key of Object.keys(ovs)) {
      for (const g of ['income', 'fixed', 'uses']) if (ovs[key][g]) delete ovs[key][g][id];
      setOverride('income', key, id, null); // 空になった期間を片づける
    }
  }

  // =====================================================================
  // 画面
  // =====================================================================

  function html() {
    const subs = `
    <div class="segmented subtabs" role="group" aria-label="家計の画面">
      ${SUBS.map(([k, t]) => `<button type="button" data-action="b-sub" data-key="${k}" aria-pressed="${state.sub === k}">${t}</button>`).join('')}
    </div>`;
    if (state.sub === 'month') return subs + monthHtml();
    if (state.sub === 'items') return subs + itemsHtml();
    if (state.sub === 'history') return subs + historyView.html();
    return subs + whatifView.html();
  }

  function periodNav(period) {
    const o = state.offset;
    const tag = o === 0 ? '今の期間' : o === -1 ? '前の期間' : o === 1 ? '次の期間' : o < 0 ? `${-o}期前` : `${o}期あと`;
    const ys = parseISO(period.start).y;
    const ye = parseISO(period.end).y;
    const sub = `${ys === ye ? `${ys}年` : `${ys}年〜${ye}年`}・${period.days}日間`;
    return `
    <div class="pnav">
      <button type="button" class="icon-btn" data-action="b-prev" aria-label="前の期間" ${o <= -MAX_OFFSET ? 'disabled' : ''}>${icon('chevron-left')}</button>
      <div class="pnav-body" aria-live="polite">
        <span class="tag ${o === 0 ? 'accent' : ''}">${tag}</span>
        <strong class="pnav-range">${md(period.start)}〜${md(period.end)}</strong>
        <span class="pnav-sub">${sub}</span>
      </div>
      <button type="button" class="icon-btn" data-action="b-next" aria-label="次の期間" ${o >= MAX_OFFSET ? 'disabled' : ''}>${icon('chevron-right')}</button>
    </div>
    ${o !== 0 ? '<div class="pnav-now"><button type="button" class="link-btn" data-action="b-now">今の期間に戻る</button></div>' : ''}`;
  }

  // ---- 今月 ----

  function emptyGuideHtml() {
    return `
    <section class="card empty">
      <div class="empty-icon">${icon('wallet')}</div>
      <h2>収入と固定費を入れましょう</h2>
      <p>毎月の収入と、家賃・通信費などの固定費を入れると、毎月自由に使える額がわかります。返済中の会社の返済額は、固定費に自動で入ります。</p>
      <button type="button" class="btn btn-primary btn-block" data-action="b-sub" data-key="items">${icon('plus')}収支を入れる</button>
      <button type="button" class="btn btn-block mt-12" data-action="b-spend-add">${icon('edit')}出費だけ記録する</button>
      <p class="hint">収入や固定費を入れずに、出費だけ記録することもできます。あとから収入を入れると、自由に使える額や「今日あと」がわかるようになります。</p>
      <p class="hint">データはこのスマホの中だけに保存され、外部には送られません。</p>
    </section>`;
  }

  /** 合計100%になる整数の割合（最大剰余法） */
  function shares(values) {
    const total = values.reduce((s, v) => s + v, 0);
    if (total <= 0) return values.map(() => 0);
    const raw = values.map((v) => (v * 100) / total);
    const out = raw.map(Math.floor);
    let rest = 100 - out.reduce((s, v) => s + v, 0);
    const order = raw.map((r, i) => ({ i, f: r - out[i] })).sort((x, y) => y.f - x.f);
    for (const { i } of order) {
      if (rest <= 0) break;
      if (values[i] > 0) {
        out[i] += 1;
        rest -= 1;
      }
    }
    return out;
  }

  const pctText = (pct, value) => (value > 0 && pct === 0 ? '1%未満' : `${pct}%`);

  function monthHtml() {
    const data = getData();
    if (isBudgetEmpty(data.budget)) return emptyGuideHtml();
    const period = currentPeriod();
    const a = periodAmounts(data, period);
    const negative = a.free < 0;

    const hero = `
    <section class="card summary">
      <div class="hero-label">自由に使える額</div>
      <div class="hero-value ${negative ? 'is-neg' : ''}">${negative ? icon('alert') : ''}${money(a.free)}<span class="unit">円</span></div>
      <p class="summary-foot">この期間の収入 <strong>${yen(a.income)}</strong> から、固定費・貯金の取り分・返済への上乗せを引いた額です。</p>
      ${
        // 出費だけを記録している人（収入を1つも入れていない）への一言
        !data.budget.incomes.length && !data.budget.entries.length
          ? `<p class="note">${icon('info')}<span>収入を入れていないので、自由に使える額は <span class="nobr">0円</span> です。収入と固定費を入れると、自由に使える額と「今日あと」がわかります。<button type="button" class="link-btn" data-action="b-sub" data-key="items">収支を入れる</button></span></p>`
          : ''
      }
    </section>`;

    // 「今日あと」と「＋ 出費を記録」は毎日使うので、自由に使える額のすぐ下に置く（設計書「14」の1）
    return `${periodNav(period)}${hero}${spends.summaryHtml(a, period)}${barCardHtml(a)}${breakdownHtml(a)}${spends.listHtml(a, period)}${spends.categoryHtml(period)}`;
  }

  function barCardHtml(a) {
    const negative = a.free < 0;
    const values = [a.savings, a.fixed, a.extra, Math.max(0, a.free)];
    const total = a.income;
    const pcts = negative ? values.map(() => 0) : shares(values);
    const parts = PARTS.map((p, i) => ({ ...p, value: values[i], pct: pcts[i] })).filter((p) => p.value > 0);
    const debtLine = a.fixedLines.find((l) => l.kind === 'debt');

    let visual;
    if (negative) {
      visual = `
      <div class="warn" role="alert">
        ${icon('alert')}
        <span>固定費などが収入を ${yen(-a.free)} 上回っています。固定費・貯金の取り分・返済への上乗せを見直すか、収入の入れ忘れがないか確かめてください。</span>
      </div>
      <button type="button" class="btn btn-block mt-12" data-action="b-sub" data-key="items">収支を見直す</button>`;
    } else if (total <= 0 || !parts.length) {
      visual = `<p class="empty-text">この期間の収入は0円です。収入を入れると、使い道が棒で見えます。</p>`;
    } else {
      const label = parts.map((p) => `${p.label} ${yen(p.value)}（${pctText(p.pct, p.value)}）`).join('、');
      const blocks = parts
        .map(
          (p) =>
            `<button type="button" class="sbar-block ${p.cls}" style="flex:${p.value} 1 0" data-action="b-part" data-text="${esc(`${p.label}　${yen(p.value)}（収入の ${pctText(p.pct, p.value)}）`)}" aria-label="${esc(`${p.label} ${yen(p.value)}、収入の ${pctText(p.pct, p.value)}`)}"><span class="sbar-label">${pctText(p.pct, p.value)}</span></button>`,
        )
        .join('');
      const legend = parts
        .map((p) => `<li><span class="lsw ${p.cls}"></span><span class="legend-name">${p.label}</span><span class="legend-val">${yen(p.value)}</span></li>`)
        .join('');
      visual = `
      <div class="sbar" role="group" aria-label="${esc(`収入の使い道。${label}`)}">${blocks}</div>
      <div class="bar-readout" id="bar-readout" aria-live="polite">棒をタップすると、その額が出ます。</div>
      <ul class="legend legend-parts">${legend}</ul>
      ${debtLine ? `<p class="hint">固定費には、借入の返済 ${yen(debtLine.amount)}（${debtLine.companies}社）が入っています。</p>` : ''}`;
    }

    const tableRows = [
      ['収入', moneyYen(a.income), ''],
      ['貯金の取り分', moneyYen(a.savings), negative || total <= 0 ? '—' : pctText(pcts[0], a.savings)],
      ['固定費', moneyYen(a.fixed), negative || total <= 0 ? '—' : pctText(pcts[1], a.fixed)],
      ['返済への上乗せ', moneyYen(a.extra), negative || total <= 0 ? '—' : pctText(pcts[2], a.extra)],
      ['自由に使える額', moneyYen(a.free), negative || total <= 0 ? '—' : pctText(pcts[3], Math.max(0, a.free))],
    ]
      .map(([n, v, p]) => `<tr><th scope="row">${n}</th><td>${v}</td><td>${p}</td></tr>`)
      .join('');

    return `
    <section class="card">
      <h2 class="card-title">収入の使い道</h2>
      <p class="card-sub">この期間の収入 ${yen(a.income)} が、何に回るかを表します。</p>
      ${visual}
      <details class="table-view">
        <summary>表で見る</summary>
        <div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">項目</th><th scope="col">金額</th><th scope="col">割合</th></tr></thead><tbody>${tableRows}</tbody></table></div>
      </details>
    </section>`;
  }

  /** 行の説明（まとめて入る・払う日、回数、上書きなど） */
  function lineNote(l) {
    const notes = [];
    if (l.kind === 'entry') notes.push(`${md(l.date)}に入金`);
    else if (l.dates?.length) notes.push(`${l.dates.map(md).join('・')}`);
    if (l.kind === 'uses') notes.push(`${yen(l.unit)} × ${l.count}回`);
    if (l.kind === 'periodic' && l.mode === 'spread') notes.push('月割りで積み立て');
    if (l.kind === 'debt') notes.push(`${l.companies}社`);
    return notes.length ? `<small>${esc(notes.join('・'))}</small>` : '';
  }

  function breakdownHtml(a) {
    const row = (l) =>
      `<li><span class="bl-name">${esc(l.name)}${lineNote(l)}${l.overridden ? '<span class="tag accent">この期間だけ変更</span>' : ''}</span><span class="bl-amt">${yen(l.amount)}</span></li>`;
    const inc = a.incomeLines.length ? a.incomeLines.map(row).join('') : '<li class="bl-empty">この期間に入る収入はありません</li>';
    const fx = a.fixedLines.length ? a.fixedLines.map(row).join('') : '<li class="bl-empty">この期間に払う固定費はありません</li>';
    return `
    <details class="card explain breakdown">
      <summary>この期間の収入と固定費のくわしい内訳</summary>
      <h3 class="sub-title">収入 ${yen(a.income)}</h3>
      <ul class="bl-list">${inc}</ul>
      <h3 class="sub-title">固定費 ${yen(a.fixed)}</h3>
      <ul class="bl-list">${fx}</ul>
      <p class="hint">ボーナスなどの「決まった月」の収入や、年払いの固定費は、支払う日が入る期間にまとめて入ります。</p>
    </details>`;
  }

  // ---- 収支 ----

  const brow = ({ attrs, name, sub = '', amount = '', amountSub = '', muted = false, tags = '' }) => `
    <button type="button" class="brow ${muted ? 'is-muted' : ''}" ${attrs}>
      <span class="brow-main"><span class="brow-name">${name}</span>${sub ? `<span class="brow-sub">${sub}</span>` : ''}${tags}</span>
      <span class="brow-amt">${amount}${amountSub ? `<small>${amountSub}</small>` : ''}</span>
      <span class="brow-go">${icon('chevron-right')}</span>
    </button>`;

  const overrideTag = '<span class="tag accent">この期間だけ変更</span>';

  // 出費の画面（今日あと・記録・一覧・カテゴリ別）。ファイルは js/budget-spends.js
  const spends = createSpendsView({
    getData,
    currentPeriod,
    commit,
    rerender,
    kit: { textField, readYen, md, money, moneyYen, brow, shares, pctText, nowISO, refreshForm, calmEnter },
  });

  // 履歴の画面（期間ごとの結果・前の期間との比べ・最近12期間の棒グラフ）。ファイルは js/budget-history.js
  const historyView = createHistoryView({ getData, rerender, kit: { md, moneyYen, emptyGuideHtml } });

  // 「もしも」の画面（変更を重ねて、自由に使える額と返済の変化を試す。実データは変えない）。ファイルは js/budget-whatif.js
  const whatifView = createWhatIfView({
    getData,
    currentPeriod,
    rerender,
    kit: { textField, segField, readYen, md, refreshForm, calmEnter, periodNav, emptyGuideHtml },
  });

  function itemsHtml() {
    const data = getData();
    const b = data.budget;
    const period = currentPeriod();
    const a = periodAmounts(data, period);
    return `${periodNav(period)}${paydayCardHtml(b.settings)}${incomesCardHtml(b, a)}${entriesCardHtml(b, a)}${fixedCardHtml(b, a)}${savingsCardHtml(b.settings, a)}${extraCardHtml(data)}<div id="b-totals">${totalsHtml(a)}</div>`;
  }

  function paydayCardHtml(s) {
    const day = s.payday === 0 ? '月末' : `${s.payday}日`;
    const shift = s.payday === 1 ? '1日は、前の平日には動かしません' : s.shiftEarly ? '土日祝にあたるときは、前の平日' : '土日祝でも動かしません';
    return `
    <section class="card">
      <h2 class="card-title">給料日</h2>
      <p class="card-sub">1か月は「給料日 〜 次の給料日の前日」です。</p>
      ${brow({ attrs: 'data-action="b-payday"', name: `毎月 ${day}`, sub: shift })}
    </section>`;
  }

  function incomesCardHtml(b, a) {
    const rows = b.incomes
      .map((it) => {
        const line = a.incomeLines.find((l) => l.id === it.id && l.kind !== 'entry');
        let sub = it.kind === 'months' ? `${monthsText(it.months)}の${it.day}日に支給` : '毎月';
        let muted = false;
        if (it.enabled === false) {
          sub += '・計算に含めない';
          muted = true;
        } else if (!line) {
          sub += '・この期間は入りません';
          muted = true;
        }
        return brow({
          attrs: `data-action="b-income-edit" data-id="${esc(it.id)}"`,
          name: esc(it.name),
          sub: esc(sub),
          amount: line ? yen(line.amount) : '—',
          amountSub: line?.overridden ? `元は ${yen(line.baseAmount)}` : '',
          tags: line?.overridden ? overrideTag : '',
          muted,
        });
      })
      .join('');
    return `
    <section class="card">
      <h2 class="card-title">収入</h2>
      <p class="card-sub">毎月入る収入と、ボーナスのように決まった月に入る収入を入れます。</p>
      <div class="brow-list">${rows || '<p class="empty-text">まだ収入が入っていません</p>'}</div>
      <button type="button" class="btn btn-block mt-12" data-action="b-income-add">${icon('plus')}収入を追加</button>
    </section>`;
  }

  function entriesCardHtml(b, a) {
    const lines = a.incomeLines.filter((l) => l.kind === 'entry').sort((x, y) => x.date.localeCompare(y.date));
    const rows = lines
      .map((l) => {
        const e = b.entries.find((x) => x.id === l.id);
        return brow({ attrs: `data-action="b-entry-edit" data-id="${esc(l.id)}"`, name: esc(e?.memo || '変わる収入'), sub: md(l.date), amount: yen(l.amount) });
      })
      .join('');
    return `
    <section class="card">
      <h2 class="card-title">変わる収入の記録</h2>
      <p class="card-sub">残業代・副収入など、月によって変わる収入は、入金のたびに記録します。入った額だけが、この期間の収入に足されます。</p>
      <div class="brow-list">${rows || '<p class="empty-text">この期間の記録はありません</p>'}</div>
      <button type="button" class="btn btn-block mt-12" data-action="b-entry-add">${icon('plus')}入金を記録</button>
    </section>`;
  }

  function fixedSub(it, line) {
    if (it.kind === 'uses') {
      const u = it.uses;
      const how = u.by === 'count' ? `期間に${u.count}回` : `${u.days.map((d) => WEEK[d]).join('')}${u.skipHolidays ? '（祝日を除く）' : ''}`;
      return `${yen(it.amount)} × ${line ? line.count : '—'}回・${how}`;
    }
    if (it.kind === 'periodic') {
      const how = it.mode === 'spread' ? '月割りで積み立て' : `${monthsText(dueMonths(it))}の${it.dueDay}日に払う`;
      return `${it.every}か月ごと・${how}`;
    }
    return '毎月';
  }

  function fixedCardHtml(b, a) {
    const debtLine = a.fixedLines.find((l) => l.kind === 'debt');
    const debtRow = debtLine
      ? brow({
          attrs: 'data-goto="home"',
          name: '借入の返済（自動）',
          sub: `返済中の${debtLine.companies}社の、毎月の返済額の合計。ホームで変えます`,
          amount: yen(debtLine.amount),
        })
      : '';
    const groups = FIXED_CATEGORIES.map((c) => ({ c, items: b.fixed.filter((f) => f.category === c.key) }))
      .filter((g) => g.items.length)
      .map((g) => {
        const rows = g.items
          .map((it) => {
            const line = a.fixedLines.find((l) => l.id === it.id && l.kind !== 'debt');
            let sub = fixedSub(it, line);
            let muted = false;
            if (it.enabled === false) {
              sub += '・計算に含めない';
              muted = true;
            } else if (!line) {
              sub += '・この期間は払いません';
              muted = true;
            }
            return brow({
              attrs: `data-action="b-fixed-edit" data-id="${esc(it.id)}"`,
              name: esc(it.name),
              sub: esc(sub),
              amount: line ? yen(line.amount) : '—',
              amountSub: line?.overridden ? `元は ${yen(line.baseAmount)}` : '',
              tags: line?.overridden ? overrideTag : '',
              muted,
            });
          })
          .join('');
        return `<h3 class="sub-title">${g.c.label}</h3><div class="brow-list">${rows}</div>`;
      })
      .join('');
    return `
    <section class="card">
      <h2 class="card-title">固定費</h2>
      <p class="card-sub">家賃・通信費・保険など。年払いは「払う月にまとめて」入れます。昼食のように「単価×回数」で入れたものは、あとで出費として記録しなくて大丈夫です。</p>
      ${debtRow ? `<div class="brow-list">${debtRow}</div>` : ''}
      ${groups || (debtRow ? '' : '<p class="empty-text">まだ固定費が入っていません</p>')}
      <button type="button" class="btn btn-block mt-12" data-action="b-fixed-add">${icon('plus')}固定費を追加</button>
    </section>`;
  }

  function savingsCardHtml(s, a) {
    const v = s.savings;
    const what = v.value === 0 ? '設定なし' : v.mode === 'percent' ? `収入の ${v.value}%` : `毎月 ${yen(v.value)}`;
    return `
    <section class="card">
      <h2 class="card-title">貯金の取り分</h2>
      <p class="card-sub">収入から先に貯金に回す分です。自由に使える額から引かれます。</p>
      ${brow({ attrs: 'data-action="b-savings-edit"', name: esc(what), sub: '', amount: yen(a.savings), amountSub: 'この期間' })}
    </section>`;
  }

  function extraCardHtml(data) {
    const hasDebts = activeDebts(data).length > 0;
    return `
    <section class="card">
      <h2 class="card-title">返済への上乗せ</h2>
      ${
        hasDebts
          ? `<p class="card-sub">毎月の返済のほかに、借金の返済に回す額です。</p>
      ${yenField('bz-extra', '毎月の上乗せ額', data.plan.monthlyExtra ? num(data.plan.monthlyExtra) : '', 'placeholder="0"')}
      <p class="hint">提案の画面の「毎月の余剰金」と同じ値です。どちらで変えても、両方に反映されます。<button type="button" class="link-btn" data-goto="plan">提案を見る</button></p>`
          : `<p class="hint">返済中の会社がありません。ホームで会社を登録すると、返済額が固定費に自動で入り、ここで上乗せを決められます。<button type="button" class="link-btn" data-goto="home">ホームへ</button></p>`
      }
    </section>`;
  }

  function totalsHtml(a) {
    const negative = a.free < 0;
    return `
    <section class="card">
      <h2 class="card-title">この期間の合計</h2>
      <table class="sum-table">
        <tbody>
          <tr><th scope="row">収入</th><td>${yen(a.income)}</td></tr>
          <tr><th scope="row">− 固定費</th><td>${yen(a.fixed)}</td></tr>
          <tr><th scope="row">− 貯金の取り分</th><td>${yen(a.savings)}</td></tr>
          <tr><th scope="row">− 返済への上乗せ</th><td>${yen(a.extra)}</td></tr>
        </tbody>
        <tfoot>
          <tr class="is-total"><th scope="row">＝ 自由に使える額</th><td class="${negative ? 'is-neg' : ''}">${negative ? icon('alert') : ''}${moneyYen(a.free)}</td></tr>
        </tfoot>
      </table>
      ${negative ? `<p class="warn">${icon('alert')}<span>固定費などが収入を ${yen(-a.free)} 上回っています。</span></p>` : ''}
    </section>`;
  }

  // =====================================================================
  // 入力フォーム（シート）
  // =====================================================================

  /** フォームごとの設定：読み取り・保存・エラーを出す欄の id・プレビュー */
  const FORMS = {
    'b-payday-form': { read: readPaydayForm, submit: submitPayday, ids: [], preview: updatePaydayPreview },
    'b-income-form': { read: readIncomeForm, submit: submitIncome, ids: ['bi-name', 'bi-amount', 'bi-months', 'bi-ov'] },
    'b-entry-form': { read: readEntryForm, submit: submitEntry, ids: ['be-date', 'be-amount', 'be-memo'] },
    'b-fixed-form': { read: readFixedForm, submit: submitFixed, ids: ['bx-name', 'bx-amount', 'bx-days', 'bx-count', 'bx-ov'], preview: updateFixedPreview },
    'b-savings-form': { read: readSavingsForm, submit: submitSavings, ids: ['bs-value'], preview: updateSavingsPreview },
    'b-spend-form': spends.form,
    ...whatifView.forms,
  };

  function refreshForm(form) {
    const spec = FORMS[form.id];
    if (!spec) return;
    applyVisibility(form);
    const { errors } = spec.read(form);
    if (form.dataset.submitted) for (const id of spec.ids) setError(id, errors[id]);
    spec.preview?.(form, errors);
  }

  const submitLabel = (it) => (it ? '保存する' : '追加する');
  const deleteButton = (action, id) => `<button type="button" class="btn btn-danger btn-block mt-12" data-action="${action}" data-id="${esc(id)}">${icon('trash')}削除</button>`;

  /** 「この期間だけ変える」の欄（項目を編集するときだけ） */
  function overrideSection(period, { field, current, hint }) {
    return `
    <section class="ov-box">
      <h3 class="ov-title">この期間（${md(period.start)}〜${md(period.end)}）だけ変える</h3>
      ${field}
      <p class="hint">${hint}<button type="button" class="link-btn" data-action="b-ov-clear" data-target="${current}">元に戻す</button></p>
    </section>`;
  }

  // ---- 給料日 ----

  function openPaydayForm() {
    const s = settings();
    openSheet(`
    ${sheetHead('給料日')}
    <form id="b-payday-form" class="bform" novalidate>
      ${selectField('bp-day', '給料日', dayOptions(true), s.payday)}
      ${switchRow('bp-shift', '土日祝なら、前の平日にする', s.shiftEarly, '給料日が土日や祝日にあたるとき、直前の平日を給料日にします。1日は動かしません。')}
      <div class="preview" id="bp-preview"></div>
      ${Object.keys(getData().budget.overrides).length ? '<p class="hint mb-8">給料日を変えると、期間の区切りが変わります。「この期間だけ変える」で入れた金額は、新しい期間には引き継がれません。</p>' : ''}
      <button type="submit" class="btn btn-primary btn-block">保存する</button>
    </form>`);
    updatePaydayPreview($('#b-payday-form'));
  }

  function readPaydayForm() {
    return { values: { payday: Number($('#bp-day').value), shiftEarly: $('#bp-shift').checked }, errors: {} };
  }

  function updatePaydayPreview(form) {
    const { values } = readPaydayForm(form);
    const p = periodOf({ ...settings(), ...values }, todayISO());
    $('#bp-preview').innerHTML = `この設定だと、今の期間は <strong>${md(p.start)}〜${md(p.end)}</strong>（${p.days}日間）です。`;
  }

  function submitPayday() {
    const { values } = readPaydayForm();
    Object.assign(settings(), values);
    state.offset = 0;
    commit('給料日を保存しました');
  }

  // ---- 収入 ----

  function openIncomeForm(id) {
    const data = getData();
    const b = data.budget;
    const it = id ? b.incomes.find((x) => x.id === id) : null;
    if (id && !it) return;
    if (!it && b.incomes.length >= BUDGET_LIMITS.items) {
      toast(`収入は${BUDGET_LIMITS.items}件までです`);
      return;
    }
    const period = currentPeriod();
    const kind = it?.kind ?? 'monthly';
    const line = it ? periodAmounts(data, period).incomeLines.find((l) => l.id === it.id && l.kind !== 'entry') : null;
    const months = it?.months?.length ? it.months : kind === 'months' ? [] : [6, 12];
    const override = line
      ? overrideSection(period, {
          field: yenField('bi-ov', 'この期間に入る額', line.overridden ? num(line.amount) : '', `placeholder="変えない（${num(line.baseAmount)}）"`),
          current: 'bi-ov',
          hint: '残業代の増減など、この期間だけ額が違うときに入れます。空にすると元に戻ります。',
        })
      : '';
    openSheet(`
    ${sheetHead(it ? '収入を編集' : '収入を追加')}
    <form id="b-income-form" class="bform" novalidate data-id="${esc(id || '')}" data-kind="${kind}" data-period="${esc(period.key)}">
      ${it ? `<p class="kind-fixed"><span class="tag">${kind === 'months' ? '決まった月の収入' : '毎月の収入'}</span></p>` : segField('kind', '種類', [['monthly', '毎月'], ['months', '決まった月（ボーナスなど）']], kind)}
      ${textField('bi-name', '名前', it?.name ?? '', kind === 'months' ? '例：ボーナス' : '例：給料')}
      ${yenField('bi-amount', '<span data-show-kind="monthly">毎月の金額</span><span data-show-kind="months">1回の支給額</span>', it ? num(it.amount) : '')}
      ${chipsField('months', '支給される月', monthOptions, months, 'data-show-kind="months"', 'bi-months-err')}
      ${selectField('bi-day', '支給日（月末を超える日は月末）', dayOptions(), it?.day ?? 10, 'data-show-kind="months"')}
      ${switchRow('bi-enabled', '計算に含める', it?.enabled !== false, 'オフにすると、どの合計にも入りません。')}
      ${override}
      <button type="submit" class="btn btn-primary btn-block">${submitLabel(it)}</button>
      ${it ? deleteButton('b-income-delete', it.id) : ''}
    </form>`);
    refreshForm($('#b-income-form'));
    calmEnter($('#b-income-form'));
  }

  function readIncomeForm(form) {
    const kind = form.dataset.kind;
    const errors = {};
    const name = $('#bi-name').value.trim();
    if (!name) errors['bi-name'] = '名前を入れてください';
    const amount = readYen('bi-amount', { min: 1, label: '金額' });
    if (amount.error) errors['bi-amount'] = amount.error;
    const months = kind === 'months' ? chipValues(form, 'months') : [];
    if (kind === 'months' && !months.length) errors['bi-months'] = '支給される月を1つ以上選んでください';
    let override;
    if ($('#bi-ov')) {
      const ov = readYen('bi-ov', { required: false });
      if (ov.error) errors['bi-ov'] = ov.error;
      else override = ov.value;
    }
    return { values: { kind, name, amount: amount.value, months, day: Number($('#bi-day').value) || 1, enabled: $('#bi-enabled').checked, override }, errors };
  }

  function submitIncome(form) {
    const { values: v, errors } = readIncomeForm(form);
    form.dataset.submitted = '1';
    refreshForm(form);
    if (Object.keys(errors).length) return;
    const b = getData().budget;
    const now = nowISO();
    const id = form.dataset.id;
    let item = id ? b.incomes.find((x) => x.id === id) : null;
    if (item) {
      Object.assign(item, { name: v.name, amount: v.amount, months: v.kind === 'months' ? v.months : item.months, day: v.day, enabled: v.enabled, updatedAt: now });
    } else {
      item = { id: uid(), name: v.name, kind: v.kind, amount: v.amount, months: v.kind === 'months' ? v.months : [], day: v.day, enabled: v.enabled, createdAt: now, updatedAt: now };
      b.incomes.push(item);
    }
    if (v.override !== undefined) setOverride('income', form.dataset.period, item.id, v.override);
    commit(id ? '保存しました' : `${v.name} を追加しました`);
  }

  async function deleteIncome(id) {
    const b = getData().budget;
    const it = b.incomes.find((x) => x.id === id);
    if (!it) return;
    const ok = await confirmDialog({ title: `${it.name} を削除しますか？`, message: '「この期間だけ変える」で入れた金額も消えます。元には戻せません。', okLabel: '削除する', danger: true });
    if (!ok) return;
    b.incomes = b.incomes.filter((x) => x.id !== id);
    dropOverrides(id);
    commit('削除しました');
  }

  // ---- 変わる収入の記録 ----

  function openEntryForm(id) {
    const b = getData().budget;
    const e = id ? b.entries.find((x) => x.id === id) : null;
    if (id && !e) return;
    if (!e && b.entries.length >= BUDGET_LIMITS.entries) {
      toast(`記録は${BUDGET_LIMITS.entries}件までです`);
      return;
    }
    const period = currentPeriod();
    const today = todayISO();
    const date = e?.date ?? (today >= period.start && today <= period.end ? today : period.start);
    openSheet(`
    ${sheetHead(e ? '入金の記録を編集' : '入金を記録')}
    <form id="b-entry-form" class="bform" novalidate data-id="${esc(id || '')}">
      <label class="field">
        <span class="field-label">入金された日</span>
        <input class="input input-text" type="date" id="be-date" value="${esc(date)}">
        <span class="field-error" id="be-date-err"></span>
      </label>
      ${yenField('be-amount', '入った額', e ? num(e.amount) : '')}
      ${textField('be-memo', 'メモ（任意）', e?.memo ?? '', '例：残業代', BUDGET_LIMITS.memoLen)}
      <p class="hint mb-8">入金された日を含む期間の収入に、足されます。</p>
      <button type="submit" class="btn btn-primary btn-block">${e ? '保存する' : '記録する'}</button>
      ${e ? deleteButton('b-entry-delete', e.id) : ''}
    </form>`);
    calmEnter($('#b-entry-form'));
  }

  function readEntryForm() {
    const errors = {};
    const date = $('#be-date').value;
    if (!isValidISO(date)) errors['be-date'] = '日付を選んでください';
    const amount = readYen('be-amount', { min: 1, label: '入った額' });
    if (amount.error) errors['be-amount'] = amount.error;
    return { values: { date, amount: amount.value, memo: $('#be-memo').value.trim() }, errors };
  }

  function submitEntry(form) {
    const { values: v, errors } = readEntryForm();
    form.dataset.submitted = '1';
    refreshForm(form);
    if (Object.keys(errors).length) return;
    const b = getData().budget;
    const id = form.dataset.id;
    const e = id ? b.entries.find((x) => x.id === id) : null;
    if (e) Object.assign(e, { date: v.date, amount: v.amount, memo: v.memo });
    else b.entries.push({ id: uid(), date: v.date, amount: v.amount, memo: v.memo, createdAt: nowISO() });
    const inThis = periodOf(b.settings, v.date).key === currentPeriod().key;
    commit(inThis ? (e ? '保存しました' : '記録しました') : `記録しました（${md(v.date)}は、別の期間です）`);
  }

  async function deleteEntry(id) {
    const b = getData().budget;
    const e = b.entries.find((x) => x.id === id);
    if (!e) return;
    const ok = await confirmDialog({ title: 'この記録を削除しますか？', message: `${md(e.date)}・${yen(e.amount)}${e.memo ? `・${e.memo}` : ''}\n元には戻せません。`, okLabel: '削除する', danger: true });
    if (!ok) return;
    b.entries = b.entries.filter((x) => x.id !== id);
    commit('削除しました');
  }

  // ---- 固定費 ----

  function openFixedForm(id) {
    const data = getData();
    const b = data.budget;
    const it = id ? b.fixed.find((x) => x.id === id) : null;
    if (id && !it) return;
    if (!it && b.fixed.length >= BUDGET_LIMITS.items) {
      toast(`固定費は${BUDGET_LIMITS.items}件までです`);
      return;
    }
    const period = currentPeriod();
    const kind = it?.kind ?? 'monthly';
    const u = it?.uses ?? { by: 'weekdays', days: WEEKDAYS_DEFAULT, skipHolidays: true, count: 0 };
    const line = it ? periodAmounts(data, period).fixedLines.find((l) => l.id === it.id && l.kind !== 'debt') : null;
    let override = '';
    if (line) {
      override =
        kind === 'uses'
          ? overrideSection(period, {
              field: `
              <label class="field">
                <span class="field-label">この期間の回数</span>
                <span class="input-wrap"><input class="input" id="bx-ov" data-yen inputmode="numeric" autocomplete="off" placeholder="変えない（${line.baseCount}回）" value="${line.overridden ? line.count : ''}"><span class="suffix">回</span></span>
                <span class="field-error" id="bx-ov-err"></span>
              </label>`,
              current: 'bx-ov',
              hint: '有給・在宅・年末年始などで、この期間だけ回数が違うときに入れます。空にすると元に戻ります。',
            })
          : overrideSection(period, {
              field: yenField('bx-ov', 'この期間に払う額', line.overridden ? num(line.amount) : '', `placeholder="変えない（${num(line.baseAmount)}）"`),
              current: 'bx-ov',
              hint: '光熱費の増減など、この期間だけ額が違うときに入れます。空にすると元に戻ります。',
            });
    }
    openSheet(`
    ${sheetHead(it ? '固定費を編集' : '固定費を追加')}
    <form id="b-fixed-form" class="bform" novalidate data-id="${esc(id || '')}" data-kind="${kind}" data-by="${u.by}" data-mode="${it?.mode ?? 'lump'}" data-period="${esc(period.key)}">
      ${
        it
          ? `<p class="kind-fixed"><span class="tag">${kind === 'uses' ? '単価×回数' : kind === 'periodic' ? `${it.every}か月ごと` : '毎月'}</span></p>`
          : segField('kind', '種類', [['monthly', '毎月'], ['periodic', '◯か月ごと'], ['uses', '単価×回数']], kind)
      }
      ${textField('bx-name', '名前', it?.name ?? '', kind === 'uses' ? '例：昼食' : '例：家賃')}
      ${selectField('bx-cat', 'カテゴリ', FIXED_CATEGORIES.map((c) => [c.key, c.label]), it?.category ?? 'other')}
      ${yenField('bx-amount', '<span data-show-kind="monthly">毎月の金額</span><span data-show-kind="periodic">1回に払う額</span><span data-show-kind="uses">1回あたりの単価</span>', it ? num(it.amount) : '')}
      <div data-show-kind="periodic">
        ${selectField('bx-every', '払う間隔', EVERY_CHOICES.map((n) => [n, `${n}か月ごと`]), it?.every ?? 12)}
        ${segField('mode', '入れ方', [['lump', '払う月にまとめて'], ['spread', '月割りで積み立て']], it?.mode ?? 'lump')}
        <div data-show-mode="lump">
          ${selectField('bx-month', '払う月（2〜6か月ごとなら、最初の月）', monthOptions, it?.dueMonth ?? 1)}
          ${selectField('bx-day', '払う日（月末を超える日は月末）', dayOptions(), it?.dueDay ?? 1)}
        </div>
      </div>
      <div data-show-kind="uses">
        ${segField('by', '回数の数え方', [['weekdays', '曜日で数える'], ['count', '回数を決める']], u.by)}
        ${chipsField('days', '曜日', WEEK.map((w, i) => [i, w]), u.days, 'data-show-by="weekdays"', 'bx-days-err')}
        ${switchRow('bx-skip', '祝日を除く', u.skipHolidays, '', 'data-show-by="weekdays"')}
        <label class="field" data-show-by="count">
          <span class="field-label">期間あたりの回数</span>
          <span class="input-wrap"><input class="input" id="bx-count" data-yen inputmode="numeric" autocomplete="off" value="${u.count ? u.count : ''}"><span class="suffix">回</span></span>
          <span class="field-error" id="bx-count-err"></span>
        </label>
      </div>
      <div class="preview" id="bx-preview"></div>
      ${switchRow('bx-enabled', '計算に含める', it?.enabled !== false, 'オフにすると、どの合計にも入りません。')}
      ${override}
      <button type="submit" class="btn btn-primary btn-block">${submitLabel(it)}</button>
      ${it ? deleteButton('b-fixed-delete', it.id) : ''}
    </form>`);
    refreshForm($('#b-fixed-form'));
    calmEnter($('#b-fixed-form'));
  }

  function readFixedForm(form) {
    const kind = form.dataset.kind;
    const by = form.dataset.by;
    const errors = {};
    const name = $('#bx-name').value.trim();
    if (!name) errors['bx-name'] = '名前を入れてください';
    const amount = readYen('bx-amount', { min: 1, label: kind === 'uses' ? '単価' : '金額' });
    if (amount.error) errors['bx-amount'] = amount.error;
    const days = chipValues(form, 'days');
    let count = 0;
    if (kind === 'uses') {
      if (by === 'weekdays' && !days.length) errors['bx-days'] = '曜日を1つ以上選んでください';
      if (by === 'count') {
        const c = readYen('bx-count', { required: false, max: 366, unit: '回' });
        if (c.error) errors['bx-count'] = c.error;
        else count = c.value ?? 0;
      }
    }
    let override;
    if ($('#bx-ov')) {
      const ov = readYen('bx-ov', { required: false, ...(kind === 'uses' ? { max: 366, unit: '回' } : {}) });
      if (ov.error) errors['bx-ov'] = ov.error;
      else override = ov.value;
    }
    const item = {
      id: 'draft',
      name,
      category: $('#bx-cat').value,
      kind,
      amount: amount.value ?? 0,
      every: Number($('#bx-every').value) || 12,
      dueMonth: Number($('#bx-month').value) || 1,
      dueDay: Number($('#bx-day').value) || 1,
      mode: form.dataset.mode,
      uses: { by, days, skipHolidays: $('#bx-skip').checked, count },
      enabled: $('#bx-enabled').checked,
    };
    return { values: { item, override }, errors };
  }

  function updateFixedPreview(form, errors) {
    const box = $('#bx-preview');
    if (errors['bx-amount'] || errors['bx-days'] || errors['bx-count']) {
      box.innerHTML = '';
      return;
    }
    const { item } = readFixedForm(form).values;
    const data = getData();
    const period = periodByKey(form.dataset.period);
    const tmp = { ...data, budget: { ...data.budget, fixed: [item], overrides: {} } };
    const line = fixedLines(tmp, period).find((l) => l.id === 'draft');
    const range = `${md(period.start)}〜${md(period.end)}`;
    let text = '';
    if (item.kind === 'uses') {
      text = `${range} の回数：<strong>${line.count}回</strong> → <strong>${yen(line.amount)}</strong>`;
    } else if (item.kind === 'periodic') {
      if (item.mode === 'spread') text = `毎期 <strong>${yen(line.amount)}</strong> ずつ積み立てます（${yen(item.amount)} ÷ ${item.every}）。`;
      else text = `払う月：${monthsText(dueMonths(item))}。${line ? `${range} に <strong>${yen(line.amount)}</strong> 払います。` : `${range} は払いません。`}`;
    }
    box.innerHTML = text;
  }

  function submitFixed(form) {
    const { values: v, errors } = readFixedForm(form);
    form.dataset.submitted = '1';
    refreshForm(form);
    if (Object.keys(errors).length) return;
    const b = getData().budget;
    const now = nowISO();
    const id = form.dataset.id;
    const { item: d } = v;
    let item = id ? b.fixed.find((x) => x.id === id) : null;
    const fields = { name: d.name, category: d.category, amount: d.amount, every: d.every, dueMonth: d.dueMonth, dueDay: d.dueDay, mode: d.mode, uses: d.uses, enabled: d.enabled, updatedAt: now };
    if (item) Object.assign(item, fields);
    else {
      item = { id: uid(), kind: d.kind, ...fields, createdAt: now };
      b.fixed.push(item);
    }
    if (v.override !== undefined) setOverride(item.kind === 'uses' ? 'uses' : 'fixed', form.dataset.period, item.id, v.override);
    commit(id ? '保存しました' : `${d.name} を追加しました`);
  }

  async function deleteFixed(id) {
    const b = getData().budget;
    const it = b.fixed.find((x) => x.id === id);
    if (!it) return;
    const ok = await confirmDialog({ title: `${it.name} を削除しますか？`, message: '「この期間だけ変える」で入れた金額も消えます。元には戻せません。', okLabel: '削除する', danger: true });
    if (!ok) return;
    b.fixed = b.fixed.filter((x) => x.id !== id);
    dropOverrides(id);
    commit('削除しました');
  }

  // ---- 貯金の取り分 ----

  function openSavingsForm() {
    const v = settings().savings;
    openSheet(`
    ${sheetHead('貯金の取り分')}
    <form id="b-savings-form" class="bform" novalidate data-smode="${v.mode}" data-period="${esc(currentPeriod().key)}">
      ${segField('smode', '決め方', [['amount', '金額で決める'], ['percent', '収入の◯%']], v.mode)}
      <label class="field">
        <span class="field-label"><span data-show-smode="amount">毎月の金額</span><span data-show-smode="percent">収入の何%か（0〜100）</span></span>
        <span class="input-wrap"><input class="input" id="bs-value" data-yen inputmode="numeric" autocomplete="off" enterkeyhint="done" placeholder="0" value="${v.value ? num(v.value) : ''}"><span class="suffix"><span data-show-smode="amount">円</span><span data-show-smode="percent">%</span></span></span>
        <span class="field-error" id="bs-value-err"></span>
      </label>
      <div class="preview" id="bs-preview"></div>
      <button type="submit" class="btn btn-primary btn-block">保存する</button>
    </form>`);
    refreshForm($('#b-savings-form'));
    calmEnter($('#b-savings-form'));
  }

  function readSavingsForm(form) {
    const mode = form.dataset.smode;
    const errors = {};
    const r = readYen('bs-value', { required: false, ...(mode === 'percent' ? { max: 100, unit: '%' } : {}) });
    if (r.error) errors['bs-value'] = r.error;
    return { values: { mode, value: r.value ?? 0 }, errors };
  }

  function updateSavingsPreview(form, errors) {
    const box = $('#bs-preview');
    if (errors['bs-value']) {
      box.innerHTML = '';
      return;
    }
    const { values } = readSavingsForm(form);
    const income = periodAmounts(getData(), periodByKey(form.dataset.period)).income;
    box.innerHTML = `この期間の貯金の取り分：<strong>${yen(savingsOf({ savings: values }, income))}</strong>`;
  }

  function submitSavings(form) {
    const { values, errors } = readSavingsForm(form);
    form.dataset.submitted = '1';
    refreshForm(form);
    if (Object.keys(errors).length) return;
    settings().savings = { mode: values.mode, value: values.value };
    commit('保存しました');
  }

  // =====================================================================
  // 操作の受け付け（app.js から呼ばれる）
  // =====================================================================

  /** 積み上げ棒の中の割合ラベルを、入りきるものだけ出す（切れた文字は出さない） */
  function afterRender() {
    for (const block of $$('.sbar-block')) {
      const label = $('.sbar-label', block);
      if (!label) continue;
      label.hidden = false;
      if (label.offsetWidth + 16 > block.clientWidth) label.hidden = true;
    }
  }

  function go(sub) {
    if (sub !== state.sub) historyView.reset();
    state.sub = sub;
    setPref('budget-tab', sub);
    rerender();
    window.scrollTo(0, 0);
  }

  /** @returns {boolean} この操作を処理したら true */
  function onAction(btn) {
    const id = btn.dataset.id;
    switch (btn.dataset.action) {
      case 'b-sub':
        go(btn.dataset.key);
        return true;
      case 'b-prev':
      case 'b-next':
        state.offset = Math.min(MAX_OFFSET, Math.max(-MAX_OFFSET, state.offset + (btn.dataset.action === 'b-next' ? 1 : -1)));
        rerender();
        return true;
      case 'b-now':
        state.offset = 0;
        rerender();
        return true;
      case 'b-part': {
        const box = $('#bar-readout');
        if (box) box.textContent = btn.dataset.text;
        return true;
      }
      case 'b-payday':
        openPaydayForm();
        return true;
      case 'b-income-add':
        openIncomeForm();
        return true;
      case 'b-income-edit':
        openIncomeForm(id);
        return true;
      case 'b-income-delete':
        deleteIncome(id);
        return true;
      case 'b-entry-add':
        openEntryForm();
        return true;
      case 'b-entry-edit':
        openEntryForm(id);
        return true;
      case 'b-entry-delete':
        deleteEntry(id);
        return true;
      case 'b-fixed-add':
        openFixedForm();
        return true;
      case 'b-fixed-edit':
        openFixedForm(id);
        return true;
      case 'b-fixed-delete':
        deleteFixed(id);
        return true;
      case 'b-savings-edit':
        openSavingsForm();
        return true;
      case 'b-seg': {
        const form = btn.closest('form');
        for (const b of $$('[data-action="b-seg"]', btn.parentElement)) b.setAttribute('aria-pressed', String(b === btn));
        form.dataset[btn.dataset.name] = btn.dataset.v;
        refreshForm(form);
        return true;
      }
      case 'b-chip':
        btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
        refreshForm(btn.closest('form'));
        return true;
      case 'b-ov-clear': {
        const input = $(`#${btn.dataset.target}`);
        if (input) {
          input.value = '';
          input.focus();
          refreshForm(input.closest('form'));
        }
        return true;
      }
      default:
        return spends.onAction(btn) || historyView.onAction(btn) || whatifView.onAction(btn);
    }
  }

  /** @returns {boolean} 家計のフォームなら true */
  function onSubmit(form) {
    const spec = FORMS[form.id];
    if (!spec) return false;
    spec.submit(form);
    return true;
  }

  /** 入力のたびに呼ばれる。@returns {boolean} 家計の入力欄なら true */
  function onInput(t) {
    if (t.id === 'bz-extra') {
      const v = parseYen(t.value);
      if (v !== null && (Number.isNaN(v) || v > BUDGET_LIMITS.yen)) {
        setError(t.id, '数字で入れてください（例：50000 または 5万）');
        return true;
      }
      setError(t.id, '');
      const data = getData();
      data.plan.monthlyExtra = v ?? 0;
      persist();
      const box = $('#b-totals');
      if (box) box.innerHTML = totalsHtml(periodAmounts(data, currentPeriod()));
      return true;
    }
    const form = t.closest?.('.bform');
    if (!form) return false;
    refreshForm(form);
    return true;
  }

  return { html, afterRender, onAction, onSubmit, onInput, onChange: onInput, closePeriods };
}
