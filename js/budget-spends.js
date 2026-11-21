// 家計タブ「今月」の出費の画面：今日あと・出費の記録・一覧・カテゴリ別の内訳
//
// 計算は js/budget.js の関数（todayGuide・spendsByDay・spendsByCategory）を呼ぶだけにして、ここには書かない。
// 画面の作り方は budget-view.js と同じ：data-action は "b-" で始める、ユーザーの文字は必ず esc() でエスケープする、
// 家計のデータを変えたら commit() を通す（確定した期間の出費を直したときの履歴の同期も、commit の中で動く）。
// budget-view.js が createSpendsView() を呼んで、「今月」の画面に組み込む。

import { esc, num, yen, todayISO } from './format.js';
import { isValidISO, weekday } from './dates.js';
import { SPEND_CATEGORIES, periodOf, spendCategoryLabel, spendsByCategory, spendsByDay, todayGuide } from './budget.js';
import { BUDGET_LIMITS, uid } from './storage.js';
import { icon } from './icons.js';
import { confirmDialog, openSheet, sheetHead, toast, yenField } from './ui.js';

const PAGE = 100; // 一覧に一度に出す件数（これを超えたら「もっと見る」）
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * @param {object} deps
 * @param {() => object} deps.getData
 * @param {() => object} deps.currentPeriod    今見ている期間
 * @param {(message?: string, opts?: {keep?: boolean}) => boolean} deps.commit   家計のデータの保存（keep なら、シートを閉じない）
 * @param {() => void} deps.rerender
 * @param {object} deps.kit   budget-view.js と共有する表示の部品
 */
export function createSpendsView({ getData, currentPeriod, commit, rerender, kit }) {
  const { textField, readYen, md, money, moneyYen, brow, shares, pctText, nowISO, refreshForm } = kit;

  // 「もっと見る」で増やした件数（見ている期間ごと。期間を変えたら100件に戻る）
  let more = { key: '', limit: PAGE };
  const limitFor = (key) => (more.key === key ? more.limit : PAGE);

  const dayText = (iso) => `${md(iso)}（${WEEK[weekday(iso)]}）`;

  // =====================================================================
  // 今日あと・使った額・余り
  // =====================================================================

  /** 今日あと／明日以降／残り日数／使った額／余り、と「＋ 出費を記録」。今日が見ている期間の外なら、使った額と余りだけ */
  function summaryHtml(a, period) {
    const g = todayGuide(getData(), todayISO(), period);
    const overLeft = a.leftover < 0;

    const stat = (label, value, sub = '', neg = false) => `
      <div class="stat">
        <div class="stat-label">${label}</div>
        <div class="stat-value ${neg ? 'is-neg' : ''}">${neg ? icon('alert') : ''}${value}</div>
        ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
      </div>`;

    const spentStat = stat('使った額', yen(a.spent));
    const leftStat = stat('余り', moneyYen(a.leftover), overLeft ? `${yen(-a.leftover)}オーバー` : '', overLeft);

    let top;
    let stats;
    if (g) {
      const over = g.todayLeft < 0;
      const tomorrow = g.tomorrowPerDay === null ? '—' : yen(g.tomorrowPerDay);
      // 使いすぎのあとの一言（責めない）。余りがなければ、明日以降の目安が0円なことだけを伝える
      const tail = g.tomorrowPerDay === null ? '' : g.tomorrowPerDay > 0 ? `明日以降は、1日あたり ${yen(g.tomorrowPerDay)} でならせます。` : 'この期間の余りがないため、明日以降の目安は 0円 です。';
      top = `
      <div class="hero-label">今日あと</div>
      <div class="today-value ${over ? 'is-neg' : ''}" id="today-left">${over ? icon('alert') : ''}${money(g.todayLeft)}<span class="unit">円</span></div>
      <p class="today-note">${
        over
          ? `今日は、目安の ${yen(g.todayBudget)} より ${yen(-g.todayLeft)} 多く使っています。${tail}`
          : `今日の目安 ${yen(g.todayBudget)} のうち ${yen(g.todaySpent)} 使いました。`
      }</p>`;
      stats = [
        stat('明日以降の1日あたり', tomorrow, g.tomorrowPerDay === null ? '今日が最終日です' : '余りを日割りした額'),
        stat('残り日数', `${g.daysLeft}日`, '今日を含みます'),
        spentStat,
        leftStat,
      ].join('');
    } else {
      top = `
      <h2 class="card-title">この期間の出費</h2>
      <p class="card-sub">今日はこの期間に入っていないので、「今日あと」は出しません。</p>`;
      stats = [spentStat, leftStat].join('');
    }

    return `
    <section class="card today-card" id="today-card">
      ${top}
      <div class="stats">${stats}</div>
      <button type="button" class="btn btn-primary btn-block mt-12" data-action="b-spend-add">${icon('plus')}出費を記録</button>
      <p class="hint">昼食など、固定費（単価×回数）に入れたものは、出費として記録しなくて大丈夫です。</p>
    </section>`;
  }

  // =====================================================================
  // 出費の一覧（日ごと）
  // =====================================================================

  function listHtml(a, period) {
    const { days, count, shown } = spendsByDay(getData().budget, period, limitFor(period.key));
    const today = todayISO();
    let body;
    if (!count) {
      body = '<p class="empty-text">この期間の出費は、まだありません。</p>';
    } else {
      body = days
        .map((d) => {
          const rows = d.items
            .map((s) => {
              const cat = spendCategoryLabel(s.category);
              return brow({
                attrs: `data-action="b-spend-edit" data-id="${esc(s.id)}"`,
                name: esc(s.memo || cat),
                sub: s.memo ? esc(cat) : '',
                amount: yen(s.amount),
              });
            })
            .join('');
          return `
          <div class="day-head"><span class="day-name">${dayText(d.date)}${d.date === today ? '<span class="tag accent">今日</span>' : ''}</span><span class="day-total">${yen(d.total)}</span></div>
          <div class="brow-list">${rows}</div>`;
        })
        .join('');
      if (shown < count) body += `<button type="button" class="btn btn-block mt-12" data-action="b-spend-show-more">もっと見る（あと${count - shown}件）</button>`;
    }
    return `
    <section class="card" id="spend-list">
      <h2 class="card-title">出費の一覧</h2>
      <p class="card-sub">${count ? `${count}件・合計 ${yen(a.spent)}。タップで編集・削除できます。` : '記録すると、日ごとにここに並びます。'}</p>
      ${body}
    </section>`;
  }

  // =====================================================================
  // カテゴリ別の内訳（ランキングの横棒）
  // 1つの系列（金額）だけなので、色はスロット1の青を全部の棒に使う。値は棒の先に出し、凡例は置かない（dataviz スキル）。
  // 色は validate_palette.js で検証済み（ライト #2a78d6・ダーク #3987e5 とも合格）。
  // =====================================================================

  function categoryHtml(period) {
    const { rows, total, count } = spendsByCategory(getData().budget, period);
    if (!rows.length) return '';
    const pcts = shares(rows.map((r) => r.total));
    const bars = rows
      .map(
        (r) => `
      <li class="hbar-row">
        <div class="hbar-name">${esc(r.label)}<small>${r.count}件</small></div>
        <div class="hbar-line">
          <span class="hbar" style="--p:${r.ratio.toFixed(4)}" aria-hidden="true"></span>
          <span class="hbar-val">${yen(r.total)}</span>
        </div>
      </li>`,
      )
      .join('');
    const table = rows.map((r, i) => `<tr><th scope="row">${esc(r.label)}</th><td>${yen(r.total)}</td><td>${r.count}件</td><td>${pctText(pcts[i], r.total)}</td></tr>`).join('');
    return `
    <section class="card" id="spend-category">
      <h2 class="card-title">カテゴリ別の出費</h2>
      <p class="card-sub">多い順です。${count}件・合計 ${yen(total)}。</p>
      <ol class="hbars" aria-label="カテゴリ別の出費（多い順）">${bars}</ol>
      <details class="table-view">
        <summary>表で見る</summary>
        <div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">カテゴリ</th><th scope="col">金額</th><th scope="col">件数</th><th scope="col">割合</th></tr></thead><tbody>${table}</tbody></table></div>
      </details>
    </section>`;
  }

  // =====================================================================
  // 出費の入力（シート）
  // =====================================================================

  const catChips = (selected) => `
    <div class="field">
      <span class="field-label">カテゴリ（任意）</span>
      <div class="chips chips-4" data-spend-cats role="group" aria-label="カテゴリ">
        ${SPEND_CATEGORIES.map((c) => `<button type="button" class="chip" data-action="b-spend-cat" data-v="${c.key}" aria-pressed="${c.key === selected}">${esc(c.label)}</button>`).join('')}
      </div>
    </div>`;

  function openSpendForm(id) {
    const b = getData().budget;
    const s = id ? b.spends.find((x) => x.id === id) : null;
    if (id && !s) return;
    if (!s && b.spends.length >= BUDGET_LIMITS.spends) {
      toast(`出費は${num(BUDGET_LIMITS.spends)}件までです。古い出費を消してください`);
      return;
    }
    openSheet(`
    ${sheetHead(s ? '出費を編集' : '出費を記録')}
    <form id="b-spend-form" class="bform" novalidate data-id="${esc(id || '')}" data-category="${esc(s?.category ?? '')}">
      ${yenField('sp-amount', '金額', s ? num(s.amount) : '', s ? '' : 'autofocus')}
      <label class="field">
        <span class="field-label">日付</span>
        <input class="input input-text" type="date" id="sp-date" value="${esc(s?.date ?? todayISO())}">
        <span class="field-error" id="sp-date-err"></span>
      </label>
      ${catChips(s?.category ?? '')}
      ${textField('sp-memo', 'メモ（任意）', s?.memo ?? '', '例：スーパー', BUDGET_LIMITS.memoLen)}
      <p class="spend-status" id="sp-status" role="status" aria-live="polite"></p>
      <button type="submit" class="btn btn-primary btn-block">${s ? '保存する' : '記録する'}</button>
      ${
        s
          ? `<button type="button" class="btn btn-danger btn-block mt-12" data-action="b-spend-delete" data-id="${esc(s.id)}">${icon('trash')}削除</button>`
          : `<button type="button" class="btn btn-block mt-12" data-action="b-spend-continue">続けて入力</button>
      <p class="hint">「続けて入力」は、記録したあとも、この画面を閉じません。日付はそのままで、金額とメモだけ空になります。</p>`
      }
    </form>`);
  }

  function readSpendForm(form) {
    const errors = {};
    const date = $('#sp-date').value;
    if (!isValidISO(date)) errors['sp-date'] = '日付を選んでください';
    const amount = readYen('sp-amount', { min: 1, label: '金額' });
    if (amount.error) errors['sp-amount'] = amount.error;
    return { values: { date, amount: amount.value, category: form.dataset.category || '', memo: $('#sp-memo').value.trim() }, errors };
  }

  /** keep が true なら、記録したあともシートを開いたままにして、金額とメモを空にする（続けて入力） */
  function submitSpend(form, keep = false) {
    const { values: v, errors } = readSpendForm(form);
    form.dataset.submitted = '1';
    refreshForm(form);
    if (Object.keys(errors).length) return;
    const b = getData().budget;
    const id = form.dataset.id;
    const s = id ? b.spends.find((x) => x.id === id) : null;
    if (s) Object.assign(s, { date: v.date, amount: v.amount, category: v.category, memo: v.memo });
    else b.spends.push({ id: uid(), date: v.date, amount: v.amount, category: v.category, memo: v.memo, createdAt: nowISO() });
    const inThis = periodOf(b.settings, v.date).key === currentPeriod().key;
    const note = inThis ? '' : `（${md(v.date)}は、別の期間です）`;
    if (!keep) {
      commit(`${s ? '保存しました' : '記録しました'}${note}`);
      return;
    }
    if (!commit('', { keep: true })) return;
    // 続けて入れられるように、金額・メモ・カテゴリを空にする（日付はそのまま）
    $('#sp-amount').value = '';
    $('#sp-memo').value = '';
    form.dataset.category = '';
    for (const c of $$('[data-action="b-spend-cat"]', form)) c.setAttribute('aria-pressed', 'false');
    form.dataset.submitted = '';
    refreshForm(form);
    $('#sp-status').textContent = `${yen(v.amount)} を記録しました${note}。続けて入れられます。`;
    $('#sp-amount').focus();
  }

  async function deleteSpend(id) {
    const b = getData().budget;
    const s = b.spends.find((x) => x.id === id);
    if (!s) return;
    const ok = await confirmDialog({
      title: 'この出費を削除しますか？',
      message: `${md(s.date)}・${yen(s.amount)}・${s.memo || spendCategoryLabel(s.category)}\n元には戻せません。`,
      okLabel: '削除する',
      danger: true,
    });
    if (!ok) return;
    b.spends = b.spends.filter((x) => x.id !== id);
    commit('削除しました');
  }

  /** @returns {boolean} この操作を処理したら true */
  function onAction(btn) {
    switch (btn.dataset.action) {
      case 'b-spend-add':
        openSpendForm();
        return true;
      case 'b-spend-edit':
        openSpendForm(btn.dataset.id);
        return true;
      case 'b-spend-delete':
        deleteSpend(btn.dataset.id);
        return true;
      case 'b-spend-continue':
        submitSpend(btn.closest('form'), true);
        return true;
      case 'b-spend-cat': {
        // 1つだけ選べる。選んでいるものをもう一度押すと、カテゴリなしに戻る
        const form = btn.closest('form');
        const was = btn.getAttribute('aria-pressed') === 'true';
        for (const c of $$('[data-action="b-spend-cat"]', form)) c.setAttribute('aria-pressed', String(!was && c === btn));
        form.dataset.category = was ? '' : btn.dataset.v;
        return true;
      }
      case 'b-spend-show-more': {
        const key = currentPeriod().key;
        more = { key, limit: limitFor(key) + PAGE };
        rerender();
        return true;
      }
      default:
        return false;
    }
  }

  return {
    summaryHtml,
    listHtml,
    categoryHtml,
    onAction,
    /** budget-view.js の FORMS に登録するフォームの設定 */
    form: { read: readSpendForm, submit: (form) => submitSpend(form, false), ids: ['sp-amount', 'sp-date'] },
  };
}
