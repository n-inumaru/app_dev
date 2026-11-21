// 家計タブ「履歴」の画面：期間ごとの 使えた額・使った額・余り、前の期間との比べ、最近12期間の棒グラフ
//
// 計算は js/budget.js の historyOf を呼ぶだけにして、ここには書かない（ここにあるのは、表示用の整形だけ）。
// 画面の作り方は budget-spends.js と同じ：data-action は "b-" で始める、ユーザーの文字は必ず esc() でエスケープする。
// 履歴の中身（確定したスナップショット）は、この画面からは変えない。出費を直したときの同期は budget-view の commit が行うので、
// この画面は、開くたびに最新の値を出す（「履歴が変わった」とは知らせない）。
// budget-view.js が createHistoryView() を呼んで、「履歴」の小タブに組み込む。
//
// 棒グラフの決め方（dataviz スキルの手順。理由は設計書「15」）：
//   形＝「余り」だけの棒。ゼロの線から、＋は上・マイナス（オーバー）は下へ伸ばす（ゼロを境に分かれる＝diverging bar）。
//   色＝青（余り。--series-1）と赤（オーバー。--critical）。validate_palette.js で両モードとも合格。色だけに頼らず、位置（ゼロの線の下）・凡例のアイコン・
//   読み出しの「◯円オーバー」・表で伝える。値は、棒をタップ／前後ボタン／「表で見る」で読める。

import { esc, num, yen, todayISO } from './format.js';
import { parseISO } from './dates.js';
import { historyOf, isBudgetEmpty } from './budget.js';
import { icon } from './icons.js';

const PAGE = 24; // 一覧に一度に出す期間の数（これを超えたら「もっと見る」）

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * @param {object} deps
 * @param {() => object} deps.getData
 * @param {() => void} deps.rerender
 * @param {object} deps.kit   budget-view.js と共有する表示の部品（md・moneyYen・emptyGuideHtml）
 */
export function createHistoryView({ getData, rerender, kit }) {
  const { md, moneyYen, emptyGuideHtml } = kit;

  let limit = PAGE; // 一覧に出している期間の数
  let selected = null; // 棒グラフで選んでいる棒（null＝いちばん新しい期間）
  let bars = []; // いま描いている棒（タップで値を出すため）

  /** 小タブを開き直したときに、状態を初期に戻す */
  function reset() {
    limit = PAGE;
    selected = null;
  }

  /** 「10月23日〜11月24日」。今年でない年は、年をつける */
  function rangeText(s) {
    const y = parseISO(s.start).y;
    const lead = y === parseISO(todayISO()).y ? '' : `${y}年`;
    return `${lead}${md(s.start)}〜${md(s.end)}`;
  }

  const overText = (leftover) => (leftover < 0 ? `${yen(-leftover)}オーバー` : '');

  // =====================================================================
  // 期間ごとの一覧
  // =====================================================================

  /** 前の期間より、増えた／減った（＋／−と矢印。色には頼らない） */
  function diffValue(v) {
    if (v > 0) return `${icon('arrow-up')}+${num(v)}円`;
    if (v < 0) return `${icon('arrow-down')}−${num(-v)}円`;
    return `${icon('minus')}変わらない`;
  }

  function diffHtml(r) {
    if (r.split) return '<p class="hs-diff">給料日を変える前の区切りなので、前の期間とは比べません。</p>';
    if (!r.prev) return '';
    return `<p class="hs-diff"><span class="hs-d">前の期間（${md(r.prev.start)}〜）より</span><span class="hs-d">使った額 ${diffValue(r.prev.spentDiff)}</span><span class="hs-d">余り ${diffValue(r.prev.leftoverDiff)}</span></p>`;
  }

  /** 1期間の行。now なら「今の期間（途中）」 */
  function rowHtml(r, now = false) {
    const over = r.leftover < 0;
    const tag = now ? '<span class="tag accent">途中</span>' : r.split ? '<span class="tag">給料日を変える前の区切り</span>' : '';
    return `
    <li class="hs-row ${now ? 'is-now' : ''}">
      <div class="hs-head"><span class="hs-range">${now ? '今の期間　' : ''}${rangeText(r)}</span>${tag}</div>
      <dl class="hs-nums">
        <div><dt>使えた額</dt><dd>${moneyYen(r.free)}</dd></div>
        <div><dt>使った額</dt><dd>${moneyYen(r.spent)}</dd></div>
        <div class="${over ? 'is-neg' : ''}"><dt>余り</dt><dd>${over ? icon('alert') : ''}${moneyYen(r.leftover)}${over ? `<small>${overText(r.leftover)}</small>` : ''}</dd></div>
      </dl>
      ${now ? `<p class="hs-diff">${md(r.end)}までの途中の値です。期間が終わると、結果が記録されます。</p>` : diffHtml(r)}
    </li>`;
  }

  function listHtml(h) {
    const c = h.current;
    const now = rowHtml({ start: c.period.start, end: c.period.end, free: c.free, spent: c.spent, leftover: c.leftover }, true);
    const shownRows = h.rows.slice(0, limit);
    const more = h.rows.length > limit ? `<button type="button" class="btn btn-block mt-12" data-action="b-hist-more">もっと見る（あと${h.rows.length - limit}期間）</button>` : '';
    const note = h.splitCount
      ? `<p class="note">${icon('info')}<span>給料日を変えたため、期間が重なっているところがあります。「給料日を変える前の区切り」の印がついた期間は、そのまま残してあります（棒グラフと、前の期間との比べには入れていません）。</span></p>`
      : '';
    return `
    <section class="card" id="hist-list">
      <h2 class="card-title">期間ごとの結果</h2>
      <p class="card-sub">${h.rows.length ? `新しい期間が上です。${h.rows.length}期間。` : ''}期間が終わると、結果が自動で記録されます。</p>
      ${note}
      <ul class="hs-list">${now}${shownRows.map((r) => rowHtml(r)).join('')}</ul>
      ${more}
    </section>`;
  }

  // =====================================================================
  // 最近12期間の棒グラフ（余り）
  // =====================================================================

  function readoutHtml(b) {
    const over = b.leftover < 0;
    return `
      <div class="hs-ro-title">${rangeText(b)}</div>
      <div class="hs-ro-nums">
        <span>使えた額 <strong>${moneyYen(b.free)}</strong></span>
        <span>使った額 <strong>${moneyYen(b.spent)}</strong></span>
        <span class="${over ? 'is-neg' : ''}">${over ? icon('alert') : ''}余り <strong>${moneyYen(b.leftover)}</strong></span>${over ? `<span class="is-neg">（${overText(b.leftover)}）</span>` : ''}
      </div>`;
  }

  function chartHtml(h) {
    bars = h.chart.bars;
    if (bars.length < 2) return ''; // 1期間だけなら、棒にせず一覧の数字で見る
    if (selected === null || selected >= bars.length) selected = bars.length - 1;
    const hasOver = bars.some((b) => b.leftover < 0);

    const cols = bars
      .map((b, i) => {
        const label = `${rangeText(b)}、${b.leftover < 0 ? overText(b.leftover) : `余り ${yen(b.leftover)}`}`;
        return `<button type="button" class="hs-col" data-action="b-hist-bar" data-i="${i}" aria-pressed="${i === selected}" aria-label="${esc(label)}">${
          b.up > 0 ? `<span class="hs-up" style="height:${(b.up * 100).toFixed(2)}%"></span>` : ''
        }${b.down > 0 ? `<span class="hs-down" style="height:${(b.down * 100).toFixed(2)}%"></span>` : ''}</button>`;
      })
      .join('');
    const axis = bars.map((b) => `<span>${parseISO(b.start).m}</span>`).join('');
    const legend = hasOver
      ? `<ul class="legend hs-legend">
        <li><span class="lsw hs-sw-up"></span><span class="legend-name">余り</span><span>使えた額に収まった</span></li>
        <li><span class="lsw hs-sw-down"></span>${icon('alert')}<span class="legend-name">オーバー</span><span>使えた額を超えた</span></li>
      </ul>`
      : '';
    const rows = [...bars]
      .reverse()
      .map((b) => `<tr><th scope="row">${rangeText(b)}</th><td>${moneyYen(b.free)}</td><td>${moneyYen(b.spent)}</td><td>${moneyYen(b.leftover)}${b.leftover < 0 ? '<small>（オーバー）</small>' : ''}</td></tr>`)
      .join('');
    const hidden = h.splitCount ? `<p class="hint hs-split-note">給料日を変える前の区切りの期間（${h.splitCount}期間）は、棒に入れていません。</p>` : '';

    return `
    <section class="card" id="hist-chart">
      <h2 class="card-title">最近${bars.length}期間の余り</h2>
      <p class="card-sub">使えた額から使った額を引いた「余り」です。ゼロの線より下は、使いすぎた（オーバー）期間です。</p>
      <div class="hs-chart" role="group" aria-label="最近${bars.length}期間の余りの棒グラフ。棒を押すと、その期間の値が出ます">
        <div class="hs-plot" style="--zero:${h.chart.zero.toFixed(4)}">${cols}<span class="hs-zero" aria-hidden="true"></span></div>
        <div class="hs-axis" aria-hidden="true">${axis}</div>
      </div>
      <p class="hint hs-axis-note">下の数字は、期間が始まった月です。</p>
      <div class="hs-readout">
        <button type="button" class="icon-btn" data-action="b-hist-step" data-dir="-1" aria-label="ひとつ前の期間" ${selected === 0 ? 'disabled' : ''}>${icon('chevron-left')}</button>
        <div class="hs-ro-body" id="hs-readout" aria-live="polite">${readoutHtml(bars[selected])}</div>
        <button type="button" class="icon-btn" data-action="b-hist-step" data-dir="1" aria-label="ひとつ後の期間" ${selected === bars.length - 1 ? 'disabled' : ''}>${icon('chevron-right')}</button>
      </div>
      ${legend}
      ${hidden}
      <details class="table-view">
        <summary>表で見る</summary>
        <div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">期間</th><th scope="col">使えた額</th><th scope="col">使った額</th><th scope="col">余り</th></tr></thead><tbody>${rows}</tbody></table></div>
      </details>
    </section>`;
  }

  /** 選んだ棒を目立たせて、読み出しを入れ替える（画面は描き直さない） */
  function paintSelection() {
    $$('.hs-col').forEach((el, i) => el.setAttribute('aria-pressed', String(i === selected)));
    const box = $('#hs-readout');
    if (box && bars[selected]) box.innerHTML = readoutHtml(bars[selected]);
    const [prev, next] = $$('[data-action="b-hist-step"]');
    if (prev) prev.disabled = selected === 0;
    if (next) next.disabled = selected === bars.length - 1;
  }

  // =====================================================================

  function emptyHtml(h) {
    return `
    <section class="card empty">
      <div class="empty-icon">${icon('chart')}</div>
      <h2>履歴は、期間が終わると記録されます</h2>
      <p>今の期間は ${md(h.current.period.end)} に終わります。そのあと自動で、期間ごとの「使えた額・使った額・余り」がここに並びます。</p>
      <p class="hint">${md(h.current.period.start)}〜の途中の値は、下に出しています。</p>
    </section>`;
  }

  function html() {
    const data = getData();
    if (isBudgetEmpty(data.budget)) return emptyGuideHtml();
    const h = historyOf(data, todayISO());
    return `${h.rows.length ? chartHtml(h) : emptyHtml(h)}${listHtml(h)}`;
  }

  /** @returns {boolean} この操作を処理したら true */
  function onAction(btn) {
    switch (btn.dataset.action) {
      case 'b-hist-bar':
        selected = Number(btn.dataset.i);
        paintSelection();
        return true;
      case 'b-hist-step':
        selected = Math.min(bars.length - 1, Math.max(0, (selected ?? bars.length - 1) + Number(btn.dataset.dir)));
        paintSelection();
        return true;
      case 'b-hist-more':
        limit += PAGE;
        rerender();
        return true;
      default:
        return false;
    }
  }

  return { html, onAction, reset };
}
