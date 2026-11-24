// 入口：数据库初始化、星空背景、页面路由、状态胶囊、示例数据、提醒引擎
import * as db from './store.js';
import { state, refreshData, initWeek, pendingTasks } from './state.js';
import { h, clear, toast, ymd, DEFAULT_TITLE, icon, ICON, openSheet, isNarrow } from './ui.js';
import { startEngine, stopEngine, syncDerived, pendingCount, nextUp, notifyPermission } from './remind.js';
import { isNativeApp, hasNativeReminder, nativeStatus, dataPlace } from './native.js';
import { isAcked, openNotice, openNoticeGate } from './notice.js';
import { apply as applyTheme, onTheme, theme, MODES, getMode, setMode } from './theme.js';
import { changed } from './forms.js';

import * as today from './pages/today.js';
import * as assistants from './pages/assistants.js';
import * as timetable from './pages/timetable.js';
import * as tasks from './pages/tasks.js';
import * as goals from './pages/goals.js';
import * as calendar from './pages/calendar.js';
import * as planner from './pages/planner.js';
import * as focus from './pages/focus.js';
import * as review from './pages/review.js';
import * as reminders from './pages/reminders.js';
import * as settings from './pages/settings.js';

// tab: true 的进手机端底部标签栏，其余收进「更多」——十个小屏标签认不出来，不如四个常用加一个抽屉
const PAGES = {
  today: { label: '今日', mod: today, icon: 'star', tab: true, desc: '今天的课、计划和空闲时间' },
  assistants: { label: 'AI 助手', mod: assistants, icon: 'spark', tab: true, desc: '规划小助排和树洞，两位都在' },
  timetable: { label: '课程表', mod: timetable, icon: 'book', tab: true, desc: '按周看课表，CSV 批量导入' },
  tasks: { label: '任务', mod: tasks, icon: 'inbox', tab: true, desc: '待做的、今天到期的、已完成' },
  calendar: { label: '日历', mod: calendar, icon: 'calendar', desc: '按月看课、计划和任务' },
  goals: { label: '目标', mod: goals, icon: 'target', desc: '把大目标摊到每一天，进度从事实汇总' },
  planner: { label: '计划', mod: planner, icon: 'list', desc: '空闲时段排程，先看预览再落库' },
  focus: { label: '专注', mod: focus, icon: 'clock', desc: '计时、全屏专注与本轮记录' },
  review: { label: '复盘', mod: review, icon: 'chart', desc: '预计用时和实际用时对比' },
  reminders: { label: '提醒', mod: reminders, icon: 'bell', desc: '课前与到期提醒，含系统闹钟状态' },
  settings: { label: '设置', mod: settings, icon: 'gear', desc: '学期起始日、提醒偏好、导出导入' },
};

const view = () => document.getElementById('view');
// 页面在这条线上的前后关系，只用来判断手机端换页该往哪个方向滑（前进从右边来，退回从左边来）
const PAGE_ORDER = Object.keys(PAGES);

// ---------- 导航（桌面侧栏与手机底部标签栏共用这一份 DOM） ----------
// 桌面侧栏分组：子项在父项下方就地展开，同一时刻最多开一组（手风琴）。
// 手机端整组 display:none（样式按断点分工），底栏仍是四个标签 + 更多，DOM 只有这一份。
const NAV_GROUPS = [
  { id: 'plan', label: '规划', icon: 'calendar', pages: ['calendar', 'goals', 'planner'] },
  { id: 'flow', label: '专注复盘', icon: 'clock', pages: ['focus', 'review'] },
  { id: 'sys', label: '提醒设置', icon: 'bell', pages: ['reminders', 'settings'] },
];
const groupedPage = (name) => NAV_GROUPS.find((g) => g.pages.includes(name)) || null;

// 徽标只绑两处真实状态：任务=待做条数，提醒=待响条数。别的页面没有「未读」这个事实，不装徽标。
const BADGES = {
  tasks: { count: () => pendingTasks().length, unit: '条待做任务' },
  reminders: { count: () => pendingCount(), unit: '条待响提醒' },
};
function badgeEl(page) {
  if (!BADGES[page]) return null;
  return h('span', { class: 'nav-badge', dataset: { for: page }, 'aria-hidden': 'true', hidden: true },
    h('span', { class: 'nb-n', text: '0' }));
}

function navButton(name, sub = false, index = 0) {
  const p = PAGES[name];
  return h('button', {
    type: 'button', class: `nav-item${sub ? ' nav-sub' : ''}`, dataset: { page: name },
    ...(sub ? { style: `--i:${index}` } : {}),
  }, h('span', { class: 'nav-ico' }, icon(p.icon), badgeEl(name)), h('span', { class: 'nav-label', text: p.label }));
}

function buildNav() {
  const nav = document.getElementById('nav');
  if (!nav || nav.childElementCount) return;
  for (const [name, p] of Object.entries(PAGES)) {
    if (p.tab) nav.append(navButton(name));
  }
  for (const g of NAV_GROUPS) {
    const head = h('button', { type: 'button', class: 'nav-group-head', 'aria-expanded': 'false' },
      h('span', { class: 'nav-ico' }, icon(g.icon)),
      h('span', { class: 'nav-label', text: g.label }),
      h('span', { class: 'nav-caret', 'aria-hidden': 'true' }, icon('down')));
    head.addEventListener('click', () => toggleGroup(g.id));
    nav.append(h('div', { class: 'nav-group', dataset: { group: g.id } },
      head,
      h('div', { class: 'nav-group-body', inert: true },
        h('div', { class: 'nav-group-inner' }, ...g.pages.map((name, i) => navButton(name, true, i))))));
  }
  nav.append(h('button', { type: 'button', class: 'nav-item nav-more', id: 'nav-more' },
    h('span', { class: 'nav-ico' }, icon('gear')), h('span', { class: 'nav-label', text: '我的' })));
  // 手机端底栏那块跟着走的滑块（宽屏由 styles.css 兜底隐藏，建出来也不显示）
  nav.append(h('span', { class: 'tab-ind', id: 'tab-ind', 'aria-hidden': 'true' }));
  nav.append(h('span', { class: 'side-ind', id: 'side-ind', 'aria-hidden': 'true' }));
}

// ---------- 侧栏分组：就地展开 + 手风琴 ----------
// 高度动画走 grid-template-rows 0fr→1fr：容器高度和后续栏目位置一起变化，不用 JS 量高度。
// 子项错峰由 --i（DOM 序号）× 40ms 延迟完成，只在展开那一方演。
function setGroupOpen(id, open, { animate = true } = {}) {
  const wrap = document.querySelector(`.nav-group[data-group="${id}"]`);
  if (!wrap || wrap.classList.contains('open') === open) return false;
  if (!animate) wrap.classList.add('no-anim');
  wrap.classList.toggle('open', open);
  wrap.querySelector('.nav-group-head').setAttribute('aria-expanded', String(open));
  // 收着的组只是 overflow 裁剪，子项还在文档里：不 inert 的话键盘能 Tab 进看不见的按钮
  wrap.querySelector('.nav-group-body').inert = !open;
  if (!animate) { void wrap.offsetHeight; wrap.classList.remove('no-anim'); }
  return animate;
}
// 同一时刻最多开一组；id 为 null 表示全收（当前页不在任何组里时）。返回是否有动画在跑。
function accordionTo(id, { animate = true } = {}) {
  let animating = false;
  for (const g of NAV_GROUPS) animating = setGroupOpen(g.id, g.id === id, { animate }) || animating;
  return animating;
}
function toggleGroup(id) {
  const wrap = document.querySelector(`.nav-group[data-group="${id}"]`);
  const open = wrap && !wrap.classList.contains('open');
  if (accordionTo(open ? id : null)) deferIndToSettle();
  else moveSideInd(state.page, { animate: false });
}
// 组高度在动画途中时，选中项的位置是中间态：高亮块先藏起来，等错峰进场全部落定再落位。
// 260ms 组动画 + 最多 80ms 子项错峰 = 340ms，380ms 兜底（减弱动效下 transitionend 不一定来）。
let groupSettleTimer = 0;
function deferIndToSettle() {
  const ind = document.getElementById('side-ind');
  if (ind) ind.style.opacity = '0';
  clearTimeout(groupSettleTimer);
  groupSettleTimer = setTimeout(() => moveSideInd(state.page, { animate: false }), 380);
}

// 桌面侧栏使用独立底片，按钮和文字本身不移动；没有 JS 时保留原有选中态。
let sideIndPlaced = false;
function moveSideInd(name, { animate = true } = {}) {
  const nav = document.getElementById('nav');
  const ind = document.getElementById('side-ind');
  const btn = nav?.querySelector(`.nav-item[data-page="${name}"]`);
  if (!nav || !ind || !btn || !matchMedia('(min-width: 901px)').matches) {
    if (ind) ind.style.opacity = '0';
    return;
  }
  const n = nav.getBoundingClientRect();
  const b = btn.getBoundingClientRect();
  // 0fr 收起只是 overflow 裁剪，子项矩形仍在：目标在收着的组里时直接藏，不留假高亮
  const grp = btn.closest('.nav-group');
  if ((grp && !grp.classList.contains('open')) || !b.width || !b.height) { ind.style.opacity = '0'; return; }
  if (!animate || !sideIndPlaced) ind.style.transition = 'none';
  ind.style.transform = `translate(${b.left - n.left}px, ${b.top - n.top}px)`;
  ind.style.width = `${b.width}px`;
  ind.style.height = `${b.height}px`;
  ind.style.opacity = '1';
  nav.classList.add('side-ind-ready');
  sideIndPlaced = true;
  // 先强制提交「无过渡+新位置」这一帧再恢复过渡，否则恢复发生在同帧样式重算前，位置还是会被过渡带走
  if (!animate || ind.style.transition === 'none') { void ind.offsetWidth; requestAnimationFrame(() => { ind.style.transition = ''; }); }
}

// 滑块位置：相对 #nav 边框盒的偏移，让光片中心对上图标托中心。
// 第一次落位和窗口尺寸变化时不滑（否则开屏会从左上角飞过来），只有换页才滑。
let indPlaced = false;
function moveTabInd(name, { animate = true } = {}) {
  const nav = document.getElementById('nav');
  const ind = document.getElementById('tab-ind');
  if (!nav || !ind) return;
  const isTab = !!PAGES[name] && PAGES[name].tab;
  // 二级页（日历/目标/…）是从首页宫格进去的，不属于底栏任何一格；只有「我的」里的设置页算在「我的」名下
  const btn = isTab ? nav.querySelector(`.nav-item[data-page="${name}"]`) : (name === 'settings' ? document.getElementById('nav-more') : null);
  const tray = btn && btn.querySelector('.nav-ico');
  if (!tray || !tray.offsetWidth) { ind.style.opacity = '0'; return; }
  // 一路加 offsetLeft/offsetTop 到 #nav：这两个是布局值，不吃 xj-tab-in 的缩放，
  // 而 getBoundingClientRect 量到的是动画进行中的那一流形，滑块会停在偏掉的位置上
  let tx = 0, ty = 0;
  for (let n = tray; n && n !== nav; n = n.offsetParent) { tx += n.offsetLeft; ty += n.offsetTop; }
  if (!animate || !indPlaced) ind.style.transition = 'none';
  // 尺寸跟着目标走（光片 = 图标托 + 6×3 外沿），位置让光片中心对上图标托中心
  ind.style.width = `${tray.offsetWidth + 6}px`;
  ind.style.height = `${tray.offsetHeight + 3}px`;
  ind.style.setProperty('--tx', `${Math.round(tx + tray.offsetWidth / 2 - ind.offsetWidth / 2)}px`);
  ind.style.setProperty('--ty', `${Math.round(ty + tray.offsetHeight / 2 - ind.offsetHeight / 2)}px`);
  ind.style.opacity = '1';
  indPlaced = true;
  if (!animate || ind.style.transition === 'none') {
    requestAnimationFrame(() => { ind.style.transition = ''; });
  }
}

function markNav(name, { groupAnimate = true } = {}) {
  for (const btn of document.querySelectorAll('.nav-item')) {
    if (btn.classList.contains('nav-more')) {
      btn.setAttribute('aria-current', name === 'settings' ? 'page' : 'false');
      continue;
    }
    btn.setAttribute('aria-current', btn.dataset.page === name ? 'page' : 'false');
  }
  for (const btn of document.querySelectorAll('.dock-item')) {
    btn.setAttribute('aria-current', btn.dataset.page === name ? 'page' : 'false');
  }
  // 分组页：把它所在的那组打开（手风琴，其余组收掉）。组高度在动画时滑块等落定再落位。
  const g = groupedPage(name);
  const animating = accordionTo(g ? g.id : null, { animate: groupAnimate });
  const t = document.getElementById('appbar-title');
  const label = PAGES[name] ? PAGES[name].label : '今日';
  if (t && t.textContent !== label) {
    t.textContent = label;
    restartAnim(t, 'xj-swap');
  }
  // 手机端应用栏已经写了页面名，正文里重复的大标题要让位给内容（见 mobile.css）
  const v = view();
  if (v) v.dataset.page = name;
  moveTabInd(name);
  if (animating) deferIndToSettle();
  else moveSideInd(name);
}

// 同一帧里先摘类、读一次布局强制重排、再挂上：连续两次换到同一个页面，动画才会真的重跑第二遍
function restartAnim(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

export function goPage(name) {
  if (!PAGES[name]) return;
  const from = state.page;
  if (name !== from && (name === 'assistants' || isNarrow())) {
    document.querySelectorAll('#toasts .toast[data-brief]').forEach((el) => el.remove());
  }
  state.page = name;
  location.hash = `#${name}`;
  markNav(name);
  // 手机端换页带方向：底栏五个标签是一条有序的路，往右翻从右边进来，往回翻从左边进来（见 mobile.css）
  const dir = PAGE_ORDER.indexOf(name) >= PAGE_ORDER.indexOf(from) ? 'fwd' : 'back';
  renderPage({ motion: true, dir });
}

// 手机「我的」：只放设置类入口与数据边界说明；页面入口在首页宫格，底栏四页仍是直达。
function openMoreSheet() {
  let sheet;
  const row = (label, ic, run) => h('button', {
    type: 'button', class: 'more-item', 'aria-current': label === '设置' && state.page === 'settings' ? 'page' : 'false',
    onclick: () => { sheet.close(); run(); },
  }, h('span', { class: 'more-ico' }, icon(ic)), h('b', { text: label }), h('span', { class: 'more-go' }, icon('right')));
  sheet = openSheet({
    title: '我的',
    content: h('div', { class: 'more-groups' },
      h('section', { class: 'more-group' },
        h('h4', { class: 'more-group-title', text: '应用' }),
        h('div', { class: 'more-list' },
          row('设置', 'gear', () => goPage('settings')),
          row('使用须知', 'book', () => openNotice()),
        )),
      h('p', { class: 'note muted', text: `数据只存在${dataPlace()}里，不上传、不同步；备份与恢复在设置页的「数据」一节。` })),
  });
}

// ---------- 底部悬浮停靠栏（仅宽屏；触屏与手机端不放大，手机整条不出现） ----------
// 可选的第二排入口：默认关，左导航才是默认入口；设置页「外观」里打开后才建。
// 图标按鼠标距离连续放大（距离越近越大，余弦式衰减），放大空间由 dock 顶部内边距预留，
// 布局尺寸不变、邻居不被推开；名称泡在悬停/键盘聚焦时浮出，当前项脚下有一颗常驻点。
export function syncDock() {
  const existing = document.getElementById('dock');
  if (!state.settings.dockEnabled) { if (existing) existing.remove(); return; }
  if (existing) return;
  buildDock();
  markNav(state.page);
}
function buildDock() {
  const app = document.querySelector('.app');
  if (!app || document.getElementById('dock')) return;
  const dock = h('div', { class: 'dock', id: 'dock', role: 'navigation', 'aria-label': '页面停靠栏' });
  for (const [name, p] of Object.entries(PAGES)) {
    dock.append(h('button', {
      type: 'button', class: 'dock-item', dataset: { page: name },
      'aria-current': name === state.page ? 'page' : 'false',
    },
    h('span', { class: 'dock-name', 'aria-hidden': 'true', text: p.label }),
    h('span', { class: 'dock-ico' }, icon(p.icon), badgeEl(name)),
    h('span', { class: 'dock-dot', 'aria-hidden': 'true' })));
  }
  // 建在 .app 里面：弹层打开时 syncBackdropInert 禁的是 .app，dock 不能漏在 inert 外面
  app.append(dock);
  for (const btn of dock.querySelectorAll('.dock-item')) btn.addEventListener('click', () => goPage(btn.dataset.page));
  bindDockMagnify(dock);
}
function bindDockMagnify(dock) {
  const items = [...dock.querySelectorAll('.dock-item')];
  const fine = matchMedia('(hover: hover) and (min-width: 901px)');
  let raf = 0, mx = 0;
  const apply = () => {
    raf = 0;
    for (const it of items) {
      const r = it.getBoundingClientRect();
      const d = Math.abs(mx - (r.left + r.width / 2));
      const t = Math.max(0, 1 - d / 150);
      it.style.setProperty('--mag', (1 + 0.55 * t * t).toFixed(3));
    }
  };
  dock.addEventListener('pointermove', (e) => {
    if (!fine.matches || e.pointerType === 'touch') return;
    mx = e.clientX;
    dock.classList.add('mag-live');   // 跟手期间关掉过渡，每一帧都是当前距离的真实大小
    if (!raf) raf = requestAnimationFrame(apply);
  });
  dock.addEventListener('pointerleave', () => {
    dock.classList.remove('mag-live'); // 离开时才接通过渡，平滑收回 1
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    for (const it of items) it.style.setProperty('--mag', '1');
  });
}

// ---------- 全局命令面板 ----------
// 搜索只过滤、不跳转；Enter/点击才执行。中文输入法候选词期间的 Enter/方向键归输入法，
// 用 composition 标志 + isComposing + 229 三路与「候选刚上屏 100ms 内」一起拦。
let cmdkApi = null;
function paletteItems() {
  const pages = Object.entries(PAGES).map(([name, p]) => ({
    kind: '页面', label: p.label, desc: p.desc, icon: p.icon,
    terms: `${p.label} ${p.desc} ${name}`.toLowerCase(),
    run: () => goPage(name),
  }));
  return [...pages,
    { kind: '操作', label: '加载示例数据', desc: '写入示例课程与任务，试试完整流程', icon: 'spark', terms: '加载示例数据 sample demo', run: () => loadSampleData() },
    { kind: '操作', label: '打开使用须知', desc: '数据边界、AI 会看到什么、提醒做不到什么', icon: 'alert', terms: '打开使用须知 说明 边界 notice', run: () => openNotice() },
    { kind: '操作', label: '切换外观', desc: '跟随系统 / 深色 / 浅色循环', icon: 'gear', terms: '切换外观 主题 深色 浅色 theme', run: cycleTheme },
  ];
}
function cycleTheme() {
  const i = MODES.findIndex((m) => m[0] === getMode());
  const next = MODES[(i + 1) % MODES.length];
  setMode(next[0]);
  toast('外观已切换', next[1]);
}
// 顶栏/应用栏的外观按钮：和命令面板、设置页走同一个 cycleTheme 与同一份偏好，
// 图标跟着「当前档位」走（不是生效档——跟随系统时显示显示器，而不是猜出来的深/浅）。
const THEME_ICON = { system: 'monitor', dark: 'moon', light: 'sun' };
function syncThemeToggles() {
  const mode = getMode();
  const label = (MODES.find((m) => m[0] === mode) || MODES[1])[1];
  for (const el of document.querySelectorAll('.topbar-theme, .appbar-theme')) {
    const ico = el.querySelector('.ico');
    if (ico) ico.innerHTML = ICON[THEME_ICON[mode]] || ICON.moon;
    el.setAttribute('aria-label', `切换外观，当前${label}`);
    el.title = `外观：${label}，点一下换下一档`;
    const txt = el.querySelector('.tt-label');
    if (txt) txt.textContent = label;
  }
}
function buildThemeToggles() {
  const right = document.querySelector('.topbar-right');
  if (right && !document.getElementById('topbar-theme')) {
    const btn = h('button', { type: 'button', class: 'btn btn-ghost topbar-theme', id: 'topbar-theme', onclick: cycleTheme },
      icon('moon'), h('span', { class: 'tt-label', text: '深色' }));
    const cmd = document.getElementById('cmdk-open');
    if (cmd) cmd.after(btn); else right.prepend(btn);
  }
  const cmdPhone = document.getElementById('appbar-cmd');
  if (cmdPhone && !document.getElementById('appbar-theme')) {
    cmdPhone.before(h('button', { type: 'button', class: 'appbar-theme', id: 'appbar-theme', onclick: cycleTheme }, icon('moon')));
  }
  onTheme(syncThemeToggles);
  syncThemeToggles();
}
function openCommandPalette() {
  if (cmdkApi) { cmdkApi.close(); return; }
  const items = paletteItems();
  const input = h('input', {
    type: 'text', class: 'cmdk-input', placeholder: '搜索页面或操作…', autocomplete: 'off', spellcheck: false,
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'cmdk-list', 'aria-activedescendant': '',
    'aria-label': '搜索页面或操作', dataset: { autofocus: true },
  });
  const list = h('div', { class: 'cmdk-list', id: 'cmdk-list', role: 'listbox', 'aria-label': '搜索结果' });
  let active = 0, filtered = items, composing = false, composeEndedAt = 0;

  function syncActive(scroll = false) {
    for (const el of list.querySelectorAll('.cmdk-item')) {
      const on = el.id === `cmdk-it-${active}`;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
    }
    const el = list.querySelector(`#cmdk-it-${active}`);
    input.setAttribute('aria-activedescendant', el ? el.id : '');
    if (scroll && el) el.scrollIntoView({ block: 'nearest' });
  }
  function renderList() {
    const q = input.value.trim().toLowerCase();
    filtered = q ? items.filter((it) => it.terms.includes(q)) : items;
    active = Math.min(active, Math.max(0, filtered.length - 1));
    clear(list);
    if (!filtered.length) {
      list.append(h('div', { class: 'cmdk-empty', text: '没有匹配的页面或操作，换个词试试。' }));
      input.setAttribute('aria-activedescendant', '');
      return;
    }
    let lastKind = '';
    filtered.forEach((it, i) => {
      if (!q && it.kind !== lastKind) { list.append(h('div', { class: 'cmdk-kind', text: it.kind })); lastKind = it.kind; }
      list.append(h('div', {
        class: 'cmdk-item', id: `cmdk-it-${i}`, role: 'option', 'aria-selected': String(i === active),
        onclick: () => runItem(it),
        onpointermove: () => { if (active !== i) { active = i; syncActive(); } },
      },
      h('span', { class: 'cmdk-ico' }, icon(it.icon)),
      h('span', { class: 'cmdk-text' }, h('b', { text: it.label }), h('small', { text: it.desc }))));
    });
    syncActive();
  }
  function runItem(it) { if (!it) return; api.close(); it.run(); }

  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; composeEndedAt = Date.now(); });
  input.addEventListener('input', renderList);
  input.addEventListener('keydown', (e) => {
    // 输入法把 Enter 用来确认候选词时，这个 Enter 不该执行选中项
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && Date.now() - composeEndedAt < 100) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!filtered.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length;
      syncActive(true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(filtered[active]);
    }
  });

  const api = openSheet({
    title: '命令面板',
    content: h('div', { class: 'cmdk' }, input, list, h('p', { class: 'cmdk-hint hint', text: '↑↓ 选择 · Enter 打开 · Esc 关闭' })),
    onClose: () => { cmdkApi = null; },
  });
  cmdkApi = api;
  renderList();
}
function buildCmdkOpeners() {
  const right = document.querySelector('.topbar-right');
  if (right && !document.getElementById('cmdk-open')) {
    right.prepend(h('button', { type: 'button', class: 'btn cmdk-open', id: 'cmdk-open', onclick: openCommandPalette },
      icon('search'), h('span', { text: '命令' }), h('kbd', { class: 'cmdk-kbd', text: /Mac|iP/.test(navigator.platform) ? '⌘ K' : 'Ctrl K' })));
  }
  // 手机上没有 Ctrl+K，应用栏给一颗可点的入口（顶栏那颗随 topbar-right 一起隐藏）
  const status = document.getElementById('appbar-status');
  if (status && !document.getElementById('appbar-cmd')) {
    status.before(h('button', { type: 'button', class: 'appbar-cmd', id: 'appbar-cmd', 'aria-label': '打开命令面板', onclick: openCommandPalette }, icon('search')));
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCommandPalette(); }
  });
}

// ---------- 计数徽标：绑真实状态，滚动切换，归零缩小退出 ----------
// 徽标绝对定位在图标托右上角，不占布局，入口位置不变。数字变化时旧字往变化方向滚出、
// 新字从另一侧滚入；归零走缩小退场，演完再 hidden。减弱动效由全局覆盖层停掉动画。
function updateBadges() {
  for (const [page, def] of Object.entries(BADGES)) {
    const n = def.count();
    const text = n > 99 ? '99+' : String(n);
    for (const el of document.querySelectorAll(`.nav-badge[data-for="${page}"]`)) {
      const prev = Number(el.dataset.n || '0');
      const cur = el.querySelector('.nb-n:not(.nb-old)');
      const host = el.closest('[data-page]');
      if (host) {
        if (n > 0) host.setAttribute('aria-label', `${PAGES[page].label}，${n} ${def.unit}`);
        else host.removeAttribute('aria-label');
      }
      if (n === prev && cur && cur.textContent === text) { el.hidden = n === 0; continue; }
      el.dataset.n = String(n);
      if (n === 0) {
        if (!el.hidden) {
          el.classList.add('nb-out');
          setTimeout(() => { el.hidden = true; el.classList.remove('nb-out'); }, 200);
        }
        continue;
      }
      const fresh = el.hidden || !cur;
      el.hidden = false;
      el.classList.remove('nb-out');
      if (fresh) {
        if (cur) cur.remove();
        el.append(h('span', { class: 'nb-n', text }));
        el.classList.add('nb-in');
        setTimeout(() => el.classList.remove('nb-in'), 240);
        continue;
      }
      if (cur.textContent === text) continue;
      const dir = n > prev ? 'nb-up' : 'nb-down';
      cur.classList.add('nb-old', dir);
      el.append(h('span', { class: `nb-n nb-new ${dir}`, text }));
      setTimeout(() => cur.remove(), 260);
    }
  }
}

function openStatusSheet() {
  const s = state.settings;
  const rows = [
    ['chip-reminder', s.remindersEnabled ? '提醒' : '提醒'],
    ['chip-notify', hasNativeReminder() ? '系统通知' : '浏览器通知'],
    ['chip-data', '本机数据'],
  ].map(([id, label]) => {
    const el = document.getElementById(id);
    if (!el) return null;
    return h('div', { class: 'kv' },
      h('b', { text: label }),
      h('span', { text: el.textContent }),
      el.title ? h('p', { class: 'hint', text: el.title }) : null,
    );
  });
  const total = state.courses.length + state.tasks.length + state.plans.length;
  const sheet = openSheet({
    title: '这台设备上的状态',
    content: h('div', { class: 'status-rows' },
      ...rows,
      total === 0 ? h('p', { class: 'hint', text: '库还是空的，可以先加载一份示例数据看看流程。' }) : null,
    ),
    actions: [
      // ev.currentTarget 在 await 之后会被浏览器置空，先把按钮本身收到变量里，finally 才拿得到
      total === 0 ? h('button', {
        class: 'btn btn-primary',
        onclick: async (ev) => { const btn = ev.currentTarget; btn.disabled = true; try { await loadSampleData(); } finally { if (btn.isConnected) btn.disabled = false; } },
        text: '加载示例数据',
      }) : h('button', { class: 'btn btn-primary', onclick: () => { sheet.close(); goPage(s.remindersEnabled ? 'reminders' : 'planner'); }, text: s.remindersEnabled ? '去提醒页' : '去计划页' }),
      h('button', { class: 'btn', onclick: () => { sheet.close(); openNotice(); }, text: '使用须知' }),
      h('button', { class: 'btn', onclick: () => { sheet.close(); goPage('settings'); }, text: '打开设置' }),
    ],
  });
}

// 应用栏右侧那一颗状态点：手机端首屏不给三颗胶囊让位，但状态要一眼能看到、点开有详情
function updateAppBar() {
  const btn = document.getElementById('appbar-status');
  if (!btn) return;
  const txt = document.getElementById('appbar-status-text');
  const n = pendingCount();
  const on = !!state.settings.remindersEnabled;
  if (txt) txt.textContent = on ? (n ? `${n} 条待响` : '提醒已开') : '提醒未开';
  btn.className = `appbar-status ${on ? 'on' : 'off'}`;
}

// motion 只给「用户主动换页」和「首次确认须知」这两种场合：
// 写库后的重绘（xj:changed）不带动画，否则每确认一条建议整页都闪一下。
async function renderPage({ motion = false, dir = '' } = {}) {
  const root = view();
  clear(root);
  if (motion) {
    // 长页翻到短页时浏览器会把滚动位置硬裁到顶部，看上去像闪屏：这里直接归零，交给动画说话
    window.scrollTo(0, 0);
    // 行错峰和整页进场同帧结束，子的 animationend 可能先冒上来：once 会被它吃掉，整页的类就永远摘不掉。
    // 只有事件来自整页自己才摘类并撤监听，子元素的事件直接放过。
    const onEnd = (e) => {
      if (e.target !== root) return;
      root.classList.remove('xj-enter', 'xj-fwd', 'xj-back');
      root.removeEventListener('animationend', onEnd);
    };
    root.addEventListener('animationend', onEnd);
    if (dir) {
      root.classList.toggle('xj-fwd', dir === 'fwd');
      root.classList.toggle('xj-back', dir === 'back');
    }
    restartAnim(root, 'xj-enter');
  }
  document.title = DEFAULT_TITLE;
  const busy = h('div', { class: 'loading' }, h('span', { class: 'spinner' }), h('span', { text: '载入中…' }));
  root.append(busy);
  try {
    await PAGES[state.page].mod.render(root);
    busy.remove();
  } catch (e) {
    clear(root);
    root.append(h('div', { class: 'err', text: `这个页面没打开：${e.message}` }));
    console.error(e);
  }
  root.focus({ preventScroll: true });
  const guide = guideCard();
  if (guide) {
    // 说明条放在今日页的体验入口之后；直接打开内页时优先显示该页功能。
    const hero = state.page === 'today' ? root.querySelector('.card-hero') : null;
    if (hero) (hero.closest('.today-workbench') || hero).after(guide); else root.prepend(guide);
  }
  collapseLead(root);
  updateChips();
  updateAppBar();
  updateBadges();
  // 开屏那一次 #nav 可能还没量出尺寸（须知门禁盖着、字体未定），这里再补一次落位
  moveTabInd(state.page);
  // 换页后重算一次滚动深度：非今日页要把它归零，别让天空停在暗的那一档
  syncDepth();
}

// 页面说明在手机端会吃掉大半个首屏：超过两行的段落默认折起来，想看的人自己点开。
const SUB_CLAMP = 90;
function collapseLead(root) {
  const head = root.querySelector('.page-head');
  const sub = head && head.querySelector('.page-sub');
  if (!head || !sub || sub.textContent.trim().length < SUB_CLAMP) return;
  head.classList.add('clamped');
  const btn = h('button', {
    type: 'button', class: 'sub-more', 'aria-expanded': 'false',
    onclick: (ev) => {
      const open = ev.currentTarget.getAttribute('aria-expanded') === 'true';
      ev.currentTarget.setAttribute('aria-expanded', open ? 'false' : 'true');
      ev.currentTarget.textContent = open ? '展开' : '收起';
      sub.classList.toggle('open', !open);
    },
  }, h('span', { text: '展开' }));
  head.append(btn);
}

// ---------- 顶部状态胶囊 ----------
function chip(id, text, on, title) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `chip ${on === true ? 'on' : on === false ? 'off' : ''}`;
  if (title) el.title = title;
}
function updateChips() {
  const s = state.settings;
  const nxt = nextUp();
  chip('chip-reminder',
    s.remindersEnabled
      ? (pendingCount() ? `提醒 ${pendingCount()} 条待响` : '提醒 已开启')
      : '提醒 未开启',
    !!s.remindersEnabled,
    nxt ? `下一次：${nxt.title} ${ymd(new Date(nxt.at))} ${new Date(nxt.at).toTimeString().slice(0, 5)}` : '到提醒页开启');
  const perm = notifyPermission();
  if (!hasNativeReminder()) {
    chip('chip-notify', { granted: '通知 已允许', denied: '通知 被拒绝' }[perm] || (perm === 'unsupported' ? '通知 不支持' : '通知 未申请'),
      perm === 'granted' ? true : perm === 'default' ? null : false);
  } else {
    // App 的 WebView 里没有 window.Notification，这颗胶囊必须改报系统通知权限的真实状态
    if (nativeChip) applyNativeChip(nativeChip);
    else chip('chip-notify', '通知 读取中', null, 'App 走系统通知权限，正在向系统读取当前状态');
    nativeStatus().then((st) => { if (st) { nativeChip = st; applyNativeChip(st); } }).catch(() => {});
  }
  const total = state.courses.length + state.tasks.length + state.plans.length;
  chip('chip-data', `本机数据 ${total} 条`, total > 0, `数据只存在${dataPlace()}里，边界见「使用须知」`);
}

let nativeChip = null;
function applyNativeChip(st) {
  chip('chip-notify',
    st.notificationsAllowed
      ? (st.exactAlarmsAllowed ? '通知 已允许 · 精确闹钟' : '通知 已允许 · 批量闹钟')
      : '通知 未允许',
    st.notificationsAllowed,
    `系统通知：${st.notificationsAllowed ? '已允许' : '未允许'}｜精确闹钟：${st.exactAlarmsAllowed ? '已允许' : '未允许，会退成批量闹钟，可能晚几分钟'}｜系统已登记 ${st.pendingCount || 0} 条`);
}

// ---------- 星空背景 ----------
// skyDepth：今日页往下滚时从 0 涨到 1（见 deepSky）。星点按它加速、变亮、变大一点，
// 配合 body::before 那层渐深的天空，读起来就是「越往下看越往深处走」。
let skyDepth = 0;
function starfield() {
  const canvas = document.getElementById('stars');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let stars = [], w = 0, h2 = 0, raf = 0;
  // 减弱动效不只在启动时读一次：系统里现场开关它，天空要真的停下来或真的走起来。
  // 停下来时把画布藏掉，但只在这时候写内联样式；关掉减弱动效要还回 CSS，
  // 否则浅色档「白底不画星」那条规则会被内联 display 顶掉。
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  // 宽屏那档才有的「活天空」：分层视差 + 逐星闪烁 + 偶发流星 + 指针微视差。
  // 手机档（≤900px）走下面 else 里与原来逐行一致的路径，App 端观感不变。
  const desk = matchMedia('(min-width: 901px)');
  let meteors = [], nextMeteor = 0, px = 0, py = 0, tx = 0, ty = 0;
  function resize() {
    // dpr 每次重算：浏览器缩放或换到外接屏时它真的会变，只在启动时抓一次会让星空一直是糊的
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = window.innerWidth;
    h2 = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h2 * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const deep = desk.matches;
    const n = deep ? Math.min(230, Math.round((w * h2) / 9000)) : Math.min(160, Math.round((w * h2) / 14000));
    stars = Array.from({ length: n }, () => {
      const r = Math.random() * 1.3 + 0.3;
      return {
        x: Math.random() * w, y: Math.random() * h2,
        r,
        a: Math.random() * 0.6 + 0.15,
        tw: Math.random() * 0.018 + 0.004,
        vy: Math.random() * 0.05 + 0.01,
        hue: Math.random() < 0.35 ? '210,190,255' : '255,255,255',
        z: deep ? (r - 0.3) / 1.3 : 0,
        ph: Math.random() * Math.PI * 2,
        vx: deep ? (Math.random() * 0.02 + 0.004) * (Math.random() < 0.5 ? -1 : 1) : 0,
      };
    });
    meteors = []; nextMeteor = 0; px = py = tx = ty = 0;
  }
  // 流星预算：同屏最多两条，每条自带淡入淡出；生成间隔 6–15s，不抢正文的注意力
  function meteorStep(t) {
    if (!nextMeteor) nextMeteor = t + 2500 + Math.random() * 4500;
    if (t >= nextMeteor && meteors.length < 2) {
      nextMeteor = t + 6000 + Math.random() * 9000;
      const dir = Math.random() < 0.5 ? 1 : -1;
      const ang = 0.42 + Math.random() * 0.3;
      const sp = 6.5 + Math.random() * 4.5;
      const vx = Math.cos(ang) * sp * dir, vy = Math.sin(ang) * sp;
      const inv = 1 / Math.hypot(vx, vy);
      meteors.push({
        x: dir === 1 ? Math.random() * w * 0.45 : w * (0.55 + Math.random() * 0.45),
        y: Math.random() * h2 * 0.3,
        vx, vy, ux: vx * inv, uy: vy * inv,
        len: 90 + Math.random() * 70, life: 0, max: 55 + Math.random() * 25,
      });
    }
    for (let i = meteors.length - 1; i >= 0; i--) {
      const m = meteors[i];
      m.life++; m.x += m.vx; m.y += m.vy;
      const p = m.life / m.max;
      if (p >= 1 || m.x < -200 || m.x > w + 200 || m.y > h2 + 200) { meteors.splice(i, 1); continue; }
      const fade = Math.sin(Math.PI * p);
      const ex = m.x - m.ux * m.len, ey = m.y - m.uy * m.len;
      const g = ctx.createLinearGradient(m.x, m.y, ex, ey);
      g.addColorStop(0, `rgba(210,190,255,${(0.85 * fade).toFixed(3)})`);
      g.addColorStop(1, 'rgba(210,190,255,0)');
      ctx.strokeStyle = g; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = `rgba(255,255,255,${(0.9 * fade).toFixed(3)})`;
      ctx.arc(m.x, m.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  let last = 0;
  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (t - last < 33) return;
    last = t;
    ctx.clearRect(0, 0, w, h2);
    const deep = desk.matches;
    if (deep) { px += (tx - px) * 0.06; py += (ty - py) * 0.06; }
    for (const st of stars) {
      if (deep) {
        // 每颗星自己的相位与频率：近层闪得快、远层慢，整片天不再是一起呼吸的散点
        const twk = 0.5 + 0.5 * Math.sin(t * 0.001 * (0.5 + st.z * 1.6) + st.ph);
        st.a = 0.1 + twk * (0.5 + skyDepth * 0.35);
        st.y -= st.vy * (1 + skyDepth * (2 + st.r * 1.8)) * (0.55 + st.z * 0.9);
        st.x += st.vx * (0.5 + st.z);
        if (st.y < -2) { st.y = h2 + 2; st.x = Math.random() * w; }
        if (st.x < -2) st.x = w + 2; else if (st.x > w + 2) st.x = -2;
        const ox = px * (2 + st.z * 10), oy = py * (1.5 + st.z * 7);
        if (st.r > 1.05) {
          ctx.beginPath();
          ctx.fillStyle = `rgba(${st.hue},${(st.a * 0.16).toFixed(3)})`;
          ctx.arc(st.x + ox, st.y + oy, st.r * 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.fillStyle = `rgba(${st.hue},${st.a.toFixed(3)})`;
        ctx.arc(st.x + ox, st.y + oy, st.r * (1 + skyDepth * 0.3), 0, Math.PI * 2);
        ctx.fill();
      } else {
        st.a += Math.sin(t * st.tw * 0.01) * 0.008;
        st.a = Math.max(0.06, Math.min(0.85 + skyDepth * 0.15, st.a));
        // 深处走得快：近处（半径大）的那批加速更明显，才有穿行感而不是整片平移
        st.y -= st.vy * (1 + skyDepth * (2 + st.r * 1.8));
        if (st.y < -2) st.y = h2 + 2;
        ctx.beginPath();
        ctx.fillStyle = `rgba(${st.hue},${st.a.toFixed(3)})`;
        ctx.arc(st.x, st.y, st.r * (1 + skyDepth * 0.3), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (deep) meteorStep(t);
  }
  resize();
  // 拖动窗口边缘会连着来几十个 resize，每个都重铺一遍星星；等它停下来再重铺一次
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 200); });
  // 跨过 901px 这道坎时重铺：星数、层深、横向漂移都要换档，流星清零
  if (desk.addEventListener) desk.addEventListener('change', resize);
  // 指针微视差：只记目标值，帧里缓动跟随；鼠标离开窗口慢慢归位，不留偏移
  window.addEventListener('pointermove', (e) => {
    if (!desk.matches) return;
    tx = (e.clientX / w - 0.5) * 2;
    ty = (e.clientY / h2 - 0.5) * 2;
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => { tx = 0; ty = 0; });
  // 停与走只看三件事：有没有开减弱动效、页面在不在前台、当前是不是深色那一档。
  // 浅色里 CSS 已经把画布 display:none 了——白底上画白点本来就看不见，
  // 但那不代表 rAF 可以继续白跑一遍，所以这里真的停下来，切回深色再真的走起来。
  const shouldRun = () => !reduce.matches && document.visibilityState !== 'hidden' && theme() !== 'light';
  const sync = () => {
    if (reduce.matches) canvas.style.display = 'none';
    else canvas.style.removeProperty('display');
    if (shouldRun() && !raf) raf = requestAnimationFrame(frame);
    else if (!shouldRun() && raf) { cancelAnimationFrame(raf); raf = 0; ctx.clearRect(0, 0, w, h2); }
  };
  document.addEventListener('visibilitychange', sync);
  if (reduce.addEventListener) reduce.addEventListener('change', sync);
  onTheme(sync);
  sync();
}

// ---------- 滚动深度：只在今日页驱动 ----------
// 参考的是那种「首屏随着滚动逐渐沉进去」的做法，落到我们的主题就是潜入深空。
// 边界：① 只有今日页有效，别的页面一进就把 --depth 归零，免得整站变暗；
//       ② prefers-reduced-motion 下根本不挂监听，也不写变量，天空保持静态那一版；
//       ③ 只改背景这层，正文卡片与按钮的可见性、可点性一律不动。
function deepSky() {
  if (reduceMotion()) { document.documentElement.style.setProperty('--depth', '0'); return; }
  let queued = 0;
  const onScroll = () => {
    if (queued) return;
    queued = requestAnimationFrame(() => { queued = 0; syncDepth(); });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  syncDepth();
}

// 深度值一次算清：滚动、换页、窗口尺寸变化都走这里，别的模块不用关心事件是怎么来的
function syncDepth() {
  if (reduceMotion()) return;
  const root = document.documentElement;
  // 距离按「这一页真能滚多少」算：短页划到底也要沉到 1，长页最迟在一个视口内沉到底。
  // 原来这里给过 160 的下限，结果「只能滚 126px」的短页最深只到 0.787——
  // 注释承诺的「短页划到底也沉得下去」被这个下限自己否掉了。
  const range = Math.max(0, root.scrollHeight - window.innerHeight);
  const span = Math.max(1, Math.min(range, window.innerHeight));
  const y = window.scrollY || root.scrollTop || 0;
  skyDepth = state.page === 'today' ? Math.min(1, y / span) : 0;
  root.style.setProperty('--depth', skyDepth.toFixed(3));
}
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- 手机可视区：把可视高度写成 CSS 变量给弹层用 ----------
// Android Chrome 默认 resizes-visual：innerHeight 不变、只有 visualViewport 缩小，聚焦输入框由浏览器自己滚进可见区，
// 所以这里只维护 --vv-h：键盘弹起后弹层（.sheet）按它限高，「保存」按钮才不会被压在键盘下面。
function watchViewport() {
  const vv = window.visualViewport;
  const apply = () => {
    document.documentElement.style.setProperty('--vh', `${Math.round(window.innerHeight)}px`);
    if (vv) document.documentElement.style.setProperty('--vv-h', `${Math.round(vv.height)}px`);
  };
  apply();
  window.addEventListener('resize', apply);
  if (!vv) return;
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
}

// ---------- 托管页脚水印：量出它占掉的高度，让底栏和抽屉避开 ----------
// 站点发布后，平台会往页面里注入一颗固定定位、贴着右下角、z-index 顶到最大且可点的水印。
// 手机视口下它正好压在底部标签栏的右两格上：真人点「任务」「更多」点到的是它，不是我们的按钮。
// 本地和 App 没有这个元素，所以这条带是 0，版式和现在一模一样。
// 这里不藏它、不盖它、不跟它争 z-index——只把自己那格挪开，两边都点得到。
function keepHostBadgeClear() {
  let last = -1;
  const apply = () => {
    const el = document.getElementById('qoder-sites-watermark');
    let keep = 0;
    if (el) {
      const r = el.getBoundingClientRect();
      // 它的关闭按钮浮在自己上沿再往上 8px，量到的矩形不含那一截，多留一点
      if (r.height) keep = Math.min(160, Math.ceil(window.innerHeight - r.top) + 6);
    }
    if (keep === last) return;
    last = keep;
    document.documentElement.style.setProperty('--host-keep', `${keep}px`);
    // 滑块的位置是按 #nav 里的几何算的，底栏长高了就得重算一次，不然它还停在旧高度
    moveTabInd(state.page, { animate: false });
  };
  apply();
  window.addEventListener('resize', apply);
  // 用户可以把水印关掉（关掉后这条带要收回来），平台也可能在后续时机重新插入
  new MutationObserver(apply).observe(document.body, { childList: true });
}

// ---------- 本机数据从哪来：来源隔离说明 / 空库引导 ----------
const GUIDE_KEY = 'xj-guide-dismissed';
let sampleBusy = false;

function guideDismissedFor(mode) {
  try { return JSON.parse(localStorage.getItem(GUIDE_KEY) || '{}')[mode] === true; } catch (e) { return false; }
}
function dismissGuide(mode) {
  let m = {};
  try { m = JSON.parse(localStorage.getItem(GUIDE_KEY) || '{}'); } catch (e) { m = {}; }
  m[mode] = true;
  try { localStorage.setItem(GUIDE_KEY, JSON.stringify(m)); } catch (e) { /* 隐私模式下写不了，下次还会提示 */ }
}

async function loadSampleData() {
  if (sampleBusy) return;
  sampleBusy = true;
  try {
    const hadData = state.courses.length || state.tasks.length;
    if (hadData && !window.confirm('已经有数据了。点「确定」合并加入示例数据，点「取消」放弃。')) return;
    const result = await db.loadSample('merge');
    await refreshData();
    initWeek();
    await syncDerived();
    changed('sample');
    toast(result.alreadyLoaded ? '示例数据已经加入过了' : '示例数据已加载', result.alreadyLoaded ? '保留现有记录，不会重复添加。' : '');
  } catch (e) {
    toast('示例数据没加载完', (e && e.message) || '这台设备的存储写不进去，原有数据没有变化。', 'bad');
  } finally {
    sampleBusy = false;
  }
}

const GUIDE_NOTE = '数据存放位置、AI 会看到什么、提醒做不到什么，都写在「使用须知」里，设置页随时能再打开。';

function guideCard() {
  const isFile = location.protocol === 'file:';
  const hasData = [state.courses, state.tasks, state.plans, state.sessions, state.goals, state.reminders, state.reviews]
    .some((rows) => rows.length > 0);
  const mode = isFile ? 'file' : (state.page === 'today' && !hasData ? 'empty' : null);
  if (!mode || guideDismissedFor(mode)) return null;
  const here = isFile ? location.href : location.origin;
  const inApp = isNativeApp();
  const sampleBtn = (cls) => h('button', {
    class: cls,
    onclick: async (ev) => { const btn = ev.currentTarget; btn.disabled = true; try { await loadSampleData(); } finally { if (btn.isConnected) btn.disabled = false; } },
    text: '加载示例数据',
  });
  const dismissBtn = (cls, text) => h('button', {
    class: cls,
    onclick: (ev) => { dismissGuide(mode); const c = ev.currentTarget.closest('.card'); if (c) c.remove(); },
    text,
  });
  // file:// 是真的会丢数据的坑，保留整卡说明；空库只是「还没开始」，压成两行，别压住首屏主行动
  if (isFile) {
    const lines = [
      `现在是直接双击文件打开的（${here}）。这种打开方式有自己的一份存储，跟 http://localhost:8765 那种地址完全不通。`,
      '想在原来存过数据的地方继续用，请起一个本地静态服务器后用那个地址打开，例如在 studyhack-web 目录运行 python -m http.server 8765，再访问 http://localhost:8765/index.html。',
      '在这个页面上做的任何改动，只会写进「file:// 这一份库」，不会被别的地址读到。',
    ];
    return h('div', { class: 'card guide-card' },
      h('h3', {}, h('span', { text: '这份数据存在哪个库里？' }),
        h('span', { class: 'tag', style: 'margin-left:8px', text: '本机存储说明' })),
      ...lines.map((t) => h('p', { class: 'hint', text: t })),
      h('p', { class: 'note muted', text: GUIDE_NOTE }),
      h('div', { class: 'btn-row', style: 'margin-top:10px' },
        sampleBtn('btn btn-primary'),
        h('button', { class: 'btn', onclick: () => goPage('settings'), text: '去设置页导入备份' }),
        h('button', { class: 'btn', onclick: () => openNotice(), text: '看使用须知' }),
        dismissBtn('btn btn-ghost', '知道了，这个地址下不再提示'),
      ),
    );
  }
  const lead = inApp
    ? 'App 和网页各自保存数据。换设备或从网页搬过来，可以导入备份。'
    : '这里还没有学习记录。换过地址或设备？展开详情可查看恢复方法。';
  const detailLines = inApp
    ? ['如果数据在浏览器那边：用那边的「设置 → 导出 JSON 备份」，再回到 App 的设置页导入。']
    : [
        `当前来源：${here}。如果你确定别处录过数据，先看地址栏写法是否完全一致——同一个端口但 localhost 换成 127.0.0.1，也是另一个空库。`,
        '要拿回旧数据，用设置页「导入 JSON 备份」。',
      ];
  const more = h('div', { class: 'guide-more', hidden: true },
    ...detailLines.map((t) => h('p', { class: 'hint', text: t })),
    h('div', { class: 'btn-row', style: 'margin-top:8px' },
      h('button', { class: 'btn btn-sm', onclick: () => goPage('settings'), text: '导入 JSON 备份' }),
      h('button', { class: 'btn btn-sm', onclick: () => openNotice(), text: '看使用须知' }),
    ),
  );
  return h('div', { class: 'card guide-card guide-compact' },
    h('p', { class: 'hint', style: 'margin-top:0', text: lead }),
    h('p', { class: 'hint guide-note', text: GUIDE_NOTE }),
    h('div', { class: 'btn-row guide-actions' },
      sampleBtn('btn btn-sm guide-sample'),
      h('button', {
        class: 'btn btn-sm btn-ghost guide-toggle', 'aria-expanded': 'false',
        onclick: (ev) => {
          const open = more.hidden;
          more.hidden = !open;
          ev.currentTarget.setAttribute('aria-expanded', String(open));
          ev.currentTarget.textContent = open ? '收起详情' : '展开详情';
        },
        text: '展开详情',
      }),
      dismissBtn('btn btn-sm btn-ghost', '不再提示'),
    ),
    more,
  );
}

// ---------- 启动 ----------
let noticeAcked = isAcked();

// ---------- 按压态 ----------
// 触屏上浏览器不一定给 :active（合成事件、页面没注册触摸监听时都不会），但「按下去要有反应」
// 不能交给浏览器决定：用 pointerdown 自己挂一个类，样式和 :active 写在一起，两端共用同一套观感。
const PRESS_CLS = 'xj-press';
const PRESSABLE = '.btn, .icon-btn, .pill, .nav-item, .nav-group-head, .more-item, .home-tile, .cal-cell, .tt-course, .appbar-status, .appbar-cmd, .appbar-theme, .sub-more, .dock-item, .cmdk-item, summary';
function bindPressState() {
  let pressed = null;
  const release = () => { if (pressed) { pressed.classList.remove(PRESS_CLS); pressed = null; } };
  document.addEventListener('pointerdown', (e) => {
    release();
    const t = e.target instanceof Element ? e.target.closest(PRESSABLE) : null;
    if (!t || t.disabled) return;
    pressed = t;
    t.classList.add(PRESS_CLS);
  }, true);
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);
}
function startEngineIfAllowed() {
  if (noticeAcked && state.settings.remindersEnabled) startEngine();
}

async function boot() {
  // 深浅色在 <html> 上已经由 index.html 那一小段定好了，这里再走一次是为了同步
  // meta[theme-color] 并挂上监听；顺带保证「脚本被禁用之后又放开」这种情况也能对上。
  applyTheme();
  try {
    await db.openDB();
  } catch (e) {
    document.body.prepend(h('div', { class: 'err', text: `本机存储打不开：${e.message}。浏览器隐私模式或禁用 IndexedDB 会导致数据无法保存。` }));
  }
  await refreshData();
  initWeek();
  // 派生提醒（课程 + 任务）
  const empty = await db.isEmpty();
  if (!empty) { try { await syncDerived(); } catch (e) { console.warn('生成提醒失败', e); } }

  starfield();
  watchViewport();
  keepHostBadgeClear();
  deepSky();

  buildNav();
  syncDock();
  buildCmdkOpeners();
  buildThemeToggles();
  // moveTabInd 会一路读 offsetParent 的几何信息（强制布局），拖窗口时不必每帧都算一遍
  let indTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(indTimer);
    indTimer = setTimeout(() => { moveTabInd(state.page, { animate: false }); moveSideInd(state.page, { animate: false }); }, 150);
  });
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.addEventListener('click', () => {
      if (btn.id === 'nav-more') openMoreSheet();
      else goPage(btn.dataset.page);
    });
  }
  const statusBtn = document.getElementById('appbar-status');
  if (statusBtn) statusBtn.addEventListener('click', openStatusSheet);
  bindPressState();
  // 软键盘弹出时（WebView 被 IME inset 压矮）给 html 挂一个标记，手机层据此收起底栏
  let baseH = window.innerHeight;
  const applyKb = () => {
    const shrunk = window.innerHeight < baseH - 120;
    document.documentElement.classList.toggle('kb-open', shrunk);
  };
  window.addEventListener('resize', () => {
    if (!document.documentElement.classList.contains('kb-open')) baseH = Math.max(baseH, window.innerHeight);
    applyKb();
  });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', applyKb);

  document.getElementById('btn-sample').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      await loadSampleData();
    } catch (err) {
      // 只 try/finally 的话，写库失败会把按钮恢复、把半套示例数据留在库里，而且一声不吭
      toast('示例数据没加载完', (err && err.message) || '这台设备的存储写不进去（可能是空间满了）。');
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  });

  document.addEventListener('xj:changed', async () => {
    await refreshData();
    initWeek();
    renderPage();
  });
  document.addEventListener('xj:goto', (e) => goPage(e.detail));
  window.addEventListener('hashchange', () => {
    const name = location.hash.replace('#', '');
    if (PAGES[name] && name !== state.page) goPage(name);
  });

  const initial = location.hash.replace('#', '');
  state.page = PAGES[initial] ? initial : 'today';
  markNav(state.page, { groupAnimate: false });
  await renderPage({ motion: true });

  // 边界只在首次进入讲完一次，确认过就不再拦路；没确认的这一轮不启动提醒引擎。
  // 空库提示要排在门禁之后，否则 toast 会盖在须知的第一段上。
  // 空库时页面顶部已经有说明卡，不再弹一条同义的 toast 把它盖住；只有说明卡被手动关掉后才提醒一次。
  const emptyHint = () => {
    if (empty && state.page !== 'assistants' && !document.querySelector('.guide-card')) {
      toast('还没有数据', '课程表页可以导入 CSV，也可以加载一份示例数据先看流程。');
    }
  };
  if (noticeAcked) {
    startEngineIfAllowed();
    emptyHint();
  } else {
    openNoticeGate({
      onAck: () => {
        noticeAcked = true;
        // 门禁撤掉之后正文才第一次亮相，给一次整页进场，别让人对着突然出现的空壳找按钮
        restartAnim(view(), 'xj-enter');
        startEngineIfAllowed();
        emptyHint();
      },
      onDecline: () => { stopEngine(); toast('须知没确认', '这一轮不启动提醒引擎。想再看一遍，设置页和右上角状态里都开着「使用须知」。'); },
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startEngineIfAllowed();
    else if (document.visibilityState === 'hidden') stopEngine();
  });
}

boot().catch((e) => {
  const root = view();
  if (root) {
    clear(root);
    root.append(h('div', { class: 'err', text: `页面启动失败：${e && e.message ? e.message : String(e)}` }));
  }
  console.error(e);
});
