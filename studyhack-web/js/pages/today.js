// 今日（工作台）：主动作卡 + 今天概览 + 功能宫格；完整课表/计划/任务留在各自页面
import { state, coursesOn, plansOn, tasksOn, freeMinutesOn, todayStr, overdueTasks, pendingTasks, planStatus, planStats, sessionsOnDate, dayTotals, activeGoals, goalById } from '../state.js';
import { h, icon, clear, toast, openSheet, closeTopSheet, fmtDayTime, relTime, toMin, toHM, ymd, DOW, weekNumberOf, parseLocal } from '../ui.js';
import { dailyBudget, blockerInsight } from '../history.js';
import { editTask, setPlanStatus, deferSheet } from '../forms.js';
import { goPage } from '../app.js';
import { nextUp, pendingCount } from '../remind.js';
import { dataPlace, hostWord } from '../native.js';
import { reblockSheet } from '../reblock.js';

// 「现在能做的一步」在候选之间轮换：只保存在内存里，刷新就回到第一条，不落任何库
let stepCursor = 0;

function nextThing() {
  const ds = todayStr();
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const items = [];
  for (const c of coursesOn(ds)) {
    if (toMin(c.end) >= nowMin) items.push({ at: toMin(c.start), kind: '上课', title: c.name, sub: `${c.start}–${c.end}${c.location ? ` · ${c.location}` : ''}`, page: 'timetable' });
  }
  for (const p of plansOn(ds).filter((x) => planStatus(x) === 'scheduled')) {
    if (toMin(p.start) + p.min >= nowMin) items.push({ at: toMin(p.start), kind: '计划', title: p.title, sub: `${p.start} · ${p.min} 分钟`, page: 'planner', plan: p });
  }
  for (const t of tasksOn(ds).filter((x) => x.status !== 'done')) {
    const mins = parseLocal(t.dueAt) ? new Date(parseLocal(t.dueAt)).getHours() * 60 + new Date(parseLocal(t.dueAt)).getMinutes() : 1439;
    if (mins >= nowMin) items.push({ at: mins, kind: '截止', title: t.title, sub: `${t.dueAt ? t.dueAt.slice(11, 16) : ''} 截止${t.estMin ? ` · 预计 ${t.estMin} 分钟` : ''}`, page: 'tasks' });
  }
  items.sort((a, b) => a.at - b.at);
  return items[0] || null;
}

/** 概览三行：课 / 计划 / 要做的任务。完整列表在各自页面，首页只给数字和入口。 */
function overviewRow(label, meta, page) {
  return h('div', { class: 'row' },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title', text: label }),
      h('div', { class: 'row-meta', text: meta })),
    h('div', { class: 'row-ops' },
      h('button', { class: 'link-btn', onclick: () => goPage(page), text: '查看 ›' })));
}

/** 今天概览：把原来首页的四张列表卡收成三行摘要 + 一条步幅/目标事实 + 下一条提醒。 */
function overviewCard({ cs, ps, ts, od, dayStats, budget, tot, goals, nxt, rem }) {
  const courseMeta = cs.length
    ? cs.map((c) => `${c.start} ${c.name}`).slice(0, 2).join(' · ') + (cs.length > 2 ? ` 等 ${cs.length} 节` : '')
    : '今天没有课';
  const planMeta = ps.length
    ? `${ps.length} 条 · 共 ${ps.reduce((n, p) => n + p.min, 0)} 分钟 · 已完成 ${dayStats.done}/${dayStats.total}${dayStats.skipped ? ` · 跳过 ${dayStats.skipped}` : ''}`
    : '今天还没有排好的计划';
  const taskMeta = `今天到期 ${ts.length} 条 · 待做 ${pendingTasks().length} 条${od.length ? ` · 逾期 ${od.length} 条` : ''}`;
  return h('div', { class: 'card today-overview' },
    h('h3', { text: '今天概览' }),
    h('div', { class: 'today-overview-rows' },
      overviewRow('今天的课', courseMeta, 'timetable'),
      overviewRow('今天的计划', planMeta, 'planner'),
      overviewRow('要做的事', taskMeta, 'tasks'),
      goals.length ? overviewRow('进行中的目标', `${goals.length} 个 · ${goals.slice(0, 2).map((g) => g.title).join('、')}${goals.length > 2 ? '…' : ''}`, 'goals') : null),
    h('p', { class: 'hint', text: `今天已做 ${tot.actual} 分钟${tot.count ? ` · ${tot.count} 段专注` : ''} · ${budget.enough ? `步幅 ${budget.minutes} 分钟` : '步幅样本不足'}` }),
    nxt
      ? h('div', { class: 'row' },
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title', text: `接下来：${nxt.kind} · ${nxt.title}` }),
            h('div', { class: 'row-meta', text: nxt.sub })),
          h('div', { class: 'row-ops' },
            nxt.kind === '计划'
              ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => { state.focusSeed = { taskId: nxt.plan.taskId || null, planId: nxt.plan.id, title: nxt.plan.title, min: nxt.plan.min }; goPage('focus'); } }, icon('play'), h('span', { text: '开始专注' }))
              : h('button', { class: 'btn btn-sm', onclick: () => goPage(nxt.page), text: '去看' })))
      : h('p', { class: 'hint', text: '今天剩下的时间没有固定安排了。要不要给明天排一版计划？' }),
    rem ? h('p', { class: 'hint', text: `下一条提醒：${rem.title} · ${fmtDayTime(rem.at)}（${relTime(rem.at)}）` }) : h('p', { class: 'hint', text: state.settings.remindersEnabled ? '暂时没有待响的提醒。' : '网页提醒还没开启——去提醒页点「开启网页提醒」。' }),
    h('div', { class: 'btn-row', style: 'margin-top:10px' },
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => editTask(null) }, icon('plus'), h('span', { text: '加一个任务' })),
      h('button', { class: 'btn btn-sm', onclick: () => goPage('planner'), text: '生成计划' })),
  );
}

/** 功能入口：放在首页最上面，3×2 图标格，不带卡片头（少一层框）。 */
function featuresBlock() {
  const items = [
    ['calendar', '日历', 'calendar'], ['goals', '目标', 'target'], ['planner', '计划', 'list'],
    ['focus', '专注', 'clock'], ['review', '复盘', 'chart'], ['reminders', '提醒', 'bell'],
  ];
  const n = pendingCount();
  return h('div', { class: 'home-dock', style: 'margin-bottom:var(--sp-4)' },
    h('div', { class: 'home-grid' }, ...items.map(([page, label, ic]) => h('button', {
      type: 'button', class: 'home-tile', dataset: { page }, 'aria-current': state.page === page ? 'page' : 'false',
      onclick: () => goPage(page),
    },
    h('span', { class: 'home-ico' }, icon(ic),
      page === 'reminders'
        ? h('span', { class: 'nav-badge', dataset: { for: 'reminders' }, 'aria-hidden': 'true', hidden: n === 0 }, h('span', { class: 'nb-n', text: n > 99 ? '99+' : String(n) }))
        : null),
    h('b', { text: label })))));
}

/** 「现在能做的一步」的候选：挂了目标的最优先，其次逾期的，最后按预计时长从小到大。
 *  排序规则只陈述取舍顺序，不代表任何 AI 判断。 */
function stepCandidates() {
  const now = Date.now();
  return pendingTasks().map((t) => {
    const est = Number(t.estMin) || 15;
    const due = parseLocal(t.dueAt);
    return { t, est, overdue: Number.isFinite(due) && due < now, goal: t.goalId ? goalById(t.goalId) : null };
  }).sort((a, b) => (b.goal ? 1 : 0) - (a.goal ? 1 : 0) || (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0) || a.est - b.est);
}

function startFocusOn(t, min) {
  state.focusSeed = { taskId: t.id, planId: null, title: t.title, min };
  goPage('focus');
}

/** 首页第一格：一条可以立刻开始的小任务，以及「先做几分钟」。
 *  只做「把开始的门槛降下来」这一件事，其余信息留给任务页。 */
function stepCard(cands, root) {
  if (!cands.length) return null;
  const pick = cands[stepCursor % cands.length];
  const t = pick.t;
  const mins = Math.min(15, pick.est || 15);
  return h('div', { class: 'card card-hero today-step' },
    h('div', { class: 'today-step-context' },
      h('h3', { class: 'today-step-label', text: '现在能做的一步' }),
      h('div', { class: 'row-title today-step-name', text: t.title }),
      h('div', { class: 'row-meta' },
        pick.est > mins ? h('span', { text: `整项预计 ${pick.est} 分钟` }) : null,
        pick.goal ? h('span', { class: 'tag', text: `属于「${pick.goal.title}」` }) : null,
        pick.overdue ? h('span', { class: 'tag bad', text: '已逾期' }) : null)),
    h('div', { class: 'btn-row today-step-actions' },
      h('button', { class: 'btn btn-primary', onclick: () => startFocusOn(t, mins) }, icon('play'), h('span', { text: `开始 ${mins} 分钟` })),
      cands.length > 1 ? h('button', { class: 'btn btn-ghost', onclick: () => { stepCursor += 1; render(root); }, text: '换一个' }) : null),
    h('details', { class: 'plan-details' },
      h('summary', { text: '为什么推荐这一步' }),
      h('p', { class: 'hint', text: '由本机规则推荐，优先考虑目标的下一步，其次考虑逾期和任务时长。' })),
  );
}

/** 最后一次有动作的时间：专注记录或计划被标记完成/跳过的时刻。
 *  任务完成不带时间戳，所以这里只认这两类事实，宁可少算也不编。 */
function lastActivityAt() {
  let max = 0;
  for (const s of state.sessions) max = Math.max(max, new Date(String(s.endedAt)).getTime() || 0);
  for (const p of state.plans) if (p.statusAt) max = Math.max(max, new Date(p.statusAt).getTime() || 0);
  return max;
}

/** 「减少本周任务」：列出未来 7 天还没做的计划，勾选要跳过的；跳过可撤销，任务本身不删。 */
function trimWeekSheet(root) {
  const ds = todayStr();
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const end = ymd(new Date(Date.now() + 7 * 864e5));
  const future = state.plans
    .filter((p) => planStatus(p) === 'scheduled' && p.date >= ds && p.date <= end && !(p.date === ds && toMin(p.start) + p.min <= nowMin))
    .sort((a, b) => `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`));
  if (!future.length) {
    toast('未来 7 天没有待做的计划', '没有可以减的条目。');
    return;
  }
  const picked = new Set();
  let sheet;
  const content = h('div', { class: 'check-list' },
    ...future.map((p) => {
      const cb = h('input', { type: 'checkbox', 'aria-label': `跳过：${p.title}` });
      cb.addEventListener('change', () => { cb.checked ? picked.add(p.id) : picked.delete(p.id); });
      const when = p.date === ds ? '今天' : p.date;
      const sub = h('span', { style: 'display:block;font-size:var(--fs-3);color:var(--ink-dim)', text: `${when} ${p.start} · ${p.min} 分钟` });
      return h('label', { class: 'check-row', style: 'display:flex;gap:8px;align-items:flex-start;cursor:pointer' },
        cb,
        h('span', {}, h('b', { text: p.title }), sub));
    }),
    h('p', { class: 'note muted', text: '只把勾选的那些标成「跳过」，任务和课程都不动；跳过后可以撤销。' }),
  );
  sheet = openSheet({
    title: '减少未来 7 天的计划',
    content,
    actions: [
      h('button', { class: 'btn', onclick: () => sheet.close(), text: '取消' }),
      h('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!picked.size) { toast('还没勾选', '想减哪几条，勾上再确认。'); return; }
          sheet.close();
          const ids = [...picked];
          const done = [];
          for (const id of ids) {
            const p = state.plans.find((x) => x.id === id);
            if (p && await setPlanStatus(p, 'skipped', { silent: true })) done.push(p);
          }
          render(root);
          openSheet({
            title: `已跳过 ${done.length} 条计划`,
            content: h('div', {},
              ...done.map((p) => h('p', { style: 'margin:2px 0', text: `${p.title} · ${p.date} ${p.start}` })),
              h('p', { class: 'note muted', text: '任务本身一条没删，课程也没动。想恢复就点下面的撤销。' })),
            actions: [
              h('button', { class: 'btn', onclick: () => closeTopSheet(), text: '知道了' }),
              h('button', {
                class: 'btn btn-primary',
                onclick: async () => {
                  closeTopSheet();
                  let back = 0;
                  for (const p of done) {
                    if (planStatus(p) === 'skipped' && await setPlanStatus(p, 'scheduled', { silent: true })) back += 1;
                  }
                  render(root);
                  toast('已撤销', `${back} 条计划回到「待做」。`);
                },
                text: '撤销这些跳过',
              }),
            ],
          });
        },
        text: '跳过选中的',
      }),
    ],
  });
}

/** 中断后的温和重启：几天没有任何动作时出现，三个低压力入口，全部可撤销。 */
function restartCard(cands, root) {
  if (!cands.length) return null;
  const last = lastActivityAt();
  if (!last) return null;
  const gap = Math.floor((Date.now() - last) / 864e5);
  if (gap < 2) return null;
  const pick = cands[0];
  const overdue = cands.find((x) => x.overdue);
  return h('div', { class: 'card' },
    h('div', { class: 'btn-row', style: 'margin-bottom:4px' },
      h('h3', { style: 'margin:0', text: '几天没动，先温和地重启' }),
      h('span', { class: 'spacer', style: 'flex:1' }),
      h('span', { class: 'tag', text: '规则生成 · 未调用 AI' })),
    h('p', { class: 'hint', text: `上次记录在 ${gap} 天前；这三个调整都能撤回：` }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-sm', onclick: () => startFocusOn(pick.t, 5) }, icon('play'), h('span', { text: '先做 5 分钟' })),
      h('button', { class: 'btn btn-sm', onclick: () => trimWeekSheet(root), text: '减少未来 7 天' }),
      overdue ? h('button', { class: 'btn btn-sm', onclick: () => deferSheet(overdue.t), text: '重定截止日' }) : null,
    ),
  );
}
function reblockPicker(items, onPick, insight) {
  const sheet = openSheet({
    title: '挑一条没做完的计划',
    content: h('div', {},
      h('p', { class: 'hint', text: '选一条计划，再选择卡住的原因。调整方案由本机规则生成，确认后才会保存。' }),
      insight.enough ? h('p', { class: 'note muted', text: insight.text }) : null,
      ...items.map((p) => h('button', {
        class: 'btn btn-block', style: 'margin-bottom:6px;text-align:left',
        onclick: () => { sheet.close(); onPick(p); },
      }, h('b', { text: p.title }),
         h('span', { style: 'display:block;font-size:var(--fs-3);color:var(--ink-dim);font-weight:400', text: `${p.date === todayStr() ? '今天' : p.date} ${p.start} · ${p.min} 分钟${p.taskId ? '' : ' · 无关联任务'}` }))),
    ),
    actions: [h('button', { class: 'btn', onclick: () => sheet.close(), text: '取消' })],
  });
  return sheet;
}

/** 首次使用：一键加载示例 + 三步导览，把「今天的计划 → 没做完 → 选原因 → 看提案」讲清楚 */
function startDemo() {
  const btn = document.getElementById('btn-sample');
  if (btn) { try { btn.click(); } catch (e) { /* 交给 btn 自己的错误处理 */ } }
  setTimeout(() => {
    const s = openSheet({
      title: '两分钟体验：计划没做完，怎么重新安排',
      content: h('div', {},
        h('p', { class: 'hint', text: '示例已经放好了。跟着三步走，看星迹在「没做完」时怎么帮你重新找到下一步：' }),
        h('ul', { style: 'margin:6px 0 0;padding-left:18px;line-height:1.8;font-size:var(--fs-3)' },
          h('li', { text: '① 看「今天的计划」里那条早上已经结束、还没做的。' }),
          h('li', { text: '② 点它旁边的「没做完？」；也可以在顶部「重拾行动」里挑一条。' }),
          h('li', { text: '③ 选一个最接近的原因，看星迹给出的可编辑调整提案——确认前不会写库。' }),
        ),
        h('p', { class: 'note muted', text: '整个过程是本机规则算的，没有调用 AI；不满意随时取消。' }),
      ),
      actions: [h('button', { class: 'btn btn-primary', onclick: () => s.close(), text: '知道了，开始' })],
    });
  }, 1000);
}

export function render(root) {
  clear(root); // 保存/撤销后页面会自己再 render 一次，先清空才不会和路由重绘叠成两份
  const ds = todayStr();
  const s = state.settings;
  const week = weekNumberOf(ds, s.termStart);
  const cs = coursesOn(ds);
  const ps = plansOn(ds);
  const ts = tasksOn(ds).filter((t) => t.status !== 'done');
  const od = overdueTasks();
  const free = freeMinutesOn(ds);
  const nxt = nextThing();
  const rem = nextUp();
  const dayStats = planStats(ds, ds);
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  // 「没做完的计划」= 今天已结束还没做 + 近 7 天还没做；去重后按时间倒序
  const weekAgo = (() => { const d = new Date(`${ds}T12:00:00`); d.setDate(d.getDate() - 7); return ymd(d); })();
  const reblockItems = [
    ...ps.filter((p) => planStatus(p) === 'scheduled' && toMin(p.start) + p.min <= nowMin),
    ...state.plans.filter((p) => p.date < ds && p.date >= weekAgo && planStatus(p) === 'scheduled'),
  ].filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i)
    .sort((a, b) => `${b.date}T${b.start}`.localeCompare(`${a.date}T${a.start}`));

  const head = h('div', { class: 'page-head' },
    h('h2', { class: 'page-title', text: `${DOW[((new Date().getDay() + 6) % 7)]} · ${ds}` }),
    h('p', { class: 'page-sub', text: `${week ? `第 ${week} 周 · ` : ''}今天 ${cs.length} 节课 · ${ps.length} 条计划 · ${ts.length} 条到期 · 空闲约 ${Math.round(free / 5) * 5} 分钟` }),
  );

  const stepCands = stepCandidates();
  const step = stepCard(stepCands, root);
  const restart = restartCard(stepCands, root);
  const budget = dailyBudget();
  const tot = dayTotals(sessionsOnDate(ds));
  const goals = activeGoals();
  const overview = overviewCard({ cs, ps, ts, od, dayStats, budget, tot, goals, nxt, rem });
  const empty = !state.courses.length && !state.tasks.length && !state.goals.length && !state.plans.length;
  root.append(head);
  let recovery = null;
  if (reblockItems.length) {
    const openRecovery = () => reblockPicker(
      reblockItems,
      (p) => reblockSheet(p, { onDone: () => render(root) }),
      blockerInsight({ days: 14 }),
    );
    recovery = h('div', { class: step ? 'card recovery-entry' : 'card card-hero recovery-entry' },
      h('strong', { text: `有 ${reblockItems.length} 条计划没做完` }),
      h('button', {
        type: 'button',
        class: step ? 'btn btn-sm' : 'btn btn-primary',
        onclick: openRecovery,
      }, h('span', { text: '重拾行动' }), icon('right')),
    );
  }
  if (empty) {
    root.append(h('div', { class: 'card card-hero today-demo' },
      h('h3', { text: '两分钟体验星迹' }),
      h('p', { class: 'hint', text: '试着把一次没做完的计划，调整成今天能开始的一小步。' }),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-primary', onclick: () => startDemo() }, icon('play'), h('span', { text: '体验一个学习目标（约 2 分钟）' })),
        h('button', { class: 'btn btn-ghost', onclick: () => goPage('goals') }, h('span', { text: '创建自己的目标' })),
      ),
      h('p', { class: 'note muted', text: `目标和计划保存在${dataPlace()}里，离线也能查看。` }),
    ));
  }
  if (step) {
    root.append(h('div', { class: 'today-workbench' }, h('div', { class: 'today-actions' }, step, recovery), overview));
  } else {
    if (recovery) root.append(recovery);
    root.append(overview);
  }
  root.append(featuresBlock());
  if (restart) root.append(restart);
}
