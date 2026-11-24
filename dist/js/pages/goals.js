// 目标：把一个庞大的目标摊到每一天，进度只由已经发生的事实汇总。
// 三条不能松的规矩，就写在这个页面自己的行为里：
//   ① 没有「填一个百分比」这种入口——进度来自任务完成与专注记录，人手改不了；
//   ② 拆解出来的是提案，逐条确认才写库，而且只决定「哪天做什么、大概多久」，
//      具体落在哪个时段仍然归计划页的空闲排程管；
//   ③ 「还要几天」「赶不赶得上」全部来自这台设备上的历史，样本不够就直接说不够。
import * as db from '../store.js';
import { state, goalProgress, tasksForGoal, spentMinOn, stageRows, taskProgress, effectiveTasks } from '../state.js';
import { dailyBudget, estimateFor, goalOutlook, provenance, blockerInsight, CALIBRATION_RULE_NOTE } from '../history.js';
import { h, icon, clear, toast, selectEl, field, openSheet, confirmSheet, ymd, fmtDateTime } from '../ui.js';
import { changed, editTask } from '../forms.js';
import { goPage } from '../app.js';
import { pageAside, factsCard, quoteCard } from '../aside.js';

const GOAL_STATUS = { active: '进行中', paused: '先放着', done: '已完成', archived: '归档' };
const dayMs = 864e5;

function dateInDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
}

async function putGoal(obj) {
  await db.put('goals', obj);
  const i = state.goals.findIndex((x) => x.id === obj.id);
  if (i >= 0) state.goals[i] = obj; else state.goals.push(obj);
}

async function writeTaskRow(d) {
  const obj = {
    id: db.uid(), title: d.title, subject: d.subject || '', dueAt: d.dueAt || '',
    estMin: d.estMin || 30, priority: d.priority || 'medium', note: d.note || '',
    status: 'pending', doneAt: null, goalId: d.goalId || null, stageId: d.stageId || null, reviewDays: d.reviewDays || null,
    addedBy: d.addedBy || 'manual', createdAt: new Date().toISOString(),
  };
  await db.put('tasks', obj);
  state.tasks = [...state.tasks, obj].sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  return obj;
}

// ---------- 新建 / 编辑目标 ----------
export function editGoal(initial = null, { onSaved } = {}) {
  const g = initial || { title: '', note: '', subject: '', dueAt: '', estMin: 0, status: 'active' };
  const isEdit = Boolean(initial?.id);
  const fTitle = field('这个目标做完是什么样（写成一个能核对的结果）',
    h('input', { value: g.title, maxlength: 60, placeholder: '例：期末周 5 门课过一遍，不挂科', dataset: { autofocus: '' } }),
    { id: 'gf-title', hint: '写成结果，不要写成「好好学习」。范围越具体，后面的天数才算得准。' });
  const fDue = field('交付日（选填）', h('input', { type: 'date', value: g.dueAt ? String(g.dueAt).slice(0, 10) : '' }), { id: 'gf-due' });
  const fEst = field('总投入预计（分钟，选填）',
    h('input', { type: 'number', min: 0, max: 20000, step: 30, value: g.estMin || 0 }),
    { id: 'gf-est', hint: '留空也行：那就用它下面任务的预计合计当总量。两个都没填时，页面只报已投入的分钟，不会编一个进度出来。' });
  const fSubject = field('主要科目（选填）', h('input', { value: g.subject || '', maxlength: 30 }), { id: 'gf-subject' });
  const fStatus = field('状态', selectEl(Object.entries(GOAL_STATUS).map(([value, label]) => ({ value, label })), g.status || 'active'), { id: 'gf-status' });
  const fNote = field('范围说明（选填）', h('textarea', { rows: 3, maxlength: 200, value: g.note || '', placeholder: '例：只读与选题直接相关的 25 篇，其余先不碰' }), { id: 'gf-note' });

  const save = async () => {
    const title = fTitle.el.querySelector('input').value.trim();
    if (!title) { fTitle.error('至少写下一句话'); return; }
    const dueRaw = fDue.el.querySelector('input').value;
    const est = Number(fEst.el.querySelector('input').value) || 0;
    if (est && (est < 5 || est > 20000)) { fEst.error('总投入请在 5–20000 分钟之间'); return; }
    const obj = {
      id: g.id || db.uid(),
      title,
      subject: fSubject.el.querySelector('input').value.trim(),
      dueAt: dueRaw ? `${dueRaw}T23:59` : '',
      estMin: est,
      note: fNote.el.querySelector('textarea').value.trim(),
      status: fStatus.el.querySelector('select').value,
      doneAt: g.doneAt || null,
      createdAt: g.createdAt || new Date().toISOString(),
      // 路线只由「路线」弹层和 AI 提案改，编辑目标本身原样带着走
      stages: Array.isArray(g.stages) ? g.stages : null,
      demo: g.demo,
    };
    if (obj.status === 'done' && !obj.doneAt) obj.doneAt = new Date().toISOString();
    if (obj.status !== 'done') obj.doneAt = null;
    try {
      await putGoal(obj);
    } catch (e) {
      toast('没保存成功', (e && e.message) || '这台设备的存储写不进去（可能是空间满了）。');
      return;
    }
    sheet.close();
    changed('goal-save');
    toast(isEdit ? '目标已更新' : '目标已记下', obj.title);
    onSaved?.(obj);
  };

  const sheet = openSheet({
    title: isEdit ? '编辑目标' : '写一个目标',
    content: h('div', {},
      fTitle.el,
      h('div', { class: 'field-row' }, fDue.el, fEst.el),
      h('div', { class: 'field-row' }, fSubject.el, fStatus.el),
      fNote.el,
    ),
    actions: [
      h('button', { class: 'btn', onclick: () => sheet.close(), text: '取消' }),
      h('button', { class: 'btn btn-primary', onclick: save, text: '保存' }),
    ],
  });
  return sheet;
}

// ---------- 拆解向导：总剩余 → 每天一段（提案，逐条确认） ----------
// 受阻重规划（reblock.js）的「任务太大」复用同一种分钟摊法
export function planChunks({ remaining, perDay, days, startOffset, titles }) {
  const out = [];
  let left = remaining;
  for (let i = 0; i < days && left > 0; i++) {
    const min = Math.min(perDay, left);
    left -= min;
    const ds = dateInDays(startOffset + i);
    const custom = String(titles[i] || '').trim();
    out.push({
      key: `k${i}`,
      keep: true,
      title: custom || `第 ${i + 1} 段 · ${Math.round(min)} 分钟`,
      date: ds,
      estMin: Math.round(min),
    });
  }
  return out;
}

function breakdownSheet(goal) {
  const prog = goalProgress(goal);
  const budget = dailyBudget();
  const outlook = goalOutlook(prog, goal.dueAt, budget);
  // 有路线时只拆当前段：剩余量按段内未完成任务的剩余分钟算，后面的段走到了再拆
  const route = stageRows(goal);
  const current = route.rows.find((r) => r.status === 'current') || null;
  if (route.rows.length && !current) {
    toast('路线上的段都完成了', route.loose.length
      ? `还有 ${route.loose.length} 条未分段任务没做，但它们不归这次拆解管。要摊新内容，先在「路线」里加一段。`
      : '要摊新内容，先在「路线」里加一段。');
    return;
  }
  const remaining = current
    ? current.tasks.filter((t) => t.status !== 'done').reduce((n, t) => {
      const pr = taskProgress(t);
      return n + (pr.remaining ?? Math.max(0, Number(t.estMin) || 0));
    }, 0)
    : prog.remaining || prog.est;
  if (!remaining) {
    if (current) {
      toast('当前段没有可拆的余量', `「${current.title}」下面的任务要么都做完了，要么没填预计时长。先给这一段加几条带时长的任务，拆解才有依据。`, 'bad');
      return;
    }
    toast('还没法拆', '这个目标既没填总投入，下面也没有带预计时长的任务。先补一个数，拆解才有依据。', 'bad');
    editGoal(goal);
    return;
  }
  if (!budget.enough) {
    toast('先别急着拆', `这台设备上有专注记录的只有 ${budget.days} 天，还不够判断你一天真正能做多少。可以先自己按天分几条任务，等有了记录再让星迹按你的步幅摊。`, 'bad');
    return;
  }

  // 默认天数取「按你自己的步幅真需要几天」，不取 min(剩余天数, 需要天数)。
  // 取小的那个会只排掉一小半总量却一声不响——那是把没做完的假装排进日历，正是这个页面写明了不干的事。
  const stageDays = Math.ceil(remaining / budget.minutes);
  const defaultDays = Math.max(2, Math.min(90, current
    ? stageDays
    : outlook.canEstimate
      ? outlook.daysNeeded
      : Math.ceil(remaining / budget.minutes)));
  const fDays = field('摊到几天内', h('input', { type: 'number', min: 2, max: 90, step: 1, value: defaultDays }), {
    id: 'bf-days',
    hint: current
      ? `按你一天真正能做完的 ${budget.minutes} 分钟，当前段这 ${remaining} 分钟大约要 ${stageDays} 天。只拆这一段，后面的段走到了再拆。`
      : outlook.canEstimate
        ? `按你一天真正能做完的 ${budget.minutes} 分钟，这 ${remaining} 分钟大约要 ${outlook.daysNeeded} 天。${outlook.deadline ? `交付日 ${outlook.deadline}，还剩 ${outlook.daysLeft} 天。` : '没设交付日，那就只按需要几天算。'}`
        : `按你一天 ${budget.minutes} 分钟，大约要 ${Math.ceil(remaining / budget.minutes)} 天。`,
  });
  const fPerDay = field('每天最多投多少分钟', h('input', { type: 'number', min: 10, max: 480, step: 5, value: budget.minutes }), {
    id: 'bf-perday',
    hint: `默认值是你自己的中位数（${budget.minutes} 分钟）。调大就是承诺一个你做过的量之外的数字——星迹不会拦你，但它会把每天要投的量算给你看。`,
  });
  const fStart = field('从哪天开始', selectEl([
    { value: '0', label: '今天' }, { value: '1', label: '明天' }, { value: '2', label: '后天' },
  ], '1'), { id: 'bf-start', hint: '今天剩下的时间归计划页排；这里只定「哪天做什么、大概多久」。' });
  const fTitles = field('学习内容细化（选填）',
    h('textarea', { rows: 6, maxlength: 1200, placeholder: '一行一段，例：\n极限那章的 20 道题\n导数：只做中值定理\n把错题重做 6 道' }),
    { id: 'bf-titles', hint: '你写下每天要学的内容，星迹只负责排日期和给时长上限；不写就用「第 k 段 · N 分钟」。这一栏没有调用任何 AI，内容是你自己贴的。' });

  const listBox = h('div', { class: 'check-list' });
  let draft = [];

  const rebuild = () => {
    const days = Math.max(2, Math.min(90, Number(fDays.el.querySelector('input').value) || defaultDays));
    const perDay = Math.max(10, Math.min(480, Number(fPerDay.el.querySelector('input').value) || budget.minutes));
    const startOffset = Number(fStart.el.querySelector('select').value) || 0;
    const titles = fTitles.el.querySelector('textarea').value.split('\n').map((x) => x.trim()).filter(Boolean);
    draft = planChunks({ remaining, perDay, days, startOffset, titles });
    clear(listBox);
    const covered = draft.reduce((s, x) => s + x.estMin, 0);
    listBox.append(h('h4', { text: `预览：拆成 ${draft.length} 段（还没写进任务）` }));
    // 拆不完就明说拆不完：天数被自己压小了、或者每天量调少了，剩下的量不会凭空消失
    if (covered < remaining) {
      listBox.append(h('p', { class: 'warn-bar', text: `这几天只排掉 ${covered} 分钟，还有 ${remaining - covered} 分钟没地方去。要么把天数放宽，要么承认每天多投一点，要么回去砍范围——星迹不会把它算成「已经安排好了」。` }));
    }
    for (const d of draft) {
      const cb = h('input', { type: 'checkbox', checked: d.keep, 'aria-label': `保留 ${d.title}` });
      const titleEl = h('input', { type: 'text', maxlength: 60, value: d.title, 'aria-label': '这一段做什么' });
      const dateEl = h('input', { type: 'date', value: d.date, 'aria-label': '日期' });
      const minEl = h('input', { type: 'number', min: 5, max: 480, step: 5, value: d.estMin, 'aria-label': '预计分钟' });
      cb.addEventListener('change', () => { d.keep = cb.checked; foot(); });
      titleEl.addEventListener('input', () => { d.title = titleEl.value; });
      dateEl.addEventListener('change', () => { d.date = dateEl.value; });
      minEl.addEventListener('change', () => { d.estMin = Number(minEl.value) || d.estMin; foot(); });
      listBox.append(h('div', { class: 'check-row' }, cb,
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: d.title }),
          h('div', { class: 'field-row', style: 'margin-top:5px' },
            h('div', { class: 'field', style: 'margin:0' }, h('label', { text: '日期', style: 'font-size:11.5px' }), dateEl),
            h('div', { class: 'field', style: 'margin:0' }, h('label', { text: '预计分钟', style: 'font-size:11.5px' }), minEl),
          ),
        ),
      ));
      d._el = { titleEl, dateEl, minEl, cb };
    }
    foot();
  };

  const foot = () => {
    clear(actionsRow);
    const chosen = draft.filter((x) => x.keep);
    // 分钟数从输入框现读：用户改过的那一段要以他填的为准，不能拿拆出来时的默认值糊上去
    const m = chosen.reduce((s, x) => s + (Number(x._el?.minEl?.value) || Number(x.estMin) || 0), 0);
    actionsRow.append(
      h('span', { class: 'tag', text: `已勾选 ${chosen.length} 段 · 合计约 ${m} 分钟` }),
      h('span', { class: 'spacer', style: 'flex:1' }),
      h('button', { class: 'btn', onclick: () => sheet.close(), text: '先不拆' }),
      h('button', { class: 'btn btn-primary', onclick: save, text: `写入勾选的 ${chosen.length} 段` }, icon('plus')),
    );
  };

  let saving = false;
  const save = async () => {
    if (saving) return;
    const chosen = draft.filter((x) => x.keep && x.title.trim());
    if (!chosen.length) { toast('没勾选任何一段', '至少留一段，或者先不拆。', 'bad'); return; }
    saving = true;
    try {
      const written = [];
      const failed = [];
      for (const d of chosen) {
        const min = Number(d._el?.minEl?.value) || d.estMin;
        const date = d._el?.dateEl?.value || d.date;
        try {
          written.push(await writeTaskRow({
            title: d._el?.titleEl?.value.trim() || d.title,
            subject: goal.subject || '',
            dueAt: `${date}T23:59`,
            estMin: min,
            priority: 'medium',
            note: `来自「${goal.title}」的拆解`,
            goalId: goal.id,
            stageId: current ? current.id : null,
            addedBy: 'breakdown',
          }));
        } catch (e) { failed.push(`${d.title}：${e.message || e}`); }
      }
      if (failed.length) toast(`有 ${failed.length} 段没写进去`, `${failed[0]}\n已经写好的 ${written.length} 段保留，不会因为这一段回滚。`, 'bad');
      else toast(`已写入 ${written.length} 段`, '这些是任务，具体排在哪个时段还是由计划页的空闲排程决定；进度会自动汇总到目标上。');
      changed('goal-breakdown');
      sheet.close();
    } finally { saving = false; }
  };

  const actionsRow = h('div', { class: 'btn-row', style: 'margin-top:12px' });
  rebuild();
  for (const el of [fDays.el, fPerDay.el]) el.addEventListener('input', rebuild);
  fStart.el.addEventListener('change', rebuild);
  fTitles.el.addEventListener('input', rebuild);

  const sheet = openSheet({
    title: `把「${goal.title}」摊到每一天`,
    wide: true,
    content: h('div', {},
      h('p', { class: 'hint', text: current
        ? `这次只拆当前段「${current.title}」：它下面的未完成任务还剩约 ${remaining} 分钟。${budget.note}`
        : `总量按还剩 ${remaining} 分钟算（已投入 ${prog.spent} 分钟）。${budget.note}` }),
      h('p', { class: 'note muted', text: '这一步只用本机的历史记录算时长，没有调用任何 AI。写入前每一段都能改名字、改日期、取消勾选。' }),
      current ? h('p', { class: 'note muted', text: `写出的任务会挂到「${current.title}」这一段；后面的段走到了再拆。${route.loose.length ? `另有 ${route.loose.length} 条未分段任务，不在本次拆解里。` : ''}` }) : null,
      fDays.el, fPerDay.el, fStart.el, fTitles.el,
      listBox,
    ),
    actions: [actionsRow],
  });
}

/** 砍范围的唯一诚实做法：把某几段从这个目标的账上移走。
 *  任务本身不删（专注记录还在），只是不再算进这个目标的总量——剩余分钟会立刻跟着降。 */
function scopeSheet(goal) {
  const pending = effectiveTasks(tasksForGoal(goal.id)).filter((t) => t.status !== 'done');
  if (!pending.length) {
    toast('没有可移走的段', '这个目标下面已经没有未完成任务了，砍不动范围；要改就改交付日，或者重新摊一次。');
    return;
  }
  const list = h('div', { class: 'check-list' });
  const shiftOut = async (t) => {
    const next = { ...t, goalId: null };
    try { await db.put('tasks', next); }
    catch (e) { toast('没移走', (e && e.message) || '这台设备的存储写不进去。'); return; }
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tasks[i] = next;
    renderRow();
    changed('goal-scope');
    toast('这一段不再算进目标', `${t.title} · 预计 ${t.estMin || 0} 分钟已从「${goal.title}」的账上移走，任务还在任务页。`);
  };
  const renderRow = () => {
    clear(list);
    const rows = effectiveTasks(tasksForGoal(goal.id)).filter((t) => t.status !== 'done');
    if (!rows.length) { list.append(h('p', { class: 'empty', text: '这个目标下面已经没有未完成任务了。' })); return; }
    for (const t of rows) {
      list.append(h('div', { class: 'row' },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: t.title }),
          h('div', { class: 'row-meta' },
            h('span', { class: 'tag', text: `预计 ${t.estMin || 0} 分钟` }),
            t.dueAt ? h('span', { class: 'tag', text: `截止 ${String(t.dueAt).slice(0, 16).replace('T', ' ')}` }) : null,
          ),
        ),
        h('div', { class: 'row-ops' },
          h('button', { class: 'btn btn-sm', onclick: () => shiftOut(t), text: '移出这个目标' }),
        ),
      ));
    }
  };
  renderRow();
  // 同样要走 sheet.close()：手动摘 .mask 会让 openSheets 里那条留着，背景一直 inert，
  // 关掉抽屉之后整页都点不动（notice.js 里同一个毛病一起修了）。
  const sheet = openSheet({
    title: `把「${goal.title}」的范围砍小`,
    wide: true,
    content: h('div', {},
      h('p', { class: 'hint', text: '移出去不等于删掉：任务还在任务页，已经投进去的专注时长也不会消失。它只是不再算在这个目标的总量里，所以「还剩多少分钟」「还要几天」会立刻变小。' }),
      list,
    ),
    actions: [h('button', { class: 'btn btn-primary', onclick: () => sheet.close(), text: '看完了' })],
  });
}

// ---------- 学习路线：段状态只从任务现推，不存库；改路线不改任务内容 ----------
const STAGE_LABEL = { done: '已完成', current: '当前', later: '后续' };

function roadmapBlock(goal) {
  const route = stageRows(goal);
  if (!route.rows.length) return null;
  const box = h('div', { class: 'roadmap' });
  for (const r of route.rows) {
    box.append(h('div', { class: `stage ${r.status}` },
      h('span', { class: 'stage-dot', 'aria-hidden': 'true' }),
      h('div', { class: 'stage-main' },
        h('div', { class: 'stage-title' },
          h('span', { text: r.title }),
          h('span', { class: `tag${r.status === 'done' ? ' ok' : ''}`, text: STAGE_LABEL[r.status] })),
        h('div', { class: 'row-meta' },
          h('span', { class: 'tag', text: `任务 ${r.done}/${r.total}` }),
          h('span', { class: 'tag', text: `预计 ${r.estMin} 分钟` })),
        r.note ? h('p', { class: 'note muted', text: r.note }) : null,
      ),
    ));
  }
  if (route.loose.length) {
    const min = route.loose.reduce((n, t) => n + Math.max(0, Number(t.estMin) || 0), 0);
    box.append(h('div', { class: 'stage loose' },
      h('span', { class: 'stage-dot', 'aria-hidden': 'true' }),
      h('div', { class: 'stage-main' },
        h('div', { class: 'stage-title' }, h('span', { text: '未分段' })),
        h('div', { class: 'row-meta' },
          h('span', { class: 'tag', text: `${route.loose.length} 条任务` }),
          h('span', { class: 'tag', text: `预计 ${min} 分钟` })),
        h('p', { class: 'note muted', text: '没挂段的任务仍算在目标总量里，只是不参与段的推导。' }),
      ),
    ));
  }
  // 今天建议做当前段的哪条：按截止时间排序取第一条未完成的，规则署名
  const cur = route.rows.find((r) => r.status === 'current');
  const next = cur
    ? cur.tasks.filter((t) => t.status !== 'done').sort((a, b) => String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')))[0]
    : null;
  const suggest = next
    ? `今天建议先做当前段的「${next.title}」${next.dueAt ? `（截止 ${String(next.dueAt).slice(0, 16).replace('T', ' ')}）` : '（没设截止）'}，预计 ${next.estMin || '?'} 分钟。`
    : cur
      ? `当前段「${cur.title}」还没有可做的任务。点「摊到每一天」只拆这一段，或者手动加一条。`
      : '路线上的段都完成了。要开始新内容，先在「路线」里加一段。';
  box.append(h('p', { class: 'hint stage-suggest' },
    h('span', { text: suggest }),
    h('span', { class: 'tag', text: '规则生成 · 未调用 AI' })));
  return box;
}

/** 路线编辑：增 / 改名 / 上下移 / 删，全部先在内存里改，保存才写库。
 *  删段只把挂在它下面的任务 stageId 置 null——任务一条不删，专注记录更不动。 */
function stagesSheet(goal) {
  const before = Array.isArray(goal.stages) ? goal.stages : [];
  let draft = before.map((s) => ({ ...s }));
  const listBox = h('div', { class: 'stage-edit-list' });

  const draw = () => {
    clear(listBox);
    if (!draft.length) {
      listBox.append(h('p', { class: 'empty', text: '还没有路线。点下面「加一段」，把这个目标按顺序切成 2–8 段试试；段里有什么任务、做到哪，页面上全自动推。' }));
    }
    draft.forEach((s, i) => {
      const live = stageRows({ ...goal, stages: draft }).rows.find((r) => r.id === s.id);
      const titleEl = h('input', { type: 'text', maxlength: 40, value: s.title, placeholder: `第 ${i + 1} 段做什么`, 'aria-label': `第 ${i + 1} 段的名字` });
      titleEl.addEventListener('input', () => { s.title = titleEl.value; });
      listBox.append(h('div', { class: 'stage-edit-row' },
        h('span', { class: 'stage-idx', text: String(i + 1) }),
        h('div', { class: 'row-main' },
          titleEl,
          live ? h('div', { class: 'row-meta' }, h('span', { class: 'tag', text: `任务 ${live.done}/${live.total}` })) : null,
        ),
        h('div', { class: 'row-ops' },
          h('button', { class: 'icon-btn', title: '上移一段', 'aria-label': `上移第 ${i + 1} 段`, disabled: i === 0, onclick: () => { [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]]; draw(); } }, icon('up')),
          h('button', { class: 'icon-btn', title: '下移一段', 'aria-label': `下移第 ${i + 1} 段`, disabled: i === draft.length - 1, onclick: () => { [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]]; draw(); } }, icon('down')),
          h('button', { class: 'icon-btn', title: '删除这一段（任务不删）', 'aria-label': `删除第 ${i + 1} 段`, onclick: () => { draft.splice(i, 1); draw(); } }, icon('trash')),
        ),
      ));
    });
  };

  const save = async () => {
    const stages = draft.map((s) => ({ id: s.id, title: String(s.title || '').trim(), note: s.note || '' }));
    if (stages.some((s) => !s.title)) { toast('有段没写名字', '每一段都要有个能核对的名字；不想要这一段就删掉它。', 'bad'); return; }
    const kept = new Set(stages.map((s) => s.id));
    const removed = before.filter((s) => !kept.has(s.id)).map((s) => s.id);
    const orphans = removed.length ? tasksForGoal(goal.id).filter((t) => t.stageId && removed.includes(t.stageId)) : [];
    try {
      await putGoal({ ...goal, stages: stages.length ? stages : null });
    } catch (e) {
      toast('没保存成功', (e && e.message) || '这台设备的存储写不进去（可能是空间满了）。');
      return;
    }
    // 目标已落库才动任务；中途失败时剩下的任务 stageId 指向已删的段，页面按「未分段」读，不会丢
    let failed = 0;
    for (const t of orphans) {
      try {
        await db.put('tasks', { ...t, stageId: null });
        const i = state.tasks.findIndex((x) => x.id === t.id);
        if (i >= 0) state.tasks[i] = { ...state.tasks[i], stageId: null };
      } catch (e) { failed += 1; }
    }
    sheet.close();
    changed('goal-stages');
    if (failed) toast('路线存了，有任务没解挂', `${failed} 条任务的段标记没清掉，页面会把它们当未分段显示；再打开路线保存一次即可。`, 'bad');
    else toast(stages.length ? '路线已保存' : '路线已清空', orphans.length ? `${orphans.length} 条任务回到「未分段」，任务本身一条没删。` : '段的完成状态会从任务里自动推出来。');
  };

  draw();
  const sheet = openSheet({
    title: `「${goal.title}」的路线`,
    wide: true,
    content: h('div', {},
      h('p', { class: 'hint', text: '数组顺序就是路线顺序。段的状态不存库：段内任务全做完 = 已完成，第一个没做完的段 = 当前。删段不会删任务，原来挂在它下面的任务回到「未分段」。' }),
      listBox,
      h('div', { class: 'btn-row', style: 'margin-top:10px' },
        h('button', { class: 'btn btn-sm', onclick: () => { draft.push({ id: db.uid(), title: '', note: '' }); draw(); const last = listBox.querySelector('.stage-edit-row:last-child input'); last?.focus(); }, text: '加一段' })),
    ),
    actions: [
      h('button', { class: 'btn', onclick: () => sheet.close(), text: '取消' }),
      h('button', { class: 'btn btn-primary', onclick: save, text: '保存路线' }),
    ],
  });
  return sheet;
}

// ---------- 目标卡 ----------
function progressBlock(goal) {
  const prog = goalProgress(goal);
  const budget = dailyBudget();
  const outlook = goalOutlook(prog, goal.dueAt, budget);
  const base = h('div', {});

  base.append(h('div', { class: 'bar-row' },
    h('span', { text: prog.est ? `${prog.spent}/${prog.est} 分` : `已投入 ${prog.spent} 分` }),
    h('div', { class: 'bar' }, h('i', { style: `width:${prog.pct}%` })),
    h('span', { class: 'bar-val', text: prog.est ? `${prog.pct}%` : '没设总量' }),
  ));

  const dur = (m) => (m >= 60 ? `${(m / 60).toFixed(1).replace(/\.0$/, '')} 小时` : `${m} 分钟`);
  const metaBits = [
    h('span', { class: 'tag', text: `完成任务 ${prog.done}/${prog.tasks}` }),
    h('span', { class: 'tag', text: `投入 ${dur(prog.spent)}` }),
    prog.ratedPractice ? h('span', { class: 'tag warn', text: `其中 ${prog.ratedPractice} 项自评还需练习` }) : null,
    prog.ratedClear ? h('span', { class: 'tag ok', text: `${prog.ratedClear} 项自评能讲清楚` }) : null,
    prog.overdue ? h('span', { class: 'tag bad', text: `逾期 ${prog.overdue} 条` }) : null,
    prog.remaining !== null ? h('span', { class: 'tag', text: `还剩 ${prog.remaining} 分钟` }) : null,
    h('span', { class: 'tag', text: prog.estSource === 'goal' ? '总量来自你填的预计' : prog.estSource === 'tasks' ? '总量取任务预计合计' : '总量没设' }),
  ].filter(Boolean);
  base.append(h('div', { class: 'row-meta' }, ...metaBits));

  if (outlook.canEstimate) {
    const line = outlook.deadline
      ? outlook.feasible
        ? `按你自己一天真正做完的 ${outlook.perDay} 分钟，还要 ${outlook.daysNeeded} 天（大约 ${outlook.finishDate}），交付日 ${outlook.deadline} 前还剩 ${outlook.slack} 天余量。`
        : `按你自己一天真正做完的 ${outlook.perDay} 分钟，还要 ${outlook.daysNeeded} 天，但交付日 ${outlook.deadline} 只剩 ${outlook.daysLeft} 天——要在截止前做完，得每天投 ${outlook.perDayIfDeadline} 分钟。`
      : `按你自己一天真正做完的 ${outlook.perDay} 分钟，还要 ${outlook.daysNeeded} 天，大约 ${outlook.finishDate} 做得完。`;
    base.append(h('p', { class: outlook.deadline && !outlook.feasible ? 'warn-bar' : 'hint', text: line }));
    if (outlook.deadline) {
      base.append(h('div', { class: 'row-meta', style: 'margin-top:6px' },
        h('span', { class: 'tag', text: `距交付日 ${outlook.daysLeft} 天` }),
        h('span', { class: 'tag', text: `按你的步幅还要 ${outlook.daysNeeded} 天` }),
        h('span', { class: outlook.feasible ? 'tag ok' : 'tag bad', text: `每天至少 ${outlook.perDayIfDeadline} 分钟` }),
      ));
    }
    if (outlook.deadline && !outlook.feasible) {
      base.append(h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-sm', onclick: () => editGoal(goal, { onSaved: () => goPage('goals') }) }, icon('edit'), h('span', { text: '改交付日' })),
        h('button', {
          class: 'btn btn-sm',
          onclick: () => scopeSheet(goal),
          text: '把范围砍小一点',
        }),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => breakdownSheet(goal), text: '重新摊一次' }),
      ));
      base.append(h('p', { class: 'note muted', text: '星迹不会把没做完的假装排进日历就完事。要么改日期，要么砍范围，要么承认每天要多投多少——三个都由你点。' }));
    }
  } else {
    base.append(h('p', { class: 'hint', text: outlook.reason }));
  }

  // 本周与当前阶段连接：中断几天后回来，先看「现在在哪、做完多少、这周还适合做什么」
  const route = stageRows(goal);
  const cur = route.rows.find((r) => r.status === 'current') || null;
  if (budget.enough && cur) {
    const dow = (new Date().getDay() + 6) % 7;
    const daysLeft = 7 - dow;
    const weekCap = budget.minutes * daysLeft;
    const stageRemain = cur.tasks.filter((t) => t.status !== 'done').reduce((n, t) => {
      const pr = taskProgress(t);
      return n + (pr.remaining ?? Math.max(0, Number(t.estMin) || 0));
    }, 0);
    const fits = weekCap >= stageRemain;
    base.append(h('p', { class: fits ? 'note muted' : 'warn-bar', text: `当前阶段「${cur.title}」已完成 ${cur.done}/${cur.total} 条，还剩约 ${stageRemain} 分钟；本周（今天到周日 ${daysLeft} 天）按你的步幅约可投 ${weekCap} 分钟。${fits ? '这周能把这一段做完。' : '这一段这周装不下——先做最靠前的几条，其余顺延，或者从下面选一种调整。'}` }));
    if (!fits && !(outlook.deadline && !outlook.feasible)) {
      base.append(h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-sm', onclick: () => editGoal(goal, { onSaved: () => goPage('goals') }) }, icon('edit'), h('span', { text: '延长到更晚' })),
        h('button', { class: 'btn btn-sm', onclick: () => scopeSheet(goal), text: '缩小范围' }),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => breakdownSheet(goal), text: '调整投入 / 重新摊' }),
      ));
    }
  }

  const subj = goal.subject || '';
  const est = estimateFor(subj);
  if (est.enough && prog.tasks) {
    base.append(h('p', { class: 'note muted', text: `科目「${est.group}」的校准：${est.samples} 段记录（${provenance(est)}），实际中位数是预计的 ${Math.round(est.rawFactor * 100)}%。这条只用来解释上面的天数怎么算的，不会自动改你的任务时长。` }));
  }
  const blk = blockerInsight({ goalId: goal.id });
  if (blk.enough) {
    base.append(h('p', { class: 'hint', style: 'margin-top:6px' },
      h('span', { text: blk.text }),
      h('span', { class: 'tag', style: 'margin-left:6px', text: CALIBRATION_RULE_NOTE }),
    ));
  }
  if (prog.tasks === 0) {
    base.append(h('p', { class: 'empty', text: '这个目标下面还没有任务。点「摊到每一天」按你自己的步幅分几段，或者手动加一条。' }));
  }
  return base;
}

function goalCard(goal) {
  const ops = h('div', { class: 'row-ops' });
  ops.append(
    h('button', { class: 'btn btn-sm', onclick: () => breakdownSheet(goal), text: '摊到每一天' }),
    h('button', { class: 'btn btn-sm', onclick: () => stagesSheet(goal), text: '路线' }),
    h('button', {
      class: 'icon-btn', title: '在这个目标下加一条任务', 'aria-label': '在这个目标下加一条任务',
      onclick: () => {
        const sheet = editTask({ title: '', subject: goal.subject || '', dueAt: '', estMin: 30, priority: 'medium', note: '', status: 'pending', goalId: goal.id }, { onClose: () => goPage('goals') });
        return sheet;
      },
    }, icon('plus')),
    h('button', { class: 'icon-btn', title: '编辑目标', 'aria-label': '编辑目标', onclick: () => editGoal(goal, { onSaved: () => goPage('goals') }) }, icon('edit')),
    h('button', {
      class: 'icon-btn', title: goal.status === 'done' ? '改回进行中' : '标记完成',
      'aria-label': goal.status === 'done' ? '目标改回进行中' : '标记目标完成',
      onclick: async () => {
        const next = goal.status === 'done' ? 'active' : 'done';
        try { await putGoal({ ...goal, status: next, doneAt: next === 'done' ? new Date().toISOString() : null }); }
        catch (e) { toast('没改成', (e && e.message) || '存储写不进去。'); return; }
        changed('goal-status');
        toast(next === 'done' ? '这个目标标为已完成' : '改回进行中', goal.title);
      },
    }, icon('check')),
    h('button', {
      class: 'icon-btn', title: '删除目标', 'aria-label': '删除目标',
      onclick: async () => {
        const kids = tasksForGoal(goal.id);
        const ok = await confirmSheet({
          title: '删除这个目标',
          message: `「${goal.title}」会被删掉。它下面的 ${kids.length} 条任务不会被删，但会解除和目标的关联（否则库里会留下指向不存在目标的引用，页面上的数字就对不上了）；专注记录也不受影响。`,
          confirmText: '删除目标', danger: true,
        });
        if (!ok) return;
        // 同一事务里解绑任务再删目标：中途失败整笔回滚，不会出现「目标没了、任务还挂着它」
        try { await db.deleteGoalCascade(goal.id); }
        catch (e) { toast('没删成', (e && e.message) || '这台设备的存储写不进去。'); return; }
        for (const t of kids) {
          const i = state.tasks.findIndex((x) => x.id === t.id);
          if (i >= 0) state.tasks[i] = { ...state.tasks[i], goalId: null, stageId: null };
        }
        state.goals = state.goals.filter((x) => x.id !== goal.id);
        changed('goal-remove');
        toast('已删除目标', kids.length
          ? `${goal.title} · 原来在它下面的 ${kids.length} 条任务已解除关联，还在任务页。`
          : `${goal.title} · 它下面本来没有任务。`);
      },
    }, icon('trash')),
  );

  const doneTasks = effectiveTasks(tasksForGoal(goal.id)).filter((t) => t.status === 'done');
  const pending = effectiveTasks(tasksForGoal(goal.id)).filter((t) => t.status !== 'done');

  return h('div', { class: 'card' },
    h('div', { class: 'btn-row', style: 'margin-bottom:4px' },
      h('h3', { style: 'margin:0', text: goal.title }),
      h('span', { class: 'spacer', style: 'flex:1' }),
      h('span', { class: `tag${goal.status === 'done' ? ' ok' : ''}`, text: GOAL_STATUS[goal.status] || '进行中' }),
      h('span', { class: 'tag', text: CALIBRATION_RULE_NOTE }),
    ),
    h('div', { class: 'row-meta' },
      goal.dueAt ? h('span', { class: 'tag', text: `交付 ${String(goal.dueAt).slice(0, 10)}` }) : h('span', { class: 'tag', text: '没设交付日' }),
      goal.subject ? h('span', { class: 'tag', text: goal.subject }) : null,
      goal.demo ? h('span', { class: 'tag', text: '场景包里的目标' }) : null,
    ),
    goal.note ? h('p', { class: 'note muted', text: goal.note }) : null,
    progressBlock(goal),
    roadmapBlock(goal),
    ops,
    pending.length || doneTasks.length
      ? h('details', { class: 'fold', style: 'margin-top:10px' },
          h('summary', {}, h('span', { class: 'fold-lead', text: '已经完成的事实' }),
            h('span', { text: `${doneTasks.length} 条任务 · 还剩 ${pending.length} 条` })),
          h('div', { class: 'fold-body' },
            doneTasks.length
              ? h('div', {}, ...doneTasks.slice(0, 12).map((t) => h('div', { class: 'row' },
                  h('div', { class: 'row-main' },
                    h('div', { class: 'row-title', text: t.title }),
                    h('div', { class: 'row-meta' },
                      h('span', { class: 'tag ok', text: `完成于 ${t.doneAt ? fmtDateTime(t.doneAt) : '（没记时间）'}` }),
                      h('span', { class: 'tag', text: `${spentMinOn(t.id)} 分钟真实投入` }),
                    ),
                  ),
                  h('div', { class: 'row-ops' },
                    h('button', { class: 'btn btn-sm btn-ghost', onclick: () => goPage('tasks'), text: '去任务页' }),
                  ),
                )))
              : h('p', { class: 'empty', text: '还没有做完的任务。进度条现在为 0，是因为它只认真的发生过的事。' }),
            pending.length ? h('p', { class: 'hint', text: `还剩 ${pending.length} 条没做完：${pending.slice(0, 4).map((t) => t.title).join('、')}${pending.length > 4 ? '…' : ''}` }) : null,
            h('p', { class: 'note muted', text: '这张清单每次都是从任务状态和专注记录现算的：删掉一条记录，这里的数字立刻跟着少。没有一处进度是手填的。' }),
          ),
        )
      : null,
  );
}

// ---------- 场景包入口 ----------
function scenarioCard() {
  const busy = { v: false };
  const load = async (pack) => {
    if (busy.v) return;
    const had = state.courses.length + state.tasks.length + state.goals.length;
    if (had) {
      const ok = await confirmSheet({
        title: `加入「${pack.label}」这个场景包`,
        message: `这台设备上已经有一些数据了（课程 ${state.courses.length} 门、任务 ${state.tasks.length} 条、目标 ${state.goals.length} 个）。\n\n场景包会合并加进来，不删除、不覆盖你原来的东西。它带的记录会标成「示例」，页面在讲校准和预算时会说清其中有多少来自示例。`,
        confirmText: '合并加入',
      });
      if (!ok) return;
    }
    busy.v = true;
    try {
      const result = await db.loadSample('merge', pack.id);
      changed('scenario');
      toast(result.alreadyLoaded ? `「${pack.label}」已经加入过了` : `已加入「${pack.label}」`, result.alreadyLoaded ? '保留现有记录，不会重复添加。' : '去目标页看它带来的那个目标，进度和天数都是按这台设备上的记录算的。');
    } catch (e) {
      toast('场景包没加载完', (e && e.message) || '这台设备的存储写不进去。', 'bad');
    } finally { busy.v = false; }
  };
  return h('div', { class: 'card' },
    h('h3', { text: '想看它真的用起来什么样？挑一个场景' }),
    h('p', { class: 'hint', text: '四个场景包各自带课表、任务、一个目标和一段过去的专注记录；记录会标明是示例数据，不冒充你自己的历史。' }),
    h('div', { class: 'more-grid' }, ...db.SCENARIOS.map((pack) => h('button', {
      type: 'button', class: 'more-item', onclick: () => load(pack),
    }, h('span', { class: 'more-ico' }, icon('star')), h('b', { text: pack.label }), h('small', { text: pack.desc })))),
  );
}

export function render(root) {
  clear(root);
  const goals = state.goals;
  const budget = dailyBudget();
  const overall = estimateFor('');

  root.append(
    h('div', { class: 'page-head' },
      h('h2', { class: 'page-title', text: '目标' }),
      h('p', { class: 'page-sub', text: '一个大目标摊到每一天；进度从做完的任务和真实专注时长自动汇总，不用手动打勾。样本不够时页面会直说。' }),
    ),
    h('div', { class: 'card' },
      h('h3', {}, h('span', { text: '这台设备上的步幅' }), h('span', { class: 'tag', style: 'margin-left:8px', text: CALIBRATION_RULE_NOTE })),
      h('div', { class: 'row-meta' },
        h('span', { class: budget.enough ? 'tag ok' : 'tag', text: budget.enough ? `一天真正做完约 ${budget.minutes} 分钟` : `有记录的天数还不够（${budget.days} 天）` }),
        h('span', { class: 'tag', text: budget.enough ? `最好的一天约 ${budget.bestDay} 分钟` : '不猜预算' }),
        h('span', { class: overall.enough ? 'tag' : 'tag warn', text: overall.enough ? `实际用时中位数 = 预计的 ${Math.round(overall.rawFactor * 100)}%` : '偏差样本还不够' }),
      ),
      h('p', { class: 'hint', text: budget.note }),
      h('p', { class: 'note muted', text: overall.enough
        ? `预估偏差用了 ${provenance(overall)}。中位数用的是全部可比记录（预计和实际都在 5 分钟以上），一次意外带不跑它；系数夹在 0.6–2.2 之间，超出这个范围的比例只进统计、不改你的日程。`
        : '还没有足够的可比记录，所以「还要几天」这类话星迹暂时不会说出口。' }),
      h('div', { class: 'btn-row', style: 'margin-top:10px' },
        h('button', { class: 'btn btn-primary', onclick: () => editGoal(null, { onSaved: () => goPage('goals') }) }, icon('plus'), h('span', { text: '写一个目标' })),
        goals.length ? h('button', { class: 'btn', onclick: () => goPage('planner'), text: '去计划页排这周的空档' }) : null,
      ),
    ),
  );

  if (!goals.length) {
    root.append(
      h('div', { class: 'card' },
        h('h3', { text: '还没有目标' }),
        h('p', { class: 'empty', text: '目标不是又一张待办清单。它回答的是「今天这些是为了什么」：下面挂若干段小任务，进度和还剩几天从这些任务与专注记录里长出来。' }),
        h('p', { class: 'hint', text: '写的时候尽量具体——「期末周 5 门课过一遍」能算，「好好学习」算不了。' }),
      ),
      scenarioCard(),
      pageAside(factsCard(), quoteCard('进度从哪来', [
        '进度从做完的任务和真实专注时长自动汇总，不用手动打勾。',
        '样本不够时页面直接说，不猜「还要几天」。',
        '目标不是待办清单：它回答「今天这些是为了什么」。',
      ])),
    );
    return;
  }

  const act = goals.filter((g) => g.status !== 'done' && g.status !== 'archived');
  const rest = goals.filter((g) => g.status === 'done' || g.status === 'archived');
  root.append(h('p', { class: 'hint', text: `进行中 ${act.length} 个 · 已完成或归档 ${rest.length} 个 · 目标下的任务合计 ${act.reduce((n, g) => n + effectiveTasks(tasksForGoal(g.id)).length, 0)} 条` }));
  if (!act.length) root.append(h('p', { class: 'empty', text: '没有一个在进行中的目标。可以先写一个，或者从下面的场景里挑一个。' }));
  for (const g of act) root.append(goalCard(g));
  if (rest.length) {
    root.append(h('div', { class: 'card' },
      h('details', { class: 'fold' },
        h('summary', {}, h('span', { class: 'fold-lead', text: '已完成或归档的目标' }), h('span', { text: `${rest.length} 个` })),
        h('div', { class: 'fold-body' }, h('p', { class: 'hint', text: '这里的数字仍然会随记录增删变化：删掉一段专注，进度就跟着降——这是有意的，做完的目标也要经得起回看。' })),
      ),
      ...rest.map((g) => h('div', { class: 'row' },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: g.title }),
          h('div', { class: 'row-meta' },
            h('span', { class: 'tag', text: GOAL_STATUS[g.status] }),
            h('span', { class: 'tag', text: `${goalProgress(g).pct}%` }),
            g.doneAt ? h('span', { text: fmtDateTime(g.doneAt) }) : null,
          ),
        ),
        h('div', { class: 'row-ops' },
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => editGoal(g, { onSaved: () => goPage('goals') }), text: '打开' }),
        ),
      ))),
    );
  }
  if (goals.length < 3) root.append(scenarioCard());
  root.append(pageAside(factsCard(), quoteCard('进度从哪来', [
    '进度从做完的任务和真实专注时长自动汇总，不用手动打勾。',
    '样本不够时页面直接说，不猜「还要几天」。',
    '目标不是待办清单：它回答「今天这些是为了什么」。',
  ])));
}
