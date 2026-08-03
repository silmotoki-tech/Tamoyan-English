/* =====================================================================
   07-ui-kit.js — 画面を組み立てるための最小限の道具
   DOM を組み立てる h()、トースト、ダイアログ、ファイル入出力だけ。
   ここに画面固有のロジックは入れない。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var TOAST_MS = 2200;

  function append(el, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) { children.forEach(function (c) { append(el, c); }); return; }
    if (children instanceof Node) { el.appendChild(children); return; }
    el.appendChild(document.createTextNode(String(children)));
  }

  // h('div', {class:'x', onClick:fn}, ['中身'])
  function h(tag, props, children) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.keys(v).forEach(function (s) { el.style[s] = v[s]; });
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') el[k] = !!v;
      else el.setAttribute(k, v);
    });
    append(el, children);
    return el;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function mount(node, children) { clear(node); append(node, children); return node; }

  function toast(msg) {
    var root = document.getElementById('toast-root');
    if (!root) return;
    var el = h('div', { class: 'toast', text: msg });
    root.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, TOAST_MS);
  }

  /* ---- ダイアログ -----------------------------------------------------
     buttons: [{label, value, kind:'primary'|'danger'|undefined}]
     戻り値は選ばれた value（背景クリックや Esc は null）
  --------------------------------------------------------------------- */
  function dialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var root = document.getElementById('modal-root');
      var back = h('div', { class: 'modal-back' });
      var done = false;

      function close(v) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey);
        if (back.parentNode) back.parentNode.removeChild(back);
        resolve(v);
      }
      function onKey(e) { if (e.key === 'Escape') close(null); }

      var buttons = (opts.buttons || [{ label: 'OK', value: true, kind: 'primary' }]).map(function (b) {
        return h('button', {
          class: 'btn' + (b.kind === 'primary' ? ' btn--primary' : b.kind === 'danger' ? ' btn--danger' : ''),
          text: b.label,
          onClick: function () { close(b.value); }
        });
      });

      var modal = h('div', { class: 'modal' }, [
        opts.title ? h('h2', { class: 'modal__title', text: opts.title }) : null,
        h('div', { class: 'modal__body' }, opts.body || null),
        h('div', { class: 'modal__actions' }, buttons)
      ]);
      modal.addEventListener('click', function (e) { e.stopPropagation(); });
      back.addEventListener('click', function () { if (opts.dismissable !== false) close(null); });
      append(back, modal);
      root.appendChild(back);
      document.addEventListener('keydown', onKey);
      var first = modal.querySelector('input, textarea, select, button');
      if (first) try { first.focus(); } catch (e) {}
    });
  }

  function confirm(title, message, okLabel, kind) {
    return dialog({
      title: title,
      body: h('p', { text: message || '' }),
      buttons: [
        { label: 'やめる', value: false },
        { label: okLabel || 'OK', value: true, kind: kind || 'primary' }
      ]
    }).then(function (v) { return v === true; });
  }

  function alertBox(title, message) {
    var body = Array.isArray(message)
      ? h('ul', {}, message.map(function (m) { return h('li', { text: m }); }))
      : h('p', { text: message || '' });
    return dialog({ title: title, body: body, buttons: [{ label: '閉じる', value: true, kind: 'primary' }] });
  }

  // 3択以上を選ばせる（id重複時の「上書き/別として追加/中止」など）
  function choose(title, message, options) {
    return dialog({
      title: title,
      body: h('p', { text: message || '' }),
      buttons: options
    });
  }

  /* ---- ファイル -------------------------------------------------------- */
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 500);
  }

  function pickFile(accept) {
    return new Promise(function (resolve) {
      var input = h('input', { type: 'file', accept: accept || '.json,application/json', class: 'hidden' });
      document.body.appendChild(input);
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (!f) { cleanup(); resolve(null); return; }
        var fr = new FileReader();
        fr.onload = function () { cleanup(); resolve({ name: f.name, text: String(fr.result || '') }); };
        fr.onerror = function () { cleanup(); resolve(null); };
        fr.readAsText(f, 'utf-8');
      });
      function cleanup() { if (input.parentNode) input.parentNode.removeChild(input); }
      input.click();
    });
  }

  /* ---- 表示用の小道具 --------------------------------------------------- */
  function fmtDate(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtSeconds(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    if (sec < 60) return sec + '秒';
    return Math.floor(sec / 60) + '分' + ('0' + (sec % 60)).slice(-2) + '秒';
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  EST.ui = {
    h: h,
    clear: clear,
    mount: mount,
    append: append,
    toast: toast,
    dialog: dialog,
    confirm: confirm,
    alert: alertBox,
    choose: choose,
    download: download,
    pickFile: pickFile,
    fmtDate: fmtDate,
    fmtSeconds: fmtSeconds,
    fmtBytes: fmtBytes
  };
})(window.EST = window.EST || {});
