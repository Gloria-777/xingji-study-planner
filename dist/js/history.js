// 本机历史校准：一切都从这台设备上真的做过的专注记录里算，不调用任何 AI、不联网、不读别的地方。
// 三件事共用同一份样本：① 你估的时长和实际差多少；② 你一天真正能做完多少；③ 一个目标按你自己的步幅要几天。
// 口径写死在这里，页面上只做展示：
//   · 用中位数而不是平均数——一次通宵能把平均值带走 40%，带走不了中位数。
//   · 样本不够就明确说「不够」，不硬凑一个系数冒充了解你。
//   · 示例数据带的记录单独数一遍，页面会说明这条建议是从哪一类记录算出来的。
import { state, taskById, sessionsOnDate, sessionDate, dayTotals } from './state.js';
import { ymd, parseLocal } from './ui.js';

// 一条记录要能进样本：预计和实际都在 5 分钟以上，否则 5/10 这种粒度会让比值飞掉
const MIN_SAMPLE_MIN = 5;
// 分组最少样本数。低于这个就不给结论——三条记录算出来的中位数没有意义
const MIN_SAMPLES = 4;
// 比值夹在 0.6–2.2：再极端说明样本被某一次意外带跑了，不能拿来改你的日程
const FACTOR_MIN = 0.6;
const FACTOR_MAX = 2.2;
// 每日预算回看 28 天、至少要有 5 天真的有记录
const BUDGET_LOOKBACK = 28;
const BUDGET_MIN_DAYS = 5;

const isDemo = (row) => Boolean(row && row.demo);

const round5 = (n) => Math.max(5, Math.round(n / 5) * 5);

export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** 一条专注记录属于哪个科目：只认它关联任务的科目，没关联任务就是「未分组」 */
function subjectOf(s) {
  const t = s.taskId ? taskById(s.taskId) : null;
  const subj = String(t?.subject || '').trim();
  return subj || '未分组';
}

/** 全量样本：预计/实际都在 5 分钟以上的专注记录 */
export function estimateSamples() {
  const out = [];
  for (const s of state.sessions) {
    const planned = Number(s.plannedMin) || 0;
    const actual = Number(s.actualMin) || 0;
    if (planned < MIN_SAMPLE_MIN || actual < MIN_SAMPLE_MIN) continue;
    const task = s.taskId ? taskById(s.taskId) : null;
    out.push({
      id: s.id,
      subject: subjectOf(s),
      ratio: actual / planned,
      planned,
      actual,
      demo: isDemo(s) || isDemo(task),
      date: sessionDate(s),
      title: task?.title || s.title || '',
    });
  }
  return out;
}

/**
 * 这个科目（或全量兜底）的预估偏差。
 * 返回 enough=false 时页面必须改口说「这台设备上还没有足够的记录」，不能给建议。
 */
export function estimateFor(subject = '') {
  const all = estimateSamples();
  const subj = String(subject || '').trim();
  const grouped = subj ? all.filter((r) => r.subject === subj) : [];
  const rows = grouped.length >= MIN_SAMPLES ? grouped : all;
  const group = grouped.length >= MIN_SAMPLES ? subj : '全量';
  const factors = rows.map((r) => r.ratio);
  const med = median(factors);
  const enough = rows.length >= MIN_SAMPLES && med !== null;
  const real = rows.filter((r) => !r.demo).length;
  return {
    enough,
    group,
    groupSamples: grouped.length,
    samples: rows.length,
    realSamples: real,
    demoSamples: rows.length - real,
    rawFactor: med,
    // 夹紧后的系数才是敢拿来改时长的：极端值只允许出现在统计里，不允许出现在你的日程里
    factor: enough ? Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, med)) : null,
    // 中位数落在哪一侧，用大白话讲一遍
    direction: !enough ? 'none' : med >= 1.1 ? 'under' : med <= 0.9 ? 'over' : 'near',
    note: enough
      ? `这 ${rows.length} 段记录里，实际用时中位数是你当时预计的 ${Math.round(med * 100)}%。`
      : `同类记录只有 ${rows.length} 段（要 4 段以上才给结论），先做几次专注再说。`,
  };
}

/** 按你自己的历史，这条该留多久。差不到 5 分钟就不建议改，别为这点碎事打扰你 */
export function calibratedMin(estMin, subject = '') {
  const base = Math.max(0, Number(estMin) || 0);
  const est = estimateFor(subject);
  if (!est.enough || !base) return { est, suggested: null, diff: 0 };
  const suggested = round5(base * est.factor);
  const diff = suggested - base;
  return { est, suggested: Math.abs(diff) >= 5 ? suggested : null, raw: Math.round(base * est.factor), diff };
}

/** 你一天真正能做多少：回看 28 天，取「有记录的每一天实际总时长」的中位数 */
export function dailyBudget() {
  const days = [];
  const today = new Date();
  for (let i = 0; i < BUDGET_LOOKBACK; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const ds = ymd(d);
    const rows = sessionsOnDate(ds);
    if (!rows.length) continue;
    const tot = dayTotals(rows);
    days.push({
      date: ds,
      actual: tot.actual,
      planned: tot.planned,
      count: tot.count,
      demo: rows.every((x) => isDemo(x) || isDemo(x.taskId ? taskById(x.taskId) : null)),
    });
  }
  const enough = days.length >= BUDGET_MIN_DAYS;
  const values = days.map((x) => x.actual);
  const med = median(values);
  const sorted = values.slice().sort((a, b) => a - b);
  const p75 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))] : null;
  const realDays = days.filter((x) => !x.demo).length;
  return {
    enough,
    days: days.length,
    realDays,
    demoDays: days.length - realDays,
    minutes: enough ? round5(med) : null,
    bestDay: p75 !== null ? round5(p75) : null,
    recent: days.slice(0, 7),
    note: enough
      ? `这 ${days.length} 天里，你一天真正做完的中位数是 ${round5(med)} 分钟；最好的一天大约 ${round5(p75)} 分钟。`
      : `有记录的只有 ${days.length} 天（要 ${BUDGET_MIN_DAYS} 天以上才给预算），先积累几天再说。`,
  };
}

/** 连续几天的偏差趋势：看的是「你是不是一贯性地估少」，不是某一天 */
export function biasTrend(days = 7) {
  const rows = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const ds = ymd(d);
    const list = sessionsOnDate(ds);
    if (!list.length) { rows.push({ date: ds, empty: true, count: 0, planned: 0, actual: 0, ratio: null }); continue; }
    const tot = dayTotals(list);
    rows.push({
      date: ds, empty: false, count: tot.count, planned: tot.planned, actual: tot.actual,
      ratio: tot.planned >= MIN_SAMPLE_MIN ? tot.actual / tot.planned : null,
    });
  }
  const rated = rows.filter((r) => r.ratio !== null);
  const med = median(rated.map((r) => r.ratio));
  const underDays = rated.filter((r) => r.ratio >= 1.1).length;
  const overDays = rated.filter((r) => r.ratio <= 0.9).length;
  let verdict = 'near';
  if (rated.length >= 4 && med !== null) {
    if (med >= 1.1 && underDays / rated.length >= 0.5) verdict = 'under';
    else if (med <= 0.9 && overDays / rated.length >= 0.5) verdict = 'over';
  }
  return {
    days: rated.length,
    enough: rated.length >= 4,
    medianRatio: med,
    underDays,
    overDays,
    verdict,
    rows,
    text: rated.length < 4
      ? `这 ${days} 天里只有 ${rated.length} 天有可比的记录，看不出趋势。`
      : verdict === 'under'
        ? `这 ${days} 天里你 ${underDays} 天做得比预计多，实际中位数是预计的 ${Math.round(med * 100)}%——你系统性地估少了，同类任务下次按这个比例留时间就行，不是你慢。`
        : verdict === 'over'
          ? `这 ${days} 天里你 ${overDays} 天做得比预计少，实际中位数是预计的 ${Math.round(med * 100)}%——要么任务太大，要么预计留多了，先把最大那条切一刀。`
          : `这 ${days} 天的预计和实际基本对得上（中位数 ${Math.round(med * 100)}%），保持现在这个步幅。`,
  };
}

/** 目标展望：按你自己的每日预算，这个目标还要几天、赶不赶得上截止日。
 *  这一句是星迹的立场：先告诉你按你的步子要多久，再问你要不要改范围或改日期——
 *  而不是假装把它塞进日历就能做完。 */
export function goalOutlook(prog, dueAt, budget = dailyBudget()) {
  const remaining = Number(prog?.remaining) || 0;
  const perDay = budget.minutes;
  const dueMs = dueAt ? parseLocal(dueAt) : null;
  const daysLeft = dueMs === null ? null
    : Math.ceil((dueMs - new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime()) / 864e5);
  if (!budget.enough || !remaining) {
    return {
      canEstimate: false,
      remaining,
      reason: !budget.enough
        ? `还不清楚你一天真正能做多少（有记录的天数不足 ${BUDGET_MIN_DAYS} 天），所以不猜这个目标要几天。`
        : '这个目标没有可比较的量：既没填预计总时长，它下面的任务也没填预计。补一个数就能算。',
      budget,
    };
  }
  const daysNeeded = Math.ceil(remaining / perDay);
  const finishDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() + daysNeeded);
    return ymd(d);
  })();
  if (daysLeft === null) return { canEstimate: true, remaining, perDay, daysNeeded, finishDate, deadline: null, budget };
  const slack = daysLeft - daysNeeded;
  return {
    canEstimate: true,
    remaining,
    perDay,
    daysNeeded,
    finishDate,
    deadline: String(dueAt).slice(0, 10),
    daysLeft,
    slack,
    feasible: slack >= 0,
    // 截止日卡死了要几天做完——这个数字是用来决定「要不要砍范围」的，不是用来吓人的
    perDayIfDeadline: Math.ceil(remaining / Math.max(1, daysLeft)),
  };
}

/** 一句人话说明这些数字是从哪来的，页面每次展示统计都要带上它 */
export function provenance(res) {
  if (!res.samples) return '这台设备上还没有可用于校准的记录。';
  const parts = [`${res.samples} 段记录`];
  if (res.demoSamples && res.realSamples) parts.push(`其中 ${res.demoSamples} 段来自示例数据`);
  else if (res.demoSamples) parts.push('全部来自示例数据，不是你自己的记录');
  else parts.push('全部来自你自己的记录');
  return parts.join(' · ');
}

/** 受阻原因反哺：聚合近 N 天 plans.blockReason，给目标（或全局）一句规则统计。
 *  只读已经落库的受阻标记，不调用任何 AI、不猜没记录过的原因。 */
const BLOCKER_ADVICE = {
  '任务太大': '建议把剩下最大的一条任务再拆小一点，或减少每段的分钟。',
  '没时间': '建议把每天的安排上限调小，或砍掉一部分范围。',
  '不会做': '建议先来一个 15 分钟的小开头，只求「开了头」。',
  '想休息': '最近想休息的次数不少，可能节奏太满，给自己留一点空。',
};
export function blockerInsight({ goalId = null, days = 14 } = {}) {
  const cutoff = Date.now() - days * 864e5;
  const counts = new Map();
  let total = 0;
  for (const p of state.plans) {
    if (!p.blockReason || !p.blockedAt) continue;
    if (new Date(p.blockedAt).getTime() < cutoff) continue;
    const task = p.taskId ? state.tasks.find((t) => t.id === p.taskId) : null;
    if (goalId && task?.goalId !== goalId) continue;
    const reason = String(p.blockReason).startsWith('想休息') ? '想休息' : String(p.blockReason);
    counts.set(reason, (counts.get(reason) || 0) + 1);
    total += 1;
  }
  if (!total) return { enough: false, total: 0, top: null, text: '' };
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const advice = BLOCKER_ADVICE[top[0]] || '';
  const text = `近 ${days} 天${goalId ? '这个目标' : ''}有 ${total} 条计划受阻，其中 ${top[1]} 次是「${top[0]}」。${advice}`;
  return { enough: true, total, top: { reason: top[0], n: top[1] }, text };
}

/** 时段效率画像：按一天三个时段统计近 N 天的专注记录，找出你实际完成最多的时段。
 *  只陈述事实（哪段实际做了多少分钟），不推断「原因」，也不拿去自动改排程。 */
export function timeOfDayProfile(days = 28) {
  const buckets = [
    { key: 'morning', label: '上午（0–12 点）', from: 0, to: 12 * 60 },
    { key: 'afternoon', label: '下午（12–18 点）', from: 12 * 60, to: 18 * 60 },
    { key: 'evening', label: '晚上（18–24 点）', from: 18 * 60, to: 24 * 60 },
  ].map((b) => ({ ...b, count: 0, planned: 0, actual: 0 }));
  const start = new Date(); start.setDate(start.getDate() - (days - 1));
  const from = ymd(start);
  const to = ymd(new Date());
  for (const s of state.sessions) {
    const ds = sessionDate(s);
    if (!ds || ds < from || ds > to) continue;
    const d = new Date(String(s.endedAt || ''));
    if (isNaN(d.getTime())) continue;
    const min = d.getHours() * 60 + d.getMinutes();
    const b = buckets.find((x) => min >= x.from && min < x.to) || buckets[buckets.length - 1];
    b.count += 1;
    b.planned += Math.max(0, Number(s.plannedMin) || 0);
    b.actual += Math.max(0, Number(s.actualMin) || 0);
  }
  const totalCount = buckets.reduce((n, b) => n + b.count, 0);
  const best = buckets.slice().sort((a, b) => b.actual - a.actual)[0];
  return { buckets, totalCount, best, enough: totalCount >= 4 };
}

export const CALIBRATION_RULE_NOTE = '规则统计 · 未调用 AI';
