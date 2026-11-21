// 家計タブ「もしも」の画面：変更を重ねて、自由に使える額（と、返済の完済時期・利息）がどう変わるかを試す
//
// 計算は js/budget.js の whatIf を呼ぶだけにして、ここには書かない（ここにあるのは、表示用の整形と、入力の読み取りだけ）。
// 画面の作り方は budget-spends.js と同じ：data-action は "b-" で始める、フォームは FORMS の表（budget-view.js の FORMS に、ここの forms を足す）、
// ユーザーの文字は必ず esc() でエスケープする。
//
// 実際のデータは変えない。試している変更（changes）は、この中のメモリにだけあり、保存しない（アプリを閉じる・データを読み込み直す・消すと、なくなる）。
// だから、家計のデータを変えるときに通す commit() は使わない。「実際に反映する」ボタンも作らない（実際に変えたいときは「収支」で直接変える）。
// budget-view.js が createWhatIfView() を呼んで、「もしも」の小タブに組み込む。

import { esc, num, yen, duration, monthLabel } from './format.js';
import { activeDebts, isBudgetEmpty, whatIf } from './budget.js';
import { icon } from './icons.js';
import { closeSheet, confirmDialog, openSheet, sheetHead, toast, yenField } from './ui.js';

const $ = (sel, root = document) => root.querySelector(sel);

const TARGET_LABEL = { income: '収入', fixed: '固定費' };

/** 「毎月の金額」など、項目の金額が何の金額か */
function amountLabel(target, it) {
  if (target === 'income') return it.kind === 'months' ? '1回の支給額' : '毎月の金額';
  if (it.kind === 'uses') return '1回あたりの単価';
  if (it.kind === 'periodic') return '1回に払う額';
  return '毎月の金額';
}

/** 増減の見せ方：＋／−・矢印・言葉（色だけに頼らない） */
const signed = (v) => (v > 0 ? `+${num(v)}円` : v < 0 ? `−${num(-v)}円` : '0円');
const dir = (v) => (v > 0 ? { cls: 'is-up', ic: 'arrow-up', word: '増えます' } : v < 0 ? { cls: 'is-down', ic: 'arrow-down', word: '減ります' } : { cls: '', ic: 'minus', word: '変わりません' });

/**
 * @param {object} deps
 * @param {() => object} deps.getData
 * @param {() => object} deps.currentPeriod   今見ている期間
 * @param {() => void} deps.rerender
 * @param {object} deps.kit   budget-view.js と共有する表示の部品
 */
export function createWhatIfView({ getData, currentPeriod, rerender, kit }) {
  const { textField, segField, readYen, md, refreshForm, calmEnter, periodNav, emptyGuideHtml } = kit;

  let changes = []; // 試している変更。{ n, type, target, id, amount | item | value }（budget.js の whatIf の形に n を足したもの）
  let seq = 0;
  let boundTo = null; // この変更が作られたときのデータ（読み込み直した・消したときは、変更も捨てる）

  const findItem = (data, target, id) => (target === 'income' ? data.budget.incomes : data.budget.fixed).find((x) => x.id === id);
  const itemList = (data) => [
    ...data.budget.incomes.filter((x) => x.enabled !== false).map((item) => ({ target: 'income', item })),
    ...data.budget.fixed.filter((x) => x.enabled !== false).map((item) => ({ target: 'fixed', item })),
  ];

  /** 今のデータに合う変更だけ（試している間に、項目が消された・返済がなくなったときは、その変更を捨てる） */
  function liveChanges(data) {
    if (boundTo !== data) {
      changes = [];
      boundTo = data;
    }
    changes = changes.filter((c) => {
      if (c.type === 'add') return true;
      if (c.type === 'extra') return activeDebts(data).length > 0;
      return !!findItem(data, c.target, c.id);
    });
    return changes;
  }

  // =====================================================================
  // 画面
  // =====================================================================

  /** 変更の説明。html が true なら画面用（名前は esc、数字は太字）、false なら読み上げ用の文字 */
  function describe(data, c, html) {
    const t = (v) => (html ? esc(v) : v);
    const b = (v) => (html ? `<strong class="nobr">${esc(v)}</strong>` : v); // 数字と「円」の間で折り返さない
    const y = (v) => (html ? `<span class="nobr">${yen(v)}</span>` : yen(v));
    if (c.type === 'extra') return `返済への上乗せ：${y(data.plan.monthlyExtra)} → ${b(yen(c.value))}`;
    if (c.type === 'add') return `仮の${TARGET_LABEL[c.target]}「${t(c.item.name)}」毎月 ${b(yen(c.item.amount))} を足す`;
    const it = findItem(data, c.target, c.id);
    if (c.type === 'off') return `${t(it.name)}（${TARGET_LABEL[c.target]}）をオフにする`;
    return `${t(it.name)}（${TARGET_LABEL[c.target]}）の${amountLabel(c.target, it)}：${y(it.amount)} → ${b(yen(c.amount))}`;
  }

  /** 完済時期と利息の比べ（返済への上乗せを変えたとき） */
  function planHtml(plan) {
    const fin = (s) => (s.finished ? `${duration(s.months)}（${monthLabel(s.months)}ごろ）` : '完済できません');
    let monthsDiff = '';
    if (plan.monthsSaved !== null) {
      monthsDiff =
        plan.monthsSaved > 0
          ? `<span class="wi-diff">${icon('arrow-down')}${duration(plan.monthsSaved)} 早まります</span>`
          : plan.monthsSaved < 0
            ? `<span class="wi-diff">${icon('arrow-up')}${duration(-plan.monthsSaved)} 遅くなります</span>`
            : `<span class="wi-diff">${icon('minus')}変わりません</span>`;
    }
    let interestDiff = '';
    if (plan.interestSaved !== null) {
      interestDiff =
        plan.interestSaved > 0
          ? `<span class="wi-diff">${icon('arrow-down')}<span class="nobr">−${yen(plan.interestSaved)}</span>（減ります）</span>`
          : plan.interestSaved < 0
            ? `<span class="wi-diff">${icon('arrow-up')}<span class="nobr">+${yen(-plan.interestSaved)}</span>（増えます）</span>`
            : `<span class="wi-diff">${icon('minus')}変わりません</span>`;
    }
    return `
    <h3 class="sub-title">返済への影響</h3>
    <p class="hint mb-8">返済への上乗せを <span class="nobr">${yen(plan.before.monthlyExtra)}</span> → <strong class="nobr">${yen(plan.after.monthlyExtra)}</strong> にしたときの、おすすめの返し方どうしの比べです。</p>
    <dl class="wi-plan">
      <div><dt>全社を完済するまで</dt><dd id="wi-plan-months">${fin(plan.before)} → <strong>${fin(plan.after)}</strong>${monthsDiff}</dd></div>
      <div><dt>これから払う利息の合計</dt><dd id="wi-plan-interest">${plan.before.finished ? yen(plan.before.totalInterest) : '—'} → <strong>${plan.after.finished ? yen(plan.after.totalInterest) : '—'}</strong>${interestDiff}</dd></div>
    </dl>`;
  }

  function resultHtml(res, count, period) {
    if (!count) {
      return `
      <section class="card" id="wi-result">
        <h2 class="card-title">自由に使える額の変化</h2>
        <p class="empty-text">下の「変更を足す」から、固定費や収入、返済への上乗せを変えてみてください。結果がここに出ます。</p>
      </section>`;
    }
    const dp = dir(res.perPeriod);
    const dy = dir(res.perYear);
    const negative = res.changed.free < 0;
    const money = (v) => `${v < 0 ? '−' : ''}${yen(Math.abs(v))}`;
    return `
    <section class="card" id="wi-result">
      <h2 class="card-title">自由に使える額の変化</h2>
      <div class="wi-row">
        <div class="wi-label">この期間（${md(period.start)}〜${md(period.end)}）</div>
        <div class="wi-delta ${dp.cls}" id="wi-period">${icon(dp.ic)}${signed(res.perPeriod)}</div>
        <div class="wi-word">${dp.word}</div>
      </div>
      <div class="wi-row">
        <div class="wi-label">1年あたり（この期から12期分の合計）</div>
        <div class="wi-delta wi-delta-sm ${dy.cls}" id="wi-year">${icon(dy.ic)}${signed(res.perYear)}</div>
        <div class="wi-word">${dy.word}</div>
      </div>
      <p class="wi-ba">この期間の自由に使える額：<span class="nobr">${money(res.base.free)}</span> → <strong class="nobr" id="wi-after">${money(res.changed.free)}</strong></p>
      ${negative ? `<p class="warn" role="alert">${icon('alert')}<span>この変更だと、この期間の自由に使える額が <span class="nobr">${yen(-res.changed.free)}</span> のマイナスになります。</span></p>` : ''}
      ${res.plan ? planHtml(res.plan) : ''}
    </section>`;
  }

  function changesHtml(data, list) {
    const rows = list
      .map(
        (c) => `
      <li class="wi-change">
        <span class="wi-change-text">${describe(data, c, true)}</span>
        <button type="button" class="icon-btn" data-action="b-wi-remove" data-n="${c.n}" aria-label="${esc(`この変更をやめる：${describe(data, c, false)}`)}">${icon('close')}</button>
      </li>`,
      )
      .join('');
    const hasItems = itemList(data).length > 0;
    const hasDebts = activeDebts(data).length > 0;
    return `
    <section class="card" id="wi-changes">
      <h2 class="card-title">試している変更${list.length ? `（${list.length}件）` : ''}</h2>
      <p class="card-sub">いくつでも重ねられます。変更は、実際のデータには反映されません。</p>
      ${list.length ? `<ul class="wi-list">${rows}</ul>` : '<p class="empty-text">まだ変更はありません。</p>'}
      <h3 class="sub-title">変更を足す</h3>
      <div class="wi-add">
        <button type="button" class="btn btn-block" data-action="b-wi-amount" ${hasItems ? '' : 'disabled'}>${icon('edit')}項目の金額を変える</button>
        <button type="button" class="btn btn-block" data-action="b-wi-off" ${hasItems ? '' : 'disabled'}>${icon('minus')}項目をオフにする</button>
        <button type="button" class="btn btn-block" data-action="b-wi-add">${icon('plus')}仮の項目を足す</button>
        <button type="button" class="btn btn-block" data-action="b-wi-extra" ${hasDebts ? '' : 'disabled'}>${icon('wallet')}返済への上乗せを変える</button>
      </div>
      ${hasItems ? '' : '<p class="hint">金額を変えられる収入・固定費が、まだ入っていません。「収支」で入れるか、「仮の項目を足す」を使えます。</p>'}
      ${hasDebts ? '' : '<p class="hint">返済中の会社がないので、返済への上乗せは変えられません。</p>'}
      ${list.length ? '<button type="button" class="btn btn-block mt-12" data-action="b-wi-clear">試した変更をすべてやめる</button>' : ''}
      <p class="hint">実際に変えたいときは、「収支」で直接変えてください。<button type="button" class="link-btn" data-action="b-sub" data-key="items">収支へ</button></p>
    </section>`;
  }

  function html() {
    const data = getData();
    if (isBudgetEmpty(data.budget)) return emptyGuideHtml();
    const period = currentPeriod();
    const list = liveChanges(data);
    const res = whatIf(data, list.map(({ n, ...c }) => c), period);
    return `
    ${periodNav(period)}
    <p class="note wi-intro">${icon('info')}<span>実際のデータは変わりません。ここで試した変更は保存されず、アプリを閉じると消えます。</span></p>
    ${resultHtml(res, list.length, period)}
    ${changesHtml(data, list)}`;
  }

  // =====================================================================
  // 変更を足すシート
  // =====================================================================

  const itemSelect = (id, list) => {
    const group = (target) => {
      const opts = list.filter((x) => x.target === target).map((x) => `<option value="${target}:${esc(x.item.id)}">${esc(x.item.name)}</option>`);
      return opts.length ? `<optgroup label="${TARGET_LABEL[target]}">${opts.join('')}</optgroup>` : '';
    };
    return `<select class="input" id="${id}">${group('income')}${group('fixed')}</select>`;
  };
  const readItem = (id) => {
    const [target, ...rest] = $(`#${id}`).value.split(':');
    return { target, id: rest.join(':') };
  };

  /** 同じ項目への、前の「金額を変える」「オフにする」は、新しい変更で置き換える */
  const addChange = (c, message = '変更を足しました（実際のデータは変わりません）') => {
    if (c.type === 'amount' || c.type === 'off') changes = changes.filter((x) => !(x.id === c.id && x.target === c.target && (x.type === 'amount' || x.type === 'off')));
    if (c.type === 'extra') changes = changes.filter((x) => x.type !== 'extra');
    changes.push({ n: ++seq, ...c });
    closeSheet();
    rerender();
    toast(message);
  };

  // 金額を変える
  function openAmountForm() {
    const list = itemList(getData());
    if (!list.length) return;
    openSheet(`
    ${sheetHead('項目の金額を変える')}
    <form id="b-wi-amount-form" class="bform" novalidate>
      <label class="field"><span class="field-label">項目</span>${itemSelect('wa-item', list)}</label>
      ${yenField('wa-amount', '新しい金額', '')}
      <div class="preview" id="wa-preview"></div>
      <p class="hint mb-8">実際のデータは変わりません。試すだけです。</p>
      <button type="submit" class="btn btn-primary btn-block">この変更を試す</button>
    </form>`);
    refreshForm($('#b-wi-amount-form'));
    calmEnter($('#b-wi-amount-form'));
  }
  function readAmountForm() {
    const errors = {};
    const amount = readYen('wa-amount', { min: 0, label: '新しい金額' });
    if (amount.error) errors['wa-amount'] = amount.error;
    return { values: { ...readItem('wa-item'), amount: amount.value }, errors };
  }
  function previewAmount() {
    const { target, id } = readItem('wa-item');
    const it = findItem(getData(), target, id);
    const field = $('#wa-amount').closest('.field');
    if (!it) return;
    $('.field-label', field).textContent = `新しい${amountLabel(target, it)}`;
    $('#wa-preview').innerHTML = `今の${amountLabel(target, it)}：<strong>${yen(it.amount)}</strong>`;
  }
  function submitAmount(form) {
    const { values: v, errors } = readAmountForm();
    form.dataset.submitted = '1';
    refreshForm(form);
    if (Object.keys(errors).length) return;
    addChange({ type: 'amount', target: v.target, id: v.id, amount: v.amount });
  }

  // オフにする
  function openOffForm() {
    const list = itemList(getData());
    if (!list.length) return;
    openSheet(`
    ${sheetHead('項目をオフにする')}
    <form id="b-wi-off-form" class="bform" novalidate>
      <label class="field"><span class="field-label">オフにする項目</span>${itemSelect('wo-item', list)}</label>
      <div class="preview" id="wo-preview"></div>
      <p class="hint mb-8">オフにすると、その項目は計算に入りません（実際のデータは変わりません）。</p>
      <button type="submit" class="btn btn-primary btn-block">この変更を試す</button>
    </form>`);
    refreshForm($('#b-wi-off-form'));
    calmEnter($('#b-wi-off-form'));
  }
  function previewOff() {
    const { target, id } = readItem('wo-item');
    const it = findItem(getData(), target, id);
    if (it) $('#wo-preview').innerHTML = `今の${amountLabel(target, it)}：<strong>${yen(it.amount)}</strong>`;
  }
  function submitOff() {
    const { target, id } = readItem('wo-item');
    addChange({ type: 'off', target, id });
  }

  // 仮の項目を足す（毎月の収入・固定費）
  function openAddForm() {
    if (changes.filter((c) => c.type === 'add').length >= 20) {
      toast('仮の項目は20件までです');
      return;
    }
    openSheet(`
    ${sheetHead('仮の項目を足す')}
    <form id="b-wi-add-form" class="bform" novalidate data-wkind="fixed">
      ${segField('wkind', '種類', [['fixed', '固定費'], ['income', '収入']], 'fixed')}
      ${textField('wd-name', '名前', '', '例：習い事')}
      ${yenField('wd-amount', '毎月の金額', '')}
      <p class="hint mb-8">毎月かかる（入る）ものとして、足して試します。実際のデータには入りません。</p>
      <button type="submit" class="btn btn-primary btn-block">この変更を試す</button>
    </form>`);
    refreshForm($('#b-wi-add-form'));
    calmEnter($('#b-wi-add-form'));
  }
  function readAddForm(form) {
    const errors = {};
    const name = $('#wd-name').value.trim();
    if (!name) errors['wd-name'] = '名前を入れてください';
    const amount = readYen('wd-amount', { min: 1, label: '金額' });
    if (amount.error) errors['wd-amount'] = amount.error;
    return { values: { target: form.dataset.wkind === 'income' ? 'income' : 'fixed', name, amount: amount.value }, errors };
  }
  function submitAdd(form) {
    const { values: v, errors } = readAddForm(form);
    form.dataset.submitted = '1';
    refreshForm(form);
    if (Object.keys(errors).length) return;
    const base = { name: v.name, kind: 'monthly', amount: v.amount, enabled: true };
    const item =
      v.target === 'income'
        ? { ...base, months: [], day: 1 }
        : { ...base, category: 'other', every: 12, dueMonth: 1, dueDay: 1, mode: 'lump', uses: { by: 'weekdays', days: [1, 2, 3, 4, 5], skipHolidays: true, count: 0 } };
    addChange({ type: 'add', target: v.target, item });
  }

  // 返済への上乗せを変える
  function openExtraForm() {
    const data = getData();
    if (!activeDebts(data).length) return;
    openSheet(`
    ${sheetHead('返済への上乗せを変える')}
    <form id="b-wi-extra-form" class="bform" novalidate>
      ${yenField('we-value', '新しい毎月の上乗せ額', '')}
      <div class="preview" id="we-preview">今の上乗せ：<strong>${yen(data.plan.monthlyExtra)}</strong>（提案の「毎月の余剰金」と同じ値）</div>
      <p class="hint mb-8">自由に使える額と、完済の時期・利息がどう変わるかを試します。実際の値は変わりません。</p>
      <button type="submit" class="btn btn-primary btn-block">この変更を試す</button>
    </form>`);
    refreshForm($('#b-wi-extra-form'));
    calmEnter($('#b-wi-extra-form'));
  }
  function readExtraForm() {
    const errors = {};
    const v = readYen('we-value', { min: 0, label: '上乗せ額' });
    if (v.error) errors['we-value'] = v.error;
    return { values: { value: v.value }, errors };
  }
  function submitExtra(form) {
    const { values, errors } = readExtraForm();
    form.dataset.submitted = '1';
    refreshForm(form);
    if (Object.keys(errors).length) return;
    addChange({ type: 'extra', value: values.value });
  }

  async function clearAll() {
    const ok = await confirmDialog({ title: '試した変更をすべてやめますか？', message: '実際のデータは変わりません。', okLabel: 'すべてやめる' });
    if (!ok) return;
    changes = [];
    rerender();
  }

  /** @returns {boolean} この操作を処理したら true */
  function onAction(btn) {
    switch (btn.dataset.action) {
      case 'b-wi-amount':
        openAmountForm();
        return true;
      case 'b-wi-off':
        openOffForm();
        return true;
      case 'b-wi-add':
        openAddForm();
        return true;
      case 'b-wi-extra':
        openExtraForm();
        return true;
      case 'b-wi-remove':
        changes = changes.filter((c) => c.n !== Number(btn.dataset.n));
        rerender();
        return true;
      case 'b-wi-clear':
        clearAll();
        return true;
      default:
        return false;
    }
  }

  return {
    html,
    onAction,
    /** budget-view.js の FORMS に足すフォームの設定 */
    forms: {
      'b-wi-amount-form': { read: readAmountForm, submit: submitAmount, ids: ['wa-amount'], preview: previewAmount },
      'b-wi-off-form': { read: () => ({ values: {}, errors: {} }), submit: submitOff, ids: [], preview: previewOff },
      'b-wi-add-form': { read: readAddForm, submit: submitAdd, ids: ['wd-name', 'wd-amount'] },
      'b-wi-extra-form': { read: readExtraForm, submit: submitExtra, ids: ['we-value'] },
    },
  };
}
