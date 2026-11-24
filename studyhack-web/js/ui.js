// 共享 UI 与工具：DOM 构造、toast、弹窗（含 Esc 与焦点陷阱）、表单校验、时间与周次计算。

// ---------- 极简 hyperscript（数据一律走 textContent，避免注入） ----------
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;              // 仅用于内置静态图标
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && typeof v !== 'object') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  add(el, children);
  return el;
}
function add(el, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
/** 往已有元素里追加多个子节点；条件渲染产生的 null 会被跳过（直接 el.append(null) 会显示成文字 null） */
export function put(el, ...children) { add(el, children); return el; }
export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
/** 页面载入时的标题；专注倒计时会临时改写它，离开页面时要还原 */
export const DEFAULT_TITLE = document.title;
/** 手机端版式的判定（和 css/mobile.css 的 900px 断点一致）：页面用它决定内容先后，视觉差异仍交给样式表 */
export const isNarrow = () => matchMedia('(max-width: 900px)').matches;

// ---------- 内置图标（静态 SVG，装饰性，不参与朗读） ----------
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}${extra}</svg>`;
export const ICON = {
  check: svg('<path d="M4 12.5l5 5L20 6.5"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  bell: svg('<path d="M6 16v-5a6 6 0 0112 0v5l1.5 2.5H4.5z"/><path d="M10 21h4"/>'),
  alert: svg('<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>'),
  spark: svg('<path d="M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8z"/>'),
  calendar: svg('<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M8 3.5V7M16 3.5V7M3.5 11h17"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  trash: svg('<path d="M4.5 7h15M9 7V4.5h6V7M7 7l1 13h8l1-13"/>'),
  edit: svg('<path d="M4.5 19.5h4L19 9a2.1 2.1 0 10-3-3L5.5 16.5z"/>'),
  play: svg('<path d="M8 5.5l10 6.5-10 6.5z"/>'),
  pause: svg('<path d="M9 5.5v13M15 5.5v13"/>'),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  inbox: svg('<path d="M4 13.5V6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v7l-3 3H7z"/><path d="M4 13.5h5l1 2h4l1-2h5"/>'),
  star: svg('<path d="M12 4l2.4 5.2 5.6.6-4.2 3.8 1.2 5.6L12 16.6 7 19.8l1.2-5.6L4 10.4l5.6-.6z"/>'),
  swipe: svg('<path d="M8 9.5 4.5 12 8 14.5"/><path d="M16 9.5 19.5 12 16 14.5"/><path d="M7 12h10"/>'),
  // 目标页：一圈圈往中心收，和今日那颗星区分开
  target: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>'),
  // 底部标签栏要用图形认页面，10 个中文标签在小屏上读不出来
  book: svg('<path d="M4 5.5A2.5 2.5 0 016.5 3H19v15H6.5A2.5 2.5 0 004 20.5z"/><path d="M4 18.5A2.5 2.5 0 016.5 16H19"/>'),
  list: svg('<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>'),
  chart: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  gear: svg('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M4.6 7.5l2.2 1.3M17.2 15.2l2.2 1.3M4.6 16.5l2.2-1.3M17.2 8.8l2.2-1.3"/>'),
  dots: svg('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>'),
  up: svg('<path d="M6 14.5l6-6 6 6"/>'),
  down: svg('<path d="M6 9.5l6 6 6-6"/>'),
  right: svg('<path d="M9.5 6l6 6-6 6"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8L20 20"/>'),
  // 外观三档的顶栏按钮：跟随系统 / 深色 / 浅色
  monitor: svg('<rect x="3" y="4.5" width="18" height="12.5" rx="2"/><path d="M9 20.5h6M12 17v3.5"/>'),
  moon: svg('<path d="M20 13.5A8 8 0 1110.5 4a6.5 6.5 0 009.5 9.5z"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>'),
};
export const icon = (name) => h('span', { class: 'ico', html: ICON[name] || ICON.star, 'aria-hidden': 'true' });

// ---------- toast ----------
let toastSeq = 0;
// 到点和手动关闭走同一条退场：先挂动画类，等它跑完再摘节点，避免提示条硬消失
function fadeOutToast(el) {
  if (!el.isConnected || el.classList.contains('xj-out')) return;
  el.classList.add('xj-out');
  setTimeout(() => el.remove(), 220);
}
export function toast(title, body = '', kind = '') {
  const box = document.getElementById('toasts');
  const id = `t${++toastSeq}`;
  const el = h('div', { class: `toast ${kind}`, dataset: { id } },
    h('b', { text: title }),
    body ? h('div', { text: body }) : null,
  );
  // 窄屏上只更新普通提示，保留需要用户注意的错误和警告。
  const ordinary = kind === '';
  const brief = ordinary && isNarrow();
  if (ordinary) el.dataset.brief = '';
  if (brief) box.querySelectorAll('.toast[data-brief]').forEach((previous) => previous.remove());
  box.append(el);
  setTimeout(() => fadeOutToast(el), brief && !body ? 3200 : 6000);
  return () => fadeOutToast(el);
}

// ---------- 弹窗：Esc 关闭 + 焦点陷阱 + 关闭后焦点归位 ----------
let openSheets = [];
// 弹层打开时把背后的页面真的设为 inert：不然 Tab 与读屏会走进遮罩盖住的内容里。
// #modal-root 与 #toasts 都在 .app 外面，所以禁掉背景不会把弹层自己也一起禁掉。
function syncBackdropInert() {
  const app = document.querySelector('.app');
  if (app) app.inert = openSheets.length > 0;
}
export function openSheet({ title, content, actions = [], wide = false, dismissible = true, labelledBy = 'sheet-title', onClose = null }) {
  const prevFocus = document.activeElement;
  const root = document.getElementById('modal-root');
  const mask = h('div', { class: 'mask' });
  const sheet = h('div', {
    class: `sheet${wide ? ' wide' : ''}`,
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy, tabindex: '-1',
  }, h('h3', { id: labelledBy, text: title }), content);
  if (actions.length) sheet.append(h('div', { class: 'sheet-actions' }, ...actions));
  // 手机端（窄屏且允许关闭）在抽屉顶上放一条能拽的拉手：跟手下拖，松手按距离或速度决定关掉还是弹回。
  // 桌面的居中弹窗不建这条，行为与外观都不变。
  if (dismissible && isNarrow()) {
    const grip = h('span', { class: 'sheet-grip', 'aria-hidden': 'true' });
    sheet.prepend(grip);
    bindSheetDrag(grip, sheet, mask, closeSheet);
  }
  mask.append(sheet);
  root.append(mask);

  let closed = false;
  function closeSheet() {
    if (closed) return;
    closed = true;
    mask.remove();
    openSheets = openSheets.filter((s) => s !== api);
    syncBackdropInert();
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
    if (onClose) onClose();
  }
  const close = () => closeSheet();
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible) { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...sheet.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
      .filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  mask.addEventListener('keydown', onKey);
  if (dismissible) mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  sheet.addEventListener('cancel', (e) => e.preventDefault());
  const api = { close, mask, sheet };
  openSheets.push(api);
  syncBackdropInert();
  const focusables = sheet.querySelectorAll('input, select, textarea, button');
  (sheet.querySelector('[data-autofocus]') || focusables[0] || sheet).focus({ preventScroll: true });
  return api;
}
export function closeTopSheet() {
  const top = openSheets[openSheets.length - 1];
  if (top) top.close();
}

// 抽屉跟手下滑关闭。只在拉手上接触摸（touch 事件在整段手势里都回到 touchstart 的那个元素，
// 所以绑在 grip 上就能跟完整程），抽屉正文里的滚动、输入完全不受影响。
// 关闭走一条自己的路：先播 170ms 退场再摘节点。点按钮那条 close() 仍然立刻摘——
// 脚本与 flows 断言按「点完就没了」检查，不能把即时关闭改成延迟的。
function bindSheetDrag(grip, sheet, mask, closeNow) {
  let id = null, y0 = 0, dy = 0, t0 = 0;
  const clear = () => { id = null; dy = 0; sheet.classList.remove('dragging'); sheet.style.transform = ''; };
  grip.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || id !== null) return;   // 捏合（多指）不参与这个手势
    id = e.touches[0].identifier;
    y0 = e.touches[0].clientY; dy = 0; t0 = Date.now();
    sheet.classList.add('dragging');
  }, { passive: true });
  grip.addEventListener('touchmove', (e) => {
    if (id === null) return;
    const p = [...e.touches].find((t) => t.identifier === id);
    if (!p) return;
    dy = Math.max(0, p.clientY - y0);                   // 只认往下拽，往上留给正文自己的滚动
    if (dy > 4 && e.cancelable) e.preventDefault();
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: false });
  const end = () => {
    if (id === null) return;
    const moved = dy;                                   // clear() 会把 dy 归零，判定得先拿到拽下来的距离
    const speed = moved / Math.max(1, Date.now() - t0);  // px/ms
    clear();
    if (moved < 88 && !(moved > 28 && speed > 0.5)) return;   // 拽得不够远也不够快：已经弹回原位
    sheet.classList.add('xj-flick-down');
    mask.classList.add('xj-mask-out');
    setTimeout(closeNow, 180);
  };
  grip.addEventListener('touchend', end);
  grip.addEventListener('touchcancel', clear);
}

export function confirmSheet({ title, message, confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const done = (v) => { finish(v); api.close(); };
    const api = openSheet({
      title,
      onClose: () => finish(false),
      content: h('p', { text: message, style: 'margin:0;color:var(--ink-soft);white-space:pre-line' }),
      dismissible: true,
      actions: [
        h('button', { class: 'btn', onclick: () => done(false), text: cancelText }),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => done(true), text: confirmText }),
      ],
    });
  });
}

// ---------- 表单 ----------
export function field(label, input, { hint = '', error = null, id = null } = {}) {
  if (id && input) input.id = id;
  const wrap = h('div', { class: 'field' },
    id ? h('label', { for: id, text: label }) : h('label', { text: label }),
    input,
    hint ? h('p', { class: 'hint', text: hint }) : null,
    h('p', { class: 'field-err', hidden: true }),
  );
  const errEl = wrap.lastChild;
  input?.addEventListener('input', () => { errEl.hidden = true; input.setAttribute('aria-invalid', 'false'); });
  return {
    el: wrap,
    error(msg) {
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
      input?.setAttribute('aria-invalid', msg ? 'true' : 'false');
      if (msg) input?.focus();
    },
  };
}

export function selectEl(options, value, attrs = {}) {
  const el = h('select', attrs, ...options.map((o) => h('option', { value: o.value, text: o.label, selected: o.value === value })));
  el.value = value;
  return el;
}

// ---------- 下载 ----------
export function download(filename, text, mime = 'application/json;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h('a', { href: url, download: filename, rel: 'noopener' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- 时间 / 周次 ----------
export const pad2 = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const toMin = (hhmm) => { const [a, b] = String(hhmm || '0:0').split(':').map(Number); return a * 60 + (b || 0); };
export const toHM = (m) => `${pad2(Math.floor(m / 60) % 24)}:${pad2(Math.round(m) % 60)}`;
export const DOW = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const WEEK_MAX = 25;

export function mondayOf(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
export function dowIndex(d = new Date()) { return ((d.getDay() + 6) % 7) + 1; }

/** 该日期属于学期第几周；未设学期起始日返回 null */
export function weekNumberOf(dateStr, termStart) {
  if (!termStart || !dateStr) return null;
  const a = mondayOf(new Date(`${dateStr}T12:00:00`)).getTime();
  const b = mondayOf(new Date(`${termStart}T12:00:00`)).getTime();
  if (isNaN(a) || isNaN(b)) return null;
  const n = Math.round((a - b) / (7 * 864e5)) + 1;
  return n >= 1 && n <= WEEK_MAX ? n : null;
}

export function inWeekRange(course, week) {
  const s = Number(course.weekStart) || 1;
  const e = Number(course.weekEnd) || WEEK_MAX;
  if (week !== null && (week < s || week > e)) return false;
  const parity = course.parity || 'all';
  if (week !== null && parity !== 'all') {
    // 单双周以起始周为基准：与起始周同奇偶 = 单周
    const sameParity = (week - s) % 2 === 0;
    if (parity === 'odd' && !sameParity) return false;
    if (parity === 'even' && sameParity) return false;
  }
  return true;
}

export function fmtDateTime(msOrStr) {
  const d = typeof msOrStr === 'number' ? new Date(msOrStr) : new Date(String(msOrStr).replace('T', ' ').replace(/-/g, '/'));
  if (isNaN(d)) return String(msOrStr || '');
  return `${ymd(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function fmtDayTime(msOrStr) {
  const d = typeof msOrStr === 'number' ? new Date(msOrStr) : new Date(String(msOrStr).replace('T', ' ').replace(/-/g, '/'));
  if (isNaN(d)) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function relTime(ts) {
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '前' : '后';
  if (abs < 60e3) return '刚刚';
  if (abs < 3600e3) return `${Math.round(abs / 60e3)} 分钟${suffix}`;
  if (abs < 86400e3) return `${Math.round(abs / 3600e3)} 小时${suffix}`;
  return `${Math.round(abs / 86400e3)} 天${suffix}`;
}

/** 把 "2026-11-04T20:00" 解析成本地时间毫秒。
 *  严格档：年月日时分都要在真实范围内，并且要能被 Date 原样读回来——
 *  不这么拦的话 "2026-13-45T99:99" 会被 JS 自动进位成另一个合法日期，
 *  用户以为写的是 12 月 45 日，库里躺着的却是明年 3 月某天，事后没人看得出来。 */
export function parseLocal(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, ys, mos, ds, hs = '0', mis = '0'] = m;
  const mo = Number(mos); const d0 = Number(ds); const h = Number(hs); const mi = Number(mis);
  if (mo < 1 || mo > 12 || d0 < 1 || d0 > 31 || h > 23 || mi > 59) return null;
  const d = new Date(Number(ys), mo - 1, d0, h, mi);
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() !== Number(ys) || d.getMonth() !== mo - 1 || d.getDate() !== d0 || d.getHours() !== h || d.getMinutes() !== mi) return null;
  return d.getTime();
}

// 课程配色：紫蓝色系，按课程名稳定分配
// 课程色：同色相、两端都压深，让白字在整段渐变上都不低于 4.5:1（浅色主题用同一批）。
const PALETTE = [
  ['#5d4bc0', '#4636a0'], ['#3f63c8', '#2f4fa8'], ['#8a4fcb', '#6c34a4'],
  ['#3f7fc4', '#2f5f9e'], ['#a458c4', '#7e3a9c'], ['#5b58cf', '#463f9e'],
  ['#3b7fae', '#2c628a'], ['#8a48c4', '#6b2fa0'],
];
export function courseColor(name) {
  let hash = 0;
  for (const ch of String(name || '?')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export const PRIO_LABEL = { high: '优先', medium: '普通', low: '随缘' };
export const STATUS_LABEL = { pending: '待做', done: '已完成' };
export const PLAN_STATUS_LABEL = { scheduled: '计划中', done: '已完成', skipped: '已跳过' };
export const planSourceLabel = (p) => (p.source === 'rule' ? '规则排程' : p.source === 'ai' ? 'AI 提案（你确认后写入）' : '手动添加');
