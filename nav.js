/* Edge AI Docs — shared dropdown top navigation.
 * Renders a category-based nav (3 domains x general/projects) into <nav class="top-nav">.
 * Base URL is derived from this script's own src, so links work at any page depth. */
(function () {
  var sc = document.currentScript || document.querySelector('script[data-active][src*="nav.js"]');
  if (!sc) return;
  var base = sc.src.replace(/nav\.js(\?.*)?$/, '');
  var active = sc.getAttribute('data-active') || '';

  var NAV = [
    { name: '智能座舱', groups: [
      { label: '通识', items: [
        { t: '智能座舱面试指南', b: '51 题', f: 'cockpit/general/interview.html' },
        { t: '硬件与系统底层', b: 'Part A', f: 'cockpit/general/hardware.html' },
        { t: '模型训练与微调', b: 'Part B', f: 'cockpit/general/training.html' },
        { t: '推理优化', b: 'Part C', f: 'cockpit/general/infer.html' },
        { t: 'Android 开发 & JNI 基础', b: '基础', f: 'cockpit/general/android-jni.html' }
      ]},
      { label: '项目 · Agent框架', items: [
        { t: '项目总览', b: '总览', f: 'cockpit-agent.html' },
        { t: '设备部署', b: 'Part D', f: 'cockpit/projects/agent-framework/deploy.html' },
        { t: 'aadkcore 核心框架', b: 'Part E1', f: 'cockpit/projects/agent-framework/agent-core.html' },
        { t: '场景 Agent 应用', b: 'Part E2', f: 'cockpit/projects/agent-framework/agent-group.html' },
        { t: '调试与工具链', b: 'Part F', f: 'cockpit/projects/agent-framework/debug.html' },
        { t: 'APK 集成与端侧服务化', b: 'Part G', f: 'cockpit/projects/agent-framework/apk-integration.html' }
      ]}
    ]},
    { name: '通用机器人', groups: [
      { label: '通识', items: [
        { t: '通用机器人面试指南', b: '32 题', f: 'robot/general/interview.html' },
        { t: 'Datawhale 具身智能教程', b: '开源教程', f: 'https://github.com/datawhalechina/every-embodied', ext: true }
      ]},
      { label: '项目 · 端侧落地', items: [
        { t: '通用机器人学习文档', b: '15 章', f: 'robot/projects/edge-deploy/learning.html' }
      ]}
    ]},
    { name: '自动驾驶', groups: [
      { label: '通识', items: [
        { t: '自动驾驶面试指南', b: '34 题', f: 'ad/general/interview.html' }
      ]},
      { label: '项目 · Alpamayo-Edge', items: [
        { t: 'Cosmos-Reason2-8B · Orin 量化部署', b: '实战', f: 'https://ranpin.github.io/qwen-trajectory-prediction/', ext: true }
      ]},
      { label: '项目 · 端到端与 BEV 感知', items: [
        { t: '自动驾驶学习文档', b: '15 章', f: 'ad/projects/bev/learning.html' }
      ]}
    ]}
  ];

  var CSS = [
    '.en-cat{position:relative;display:flex;align-items:center;align-self:stretch;margin:0 1px}',
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

  function abs(f) { return /^https?:/.test(f) ? f : base + f; }
  function caret() { return '<svg class="en-caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }

  function build() {
    var h = '<a class="logo" href="' + base + 'index.html"><span class="en-logo-txt">Edge AI Docs</span></a>';
    NAV.forEach(function (cat) {
      h += '<div class="en-cat">';
      h += '<button type="button" class="en-trigger">' + cat.name + caret() + '</button>';
      h += '<div class="en-panel">';
      cat.groups.forEach(function (g) {
        h += '<div class="en-group"><div class="en-glabel">' + g.label + '</div>';
        g.items.forEach(function (it) {
          var isActive = !it.ext && it.f === active;
          var cls = 'en-item' + (isActive ? ' active' : '');
          var tgt = it.ext ? ' target="_blank" rel="noopener"' : '';
          h += '<a class="' + cls + '" href="' + abs(it.f) + '"' + tgt + '>';
          h += '<span class="en-t">' + it.t + (it.ext ? ' &#8599;' : '') + '</span>';
          if (it.b) h += '<span class="en-b">' + it.b + '</span>';
          h += '</a>';
        });
        h += '</div>';
      });
      h += '</div></div>';
    });
    h += '<div class="right"><button type="button" class="theme-btn" id="themeBtn">&#9790; / &#9788;</button></div>';
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
  nav.innerHTML = build();
  injectCss();
  wire(nav);
})();
