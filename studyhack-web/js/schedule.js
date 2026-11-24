// 规则排程：纯本地计算，不调用任何 AI 服务。
// 输出「建议占位」+「放不下原因」，由页面预览确认后才写入 plans。
import { state, freeSlotsOn, conflictsOn, dateOfWeek, weekDates, todayStr, taskProgress, effectiveTasks } from './state.js';
import { toMin, toHM, parseLocal, ymd, PRIO_LABEL } from './ui.js';

const PRIO = { high: 0, medium: 1, low: 2 };
// 一条计划的最短时长，和 validateSlot 的「时长至少 5 分钟」一致；比它更短的剩余量不值得单独成块
const TAIL_MIN = 5;

function candidateDates(task, horizonDays) {
  const dates = [];
  const today = todayStr();
  const dueDay = task.dueAt ? task.dueAt.slice(0, 10) : null;
  let last;
  if (dueDay) {
    last = dueDay;
  } else {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() + horizonDays - 1);
    last = ymd(d);
  }
  for (let i = 0; i < 30; i++) {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() + i);
    const ds = ymd(d);
    if (ds > last) break;
    dates.push(ds);
    if (ds === last) break;
  }
  return dates;
}

function dayWindow(dateStr, now) {
  const s = state.settings;
  let from = s.axisStart * 60;
  const to = s.axisEnd * 60;
  if (dateStr === todayStr()) {
    from = Math.max(from, now.getHours() * 60 + now.getMinutes() + 5);
  }
  return { from, to };
}

/** 从空闲区间里挖掉本次临时占用的块，后面的任务就不会排到同一时段 */
function subtract(base, blocks) {
  if (!blocks.length) return base;
  let out = base;
  for (const b of blocks) {
    const next = [];
    for (const s of out) {
      if (b.end <= s.start || b.start >= s.end) { next.push(s); continue; }
      if (b.start > s.start) next.push({ start: s.start, end: b.start });
      if (b.end < s.end) next.push({ start: b.end, end: s.end });
    }
    out = next;
  }
  return out;
}

function compareTask(a, b) {
  if ((a.status === 'done') !== (b.status === 'done')) return a.status === 'done' ? 1 : -1;
  const pa = PRIO[a.priority] ?? 1, pb = PRIO[b.priority] ?? 1;
  if (pa !== pb) return pa - pb;
  return String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999'));
}

/** 每条建议的「依据」：只陈述排程时已经知道的事实（排位、截止、拆块、空档来源），
 *  不写推测。手动/AI 计划没有这份依据，界面按来源标注，不替它们编一句。 */
function basisFor(t, rank, ds, pieceNo) {
  const bits = [`优先级「${PRIO_LABEL[t.priority] || '普通'}」第 ${rank} 位`];
  if (t.dueAt) bits.push(`赶在截止 ${String(t.dueAt).slice(0, 16).replace('T', ' ')} 前`);
  else bits.push('没设截止时间，按可用空档排');
  if (!Number(t.estMin)) bits.push('没填预计时长，先按 30 分钟排');
  if (pieceNo > 1) bits.push(`拆块第 ${pieceNo} 段`);
  bits.push(`${ds === todayStr() ? '今天' : ds.slice(5)}的空闲段，避开课程、午休晚餐与已保存计划`);
  return bits.join('；').slice(0, 120);
}

/**
 * 生成计划建议
 * @param {Object} opt
 *   tasks: 参与排程的任务数组
 *   horizonDays: 往后看几天
 *   chunkMax: 允许把长任务拆成的最大块（分钟，null=不拆）
 *   minBlock: 最小块（默认 15）
 *   includeFull: true 时把已投入满预计的任务也按原始预计时长排（用于测试/手工重排；默认按剩余时间）
 */
export function suggestPlan(opt = {}) {
  const s = state.settings;
  const horizon = Number(opt.horizonDays) || 7;
  const chunkMax = opt.chunkMax ? Number(opt.chunkMax) : null;
  const minBlock = Number(opt.minBlock) || 15;
  const includeFull = opt.includeFull === true;
  const now = new Date();
  const perDayUsed = {};
  const items = [];
  const skipped = [];
  const partial = [];

  // 已拆段的原任务由它的段代管，不再单独排：否则拆完后原任务和段会一起占时间
  const tasks = effectiveTasks(opt.tasks || state.tasks).filter((t) => t.status !== 'done');
  tasks.sort(compareTask);

  const tent = {};   // 本批次临时占用：date -> [{start,end}]
  const dayFree = (ds, from, to) => subtract(freeSlotsOn(ds, { dayStart: from, dayEnd: to }), tent[ds] || []);

  /** 这条任务在候选日期里真正能用的连续空闲（含截止日当天按截止时分截断） */
  function usableGaps(dates, dueDay, dueMs) {
    const gaps = [];
    let capHit = false;
    for (const ds of dates) {
      if ((perDayUsed[ds] || 0) >= s.dailyCapMin) { capHit = true; continue; }
      const win = dayWindow(ds, now);
      let dayEnd = win.to;
      if (dueDay && ds === dueDay) {
        const d = new Date(dueMs);
        dayEnd = Math.min(dayEnd, d.getHours() * 60 + d.getMinutes());
      }
      if (dayEnd <= win.from) continue;
      for (const x of dayFree(ds, win.from, dayEnd)) gaps.push(x.end - x.start);
    }
    return { maxGap: gaps.length ? Math.max(...gaps) : 0, capHit };
  }

  for (const [ti, t] of tasks.entries()) {
    const dueMs = t.dueAt ? parseLocal(t.dueAt) : null;
    if (dueMs !== null && dueMs <= now.getTime()) {
      skipped.push({ task: t, reason: `截止时间（${t.dueAt}）已经过了，先推迟任务再排程` });
      continue;
    }
    // 排程只看还缺多少时间：已投入的分钟不再重复占用你的日程
    const pr = taskProgress(t);
    if (pr.remaining === 0 && !includeFull) {
      skipped.push({ task: t, reason: `预计 ${pr.est} 分钟已经投入 ${pr.spent} 分钟，剩余 0 分钟，本轮不再排。想继续排就把任务的预计时长调大，或者勾掉这条任务。` });
      continue;
    }
    const est = Math.round(Number(t.estMin) || 30);
    const need = Math.max(TAIL_MIN, pr.remaining === null ? est : pr.remaining);
    const dates = candidateDates(t, horizon);
    const dueDay = t.dueAt ? t.dueAt.slice(0, 10) : null;
    if (!dates.length) {
      skipped.push({ task: t, reason: dueDay ? '截止时间已经过了，请先推迟任务或安排到今天之后' : '没有可安排的日期' });
      continue;
    }
    let placed = 0;
    const pieces = [];
    const added = [];
    let lastFit = null;   // 最后一块：{ ds, block, slotEnd }，用来吸收不足最小块的尾巴
    for (const ds of dates) {
      if (placed >= need) break;
      if ((perDayUsed[ds] || 0) >= s.dailyCapMin) continue;
      const win = dayWindow(ds, now);
      let dayEnd = win.to;
      if (dueDay && ds === dueDay) {
        const d = new Date(dueMs);
        dayEnd = Math.min(dayEnd, d.getHours() * 60 + d.getMinutes());
      }
      if (dayEnd <= win.from) continue;
      const slots = dayFree(ds, win.from, dayEnd);
      // 索引扫描：拆出小块后，同一个时段的剩余部分要能接着用，否则长时段只吃到一个 chunkMax
      for (let i = 0; i < slots.length; i++) {
        if (placed >= need) break;
        const slot = slots[i];
        const room = slot.end - slot.start;
        const left = need - placed;
        const roomCap = Math.max(0, s.dailyCapMin - (perDayUsed[ds] || 0));
        // 剩余量比一块还短、但不少于 5 分钟，而且这段放得下：排一条收尾小块，正好把这条补完
        const isTail = left >= TAIL_MIN && left < minBlock && left <= Math.min(room, roomCap);
        if (room < minBlock && !isTail) continue;
        let take = Math.min(room, left, roomCap);
        if (chunkMax && take > chunkMax && !isTail) take = chunkMax;
        if (take < minBlock && !isTail) continue;
        const start = slot.start;
        const end = start + take;
        const clash = conflictsOn(ds, start, end);
        if (clash.length) continue;   // 空闲表已排除占用，这里是二次校验
        const block = { start, end };
        pieces.push({ taskId: t.id, title: t.title, date: ds, start: toHM(start), min: take, priority: t.priority, estMin: pr.est, spentMin: pr.spent, basis: basisFor(t, ti + 1, ds, pieces.length + 1) });
        added.push({ ds, block });
        (tent[ds] = tent[ds] || []).push(block);
        perDayUsed[ds] = (perDayUsed[ds] || 0) + take;
        placed += take;
        lastFit = { ds, block, slotEnd: slot.end };
        if (end < slot.end && slot.end - end >= minBlock) slots.splice(i + 1, 0, { start: end, end: slot.end });
        if (!chunkMax && take >= room) break;
      }
    }
    if (placed >= need) {
      items.push(...pieces);
    } else if (placed > 0 && need - placed < minBlock) {
      const tail = need - placed;
      const roomLeft = lastFit ? lastFit.slotEnd - lastFit.block.end : 0;
      const capLeft = lastFit ? s.dailyCapMin - (perDayUsed[lastFit.ds] || 0) : 0;
      if (roomLeft >= tail && capLeft >= tail) {
        // 尾巴短到不值一条独立小块，但最后一块所在的空闲时段还装得下：并进去，不留碎片也不留缺口
        lastFit.block.end += tail;          // tent 里是同一个对象引用，占用自动跟着变
        perDayUsed[lastFit.ds] += tail;
        pieces[pieces.length - 1].min += tail;
        placed = need;
        items.push(...pieces);
      } else {
        // 排到的部分够一条，只差不到一个最小块——是粒度限制，不是没时间，
        // 所以保留已排下的部分，剩余分钟留到下一轮，别把整条扔掉。
        items.push(...pieces);
        partial.push({ task: t, placed, missing: tail, minBlock });
      }
    } else {
      // 这条不写入，把临时占用退还给后面的任务
      for (const a of added) {
        perDayUsed[a.ds] -= (a.block.end - a.block.start);
        tent[a.ds] = tent[a.ds].filter((b) => b !== a.block);
      }
      const { maxGap, capHit } = usableGaps(dates, dueDay, dueMs);
      skipped.push({
        task: t,
        reason: `需要 ${need} 分钟，${horizon} 天内最长连续空闲只有 ${maxGap} 分钟${placed > 0 ? `，零散凑到的 ${placed} 分钟也放不下整条` : ''}${capHit ? `，而且「每天最多 ${s.dailyCapMin} 分钟」的上限已经卡满` : ''}。可以拆分任务、放宽午休/晚餐、调大每天上限，或把截止时间往后挪。`,
      });
    }
  }
  return { items, skipped, partial, perDayUsed };
}

/** 校验单条计划是否与课程/午休/晚餐/已有计划冲突；extra 用于检查同一批还没保存的条目
 *  dueAt：关联任务的截止时间，新建时由调用方直接给（那时还没有计划行可查）；
 *  allowPast：恢复一条已删除的旧计划时用，那时日期在过去是应有之义。 */
export function validateSlot({ date, start, min, ignoreId = null, extra = [], dueAt = null, allowPast = false }) {
  const errs = [];
  if (!date) errs.push('请选择日期');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errs.push(`日期格式不对（收到 ${date}，要 YYYY-MM-DD）`);
  const st = toMin(start);
  const en = st + Number(min || 0);
  if (!Number.isFinite(st)) errs.push('开始时间格式不对');
  if (!(Number(min) >= 5)) errs.push('时长至少 5 分钟');
  if (Number(min) > 480) errs.push('单条计划不要超过 8 小时');
  const prior = ignoreId ? state.plans.find((p) => p.id === ignoreId) : null;
  // 时间三要素没动的编辑（只改标题、状态或备注）不拦「时间是否已经过去」这一类：
  // 否则今天下午就再也不能把今天上午那条已完成未改状态的计划标掉。冲突照常查。
  const slotUnchanged = Boolean(prior) && prior.date === date && toMin(prior.start) === st && Number(prior.min) === Number(min);
  if (date && Number.isFinite(st)) {
    const win = dayWindow(date, new Date());
    if (!slotUnchanged) {
      // 过去日期：只有「本来就安排在过去的那条老计划」放行；除此之外（新建、改期、AI 写入）排在昨天就是排不进今天。
      if (date < todayStr() && !allowPast) errs.push(`${date} 已经过去了，换到今天或以后`);
      if (date === todayStr() && st < win.from) errs.push('这个时间已经过去了');
      const dlRaw = dueAt ?? (prior?.taskId ? state.tasks.find((x) => x.id === prior.taskId)?.dueAt : null);
      const dlMs = dlRaw ? parseLocal(dlRaw) : null;
      if (dlMs !== null) {
        const endMs = new Date(`${date}T00:00:00`).getTime() + en * 60000;
        if (endMs > dlMs) errs.push(`这条排在任务截止时间（${String(dlRaw).replace('T', ' ')}）之后了`);
      }
    }
    if (en > win.to) errs.push(`超出你的可用时段（${toHM(win.from)}-${toHM(win.to)}）`);
    const clash = conflictsOn(date, st, en, ignoreId);
    for (const b of extra) {
      if (b.date === date && b.start < en && b.end > st) clash.push({ label: b.title, start: b.start, end: b.end });
    }
    if (clash.length) errs.push(`与 ${clash.map((c) => `${c.label}（${toHM(c.start)}-${toHM(c.end)}）`).join('、')} 冲突`);
  }
  return errs;
}

/** 一周内每天的空闲概览，用于计划页日历条 */
export function weekFree(mondayStr) {
  const now = new Date();
  return weekDates(mondayStr).map((ds) => {
    const win = dayWindow(ds, now);
    const slots = freeSlotsOn(ds, { dayStart: win.from, dayEnd: win.to });
    return { date: ds, minutes: slots.reduce((n, x) => n + (x.end - x.start), 0), slots };
  });
}
