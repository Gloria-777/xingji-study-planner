// 任务：新增、编辑、完成、推迟、删除；筛选与排序；间隔复习模板
import * as db from '../store.js';
import { state, pendingTasks, overdueTasks, effectiveTasks } from '../state.js';
import { h, icon, clear, selectEl, parseLocal, ymd, openSheet, confirmSheet, toast } from '../ui.js';
import { editTask, taskRow, changed } from '../forms.js';

let filter = 'all';
let sort = 'due';
let q = '';

// 间隔复习的天数序列是这条模板里唯一的「主张」：学完那天往后 1/2/4/7/15 天各碰一次。
// 它不调用任何 AI，也不猜你掌握得怎么样——只把日期排出来，每一段都能改日期、取消勾选。
// 自评会调默认间隔：能讲清楚 → 拉长；需要练习 / 暂时没理解 → 加密。仍是预览，逐条可改。
const REVIEW_SPANS = { none: [1, 2, 4, 7, 15], clear: [1, 3, 7, 14, 21], practice: [1, 2, 3, 5, 8], unclear: [1, 2, 3, 5, 8] };
const REVIEW_SPAN_LABEL = { clear: '自评「能自己讲清楚」→ 默认间隔拉长', practice: '自评「需要继续练习」→ 默认间隔加密', unclear: '自评「暂时没理解」→ 默认间隔加密' };
const REVIEW_NOTE = '间隔复习模板 · 未调用 AI';

function addDays(ds, n) {
  const d = new Date(`${ds}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

function reviewSheet(base, onDone) {
  const anchor0 = base.status === 'done' && base.doneAt
    ? String(base.doneAt).slice(0, 10)
    : ymd(new Date());
  const fAnchor = h('input', { type: 'date', value: anchor0, 'aria-label': '学完的那一天' });
  const fMin = h('input', { type: 'number', min: 5, max: 120, step: 5, value: 20, 'aria-label': '每次复习几分钟' });
  const listBox = h('div', { class: 'check-list' });
  let draft = [];

  const rebuild = () => {
    const a = fAnchor.value || anchor0;
    const min = Math.max(5, Math.min(120, Number(fMin.value) || 20));
    const spans = (base.selfRating && REVIEW_SPANS[base.selfRating]) || REVIEW_SPANS.none;
    draft = spans.map((span, i) => ({
      keep: true, span, i,
      title: `复习：${base.title}（第 ${i + 1} 次 · 距学完 ${span} 天）`,
      date: addDays(a, span),
      min,
    }));
    clear(listBox);
    for (const d of draft) {
      const cb = h('input', { type: 'checkbox', checked: d.keep, 'aria-label': `保留 ${d.title}` });
      const dateEl = h('input', { type: 'date', value: d.date, 'aria-label': '复习日期' });
      const minEl = h('input', { type: 'number', min: 5, max: 120, step: 5, value: d.min, 'aria-label': '分钟' });
      cb.addEventListener('change', () => { d.keep = cb.checked; foot(); });
      dateEl.addEventListener('change', () => { d.date = dateEl.value; });
      minEl.addEventListener('change', () => { d.min = Number(minEl.value) || d.min; foot(); });
      d._el = { dateEl, minEl };
      listBox.append(h('div', { class: 'check-row' }, cb,
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: d.title }),
          h('div', { class: 'field-row', style: 'margin-top:5px' },
            h('div', { class: 'field', style: 'margin:0' }, h('label', { text: '日期', style: 'font-size:11.5px' }), dateEl),
            h('div', { class: 'field', style: 'margin:0' }, h('label', { text: '分钟', style: 'font-size:11.5px' }), minEl),
          ),
        ),
      ));
    }
    foot();
  };

  const foot = () => {
    clear(actions);
    const chosen = draft.filter((x) => x.keep);
    // 合计从输入框现读，理由和目标页 foot() 一样：change 要等失焦才落，
    // 刚打完字还没点别处时，这一行不能还显示旧数字骗人。
    const mins = chosen.reduce((n, x) => n + (Number(x._el?.minEl?.value) || x.min || 0), 0);
    actions.append(
      h('span', { class: 'tag', text: `已勾选 ${chosen.length} 段 · 合计约 ${mins} 分钟` }),
      h('span', { class: 'spacer', style: 'flex:1' }),
      h('button', { class: 'btn', onclick: () => sheet.close(), text: '先不排' }),
      h('button', { class: 'btn btn-primary', onclick: save, text: `写入勾选的 ${chosen.length} 段` }),
    );
  };

  let saving = false;
  const save = async () => {
    if (saving) return;
    const chosen = draft.filter((x) => x.keep);
    if (!chosen.length) { toast('没勾选任何一段', '至少留一段，或者先不排。', 'bad'); return; }
    const dup = state.tasks.some((x) => x.reviewOf === base.id);
    if (dup) {
      const ok = await confirmSheet({
        title: '这条已经排过复习了',
        message: `再点一次会另加 ${chosen.length} 段新的复习任务，已有的那几条不删、不改。要让新的一批取代旧的，请先去任务页把旧的删掉。`,
        confirmText: '仍然再排一批',
      });
      if (!ok) return;
    }
    saving = true;
    const written = [];
    try {
      for (const d of chosen) {
        const el = d._el || {};
        const obj = {
          id: db.uid(), title: d.title, subject: base.subject || '', dueAt: `${el.dateEl?.value || d.date}T23:59`,
          estMin: Number(el.minEl?.value) || d.min, priority: base.priority || 'medium',
          note: `间隔复习 · 源任务「${base.title}」（距学完 ${d.span} 天）`,
          status: 'pending', doneAt: null, goalId: base.goalId || null,
          reviewOf: base.id, reviewDays: null, addedBy: 'review', createdAt: new Date().toISOString(),
        };
        await db.put('tasks', obj);
        state.tasks = [...state.tasks, obj];
        written.push(obj);
      }
      const nextBase = { ...base, reviewDays: chosen.map((x) => x.span), reviewAnchor: fAnchor.value || anchor0 };
      await db.put('tasks', nextBase);
      const bi = state.tasks.findIndex((x) => x.id === base.id);
      if (bi >= 0) state.tasks[bi] = nextBase;
      sheet.close();
      changed('review-plan');
      toast(`已排入 ${written.length} 段复习`, `「${base.title}」按 1 / 2 / 4 / 7 / 15 天各碰一次。这些是任务，具体落在哪个时段仍然由计划页排。`);
      onDone?.();
    } catch (e) {
      toast('复习没排完', `${e.message || e}\n已经写好的 ${written.length} 段保留，不会因为这一段回滚。`, 'bad');
    } finally { saving = false; }
  };

  const actions = h('div', { class: 'btn-row', style: 'margin-top:12px' });
  rebuild();
  fAnchor.addEventListener('change', rebuild);
  fMin.addEventListener('input', rebuild);

  const sheet = openSheet({
    title: `给「${base.title}」排一组间隔复习`,
    wide: true,
    content: h('div', {},
      h('p', { class: 'hint', text: `锚点是「学完的那一天」，默认${base.status === 'done' ? '取这条任务完成的日子' : '取今天'}。${base.selfRating && REVIEW_SPAN_LABEL[base.selfRating] ? '有自评时默认间隔会按自评调整（见下面那行），日期和分钟逐条可改。' : '往后第 1、2、4、7、15 天各复习一次，一共 5 段，逐条可改日期或取消勾选。'}` }),
      base.selfRating && REVIEW_SPAN_LABEL[base.selfRating]
        ? h('p', { class: 'hint' }, h('span', { text: REVIEW_SPAN_LABEL[base.selfRating] }), h('span', { class: 'tag', style: 'margin-left:6px', text: REVIEW_NOTE }))
        : null,
      h('div', { class: 'field-row' },
        h('div', { class: 'field' }, h('label', { text: '学完的那一天' }), fAnchor),
        h('div', { class: 'field' }, h('label', { text: '每次几分钟' }), fMin),
      ),
      h('p', { class: 'note muted', text: `${REVIEW_NOTE}。这一排只决定「哪天复习、大概多久」，不会自动排时段，也不会替你判断「这块已经掌握了」。每一段都可以在下面改日期或取消勾选。` }),
      base.reviewDays && base.reviewDays.length ? h('p', { class: 'warn-bar', text: `这条已经排过 ${base.reviewDays.length} 次复习；再写入会另加一批，已有的那几条不删不改。` }) : null,
      listBox,
    ),
    actions: [actions],
  });
}

function reviewPicker(onDone) {
  const pool = pendingTasks().slice(0, 60);
  if (!pool.length) { toast('没有可排的任务', '先加一条任务或先勾掉一条，复习要挂在具体的任务上。'); return; }
  const fTask = selectEl(pool.map((t) => ({ value: t.id, label: `${t.title}${t.subject ? `（${t.subject}）` : ''}` })), pool[0].id, { 'aria-label': '给哪条任务排复习' });
  const sheet = openSheet({
    title: '给哪条任务排复习',
    content: h('div', {},
      h('div', { class: 'field' }, h('label', { text: '选一条任务' }), fTask),
      h('p', { class: 'hint', text: '也可以直接在任务那一行点日历图标，给那一条单独排。这里只列待做的任务（最多 60 条）。' }),
    ),
    actions: [
      h('button', { class: 'btn', onclick: () => sheet.close(), text: '取消' }),
      h('button', { class: 'btn btn-primary', onclick: () => { const t = state.tasks.find((x) => x.id === fTask.value); if (!t) return; sheet.close(); reviewSheet(t, onDone); }, text: '排复习' }),
    ],
  });
}

function bucket(t) {
  const due = parseLocal(t.dueAt);
  const now = new Date();
  const weekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).getTime();
  if (t.status === 'done') return 'done';
  if (due && due < Date.now()) return 'overdue';
  if (due && due < weekEnd) return 'week';
  return 'later';
}

export function render(root) {
  clear(root); // 页面自己也会再 render（筛选/新建后），先清空才不会和路由重绘叠成两份
  const all = state.tasks;
  const eff = effectiveTasks(all);
  const counts = {
    all: pendingTasks().length,
    overdue: overdueTasks().length,
    week: pendingTasks().filter((t) => bucket(t) === 'week').length,
    done: eff.filter((t) => t.status === 'done').length,
  };
  const computeList = () => {
    let list = all.slice();
    if (filter === 'pending') list = eff.filter((t) => t.status !== 'done');
    else if (filter === 'done') list = eff.filter((t) => t.status === 'done');
    else if (filter === 'overdue') list = eff.filter((t) => t.status !== 'done' && parseLocal(t.dueAt) < Date.now());
    else if (filter === 'week') list = eff.filter((t) => bucket(t) === 'week');
    if (q) {
      const k = q.toLowerCase();
      list = list.filter((t) => `${t.title} ${t.subject || ''} ${t.note || ''}`.toLowerCase().includes(k));
    }
    list.sort((a, b) => {
      if (filter === 'all' && (a.status === 'done') !== (b.status === 'done')) return a.status === 'done' ? 1 : -1;
      if (sort === 'title') return a.title.localeCompare(b.title, 'zh');
      if (sort === 'prio') { const r = { high: 0, medium: 1, low: 2 }; return r[a.priority] - r[b.priority]; }
      return String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999'));
    });
    return list;
  };
  const listBox = h('div', { class: 'task-list' });
  const overdueNotice = h('div', { class: 'warn-bar', hidden: true, role: 'status' });
  const draw = () => {
    const rows = computeList();
    const overdueCount = rows.filter((t) => bucket(t) === 'overdue').length;
    overdueNotice.hidden = overdueCount === 0;
    overdueNotice.textContent = overdueCount ? `当前结果有 ${overdueCount} 条任务已逾期。可以推迟，或把任务拆小一点。` : '';
    clear(listBox);
    listBox.classList.toggle('task-list-empty', rows.length === 0);
    if (!rows.length) {
      const narrowed = Boolean(q || filter !== 'all');
      listBox.append(h('div', { class: 'task-empty-content' },
        h('h3', { text: q || narrowed ? '没有符合条件的任务' : '从一件小事开始' }),
        h('p', { class: 'empty', text: q ? '没有匹配的任务，换个关键词试试。' : narrowed ? '这个筛选下还没有任务。' : '这里还是空的。先加一件 15 分钟能开始的小事。' }),
        narrowed ? h('div', { class: 'btn-row' }, h('button', {
          class: 'btn btn-sm',
          onclick: () => {
            q = ''; search.value = '';
            filter = 'all'; fSel.value = filter;
            draw();
            fSel.focus({ preventScroll: true });
          },
          text: '清除筛选',
        })) : h('button', { class: 'btn btn-primary', onclick: () => editTask(null, { onClose: () => render(root) }) }, icon('plus'), h('span', { text: '添加第一个任务' })),
      ));
    } else {
      for (const t of rows) {
        listBox.append(taskRow(t, {
          sheetOps: [{ label: '排一组复习', aria: '给这条任务排复习', icon: 'calendar', run: () => reviewSheet(t, () => render(root)) }],
        }));
      }
    }
  };

  const fSel = selectEl([
    { value: 'all', label: `全部（${all.length}）` },
    { value: 'pending', label: `待做（${counts.all}）` },
    { value: 'overdue', label: `已逾期（${counts.overdue}）` },
    { value: 'week', label: `未来 7 天（${counts.week}）` },
    { value: 'done', label: `已完成（${counts.done}）` },
  ], filter, { 'aria-label': '筛选任务' });
  fSel.addEventListener('change', () => { filter = fSel.value; draw(); });

  const sSel = selectEl([
    { value: 'due', label: '按截止时间' },
    { value: 'prio', label: '按优先级' },
    { value: 'title', label: '按名称' },
  ], sort, { 'aria-label': '任务排序' });
  sSel.addEventListener('change', () => { sort = sSel.value; draw(); });

  const search = h('input', { type: 'search', value: q, placeholder: '搜索任务、科目', 'aria-label': '搜索任务', style: 'min-width:160px' });
  search.addEventListener('input', () => { q = search.value; draw(); });


  root.append(
    h('div', { class: 'page-head' },
      h('h2', { class: 'page-title', text: '任务' }),
      h('p', { class: 'page-sub', text: '写小一点：一条任务只做一件事。点开可以完成、推迟、编辑、挂目标或排间隔复习。' }),
    ),
    h('div', { class: 'card task-workspace' },
      h('div', { class: 'btn-row', style: 'margin-bottom:10px' },
        fSel,
        h('span', { class: 'spacer', style: 'flex:1' }),
        h('button', { class: 'btn btn-primary btn-sm', onclick: () => editTask(null, { onClose: () => render(root) }) }, icon('plus'), h('span', { text: '添加任务' })),
      ),
      h('details', { class: 'task-tools' },
        h('summary', { text: '搜索、排序与批量复习' }),
        h('div', { class: 'btn-row', style: 'margin-top:8px' },
          sSel, search,
          h('button', { class: 'btn btn-sm', onclick: () => reviewPicker(() => render(root)) }, icon('calendar'), h('span', { text: '排一组间隔复习' })),
        ),
      ),
      overdueNotice,
      listBox,
    ),
  );
  draw();
}
