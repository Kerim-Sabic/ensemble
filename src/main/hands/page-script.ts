// Scripts that run inside a web page on an agent's behalf. They are plain
// old-style JavaScript kept as text, because they execute in the page, not here.

/**
 * Describes the part of the page around the viewport as an outline: headings,
 * text, and a numbered line for everything that can be clicked or typed into.
 * The numbered elements are remembered on the window so later actions can find
 * them again.
 */
export const SNAPSHOT_JS = String.raw`(function () {
  var MAX_CHARS = 9000, MAX_REFS = 170, MAX_NODES = 25000;
  var vw = window.innerWidth, vh = window.innerHeight;
  var refs = [], out = [], chars = 0, visited = 0, cut = false, moreAbove = false, moreBelow = false;
  var pending = '', pendingEl = null, lead = '';
  var ox = 0, oy = 0;
  var NATIVE = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, SUMMARY: 1 };
  var ROLES = { button: 1, link: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, checkbox: 1, radio: 1, 'switch': 1, option: 1, combobox: 1, textbox: 1, searchbox: 1, slider: 1, spinbutton: 1, treeitem: 1 };
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1 };
  var INNER = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[onclick]';

  function clean(s, max) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function styleOf(el) { try { return el.ownerDocument.defaultView.getComputedStyle(el); } catch (e) { return null; } }
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { left: r.left + ox, top: r.top + oy, right: r.right + ox, bottom: r.bottom + oy, width: r.width, height: r.height };
  }
  function inWindow(el) {
    var r = rectOf(el);
    if (r.width === 0 && r.height === 0) return false;
    if (r.bottom < -0.3 * vh) { moreAbove = true; return false; }
    if (r.top > 2.0 * vh) { moreBelow = true; return false; }
    return true;
  }
  function push(line) {
    if (cut) return;
    line = lead + line; lead = '';
    if (chars + line.length > MAX_CHARS) { cut = true; return; }
    out.push(line); chars += line.length + 1;
  }
  function flush() {
    var t = clean(pending, 420), el = pendingEl;
    pending = ''; pendingEl = null;
    if (!t || !el || t === '|') return;
    if (!inWindow(el)) return;
    push(t.replace(/(\s*\|\s*)+$/, ''));
  }
  function isInteractive(el, st) {
    var tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href');
    if (tag === 'INPUT') return el.type !== 'hidden';
    if (NATIVE[tag]) return true;
    var role = el.getAttribute('role');
    if (role && ROLES[role]) return true;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return true;
    if (el.hasAttribute('onclick')) return true;
    var ti = el.getAttribute('tabindex');
    if (ti !== null && ti !== '-1' && tag !== 'BODY' && tag !== 'HTML') return true;
    if (st && st.cursor === 'pointer') {
      var ps = el.parentElement ? styleOf(el.parentElement) : null;
      if (!ps || ps.cursor !== 'pointer') return true;
    }
    return false;
  }
  // The words a person sees in an element. A badge beside a label ("Annual" + "save 20%")
  // has no space between them in the markup, so the pieces are joined with one.
  function wordsOf(el) {
    var seen = String(el.innerText || el.textContent || '');
    if (!el.firstElementChild) return seen;
    var parts = [], w = el.ownerDocument.createTreeWalker(el, 4), n, count = 0;
    while ((n = w.nextNode()) && count++ < 60) { var t = n.nodeValue; if (t && /\S/.test(t)) parts.push(t.trim()); }
    var joined = parts.join(' ');
    return joined.replace(/\s+/g, '') === seen.replace(/\s+/g, '') ? joined : seen;
  }
  function nameOf(el) {
    var v = el.getAttribute('aria-label');
    if (v && v.trim()) return clean(v, 90);
    var lb = el.getAttribute('aria-labelledby');
    if (lb) {
      var t = lb.split(/\s+/).map(function (id) { var n = el.ownerDocument.getElementById(id); return n ? (n.innerText || n.textContent) : ''; }).join(' ');
      if (t.trim()) return clean(t, 90);
    }
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (tag === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) && el.value) return clean(el.value, 90);
      if (el.labels && el.labels.length) { var l = clean(el.labels[0].innerText, 90); if (l) return l; }
      if (el.placeholder) return clean(el.placeholder, 90);
      if (el.title) return clean(el.title, 90);
      if (el.name) return clean(el.name, 60);
      return '';
    }
    var text = clean(wordsOf(el), 90);
    if (text) return text;
    var img = el.querySelector ? el.querySelector('img[alt]') : null;
    if (img && img.alt) return clean(img.alt, 90);
    if (el.title) return clean(el.title, 90);
    var st = el.querySelector ? el.querySelector('svg title') : null;
    if (st && st.textContent) return clean(st.textContent, 90);
    if (tag === 'A') { try { var u = new URL(el.href); return clean(u.pathname.split('/').filter(Boolean).pop() || u.host, 60); } catch (e) {} }
    return '';
  }
  function kindOf(el) {
    var tag = el.tagName, role = el.getAttribute('role');
    if (role && ROLES[role]) return role === 'searchbox' ? 'textbox' : role === 'combobox' && tag === 'SELECT' ? 'dropdown' : role;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'dropdown';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      var t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'range') return 'slider';
      if (t === 'file') return 'file picker';
      if (t === 'password') return 'password box';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  }
  function stateOf(el) {
    var tag = el.tagName, parts = [];
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      var t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') parts.push(el.checked ? 'checked' : 'not checked');
      else if (t === 'password') parts.push(el.value ? 'filled in' : 'empty');
      else if (!/^(submit|button|reset|image|file)$/.test(t)) parts.push(el.value ? 'contains ' + JSON.stringify(clean(el.value, 60)) : 'empty');
    } else if (tag === 'SELECT') {
      var sel = el.selectedOptions && el.selectedOptions[0];
      parts.push('set to ' + JSON.stringify(sel ? clean(sel.text, 50) : ''));
      var opts = [];
      for (var i = 0; i < el.options.length && i < 14; i++) opts.push(clean(el.options[i].text, 40));
      parts.push('options: ' + opts.join(' / ') + (el.options.length > 14 ? ' / …' : ''));
    } else if (el.isContentEditable) {
      var txt = clean(el.innerText, 60);
      parts.push(txt ? 'contains ' + JSON.stringify(txt) : 'empty');
    }
    var checked = el.getAttribute('aria-checked');
    if (checked === 'true') parts.push('checked'); else if (checked === 'false') parts.push('not checked');
    if (el.getAttribute('aria-expanded') === 'true') parts.push('open');
    if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')) parts.push('selected');
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    return parts.length ? ' (' + parts.join(', ') + ')' : '';
  }
  function walk(node) {
    if (cut || visited > MAX_NODES) return;
    if (node.nodeType === 3) {
      var t = node.nodeValue;
      if (t && /\S/.test(t)) { pending += t; if (!pendingEl) pendingEl = node.parentElement; }
      return;
    }
    if (node.nodeType !== 1) return;
    visited++;
    var el = node, tag = el.tagName;
    if (SKIP[tag] || String(tag).toLowerCase() === 'svg') return;
    var st = styleOf(el);
    if (!st || st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return;
    if (tag === 'BR') { flush(); return; }
    var cell = st.display === 'table-cell';
    var block = !cell && st.display.indexOf('inline') !== 0 && st.display !== 'contents';
    var inter = isInteractive(el, st);
    if (inter && !NATIVE[tag] && el.querySelector && el.querySelector(INNER)) inter = false;
    if (inter) {
      flush();
      if (inWindow(el)) {
        if (refs.length >= MAX_REFS) { cut = true; return; }
        var label = nameOf(el), kind = kindOf(el);
        refs.push({ el: el, label: label, kind: kind });
        push('[' + refs.length + '] ' + kind + ' ' + JSON.stringify(label) + stateOf(el));
      }
      lead = '';
      return;
    }
    if (tag === 'IMG') {
      if (el.alt && el.alt.trim()) { pending += ' [picture: ' + clean(el.alt, 80) + '] '; if (!pendingEl) pendingEl = el; }
      return;
    }
    if (tag === 'IFRAME' || tag === 'FRAME') {
      flush();
      var doc = null;
      try { doc = el.contentDocument; } catch (e) { doc = null; }
      if (doc && doc.body) {
        var r = el.getBoundingClientRect(), px = ox, py = oy;
        ox += r.left; oy += r.top;
        walk(doc.body); flush();
        ox = px; oy = py;
      } else if (inWindow(el)) {
        push('(an embedded frame' + (el.title ? ' called ' + JSON.stringify(clean(el.title, 60)) : '') + ' whose contents are not listed here; use look and act on it by coordinate)');
      }
      return;
    }
    var heading = /^H[1-6]$/.test(tag) || el.getAttribute('role') === 'heading';
    if (heading) {
      flush();
      var lvl = tag.charAt(0) === 'H' ? Number(tag.charAt(1)) : 2;
      var marks = new Array(lvl + 1).join('#') + ' ';
      if (!(el.querySelector && el.querySelector(INNER))) {
        if (inWindow(el)) { var ht = clean(el.innerText, 160); if (ht) push(marks + ht); }
        return;
      }
      lead = marks;
    } else if (block) {
      flush();
      if (st.display === 'list-item') lead = '- ';
    }
    var kids = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
    if (cell) { if (pending) pending += ' | '; }
    else if (block || heading) { flush(); lead = ''; }
  }

  if (document.body) walk(document.body);
  flush();
  try { Object.defineProperty(window, '__ensembleRefs', { value: refs, configurable: true, enumerable: false, writable: true }); } catch (e) { window.__ensembleRefs = refs; }
  var full = Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
  var said = (window.__ensembleDialogs || []).splice(0);
  return {
    title: document.title || '',
    url: location.href,
    outline: out.join('\n'),
    refs: refs.length,
    scrollY: Math.round(window.scrollY || 0),
    scrollMax: Math.max(0, Math.round(full - vh)),
    viewHeight: vh,
    moreAbove: moreAbove,
    moreBelow: moreBelow || cut,
    notes: said
  };
})()`

/** Installed before any page script runs: pages cannot block the agent with a pop-up box. */
export const DIALOGS_JS = String.raw`(function () {
  if (window.__ensembleDialogs) return;
  var q = [];
  try { Object.defineProperty(window, '__ensembleDialogs', { value: q, enumerable: false }); } catch (e) { return; }
  var say = function (m) { return String(m == null ? '' : m).slice(0, 300); };
  window.alert = function (m) { q.push('The page showed a message: ' + JSON.stringify(say(m))); };
  window.confirm = function (m) {
    var yes = window.__ensembleAccept === true;
    window.__ensembleAccept = false;
    q.push('The page asked to confirm: ' + JSON.stringify(say(m)) + (yes ? ' It was answered OK.' : ' It was answered Cancel. Repeat the action with accept set to true to answer OK.'));
    return yes;
  };
  window.prompt = function (m, d) { q.push('The page asked for input: ' + JSON.stringify(say(m)) + ' It was left as it was.'); return d == null ? null : String(d); };
  window.print = function () { q.push('The page tried to print.'); };
})()`

const HELPERS = String.raw`
  var list = window.__ensembleRefs || [];
  function pick(n) {
    var ref = list[n - 1];
    if (!ref || !ref.el || !ref.el.isConnected) return null;
    return ref;
  }
  function place(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { el.scrollIntoView(); }
    var r = el.getBoundingClientRect(), fx = 0, fy = 0;
    var w = el.ownerDocument.defaultView;
    while (w && w !== window && w.frameElement) { var fr = w.frameElement.getBoundingClientRect(); fx += fr.left; fy += fr.top; w = w.parent; }
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var top = el.ownerDocument.elementFromPoint(cx, cy);
    var hit = !!top && (top === el || el.contains(top) || top.contains(el));
    return {
      x: Math.max(1, Math.min(window.innerWidth - 2, cx + fx)),
      y: Math.max(1, Math.min(window.innerHeight - 2, cy + fy)),
      empty: r.width < 1 || r.height < 1,
      hit: hit
    };
  }
`

/** Scrolls a numbered element into view and says where its middle is. */
export const locateJs = (n: number): string => `(function () {${HELPERS}
  var ref = pick(${n});
  if (!ref) return { error: 'gone' };
  var el = ref.el, p = place(el);
  return {
    x: p.x, y: p.y, empty: p.empty, hit: p.hit, label: ref.label, kind: ref.kind,
    tag: el.tagName, type: String(el.type || '').toLowerCase(),
    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    editable: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
  };
})()`

/** For elements a real click cannot reach (zero-size inputs behind a styled label). */
export const scriptClickJs = (n: number): string => `(function () {${HELPERS}
  var ref = pick(${n});
  if (!ref) return false;
  ref.el.click();
  return true;
})()`

/** Puts the caret in a field, selecting what is there so typing replaces it. */
export const focusJs = (n: number, selectAll: boolean): string => `(function () {${HELPERS}
  var ref = pick(${n});
  if (!ref) return false;
  var el = ref.el;
  el.focus();
  if (${selectAll ? 'true' : 'false'}) {
    if (typeof el.select === 'function') { try { el.select(); } catch (e) {} }
    else if (el.isContentEditable) {
      var range = el.ownerDocument.createRange(); range.selectNodeContents(el);
      var s = el.ownerDocument.defaultView.getSelection(); s.removeAllRanges(); s.addRange(range);
    }
  } else if (typeof el.setSelectionRange === 'function') {
    try { var end = String(el.value || '').length; el.setSelectionRange(end, end); } catch (e) {}
  }
  return true;
})()`

/** What is focused right now, so typing without a target can be sanity-checked. */
export const FOCUSED_JS = String.raw`(function () {
  var el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body) return { editable: false, password: false };
  return {
    editable: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true,
    password: el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password'
  };
})()`

/** Chooses an option of a real dropdown by its visible text. */
export const selectJs = (n: number, option: string): string => `(function () {${HELPERS}
  var ref = pick(${n});
  if (!ref) return { error: 'gone' };
  var el = ref.el;
  if (el.tagName !== 'SELECT') return { error: 'notselect' };
  var want = ${JSON.stringify(option)}.trim().toLowerCase(), found = null;
  for (var i = 0; i < el.options.length; i++) { var o = el.options[i]; if (o.text.trim().toLowerCase() === want || String(o.value).toLowerCase() === want) { found = o; break; } }
  if (!found) for (var j = 0; j < el.options.length; j++) { if (el.options[j].text.toLowerCase().indexOf(want) >= 0) { found = el.options[j]; break; } }
  if (!found) { var names = []; for (var k = 0; k < el.options.length && k < 30; k++) names.push(el.options[k].text.trim()); return { error: 'nooption', options: names }; }
  var p = place(el);
  el.value = found.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { x: p.x, y: p.y, label: ref.label, chosen: found.text.trim() };
})()`

/** Scrolls to the next place some text appears. */
export const findJs = (text: string): string => `(function () {
  var want = ${JSON.stringify(text)}.trim().toLowerCase();
  if (!want) return false;
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var first = null, next = null, n;
  while ((n = walker.nextNode())) {
    if (!n.nodeValue || n.nodeValue.toLowerCase().indexOf(want) < 0) continue;
    var el = n.parentElement;
    if (!el) continue;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (!first) first = el;
    if (r.top > window.innerHeight * 0.6) { next = el; break; }
  }
  var target = next || first;
  if (!target) return false;
  try { target.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { target.scrollIntoView(); }
  return true;
})()`

export const TEXT_JS = String.raw`(function () {
  var t = document.body ? document.body.innerText : '';
  return String(t || '').replace(/\n{3,}/g, '\n\n');
})()`

export const ACCEPT_JS = 'window.__ensembleAccept = true'
