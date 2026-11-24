// 共用编辑器：任务 / 课程 / 计划条目的表单与行操作
import * as db from './store.js';
import { state, planStatus, taskProgress, spentMinForPlan, goalById, splitChildrenOf } from './state.js';
import { h, icon, field, openSheet, selectEl, confirmSheet, toast, toMin, ymd, pad2, DOW, PRIO_LABEL, PLAN_STATUS_LABEL, parseLocal, fmtDateTime, WEEK_MAX } from './ui.js';
import { syncDerived } from './remind.js';
import { validateSlot } from './schedule.js';

export function changed(reason = '') {
  document.dispatchEvent(new CustomEvent('xj:changed', { detail: { reason } }));
}

/** 写本机库失败必须让用户看见：点「保存」没反应、或界面显示已保存而库里其实没落盘，
 *  都比一句明确的「空间满了」更糟。返回 false 时调用方不要改内存、不要关弹层、不要报成功。 */
export async function writeRow(fn) {
  try { await fn(); return true; }
  catch (e) {
    toast('没保存成功', (e && e.message) || '这台设备的存储写不进去（可能是空间满了）。刚才填的内容还留在这一页上。');
    return false;
  }
}

const dtVal = (v) => (v ? String(v).slice(0, 16) : '');
const dtFromMs = (ms) => {
  const d = new Date(ms);
  return `${ymd(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// ---------- 任务 ----------
export function editTask(initial = null, { onClose } = {}) {
  const t = initial || { title: '', subject: '', dueAt: '', estMin: 30, priority: 'medium', note: '', status: 'pending' };
  const fTitle = field('任务内容（写小一点更容易开始）', h('input', { value: t.title, placeholder: '例：高数课后题只做第 1、2 题', maxlength: 80, dataset: { autofocus: '' } }), { id: 'tf-title', hint: '小到 15 分钟能起步，就成功了。' });
  const fSubject = field('关联科目（选填）', h('input', { value: t.subject || '', list: 'subject-list', maxlength: 30 }), { id: 'tf-subject' });
  const fDue = field('截止时间（选填）', h('input', { type: 'datetime-local', value: dtVal(t.dueAt) }), { id: 'tf-due' });
  const fEst = field('预计时长（分钟）', h('input', { type: 'number', min: 5, max: 600, step: 5, value: t.estMin ?? 30 }), { id: 'tf-est' });
  const fPrio = field('优先级', selectEl([
    { value: 'high', label: '优先' }, { value: 'medium', label: '普通' }, { value: 'low', label: '随缘' },
  ], t.priority || 'medium'), { id: 'tf-prio' });
  const fNote = field('给自己的一句话（选填）', h('input', { value: t.note || '', placeholder: '例：做完前 3 题就算胜利', maxlength: 60 }), { id: 'tf-note' });

  const dl = h('datalist', { id: 'subject-list' }, ...[...new Set(state.tasks.map((x) => x.subject).filter(Boolean))].map((s) => h('option', { value: s })));

  const save = async () => {
    const title = fTitle.el.querySelector('input').value.trim();
    if (!title) { fTitle.error('请至少写下要做什么'); return; }
    const est = Number(fEst.el.querySelector('input').value);
    if (est && (est < 5 || est > 600)) { fEst.error('预计时长请在 5–600 分钟之间'); return; }
    const dueRaw = fDue.el.querySelector('input').value;
    if (dueRaw && parseLocal(dueRaw) === null) { fDue.error('截止时间格式不对'); return; }
    // 新建或主动改成一个过去的时间会被拦；编辑一条本来就逾期的任务、不动截止时间时放行，
    // 否则示例数据里的逾期任务连标题都改不了。补录过去的事直接留空截止即可。
    const duePts = dueRaw ? parseLocal(dueRaw) : null;
    const prevPts = t.dueAt ? parseLocal(t.dueAt) : null;
    if (duePts !== null && duePts < Date.now() && duePts !== prevPts) {
      fDue.error('这个截止时间已经过去了，请改成还没到的时间；要做的事已经发生过，截止留空就行');
      return;
    }
    const obj = {
      id: t.id || db.uid(),
      title,
      subject: fSubject.el.querySelector('input').value.trim(),
      dueAt: dueRaw || '',
      estMin: est || 30,
      priority: fPrio.el.querySelector('select').value,
      note: fNote.el.querySelector('input').value.trim(),
      status: t.status || 'pending',
      doneAt: t.doneAt || null,
      // 目标归属、复习计划和来源必须跟着这次保存走：目标页「在这个目标下加一条任务」
      // 就是把 goalId 放在 initial 里传进来的，这里漏掉就会写出一条游离任务，目标进度长不出来。
      goalId: t.goalId || null,
      reviewDays: t.reviewDays || null,
      addedBy: t.addedBy || 'manual',
      selfRating: t.selfRating || null,
      // 受阻拆分的来源标记要留住：改一条拆出来的任务不该把它变成无来源的普通任务
      splitFrom: t.splitFrom || null,
      splitKind: t.splitKind || null,
      // 复习段之间的来源链要留住：编辑一条复习任务不该让它变成普通任务，否则会重复排复习
      ...(t.reviewOf ? { reviewOf: t.reviewOf } : {}),
      ...(t.reviewAnchor ? { reviewAnchor: t.reviewAnchor } : {}),
      // 路线段归属同理：编辑任务不该把它从目标路线的某一段里悄悄踢出去
      stageId: t.stageId || null,
      // 示例数据的标记也要留住：改过一条示例任务就把它算成你自己的历史，校准的口径就假了
      ...(t.demo ? { demo: t.demo } : {}),
      createdAt: t.createdAt || new Date().toISOString(),
    };
    if (!(await writeRow(() => db.put('tasks', obj)))) return;
    const idx = state.tasks.findIndex((x) => x.id === obj.id);
    if (idx >= 0) state.tasks[idx] = obj; else state.tasks.push(obj);
    await syncDerived();
    sheet.close();
    changed('task-save');
    toast(initial?.id ? '任务已更新' : '任务已添加', obj.title);
  };

  const sheet = openSheet({
    title: initial?.id ? '编辑任务' : '添加任务',
    content: h('div', {}, dl, fTitle.el, fSubject.el, fDue.el, fEst.el, fPrio.el, fNote.el),
    actions: [
      h('button', { class: 'btn', onclick: () => { sheet.close(); onClose?.(); }, text: '取消' }),
      h('button', { class: 'btn btn-primary', onclick: save, text: '保存' }),
    ],
  });
  return sheet;
}

export async function deferTask(t, ms) {
  const prev = t.dueAt;
  t.dueAt = dtFromMs(ms);
  if (!(await writeRow(() => db.put('tasks', t)))) { t.dueAt = prev; return; }
  await syncDerived();
  changed('task-defer');
  toast('已推迟', `${t.title} → ${fmtDateTime(ms)}`);
}
export function deferSheet(t) {
  const base = parseLocal(t.dueAt) || Date.now();
  const opts = [
    { label: '推迟到今天晚上 21:30', at: () => { const d = new Date(); d.setHours(21, 30, 0, 0); return d.getTime(); } },
    { label: '推迟 3 小时', at: () => base + 3 * 3600e3 },
    { label: '推迟到明天同一时间', at: () => base + 864e5 },
    { label: '推迟到本周末（周六 15:00）', at: () => { const d = new Date(); d.setDate(d.getDate() + ((5 - ((d.getDay() + 6) % 7) + 7) % 7)); d.setHours(15, 0, 0, 0); return d.getTime(); } },
  ];
  const picker = h('input', { type: 'datetime-local', value: dtFromMs(base + 864e5) });
  const api = openSheet({
    title: `推迟「${t.title}」`,
    content: h('div', {},
      h('p', { class: 'empty', text: `当前截止：${t.dueAt ? fmtDateTime(base) : '未设置'}` }),
      ...opts.map((o) => h('button', {
        class: 'btn btn-block', style: 'margin-bottom:6px;text-align:left',
        onclick: async () => { await deferTask(t, o.at()); api.close(); }, text: o.label,
      })),
      h('div', { class: 'field' }, h('label', { text: '或者自选时间' }), picker),
      h('button', {
        class: 'btn', text: '用这个时间',
        onclick: async () => { const ms = parseLocal(picker.value); if (!ms) return; await deferTask(t, ms); api.close(); },
      }),
    ),
  });
  return api;
}

// ---------- 学习自评：用户自己的记录，与完成状态分开存、分开看 ----------
export const SELF_RATING = { clear: '能自己讲清楚', practice: '需要继续练习', unclear: '暂时没理解' };
export const SELF_RATING_NOTE = '你自己的学习记录 · 不是 AI 诊断';

export function selfRatingSheet(t, onDone) {
  const set = async (val) => {
    const next = { ...t, selfRating: val };
    if (!(await writeRow(() => db.put('tasks', next)))) return;
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tasks[i] = next;
    sheet.close();
    changed('task-selfrating');
    onDone?.();
    toast(val ? '自评已记下' : '自评已清除', val ? `「${t.title}」→ ${SELF_RATING[val]}` : `「${t.title}」不再有自评。`);
  };
  const sheet = openSheet({
    title: `学习自评：${t.title}`.slice(0, 40),
    content: h('div', {},
      h('p', { class: 'hint', text: '这是你自己对这次学习的记录，不是 AI 诊断，也不是客观掌握度。它和「已完成」分开存、分开看；后面的建议可以参考它，但不会替你改计划。' }),
      ...Object.entries(SELF_RATING).map(([val, label]) => h('button', {
        class: 'btn btn-block', style: 'margin-bottom:6px;text-align:left',
        onclick: () => set(val),
      }, h('b', { text: label }))),
      h('button', { class: 'btn btn-block btn-ghost', style: 'text-align:left', onclick: () => set(null), text: '暂不评价（清除）' }),
    ),
    actions: [h('button', { class: 'btn', onclick: () => sheet.close(), text: '取消' })],
  });
  return sheet;
}

// 刚勾掉的那一条：只有「未完成 → 完成」会画那一笔，改回未做或编辑保存都不算
let justDoneId = null;
const takeJustDone = (id) => (justDoneId === id ? (justDoneId = null, true) : false);

/** 一组写操作按顺序做，任何一步没落盘就停下来：宁可少删几条，也不要库里剩一半、内存里全没了。 */
async function writeAll(fns) {
  for (const fn of fns) if (!(await writeRow(fn))) return false;
  return true;
}

export async function toggleTaskDone(t, done = null) {
  const wasDone = t.status === 'done';
  const prev = { status: t.status, doneAt: t.doneAt };
  t.status = done === null ? (t.status === 'done' ? 'pending' : 'done') : (done ? 'done' : 'pending');
  t.doneAt = t.status === 'done' ? new Date().toISOString() : null;
  if (!(await writeRow(() => db.put('tasks', t)))) {
    // 库里没动，内存也改回去，免得界面显示「已做完」而下次打开又变回未做
    t.status = prev.status;
    t.doneAt = prev.doneAt;
    return;
  }
  await syncDerived();
  if (!wasDone) justDoneId = t.id;
  changed('task-toggle');
  if (t.status === 'done') toast('做完了', t.title);
}

export async function removeTask(t) {
  const ok = await confirmSheet({ title: '删除任务', message: `「${t.title}」删除后无法恢复，相关的计划条目和未响的提醒也会一起删除。`, confirmText: '删除', danger: true });
  if (!ok) return;
  const wrote = await writeRow(() => db.removeTaskCascade(t.id));
  if (!wrote) return;
  state.tasks = state.tasks.filter((x) => x.id !== t.id);
  state.plans = state.plans.filter((p) => p.taskId !== t.id);
  state.reminders = state.reminders.filter((r) => !(r.refId === t.id && r.status === 'active'));
  changed('task-remove');
  toast('已删除任务', t.title);
}

/** 任务投入进度：条形最长 100%，超出预计只标注不再变长，剩余时间不会出现负数 */
function progressLine(pr) {
  const pct = Math.min(100, Math.round((pr.spent / pr.est) * 100));
  return h('div', { class: 'bar-row bar-sm' },
    h('span', { text: `${pr.spent}/${pr.est} 分` }),
    h('div', { class: `bar${pr.over ? ' over' : ''}` }, h('i', { style: `width:${pct}%` })),
    h('span', { class: 'bar-val', text: pr.over ? `已超出 ${pr.spent - pr.est} 分钟` : `还差 ${pr.remaining} 分钟` }),
  );
}

/** 任务行的次级操作（排复习/推迟/编辑/删除）收进底部动作单：手机上四颗小图标并排会挤成一片。
    行上只留「完成/未做」与「更多」；自评改成行内一颗可点的自评胶囊，状态可见也点得到。 */
function taskOpsSheet(t, extras = []) {
  let sheet;
  const act = (label, ic, run, cls = '', aria = label) => h('button', {
    type: 'button', class: `btn btn-ghost ops-item${cls}`.trim(), 'aria-label': aria,
    onclick: () => { sheet.close(); run(); },
  }, icon(ic), h('span', { text: label }));
  sheet = openSheet({
    title: '任务操作',
    content: h('div', { class: 'ops-list' },
      h('p', { class: 'ops-task', text: t.title }),
      ...extras.map((x) => act(x.label, x.icon, x.run, '', x.aria || x.label)),
      act('推迟截止时间', 'clock', () => deferSheet(t)),
      act('编辑任务', 'edit', () => editTask(t)),
      act('删除任务', 'trash', () => removeTask(t), ' ops-danger'),
    ),
  });
}

export function taskRow(t, { showOps = true, sheetOps = [] } = {}) {
  const overdue = t.status !== 'done' && parseLocal(t.dueAt) && parseLocal(t.dueAt) < Date.now();
  const pr = taskProgress(t);
  const just = takeJustDone(t.id);
  const kids = splitChildrenOf(t.id);
  const parentTask = t.splitFrom ? state.tasks.find((x) => x.id === t.splitFrom) : null;
  // 「已投入 x/y 分钟」不在这里再放一颗胶囊：进度条自身左侧已经写着 x/y 分、右侧写着还差/超出。
  return h('div', { class: `row${t.status === 'done' ? ' done' : ''}${just ? ' xj-just' : ''}` },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title', text: t.title }),
      h('div', { class: 'row-meta' },
        h('span', { class: `tag p-${t.priority} tag-soft`, text: PRIO_LABEL[t.priority] || t.priority }),
        t.subject ? h('span', { class: 'tag tag-soft', text: t.subject }) : null,
        t.dueAt ? h('span', { class: overdue ? 'tag bad' : 'tag tag-soft', text: `${overdue ? '已逾期 ' : '截止 '}${fmtDateTime(t.dueAt)}` }) : null,
        kids.length ? h('span', { class: 'tag', text: `已拆成 ${kids.length} 段 · 段合计 ${kids.reduce((n, k) => n + (Number(k.estMin) || 0), 0)} 分钟` }) : null,
        parentTask ? h('span', { class: 'tag', text: `拆自「${parentTask.title}」` }) : null,
        Array.isArray(t.reviewDays) && t.reviewDays.length ? h('span', { class: 'tag', text: `已排 ${t.reviewDays.length} 次复习` }) : null,
        t.goalId ? h('span', { class: 'tag', text: goalById(t.goalId) ? `属于「${goalById(t.goalId).title}」` : '属于一个已删除的目标' }) : null,
        pr.hasEst && !pr.spent ? h('span', { class: 'tag tag-soft', text: `预计 ${pr.est} 分钟` }) : null,
        t.status === 'done' ? h('span', { class: 'tag ok', text: '已完成' }) : null,
        t.status === 'done' ? h('button', {
          type: 'button', class: `${t.selfRating ? 'tag' : 'tag warn'} tag-btn`, 'aria-label': '学习自评',
          onclick: () => selfRatingSheet(t),
        }, t.selfRating ? `自评：${SELF_RATING[t.selfRating] || t.selfRating}` : '自评：未评价') : null,
      ),
      pr.hasEst && pr.spent > 0 ? h('div', { class: 'row-meta' }, progressLine(pr)) : null,
      t.note ? h('div', { class: 'row-meta', text: t.note }) : null,
    ),
    showOps ? h('div', { class: 'row-ops' },
      h('button', { class: 'icon-btn', title: t.status === 'done' ? '标记未做' : '标记完成', onclick: () => toggleTaskDone(t), 'aria-label': t.status === 'done' ? '标记未做' : '标记完成' }, icon('check')),
      h('button', { class: 'icon-btn', title: '更多操作', 'aria-label': '更多操作', 'aria-haspopup': 'dialog', onclick: () => taskOpsSheet(t, sheetOps) }, icon('dots')),
    ) : null,
  );
}

// ---------- 课程 ----------
export function editCourse(initial = null) {
  const c = initial || { name: '', day: 1, start: '08:00', end: '09:40', location: '', teacher: '', weekStart: 1, weekEnd: 16, parity: 'all' };
  const fName = field('课程名称', h('input', { value: c.name, maxlength: 30, dataset: { autofocus: '' } }), { id: 'cf-name' });
  const fDay = field('星期', selectEl(DOW.map((label, i) => ({ value: String(i + 1), label })), String(c.day), { id: 'cf-day' }));
  const fStart = field('开始时间', h('input', { type: 'time', value: c.start, step: 300 }), { id: 'cf-start' });
  const fEnd = field('结束时间', h('input', { type: 'time', value: c.end, step: 300 }), { id: 'cf-end' });
  const fLoc = field('地点（选填）', h('input', { value: c.location || '', maxlength: 30 }), { id: 'cf-loc' });
  const fTeacher = field('老师（选填）', h('input', { value: c.teacher || '', maxlength: 20 }), { id: 'cf-teacher' });
  const fWs = field('起始周', h('input', { type: 'number', min: 1, max: WEEK_MAX, value: c.weekStart || 1 }), { id: 'cf-ws' });
  const fWe = field('结束周', h('input', { type: 'number', min: 1, max: WEEK_MAX, value: c.weekEnd || 16 }), { id: 'cf-we' });
  const fParity = field('单双周', selectEl([
    { value: 'all', label: '每周都上' }, { value: 'odd', label: '单周（与起始周同奇偶）' }, { value: 'even', label: '双周' },
  ], c.parity || 'all'), { id: 'cf-parity' });

  const save = async () => {
    const name = fName.el.querySelector('input').value.trim();
    if (!name) { fName.error('请填写课程名称'); return; }
    const start = fStart.el.querySelector('input').value;
    const end = fEnd.el.querySelector('input').value;
    if (!start || !end) { (start ? fEnd : fStart).error('请选择起止时间'); return; }
    if (toMin(end) <= toMin(start)) { fEnd.error('结束时间必须晚于开始时间'); return; }
    const ws = Number(fWs.el.querySelector('input').value) || 1;
    const we = Number(fWe.el.querySelector('input').value) || ws;
    if (we < ws) { fWe.error('结束周不能早于起始周'); return; }
    const obj = {
      id: c.id || db.uid(),
      name,
      day: Number(fDay.el.querySelector('select').value),
      start, end,
      location: fLoc.el.querySelector('input').value.trim(),
      teacher: fTeacher.el.querySelector('input').value.trim(),
      weekStart: ws, weekEnd: Math.min(we, WEEK_MAX), parity: fParity.el.querySelector('select').value,
      // 示例标记跟着课程走：编辑一门示例课不该把它算成用户自己的历史
      ...(c.demo ? { demo: c.demo } : {}),
      createdAt: c.createdAt || new Date().toISOString(),
    };
    const clash = state.courses.filter((x) => x.id !== obj.id && x.day === obj.day)
      .filter((x) => toMin(x.start) < toMin(obj.end) && toMin(x.end) > toMin(obj.start));
    if (clash.length) {
      const ok = await confirmSheet({
        title: '这个时间段已经有课',
        message: `与「${clash.map((x) => `${x.name} ${x.start}-${x.end}`).join('、')}」重叠。仍要保存吗？（课表会并排显示，不会互相覆盖）`,
        confirmText: '仍然保存',
      });
      if (!ok) return;
    }
    if (!(await writeRow(() => db.put('courses', obj)))) return;
    const idx = state.courses.findIndex((x) => x.id === obj.id);
    if (idx >= 0) state.courses[idx] = obj; else state.courses.push(obj);
    state.courses.sort((a, b) => a.day - b.day || toMin(a.start) - toMin(b.start));
    await syncDerived();
    sheet.close();
    changed('course-save');
    toast(initial?.id ? '课程已更新' : '课程已添加', `${obj.name} ${DOW[obj.day - 1]} ${obj.start}-${obj.end}`);
  };

  const sheet = openSheet({
    title: initial?.id ? '编辑课程' : '添加课程',
    content: h('div', {},
      fName.el,
      h('div', { class: 'field-row' }, fDay.el, fStart.el, fEnd.el),
      h('div', { class: 'field-row' }, fLoc.el, fTeacher.el),
      h('div', { class: 'field-row' }, fWs.el, fWe.el, fParity.el),
    ),
    actions: [
      h('button', { class: 'btn', onclick: () => sheet.close(), text: '取消' }),
      h('button', { class: 'btn btn-primary', onclick: save, text: '保存' }),
    ],
  });
  return sheet;
}

export async function removeCourse(c) {
  const ok = await confirmSheet({ title: '删除课程', message: `确定删除「${c.name}」？这不会影响已生成的学习计划。`, confirmText: '删除', danger: true });
  if (!ok) return;
  const wrote = await writeAll([
    () => db.del('courses', c.id),
    ...state.reminders.filter((r) => r.kind === 'course' && r.refId === c.id).map((r) => () => db.del('reminders', r.id)),
  ]);
  if (!wrote) return;
  state.courses = state.courses.filter((x) => x.id !== c.id);
  state.reminders = state.reminders.filter((r) => !(r.kind === 'course' && r.refId === c.id));
  changed('course-remove');
  toast('已删除课程', c.name);
}

export function courseSheet(c) {
  const openSheetApi = openSheet({
    title: c.name,
    content: h('div', {},
      h('div', { class: 'kv' }, h('b', { text: '时间' }), h('span', { text: `${DOW[c.day - 1]} ${c.start}–${c.end}` })),
      h('div', { class: 'kv' }, h('b', { text: '地点' }), h('span', { text: c.location || '未填写' })),
      h('div', { class: 'kv' }, h('b', { text: '老师' }), h('span', { text: c.teacher || '未填写' })),
      h('div', { class: 'kv' }, h('b', { text: '周次' }), h('span', { text: `第 ${c.weekStart}–${c.weekEnd} 周` })),
      h('div', { class: 'kv' }, h('b', { text: '单双周' }), h('span', { text: { all: '每周', odd: '单周', even: '双周' }[c.parity || 'all'] })),
    ),
    actions: [
      h('button', { class: 'btn', onclick: () => { openSheetApi.close(); editCourse(c); }, text: '编辑' }),
      h('button', { class: 'btn btn-danger', onclick: async () => { openSheetApi.close(); await removeCourse(c); }, text: '删除' }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-ghost', onclick: () => openSheetApi.close(), text: '关闭' }),
    ],
  });
  return openSheetApi;
}

// ---------- 计划条目 ----------
export function editPlan(initial = null, { onSaved } = {}) {
  const p = initial || { taskId: null, title: '', date: ymd(new Date()), start: '19:00', min: 30 };
  const isEdit = Boolean(initial?.id);
  const spent = isEdit ? spentMinForPlan(p.id) : 0;
  const fTitle = field('做什么', h('input', { value: p.title, maxlength: 60, dataset: { autofocus: '' } }), { id: 'pf-title' });
  const fDate = field('日期', h('input', { type: 'date', value: p.date }), { id: 'pf-date' });
  const fStart = field('开始时间', h('input', { type: 'time', value: p.start, step: 60 }), { id: 'pf-start' });
  const fMin = field('时长（分钟）', h('input', { type: 'number', min: 5, max: 480, step: 1, value: p.min }), { id: 'pf-min' });
  const fStatus = isEdit ? field('状态', selectEl([
    { value: 'scheduled', label: PLAN_STATUS_LABEL.scheduled },
    { value: 'done', label: PLAN_STATUS_LABEL.done },
    { value: 'skipped', label: PLAN_STATUS_LABEL.skipped },
  ], planStatus(p)), {
    id: 'pf-status',
    hint: spent
      ? `这条已关联 ${spent} 分钟专注记录。改状态不会删除、也不会重算这些记录。`
      : '改成已完成或已跳过，这段时间就不再占用你的日程。',
  }) : null;
  const live = h('div', { class: 'note muted', text: '会自动检查与课程、午休、晚餐、已排计划的冲突。' });

  const check = () => {
    // 关联任务的截止时间由表单这一侧直接给：新建时还没有计划行，程序只能从这儿拿到它
    const linked = p.taskId ? state.tasks.find((x) => x.id === p.taskId) : null;
    const errs = validateSlot({
      date: fDate.el.querySelector('input').value,
      start: fStart.el.querySelector('input').value,
      min: Number(fMin.el.querySelector('input').value),
      ignoreId: p.id || null,
      dueAt: linked?.dueAt || null,
    });
    live.className = errs.length ? 'err' : 'note muted';
    live.textContent = errs.length ? `冲突或无效：${errs.join('；')}` : '这个时间段是空的，可以安排。';
    return errs;
  };
  for (const el of [fDate.el, fStart.el, fMin.el]) el.addEventListener('input', check);
  check();

  const save = async () => {
    const title = fTitle.el.querySelector('input').value.trim();
    if (!title) { fTitle.error('请填写这条计划的内容'); return; }
    const errs = check();
    if (errs.length) { toast('这条安排有问题', errs[0], 'bad'); return; }
    const status = isEdit ? fStatus.el.querySelector('select').value : 'scheduled';
    const dateVal = fDate.el.querySelector('input').value;
    const startVal = fStart.el.querySelector('input').value;
    const minVal = Number(fMin.el.querySelector('input').value);
    // 依据描述的是排程那一刻的事实：时间三要素任何一项被手改就失效，只改标题/状态则原样保留
    const timeChanged = !isEdit || p.date !== dateVal || p.start !== startVal || Number(p.min) !== minVal;
    const obj = {
      id: p.id || db.uid(),
      taskId: p.taskId || null,
      title,
      date: dateVal,
      start: startVal,
      min: minVal,
      status,
      statusAt: status === 'scheduled' ? null : (p.statusAt || new Date().toISOString()),
      batch: p.batch || null,
      source: p.source || 'manual',
      basis: timeChanged ? null : (p.basis || null),
      blockReason: p.blockReason || null,
      blockedAt: p.blockedAt || null,
      createdAt: p.createdAt || new Date().toISOString(),
      // 手改过的计划留个时间戳：撤销上一批时据此跳过，不把用户之后的修改一起删掉
      ...(isEdit ? { updatedAt: new Date().toISOString() } : {}),
    };
    if (!(await writeRow(() => db.put('plans', obj)))) return;
    const idx = state.plans.findIndex((x) => x.id === obj.id);
    if (idx >= 0) state.plans[idx] = obj; else state.plans.push(obj);
    sheet.close();
    onSaved?.(obj);
    changed('plan-save');
    toast(initial?.id ? '已修改这条计划' : '已加入计划', `${obj.date} ${obj.start} · ${obj.min} 分钟 · ${PLAN_STATUS_LABEL[obj.status]}`);
  };

  const sheet = openSheet({
    title: initial?.id ? '修改这条计划' : '手动加一条计划',
    content: h('div', {}, fTitle.el, h('div', { class: 'field-row' }, fDate.el, fStart.el, fMin.el), fStatus?.el, live),
    actions: [
      h('button', { class: 'btn', onclick: () => sheet.close(), text: '取消' }),
      h('button', { class: 'btn btn-primary', onclick: save, text: '保存' }),
    ],
  });
  return sheet;
}

/** 只改一条计划的状态；重复设成同一状态不写入，也不会刷新 statusAt。
 *  返回 true=写进去了，false=本来就是那个状态，null=没落盘（内存已改回来，调用方别说成功）。 */
export async function setPlanStatus(p, status, { silent = false } = {}) {
  const next = status === 'done' || status === 'skipped' ? status : 'scheduled';
  if (planStatus(p) === next) return false;
  const prev = { status: p.status, statusAt: p.statusAt };
  p.status = next;
  p.statusAt = next === 'scheduled' ? null : new Date().toISOString();
  if (!(await writeRow(() => db.put('plans', p)))) {
    p.status = prev.status;
    p.statusAt = prev.statusAt;
    return null;
  }
  if (!silent) changed('plan-status');
  return true;
}

/** 计划条目的三态开关：计划中 / 已完成 / 已跳过，点同一个状态不会重复写入 */
export function planStatusPills(p, onDone) {
  const cur = planStatus(p);
  return h('div', { class: 'status-pills' }, ...['scheduled', 'done', 'skipped'].map((st) => h('button', {
    class: 'pill pill-sm',
    'aria-pressed': cur === st ? 'true' : 'false',
    title: `把这条标记为${PLAN_STATUS_LABEL[st]}`,
    onclick: async () => {
      const res = await setPlanStatus(p, st, { silent: true });
      if (res === null) { onDone?.(); return; }   // 没保存成功：原因已经由 writeRow 说过，这里不再报喜
      toast(res ? '状态已更新' : '状态没有变化', res
        ? `${p.title} → ${PLAN_STATUS_LABEL[st]}。完成数和完成率会立刻跟着变。`
        : `这条本来就是「${PLAN_STATUS_LABEL[st]}」，没有重复写入。`);
      onDone?.();
    },
    text: PLAN_STATUS_LABEL[st],
  })));
}

export async function removePlan(p) {
  const linked = state.sessions.filter((x) => x.planId === p.id).length;
  const ok = await confirmSheet({
    title: '删除这条计划',
    message: `删除「${p.date} ${p.start} · ${p.title}」？${linked ? `关联的 ${linked} 条专注记录会保留，只会在专注页显示「计划已删除」。` : '这条计划没有关联专注记录。'}\n\n删掉后会在本机存一份快照，计划页可以恢复一次（只保留最近删除的那一条）。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  // 快照写不进去就先别删：确认框里承诺了「可以恢复一次」，落空的恢复比不删更糟
  if (!(await writeRow(() => db.metaSet('lastDeletedPlan', { plan: p, linked, deletedAt: new Date().toISOString() })))) return;
  if (!(await writeRow(() => db.del('plans', p.id)))) return;
  state.plans = state.plans.filter((x) => x.id !== p.id);
  changed('plan-remove');
  toast('已删除计划', linked ? `${linked} 条专注记录仍在，累计时长不受影响。想收回可以去计划页点「恢复刚才删除的计划」。` : `${p.title} · 想收回可以去计划页点「恢复刚才删除的计划」。`);
}
