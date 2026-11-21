// 残高の減り方の折れ線グラフ（SVG）。指でなぞると、その月の値を上の欄に出す

import { axisYen, elapsedShort, monthLabel, duration, yen } from './format.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const PLOT_H = 200;
const PAD = { top: 10, right: 14, bottom: 26, left: 46 };

function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function niceScale(max, ticks) {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag);
  return { step, max: Math.ceil(max / step - 1e-9) * step };
}

/** 横軸の目盛りの間隔（ラベルが重ならない範囲で細かく） */
function xStep(months, maxLabels) {
  const candidates = months <= 12 ? [1, 2, 3, 6, 12] : months <= 36 ? [6, 12, 24] : [12, 24, 36, 60, 120, 240];
  for (const c of candidates) if (Math.floor(months / c) + 1 <= maxLabels) return c;
  return candidates[candidates.length - 1];
}

/**
 * @param {HTMLElement} host グラフを入れる場所
 * @param {HTMLElement} readout なぞった月の値を出す場所
 * @param {Array<{key:string, label:string, values:number[]}>} series 凡例の順（最初が強調するもの）
 * @param {number} horizon 横軸の月数
 */
export function drawBalanceChart(host, readout, series, horizon) {
  host.replaceChildren();
  const width = Math.max(260, Math.floor(host.clientWidth || 320));
  const height = PAD.top + PLOT_H + PAD.bottom;
  const iw = width - PAD.left - PAD.right;
  const X = Math.max(1, horizon);
  const valueAt = (s, m) => (m < s.values.length ? s.values[m] : 0);

  let maxV = 1;
  for (const s of series) for (let m = 0; m <= X; m++) maxV = Math.max(maxV, valueAt(s, m));
  const { max: yMax, step: yStep } = niceScale(maxV, 4);
  const x = (m) => PAD.left + (m / X) * iw;
  const y = (v) => PAD.top + PLOT_H - (v / yMax) * PLOT_H;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' });

  // 目盛り線（横）と縦軸のラベル
  const grid = svgEl('g', { class: 'grid' });
  for (let i = 0; i * yStep <= yMax + 1e-6; i++) {
    const v = i * yStep;
    if (v > 0) grid.append(svgEl('line', { x1: PAD.left, x2: width - PAD.right, y1: y(v), y2: y(v) }));
    const t = svgEl('text', { x: PAD.left - 8, y: y(v), class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' });
    t.textContent = axisYen(v);
    svg.append(t);
  }
  svg.append(grid);
  svg.append(svgEl('line', { x1: PAD.left, x2: width - PAD.right, y1: y(0), y2: y(0), class: 'baseline' }));

  // 横軸のラベル（今からの期間）
  const step = xStep(X, Math.max(2, Math.floor(iw / 56)));
  for (let m = 0; m <= X; m += step) {
    const px = x(m);
    const anchor = m === 0 ? 'start' : px > width - PAD.right - 18 ? 'end' : 'middle';
    const t = svgEl('text', { x: m === 0 ? px - 2 : px, y: height - 6, class: 'tick', 'text-anchor': anchor });
    t.textContent = elapsedShort(m);
    svg.append(t);
  }

  // 折れ線（強調するものを最後に描いて手前に出す）
  for (const s of [...series].reverse()) {
    const last = Math.min(X, s.values.length - 1);
    const pts = [];
    for (let m = 0; m <= last; m++) pts.push(`${x(m).toFixed(1)},${y(s.values[m]).toFixed(1)}`);
    if (pts.length === 1) pts.push(pts[0]);
    svg.append(svgEl('polyline', { points: pts.join(' '), class: `line s-${s.key}` }));
    if (s.values.length - 1 <= X && s.values[s.values.length - 1] === 0) {
      svg.append(svgEl('circle', { cx: x(last), cy: y(0), r: 4, class: `end-dot d-${s.key}` }));
    }
  }

  // なぞったときの縦線と点
  const cross = svgEl('g', { visibility: 'hidden' });
  const vline = svgEl('line', { y1: PAD.top, y2: PAD.top + PLOT_H, class: 'crosshair' });
  cross.append(vline);
  const dots = series.map((s) => {
    const c = svgEl('circle', { r: 4, class: `cross-dot d-${s.key}` });
    cross.append(c);
    return c;
  });
  svg.append(cross);
  host.append(svg);

  let current = null;
  function show(m) {
    current = m;
    const px = x(m);
    vline.setAttribute('x1', px);
    vline.setAttribute('x2', px);
    series.forEach((s, i) => {
      dots[i].setAttribute('cx', px);
      dots[i].setAttribute('cy', y(valueAt(s, m)));
    });
    cross.setAttribute('visibility', 'visible');

    const head = document.createElement('div');
    head.className = 'ro-head';
    head.textContent = `${monthLabel(m)}${m === 0 ? '（今）' : `（${duration(m)}後）`}の残高`;
    const rows = series.map((s) => {
      const row = document.createElement('div');
      row.className = 'ro-row';
      const key = document.createElement('span');
      key.className = `lkey k-${s.key}`;
      const val = document.createElement('strong');
      val.className = 'ro-val';
      val.textContent = yen(valueAt(s, m));
      const name = document.createElement('span');
      name.className = 'ro-name';
      name.textContent = s.label;
      row.append(key, val, name);
      return row;
    });
    readout.replaceChildren(head, ...rows);
  }

  const toMonth = (clientX) => {
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * width;
    return Math.max(0, Math.min(X, Math.round(((px - PAD.left) / iw) * X)));
  };
  // 描き直しても二重にならないよう、プロパティで登録する
  host.onpointerdown = (e) => show(toMonth(e.clientX));
  host.onpointermove = (e) => {
    if (e.pointerType === 'mouse' || e.buttons) show(toMonth(e.clientX));
  };
  host.onkeydown = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const d = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 12 : 1);
    show(Math.max(0, Math.min(X, (current ?? -d) + d)));
  };
}
