// 内存缓存 + 派生查询：页面统一从这里取数据，写入后调用 refreshData()
import * as db from './store.js';
import { ymd, mondayOf, dowIndex, toMin, toHM, inWeekRange, weekNumberOf, parseLocal } from './ui.js';

export const state = {
  courses: [], tasks: [], plans: [], sessions: [], reviews: [], reminders: [], goals: [],
  settings: db.DEFAULT_SETTINGS,
  week: null,          // 当前查看的周（周一日期字符串）
  curWeek: null,       // 今天所在的周
  page: 'today',
};

export async function refreshData() {
  const [courses, tasks, plans, sessions, reviews, reminders, goals] = await Promise.all([
    db.list('courses'), db.list('tasks'), db.list('plans'),
    db.list('sessions'), db.list('reviews'), db.list('reminders'), db.list('goals'),
  ]);
  state.courses = courses.sort((a, b) => a.day - b.day || toMin(a.start) - toMin(b.start));
  state.tasks = tasks.sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  state.plans = plans.sort((a, b) => String(a.date).localeCompare(String(b.date)) || toMin(a.start) - toMin(b.start));
  state.sessions = sessions.sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
  state.reviews = reviews.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  state.reminders = reminders;
  state.goals = goals.sort((a, b) => String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')));
  state.settings = db.settings();
  return state;
}

export function initWeek() {
  state.curWeek = ymd(mondayOf());
  if (state.week === null) state.week = state.curWeek;
}

export const todayStr = () => ymd(new Date());
export const isToday = (d) => d === todayStr();

/** 某周周一 + i 天的日期字符串 */
export function dateOfWeek(mondayStr, i) {
  const d = new Date(`${mondayStr}T12:00:00`);
  d.setDate(d.getDate() + i);
  return ymd(d);
}
export function weekDates(mondayStr) {
  return Array.from({ length: 7 }, (_, i) => dateOfWeek(mondayStr, i));
}
export function shiftWeek(mondayStr, delta) {
  const d = new Date(`${mondayStr}T12:00:00`);
  d.setDate(d.getDate() + delta * 7);
  return ymd(d);
}

/** 该课程在这一天是否真的要上 */
export function courseOn(course, dateStr) {
  if (Number(course.day) !== dowIndex(new Date(`${dateStr}T12:00:00`))) return false;
  const week = weekNumberOf(dateStr, state.settings.termStart);
  return inWeekRange(course, week);
}

export function coursesOn(dateStr) {
  return state.courses.filter((c) => courseOn(c, dateStr))
    .sort((a, b) => toMin(a.start) - toMin(b.start));
}

export function tasksOn(dateStr) {
  return effectiveTasks(state.tasks).filter((t) => t.dueAt && t.dueAt.slice(0, 10) === dateStr);
}
export const pendingTasks = () => effectiveTasks(state.tasks).filter((t) => t.status !== 'done');
export const doneTasks = () => effectiveTasks(state.tasks).filter((t) => t.status === 'done');
export function taskById(id) { return state.tasks.find((t) => t.id === id) || null; }

// ---------- 拆分任务的父子关系（从 splitFrom 现推，不改库、不猜关联） ----------
// 「任务太大」拆出的段叫 chunk：原任务的剩余量被这些段取代，计数时原任务不再单独算。
// 「不会做」拆出的 15 分钟小开头叫 starter：原任务仍是真实工作量，计数照常，只多出这一小步。
function childSplitKind(t) {
  if (!t || !t.splitFrom) return null;
  if (t.splitKind === 'chunk' || t.splitKind === 'starter') return t.splitKind;
  // 旧数据（A20）没有 splitKind：按已记录字段识别——单个 15 分钟随缘子任务是「小开头」，其余按「拆段」读。
  const siblings = state.tasks.filter((x) => x.splitFrom === t.splitFrom && x.id !== t.id);
  if (siblings.length === 0 && Number(t.estMin) === 15 && t.priority === 'low') return 'starter';
  return 'chunk';
}

/** 仍有现存「拆段」子任务指向它们的原任务 id 集合：这些原任务的预计/完成数由子任务代管 */
export function splitParentIds() {
  const living = new Set(state.tasks.map((x) => x.id));
  const parents = new Set();
  for (const t of state.tasks) {
    if (!t.splitFrom || !living.has(t.splitFrom)) continue;
    if (childSplitKind(t) === 'chunk') parents.add(t.splitFrom);
  }
  return parents;
}

/** 有效任务：排除「仍有现存拆段子任务」的原任务。计数（预计/剩余/完成/逾期/待做）只用有效任务；
 *  删光全部子任务后原任务自动恢复成普通任务，不重写任何一行。 */
export function effectiveTasks(rows = state.tasks) {
  const parents = splitParentIds();
  return rows.filter((t) => !parents.has(t.id));
}

/** 某条任务现存的所有拆段子任务（chunk），按截止时间排序 */
export function splitChildrenOf(taskId) {
  return state.tasks
    .filter((t) => t.splitFrom === taskId && childSplitKind(t) === 'chunk')
    .sort((a, b) => String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')));
}
export function courseById(id) { return state.courses.find((c) => c.id === id) || null; }
export function plansOn(dateStr) { return state.plans.filter((p) => p.date === dateStr); }

/** 计划条目状态。老数据没有 status 字段，一律当「计划中」，不猜测、不改写 */
export function planStatus(p) {
  return p && (p.status === 'done' || p.status === 'skipped') ? p.status : 'scheduled';
}

/** 专注记录归属的本地日期：endedAt 可能是 UTC ISO，也可能是不带时区的本地串 */
export function sessionDate(s) {
  const d = new Date(String(s?.endedAt || ''));
  return isNaN(d.getTime()) ? '' : ymd(d);
}

export function sessionsOnDate(dateStr) {
  return state.sessions.filter((x) => sessionDate(x) === dateStr);
}

/** 按任务累计的有效专注分钟。每次重新汇总，所以删改记录后不会重复累计 */
export function spentMinOn(taskId) {
  if (!taskId) return 0;
  return state.sessions.reduce((n, x) => n + (x.taskId === taskId ? Math.max(0, Number(x.actualMin) || 0) : 0), 0);
}

/** 按计划条目累计的实际分钟；planId 是后加的字段，旧记录没有就不计入 */
export function spentMinForPlan(planId) {
  if (!planId) return 0;
  return state.sessions.reduce((n, x) => n + (x.planId === planId ? Math.max(0, Number(x.actualMin) || 0) : 0), 0);
}

/** 任务投入进度：remaining 永不为负；没填预计时长时 hasEst 为 false、remaining 为 null */
export function taskProgress(t) {
  const est = Math.max(0, Math.round(Number(t?.estMin) || 0));
  const spent = spentMinOn(t?.id);
  return {
    est,
    spent,
    hasEst: est > 0,
    remaining: est > 0 ? Math.max(0, est - spent) : null,
    over: est > 0 && spent > est,
    pct: est > 0 ? Math.min(100, Math.round((spent / est) * 100)) : 0,
  };
}

// ---------- 目标：进度只从既有事实汇总，界面里没有「填一个百分比」这种入口 ----------
export function goalById(id) { return state.goals.find((g) => g.id === id) || null; }
export function tasksForGoal(goalId) { return state.tasks.filter((t) => t.goalId === goalId); }
export const activeGoals = () => state.goals.filter((g) => g.status === 'active' || !g.status);

/** 这段专注记到哪个目标头上：先认任务，任务没关联时认它挂的计划所对应的任务。
 *  关联不上就是关联不上——不猜，也不按标题文字去凑。 */
export function sessionGoalId(s) {
  if (!s) return null;
  const direct = s.taskId ? taskById(s.taskId) : null;
  if (direct?.goalId) return direct.goalId;
  const plan = s.planId ? state.plans.find((p) => p.id === s.planId) : null;
  const viaPlan = plan?.taskId ? taskById(plan.taskId) : null;
  return viaPlan?.goalId || null;
}

/** 目标汇总：est 取目标自己填的预计总时长，没填就用它下面任务的预计合计；
 *  spent 是归属到这个目标的全部实际专注分钟。两个数都能逐条追到记录，不是估出来的。 */
export function goalProgress(goal) {
  const tasks = effectiveTasks(tasksForGoal(goal?.id));
  const taskEst = tasks.reduce((n, t) => n + Math.max(0, Number(t.estMin) || 0), 0);
  const ownEst = Math.max(0, Math.round(Number(goal?.estMin) || 0));
  const est = ownEst || taskEst;
  let spent = 0;
  let spentFromTask = 0;
  let spentFromPlan = 0;
  for (const s of state.sessions) {
    if (sessionGoalId(s) !== goal?.id) continue;
    const min = Math.max(0, Number(s.actualMin) || 0);
    spent += min;
    if (s.taskId && taskById(s.taskId)?.goalId === goal.id) spentFromTask += min;
    else spentFromPlan += min;
  }
  const done = tasks.filter((t) => t.status === 'done').length;
  const overdue = tasks.filter((t) => t.status !== 'done' && isOverdue(t)).length;
  const ratedPractice = tasks.filter((t) => t.selfRating === 'practice' || t.selfRating === 'unclear').length;
  const ratedClear = tasks.filter((t) => t.selfRating === 'clear').length;
  return {
    tasks: tasks.length, done, overdue,
    ratedPractice, ratedClear,
    est, estSource: ownEst ? 'goal' : taskEst ? 'tasks' : 'none',
    spent, remaining: est ? Math.max(0, est - spent) : null,
    pct: est ? Math.min(100, Math.round((spent / est) * 100)) : 0,
  };
}

/** 目标路线：阶段状态不存库，每次从任务现推。
 *  段内任务全部 done = 已完成；第一个没完成的段 = 当前；其余 = 后续。
 *  空段（还没挂任务）不算完成，轮到它就是当前。stageId 指向已删/不存在段的、
 *  以及没挂段的任务，一律归「未分段」——不猜它原来属于哪段。 */
export function stageRows(goal) {
  const stages = Array.isArray(goal?.stages) ? goal.stages.filter((s) => s && s.id) : [];
  const tasks = effectiveTasks(tasksForGoal(goal?.id));
  let currentMarked = false;
  const rows = stages.map((s, i) => {
    const ts = tasks.filter((t) => t.stageId === s.id);
    const done = ts.filter((t) => t.status === 'done').length;
    const estMin = ts.reduce((n, t) => n + Math.max(0, Number(t.estMin) || 0), 0);
    let status;
    if (ts.length && done === ts.length) status = 'done';
    else if (!currentMarked) { status = 'current'; currentMarked = true; }
    else status = 'later';
    return { id: s.id, title: s.title || `第 ${i + 1} 段`, note: s.note || '', index: i, tasks: ts, done, total: ts.length, estMin, status };
  });
  const loose = tasks.filter((t) => !t.stageId || !stages.some((s) => s.id === t.stageId));
  return { rows, loose };
}

/** 日期区间内（含端点，YYYY-MM-DD 字符串可直接比较）的计划完成情况 */
export function planStats(from, to) {
  let total = 0, done = 0, skipped = 0;
  for (const p of state.plans) {
    if (p.date < from || p.date > to) continue;
    total += 1;
    const st = planStatus(p);
    if (st === 'done') done += 1;
    else if (st === 'skipped') skipped += 1;
  }
  return { total, done, skipped, scheduled: total - done - skipped, rate: total ? Math.round((done / total) * 100) : 0 };
}

/** 一批专注记录的预计/实际合计 */
export function dayTotals(rows) {
  const planned = rows.reduce((n, x) => n + Math.max(0, Number(x.plannedMin) || 0), 0);
  const actual = rows.reduce((n, x) => n + Math.max(0, Number(x.actualMin) || 0), 0);
  return { count: rows.length, planned, actual, diff: actual - planned };
}

/** 任务是否已经过期未做 */
export function isOverdue(t) {
  if (t.status === 'done') return false;
  if (!t.dueAt) return false;
  const ms = parseLocal(t.dueAt);
  return ms !== null && ms < Date.now();
}

export function overdueTasks() { return pendingTasks().filter(isOverdue); }

/** 某天的固定占用（课程 + 午休 + 晚餐），单位分钟 */
export function busyOn(dateStr) {
  const s = state.settings;
  const blocks = [];
  for (const c of coursesOn(dateStr)) {
    // 旧数据/导入的课程可能缺 name：给中性占位，避免 occupiedOn 合并时 undefined.includes 崩掉今日/日历。
    blocks.push({ start: toMin(c.start), end: toMin(c.end), label: c.name || '课程', kind: 'course', refId: c.id });
  }
  if (s.lunchStart && s.lunchEnd) {
    blocks.push({ start: toMin(s.lunchStart), end: toMin(s.lunchEnd), label: '午休', kind: 'meal' });
  }
  if (s.dinnerStart && s.dinnerEnd) {
    blocks.push({ start: toMin(s.dinnerStart), end: toMin(s.dinnerEnd), label: '晚餐', kind: 'meal' });
  }
  return blocks;
}

/** 某天仍占用时间的学习计划：已完成和已跳过的都放行，让排程能把这段时间用给别的任务 */
export function plannedOn(dateStr) {
  return plansOn(dateStr)
    .filter((p) => planStatus(p) === 'scheduled')
    .map((p) => ({ start: toMin(p.start), end: toMin(p.start) + Number(p.min), label: p.title, kind: 'plan', refId: p.id }));
}

/** 某天所有占用，合并重叠后按时间排序 */
export function occupiedOn(dateStr, { includePlans = true } = {}) {
  const items = [...busyOn(dateStr), ...(includePlans ? plannedOn(dateStr) : [])].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (last && it.start <= last.end) {
      last.end = Math.max(last.end, it.end);
      if (!last.label.includes(it.label)) last.label += `、${it.label}`;
      (last.touched = last.touched || [/* 原始条目 */]).push(it);
    } else {
      merged.push({ ...it, touched: [it] });
    }
  }
  return merged;
}

/** 某天从 dayStart 到 dayEnd 之间的空闲区间 */
export function freeSlotsOn(dateStr, { includePlans = true, dayStart = null, dayEnd = null } = {}) {
  const s = state.settings;
  const from = dayStart ?? 7 * 60;
  const to = dayEnd ?? 23 * 60;
  const occ = occupiedOn(dateStr, { includePlans }).filter((b) => b.end > from && b.start < to);
  const slots = [];
  let cur = from;
  for (const b of occ) {
    if (b.start > cur) slots.push({ start: cur, end: Math.min(b.start, to) });
    cur = Math.max(cur, b.end);
  }
  if (cur < to) slots.push({ start: cur, end: to });
  return slots.filter((x) => x.end - x.start >= 15);
}

/** 某天空闲总时长（分钟），用于「今天还有多少自由时间」 */
export function freeMinutesOn(dateStr) {
  return freeSlotsOn(dateStr).reduce((n, s) => n + (s.end - s.start), 0);
}

/** 与给定区间冲突的占用（返回原始条目，用于提示） */
export function conflictsOn(dateStr, start, end, ignoreId = null) {
  const items = [...busyOn(dateStr), ...plannedOn(dateStr)].filter((b) => b.refId !== ignoreId);
  return items.filter((b) => b.start < end && b.end > start);
}

export function fmtRange(start, min) { return `${toHM(start)}-${toHM(start + min)}`; }
