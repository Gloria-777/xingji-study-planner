// 日历：同屏显示课程 + 计划 + 任务；点日期看当天；可从当天直接建任务
import { state, coursesOn, plansOn, tasksOn, freeMinutesOn, todayStr, planStatus, planStats, spentMinForPlan } from '../state.js';
import { h, icon, clear, put, ymd, pad2, DOW, courseColor, weekNumberOf, PLAN_STATUS_LABEL, planSourceLabel, toMin } from '../ui.js';
import { editTask, editPlan, removePlan, taskRow, planStatusPills } from '../forms.js';

let cur = new Date();
let sel = todayStr();

const sameMonth = (dStr, ref) => dStr.slice(0, 7) === `${ref.getFullYear()}-${pad2(ref.getMonth() + 1)}`;

// 只合并显示，保留每条原始课程记录；规则与课程表一致。
function calendarCourses(ds) {
  const groups = new Map();
  for (const course of coursesOn(ds)) {
    const key = JSON.stringify([course.name, course.day, toMin(course.start), toMin(course.end),
      course.location || '', course.teacher || '', String(course.weekStart ?? ''),
      String(course.weekEnd ?? ''), course.parity || 'all']);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { course, count: 1 });
  }
  return [...groups.values()];
}

function chipsFor(ds) {
  const out = [];
  for (const { course: c, count } of calendarCourses(ds)) out.push({ cls: 'course', text: `${c.start} ${c.name}`, time: c.start, color: courseColor(c.name)[0], title: `${c.start}–${c.end} ${c.name}${c.location ? ' · ' + c.location : ''}${count > 1 ? '（' + count + ' 条相同记录已合并展示）' : ''}` });
  for (const p of plansOn(ds)) {
    const st = planStatus(p);
    out.push({
      cls: `plan${st === 'done' ? ' pd' : st === 'skipped' ? ' ps' : ''}`, time: p.start, finished: st !== 'scheduled',
      text: `${st === 'done' ? '✓ ' : st === 'skipped' ? '— ' : ''}${p.start} ${p.title}`,
    });
  }
  for (const t of tasksOn(ds)) out.push({ cls: `task${t.status === 'done' ? ' done' : ''}`, text: `${t.status === 'done' ? '✓ ' : ''}${t.dueAt ? t.dueAt.slice(11, 16) : ''} ${t.title}`, time: t.dueAt?.slice(11, 16) || '23:59', finished: t.status === 'done' });
  return out.sort((a, b) => Number(!!a.finished) - Number(!!b.finished) || String(a.time).localeCompare(String(b.time)));
}

function dayDetail(root, refresh) {
  const box = h('div', { class: 'card cal-detail', tabindex: '-1' });
  const draw = () => {
    clear(box);
    const ds = sel;
    const cs = calendarCourses(ds);
    const ps = plansOn(ds);
    const ts = tasksOn(ds);
    const st = planStats(ds, ds);
    const week = weekNumberOf(ds, state.settings.termStart);
    put(box,
      h('div', { class: 'btn-row', style: 'margin-bottom:8px' },
        h('h3', { style: 'margin:0;font-size:16px', text: `${ds} ${DOW[((new Date(`${ds}T12:00:00`).getDay() + 6) % 7)]}${week ? ` · 第${week}周` : ''}` }),
        h('span', { class: 'spacer', style: 'flex:1' }),
        h('button', { class: 'btn btn-sm', onclick: () => newTaskHere(ds) }, icon('plus'), h('span', { text: '从这天建任务' })),
        h('button', { class: 'btn btn-sm', onclick: () => editPlan({ title: '', date: ds, start: '19:00', min: 30 }) }, h('span', { text: '加一条计划' })),
      ),
      h('p', { class: 'hint', text: `课程 ${cs.length} 节 · 计划 ${ps.length} 条（${ps.reduce((n, p) => n + Number(p.min), 0)} 分钟，已完成 ${st.done}/${st.total}${st.skipped ? `、已跳过 ${st.skipped}` : ''}） · 到期任务 ${ts.filter((t) => t.status !== 'done').length} 条 · 空闲约 ${Math.round(freeMinutesOn(ds) / 5) * 5} 分钟` }),
      cs.length ? h('div', {}, h('h4', { style: 'font-size:14px;margin:12px 0 2px;color:var(--ink-soft)', text: '当天课程' }),
        ...cs.map(({ course: c, count }) => h('div', { class: 'row cal-detail-course' },
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title' }, h('span', { text: c.name }), count > 1 ? h('span', { class: 'cal-record-count', title: '相同课程的 ' + count + ' 条原始记录均已保留', text: '×' + count }) : null),
            h('div', { class: 'row-meta' }, h('span', { text: `${c.start}–${c.end}` }), c.location ? h('span', { text: c.location }) : null),
          ),
        ))) : h('p', { class: 'empty', text: '这天没有课。' }),
      ps.length ? h('div', {}, h('h4', { style: 'font-size:14px;margin:12px 0 2px;color:var(--ink-soft)', text: '当天计划' }),
        ...ps.map((p) => {
          const s2 = planStatus(p);
          const spent = spentMinForPlan(p.id);
          return h('div', { class: `row${s2 !== 'scheduled' ? ` plan-${s2}` : ''}` },
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title', text: `${p.start} · ${p.title}` }),
              h('div', { class: 'row-meta' },
                h('span', { class: `tag ${s2 === 'done' ? 'ok' : s2 === 'skipped' ? 'warn' : ''}`, text: PLAN_STATUS_LABEL[s2] }),
                h('span', { text: `${p.min} 分钟` }),
                h('span', { class: 'tag', text: planSourceLabel(p) }),
                h('span', { class: 'tag', text: spent ? `已投入 ${spent} 分钟` : '无专注记录' }),
              ),
              p.basis ? h('div', { class: 'row-meta' }, h('span', { class: 'note muted', text: `依据：${p.basis}` })) : null,
              planStatusPills(p, refresh),
            ),
            h('div', { class: 'row-ops' },
              h('button', { class: 'icon-btn', title: '修改', onclick: () => editPlan(p), 'aria-label': '修改这条计划' }, icon('edit')),
              h('button', { class: 'icon-btn', title: '删除', onclick: () => removePlan(p), 'aria-label': '删除这条计划' }, icon('trash')),
            ),
          );
        })) : null,
      ts.length ? h('div', {}, h('h4', { style: 'font-size:14px;margin:12px 0 2px;color:var(--ink-soft)', text: '这天到期的任务' }),
        ...ts.map((t) => taskRow(t))) : null,
    );
  };
  const newTaskHere = (ds) => {
    const hour = ds === todayStr() ? Math.min(23, new Date().getHours() + 3) : 21;
    editTask({ title: '', subject: '', dueAt: `${ds}T${pad2(hour)}:00`, estMin: 30, priority: 'medium', note: '', status: 'pending' });
  };
  draw();
  return box;
}

export function render(root) {
  clear(root); // 页面自己也会再 render（改/删计划后），先清空才不会和路由重绘叠成两份
  const grid = h('div', { class: 'cal-grid' });
  const detail = h('div', {});
  const label = h('span', { class: 'cal-month' });

  const draw = () => {
    clear(grid);
    const y = cur.getFullYear(), m = cur.getMonth();
    label.textContent = `${y} 年 ${m + 1} 月`;
    const first = new Date(y, m, 1);
    const startDow = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startDow; i++) {
      const d = new Date(y, m, i - startDow + 1);
      cells.push(ymd(d));
    }
    for (let d = 1; d <= daysInMonth; d++) cells.push(`${y}-${pad2(m + 1)}-${pad2(d)}`);
    while (cells.length % 7) {
      const last = cells[cells.length - 1];
      const d = new Date(`${last}T12:00:00`);
      d.setDate(d.getDate() + 1);
      cells.push(ymd(d));
    }
    DOW.forEach((x) => grid.append(h('div', { class: 'cal-dow', text: x })));
    for (const ds of cells) {
      const chips = chipsFor(ds);
      const inMonth = sameMonth(ds, cur);
      const shown = inMonth ? chips.slice(0, 2) : [];
      grid.append(
        h('button', {
          class: `cal-cell${sameMonth(ds, cur) ? '' : ' out'}${ds === todayStr() ? ' today' : ''}`,
          'aria-pressed': ds === sel ? 'true' : 'false',
          onclick: () => {
            sel = ds; draw();
            const panel = detail.firstElementChild;
            panel?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
            panel?.focus({ preventScroll: true });
          },
          'aria-label': `${ds}，${chips.length} 项安排`,
        },
          h('div', { class: 'cal-date', text: ds.slice(8) }),
          ...shown.map((c) => h('div', { class: `cal-chip ${c.cls}`, style: c.color ? `border-left-color:${c.color}` : '', title: c.title || c.text, text: c.text })),
          inMonth && chips.length > shown.length ? h('div', { class: 'cal-more', text: `还有 ${chips.length - shown.length} 项`, 'aria-hidden': 'true', 'data-count': chips.length - shown.length }) : null,
        ),
      );
    }
    detail.replaceChildren(dayDetail(root, draw));
  };

  root.append(
    h('div', { class: 'page-head' },
      h('h2', { class: 'page-title', text: '日历' }),
      h('p', { class: 'page-sub', text: '课程、计划、任务在同一张月历上。点任意日期看当天安排，也能直接从那天建任务。' }),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'cal-toolbar' },
        h('button', { class: 'btn btn-sm', onclick: () => { cur = new Date(cur.getFullYear(), cur.getMonth() - 1, 1); draw(); }, text: '‹ 上月' }),
        label,
        h('button', { class: 'btn btn-sm', onclick: () => { cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1); draw(); }, text: '下月 ›' }),
        h('button', { class: 'btn btn-sm', onclick: () => { cur = new Date(); sel = todayStr(); draw(); }, text: '回到今天' }),
        h('span', { class: 'spacer', style: 'flex:1' }),
        h('span', { class: 'tag', text: '课程' }), h('span', { class: 'cal-chip plan', text: '计划' }), h('span', { class: 'cal-chip task', text: '任务' }),
      ),
      grid,
      h('p', { class: 'hint', text: '每天预览两项安排，点日期查看当天全部内容；相同课程合并显示，原始记录保留。' }),
    ),
    detail,
  );
  draw();
}
