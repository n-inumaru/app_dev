// 完済ナビ：画面の組み立てと操作

import { simulate, buildPlan, monthlyInterest, isStuck, STRATEGY_LABEL, MAX_MONTHS } from './calc.js';
import {
  esc,
  num,
  yen,
  rateText,
  duration,
  monthLabel,
  parseYen,
  parseRate,
  yenInputValue,
  todayISO,
  yearMonthText,
  dayText,
  dateText,
  fileDate,
} from './format.js';
import {
  loadData,
  saveData,
  emptyData,
  makeBackup,
  readBackup,
  requestPersist,
  removeAllStorage,
  uid,
  getFlag,
  setFlag,
  getPref,
  setPref,
} from './storage.js';
import * as lock from './lock.js';
import { drawBalanceChart } from './chart.js';
import { icon } from './icons.js';
import { createBudgetView } from './budget-view.js';
import { extraGuide, isBudgetEmpty } from './budget.js';
import { parseISO } from './dates.js';
import {
  setupDialogs,
  openSheet,
  closeSheet,
  closeAllDialogs,
  confirmDialog,
  alertDialog,
  askPin,
  createPinPad,
  toast,
  sheetHead,
  yenField,
  setError,
} from './ui.js';

const APP_VERSION = '1.2.1';
const RELOCK_AFTER_MS = 60 * 1000; // アプリから離れて1分でロック
const TITLES = { home: '完済ナビ', plan: '返し方の提案', forecast: '完済の予測', records: '返済の記録', budget: '家計' };

let data = loadData();
const ui = {
  tab: TITLES[getPref('tab')] ? getPref('tab') : 'home', // 最後に開いていたタブ（ロック解除後もここから始まる）
  locked: false,
  scenario: null,
  scheduleLimit: 12,
  recordFilter: 'all',
  installPrompt: null,
  hiddenAt: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const sumValues = (o) => Object.values(o).reduce((s, v) => s + v, 0);
const activeDebts = () => data.debts.filter((d) => d.balance > 0);
const debtById = (id) => data.debts.find((d) => d.id === id);
const debtName = (id) => debtById(id)?.name ?? '（削除した会社）';
const nowISO = () => new Date().toISOString();
const plan = () => buildPlan(data.debts, data.plan);

function persist({ touch = true } = {}) {
  if (touch) data.meta.updatedAt = nowISO();
  try {
    saveData(data);
  } catch (e) {
    console.error(e);
    toast('保存できませんでした。スマホの空き容量を確認してください');
    return false;
  }
  requestPersist();
  return true;
}

// 家計タブ（今月・収支・履歴・もしも）。画面は js/budget-view.js
const budgetView = createBudgetView({ getData: () => data, persist, rerender: () => render() });

// =====================================================================
// 画面の描き分け
// =====================================================================

function render() {
  if (ui.locked) return;
  $('#page-title').textContent = TITLES[ui.tab];
  for (const b of $$('.tabbar [data-tab]')) {
    if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  const view = $('#view');
  if (ui.tab === 'home') view.innerHTML = viewHome();
  else if (ui.tab === 'plan') {
    view.innerHTML = viewPlan();
    renderPlanResult();
  } else if (ui.tab === 'forecast') {
    view.innerHTML = viewForecast();
    drawForecastChart();
  } else if (ui.tab === 'budget') {
    budgetView.closePeriods(); // 終わった期間の結果を確定する
    view.innerHTML = budgetView.html();
    budgetView.afterRender();
  } else view.innerHTML = viewRecords();
}

function switchTab(tab) {
  if (!TITLES[tab]) return;
  ui.tab = tab;
  setPref('tab', tab);
  if (tab === 'forecast') {
    ui.scenario = null;
    ui.scheduleLimit = 12;
  }
  render();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------
// ホーム
// ---------------------------------------------------------------------

function needsBackupReminder() {
  if (!data.debts.length) return false;
  const now = Date.now();
  const DAY = 86400000;
  const last = data.meta.lastBackupAt ? Date.parse(data.meta.lastBackupAt) : null;
  if (last === null) {
    const first = Math.min(...data.debts.map((d) => Date.parse(d.createdAt) || now));
    return now - first > 7 * DAY;
  }
  const updated = Date.parse(data.meta.updatedAt) || 0;
  return updated > last && now - last > 30 * DAY;
}

function homeBanners() {
  let html = '';
  const standalone = matchMedia('(display-mode: standalone)').matches;
  if (ui.installPrompt && !standalone && !getFlag('install-dismissed')) {
    html += `
    <section class="banner">
      ${icon('phone')}
      <div class="banner-body">
        <strong>ホーム画面に追加できます</strong>
        <span>アプリのように、すぐ開けるようになります。</span>
        <div class="banner-actions">
          <button type="button" class="btn btn-sm btn-primary" data-action="install">追加する</button>
          <button type="button" class="btn btn-sm btn-ghost" data-action="dismiss-install">閉じる</button>
        </div>
      </div>
    </section>`;
  }
  if (needsBackupReminder()) {
    html += `
    <section class="banner">
      ${icon('download')}
      <div class="banner-body">
        <strong>${data.meta.lastBackupAt ? 'バックアップから30日以上たちました' : 'バックアップをとっておきましょう'}</strong>
        <span>スマホの故障や機種変更に備えて、データをファイルに書き出せます。</span>
        <div class="banner-actions">
          <button type="button" class="btn btn-sm btn-primary" data-action="export">${icon('download')}書き出す</button>
        </div>
      </div>
    </section>`;
  }
  return html;
}

function viewHome() {
  const banners = homeBanners();
  if (!data.debts.length) {
    return `${banners}
    <section class="card empty">
      <div class="empty-icon">${icon('list')}</div>
      <h2>まずは会社を登録しましょう</h2>
      <p>借りている会社ごとに、残高・年利・毎月の返済額を入れると、完済の時期と、余剰金の効率のよい返し方がわかります。</p>
      <button type="button" class="btn btn-primary btn-block" data-action="add-debt">${icon('plus')}会社を追加</button>
      <p class="hint">データはこのスマホの中だけに保存され、外部には送られません。</p>
    </section>`;
  }

  const active = activeDebts();
  const done = data.debts.filter((d) => !(d.balance > 0));
  const p = plan();
  const base = p.base;
  const rec = p[p.recommended];

  let summary;
  if (!active.length) {
    summary = `
    <section class="card summary">
      <div class="hero-label">借金の残高（合計）</div>
      <div class="hero-value">0<span class="unit">円</span></div>
      <p class="summary-foot good-text">${icon('check')} すべての会社を完済しました。おつかれさまでした！</p>
    </section>`;
  } else {
    const totalBalance = sum(active, (d) => d.balance);
    const totalPay = sum(active, (d) => d.payment);
    const totalInt = sum(active, (d) => monthlyInterest(d.balance, d.rate));
    let foot = base.finished
      ? `<p class="summary-foot">このままだと <strong>${duration(base.months)}</strong> で全社完済（${monthLabel(base.months)}ごろ）。利息はあと <strong>${yen(base.totalInterest)}</strong> です。</p>`
      : `<p class="warn">${icon('alert')}<span>このままでは完済できない会社があります。毎月の返済額を見直すか、提案を見てください。</span></p>`;
    if (!p.planSameAsBase && rec.finished) {
      foot += `<p class="summary-foot">提案どおりに返すと <strong>${duration(rec.months)}</strong>（${monthLabel(rec.months)}ごろ）、利息は <strong>${yen(rec.totalInterest)}</strong> です。 <button type="button" class="link-btn" data-goto="plan">提案を見る</button></p>`;
    }
    summary = `
    <section class="card summary">
      <div class="hero-label">借金の残高（合計）</div>
      <div class="hero-value">${num(totalBalance)}<span class="unit">円</span></div>
      <div class="stats">
        <div class="stat"><div class="stat-label">毎月の返済</div><div class="stat-value">${yen(totalPay)}</div></div>
        <div class="stat"><div class="stat-label">毎月の利息（目安）</div><div class="stat-value">${yen(totalInt)}</div></div>
      </div>
      ${foot}
    </section>`;
  }

  const cards = [...active.map((d) => debtCard(d, base)), ...done.map(doneCard)].join('');
  return `${banners}${summary}
    <h2 class="section-title">会社ごと<span class="count">${data.debts.length}社</span></h2>
    ${cards}
    <button type="button" class="btn btn-primary btn-block" data-action="add-debt">${icon('plus')}会社を追加</button>`;
}

function debtCard(d, base) {
  const per = base.perDebt[d.id];
  const interest = monthlyInterest(d.balance, d.rate);
  const progress = d.startBalance > 0 ? Math.min(100, Math.max(0, (1 - d.balance / d.startBalance) * 100)) : 0;
  let foot;
  if (isStuck(d)) {
    foot = `<p class="warn">${icon('alert')}<span>毎月の返済額が利息（${yen(interest)}）以下なので、このままでは残高が減りません。</span></p>`;
  } else if (per && per.payoffMonth !== null) {
    foot = `<p class="debt-foot">このままだと ${duration(per.payoffMonth)}で完済（${monthLabel(per.payoffMonth)}ごろ）・利息はあと ${yen(per.interest)}</p>`;
  } else {
    foot = `<p class="warn">${icon('alert')}<span>このままだと完済まで50年以上かかります。</span></p>`;
  }
  return `
  <article class="card debt">
    <div class="debt-head">
      <h3 class="debt-name">${esc(d.name)}</h3>
      <span class="pill">年${rateText(d.rate)}%</span>
    </div>
    <div class="debt-balance">${num(d.balance)}<span class="unit">円</span></div>
    <div class="meter" role="img" aria-label="登録したときから${Math.floor(progress)}%返済"><span style="width:${progress.toFixed(1)}%"></span></div>
    <dl class="facts">
      <div><dt>毎月の返済</dt><dd>${yen(d.payment)}</dd></div>
      <div><dt>月の利息（目安）</dt><dd>${yen(interest)}</dd></div>
      <div><dt>登録時から</dt><dd>${Math.floor(progress)}%返済</dd></div>
    </dl>
    ${foot}
    <div class="debt-actions">
      <button type="button" class="btn btn-sm" data-action="add-record" data-id="${esc(d.id)}">${icon('check')}返済を記録</button>
      <button type="button" class="btn btn-sm btn-ghost" data-action="edit-debt" data-id="${esc(d.id)}">${icon('edit')}編集</button>
    </div>
  </article>`;
}

function doneCard(d) {
  return `
  <article class="card debt is-done">
    <div class="debt-head">
      <h3 class="debt-name">${esc(d.name)}</h3>
      <span class="tag good">${icon('check')}完済</span>
    </div>
    <p class="debt-foot">毎月 ${yen(d.payment)} を返していた会社です。</p>
    <div class="debt-actions">
      <button type="button" class="btn btn-sm btn-ghost" data-action="edit-debt" data-id="${esc(d.id)}">${icon('edit')}編集・削除</button>
    </div>
  </article>`;
}

// ---------------------------------------------------------------------
// 提案
// ---------------------------------------------------------------------

function emptyActive(text) {
  return `
  <section class="card empty">
    <div class="empty-icon">${icon('bulb')}</div>
    <h2>返済中の会社がありません</h2>
    <p>${text}</p>
    <button type="button" class="btn btn-primary btn-block" data-goto="home">ホームへ</button>
  </section>`;
}

function viewPlan() {
  if (!activeDebts().length) return emptyActive('ホームで会社を登録すると、ここで余剰金の効率のよい返し方を提案します。');
  const s = data.plan;
  return `
  <section class="card">
    <h2 class="card-title">余剰金を入れる</h2>
    <p class="card-sub">返済とは別に使えるお金を入れると、どの会社に返すと得かを計算します。</p>
    ${yenField('plan-lump', '今ある余剰金（一括で返す額）', s.lumpSum ? num(s.lumpSum) : '', 'placeholder="0"')}
    ${yenField('plan-extra', '毎月の余剰金（毎月上乗せできる額）', s.monthlyExtra ? num(s.monthlyExtra) : '', 'placeholder="0"')}
    <p class="note">${icon('info')}<span id="plan-total"></span></p>
    <div id="plan-guide" aria-live="polite"></div>
  </section>
  <div id="plan-result"></div>`;
}

function renderPlanResult() {
  const box = $('#plan-result');
  if (!box) return;
  const p = plan();
  $('#plan-total').innerHTML = `毎月の返済の総額 <strong>${yen(p.monthlyTotal)}</strong> を変えずに続け、完済した会社に払っていた額は次の会社に回す前提で計算します。`;
  $('#plan-guide').innerHTML = planGuideHtml();
  box.innerHTML = planResultHtml(p);
}

const mdText = (iso) => {
  const p = parseISO(iso);
  return `${p.m}月${p.d}日`;
};

/**
 * 家計の「自由に使える額（返済への上乗せの前。今の期間）」を目安として出し、毎月の余剰金がそれを超えたら注意する（設計書 7）。
 * 計算は budget.js の extraGuide。家計に何も入れていないときは出さない。責める言葉は使わない。
 */
function planGuideHtml() {
  const g = extraGuide(data, todayISO());
  if (!g) return '';
  const range = `${mdText(g.period.start)}〜${mdText(g.period.end)}`;
  const link = '<button type="button" class="link-btn" data-goto="budget">家計を見る</button>';
  const money = (v) => `${v < 0 ? '−' : ''}${yen(Math.abs(v))}`;
  if (g.over) {
    const text = g.negative
      ? `家計では、返済への上乗せの前でも、今の期間（${range}）の自由に使える額が <strong>${money(g.free)}</strong> です。毎月の余剰金 ${yen(g.extra)} を続けられるか、家計の収支と合わせて確かめてみてください。`
      : `毎月の余剰金 ${yen(g.extra)} は、家計の目安（<strong>${yen(g.free)}</strong>）を ${yen(g.overBy)} 超えています。無理なく続けられるか、家計の収支と合わせて確かめてみてください。`;
    return `<p class="warn" id="plan-guide-text">${icon('alert')}<span>${text} ${link}</span></p>`;
  }
  const text = g.negative
    ? `家計の自由に使える額は、返済への上乗せの前で <strong>${money(g.free)}</strong>（今の期間 ${range}）です。上乗せを考える前に、家計の収支を見直せるか確かめてみましょう。`
    : `家計の目安：今の期間（${range}）の自由に使える額は、返済への上乗せの前で <strong>${yen(g.free)}</strong> です。毎月の余剰金は、この範囲に収めると無理がありません（ボーナスや年払いの月は、期間ごとに変わります）。`;
  return `<p class="note" id="plan-guide-text">${icon('wallet')}<span>${text} ${link}</span></p>`;
}

function planResultHtml(p) {
  const rec = p.recommended;
  const r = p[rec];
  if (p.planSameAsBase) {
    return `
    <section class="card reco">
      <h2 class="card-title">余剰金を入れてみましょう</h2>
      <p class="card-sub">余剰金を入れると、どの会社に返すと利息が一番少なくなるかを計算します。</p>
      ${statsHtml(r, p.base, false)}
    </section>
    ${explainHtml()}`;
  }
  return `
    <section class="card reco">
      <span class="reco-badge">おすすめ</span>
      <h2 class="card-title">${STRATEGY_LABEL[rec]}に返す</h2>
      <p class="card-sub">${p.sameOrder ? '今回は、利率の高い順と残高の少ない順が同じ順番です。' : '2つの返し方のうち、払う利息の合計が少ない方です。'}</p>
      ${p.lumpSum > 0 ? lumpHtml(p, r) : ''}
      ${orderHtml(p, r)}
      ${nextPaymentHtml(r)}
      <h3 class="sub-title">この返し方の結果</h3>
      ${statsHtml(r, p.base, true)}
    </section>
    ${compareHtml(p)}
    ${explainHtml()}`;
}

function statsHtml(r, base, compare) {
  const both = r.finished && base.finished;
  const monthsDiff = both ? base.months - r.months : 0;
  const intDiff = both ? base.totalInterest - r.totalInterest : 0;
  let monthSub = r.finished ? `${monthLabel(r.months)}ごろ` : '返済額が利息以下の会社があります';
  if (compare && monthsDiff > 0) monthSub += `<br><span class="good-text">今のままより<br>${duration(monthsDiff)}早い</span>`;
  if (compare && r.finished && !base.finished) monthSub += '<br>今のままだと完済できません';
  const intSub = compare && intDiff > 0 ? `<span class="good-text">今のままより<br>${yen(intDiff)}少ない</span>` : 'これから払う利息の目安';
  return `
  <div class="stats">
    <div class="stat"><div class="stat-label">全社完済まで</div><div class="stat-value">${r.finished ? duration(r.months) : '完済できません'}</div><div class="stat-sub">${monthSub}</div></div>
    <div class="stat"><div class="stat-label">利息の合計</div><div class="stat-value">${r.finished ? yen(r.totalInterest) : '—'}</div><div class="stat-sub">${intSub}</div></div>
  </div>`;
}

function lumpHtml(p, r) {
  const items = r.lumpAllocation
    .map((a, i) => {
      const d = debtById(a.id);
      return `
      <li>
        <span class="rank">${i + 1}</span>
        <span class="alloc-name">${esc(d.name)}<small>年${rateText(d.rate)}%・残高 ${yen(d.balance)}</small></span>
        <span class="alloc-amt">${yen(a.amount)}${a.paysOff ? `<span class="tag good">${icon('check')}完済</span>` : ''}</span>
      </li>`;
    })
    .join('');
  return `
    <h3 class="sub-title">今ある余剰金 ${yen(p.lumpSum)} の入れ先</h3>
    <ol class="alloc">${items}</ol>
    ${r.lumpLeft > 0 ? `<p class="hint">全社を完済しても ${yen(r.lumpLeft)} 余ります。</p>` : ''}
    <button type="button" class="btn btn-block mt-12" data-action="record-lump">${icon('check')}この振り分けで返したら、記録する</button>`;
}

function orderWhen(per) {
  if (per.payoffMonth === null) return '50年以内に完済できません';
  const done = `${monthLabel(per.payoffMonth)}ごろ完済（${duration(per.payoffMonth)}後）`;
  if (per.extraFrom === null) return `上乗せなしで ${done}`;
  return `${per.extraFrom === 1 ? '次の返済' : monthLabel(per.extraFrom)}から上乗せ → ${done}`;
}

function orderHtml(p, r) {
  const ids = r.order.filter((id) => r.perDebt[id].payoffMonth !== 0);
  if (!ids.length) return '';
  const items = ids
    .map((id, i) => {
      const d = debtById(id);
      return `
      <li>
        <span class="rank">${i + 1}</span>
        <span class="order-body"><span class="order-name">${esc(d.name)}<small>年${rateText(d.rate)}%</small></span><span class="order-when">${orderWhen(r.perDebt[id])}</span></span>
      </li>`;
    })
    .join('');
  const lead =
    p.monthlyExtra > 0
      ? `毎月の余剰金 ${yen(p.monthlyExtra)} を、上から順に上乗せします。完済したら、その会社に払っていた額も次の会社に回します。`
      : '完済した会社に払っていた額を、上から順に次の会社へ回します。';
  return `
    <h3 class="sub-title">返す順番</h3>
    <p class="hint mb-8">${lead}</p>
    <ol class="order">${items}</ol>`;
}

function nextPaymentHtml(r) {
  const t = r.timeline[1];
  if (!t) return `<p class="note good-note">${icon('check')}<span>一括の余剰金で、全社を完済できます。</span></p>`;
  const before = r.timeline[0].balances;
  const rows = Object.entries(t.payments)
    .filter(([, v]) => v > 0)
    .map(([id, v]) => {
      const d = debtById(id);
      const regular = Math.min(d.payment, before[id] + (t.interest[id] || 0));
      const plus = v - regular;
      return `<tr><th scope="row">${esc(d.name)}</th><td>${yen(v)}${plus > 0 ? `<small>上乗せ +${yen(plus)}</small>` : ''}</td></tr>`;
    })
    .join('');
  return `
    <h3 class="sub-title">次の返済で払う額</h3>
    <table class="pay-table">
      <tbody>${rows}</tbody>
      <tfoot><tr><th scope="row">合計</th><td>${yen(sumValues(t.payments))}</td></tr></tfoot>
    </table>`;
}

function compareNote(p) {
  if (p.sameOrder) return '今回は2つの返し方が同じ順番なので、結果も同じです。';
  const av = p.avalanche;
  const sb = p.snowball;
  if (!av.finished || !sb.finished) return '';
  const otherKey = p.recommended === 'avalanche' ? 'snowball' : 'avalanche';
  const diff = p[otherKey].totalInterest - p[p.recommended].totalInterest;
  let s = diff > 0 ? `${STRATEGY_LABEL[otherKey]}にすると、利息が ${yen(diff)} 多くなります。` : `${STRATEGY_LABEL[otherKey]}でも、利息は変わりません。`;
  if (p.recommended === 'avalanche' && sb.firstPayoffMonth !== null && av.firstPayoffMonth !== null && sb.firstPayoffMonth < av.firstPayoffMonth) {
    const when = sb.firstPayoffMonth === 0 ? '一括の余剰金ですぐ完済' : `${duration(sb.firstPayoffMonth)}後`;
    s += `そのかわり、1社目の完済が ${duration(av.firstPayoffMonth - sb.firstPayoffMonth)} 早くなります（${when}）。`;
  }
  return s;
}

function compareHtml(p) {
  const rows = ['avalanche', 'snowball', 'base']
    .map((key) => {
      const r = p[key];
      const isRec = key === p.recommended;
      return `
      <tr class="${isRec ? 'is-rec' : ''}">
        <th scope="row">${STRATEGY_LABEL[key]}${isRec ? '<span class="tag accent">おすすめ</span>' : ''}</th>
        <td>${r.finished ? duration(r.months) : '完済不可'}</td>
        <td>${r.finished ? yen(r.totalInterest) : '—'}</td>
      </tr>`;
    })
    .join('');
  return `
  <section class="card">
    <h2 class="card-title">返し方をくらべる</h2>
    <table class="compare">
      <thead><tr><th scope="col">返し方</th><th scope="col">完済まで</th><th scope="col">利息の合計</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">${compareNote(p)}</p>
    <p class="hint">「今のまま」は、余剰金を入れず、完済した会社の分もほかに回さない場合です。</p>
  </section>`;
}

function explainHtml() {
  return `
  <details class="card explain">
    <summary>なぜ利率の高い順が得なの？</summary>
    <p>利息は毎月「残高 × 年利 ÷ 12」でかかります。同じ1万円を返すなら、利率の高い会社に返したほうが、その後の利息が多く減ります。</p>
    <p>たとえば1万円を返すと、年18%の会社なら利息が毎月150円、年15%の会社なら125円減ります。この差が完済まで毎月続きます。決め手は残高の大きさではなく、利率です。</p>
    <p>残高の少ない順は、完済する会社が早く出るので、管理する会社が減り、続けやすいのがよいところです。</p>
    <p>どちらも「毎月の返済の総額を変えずに、完済した会社の分を次の会社に回す」前提で計算しています。この前提では、利率の高い順が利息を一番少なくします。</p>
    <p>計算は目安です。実際の会社は利息を日割りで計算するため、数百円ほどずれることがあります。</p>
  </details>`;
}

// ---------------------------------------------------------------------
// 予測
// ---------------------------------------------------------------------

function forecastSeries(p) {
  const rec = p.recommended;
  const other = rec === 'avalanche' ? 'snowball' : 'avalanche';
  const values = (r) => r.timeline.map((t) => t.total);
  const series = [];
  if (p.planSameAsBase) {
    series.push({ key: 'base', label: '今のまま', values: values(p.base), result: p.base });
  } else {
    series.push({ key: rec, label: `${STRATEGY_LABEL[rec]}（おすすめ）`, values: values(p[rec]), result: p[rec] });
    if (!p.strategiesSame) series.push({ key: other, label: STRATEGY_LABEL[other], values: values(p[other]), result: p[other] });
    series.push({ key: 'base', label: '今のまま', values: values(p.base), result: p.base });
  }
  const finished = series.filter((s) => s.result.finished).map((s) => s.result.months);
  let horizon;
  if (finished.length === series.length) horizon = Math.max(...finished);
  else if (finished.length) horizon = Math.min(MAX_MONTHS, Math.ceil(Math.max(...finished) * 1.3) + 1);
  else horizon = 120;
  return { series, horizon: Math.max(1, horizon) };
}

function legendHtml(cfg) {
  if (cfg.series.length < 2) return '';
  const items = cfg.series
    .map(
      (s) => `
      <li><span class="lkey k-${s.key}"></span><span class="legend-name">${esc(s.label)}</span><span class="legend-val">${s.result.finished ? `${monthLabel(s.result.months)}に完済` : '完済できません'}</span></li>`,
    )
    .join('');
  return `<ul class="legend">${items}</ul>`;
}

function chartTableHtml(cfg) {
  const H = cfg.horizon;
  const step = H <= 12 ? 3 : H <= 36 ? 6 : 12;
  const months = [];
  for (let m = 0; m <= H; m += step) months.push(m);
  if (months[months.length - 1] !== H) months.push(H);
  const head = cfg.series.map((s) => `<th scope="col">${esc(s.label)}</th>`).join('');
  const rows = months
    .map((m) => {
      const cells = cfg.series.map((s) => `<td>${yen(m < s.values.length ? s.values[m] : 0)}</td>`).join('');
      return `<tr><th scope="row">${m === 0 ? '今' : monthLabel(m)}</th>${cells}</tr>`;
    })
    .join('');
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">時期</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function viewForecast() {
  if (!activeDebts().length) return emptyActive('ホームで会社を登録すると、ここで完済までの予測を表示します。');
  const p = plan();
  const cfg = forecastSeries(p);
  if (!ui.scenario || (p.planSameAsBase && ui.scenario !== 'base')) ui.scenario = p.planSameAsBase ? 'base' : p.recommended;
  const s = data.plan;
  const single = cfg.series.length === 1;
  const sub = single
    ? `今のままの残高の減り方です。${cfg.series[0].result.finished ? `${monthLabel(cfg.series[0].result.months)}に完済します。` : ''}`
    : `余剰金：一括 ${yen(s.lumpSum)}・毎月 ${yen(s.monthlyExtra)}`;
  const chartLabel = cfg.series
    .map((x) => `${x.label}は${x.result.finished ? `${monthLabel(x.result.months)}に完済` : '完済できません'}`)
    .join('、');

  const scenarios = p.planSameAsBase ? ['base'] : ['avalanche', 'snowball', 'base'];
  const buttons = scenarios
    .map(
      (key) =>
        `<button type="button" data-action="scenario" data-key="${key}" aria-pressed="${key === ui.scenario}">${STRATEGY_LABEL[key]}${key === p.recommended && !p.planSameAsBase ? '<small>おすすめ</small>' : ''}</button>`,
    )
    .join('');

  return `
  <section class="card">
    <h2 class="card-title">残高の減り方</h2>
    <p class="card-sub">${sub}${single ? '' : ' <button type="button" class="link-btn" data-goto="plan">変える</button>'}</p>
    ${legendHtml(cfg)}
    <div class="chart-readout" id="chart-readout" aria-live="polite">グラフを指でなぞると、その月の残高が出ます。</div>
    <div class="chart" id="chart" tabindex="0" role="img" aria-label="残高の減り方のグラフ。${esc(chartLabel)}。"></div>
    <details class="table-view">
      <summary>表で見る</summary>
      ${chartTableHtml(cfg)}
    </details>
  </section>
  <section class="card">
    <h2 class="card-title">返し方ごとのくわしい予定</h2>
    ${scenarios.length > 1 ? `<div class="segmented" role="group" aria-label="返し方を選ぶ">${buttons}</div>` : ''}
    <div id="scenario-detail">${scenarioDetail(p)}</div>
  </section>`;
}

function drawForecastChart() {
  const host = $('#chart');
  if (!host) return;
  const cfg = forecastSeries(plan());
  drawBalanceChart(host, $('#chart-readout'), cfg.series, cfg.horizon);
}

function scenarioDetail(p) {
  const key = ui.scenario;
  const r = p[key];
  const compare = key !== 'base';
  const payoffs = p.active
    .map((d) => ({ d, per: r.perDebt[d.id] }))
    .sort((a, b) => (a.per.payoffMonth ?? Infinity) - (b.per.payoffMonth ?? Infinity));
  const payoffItems = payoffs
    .map(({ d, per }) => {
      const when =
        per.payoffMonth === null
          ? '<span class="critical-text">完済できません</span>'
          : per.payoffMonth === 0
            ? '一括の余剰金ですぐ完済'
            : `${monthLabel(per.payoffMonth)}ごろ（${duration(per.payoffMonth)}後）`;
      return `<li><span class="po-name">${esc(d.name)}</span><span class="po-when">${when}</span><span class="po-int">利息 ${per.payoffMonth === null ? '—' : yen(per.interest)}</span></li>`;
    })
    .join('');
  return `
    ${key === 'base' ? '<p class="hint">余剰金を入れず、各社に毎月の返済額だけを払い続けた場合です。</p>' : ''}
    ${statsHtml(r, p.base, compare)}
    <h3 class="sub-title">会社ごとの完済時期</h3>
    <ul class="payoffs">${payoffItems}</ul>
    <h3 class="sub-title">月ごとの返済表</h3>
    ${scheduleHtml(r)}`;
}

function scheduleHtml(r) {
  const rows = [];
  if (r.lumpUsed > 0) {
    const pays = r.lumpAllocation
      .map((a) => `<li class="is-extra"><span class="sched-name">${esc(debtName(a.id))}${a.paysOff ? `<span class="tag good">${icon('check')}完済</span>` : ''}</span><span class="sched-amt">${yen(a.amount)}</span></li>`)
      .join('');
    rows.push(`
      <li class="sched">
        <div class="sched-head"><span class="sched-month">今（一括の余剰金）</span><span class="sched-left">残り ${yen(r.timeline[0].total)}</span></div>
        <ul class="sched-pays">${pays}</ul>
      </li>`);
  }
  const last = r.timeline.length - 1;
  const limit = Math.min(last, ui.scheduleLimit);
  for (let m = 1; m <= limit; m++) {
    const t = r.timeline[m];
    const pays = Object.entries(t.payments)
      .filter(([, v]) => v > 0)
      .map(([id, v]) => {
        const d = debtById(id);
        const plus = d ? v - d.payment : 0;
        const paidOff = t.balances[id] === 0;
        return `<li class="${plus > 0 ? 'is-extra' : ''}"><span class="sched-name">${esc(debtName(id))}${paidOff ? `<span class="tag good">${icon('check')}完済</span>` : ''}</span><span class="sched-amt">${plus > 0 ? `<span class="sched-plus">上乗せ +${num(plus)}</span>` : ''}${yen(v)}</span></li>`;
      })
      .join('');
    rows.push(`
      <li class="sched">
        <div class="sched-head"><span class="sched-month">${monthLabel(m)}</span><span class="sched-left">残り ${yen(t.total)}</span></div>
        <ul class="sched-pays">${pays}</ul>
      </li>`);
  }
  const rest = last - limit;
  const more = rest > 0 ? `<button type="button" class="btn btn-block" data-action="show-more">もっと見る（あと${rest}か月）</button>` : '';
  return `<ol class="schedule">${rows.join('')}</ol>${more}`;
}

function renderScenarioDetail() {
  const box = $('#scenario-detail');
  if (!box) return;
  box.innerHTML = scenarioDetail(plan());
  for (const b of $$('[data-action="scenario"]')) b.setAttribute('aria-pressed', String(b.dataset.key === ui.scenario));
}

// ---------------------------------------------------------------------
// 記録
// ---------------------------------------------------------------------

function viewRecords() {
  if (!data.debts.length) {
    return `
    <section class="card empty">
      <div class="empty-icon">${icon('list')}</div>
      <h2>まだ会社が登録されていません</h2>
      <p>ホームで会社を登録すると、返済を記録できるようになります。</p>
      <button type="button" class="btn btn-primary btn-block" data-goto="home">ホームへ</button>
    </section>`;
  }
  const hasActive = activeDebts().length > 0;
  const filter = ui.recordFilter;
  const list = data.records
    .filter((r) => filter === 'all' || r.debtId === filter)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const groups = new Map();
  for (const r of list) {
    const ym = r.date.slice(0, 7);
    if (!groups.has(ym)) groups.set(ym, []);
    groups.get(ym).push(r);
  }
  const options = [`<option value="all">すべての会社</option>`, ...data.debts.map((d) => `<option value="${esc(d.id)}" ${d.id === filter ? 'selected' : ''}>${esc(d.name)}</option>`)].join('');
  const groupHtml = [...groups.entries()]
    .map(([ym, recs]) => {
      const items = recs
        .map(
          (r) => `
        <li class="rec">
          <div class="rec-main">
            <span class="rec-date">${dayText(r.date)}</span>
            <span class="rec-name">${esc(debtName(r.debtId))}</span>
            ${r.type === 'extra' ? '<span class="tag accent">追加</span>' : ''}
            <span class="rec-amt">${yen(r.amount)}</span>
          </div>
          <div class="rec-sub">利息 ${yen(r.interest)}・元金 ${yen(r.principal)} → 残高 ${yen(r.balanceAfter)}</div>
          <button type="button" class="icon-btn rec-del" data-action="delete-record" data-id="${esc(r.id)}" aria-label="この記録を削除">${icon('trash')}</button>
        </li>`,
        )
        .join('');
      return `
      <section class="card rec-group">
        <div class="rec-group-head"><h3>${yearMonthText(ym)}</h3><span>合計 ${yen(sum(recs, (r) => r.amount))}（うち利息 ${yen(sum(recs, (r) => r.interest))}）</span></div>
        <ul class="rec-list">${items}</ul>
      </section>`;
    })
    .join('');
  return `
  <div class="toolbar">
    <button type="button" class="btn btn-primary" data-action="add-record" ${hasActive ? '' : 'disabled'}>${icon('plus')}返済を記録</button>
    <button type="button" class="btn" data-action="bulk-record" ${hasActive ? '' : 'disabled'}>今月分をまとめて記録</button>
  </div>
  <label class="field">
    <span class="field-label">表示する会社</span>
    <select class="input" id="record-filter">${options}</select>
  </label>
  ${groupHtml || '<p class="empty-text">まだ記録がありません。返済したら「返済を記録」から入れてください。残高が自動で減ります。</p>'}`;
}

// =====================================================================
// 会社の追加・編集
// =====================================================================

function openDebtForm(id) {
  const d = id ? debtById(id) : null;
  if (id && !d) return;
  openSheet(`
    ${sheetHead(d ? '会社を編集' : '会社を追加')}
    <form id="debt-form" novalidate data-id="${d ? esc(d.id) : ''}">
      <label class="field">
        <span class="field-label">会社名</span>
        <input class="input input-text" id="d-name" maxlength="30" autocomplete="off" enterkeyhint="next" placeholder="例：A社" value="${d ? esc(d.name) : ''}">
        <span class="field-error" id="d-name-err"></span>
      </label>
      ${yenField('d-balance', '今の残高', d ? num(d.balance) : '')}
      <label class="field">
        <span class="field-label">年利（実質年率）</span>
        <span class="input-wrap"><input class="input" id="d-rate" inputmode="decimal" autocomplete="off" enterkeyhint="next" value="${d ? rateText(d.rate) : ''}"><span class="suffix">%</span></span>
        <span class="field-error" id="d-rate-err"></span>
      </label>
      ${yenField('d-payment', '毎月の返済額', d ? num(d.payment) : '')}
      <div class="preview" id="d-preview"></div>
      <button type="submit" class="btn btn-primary btn-block">${d ? '保存する' : '追加する'}</button>
      ${d ? `<button type="button" class="btn btn-danger btn-block mt-12" data-action="delete-debt" data-id="${esc(d.id)}">${icon('trash')}この会社を削除</button>` : ''}
    </form>`);
  updateDebtPreview();
}

function readDebtForm() {
  const form = $('#debt-form');
  const isNew = !form.dataset.id;
  const name = $('#d-name').value.trim();
  const balance = parseYen($('#d-balance').value);
  const rate = parseRate($('#d-rate').value);
  const payment = parseYen($('#d-payment').value);
  const errors = {};
  if (!name) errors['d-name'] = '会社名を入れてください';
  if (balance === null) errors['d-balance'] = '残高を入れてください';
  else if (Number.isNaN(balance)) errors['d-balance'] = '数字で入れてください（例：500000 または 50万）';
  else if (isNew && balance === 0) errors['d-balance'] = '残高が0円の会社は登録できません';
  if (rate === null) errors['d-rate'] = '年利を入れてください';
  else if (Number.isNaN(rate) || rate > 100) errors['d-rate'] = '0〜100の数字で入れてください（例：15 または 14.6）';
  if (payment === null) errors['d-payment'] = '毎月の返済額を入れてください';
  else if (Number.isNaN(payment)) errors['d-payment'] = '数字で入れてください（例：15000 または 1.5万）';
  else if (payment < 1) errors['d-payment'] = '1円以上にしてください';
  return { values: { name, balance, rate, payment }, errors };
}

function updateDebtPreview() {
  const form = $('#debt-form');
  if (!form) return;
  const { values: v, errors } = readDebtForm();
  if (form.dataset.submitted) {
    for (const id of ['d-name', 'd-balance', 'd-rate', 'd-payment']) setError(id, errors[id]);
  }
  const box = $('#d-preview');
  if (errors['d-balance'] || errors['d-rate'] || errors['d-payment']) {
    box.innerHTML = '';
    return;
  }
  if (v.balance === 0) {
    box.innerHTML = '残高を0円にすると「完済」になります。';
    return;
  }
  const interest = monthlyInterest(v.balance, v.rate);
  let html = `月の利息の目安：<strong>${yen(interest)}</strong>`;
  if (v.payment <= interest) {
    html += `<br><span class="critical-text">毎月の返済額が利息以下なので、このままでは残高が減りません。</span>`;
  } else {
    const r = simulate([{ id: 'x', balance: v.balance, rate: v.rate, payment: v.payment }]);
    html += r.finished
      ? `<br>このまま返すと：<strong>${duration(r.months)}</strong>で完済（${monthLabel(r.months)}ごろ）・利息の合計 <strong>${yen(r.totalInterest)}</strong>`
      : '<br>このままだと完済まで50年以上かかります。';
  }
  if (v.rate > 20) html += '<br>年20%を超えています。入力に間違いがないか確かめてください。';
  box.innerHTML = html;
}

function submitDebtForm(form) {
  form.dataset.submitted = '1';
  const { values: v, errors } = readDebtForm();
  for (const id of ['d-name', 'd-balance', 'd-rate', 'd-payment']) setError(id, errors[id]);
  if (Object.keys(errors).length) {
    document.getElementById(Object.keys(errors)[0])?.focus();
    return;
  }
  const now = nowISO();
  const id = form.dataset.id;
  let paidOff = [];
  if (id) {
    const d = debtById(id);
    if (!d) return;
    const wasActive = d.balance > 0;
    Object.assign(d, { name: v.name, balance: v.balance, rate: v.rate, payment: v.payment, updatedAt: now });
    if (d.balance > d.startBalance) d.startBalance = d.balance;
    if (wasActive && d.balance === 0) paidOff = [d.id];
  } else {
    data.debts.push({ id: uid(), name: v.name, balance: v.balance, rate: v.rate, payment: v.payment, startBalance: v.balance, createdAt: now, updatedAt: now });
  }
  persist();
  closeSheet();
  render();
  toast(id ? '保存しました' : `${v.name} を追加しました`);
  if (paidOff.length) celebrate(paidOff);
}

async function deleteDebt(id) {
  const d = debtById(id);
  if (!d) return;
  const count = data.records.filter((r) => r.debtId === id).length;
  const ok = await confirmDialog({
    title: `${d.name} を削除しますか？`,
    message: count ? `この会社の返済の記録（${count}件）も消えます。元には戻せません。` : '元には戻せません。',
    okLabel: '削除する',
    danger: true,
  });
  if (!ok) return;
  data.debts = data.debts.filter((x) => x.id !== id);
  data.records = data.records.filter((r) => r.debtId !== id);
  if (ui.recordFilter === id) ui.recordFilter = 'all';
  persist();
  closeSheet();
  render();
  toast('削除しました');
}

// =====================================================================
// 返済の記録
// =====================================================================

/** 記録を1件追加して残高を減らす。完済したら true */
function addRecord({ debtId, date, type, amount, interest }) {
  const d = debtById(debtId);
  const principal = amount - interest;
  const before = d.balance;
  d.balance = before - principal;
  d.updatedAt = nowISO();
  data.records.push({ id: uid(), debtId, date, type, amount, interest, principal, balanceAfter: d.balance, createdAt: nowISO() });
  return before > 0 && d.balance === 0;
}

function openRecordForm(debtId) {
  const debts = activeDebts();
  if (!debts.length) {
    toast('返済中の会社がありません');
    return;
  }
  const sel = debtId && debts.some((d) => d.id === debtId) ? debtId : debts[0].id;
  openSheet(`
    ${sheetHead('返済を記録')}
    <form id="record-form" novalidate data-type="regular">
      <label class="field">
        <span class="field-label">会社</span>
        <select class="input" id="r-debt">${debts.map((d) => `<option value="${esc(d.id)}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}（残高 ${yen(d.balance)}）</option>`).join('')}</select>
      </label>
      <label class="field">
        <span class="field-label">払った日</span>
        <input class="input input-text" type="date" id="r-date" value="${todayISO()}">
      </label>
      <div class="field">
        <span class="field-label">種類</span>
        <div class="segmented" id="r-type">
          <button type="button" data-rtype="regular" aria-pressed="true">毎月の返済</button>
          <button type="button" data-rtype="extra" aria-pressed="false">追加の返済</button>
        </div>
      </div>
      ${yenField('r-amount', '払った額')}
      ${yenField('r-interest', 'うち利息')}
      <p class="hint" id="r-hint"></p>
      <div class="preview" id="r-preview"></div>
      <button type="submit" class="btn btn-primary btn-block">記録する</button>
    </form>`);
  fillRecordDefaults();
}

/** 会社や種類を変えたとき、まだ手で直していない欄に目安を入れる */
function fillRecordDefaults() {
  const form = $('#record-form');
  if (!form) return;
  const d = debtById($('#r-debt').value);
  if (!d) return;
  const type = form.dataset.type;
  const interest = type === 'regular' ? monthlyInterest(d.balance, d.rate) : 0;
  if (!form.dataset.amountDirty) $('#r-amount').value = type === 'regular' ? num(Math.min(d.payment, d.balance + interest)) : '';
  if (!form.dataset.interestDirty) $('#r-interest').value = num(interest);
  $('#r-hint').textContent =
    type === 'regular'
      ? '利息は「残高 × 年利 ÷ 12」の目安です。明細に書かれた額があれば、その額に直してください。'
      : '追加の返済は、全額が元金に充てられるとして利息を0円にしています。明細に利息が書かれていれば入れてください。';
  updateRecordPreview();
}

function readRecordForm() {
  const d = debtById($('#r-debt').value);
  const amount = parseYen($('#r-amount').value);
  const interest = parseYen($('#r-interest').value) ?? 0;
  const date = $('#r-date').value;
  const errors = {};
  if (amount === null) errors['r-amount'] = '払った額を入れてください';
  else if (Number.isNaN(amount)) errors['r-amount'] = '数字で入れてください';
  else if (amount === 0) errors['r-amount'] = '1円以上にしてください';
  if (Number.isNaN(interest)) errors['r-interest'] = '数字で入れてください';
  else if (!errors['r-amount'] && interest > amount) errors['r-interest'] = '利息が、払った額より多くなっています';
  if (!errors['r-amount'] && !errors['r-interest'] && d && amount - interest > d.balance) {
    errors['r-amount'] = `元金に充てる額が、残高（${yen(d.balance)}）を超えています。払った額か利息を見直してください`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors['r-date'] = '日付を選んでください';
  return { d, amount, interest, date, errors };
}

function updateRecordPreview() {
  const form = $('#record-form');
  if (!form) return;
  const { d, amount, interest, errors } = readRecordForm();
  if (form.dataset.submitted) for (const id of ['r-amount', 'r-interest']) setError(id, errors[id]);
  const box = $('#r-preview');
  if (!d || errors['r-amount'] || errors['r-interest']) {
    box.innerHTML = '';
    return;
  }
  const principal = amount - interest;
  const after = d.balance - principal;
  box.innerHTML = `元金に充てる額：<strong>${yen(principal)}</strong><br>返済後の残高：<strong>${yen(d.balance)} → ${yen(after)}</strong>${after === 0 ? ` <span class="tag good">${icon('check')}完済</span>` : ''}`;
}

function submitRecordForm(form) {
  form.dataset.submitted = '1';
  const { d, amount, interest, date, errors } = readRecordForm();
  for (const id of ['r-amount', 'r-interest']) setError(id, errors[id]);
  if (errors['r-date']) {
    toast(errors['r-date']);
    return;
  }
  if (Object.keys(errors).length || !d) return;
  const paidOff = addRecord({ debtId: d.id, date, type: form.dataset.type, amount, interest });
  persist();
  closeSheet();
  render();
  toast('記録しました');
  if (paidOff) celebrate([d.id]);
}

function openBulkForm() {
  const debts = activeDebts();
  if (!debts.length) return;
  const p = buildPlan(data.debts, { ...data.plan, lumpSum: 0 });
  const pays = p[p.recommended].timeline[1]?.payments ?? {};
  const rows = debts
    .map(
      (d) => `
      <div class="bulk-row">
        <div class="bulk-name">${esc(d.name)}<small>残高 ${yen(d.balance)}・利息の目安 ${yen(monthlyInterest(d.balance, d.rate))}</small></div>
        <span class="input-wrap"><input class="input" id="b-${esc(d.id)}" data-yen data-bulk="${esc(d.id)}" inputmode="numeric" autocomplete="off" value="${num(pays[d.id] ?? 0)}"><span class="suffix">円</span></span>
        <span class="field-error" id="b-${esc(d.id)}-err"></span>
      </div>`,
    )
    .join('');
  openSheet(`
    ${sheetHead('今月分をまとめて記録')}
    <form id="bulk-form" novalidate>
      <label class="field">
        <span class="field-label">払った日</span>
        <input class="input input-text" type="date" id="b-date" value="${todayISO()}">
      </label>
      <p class="hint mb-8">提案どおりの額を入れています。実際に払った額と違う会社は直してください。0円の会社は記録しません。利息は「残高 × 年利 ÷ 12」の目安で記録します。</p>
      ${rows}
      <button type="submit" class="btn btn-primary btn-block mt-16">まとめて記録</button>
    </form>`);
}

function submitBulkForm(form) {
  const date = $('#b-date').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    toast('日付を選んでください');
    return;
  }
  const entries = [];
  let hasError = false;
  for (const input of $$('[data-bulk]', form)) {
    const d = debtById(input.dataset.bulk);
    const amount = parseYen(input.value) ?? 0;
    let err = '';
    if (Number.isNaN(amount)) err = '数字で入れてください';
    else if (d && amount > 0) {
      const interest = Math.min(amount, monthlyInterest(d.balance, d.rate));
      if (amount - interest > d.balance) err = `残高（${yen(d.balance)}）と利息の合計より多くなっています`;
      else entries.push({ debtId: d.id, date, type: 'regular', amount, interest });
    }
    setError(input.id, err);
    if (err) hasError = true;
  }
  if (hasError) return;
  if (!entries.length) {
    toast('記録する額がありません');
    return;
  }
  const paidOff = entries.filter((e) => addRecord(e)).map((e) => e.debtId);
  persist();
  closeSheet();
  render();
  toast(`${entries.length}社分を記録しました`);
  if (paidOff.length) celebrate(paidOff);
}

async function deleteRecord(id) {
  const r = data.records.find((x) => x.id === id);
  if (!r) return;
  const d = debtById(r.debtId);
  const ok = await confirmDialog({
    title: 'この記録を削除しますか？',
    message: `${debtName(r.debtId)}・${r.date.replace(/-/g, '/')}・${yen(r.amount)}${d ? `\n削除すると、残高が ${yen(d.balance)} → ${yen(d.balance + r.principal)} に戻ります。` : ''}`,
    okLabel: '削除する',
    danger: true,
  });
  if (!ok) return;
  if (d) {
    d.balance += r.principal;
    if (d.balance > d.startBalance) d.startBalance = d.balance;
    d.updatedAt = nowISO();
  }
  data.records = data.records.filter((x) => x.id !== id);
  persist();
  render();
  toast('削除しました');
}

async function recordLump() {
  const p = plan();
  const r = p[p.recommended];
  if (!r.lumpAllocation.length) return;
  const list = r.lumpAllocation.map((a) => `<li><span>${esc(debtName(a.id))}</span><strong>${yen(a.amount)}</strong></li>`).join('');
  const ok = await confirmDialog({
    title: '一括返済を記録しますか？',
    message: '次の額を「追加の返済」として今日の日付で記録し、残高を減らします。入れた「今ある余剰金」は0円に戻します。',
    html: `<ul class="modal-list">${list}</ul>`,
    okLabel: '記録する',
  });
  if (!ok) return;
  const date = todayISO();
  const paidOff = r.lumpAllocation.filter((a) => addRecord({ debtId: a.id, date, type: 'extra', amount: a.amount, interest: 0 })).map((a) => a.id);
  data.plan.lumpSum = 0;
  persist();
  render();
  toast('記録しました');
  if (paidOff.length) celebrate(paidOff);
}

/** 完済したときのお祝いと、浮いたお金の使い道の確認 */
async function celebrate(ids) {
  const stillActive = activeDebts().length > 0;
  const withBudget = !isBudgetEmpty(data.budget); // 家計を使っているときだけ、家計の話をする
  if (!stillActive) {
    await alertDialog({
      title: 'すべての会社を完済しました！',
      message: `おつかれさまでした。記録はこのまま残ります。${withBudget ? '\n家計の「自由に使える額」は、返済と返済への上乗せがなくなったぶん、増えます。' : ''}`,
      okLabel: 'やった！',
    });
    return;
  }
  for (const id of ids) {
    const d = debtById(id);
    if (!d) continue;
    // 2つの選び方の意味を、はっきり書く（ボタンは「余剰金に足す」「自由に使う」）
    const ok = await confirmDialog({
      title: `${d.name} を完済しました！`,
      message: [
        'おめでとうございます。',
        `${d.name} に毎月払っていた ${yen(d.payment)} が、浮きます。使い道を選んでください。`,
        '',
        `・余剰金に足す：「毎月の余剰金」に ${yen(d.payment)} を足して、ほかの会社の返済に回します。完済が早まります。`,
        `・自由に使う（足さない）：返済には回さず、自由に使えるお金にします。${withBudget ? `家計の「自由に使える額」が、${yen(d.payment)} 増えます。` : ''}`,
        '',
        '（あとから提案の画面で変えられます）',
      ].join('\n'),
      okLabel: '余剰金に足す',
      cancelLabel: '自由に使う',
    });
    if (ok) {
      data.plan.monthlyExtra += d.payment;
      persist();
      toast(`毎月の余剰金を ${yen(data.plan.monthlyExtra)} にしました`);
    } else {
      toast('足さずに、自由に使えるお金にしました');
    }
  }
  render();
}

// =====================================================================
// 設定・ロック・バックアップ
// =====================================================================

async function openSettings() {
  const st = lock.info();
  const pkSupported = await lock.passkeySupported();
  const last = data.meta.lastBackupAt;
  const standalone = matchMedia('(display-mode: standalone)').matches;
  let lockHtml;
  if (st.enabled) {
    let pk;
    if (st.passkey) pk = '<button type="button" class="btn" data-action="passkey-remove">指紋・顔認証をやめる</button>';
    else if (pkSupported) pk = `<button type="button" class="btn btn-primary" data-action="passkey-add">${icon('fingerprint')}指紋・顔認証を使う</button>`;
    else pk = '<p class="hint">この端末・ブラウザでは、指紋・顔認証を使えません。</p>';
    lockHtml = `
      <div class="set-row"><span>パスコード</span><span class="tag good">${icon('check')}オン</span></div>
      <div class="set-row"><span>指紋・顔認証</span>${st.passkey ? `<span class="tag good">${icon('check')}オン</span>` : '<span class="tag">オフ</span>'}</div>
      <div class="btn-col">
        ${pk}
        <button type="button" class="btn" data-action="pin-change">パスコードを変える</button>
        <button type="button" class="btn btn-danger" data-action="lock-off">ロックをやめる</button>
      </div>
      <p class="hint">アプリから離れて1分たつと、もう一度ロックがかかります。</p>`;
  } else {
    lockHtml = `
      <p class="set-text">アプリを開くときに、4桁のパスコードを求めます。そのあと、指紋・顔認証も登録できます。</p>
      <button type="button" class="btn btn-primary btn-block" data-action="lock-setup">${icon('lock')}パスコードを設定する</button>`;
  }
  openSheet(`
    ${sheetHead('設定')}
    <div id="settings-root">
      <section class="set-sec">
        <h3 class="set-title">${icon('lock')}ロック</h3>
        ${lockHtml}
      </section>
      <section class="set-sec">
        <h3 class="set-title">${icon('download')}バックアップ</h3>
        <p class="set-text">最後のバックアップ：${last ? dateText(last) : 'まだありません'}</p>
        <div class="btn-col">
          <button type="button" class="btn" data-action="export">${icon('download')}ファイルに書き出す</button>
          <button type="button" class="btn" data-action="import">${icon('upload')}ファイルから読み込む</button>
        </div>
        <p class="hint">書き出したファイルは暗号化されません。人に見られない場所に保存してください。機種変更のときは、このファイルを新しいスマホで読み込みます。</p>
      </section>
      ${
        ui.installPrompt && !standalone
          ? `<section class="set-sec">
        <h3 class="set-title">${icon('phone')}ホーム画面</h3>
        <button type="button" class="btn btn-block" data-action="install">ホーム画面に追加する</button>
      </section>`
          : ''
      }
      <section class="set-sec">
        <h3 class="set-title">${icon('info')}計算について</h3>
        <ul class="set-list">
          <li>利息は「残高 × 年利 ÷ 12」で毎月かかるとして計算します（1円未満は切り捨て）。実際の会社は日割りで計算するため、少しずれることがあります。</li>
          <li>毎月の返済額は一定として計算します。</li>
          <li>提案では、毎月の返済の総額を変えずに、完済した会社の分を次の会社に回します。</li>
          <li>50年を超える計算は打ち切ります。</li>
        </ul>
      </section>
      <section class="set-sec">
        <h3 class="set-title">${icon('trash')}データ</h3>
        <p class="set-text">データはこのスマホのブラウザの中だけに保存され、外部には送られません。</p>
        <button type="button" class="btn btn-danger btn-block" data-action="wipe">すべてのデータを消す</button>
      </section>
      <p class="version">完済ナビ v${APP_VERSION}</p>
    </div>`);
}

const settingsOpen = () => !!$('#settings-root');
async function refreshSettings() {
  if (settingsOpen()) await openSettings();
}

async function newPinFlow() {
  const first = await askPin({ title: '新しいパスコード', subtitle: '4桁の数字を決めてください' });
  if (!first) return null;
  return askPin({
    title: 'もう一度入力',
    subtitle: '確認のため、同じ4桁を入れてください',
    validate: (pin) => (pin === first ? null : '最初に入れた数字と違います'),
  });
}

async function confirmCurrentPin(title) {
  const pin = await askPin({
    title,
    subtitle: '今のパスコードを入れてください',
    validate: async (p) => {
      const r = await lock.checkPin(p);
      if (r.ok) return null;
      return r.waitMs ? `間違いが続いたため、${Math.ceil(r.waitMs / 1000)}秒待ってから入れてください` : 'パスコードが違います';
    },
  });
  return !!pin;
}

async function addPasskey() {
  try {
    await lock.registerPasskey();
    toast('指紋・顔認証を登録しました');
  } catch (e) {
    if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') toast('登録をやめました');
    else await alertDialog({ title: '登録できませんでした', message: lock.describeError(e) });
  }
}

async function setupLock() {
  const pin = await newPinFlow();
  if (!pin) return;
  await lock.setPin(pin);
  toast('パスコードを設定しました');
  if (await lock.passkeySupported()) {
    const ok = await confirmDialog({
      title: '指紋・顔認証も使いますか？',
      message: '次からは、指紋や顔でロックを解除できます。うまくいかないときは、パスコードで解除できます。',
      okLabel: '使う',
      cancelLabel: 'あとで',
    });
    if (ok) await addPasskey();
  }
  await refreshSettings();
}

async function changePin() {
  if (!(await confirmCurrentPin('パスコードを変える'))) return;
  const pin = await newPinFlow();
  if (!pin) return;
  await lock.setPin(pin);
  toast('パスコードを変えました');
  await refreshSettings();
}

async function turnOffLock() {
  if (!(await confirmCurrentPin('ロックをやめる'))) return;
  await lock.disable();
  toast('ロックをやめました');
  await refreshSettings();
}

async function removePasskey() {
  const ok = await confirmDialog({
    title: '指紋・顔認証をやめますか？',
    message: '次からは、パスコードだけで解除します。',
    okLabel: 'やめる',
  });
  if (!ok) return;
  await lock.forgetPasskey();
  toast('指紋・顔認証をやめました');
  await refreshSettings();
}

function exportBackup() {
  const blob = new Blob([makeBackup(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kanzai-navi-backup-${fileDate()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  data.meta.lastBackupAt = nowISO();
  persist({ touch: false });
  toast('バックアップを書き出しました（ダウンロードに保存）');
  if (settingsOpen()) refreshSettings();
  else render();
}

const BUDGET_EMPTY_TEXT = '入っていません';

/** 家計に入っているものの件数（バックアップの確認ダイアログ用） */
function budgetCountText(b) {
  const parts = [];
  if (b.incomes.length) parts.push(`収入${b.incomes.length}件`);
  if (b.fixed.length) parts.push(`固定費${b.fixed.length}件`);
  if (b.entries.length) parts.push(`変わる収入${b.entries.length}件`);
  if (b.spends.length) parts.push(`出費${b.spends.length}件`);
  return parts.length ? parts.join('・') : BUDGET_EMPTY_TEXT;
}

async function importBackup(file) {
  if (file.size > 5 * 1024 * 1024) {
    await alertDialog({ title: '読み込めませんでした', message: 'ファイルが大きすぎます。書き出したバックアップのファイルを選んでください。' });
    return;
  }
  let parsed;
  try {
    parsed = readBackup(await file.text());
  } catch (e) {
    await alertDialog({ title: '読み込めませんでした', message: e.message });
    return;
  }
  const next = parsed.data;
  const budgetNow = budgetCountText(data.budget);
  const lines = [
    parsed.exportedAt ? `${dateText(parsed.exportedAt)}に書き出したファイルです。` : '',
    `会社 ${next.debts.length}社・記録 ${next.records.length}件${parsed.format >= 2 ? `・家計（${budgetCountText(next.budget)}）` : ''}を読み込みます。`,
    `今のデータ（会社 ${data.debts.length}社・記録 ${data.records.length}件・家計（${budgetNow}））は消えて、入れ替わります。`,
  ];
  // format 1 のファイルには家計が入っていない。読み込むと、今の家計も空になる
  if (parsed.format < 2 && budgetNow !== BUDGET_EMPTY_TEXT) lines.push('このファイルは古い形式で、家計のデータが入っていません。読み込むと、今の家計は空になります。');
  const ok = await confirmDialog({
    title: 'バックアップを読み込みますか？',
    message: lines.filter(Boolean).join('\n'),
    okLabel: '読み込む',
    danger: data.debts.length > 0 || budgetNow !== BUDGET_EMPTY_TEXT,
  });
  if (!ok || ui.locked) return;
  next.meta.lastBackupAt = parsed.exportedAt || data.meta.lastBackupAt;
  data = next;
  ui.recordFilter = 'all';
  persist();
  closeSheet();
  render();
  toast('読み込みました');
}

async function wipeAll() {
  await lock.disable();
  removeAllStorage();
  data = emptyData();
  ui.recordFilter = 'all';
  ui.tab = 'home';
  closeAllDialogs();
  if (ui.locked) unlock();
  else render();
  toast('すべてのデータを消しました');
}

async function confirmWipe() {
  const ok = await confirmDialog({
    title: 'すべてのデータを消しますか？',
    message: '会社・返済の記録・家計・ロックの設定がすべて消えます。元には戻せません。\n（バックアップのファイルがあれば、読み込んで戻せます。ロックの設定は戻りません）',
    okLabel: 'すべて消す',
    danger: true,
  });
  if (ok) await wipeAll();
}

// ---- ロック画面 ----

let lockPad = null;
let passkeyAbort = null;
let passkeyBusy = false;
let lockWaitTimer = null;

function showLockScreen() {
  closeAllDialogs();
  ui.locked = true;
  $('#app').hidden = true;
  $('#view').innerHTML = '';
  document.body.classList.remove('covered');
  const st = lock.info();
  const box = $('#lock');
  box.innerHTML = `
    <div class="lock-inner">
      <div class="lock-icon">${icon('lock')}</div>
      <h1 class="lock-title">完済ナビ</h1>
      <p class="lock-sub">${st.passkey ? '指紋・顔認証か、パスコードで解除します' : 'パスコードを入れてください'}</p>
      <div class="lock-pad"></div>
      <button type="button" class="link-btn lock-forgot" data-lock-action="forgot">パスコードを忘れたとき</button>
    </div>`;
  lockPad?.detachKeyboard();
  lockPad = createPinPad({
    onComplete: async (pin, pad) => {
      const res = await lock.checkPin(pin);
      if (res.ok) unlock();
      else if (res.waitMs) startLockWait(res.waitMs);
      else pad.error('パスコードが違います');
    },
    leftKey: st.passkey ? { label: '指紋・顔認証で解除', icon: icon('fingerprint'), onPress: () => tryPasskey() } : null,
  });
  $('.lock-pad', box).append(lockPad.el);
  box.hidden = false;
  lockPad.attachKeyboard();
  const wait = lock.waitRemaining();
  if (wait) startLockWait(wait);
  else if (st.passkey && document.visibilityState === 'visible') setTimeout(() => tryPasskey(), 300);
}

function startLockWait(ms) {
  if (!lockPad) return;
  clearInterval(lockWaitTimer);
  const until = Date.now() + ms;
  lockPad.reset();
  lockPad.setDisabled(true);
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(lockWaitTimer);
      lockPad?.setDisabled(false);
      lockPad?.message('もう一度入れてください');
      return;
    }
    lockPad?.message(`間違いが続いたため、${left}秒待ってください`);
  };
  tick();
  lockWaitTimer = setInterval(tick, 1000);
}

async function tryPasskey() {
  if (passkeyBusy || !ui.locked) return;
  passkeyBusy = true;
  passkeyAbort = new AbortController();
  try {
    const ok = await lock.unlockWithPasskey(passkeyAbort.signal);
    if (ok) unlock();
    else lockPad?.message('指紋・顔認証で確認できませんでした。パスコードを入れてください');
  } catch (e) {
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') lockPad?.message(lock.describeError(e));
  } finally {
    passkeyBusy = false;
    passkeyAbort = null;
  }
}

function unlock() {
  passkeyAbort?.abort();
  clearInterval(lockWaitTimer);
  lockPad?.detachKeyboard();
  lockPad = null;
  ui.locked = false;
  const box = $('#lock');
  box.hidden = true;
  box.innerHTML = '';
  $('#app').hidden = false;
  render();
}

async function forgotPin() {
  const ok = await confirmDialog({
    title: 'パスコードを忘れたとき',
    message:
      'パスコードを確かめる方法はありません。\nすべてのデータを消して、最初からやり直すことはできます。バックアップのファイルがあれば、やり直したあとに読み込んで元に戻せます。',
    okLabel: 'すべて消してやり直す',
    danger: true,
  });
  if (!ok) return;
  const ok2 = await confirmDialog({
    title: '本当に消しますか？',
    message: '会社・返済の記録・家計が、すべて消えます。元には戻せません。',
    okLabel: '消す',
    danger: true,
  });
  if (ok2) await wipeAll();
}

// =====================================================================
// 操作の受け付け
// =====================================================================

async function onClick(e) {
  const t = e.target;
  const lockBtn = t.closest('[data-lock-action]');
  if (lockBtn) {
    if (lockBtn.dataset.lockAction === 'forgot') forgotPin();
    return;
  }
  if (ui.locked) return;

  const tab = t.closest('.tabbar [data-tab]');
  if (tab) {
    switchTab(tab.dataset.tab);
    return;
  }
  const go = t.closest('[data-goto]');
  if (go) {
    closeSheet();
    switchTab(go.dataset.goto);
    return;
  }
  const rtype = t.closest('[data-rtype]');
  if (rtype) {
    const form = $('#record-form');
    form.dataset.type = rtype.dataset.rtype;
    for (const b of $$('[data-rtype]', form)) b.setAttribute('aria-pressed', String(b === rtype));
    fillRecordDefaults();
    return;
  }
  const btn = t.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action.startsWith('b-') && budgetView.onAction(btn)) return; // 家計の操作
  const id = btn.dataset.id;
  switch (btn.dataset.action) {
    case 'add-debt':
      openDebtForm();
      break;
    case 'edit-debt':
      openDebtForm(id);
      break;
    case 'delete-debt':
      deleteDebt(id);
      break;
    case 'add-record':
      openRecordForm(id);
      break;
    case 'bulk-record':
      openBulkForm();
      break;
    case 'delete-record':
      deleteRecord(id);
      break;
    case 'record-lump':
      recordLump();
      break;
    case 'scenario':
      ui.scenario = btn.dataset.key;
      ui.scheduleLimit = 12;
      renderScenarioDetail();
      break;
    case 'show-more':
      ui.scheduleLimit += 24;
      renderScenarioDetail();
      break;
    case 'open-settings':
      openSettings();
      break;
    case 'close-sheet':
      closeSheet();
      break;
    case 'lock-setup':
      setupLock();
      break;
    case 'pin-change':
      changePin();
      break;
    case 'lock-off':
      turnOffLock();
      break;
    case 'passkey-add':
      await addPasskey();
      await refreshSettings();
      break;
    case 'passkey-remove':
      removePasskey();
      break;
    case 'export':
      exportBackup();
      break;
    case 'import':
      $('#import-file').click();
      break;
    case 'wipe':
      confirmWipe();
      break;
    case 'install': {
      const ev = ui.installPrompt;
      if (!ev) break;
      ui.installPrompt = null;
      ev.prompt();
      try {
        await ev.userChoice;
      } catch {
        /* 何もしない */
      }
      if (settingsOpen()) refreshSettings();
      else render();
      break;
    }
    case 'dismiss-install':
      setFlag('install-dismissed');
      render();
      break;
    default:
      break;
  }
}

function onSubmit(e) {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  e.preventDefault();
  if (ui.locked) return;
  if (form.id === 'debt-form') submitDebtForm(form);
  else if (form.id === 'record-form') submitRecordForm(form);
  else if (form.id === 'bulk-form') submitBulkForm(form);
  else budgetView.onSubmit(form);
}

function onPlanInput(input) {
  const v = parseYen(input.value);
  if (v !== null && Number.isNaN(v)) {
    setError(input.id, '数字で入れてください（例：50000 または 5万）');
    return;
  }
  setError(input.id, '');
  if (input.id === 'plan-lump') data.plan.lumpSum = v ?? 0;
  else data.plan.monthlyExtra = v ?? 0;
  persist();
  renderPlanResult();
}

function onInput(e) {
  const t = e.target;
  if (ui.locked) return;
  if (t.id === 'plan-lump' || t.id === 'plan-extra') onPlanInput(t);
  else if (t.closest('#debt-form')) updateDebtPreview();
  else if (t.closest('#record-form')) {
    if (t.id === 'r-amount') t.form.dataset.amountDirty = '1';
    if (t.id === 'r-interest') t.form.dataset.interestDirty = '1';
    updateRecordPreview();
  } else budgetView.onInput(t);
}

function onChange(e) {
  const t = e.target;
  if (ui.locked) return;
  if (ui.tab === 'budget' && budgetView.onChange(t)) return;
  if (t.id === 'record-filter') {
    ui.recordFilter = t.value;
    render();
  } else if (t.id === 'r-debt') {
    fillRecordDefaults();
  } else if (t.id === 'import-file') {
    const file = t.files?.[0];
    t.value = '';
    if (file) importBackup(file);
  }
}

/** 金額の欄から離れたら「12,000」の形にそろえる */
function onFocusOut(e) {
  const t = e.target;
  if (t.matches?.('input[data-yen]')) t.value = yenInputValue(t.value);
}

function onVisibility() {
  if (!lock.isEnabled()) return;
  if (document.visibilityState === 'hidden') {
    ui.hiddenAt = Date.now();
    if (!ui.locked) document.body.classList.add('covered'); // 履歴の画面に中身を映さない
  } else {
    const away = ui.hiddenAt ? Date.now() - ui.hiddenAt : 0;
    ui.hiddenAt = 0;
    if (!ui.locked && away >= RELOCK_AFTER_MS) showLockScreen();
    document.body.classList.remove('covered');
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('新しいバージョンになりました。次に開いたときから使えます');
  });
}

function init() {
  for (const el of $$('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
  setupDialogs();
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener(
    'resize',
    debounce(() => {
      if (ui.locked) return;
      if (ui.tab === 'forecast') drawForecastChart();
      else if (ui.tab === 'budget') budgetView.afterRender();
    }, 150),
  );
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    ui.installPrompt = e;
    if (ui.tab === 'home' && !ui.locked) render();
  });
  window.addEventListener('appinstalled', () => {
    ui.installPrompt = null;
    if (!ui.locked) render();
  });
  registerServiceWorker();
  budgetView.closePeriods(); // 閉じている間に終わった期間の結果を確定する（ロック中でも行う。画面には何も出さない）

  if (lock.isEnabled()) showLockScreen();
  else {
    $('#app').hidden = false;
    render();
  }
}

init();
