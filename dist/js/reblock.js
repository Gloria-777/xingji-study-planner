// 计划受阻之后：选一个原因 → 看到对应的调整提案 → 逐条勾选、可改时间/分钟 → 确认才写本机库。
// 提案全部来自本机规则计算，没有调用任何 AI；确认之前库里一条记录都不变。
// 原任务与原计划都不删除：拆分只是长出新的段，去向在预览里写明。
import * as db from './store.js';
import { state, taskProgress } from './state.js';
import { h, openSheet, toast, ymd, pad2, parseLocal } from './ui.js';
import { changed, writeRow, deferTask, deferSheet, editPlan } from './forms.js';
import { suggestPlan, validateSlot } from './schedule.js';
import { syncDerived } from './remind.js';
import { planChunks } from './pages/goals.js';
import { openAs } from './pages/assistants.js';
import { goPage } from './app.js';

const RULE_NOTE = '规则生成 · 未调用 AI';
const REASONS = [
  { key: '没时间', desc: '按任务剩余分钟重新找空档，排出来再逐条确认' },
  { key: '不会做', desc: '先来一个 15 分钟的小开头，原任务可以推迟一天' },
  { key: '任务太大', desc: '把剩余分钟拆成 2–3 段，原任务保留不动' },
  { key: '想休息', desc: '暂停或跳过，不排任何新东西' },
  { key: '不想回答', desc: '不追问，直接用现有的推迟 / 改时间' },
];

const dtFromMs = (ms) => {
  const d = new Date(ms);
  return `${ymd(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const showDT = (v) => String(v || '').replace('T', ' ');

/** 把这条计划标为跳过并记下原因；写不进去就把内存改回来，调用方别报成功 */
async function markBlocked(p, reason) {
  const prev = { status: p.status, statusAt: p.statusAt, blockReason: p.blockReason ?? null, blockedAt: p.blockedAt ?? null };
  p.status = 'skipped';
  if (!p.statusAt) p.statusAt = new Date().toISOString();
  p.blockReason = reason;
  p.blockedAt = new Date().toISOString();
  if (!(await writeRow(() => db.put('plans', p)))) { Object.assign(p, prev); return false; }
  return true;
}

async function addTaskRow(row) {
  if (!(await writeRow(() => db.put('tasks', row)))) return null;
  state.tasks.push(row);
  return row;
}

/** 没时间：按关联任务重跑排程（3 天、拆 45）；任务已逾期，提案里第一条就是先推迟 */
function noTimeItems(plan, task) {
  if (!task) return { items: [], note: '这条计划没有关联任务，没法按任务剩余分钟重排。选「不想回答」可以直接改它的时间。' };
  const items = [];
  const dueMs = task.dueAt ? parseLocal(task.dueAt) : null;
  const overdue = dueMs !== null && dueMs <= Date.now();
  let effectiveDue = task.dueAt || '';
  if (overdue) {
    const newMs = dueMs + 864e5;
    effectiveDue = dtFromMs(newMs);
    items.push({
      kind: 'defer', keep: true,
      title: '先把任务截止推迟一天',
      detail: `原截止 ${showDT(task.dueAt)} 已经过了，不推迟就排不进任何空档。新截止：${showDT(effectiveDue)}`,
      run: async () => {
        const prevDueAt = task.dueAt;
        await deferTask(task, newMs);
        return task.dueAt === effectiveDue ? { _defer: true, taskId: task.id, prevDueAt, newDueAt: task.dueAt, title: task.title } : null;
      },
    });
  }
  const res = suggestPlan({ tasks: [{ ...task, dueAt: effectiveDue }], horizonDays: 3, chunkMax: 45 });
  for (const it of res.items) {
    const errs = validateSlot({ date: it.date, start: it.start, min: it.min, dueAt: effectiveDue || null });
    items.push({
      kind: 'plan', keep: !errs.length, disabled: errs.length > 0,
      title: it.title,
      detail: `排进 ${it.date} ${it.start} 的空闲段`,
      basis: it.basis || '', errs,
      edit: { date: it.date, start: it.start, min: Number(it.min) },
      run: async (self) => {
        const { date, start, min } = self.edit;
        // 落库前按任务此刻的真实截止再验一次：推迟那条被勾掉时，这里会正当地拦下
        const e = validateSlot({ date, start, min, dueAt: task.dueAt || null });
        if (e.length) { toast('这条没写进去', e[0], 'bad'); return false; }
        const touched = date !== it.date || start !== it.start || Number(min) !== Number(it.min);
        const row = {
          id: db.uid(), taskId: task.id, title: it.title, date, start, min: Number(min),
          status: 'scheduled', statusAt: null, source: 'rule',
          basis: touched ? null : (it.basis || null), createdAt: new Date().toISOString(),
        };
        if (!(await writeRow(() => db.put('plans', row)))) return null;
        state.plans.push(row);
        return row;
      },
    });
  }
  const note = res.items.length
    ? (overdue ? '勾掉「先推迟」的话，下面这些时段会因晚于原截止而被校验拦下，不会硬写。' : '日期、开始时间和分钟都能改；改过时间的条目不再挂原来的排程依据。')
    : `三天内没有排出空档：${res.skipped[0] ? res.skipped[0].reason : '可用时段不足'}。可以去计划页调大每天上限或放宽午休/晚餐，再来一次。`;
  return { items, note };
}

/** 不会做：一个 15 分钟低门槛第一步 + 原任务推迟一天，两条各自可勾掉 */
function stuckItems(plan, task) {
  const base = task || { title: plan.title, dueAt: '', goalId: null, subject: '' };
  const dueMs = base.dueAt ? parseLocal(base.dueAt) : null;
  const overdue = dueMs !== null && dueMs <= Date.now();
  const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(21, 0, 0, 0);
  const stepDue = overdue ? dtFromMs(dueMs + 864e5) : (base.dueAt || dtFromMs(d.getTime()));
  const stepTitle = `先开个头：${base.title}`.slice(0, 80);
  const items = [{
    kind: 'task', keep: true,
    title: stepTitle,
    detail: '只看例题或笔记，写下已经看懂的一步；做不出来也算开始了。具体看哪道题、哪一页由你填，星迹不替你编例题或前置知识。',
    edit: { estMin: 15, date: stepDue.slice(0, 10), time: stepDue.slice(11, 16) || '21:00', title: '' },
    run: async (self) => addTaskRow({
      id: db.uid(), title: (self.edit.title || '').trim() || stepTitle, subject: base.subject || '', dueAt: `${self.edit.date}T${self.edit.time}`,
      estMin: Number(self.edit.estMin) || 15, priority: 'low',
      note: '不会做时的低门槛第一步：只看例题或笔记，做不出来也算开始。',
      status: 'pending', goalId: base.goalId || null, stageId: base.stageId || null, splitFrom: task ? task.id : null, splitKind: task ? 'starter' : null, addedBy: 'reblock',
      createdAt: new Date().toISOString(),
    }),
  }];
  if (task) {
    const newMs = (dueMs ?? Date.now()) + 864e5;
    const newDue = dtFromMs(newMs);
    items.push({
      kind: 'defer', keep: true,
      title: '原任务推迟一天',
      detail: `${task.dueAt ? showDT(task.dueAt) : '没有截止时间'} → ${showDT(newDue)}。原任务不删、不改小，只是往后挪一天。`,
      run: async () => {
        const prevDueAt = task.dueAt;
        await deferTask(task, newMs);
        return task.dueAt === newDue ? { _defer: true, taskId: task.id, prevDueAt, newDueAt: task.dueAt, title: task.title } : null;
      },
    });
  }
  return { items, note: task ? '' : '这条计划没有关联任务：只提案一个小开头任务，没有可推迟的原任务。' };
}

/** 任务太大：按时间切 2–3 段；每段具体做什么由用户填。
 *  时间切段不等于内容拆解——填不出内容的段只按时间算，星迹不替用户编学习内容。 */
function bigItems(plan, task) {
  const pr = task ? taskProgress(task) : null;
  const remaining = task ? (pr.remaining ?? Math.max(5, pr.est || 30)) : Math.max(5, Number(plan.min) || 30);
  if (remaining < 30) return { items: [], note: `只剩 ${remaining} 分钟，不值得再拆成段。可以试「不会做」的 15 分钟小开头，或选「不想回答」直接改时间。` };
  const n = remaining > 90 ? 3 : 2;
  const chunks = planChunks({ remaining, perDay: Math.ceil(remaining / n), days: n, startOffset: 1, titles: [] });
  const dueTime = task && task.dueAt ? task.dueAt.slice(11, 16) : '21:00';
  const items = chunks.map((c, i) => {
    const title = `第 ${i + 1} 段：${task ? task.title : plan.title}`.slice(0, 80);
    return {
      kind: 'task', keep: true,
      title,
      detail: '按时间切出来的一段。这一段具体做什么由你填（比如「例 1–3 题」「读第 2 节并做笔记」）；不填就只按时间算，星迹不替你编内容。',
      edit: { estMin: c.estMin, date: c.date, time: dueTime, title: '' },
      run: async (self) => addTaskRow({
        id: db.uid(), title: (self.edit.title || '').trim() || title, subject: task?.subject || '', dueAt: `${self.edit.date}T${self.edit.time}`,
        estMin: Number(self.edit.estMin) || c.estMin,
        priority: task?.priority || 'medium', note: '', status: 'pending',
        goalId: task?.goalId || null, stageId: task?.stageId || null, splitFrom: task?.id || null, splitKind: task ? 'chunk' : null, addedBy: 'reblock',
        createdAt: new Date().toISOString(),
      }),
    };
  });
  const note = (task
    ? `原任务保留不动：仍是 ${pr.est} 分钟、截止 ${task.dueAt ? showDT(task.dueAt) : '未设置'}。拆出的 ${items.length} 段合计 ${remaining} 分钟（剩余量）；每段的分钟、到期日期和内容都能改。段做完后，由你决定什么时候把原任务标完成。`
    : `原计划保留不动；拆出的 ${items.length} 段是独立任务，合计 ${remaining} 分钟。`)
    + ' 这是时间切段；每段的内容条件由你写，写不出来就先按时间开始。';
  return { items, note };
}

/** 提案弹层：勾选 + 可改时间/分钟，确认那一刻才先标跳过、再逐条写入 */
function proposalSheet(plan, reason, { items, note }, onDone) {
  const list = h('div', { class: 'check-list' });
  const countEl = h('p', { class: 'reblock-count', role: 'status' });
  const refresh = () => {
    const n = items.filter((x) => x.keep && !x.disabled).length;
    countEl.textContent = `已勾选 ${n} 条 · 确认后写入`;
  };
  const fieldRow = (label, el) => h('div', { class: 'field' }, h('label', { text: label }), el);
  for (const it of items) {
    const cb = h('input', { type: 'checkbox', checked: it.keep, disabled: it.disabled, 'aria-label': `采纳：${it.title}` });
    cb.addEventListener('change', () => { it.keep = cb.checked; refresh(); });
    let edits = null;
    let titleNode = null;
    const duration = it.edit ? h('span', { class: 'reblock-duration' }) : null;
    const showDuration = () => {
      const minutes = it.kind === 'task' ? it.edit.estMin : it.edit.min;
      duration.textContent = `${minutes} 分钟`;
    };
    if (duration) showDuration();
    if (it.edit && it.kind === 'task') {
      const minEl = h('input', { type: 'number', min: 5, max: 480, step: 5, value: it.edit.estMin, 'aria-label': '预计分钟' });
      const dateEl = h('input', { type: 'date', value: it.edit.date, 'aria-label': '到期日期' });
      minEl.addEventListener('change', () => { it.edit.estMin = Number(minEl.value) || it.edit.estMin; showDuration(); });
      dateEl.addEventListener('change', () => { it.edit.date = dateEl.value; });
      const titleEl = it.edit.title !== undefined
        ? h('input', { type: 'text', maxlength: 80, value: it.edit.title || '', placeholder: '选填：这一段具体做什么', 'aria-label': `这一段做什么：${it.title}` })
        : null;
      if (titleEl) titleEl.addEventListener('input', () => {
        it.edit.title = titleEl.value;
        if (titleNode) titleNode.textContent = titleEl.value.trim() || it.title;
      });
      edits = h('div', {},
        titleEl ? h('div', { class: 'field', style: 'margin:0' },
          h('label', { text: '这一段做什么（选填，不填就只按时间算）' }), titleEl) : null,
        h('div', { class: 'field-row', style: 'margin-top:5px' }, fieldRow('预计分钟', minEl), fieldRow('到期日期', dateEl)));
    } else if (it.edit && it.kind === 'plan') {
      const dateEl = h('input', { type: 'date', value: it.edit.date, 'aria-label': '日期' });
      const startEl = h('input', { type: 'time', value: it.edit.start, step: 60, 'aria-label': '开始时间' });
      const minEl = h('input', { type: 'number', min: 5, max: 480, step: 5, value: it.edit.min, 'aria-label': '分钟' });
      dateEl.addEventListener('change', () => { it.edit.date = dateEl.value; });
      startEl.addEventListener('change', () => { it.edit.start = startEl.value; });
      minEl.addEventListener('change', () => { it.edit.min = Number(minEl.value) || it.edit.min; showDuration(); });
      edits = h('div', { class: 'field-row', style: 'margin-top:5px' }, fieldRow('日期', dateEl), fieldRow('开始', startEl), fieldRow('分钟', minEl));
    }
    titleNode = h('div', { class: 'row-title', text: it.title });
    list.append(h('div', { class: 'check-row reblock-choice' },
      h('label', { class: 'reblock-check' }, cb),
      h('div', { class: 'row-main' },
        h('div', { class: 'reblock-choice-head' }, titleNode, duration),
        it.errs && it.errs.length ? h('div', { class: 'err', text: `冲突或无效：${it.errs.join('；')}（这条默认不勾）` }) : null,
        edits ? h('details', { class: 'plan-details reblock-details' },
          h('summary', { text: '查看依据与编辑' }),
          h('p', { class: 'hint note muted', text: it.detail }),
          it.basis ? h('p', { class: 'hint note muted', text: `依据：${it.basis}` }) : null,
          edits,
        ) : h('p', { class: 'hint note muted', text: it.detail }),
      ),
    ));
  }
  let applying = false;
  // 预览到确认之间，这条计划可能已在别处被改过：只拦「和打开弹层时不一样」的情况；
  // 计划页「调整」入口本来就是从已跳过的计划打开的，不能一刀切要求 scheduled
  const planStatusAtOpen = plan.status;
  const confirm = async () => {
    if (applying) return;
    if (plan.status !== planStatusAtOpen) {
      toast('这条计划已经变过', '它在你预览之后被改过，这次提案没有写入任何东西。先关闭，刷新后再看。', 'bad');
      return;
    }
    const chosen = items.filter((x) => x.keep && !x.disabled);
    if (!chosen.length) { toast('没有勾选任何提案', '先勾一条，或取消。', 'bad'); return; }
    applying = true;
    try {
      const planPrev = { status: plan.status, statusAt: plan.statusAt ?? null, blockReason: plan.blockReason ?? null, blockedAt: plan.blockedAt ?? null };
      if (!(await markBlocked(plan, reason))) {
        toast('没保存成功', '原计划没有被标为跳过，下面这些提案也一条都没写进库里。', 'bad');
        return;
      }
      const written = [];
      const failed = [];
      for (const it of chosen) {
        const r = await it.run(it);
        if (r && r._defer) written.push({ kind: 'defer', taskId: r.taskId, prevDueAt: r.prevDueAt, newDueAt: r.newDueAt, title: r.title });
        else if (r) written.push({ kind: it.kind, row: r });
        else failed.push(it.title);
      }
      if (written.some((w) => w.kind === 'task' || w.kind === 'defer')) { try { await syncDerived(); } catch (e) { /* 提醒生成失败不影响已写数据 */ } }
      // 撤销记录（只保留最近一次）：写不进去也不影响这次调整本身
      try { await db.metaSet('reblockUndo', { at: Date.now(), planId: plan.id, planPrev, written, label: plan.title, reason }); } catch (e) { /* ignore */ }
      changed('plan-reblock');
      sheet.close();
      onDone?.();
      openResultSheet({ planTitle: plan.title, reason, written, failed, unchosen: items.filter((x) => !x.keep && !x.disabled).length, onDone });
    } finally { applying = false; }
  };
  const sheet = openSheet({
    title: `「${reason}」的调整提案`,
    content: h('div', {},
      h('div', { class: 'reblock-summary' },
        h('p', { class: 'reblock-original', text: `原计划：${plan.title}` }),
        h('span', { class: 'tag', text: RULE_NOTE }),
      ),
      h('p', { class: 'hint', text: `确认后把原计划标为跳过（${reason}），只写入勾选的提案。` }),
      items.length ? list : h('p', { class: 'empty', text: '没有可采纳的提案。' }),
      note ? h('p', { class: 'hint', text: note }) : null,
    ),
    actions: [
      items.length ? countEl : null,
      h('button', { class: 'btn', onclick: () => sheet.close(), text: '取消' }),
      items.length ? h('button', { class: 'btn btn-primary', onclick: confirm, text: '确认采纳勾选的提案' }) : null,
    ],
  });
  sheet.sheet.classList.add('reblock-proposal');
  refresh();
  return sheet;
}

/** 撤销最近一次受阻重规划：只回滚当时真的写进去、且之后没被用户改过的条目。
 *  用户之后动过的条目一律保留（不覆盖新修改），返回值里报数。 */
async function undoReblock() {
  let undo;
  try { undo = await db.metaGet('reblockUndo'); } catch (e) { undo = null; }
  if (!undo) return null;
  let revoked = 0, kept = 0, planBack = false;
  for (const w of undo.written || []) {
    try {
      if (w.kind === 'plan') {
        const row = await db.get('plans', w.row.id);
        if (!row || row.status !== 'scheduled') { kept += 1; continue; }
        await db.del('plans', w.row.id);
        state.plans = state.plans.filter((x) => x.id !== w.row.id);
        revoked += 1;
      } else if (w.kind === 'task') {
        const t = await db.get('tasks', w.row.id);
        if (!t || t.status !== 'pending' || taskProgress(t).spent > 0) { kept += 1; continue; }
        await db.del('tasks', w.row.id);
        state.tasks = state.tasks.filter((x) => x.id !== w.row.id);
        revoked += 1;
      } else if (w.kind === 'defer') {
        const t = await db.get('tasks', w.taskId);
        if (!t || t.dueAt !== w.newDueAt) { kept += 1; continue; }
        t.dueAt = w.prevDueAt;
        await db.put('tasks', t);
        const mem = state.tasks.find((x) => x.id === w.taskId);
        if (mem) mem.dueAt = w.prevDueAt;
        revoked += 1;
      }
    } catch (e) { kept += 1; }
  }
  const p = await db.get('plans', undo.planId).catch(() => null);
  if (p && undo.planPrev) {
    if (p.status === 'skipped' && String(p.blockReason || '') === String(undo.reason || '')) {
      Object.assign(p, undo.planPrev);
      try { await db.put('plans', p); planBack = true; } catch (e) { kept += 1; }
      const mem = state.plans.find((x) => x.id === undo.planId);
      if (mem && planBack) Object.assign(mem, undo.planPrev);
    } else kept += 1;
  }
  try { await db.metaSet('reblockUndo', null); } catch (e) { /* ignore */ }
  try { await syncDerived(); } catch (e) { /* ignore */ }
  return { revoked, kept, planBack };
}

/** 调整结果层：原计划去向 + 新增了什么 + 哪些没安排 + 去哪继续 + 撤销入口 */
function openResultSheet({ planTitle, reason, written, failed, unchosen, onDone }) {
  const lines = [];
  for (const w of written) {
    if (w.kind === 'plan') lines.push(h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: `计划：${w.row.date} ${w.row.start} · ${w.row.min} 分钟` }), h('div', { class: 'row-meta' }, h('span', { class: 'note muted', text: w.row.title })))));
    else if (w.kind === 'task') lines.push(h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: `任务：${w.row.title}` }), h('div', { class: 'row-meta' }, h('span', { class: 'note muted', text: `预计 ${w.row.estMin} 分钟` })))));
    else if (w.kind === 'defer') lines.push(h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: `推迟任务：${w.title || ''}` }), h('div', { class: 'row-meta' }, h('span', { class: 'note muted', text: `截止改到 ${showDT(w.newDueAt)}` })))));
  }
  const rs = openSheet({
    title: '这次调整的结果',
    content: h('div', {},
      h('p', { class: 'hint', text: `原计划「${planTitle}」→ 已标为跳过（${reason}）。` }),
      written.length ? h('div', {}, ...lines) : h('p', { class: 'empty', text: '这次没有新增任何条目。' }),
      failed.length ? h('div', { class: 'warn-bar', text: `${failed.length} 条没安排（没写进库）：${failed[0]}${failed.length > 1 ? ' 等' : ''}。可以回计划页再试。` }) : null,
      unchosen ? h('p', { class: 'note muted', text: `你取消了 ${unchosen} 条提案，它们没有动。` }) : null,
      h('p', { class: 'note muted', text: '这次调整可以撤销（只保留最近一次）。要接着安排，去计划页或今日页。' }),
    ),
    actions: [
      h('button', {
        class: 'btn',
        onclick: async () => {
          const r = await undoReblock();
          rs.close();
          onDone?.();
          if (!r) { toast('没有可撤销的调整', '撤销记录只保留最近一次，已经用掉了。'); return; }
          toast('已撤销这次调整', `撤销了 ${r.revoked} 项${r.kept ? `；${r.kept} 项因为你之后改过，保留不动` : ''}。原计划${r.planBack ? '已改回计划中' : '已有新变化，没有覆盖'}。`);
        },
        text: '撤销这次调整',
      }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => { rs.close(); goPage('planner'); }, text: '去计划页' }),
      h('button', { class: 'btn btn-primary', onclick: () => { rs.close(); onDone?.(); }, text: '完成' }),
    ],
  });
  return rs;
}

/** 想休息：先选「跳过」还是「暂停」，两种都不排任何新东西 */
async function restSheet(plan, onDone) {
  const done = async (mode) => {
    if (!(await markBlocked(plan, mode))) return;
    changed('plan-blocked');
    onDone?.();
    sheet.close();
    const s = openSheet({
      title: mode === '想休息' ? '先跳过，休息一下' : '先暂停，放到一边',
      content: h('div', {},
        h('p', { class: 'empty', text: mode === '想休息'
          ? '这条今天不做了，已经标为跳过。跳过不是失败，是你在照顾自己的状态。'
          : '这条先暂停，不占今天的时间。之后可以在计划页这条上点「调整」，把它改个时间继续。' }),
        h('p', { class: 'hint', text: '可以离开屏幕喝口水、走两步。想说说为什么累，树洞在那边——它不催你学习。' }),
      ),
      actions: [
        h('button', { class: 'btn', onclick: () => s.close(), text: '先休息' }),
        h('button', { class: 'btn btn-primary', onclick: () => { s.close(); openAs('mentor'); goPage('assistants'); }, text: '去树洞聊聊' }),
      ],
    });
  };
  const sheet = openSheet({
    title: '想休息一下',
    content: h('div', {},
      h('p', { class: 'hint', text: '这条先不做了，不排任何新东西。选一种方式把它放下。' }),
      h('button', {
        class: 'btn btn-block', style: 'margin-bottom:6px;text-align:left',
        onclick: () => done('想休息'),
      }, h('b', { text: '跳过今天这条' }), h('span', { style: 'display:block;font-size:var(--fs-2);color:var(--ink-dim);font-weight:400', text: '标记为跳过，关联任务不动。' })),
      h('button', {
        class: 'btn btn-block', style: 'text-align:left',
        onclick: () => done('想休息·暂停'),
      }, h('b', { text: '暂停（先放着）' }), h('span', { style: 'display:block;font-size:var(--fs-2);color:var(--ink-dim);font-weight:400', text: '标记为暂停，之后在计划页这条上点「调整」改时间继续。' })),
    ),
    actions: [h('button', { class: 'btn', onclick: () => sheet.close(), text: '取消' })],
  });
}

/** 入口：今日页「没做完？」与计划页已跳过行的「调整」都开这里 */
export function reblockSheet(plan, { onDone } = {}) {
  const task = plan.taskId ? state.tasks.find((t) => t.id === plan.taskId) || null : null;
  const pick = (key) => {
    sheet.close();
    if (key === '不想回答') {
      if (task) deferSheet(task); else editPlan(plan, { onSaved: () => onDone?.() });
      return;
    }
    if (key === '想休息') { restSheet(plan, onDone); return; }
    const built = key === '没时间' ? noTimeItems(plan, task) : key === '不会做' ? stuckItems(plan, task) : bigItems(plan, task);
    proposalSheet(plan, key, built, onDone);
  };
  const sheet = openSheet({
    title: '这条没做完？',
    content: h('div', {},
      h('div', { class: 'row' },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: plan.title }),
          h('div', { class: 'row-meta' },
            h('span', { class: 'tag', text: `${plan.date} ${plan.start} · ${plan.min} 分钟` }),
            task ? h('span', { class: 'tag', text: `关联任务：${task.title}`.slice(0, 36) }) : h('span', { class: 'tag', text: '没有关联任务' }),
          ),
        ),
      ),
      h('p', { class: 'hint', text: '选一个最接近的原因。调整提案由本机规则算出，勾选确认后才写进本机库；原任务不会删。' }),
      h('div', {}, ...REASONS.map((r) => h('button', {
        class: 'btn btn-block', style: 'margin-bottom:6px;text-align:left',
        onclick: () => pick(r.key),
      }, h('b', { text: r.key }), h('span', { style: 'display:block;font-size:var(--fs-2);color:var(--ink-dim);font-weight:400', text: r.desc })))),
    ),
    actions: [h('button', { class: 'btn', onclick: () => sheet.close(), text: '取消' })],
  });
  return sheet;
}
