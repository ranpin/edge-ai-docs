/* Edge AI Docs — shared dropdown top navigation.
 * Data-driven: categories are fetched from docs.json (single source of truth, shared
 * with the homepage). Base URL is derived from this script's own src, so links work
 * at any page depth. Each page: <nav class="top-nav"></nav> +
 * <script src="nav.js" data-active="path/from/root.html"> */
(function () {
  var sc = document.currentScript || document.querySelector('script[data-active][src*="nav.js"]');
  if (!sc) return;
  var base = sc.src.replace(/nav\.js(\?.*)?$/, '');
  var active = sc.getAttribute('data-active') || '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isExt(f) { return /^https?:/.test(f); }
  function abs(f) { return isExt(f) ? f : base + f; }
  function caret() { return '<svg class="en-caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }

  var CSS = [
    '.en-cats{display:flex;align-self:stretch;align-items:stretch}',
    '.en-cat{position:relative;display:flex;align-items:center;margin:0 1px}',
    '.en-cat::after{content:"";position:absolute;left:0;right:0;top:100%;height:8px}',
    '.en-trigger{display:flex;align-items:center;gap:6px;padding:6px 12px;border:0;background:transparent;border-radius:8px;font:inherit;font-size:13px;font-weight:500;color:var(--text2);cursor:pointer;white-space:nowrap;transition:color .18s,background .18s}',
    '.en-trigger:hover,.en-cat.open .en-trigger{background:var(--accentL);color:var(--accent)}',
    '.en-caret{width:9px;height:6px;flex:none;transition:transform .2s}',
    '.en-cat.open .en-caret{transform:rotate(180deg)}',
    '.en-panel{position:absolute;top:calc(100% + 8px);left:0;min-width:272px;max-height:calc(100vh - var(--nav-h) - 24px);overflow:auto;padding:8px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 32px var(--shadow);opacity:0;visibility:hidden;transform:translateY(6px);transition:opacity .16s,transform .16s,visibility .16s;z-index:1001}',
    '.en-cat.open .en-panel{opacity:1;visibility:visible;transform:translateY(0)}',
    '.en-group{margin-bottom:6px}',
    '.en-group:last-child{margin-bottom:0}',
    '.en-glabel{font-size:10px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:var(--muted);padding:7px 10px 4px;white-space:nowrap}',
    '.en-item{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:7px 10px;border-radius:8px;text-decoration:none;color:var(--text2);font-size:13px;transition:background .15s,color .15s}',
    '.en-item:hover{background:var(--accentL);color:var(--accent)}',
    '.en-item.active{background:var(--accentL);color:var(--accent);font-weight:600}',
    '.en-t{flex:1;white-space:nowrap}',
    '.en-b{flex:none;font-size:10px;font-weight:600;letter-spacing:.3px;color:var(--muted);background:var(--bg3);border:1px solid var(--border);padding:1px 6px;border-radius:5px}',
    '.en-item:hover .en-b,.en-item.active .en-b{color:var(--accent);background:transparent;border-color:transparent}',
    '.en-logo-txt{transition:opacity .2s}',
    '@media(max-width:640px){.en-logo-txt{display:none}.top-nav .logo::before{margin-right:0}.en-trigger{padding:6px 9px}}'
  ].join('\n');

  /* Build the category dropdowns from docs.json's `categories` array.
   * general -> "通识" group; each project -> its own group by project name. */
  function buildCats(cats) {
    var h = '';
    (cats || []).forEach(function (cat) {
      var groups = [];
      if (cat.general && cat.general.length) groups.push({ label: '通识', items: cat.general });
      (cat.projects || []).forEach(function (p) {
        if (p.docs && p.docs.length) groups.push({ label: p.name, items: p.docs });
      });
      if (!groups.length) return;
      h += '<div class="en-cat">';
      h += '<button type="button" class="en-trigger">' + esc(cat.name) + caret() + '</button>';
      h += '<div class="en-panel">';
      groups.forEach(function (g) {
        h += '<div class="en-group"><div class="en-glabel">' + esc(g.label) + '</div>';
        g.items.forEach(function (d) {
          var ext = isExt(d.file);
          var isActive = !ext && d.file === active;
          var cls = 'en-item' + (isActive ? ' active' : '');
          var tgt = ext ? ' target="_blank" rel="noopener"' : '';
          h += '<a class="' + cls + '" href="' + abs(d.file) + '"' + tgt + '>';
          h += '<span class="en-t">' + esc(d.title) + (ext ? ' &#8599;' : '') + '</span>';
          if (d.badge) h += '<span class="en-b">' + esc(d.badge) + '</span>';
          h += '</a>';
        });
        h += '</div>';
      });
      h += '</div></div>';
    });
    return h;
  }

  function injectCss() {
    if (document.getElementById('en-nav-css')) return;
    var st = document.createElement('style');
    st.id = 'en-nav-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function wire(nav) {
    var cats = Array.prototype.slice.call(nav.querySelectorAll('.en-cat'));
    var hoverable = window.matchMedia && window.matchMedia('(hover: hover)').matches;
    function closeAll() { cats.forEach(function (c) { c.classList.remove('open'); }); }
    function openOnly(cat) { cats.forEach(function (c) { if (c !== cat) c.classList.remove('open'); }); cat.classList.add('open'); }
    cats.forEach(function (cat) {
      var trig = cat.querySelector('.en-trigger');
      trig.addEventListener('click', function (e) {
        e.stopPropagation();
        if (cat.classList.contains('open')) cat.classList.remove('open'); else openOnly(cat);
      });
      if (hoverable) {
        cat.addEventListener('mouseenter', function () { openOnly(cat); });
        cat.addEventListener('mouseleave', function () { cat.classList.remove('open'); });
      }
    });
    document.addEventListener('click', closeAll);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });
  }

  var nav = document.querySelector('.top-nav');
  if (!nav) return;
  injectCss();

  // Synchronous shell: logo + empty categories + theme button. The theme button must
  // exist before each page's inline script binds themeBtn, so only .en-cats is filled
  // asynchronously — it is never rebuilt after the fact.
  nav.innerHTML = '<a class="logo" href="' + base + 'index.html"><span class="en-logo-txt">Edge AI Docs</span></a>' +
    '<div class="en-cats"></div>' +
    '<div class="right"><button type="button" class="theme-btn" id="themeBtn">&#9790; / &#9788;</button></div>';

  var mount = nav.querySelector('.en-cats');
  fetch(base + 'docs.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (data) {
      mount.innerHTML = buildCats(data.categories);
      wire(nav);
    })
    .catch(function (e) {
      // file:// preview or offline: nav degrades to logo + theme toggle
      console.warn('[nav.js] docs.json unavailable:', e);
    });
})();
