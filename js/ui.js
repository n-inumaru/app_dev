// 画面の共通部品：下から出る画面（シート）、確認ダイアログ、数字キー、お知らせ（トースト）

import { esc } from './format.js';
import { icon } from './icons.js';

const byId = (id) => document.getElementById(id);

/** ダイアログを一度だけ準備する */
export function setupDialogs() {
  const sheet = byId('sheet');
  // 背景をタップしたら閉じる
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.close();
  });
  // 閉じたら中身を消す（すぐ開き直したときは消さない）
  sheet.addEventListener('close', () => {
    if (!sheet.open) sheet.innerHTML = '';
  });
}

// ---- シート ----

export function openSheet(html) {
  const dlg = byId('sheet');
  dlg.innerHTML = `<div class="sheet-inner">${html}</div>`;
  if (!dlg.open) dlg.showModal();
  return dlg;
}

export function closeSheet() {
  const dlg = byId('sheet');
  if (dlg.open) dlg.close();
}

export function sheetIsOpen() {
  return byId('sheet').open;
}

export function closeAllDialogs() {
  for (const id of ['modal', 'pinpad', 'sheet']) {
    const d = byId(id);
    if (d && d.open) d.close();
  }
}

/** シートの見出し（タイトルと閉じるボタン） */
export const sheetHead = (title) => `
  <div class="sheet-handle" aria-hidden="true"></div>
  <div class="sheet-head">
    <h2>${esc(title)}</h2>
    <button type="button" class="icon-btn" data-action="close-sheet" aria-label="閉じる">${icon('close')}</button>
  </div>`;

// ---- 入力欄 ----

/** 金額の入力欄（右に「円」）。エラーは id + '-err' の欄に出る */
export const yenField = (id, label, value = '', extra = '') => `
  <label class="field">
    <span class="field-label">${label}</span>
    <span class="input-wrap"><input class="input" id="${id}" data-yen inputmode="numeric" autocomplete="off" enterkeyhint="next" value="${esc(value)}" ${extra}><span class="suffix">円</span></span>
    <span class="field-error" id="${id}-err"></span>
  </label>`;

/** 入力欄の下のエラー表示を入れ替える（空文字で消す） */
export function setError(id, text) {
  const input = document.getElementById(id);
  const err = document.getElementById(`${id}-err`);
  if (err) err.textContent = text || '';
  if (input) {
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

// ---- 確認ダイアログ ----

/** @returns {Promise<boolean>} */
export function confirmDialog({ title, message = '', html = '', okLabel = 'OK', cancelLabel = 'キャンセル', danger = false }) {
  return new Promise((resolve) => {
    const dlg = byId('modal');
    dlg.innerHTML = `
      <h2 class="modal-title">${esc(title)}</h2>
      ${message ? `<p class="modal-text">${esc(message)}</p>` : ''}
      ${html}
      <div class="modal-actions">
        ${cancelLabel ? `<button type="button" class="btn" data-answer="no">${esc(cancelLabel)}</button>` : ''}
        <button type="button" class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-answer="yes">${esc(okLabel)}</button>
      </div>`;
    let answered = false;
    const finish = (v) => {
      if (answered) return;
      answered = true;
      dlg.removeEventListener('click', onClick);
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const onClick = (e) => {
      const b = e.target.closest('[data-answer]');
      if (b) finish(b.dataset.answer === 'yes');
      else if (e.target === dlg) finish(false);
    };
    // 前のダイアログの「閉じた」通知が遅れて届いても無視する
    const onClose = () => {
      if (!dlg.open) finish(false);
    };
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

export function alertDialog({ title, message = '', html = '', okLabel = 'OK' }) {
  return confirmDialog({ title, message, html, okLabel, cancelLabel: '' });
}

// ---- 数字キー（パスコード入力） ----

/**
 * @param {{length?:number, onComplete:(pin:string, pad:object)=>Promise<void>|void, leftKey?:{label:string, icon:string, onPress:()=>void}}} opts
 */
export function createPinPad({ length = 4, onComplete, leftKey = null }) {
  const el = document.createElement('div');
  el.className = 'pinpad';
  const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" class="key" data-key="${n}">${n}</button>`).join('');
  el.innerHTML = `
    <div class="pin-dots" aria-hidden="true">${'<span></span>'.repeat(length)}</div>
    <p class="pin-message" role="status" aria-live="polite"></p>
    <div class="keypad">
      ${keys}
      ${leftKey ? `<button type="button" class="key key-ghost" data-key="left" aria-label="${esc(leftKey.label)}">${leftKey.icon}</button>` : '<span></span>'}
      <button type="button" class="key" data-key="0">0</button>
      <button type="button" class="key key-ghost" data-key="back" aria-label="1文字消す">${icon('backspace')}</button>
    </div>`;

  let value = '';
  let busy = false;
  let disabled = false;
  const dots = el.querySelectorAll('.pin-dots span');
  const dotsBox = el.querySelector('.pin-dots');
  const msg = el.querySelector('.pin-message');
  const paint = () => dots.forEach((d, i) => d.classList.toggle('filled', i < value.length));

  async function press(k) {
    if (k === 'left') {
      leftKey?.onPress();
      return;
    }
    if (busy || disabled) return;
    if (k === 'back') {
      value = value.slice(0, -1);
      paint();
      return;
    }
    if (value.length >= length) return;
    value += k;
    paint();
    msg.textContent = '';
    msg.classList.remove('is-error');
    if (value.length === length) {
      busy = true;
      const pin = value;
      try {
        await onComplete(pin, api);
      } finally {
        busy = false;
      }
    }
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-key]');
    if (b) press(b.dataset.key);
  });
  const onKey = (e) => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('back');
  };

  const api = {
    el,
    reset() {
      value = '';
      paint();
    },
    error(text) {
      value = '';
      paint();
      msg.textContent = text;
      msg.classList.add('is-error');
      dotsBox.classList.remove('shake');
      void dotsBox.offsetWidth;
      dotsBox.classList.add('shake');
      navigator.vibrate?.(60);
    },
    message(text) {
      msg.textContent = text;
      msg.classList.remove('is-error');
    },
    setDisabled(flag) {
      disabled = flag;
      el.classList.toggle('is-disabled', flag);
    },
    attachKeyboard() {
      document.addEventListener('keydown', onKey);
    },
    detachKeyboard() {
      document.removeEventListener('keydown', onKey);
    },
  };
  return api;
}

/**
 * パスコードを聞く画面
 * @param {{title:string, subtitle?:string, validate?:(pin:string)=>Promise<string|null>|string|null}} opts
 *   validate が文字を返したらエラーとして表示し、入れ直してもらう
 * @returns {Promise<string|null>} やめたら null
 */
export function askPin({ title, subtitle = '', validate }) {
  return new Promise((resolve) => {
    const dlg = byId('pinpad');
    dlg.innerHTML = `
      <div class="pin-screen">
        <button type="button" class="icon-btn pin-cancel" data-pin-cancel aria-label="やめる">${icon('close')}</button>
        <div class="pin-icon">${icon('lock')}</div>
        <h2 class="pin-title">${esc(title)}</h2>
        <p class="pin-sub">${esc(subtitle)}</p>
        <div class="pin-slot"></div>
      </div>`;
    let done = false;
    const pad = createPinPad({
      onComplete: async (pin) => {
        const err = validate ? await validate(pin) : null;
        if (err) pad.error(err);
        else finish(pin);
      },
    });
    dlg.querySelector('.pin-slot').append(pad.el);
    const finish = (v) => {
      if (done) return;
      done = true;
      pad.detachKeyboard();
      dlg.removeEventListener('close', onClose);
      dlg.removeEventListener('click', onClick);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const onClose = () => {
      if (!dlg.open) finish(null);
    };
    const onClick = (e) => {
      if (e.target.closest('[data-pin-cancel]')) finish(null);
    };
    dlg.addEventListener('close', onClose);
    dlg.addEventListener('click', onClick);
    dlg.showModal();
    pad.attachKeyboard();
  });
}

// ---- お知らせ（トースト） ----

let toastSeq = 0;
export function toast(text, ms = 2800) {
  const el = byId('toast');
  const seq = ++toastSeq;
  el.textContent = text;
  el.classList.remove('show');
  try {
    if (el.matches(':popover-open')) el.hidePopover();
    el.showPopover(); // ダイアログより手前に出す
  } catch {
    /* popover 非対応 */
  }
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    if (seq !== toastSeq) return;
    el.classList.remove('show');
    setTimeout(() => {
      try {
        if (seq === toastSeq && el.matches(':popover-open')) el.hidePopover();
      } catch {
        /* 何もしない */
      }
    }, 250);
  }, ms);
}
