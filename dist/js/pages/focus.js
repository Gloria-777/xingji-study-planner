// 专注计时：绝对时间戳倒计时 + 全屏 + 完成后记录实际用时（可关联计划与任务）
import * as db from '../store.js';
import { state, planStatus, taskProgress, spentMinForPlan, spentMinOn, sessionsOnDate, dayTotals, todayStr } from '../state.js';
import { h, icon, clear, put, toast, pad2, fmtDateTime, openSheet, confirmSheet, selectEl, DEFAULT_TITLE, PLAN_STATUS_LABEL } from '../ui.js';
import { playBell } from '../remind.js';
import { isNativeApp } from '../native.js';
import { changed, setPlanStatus } from '../forms.js';

const PRESETS = [15, 25, 40, 60];
let minutes = 25;
let left = 25 * 60;
let running = false;
let finished = false;
let endAt = 0;
let taskId = null;
let planId = null;
let titleText = '';
let interval = null;
let overlay = null;
// render() 每次把当前的重绘函数交给模块级逻辑（start/pause/reset 都在模块作用域）
let redraw = () => {};

// ---------- 跨刷新的那一轮 ----------
// 快照只存在本机 IndexedDB 的 meta 里，用来接回被刷新/切走打断的计时；不代表任何统计口径
const ROUND_KEY = 'focusRound';
let resumeNote = '';
let restoredOnce = false;

function persistRound() {
  return db.metaSet(ROUND_KEY, {
    taskId: taskId || null, planId: planId || null, titleText,
    minutes, left, running, finished, endAt: running ? endAt : null, savedAt: Date.now(),
  }).catch(() => {});
}
function forgetRound() {
  return db.metaSet(ROUND_KEY, null).catch(() => {});
}

/** 一次文档生命周期里只在第一次进专注页时接回上一轮；之后一切以内存里的状态为准 */
async function restoreOnce() {
  if (restoredOnce) return;
  restoredOnce = true;
  let snap = null;
  try { snap = await db.metaGet(ROUND_KEY); } catch (e) { return; }
  if (!snap || !Number.isFinite(Number(snap.minutes))) return;
  // 刚从计划页/今日页点「开始」进来：这一轮以点击为准，不被旧快照覆盖
  if (state.focusSeed) {
    if (snap.finished && !snap.running) {
      toast('上一轮结束了但还没记录', `「${snap.titleText || '自由专注'}」的 ${snap.minutes} 分钟没有落成记录。这一轮按你刚点的开始；想补那条就用专注页的「补记一次专注」。`);
    }
    return;
  }
  minutes = Math.min(240, Math.max(5, Number(snap.minutes) || 25));
  taskId = snap.taskId || null;
  planId = snap.planId || null;
  titleText = snap.titleText || '';
  if (snap.running) {
    const remain = Math.round((Number(snap.endAt) - Date.now()) / 1000);
    if (Number.isFinite(remain) && remain > 0) {
      running = true;
      finished = false;
      endAt = Number(snap.endAt);
      left = remain;
      resumeNote = `已接回刷新前的那一轮：${titleText || '自由专注'} · 还剩 ${fmtLeft(remain)}，倒计时继续走。`;
      tickLoop();
    } else {
      // 页面不在的时候这一轮到点了。绝不自动写记录、也不自动把计划标完成，交给人决定
      running = false;
      finished = true;
      left = 0;
      resumeNote = `这一轮设的 ${minutes} 分钟在刷新或切走期间到点了。计时结束不等于完成：要按 ${minutes} 分钟记一条，点下面「记录这一轮」；不想记就点「不要了，清空这一轮」。`;
    }
  } else if (snap.finished) {
    running = false;
    finished = true;
    left = 0;
    resumeNote = `上一轮 ${minutes} 分钟结束了但还没记录（${titleText || '自由专注'}）。现在补上也来得及（点「记录这一轮」），不想记点「不要了，清空这一轮」。`;
  } else {
    const l = Math.round(Number(snap.left));
    left = Number.isFinite(l) ? Math.max(0, Math.min(minutes * 60, l)) : minutes * 60;
    running = false;
    finished = false;
    if (left > 0 && left < minutes * 60) resumeNote = `接回上一轮暂停前的位置：${titleText || '自由专注'} · 还剩 ${fmtLeft(left)}。暂停和关页面期间走掉的时间不算进任何记录。`;
  }
}

/** 放弃这一轮：停表、回到准备状态、清掉快照 */
async function discardRound() {
  running = false;
  finished = false;
  clearInterval(interval);
  left = minutes * 60;
  resumeNote = '';
  await forgetRound();
  redraw();
  toast('这一轮已清空', '没有写入任何专注记录，计划页的进度也不会变。');
}

/** 计划页/今日页带来的关联信息。正在计时时只换关联，不重置已经跑起来的倒计时 */
function applySeed() {
  const seed = state.focusSeed;
  if (!seed) return;
  state.focusSeed = null;
  taskId = seed.taskId || null;
  planId = seed.planId || null;
  titleText = seed.title || '';
  const m = Math.min(240, Math.max(5, Number(seed.min) || 25));
  if (running) {
    toast('已换到这条安排', `这一轮继续按原来的 ${minutes} 分钟倒计时，不重置；结束时会记到「${titleText || '自由专注'}」${planId ? '对应的计划' : ''}。`);
  } else {
    minutes = m;
    left = m * 60;
    finished = false;
  }
}

function linkedPlan() { return planId ? state.plans.find((x) => x.id === planId) || null : null; }

function pickTaskEl() {
  const sel = h('select', { 'aria-label': '这次专注做什么' },
    h('option', { value: '', text: '不关联任务（自由专注）' }),
    ...state.tasks.filter((t) => t.status !== 'done').map((t) => h('option', { value: t.id, text: `${t.title}${t.estMin ? ` · 预计 ${t.estMin} 分钟` : ''}` })),
  );
  sel.value = taskId || '';
  sel.addEventListener('change', () => {
    taskId = sel.value || null;
    const t = state.tasks.find((x) => x.id === taskId);
    if (planId && (!t || t.id !== (state.plans.find((p) => p.id === planId) || {}).taskId)) {
      // 手动换了任务，原来那条计划的关联就不再保留：不猜测这笔时间属于哪条计划
      planId = null;
      toast('已解除计划关联', '任务改成了别的一条，这一轮不再计入原来那条计划。');
    }
    if (t) {
      titleText = t.title;
      if (t.estMin && t.estMin !== minutes) { minutes = Math.min(240, Number(t.estMin)); left = minutes * 60; }
    } else titleText = '';
    redraw();
  });
  return sel;
}

function tickLoop() {
  clearInterval(interval);
  interval = setInterval(() => {
    if (!running) return;
    left = Math.max(0, Math.round((endAt - Date.now()) / 1000));
    if (left <= 0) onFinish();
    updateTime();
  }, 250);
}

function start() {
  if (running) return;
  // 「再来一轮」时 left 还是 0，直接开跑会立刻判定时间到
  if (left <= 0) { left = minutes * 60; finished = false; }
  endAt = Date.now() + left * 1000;
  running = true;
  finished = false;
  tickLoop();
  redraw();
}
function pause() {
  running = false;
  clearInterval(interval);
  redraw();
}
function reset() {
  running = false;
  finished = false;
  clearInterval(interval);
  left = minutes * 60;
  redraw();
}
async function onFinish() {
  running = false;
  clearInterval(interval);
  finished = true;
  left = 0;
  await playBell(state.settings.bell);
  // 人可能在别的页上（计时在后台照走）。这时候甩一张记录用的抽屉会盖住他正在做的事，
  // 而专注页本来就留了「记录这一轮」的入口——所以这一档只提醒一句，回去再记。
  if (state.page !== 'focus') {
    document.title = DEFAULT_TITLE;
    toast('时间到', `这 ${minutes} 分钟结束了。回到专注页记一下实际用了多久。`);
    return;
  }
  toast('时间到', `这 ${minutes} 分钟是你的。要不要记一下实际用了多久？`);
  askActual();
  redraw();
}

function fmtLeft(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

/** 已经跑掉的分钟数（提前结束时用来预填实际用时） */
const elapsedMin = () => Math.max(0, Math.min(minutes, Math.round((minutes * 60 - left) / 60)));

/** 这条记录保存后会让哪些累计变化——只在弹窗里展示，不写入 */
function impactText({ tid, pid, addMin }) {
  const bits = [];
  const t = tid ? state.tasks.find((x) => x.id === tid) : null;
  if (t) {
    const pr = taskProgress(t);
    const spent = pr.spent + addMin;
    bits.push(pr.hasEst
      ? `任务累计 ${pr.spent} → ${spent} / 预计 ${pr.est} 分钟${spent > pr.est ? '（已超出预计）' : `（还差 ${Math.max(0, pr.est - spent)} 分钟）`}`
      : `任务累计 ${pr.spent} → ${spent} 分钟（这条任务没设预计时长）`);
  }
  const p = pid ? state.plans.find((x) => x.id === pid) : null;
  if (p) bits.push(`这条计划累计投入 ${spentMinForPlan(p.id) + addMin} 分钟（计划 ${p.min} 分钟）`);
  bits.push(`今天实际合计 ${dayTotals(sessionsOnDate(todayStr())).actual + addMin} 分钟`);
  return bits;
}

/** 计划状态选择：默认保持原状态，计时结束不等于完成 */
function planChoiceEl(p) {
  let choice = 'keep';
  const name = `pc${Math.random().toString(36).slice(2, 8)}`;
  const mk = (value, label) => h('label', { class: 'radio-line' },
    h('input', { type: 'radio', name, value, checked: value === 'keep', onchange: () => { choice = value; }, 'aria-label': label }),
    h('span', { text: label }),
  );
  const el = h('div', { class: 'field' },
    h('label', { text: `这条计划现在是「${PLAN_STATUS_LABEL[planStatus(p)]}」，记完这笔要怎么算？` }),
    mk('keep', '保持原状态，我自己稍后决定'),
    mk('done', '标记为「已完成」'),
    mk('skipped', '标记为「已跳过」'),
    h('p', { class: 'hint', text: '倒计时结束不会自动把计划改成已完成——只有这里选了才改。' }),
  );
  return { el, get: () => choice };
}

function askActual(opts = {}) {
  const prefill = Number.isFinite(opts.prefill) ? opts.prefill : minutes;
  const p = linkedPlan();
  const actual = h('input', { type: 'number', min: 0, max: 600, step: 1, value: prefill, 'aria-label': '实际用时（分钟）' });
  const note = h('input', { type: 'text', maxlength: 60, placeholder: '选填：中间发生了什么', 'aria-label': '备注' });
  const impact = h('div', { class: 'note muted' });
  const choice = p ? planChoiceEl(p) : null;
  const refresh = () => {
    const mins = Math.max(0, Number(actual.value) || 0);
    impact.textContent = `保存后：${impactText({ tid: taskId, pid: p ? p.id : null, addMin: mins }).join('　·　')}`;
  };
  actual.addEventListener('input', refresh);
  refresh();
  const api = openSheet({
    title: opts.early ? '提前结束，记录这一轮' : '记录实际用时',
    content: h('div', {},
      h('p', { class: 'hint', text: opts.early
        ? `这轮设了 ${minutes} 分钟，已经走过 ${elapsedMin()} 分钟。实际用了多少就填多少，不想记可以关掉。`
        : `计划 ${minutes} 分钟。实际用了多少就填多少，填 0 也可以——这只是一条数据，不是成绩单。` }),
      h('div', { class: 'field' }, h('label', { text: '实际分钟数' }), actual),
      h('div', { class: 'field' }, h('label', { text: '备注' }), note),
      h('div', { class: 'kv' }, h('b', { text: '关联' }), h('span', { text: linkLabel() })),
      impact,
      choice ? choice.el : null,
    ),
    actions: [
      h('button', { class: 'btn', onclick: () => { api.close(); }, text: '先不记' }),
      h('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const mins = Math.max(0, Number(actual.value) || 0);
          const row = {
            id: db.uid(), taskId: taskId || null, planId: planId || null,
            plannedMin: minutes, actualMin: mins,
            endedAt: new Date().toISOString(), note: note.value.trim(),
            title: titleText || (state.tasks.find((t) => t.id === taskId)?.title ?? '自由专注'),
          };
          await db.put('sessions', row);
          state.sessions.unshift(row);
          // 这一轮已经落成记录：清掉跨刷新快照，回到准备状态，免得下次打开再问一遍
          running = false;
          finished = false;
          resumeNote = '';
          clearInterval(interval);
          left = minutes * 60;
          await forgetRound();
          const picked = choice ? choice.get() : 'keep';
          if (picked !== 'keep') {
            const plan = state.plans.find((x) => x.id === row.planId);
            if (plan) await setPlanStatus(plan, picked, { silent: true });
          }
          api.close();
          changed('session-save');
          const parts = [`实际 ${mins} 分钟`];
          if (taskId) {
            const t = state.tasks.find((x) => x.id === taskId);
            const pr = taskProgress(t);
            parts.push(pr.hasEst ? `任务已投入 ${pr.spent} / 预计 ${pr.est} 分钟${pr.over ? '，已超出预计' : ''}` : `任务已投入 ${pr.spent} 分钟`);
          }
          if (planId) {
            const still = state.plans.find((x) => x.id === planId);
            if (still) parts.push(picked === 'keep' ? `计划仍是「${PLAN_STATUS_LABEL[planStatus(still)]}」` : `计划已标记为「${PLAN_STATUS_LABEL[picked]}」`);
            parts.push(`这条计划累计投入 ${spentMinForPlan(planId)} 分钟`);
          }
          toast('已记录', parts.join('　·　'));
        }, text: '保存',
      }),
    ],
  });
}

/** 记录上关联了什么：旧数据没有 planId 就写「未关联计划」，不做任何猜测 */
function linkLabel() {
  const bits = [titleText || '自由专注'];
  if (taskId) bits.push(`任务「${state.tasks.find((t) => t.id === taskId)?.title || '已删除'}」`);
  if (planId) {
    const p = state.plans.find((x) => x.id === planId);
    bits.push(p ? `计划 ${p.date} ${p.start} · ${PLAN_STATUS_LABEL[planStatus(p)]}` : '计划已删除（记录保留）');
  } else bits.push('未关联计划');
  return bits.join(' · ');
}

/** 提前结束：停表，把已经跑掉的时间填好交给用户确认，不自动写入 */
function endEarly() {
  const spent = elapsedMin();
  running = false;
  clearInterval(interval);
  if (spent <= 0) {
    reset();
    toast('这一轮还没跑满 1 分钟', '想放弃就点重置；计时已经停下。');
    return;
  }
  askActual({ prefill: spent, early: true });
  redraw();
}

/** 修改一条专注记录：预计/实际/关联任务/备注。累计时长与复盘每次都从记录重新汇总，所以改完自动同步 */
function editSession(x) {
  const planned = h('input', { type: 'number', min: 0, max: 600, step: 1, value: Number(x.plannedMin) || 0, 'aria-label': '预计分钟' });
  const actual = h('input', { type: 'number', min: 0, max: 600, step: 1, value: Number(x.actualMin) || 0, 'aria-label': '实际分钟' });
  const note = h('input', { type: 'text', maxlength: 60, value: x.note || '', 'aria-label': '备注' });
  const taskSel = selectEl(
    [{ value: '', label: '不关联任务' }, ...state.tasks.map((t) => ({ value: t.id, label: `${t.title}${t.estMin ? ` · 预计 ${t.estMin} 分钟` : ''}` }))],
    x.taskId || '', { 'aria-label': '关联任务' },
  );
  const hasPlan = Boolean(x.planId);
  const linked = hasPlan ? (state.plans.find((p) => p.id === x.planId) || null) : null;
  const api = openSheet({
    title: '修改这条专注记录',
    content: h('div', {},
      h('p', { class: 'hint', text: `原记录：${x.title || '自由专注'} · ${fmtDateTime(x.endedAt)}` }),
      h('div', { class: 'field-row' },
        h('div', { class: 'field' }, h('label', { text: '预计分钟' }), planned),
        h('div', { class: 'field' }, h('label', { text: '实际分钟' }), actual),
      ),
      h('div', { class: 'field' }, h('label', { text: '关联任务' }), taskSel),
      h('div', { class: 'field' }, h('label', { text: '备注' }), note),
      h('div', { class: 'note muted', text: hasPlan
        ? (linked ? `这条记录的关联保持为计划「${linked.title} ${linked.date} ${linked.start}」，改这里不会动它。` : '这条记录原本关联的计划已被删除；关联 ID 保留在记录里，不猜测改指向别的计划。')
        : '这条记录没有关联计划（旧数据或补记），不自动猜测关联。' }),
      h('div', { class: 'note muted', id: 'xj-session-impact' }),
    ),
    actions: [
      h('button', { class: 'btn', onclick: () => api.close(), text: '取消' }),
      h('button', {
        class: 'btn btn-primary', text: '保存',
        onclick: async () => {
          const next = {
            ...x,
            plannedMin: Math.max(0, Number(planned.value) || 0),
            actualMin: Math.max(0, Number(actual.value) || 0),
            taskId: taskSel.value || null,
            note: note.value.trim(),
          };
          if (next.taskId !== (x.taskId || null)) {
            const nt = state.tasks.find((t) => t.id === next.taskId);
            next.title = nt ? nt.title : '自由专注';
          }
          await db.put('sessions', next);
          const i = state.sessions.findIndex((y) => y.id === next.id);
          if (i >= 0) state.sessions[i] = next; else state.sessions.unshift(next);
          api.close();
          changed('session-edit');
          const t = next.taskId ? state.tasks.find((x2) => x2.id === next.taskId) : null;
          const pr = t ? taskProgress(t) : null;
          toast('已修改记录', pr && pr.hasEst ? `任务现在累计 ${pr.spent} / 预计 ${pr.est} 分钟，复盘同步更新。` : '累计时长与复盘已按新记录重新汇总。');
        },
      }),
    ],
  });
  const box = api.sheet.querySelector('#xj-session-impact');
  const show = () => {
    const before = Math.max(0, Number(x.actualMin) || 0);
    const after = Math.max(0, Number(actual.value) || 0);
    const tid = taskSel.value || null;
    const t = tid ? state.tasks.find((y) => y.id === tid) : null;
    // 这条记录原本的分钟数先从旧任务里扣掉，再按新任务加回来，避免重复累计
    const base = t ? spentMinOn(t.id) - (x.taskId === t.id ? before : 0) : 0;
    box.textContent = t
      ? `保存后任务「${t.title}」累计 ${base + after} 分钟${t.estMin ? ` / 预计 ${t.estMin} 分钟` : ''}；这条记录变化 ${before} → ${after}。`
      : `保存后这条记录不再关联任务；这条记录变化 ${before} → ${after} 分钟。`;
  };
  for (const el of [actual, planned]) el.addEventListener('input', show);
  taskSel.addEventListener('change', show);
  show();
}

// ---------- 全屏（站内沉浸层） ----------
// 不再调用原生 Fullscreen API：2026-11-18 用 Edge 实测，元素级全屏退出时
// exitFullscreen() 既不 resolve 也不 reject、fullscreenchange 也不触发，
// 站内层已收，人就被卡在全屏里、左侧导航也回不来（用户报的「项目栏消失」）。
// 覆盖层本来就铺满窗口，只用它就能达到「专注时只见计时」的效果，状态只有一层，不会和浏览器失步。
let fsKey = null;
function setFullscreen(on) {
  const host = document.getElementById('view');
  if (on) {
    overlay?.remove();
    overlay = h('div', { class: 'focus-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': '全屏倒计时' },
      h('button', { class: 'btn focus-exit', onclick: () => setFullscreen(false), text: '退出全屏 (Esc)' }),
      h('div', { class: 'focus-state', text: titleText || '自由专注' }),
      h('div', { class: 'focus-time', id: 'ov-time', text: fmtLeft(left) }),
      h('div', { class: 'focus-progress' }, h('i', { id: 'ov-bar', style: `width:${pct()}%` })),
      h('div', { class: 'btn-row', style: 'justify-content:center' },
        running
          ? h('button', { class: 'btn btn-primary', onclick: () => { pause(); setFullscreen(true); }, text: '暂停' })
          : h('button', { class: 'btn btn-primary', onclick: () => { start(); }, text: '开始' }),
        h('button', { class: 'btn', onclick: () => { reset(); setFullscreen(true); }, text: '重置' }),
      ),
    );
    // 挂在页面里而不是 body：页面重绘时能跟着一起收，不会留下一层盖住导航的无主浮层
    (host || document.body).append(overlay);
    document.documentElement.classList.add('xj-immersive');
    overlay.tabIndex = -1;
    overlay.focus({ preventScroll: true });
    if (!fsKey) {
      fsKey = (e) => {
        if (e.key === 'Escape' && overlay) { e.preventDefault(); setFullscreen(false); }
      };
      document.addEventListener('keydown', fsKey);
    }
  } else {
    overlay?.remove();
    overlay = null;
    document.documentElement.classList.remove('xj-immersive');
    if (fsKey) { document.removeEventListener('keydown', fsKey); fsKey = null; }
    redraw();
    const back = [...document.querySelectorAll('#view button')].find((b) => /全屏倒计时/.test(b.textContent));
    if (back) back.focus({ preventScroll: true });
  }
}
const pct = () => Math.round((1 - left / (minutes * 60)) * 100);
// 环要带小数：25 分钟那一档整数百分比 1 秒才走 0.067%，取整后环看起来根本没动
const pctDial = () => Math.min(100, Math.max(0, (1 - left / (minutes * 60)) * 100)).toFixed(2);

// 卡片里的环形进度：静态 SVG 字符串（不含任何外部内容），环心放倒计时和「已用几分钟」
const DIAL_RING = '<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">'
  + '<defs><linearGradient id="xj-dial-grad" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" stop-color="#8f7bf5"/><stop offset="1" stop-color="#6ea8ff"/></linearGradient></defs>'
  + '<circle class="track" cx="60" cy="60" r="52" pathLength="100"/>'
  + '<circle class="prog" cx="60" cy="60" r="52" pathLength="100"/></svg>';

function dialEl() {
  return h('div', { class: `focus-dial${finished ? ' done' : ''}`, id: 'xj-dial', html: DIAL_RING, style: `--p:${pctDial()}` },
    h('div', { class: 'focus-dial-body' },
      h('div', { class: 'focus-time', id: 'xj-time', text: fmtLeft(left) }),
      h('div', { class: 'dial-cap', id: 'xj-dial-cap', text: `已用 ${elapsedMin()} / ${minutes} 分钟` }),
    ),
  );
}

function updateTime() {
  const dial = document.getElementById('xj-dial');
  if (dial) {
    dial.style.setProperty('--p', pctDial());
    dial.classList.toggle('done', finished);
    const el = document.getElementById('xj-time');
    if (el) el.textContent = fmtLeft(left);
    const cap = document.getElementById('xj-dial-cap');
    if (cap) cap.textContent = `已用 ${elapsedMin()} / ${minutes} 分钟`;
  }
  const ov = document.getElementById('ov-time');
  if (ov) ov.textContent = fmtLeft(left);
  const ovb = document.getElementById('ov-bar');
  if (ovb) ovb.style.width = `${pct()}%`;
  document.title = running ? `${fmtLeft(left)} · 星迹` : DEFAULT_TITLE;
}

function manualLogSheet() {
  const mins = h('input', { type: 'number', min: 1, max: 600, value: 25, 'aria-label': '实际分钟' });
  const when = h('input', { type: 'date', value: todayStr(), 'aria-label': '日期' });
  const planned = h('input', { type: 'number', min: 1, max: 600, value: 25, 'aria-label': '预计分钟' });
  const note = h('input', { type: 'text', maxlength: 60, 'aria-label': '备注' });
  const taskSel = selectEl(
    [{ value: '', label: '不关联任务（自由专注）' }, ...state.tasks.map((t) => ({ value: t.id, label: `${t.title}${t.estMin ? ` · 预计 ${t.estMin} 分钟` : ''}` }))],
    taskId || '', { 'aria-label': '关联任务' },
  );
  const err = h('div', { class: 'err', style: 'display:none' });
  const planLabel = h('label', { text: '关联计划（只列这一天已保存的条目，选不选都行）' });
  const planNote = h('div', { class: 'note muted', style: 'display:none' });
  const planBox = h('div', { class: 'field' }, planLabel, planNote);
  let planSel = null;
  let plannedTouched = false;
  planned.addEventListener('input', () => { plannedTouched = true; });

  const dayPlans = () => state.plans
    .filter((p) => p.date === when.value)
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));

  function showPlanNote(p) {
    if (!p) { planNote.style.display = 'none'; planNote.textContent = ''; return; }
    planNote.style.display = '';
    planNote.textContent = `选中「${p.title} ${p.date} ${p.start} · ${p.min} 分钟（${PLAN_STATUS_LABEL[planStatus(p)]}）」。预计分钟已跟着填成 ${p.min}；这条记录同时算进这条计划的「已投入」和任务的累计。改回「不关联计划条目」就不会写 planId。`;
  }

  function rebuildPlanSel() {
    const list = dayPlans();
    const keep = planSel ? planSel.value : '';
    planSel = selectEl(
      [{ value: '', label: list.length ? '不关联计划条目' : '这天没有保存的计划' },
        ...list.map((p) => ({ value: p.id, label: `${p.start} · ${p.title}（${p.min} 分钟 · ${PLAN_STATUS_LABEL[planStatus(p)]}）` }))],
      list.some((p) => p.id === keep) ? keep : '',
      { 'aria-label': '关联计划' },
    );
    planSel.addEventListener('change', syncTaskFromPlan);
    planBox.replaceChildren(planLabel, planSel, planNote);
    showPlanNote(list.find((x) => x.id === planSel.value) || null);
    err.style.display = 'none';
  }

  function syncTaskFromPlan() {
    const p = state.plans.find((x) => x.id === planSel.value);
    showPlanNote(p || null);
    if (!p) { err.style.display = 'none'; return; }
    if (p.taskId && taskSel.value !== p.taskId) {
      // 计划属于某个任务时把任务跟过去，免得补记出一条「任务累计」和「计划累计」对不上的记录
      taskSel.value = [...taskSel.options].some((o) => o.value === p.taskId) ? p.taskId : '';
    }
    if (!plannedTouched) planned.value = p.min;
    err.style.display = 'none';
  }

  rebuildPlanSel();
  when.addEventListener('change', rebuildPlanSel);

  const api = openSheet({
    title: '补记一次专注',
    content: h('div', {},
      h('p', { class: 'hint', text: '没用计时器也能补记，复盘时同样能看到预计与实际的差距。关联任务后，这条会算进任务的已投入时长；再选中当天的一条计划，它同时算进那条计划的已投入时长。什么都不选就是自由专注——程序不会替你猜关联。' }),
      h('div', { class: 'field' }, h('label', { text: '关联任务' }), taskSel),
      planBox,
      h('div', { class: 'field-row' },
        h('div', { class: 'field' }, h('label', { text: '日期' }), when),
        h('div', { class: 'field' }, h('label', { text: '预计分钟' }), planned),
        h('div', { class: 'field' }, h('label', { text: '实际分钟' }), mins),
      ),
      h('div', { class: 'field' }, h('label', { text: '备注（选填）' }), note),
      err,
    ),
    actions: [
      h('button', { class: 'btn', onclick: () => api.close(), text: '取消' }),
      h('button', {
        class: 'btn btn-primary', text: '保存',
        onclick: async () => {
          const plan = planSel.value ? state.plans.find((x) => x.id === planSel.value) : null;
          let t = state.tasks.find((x) => x.id === taskSel.value) || null;
          if (plan && plan.taskId && t && plan.taskId !== t.id) {
            err.textContent = `你选的计划属于「${plan.title}」，和任务「${t.title}」不是同一条。要么改任务，要么把计划改回「不关联计划条目」。`;
            err.style.display = '';
            return;
          }
          if (plan && !t && plan.taskId) t = state.tasks.find((x) => x.id === plan.taskId) || null;
          const row = {
            id: db.uid(), taskId: t ? t.id : null, planId: plan ? plan.id : null,
            plannedMin: Number(planned.value) || 0, actualMin: Number(mins.value) || 0,
            endedAt: `${when.value}T${pad2(new Date().getHours())}:${pad2(new Date().getMinutes())}:00`,
            note: note.value.trim(), title: t ? t.title : (plan ? plan.title : '补记的专注'),
          };
          await db.put('sessions', row);
          state.sessions.unshift(row);
          api.close();
          changed('session-save');
          const pr = t ? taskProgress(t) : null;
          toast('已补记', `预计 ${row.plannedMin} · 实际 ${row.actualMin} 分钟${plan ? `　·　计划累计 ${spentMinForPlan(plan.id)} 分钟` : ''}${pr && pr.hasEst ? `　·　任务累计 ${pr.spent} / 预计 ${pr.est} 分钟` : ''}`);
        },
      }),
    ],
  });
}

async function render(root) {
  // 后台数据事件可能触发整页重绘：覆盖层挂在 #view 里会被一起清掉，
  // 这里把滚动锁和 Esc 监听一起收掉，免得留下一把锁着页面的「无主」沉浸态。
  if (overlay && !overlay.isConnected) {
    overlay = null;
    document.documentElement.classList.remove('xj-immersive');
    if (fsKey) { document.removeEventListener('keydown', fsKey); fsKey = null; }
  }
  clear(root);
  await restoreOnce(); // 先接回刷新前的那一轮
  applySeed();         // 计划页/今日页刚带进来的关联优先于快照
  if (running) left = Math.max(0, Math.round((endAt - Date.now()) / 1000));
  const card = h('div', { class: 'card card-timer' });
  const list = h('div', { class: 'card' });

  function draw() {
    clear(card);
    const presets = h('div', { class: 'focus-presets' }, ...PRESETS.map((m) => h('button', {
      class: 'pill',
      'aria-pressed': minutes === m ? 'true' : 'false',
      onclick: () => { minutes = m; left = m * 60; running = false; finished = false; draw(); },
      text: `${m}`,
    })));
    const custom = h('input', { type: 'number', min: 5, max: 240, step: 1, value: minutes, 'aria-label': '自定义分钟', style: 'width:88px' });
    custom.addEventListener('change', () => {
      minutes = Math.min(240, Math.max(5, Number(custom.value) || 25));
      left = minutes * 60;
      running = false;
      draw();
    });
    const p = linkedPlan();
    const started = running || (!finished && left < minutes * 60);
    put(card,
      h('h3', { text: '专注' }),
      h('div', { class: 'field' }, h('label', { text: '这次做什么' }), pickTaskEl()),
      h('div', { class: 'note muted' },
        h('b', { text: '这一轮关联：' }),
        h('span', { text: linkLabel() }),
        p ? h('span', { text: `　·　这条计划已投入 ${spentMinForPlan(p.id)} 分钟` }) : null,
        taskId ? (() => { const pr = taskProgress(state.tasks.find((x) => x.id === taskId)); return pr.hasEst ? h('span', { text: `　·　任务已投入 ${pr.spent} / 预计 ${pr.est} 分钟` }) : null; })() : null,
      ),
      h('div', { class: 'focus-state', text: running ? '专注中，别被打断' : finished ? '这段时间结束了，先喝口水' : `准备专注 ${minutes} 分钟` }),
      resumeNote ? h('div', { class: 'warn-bar' },
        h('span', { text: resumeNote }),
        h('div', { class: 'btn-row', style: 'margin-top:8px' },
          finished ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => askActual({ prefill: minutes }), text: '记录这一轮' }) : null,
          h('button', { class: 'btn btn-sm', onclick: () => discardRound(), text: '不要了，清空这一轮' }),
        ),
      ) : null,
      dialEl(),
      presets,
      h('div', { class: 'btn-row', style: 'justify-content:center;margin:8px 0' },
        h('span', { style: 'font-size:var(--fs-2);color:var(--ink-dim)', text: '自定义：' }), custom, h('span', { style: 'font-size:var(--fs-2);color:var(--ink-dim)', text: '分钟' }),
      ),
      h('div', { class: 'btn-row', style: 'justify-content:center' },
        running
          ? h('button', { class: 'btn btn-primary', onclick: pause }, icon('pause'), h('span', { text: '暂停' }))
          : h('button', { class: 'btn btn-primary', onclick: start }, icon('play'), h('span', { text: left === 0 ? '再来一轮' : '开始' })),
        h('button', { class: 'btn', onclick: reset }, h('span', { text: '重置' })),
        started ? h('button', { class: 'btn', onclick: endEarly }, icon('check'), h('span', { text: '提前结束并记录' })) : null,
        h('button', { class: 'btn', onclick: () => setFullscreen(true) }, icon('expand'), h('span', { text: '全屏倒计时' })),
        h('button', { class: 'btn btn-ghost', onclick: manualLogSheet, text: '补记一次专注' }),
      ),
      h('p', { class: 'hint', text: isNativeApp()
        ? '计时用绝对时间戳：退到桌面、切到别的 App 也不会算错，但 App 被系统彻底冻结时更新会停顿，回来后自动追平。'
        : '计时用绝对时间戳：切到别的标签页也不会算错，但标签页被浏览器彻底冻结时更新会停顿，回来后自动追平。' }),
      h('p', { class: 'hint', text: '提前结束会停表并按已经跑掉的时间预填，你确认后才写入记录；时间到不会自动把这条计划标成已完成。' }),
      (finished && !resumeNote) ? h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-sm', onclick: () => askActual(), text: '记录实际用时' })) : null,
    );
    persistRound();
    drawList();
  }

  async function delSession(x) {
    const t = x.taskId ? state.tasks.find((y) => y.id === x.taskId) : null;
    const before = t ? taskProgress(t) : null;
    const ok = await confirmSheet({
      title: '删除这条专注记录',
      message: t && before && before.hasEst
        ? `删掉「${x.title || '自由专注'}」的 ${x.actualMin} 分钟，任务「${t.title}」的累计会从 ${before.spent} 变成 ${Math.max(0, before.spent - (x.actualMin || 0))} / 预计 ${before.est} 分钟，复盘同步减少。`
        : `删掉「${x.title || '自由专注'}」这条 ${x.actualMin} 分钟的记录？删掉的记录不会留在任何统计里。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    await db.del('sessions', x.id);
    state.sessions = state.sessions.filter((y) => y.id !== x.id);
    changed('session-remove');
    drawList();
  }

  function drawList() {
    clear(list);
    const todayRows = sessionsOnDate(todayStr());
    const tot = dayTotals(todayRows);
    const linkedMin = todayRows.filter((x) => x.planId).reduce((n, x) => n + (Math.max(0, Number(x.actualMin) || 0)), 0);
    put(list,
      h('h3', { text: `今天的专注记录（${todayRows.length}）` }),
      todayRows.length ? h('p', { class: 'hint', text: `预计合计 ${tot.planned} 分钟 · 实际合计 ${tot.actual} 分钟 · 差值 ${tot.diff >= 0 ? '+' : ''}${tot.diff} 分钟；其中关联到计划条目的 ${linkedMin} 分钟。任务与复盘的累计每次都从这些记录重新汇总，删掉或改一条会立刻跟着变。` }) : null,
      todayRows.length ? h('div', {}, ...todayRows.map((x) => {
        const p = x.planId ? state.plans.find((y) => y.id === x.planId) : null;
        const t = x.taskId ? state.tasks.find((y) => y.id === x.taskId) : null;
        const pr = t ? taskProgress(t) : null;
        return h('div', { class: 'row' },
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title', text: x.title || '自由专注' }),
            h('div', { class: 'row-meta' },
              h('span', { class: 'tag', text: `预计 ${x.plannedMin} 分` }),
              h('span', { class: `tag ${x.actualMin >= x.plannedMin ? 'ok' : ''}`, text: `实际 ${x.actualMin} 分` }),
              h('span', { text: fmtDateTime(x.endedAt) }),
              p ? h('span', { class: 'tag', text: `计划 ${p.date} ${p.start} · ${PLAN_STATUS_LABEL[planStatus(p)]}` })
                : h('span', { class: x.planId ? 'tag warn' : 'tag', text: x.planId ? '计划已删除（记录保留）' : '未关联计划' }),
              t ? h('span', { class: 'tag', text: pr && pr.hasEst ? `任务累计 ${pr.spent} / 预计 ${pr.est}` : `任务「${t.title}」` }) : null,
              x.note ? h('span', { text: x.note }) : null,
            ),
          ),
          h('div', { class: 'row-ops' },
            h('button', { class: 'icon-btn', title: '修改这条记录', 'aria-label': '修改这条记录', onclick: () => editSession(x) }, icon('edit')),
            h('button', { class: 'icon-btn', title: '删除这条记录', 'aria-label': '删除这条记录', onclick: () => delSession(x) }, icon('trash')),
          ),
        );
      })) : h('p', { class: 'empty', text: '还没有记录。开始一轮，或者用「补记一次专注」。' }),
      h('p', { class: 'hint', text: '预计和实际的差距会进入复盘页，用来调整下一次的步幅。没有 planId 的历史记录照旧显示，不会猜测关联。' }),
      // 桌面档右栏底部补一段口径，把「内容少留下的空白」变成可读的说明；手机不显示
      h('div', { class: 'focus-notes desk-only' },
        h('h4', { text: '这一轮怎么记' }),
        h('ul', { class: 'aside-list' },
          h('li', { text: '刷新或切走不丢正在跑的计时：回来接着走，剩多少就是多少。' }),
          h('li', { text: '到点只问你要不要记，不替你写；不足 1 分钟的轮次会停表，但不生成记录。' }),
          h('li', { text: '没有 planId 的历史记录照旧显示「未关联计划」，不会猜测关联。' }),
        ),
      ),
    );
  }

  root.append(
    h('div', { class: 'page-head' },
      h('h2', { class: 'page-title', text: '专注' }),
      h('p', { class: 'page-sub', text: '从计划或任务开始这一轮，结束后记实际用时，算不算完成由你定。刷新或切走不丢正在跑的计时；到点只问你要不要记，不替你写。' }),
    ),
    card, list,
  );
  redraw = draw;
  draw();
  updateTime();
}
export { render };
