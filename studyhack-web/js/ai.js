// AI 客户端：课表/任务/计划始终只在本机浏览器里；这里只把「本机快照 + 本轮对话」作为提示词发给服务端函数，
// 密钥不在前端代码也不在本机存储，动作必须学生确认后才写入本地数据库。
import * as db from './store.js';
import {
  state, todayStr, pendingTasks, taskProgress, spentMinForPlan, freeMinutesOn,
  planStatus, sessionDate, dayTotals, sessionsOnDate, dateOfWeek, isOverdue,
} from './state.js';
import { pendingCount, missedCount, syncDerived } from './remind.js';
import { validateSlot } from './schedule.js';
import { ymd, DOW, toMin, parseLocal, PRIO_LABEL, fmtDateTime, WEEK_MAX } from './ui.js';
import { changed } from './forms.js';
import { isNativeApp } from './native.js';

export const AGENTS = {
  work: { name: '规划小助', role: '学习与工作规划 AI', key: db.CHAT_IDS.work, canWrite: true },
  mentor: { name: '心事树洞', role: '学习心态教练 AI', key: db.CHAT_IDS.mentor, canWrite: false },
};
const PEER = { work: 'mentor', mentor: 'work' };
// 只有规划助手能落库；教练那边即使拿到动作也一律拒绝。
const WRITERS = new Set(['work']);

const HISTORY_LIMIT = 200;      // 本机保存的对话条数上限
const SEND_HISTORY = 24;        // 每轮发给模型的历史条数
const SEND_PEER = 10;           // 每轮带入的另一个空间条数
const BASE_KEY = 'xj-ai-base';
const DEVICE_KEY = 'xj-device-id';

const ERRORS = {
  no_backend: '这个打开方式连不到服务端：file:// 打开的页面没有同源函数地址。用 http://localhost:8765 这类地址打开，或在下面填「AI 接口地址」。',
  offline: '连不上 AI 服务。可能是页面还没部署到带函数的地址、网络不通，或服务端函数没启用。你的本机数据没受影响。',
  service_not_configured: 'AI 服务还没配密钥：需要作品所有者在 Sites 设置里填写 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL。填好之前，两位助手不会假装回答。',
  model_unavailable: '大模型没有正常响应（网络、额度或上游服务问题）。本机数据没受影响，稍后重试。',
  model_bad_output: 'AI 没有返回可用的回复。输入已保留，可以原样重试或换个说法。',
  rate_limited: '这台设备 5 分钟内问得有点多，服务端做了额度保护。',
  sites_gateway_origin_forbidden: '这个页面不是从站点自身地址打开的，平台网关拦掉了请求。请通过作品地址访问，别用 file:// 或第三方内嵌页面。',
  model_rate_limited: '模型服务暂时繁忙或额度受限。请稍后重试。',
  rate_limited_by_gateway: '平台网关判定这一分钟内请求过多，先稍一稍再问。',
  payload_too_large: '本机快照超出请求上限，这次没发出去。可以先清理一些历史对话。',
  invalid_input: '这条请求没被服务端接受（内容过长或格式不对）。',
  no_route: '这个地址上没有 AI 接口：只有静态页面在跑（8765 这类端口不带函数）。要么从站点自身地址打开已发布的页面，要么在设置里把「AI 接口地址」填成本地函数地址，例如 http://127.0.0.1:8000/functions/v1/app。',
  forbidden: 'AI 服务拒绝了这次请求（403）。请从作品链接在普通浏览器里打开后再试。',
  // 服务端分出来的那几档，前端没有对应文案就会退回「连不上 AI 服务」，把可诊断的信息抹平了
  model_timeout: '这一条模型想得太久（服务端等了 60 秒收掉）。本机数据没受影响，再问一次，或者把问题拆短一点。',
  client_timeout: '这条请求等了一分半还没回来，页面先不等了。本机数据没受影响，可以再问一次。',
  internal_error: '服务端内部出了错，不是你这边的问题。稍后再试；一直这样的话要看函数日志才能定位。',
  retired: '这条接口已经停用了（旧版云端数据接口，现在数据只在本机）。AI 对话走 /api/ai/chat，不受影响。',
};
export const errorMessage = (code) => ERRORS[code] || ERRORS.offline;

// App（Capacitor 壳）里连不上站点函数：平台网关只放行站点自身页面的来源，
// 实测以 https://localhost 身份 POST 会直接 403 sites_gateway_origin_forbidden。
// 这不是本机数据出了问题，也不是代码没写完，是平台侧的来源策略，所以单独给一句实话。
export function offlineMessage() {
  if (isNativeApp()) {
    return 'App 里连不到 AI：平台的来源校验只放行站点自身的页面，App 的 WebView 身份（https://localhost）会被网关直接拒绝（实测 403 sites_gateway_origin_forbidden）。两位助手请到网页版使用；你 App 里的本机数据不受影响，也不会因此丢掉。';
  }
  return ERRORS.offline;
}

export function aiBase() {
  const custom = String(localStorage.getItem(BASE_KEY) || '').trim();
  if (custom) return custom.replace(/\/+$/, '');
  // file:// 下 location.origin 是 "null"，没有同源后端可用
  if (location.protocol === 'file:') return null;
  // App 的 WebView 里同源地址是 https://localhost，那个地址上没有函数：
  // 静态托管会把未知路径回退成 index.html，探一次只会拿到一个假的「在线」。
  if (isNativeApp()) return null;
  return '/functions/v1/app';
}
export function setAiBase(url) {
  if (!url) localStorage.removeItem(BASE_KEY); else localStorage.setItem(BASE_KEY, String(url).trim());
}

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id || !/^.{8,64}$/.test(id)) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `xj-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

async function request(path, options = {}) {
  const base = aiBase();
  if (!base) {
    const e = new Error(isNativeApp() ? offlineMessage() : ERRORS.no_backend);
    e.code = 'no_backend';
    throw e;
  }
  let res;
  // 服务端 60 秒会自己收掉这一条；这里再多等 15 秒，挡的是「服务端没机会说话」那种挂死：
  // 上游慢慢滴响应体时浏览器这边可以无限等，标签页一直转圈也不报错。
  const timeout = AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(75000) : undefined;
  // 页面上的「停止」传进来的是自己的 controller；和上面的超时合并，谁先到都算数
  const signal = options.signal
    ? (timeout && AbortSignal.any ? AbortSignal.any([options.signal, timeout]) : options.signal)
    : timeout;
  try {
    res = await fetch(base + path, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-xj-device': deviceId(),
        ...(options.headers || {}),
      },
      body: options.body,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (options.signal && options.signal.aborted) {
      const e = new Error('已停止，这条消息已停止等待回复。');
      e.code = 'aborted'; e.cause = err; throw e;
    }
    const timedOut = Boolean(signal) && err && err.name === 'TimeoutError';
    const e = new Error(timedOut ? errorMessage('client_timeout') : offlineMessage());
    e.code = timedOut ? 'client_timeout' : 'offline'; e.cause = err; throw e;
  }
  let data;
  try {
    data = await res.json();
  } catch {
    // 200 但拿不出 JSON：这是静态托管把未知路径回退成了 index.html，不是函数应答
    if (res.ok) { const e = new Error(errorMessage('no_route')); e.code = 'no_route'; e.status = res.status; throw e; }
    data = {};
  }
  if (!res.ok) {
    // 网关报错用 code 字段（拦来源、限流），我们的函数用 error；静态服务器只会给一个
    // 没有错误体的 404，这时候按状态码说清楚是「这个地址上没有函数」，别混成「格式不对」。
    const reported = [data?.error, data?.code].find((value) =>
      typeof value === 'string' && Object.hasOwn(ERRORS, value));
    const code = reported || (res.status === 404 ? 'no_route' : res.status === 403 ? 'forbidden'
      : res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'model_unavailable' : 'invalid_input');
    const e = new Error(errorMessage(code)); e.code = code; e.status = res.status;
    // 服务端额度保护会告知还要等多久（retry_after 或 Retry-After 头）；拿到了就说准数，
    // 拿不到（旧版函数、被网关改写）才退回「再等一会儿」，不编一个时间出来。
    if (code === 'rate_limited') {
      const ra = Number(data?.retry_after) || Number(res.headers && res.headers.get('retry-after')) || 0;
      e.retryAfter = ra;
      e.message += ra > 0
        ? `还要等大约${ra >= 90 ? ` ${Math.ceil(ra / 60)} 分钟` : ` ${ra} 秒`}。`
        : '再等一会儿。';
    }
    throw e;
  }
  return data;
}

// ---------- 本机快照（发出去的内容完全可在这里查） ----------
/** 共享开关：只有显式 true 才算共享，缺省按最保守的「不共享」处理 */
export function privacyOf() {
  const p = (state.settings && state.settings.privacy) || {};
  return {
    courses: p.courses === true,
    tasks: p.tasks === true,
    focus: p.focus === true,
    peer: p.peer === true,
  };
}

export function snapshot() {
  const s = state.settings;
  const today = todayStr();
  const pv = privacyOf();
  const tasks = pv.tasks ? pendingTasks().slice(0, 40).map((t) => {
    const pr = taskProgress(t);
    return {
      title: t.title, subject: t.subject || '', dueAt: t.dueAt || '', status: t.status,
      estMin: pr.est, spentMin: pr.spent, priority: t.priority || 'medium', note: t.note || '',
      selfRating: t.selfRating || null,
    };
  }) : [];
  const plans = pv.tasks
    ? state.plans
      .filter((p) => p.date >= today && p.date <= dateOfWeek(ymd(new Date()), 6))
      .slice(0, 40)
      .map((p) => ({
        date: p.date, start: p.start, min: Number(p.min) || 0, title: p.title,
        status: planStatus(p), spentMin: spentMinForPlan(p.id),
      }))
    : [];
  const focus = [];
  if (pv.focus) {
    for (let i = 6; i >= 0; i -= 1) {
      const d = dateOfWeek(ymd(new Date()), -i);
      const rows = sessionsOnDate(d);
      if (!rows.length) continue;
      const t = dayTotals(rows);
      focus.push({ date: d, count: t.count, plannedMin: t.planned, actualMin: t.actual });
    }
  }
  const overdue = pv.tasks ? pendingTasks().filter(isOverdue).map((x) => x.title).slice(0, 10) : [];
  // 目标随任务这一档共享：set_stages 的 goal_id 只能从这里取，没共享就没有 id 可用
  const goals = pv.tasks
    ? state.goals.filter((g) => g.status !== 'archived').slice(0, 5).map((g) => ({
      id: g.id, title: g.title,
      stages: (Array.isArray(g.stages) ? g.stages : []).map((s) => s.title).slice(0, 8),
    }))
    : [];
  let pending = 0, missed = 0;
  try { pending = pendingCount(); missed = missedCount(); } catch (err) { /* 提醒模块不可用就不带这两个数 */ }
  return {
    today,
    todayName: DOW[((new Date(`${today}T12:00:00`).getDay() + 6) % 7)],
    privacy: pv,
    courses: pv.courses ? state.courses.map((c) => ({
      name: c.name, day: c.day, start: c.start, end: c.end,
      location: c.location || '', teacher: c.teacher || '',
      weeks: c.weekStart && c.weekEnd ? `${c.weekStart}-${c.weekEnd}` : '',
    })).slice(0, 60) : [],
    tasks,
    goals,
    plans,
    focus,
    freeTodayMin: pv.tasks ? freeMinutesOn(today) : 0,
    dailyCapMin: Number(s.dailyCapMin) || 240,
    lunch: s.lunchStart && s.lunchEnd ? `${s.lunchStart}-${s.lunchEnd}` : '',
    dinner: s.dinnerStart && s.dinnerEnd ? `${s.dinnerStart}-${s.dinnerEnd}` : '',
    reminders: { pending, missed },
    counts: {
      courses: state.courses.length, tasks: state.tasks.length,
      plans: state.plans.length, sessions: state.sessions.length,
    },
    overdue,
  };
}

export async function probe() {
  try {
    const data = await request('/api/ai/status');
    return { ok: true, base: aiBase(), ...data };
  } catch (err) {
    return { ok: false, code: err.code || 'offline', base: aiBase(), message: err.message };
  }
}

// ---------- 会话（存本机 meta 仓，不升数据库版本） ----------
export async function historyOf(agent) {
  const rows = await db.metaGet(AGENTS[agent].key);
  return Array.isArray(rows) ? rows : [];
}
async function saveHistory(agent, rows) {
  await db.metaSet(AGENTS[agent].key, rows.slice(-HISTORY_LIMIT));
}
/** 往某助手的历史里追加一条（如「已把某一步安排进计划」的回显），只落本机、不调模型 */
export async function appendHistory(agent, role, content) {
  const rows = await historyOf(agent);
  rows.push({ id: db.uid(), role, content: String(content || ''), at: new Date().toISOString() });
  await saveHistory(agent, rows);
}
export async function clearHistory(agent) {
  await db.metaSet(AGENTS[agent].key, null);
}

export async function send(agent, text, { signal } = {}) {
  const message = String(text || '').trim();
  if (!message) throw new Error('先写点什么再发。');
  const pv = privacyOf();
  const [mine, theirs] = pv.peer
    ? await Promise.all([historyOf(agent), historyOf(PEER[agent])])
    : [await historyOf(agent), []];
  const data = await request('/api/ai/chat', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      agent,
      message: message.slice(0, 4000),
      privacy: pv,
      history: mine.slice(-SEND_HISTORY).map((m) => ({ role: m.role, content: m.content })),
      peer: theirs.slice(-SEND_PEER).map((m) => ({ role: m.role, content: m.content })),
      context: snapshot(),
    }),
  });
  // 教练没有写入权：服务端已经丢掉了，这里再挡一次，别让 UI 出现「确认写入」。
  if (signal?.aborted) {
    const e = new Error('已停止等待回复。');
    e.code = 'aborted';
    throw e;
  }
  const actions = agent === 'work' && Array.isArray(data?.actions) ? data.actions : [];
  const reply = typeof data?.reply === 'string' ? data.reply.trim() : '';
  if (!reply && !actions.length) {
    const e = new Error(errorMessage('model_bad_output'));
    e.code = 'model_bad_output';
    throw e;
  }
  const at = new Date().toISOString();
  const rows = [
    ...mine,
    { id: db.uid(), role: 'user', content: message, at },
    {
      id: db.uid(), role: 'assistant', content: reply || '我整理了几条待确认的建议，请逐条核对。',
      at: new Date().toISOString(), actions, applied: false, safety: data.safety || null,
    },
  ];
  await saveHistory(agent, rows);
  return { reply: rows[rows.length - 1], actions, safety: data.safety || null };
}

// ---------- 动作：先归一化 + 校验，学生确认后才写本机库 ----------
const HHMM = /^(\d{1,2}):(\d{2})$/;
const clean = (v, max) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

export function normalizeAction(a) {
  const type = a && typeof a === 'object' ? String(a.type || '') : '';
  const base = { type, ok: false, error: '', label: '', detail: '', data: null, raw: a || {} };
  if (type === 'add_course') {
    const name = clean(a.name, 60);
    const day = Number(a.day);
    const start = clean(a.start, 5);
    const end = clean(a.end, 5);
    const hm = (x) => {
      const m = HHMM.exec(x);
      if (!m) return null;
      const h = Number(m[1]); const mi = Number(m[2]);
      return h <= 23 && mi <= 59 ? `${String(h).padStart(2, '0')}:${m[2]}` : null;
    };
    const s = hm(start); const e = hm(end);
    base.label = '录入一门课';
    // 周次：模型没说就按第 1–16 周、每周上，但说什么都要在确认条里写出来——
    // 之前这里直接写死 1–16，用户看到「录入一门课 周三 08:00-09:40」以为就是全部信息，
    // 其实单双周和只上到第 12 周这类细节被静悄悄补成了默认值。
    const hasWeek = a.week_start !== undefined || a.weekStart !== undefined || a.week_end !== undefined || a.weekEnd !== undefined;
    const wsRaw = Number(a.week_start ?? a.weekStart);
    const weRaw = Number(a.week_end ?? a.weekEnd);
    const ws = hasWeek && Number.isFinite(wsRaw) ? wsRaw : 1;
    const we = hasWeek && Number.isFinite(weRaw) ? weRaw : 16;
    const PARITY = { all: '每周', odd: '单周', even: '双周' };
    const parity = PARITY[a.parity] ? a.parity : 'all';
    if (a.parity !== undefined && !PARITY[a.parity]) { base.error = `单双周只认 all / odd / even（收到 ${a.parity}）。`; return base; }
    if (!Number.isInteger(ws) || ws < 1 || ws > WEEK_MAX) { base.error = `起始周要在 1–${WEEK_MAX}（收到 ${a.week_start ?? a.weekStart ?? '空'}）。`; return base; }
    if (!Number.isInteger(we) || we < 1 || we > WEEK_MAX) { base.error = `结束周要在 1–${WEEK_MAX}（收到 ${a.week_end ?? a.weekEnd ?? '空'}）。`; return base; }
    if (ws > we) { base.error = `起始周（第 ${ws} 周）晚于结束周（第 ${we} 周）。`; return base; }
    const weekText = `第 ${ws}–${we} 周 · ${PARITY[parity]}`;
    base.detail = `${name || '（没写课名）'} ${Number.isInteger(day) && day >= 1 && day <= 7 ? DOW[day - 1] : `周${day}`} ${start}-${end}${clean(a.location, 40) ? ` @${clean(a.location, 40)}` : ''}${clean(a.teacher, 30) ? `（${clean(a.teacher, 30)}）` : ''} · ${weekText}${hasWeek || a.parity !== undefined ? '' : '（周次按默认 1–16 周补的）'}`;
    if (!name) base.error = '没写课程名。';
    else if (!Number.isInteger(day) || day < 1 || day > 7) base.error = `星期不在 1–7（收到 ${a.day}）。`;
    else if (!s || !e) base.error = '时间不是 HH:MM 格式。';
    else if (toMin(e) <= toMin(s)) base.error = '结束时间不晚于开始时间。';
    else {
      const clash = state.courses.filter((x) => x.day === day).filter((x) => toMin(x.start) < toMin(e) && toMin(x.end) > toMin(s));
      if (clash.length) base.error = `和「${clash.map((x) => `${x.name} ${x.start}-${x.end}`).join('、')}」重叠。`;
      else base.ok = true;
    }
    base.data = { name, day, start: s, end: e, location: clean(a.location, 40), teacher: clean(a.teacher, 30), weekStart: ws, weekEnd: we, parity };
    return base;
  }
  if (type === 'delete_course') {
    const id = clean(a.id, 40);
    const found = state.courses.find((x) => x.id === id);
    base.label = '删除一门课';
    base.detail = found ? `${found.name} ${DOW[(found.day || 1) - 1]} ${found.start}-${found.end}` : `（本机课表里找不到 id=${id}）`;
    if (!found) base.error = '本机课表里没有这个 id，可能是模型记错了。';
    else { base.ok = true; base.data = { id, name: found.name }; }
    return base;
  }
  if (type === 'add_task') {
    const title = clean(a.title, 80);
    const subject = clean(a.subject, 30);
    const dueRaw = clean(a.due_at || a.dueAt, 20);
    const est = Number(a.estMin);
    const priority = ['high', 'medium', 'low'].includes(a.priority) ? a.priority : 'medium';
    const note = clean(a.note, 60);
    let dueAt = '';
    if (dueRaw) {
      const norm = dueRaw.replace(' ', 'T').slice(0, 16);
      dueAt = parseLocal(norm) === null ? '' : norm;
    }
    base.label = '新建一条任务';
    base.detail = `${title || '（没写要做什么）'}${subject ? `（${subject}）` : ''}${dueAt ? ` 截止 ${dueAt.replace('T', ' ')}` : dueRaw ? ` 截止时间无法识别（${dueRaw}）` : ' 不设截止时间'}｜预计 ${Number.isFinite(est) && est >= 5 && est <= 600 ? Math.round(est) : 30} 分钟｜${PRIO_LABEL[priority]}`;
    if (!title) base.error = '没写任务内容。';
    else if (dueRaw && !dueAt) base.error = `截止时间没法识别：${dueRaw}`;
    else base.ok = true;
    base.data = { title, subject, dueAt, estMin: Number.isFinite(est) && est >= 5 && est <= 600 ? Math.round(est) : 30, priority, note };
    return base;
  }
  if (type === 'add_plan') {
    const title = clean(a.title, 80);
    const date = clean(a.date, 10);
    const start = clean(a.start, 5);
    const min = Number(a.min ?? a.duration_min);
    const taskId = clean(a.task_id || a.taskId, 40);
    base.label = '安排一段学习时间';
    base.detail = `${title || '（没写做什么）'} ${date} ${start} · ${Number.isFinite(min) ? Math.round(min) : '?'} 分钟${taskId ? `（关联任务 ${taskId}）` : ''}`;
    const task = taskId ? state.tasks.find((x) => x.id === taskId) : null;
    if (!title) base.error = '没写这段安排是做什么的。';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) base.error = `日期不是 YYYY-MM-DD（收到 ${a.date || '空'}）。`;
    else if (!HHMM.test(start)) base.error = `开始时间不是 HH:MM（收到 ${a.start || '空'}）。`;
    else if (!Number.isFinite(min) || min < 5 || min > 480) base.error = `时长要在 5-480 分钟（收到 ${a.min ?? '空'}）。`;
    else if (taskId && !task) base.error = `关联任务 id=${taskId} 在本机找不到，不猜它想连哪条。`;
    else {
      // 时间安排必须由程序查冲突（课程 / 午休 / 晚餐 / 已有计划 / 已经过去的时间），有冲突就禁止保存。
      // 关联任务的截止时间也一起交给校验：新建时还没有计划行，不传就查不到。
      const errs = validateSlot({ date, start, min, dueAt: task?.dueAt || null });
      if (errs.length) base.error = `冲突或无效：${errs.join('；')}`;
      else { base.ok = true; base.detail = `${title}${task ? `（${task.title}）` : ''} ${date} ${start} 起 ${Math.round(min)} 分钟`; }
    }
    base.data = { title, date, start, min: Math.round(min), taskId: task ? task.id : null, dueAt: task?.dueAt || null };
    return base;
  }
  if (type === 'set_stages') {
    const goalId = clean(a.goal_id || a.goalId, 40);
    const goal = state.goals.find((g) => g.id === goalId);
    const raw = Array.isArray(a.stages) ? a.stages : [];
    const titles = raw.map((s) => clean(s && typeof s === 'object' ? s.title : s, 40));
    base.label = '换一份目标路线草案';
    const orphanCount = goal ? state.tasks.filter((t) => t.goalId === goal.id && t.stageId).length : 0;
    base.detail = goal
      ? `「${goal.title}」→ ${titles.length} 段：${titles.join(' → ')}。只换路线，不创建任务${orphanCount ? `；原来挂在段上的 ${orphanCount} 条任务会回到「未分段」（任务不删）` : ''}。`
      : `（本机目标里找不到 id=${goalId}）`;
    if (!goal) base.error = '本机目标里没有这个 id，不猜它想改哪个目标。';
    else if (raw.length < 2 || raw.length > 8) base.error = `阶段数要在 2–8（收到 ${raw.length}）。`;
    else if (titles.some((t) => !t)) base.error = '有阶段没写名字。';
    else base.ok = true;
    base.data = { goalId, titles };
    return base;
  }
  base.label = `不认识的动作（${type || '无类型'}）`;
  base.detail = '会被忽略，不会写入任何数据。';
  base.error = '模型给出了这个版本不支持的动作。';
  return base;
}

async function writeCourse(d) {
  const obj = {
    id: db.uid(), name: d.name, day: d.day, start: d.start, end: d.end,
    location: d.location, teacher: d.teacher,
    weekStart: d.weekStart || 1, weekEnd: Math.min(d.weekEnd || 16, WEEK_MAX), parity: d.parity || 'all',
    createdAt: new Date().toISOString(),
  };
  await db.put('courses', obj);
  state.courses = [...state.courses, obj].sort((a, b) => a.day - b.day || toMin(a.start) - toMin(b.start));
  return `${obj.name} ${DOW[obj.day - 1]} ${obj.start}-${obj.end} · 第 ${obj.weekStart}–${obj.weekEnd} 周`;
}
async function removeCourse(d) {
  await db.del('courses', d.id);
  state.courses = state.courses.filter((x) => x.id !== d.id);
  return d.name;
}
async function writeTask(d) {
  const obj = {
    id: db.uid(), title: d.title, subject: d.subject, dueAt: d.dueAt, estMin: d.estMin,
    priority: d.priority, note: d.note, status: 'pending', doneAt: null, createdAt: new Date().toISOString(),
  };
  await db.put('tasks', obj);
  state.tasks = [...state.tasks, obj].sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  return obj.title;
}
async function writePlan(d) {
  const obj = {
    id: db.uid(), taskId: d.taskId || null, title: d.title, date: d.date, start: d.start,
    min: d.min, status: 'scheduled', statusAt: null, batch: null, source: 'ai',
    createdAt: new Date().toISOString(),
  };
  await db.put('plans', obj);
  state.plans = [...state.plans, obj];
  return `${obj.date} ${obj.start} · ${obj.min} 分钟 · ${obj.title}`;
}
/** 路线草案整段落库：段 id 全部新生成，旧段上的任务一律回到未分段——不猜旧任务挂哪段。
 *  解挂失败不抛错：指向已删段的 stageId 页面本来就按「未分段」读，如实报数即可。 */
async function writeStages(d) {
  const goal = state.goals.find((g) => g.id === d.goalId);
  if (!goal) throw new Error('这个目标刚刚被删了，路线没有写入。');
  const stages = d.titles.map((title) => ({ id: db.uid(), title, note: '' }));
  const orphans = state.tasks.filter((t) => t.goalId === goal.id && t.stageId);
  await db.put('goals', { ...goal, stages });
  const gi = state.goals.findIndex((g) => g.id === goal.id);
  if (gi >= 0) state.goals[gi] = { ...goal, stages };
  let failed = 0;
  for (const t of orphans) {
    try {
      await db.put('tasks', { ...t, stageId: null });
      const i = state.tasks.findIndex((x) => x.id === t.id);
      if (i >= 0) state.tasks[i] = { ...state.tasks[i], stageId: null };
    } catch (err) { failed += 1; }
  }
  return `「${goal.title}」换成 ${stages.length} 段${orphans.length ? `，${orphans.length} 条任务回到未分段` : ''}${failed ? `；${failed} 条旧段标记没清掉（页面按未分段显示）` : ''}`;
}

/** 应用一组已确认的动作；只写校验通过的，其余原样报告失败原因。
 *  results 与传进来的 list 一一对应：页面要按条记住「已写入 / 失败 / 未勾选」，
 *  只知道 applied 的数量就会把「没勾选」和「没过校验」糊成同一件事。 */
export async function runActions(list, agent = 'work') {
  const applied = [];
  const failed = [];
  const results = [];
  if (!WRITERS.has(agent)) return { applied, failed: ['这个助手没有写入本机数据的权限。'], results };
  const tent = [];   // 同一批里已落地的时间块，防止两条安排互相撞车
  for (const raw of list) {
    const a = normalizeAction(raw);
    if (!a.ok) {
      const why = a.error || a.label;
      failed.push(why);
      results.push({ ok: false, label: a.label, error: why });
      continue;
    }
    try {
      let text = '';
      if (a.type === 'add_plan') {
        const errs = validateSlot({ date: a.data.date, start: a.data.start, min: a.data.min, extra: tent, dueAt: a.data.dueAt || null });
        if (errs.length) {
          const why = `安排冲突：${errs[0]}`;
          failed.push(why);
          results.push({ ok: false, label: a.label, error: why });
          continue;
        }
        text = await writePlan(a.data);
        const st = toMin(a.data.start);
        tent.push({ date: a.data.date, start: st, end: st + a.data.min, title: a.data.title });
      } else if (a.type === 'add_course') text = await writeCourse(a.data);
      else if (a.type === 'delete_course') text = await removeCourse(a.data);
      else if (a.type === 'set_stages') text = await writeStages(a.data);
      else text = await writeTask(a.data);
      applied.push(`${a.label}：${text}`);
      results.push({ ok: true, label: a.label, text });
    } catch (err) {
      const why = `${a.label} 写入失败：${err.message || err}`;
      failed.push(why);
      results.push({ ok: false, label: a.label, error: err.message || String(err) });
    }
  }
  if (applied.length) {
    try { await syncDerived(); } catch (err) { console.warn('生成提醒失败', err); }
    changed('ai-actions');
  }
  return { applied, failed, results };
}

/** 「让它直接写」这一试只做校验，一行都不写库。
 *  拦下时打出本机排程器当场算出来的理由（撞哪门课、落在午休、已经过了截止时间），
 *  过得去时也只回报「校验现在过得去，写入仍要你勾上」——提案权的边界有两道，
 *  程序拦冲突是第二道，你勾选才是第一道，演示要把两道都演到。
 *  它必须走和 runActions 同一套校验，否则演给评委看的就不是真的那条闸门。 */
export function probeWrite(raw, agent = 'work') {
  if (!WRITERS.has(agent)) return { blocked: true, reason: '这个助手没有写入本机数据的权限。', gate: 'role' };
  const a = normalizeAction(raw);
  if (!a.ok) return { blocked: true, reason: a.error || a.label, gate: 'validate' };
  if (a.type === 'add_plan') {
    const errs = validateSlot({ date: a.data.date, start: a.data.start, min: a.data.min, dueAt: a.data.dueAt || null });
    if (errs.length) return { blocked: true, reason: `安排冲突：${errs[0]}`, gate: 'slot' };
  }
  return { blocked: false, gate: 'confirm', label: a.label, detail: a.detail };
}

/** 把某条助手消息标成已写入，并逐条记下结果：建议数 ≠ 写入数时不能吹成全部落库，
 *  「你取消勾选的」和「本机校验没过的」也要分开留痕，否则剩下的条目没法再选。 */
export async function markApplied(agent, messageId, appliedCount, statuses = null) {
  const rows = await historyOf(agent);
  const idx = rows.findIndex((m) => m.id === messageId);
  if (idx < 0) return;
  const patch = { applied: true, appliedCount };
  if (Array.isArray(statuses)) patch.actionStatuses = statuses;
  rows[idx] = { ...rows[idx], ...patch };
  await saveHistory(agent, rows);
}

export function whenLabel(at) {
  try { return fmtDateTime(at); } catch (err) { return String(at || ''); }
}
