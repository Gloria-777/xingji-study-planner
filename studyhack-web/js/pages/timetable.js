// 课程表：按周翻页、重叠并排显示、时间轴可调、手动编辑删除、CSV/TSV 批量导入
import * as db from '../store.js';
import { state, weekDates, shiftWeek, coursesOn, courseOn, isToday, todayStr } from '../state.js';
import { h, icon, clear, toast, openSheet, selectEl, toMin, DOW, courseColor, weekNumberOf, download, isNarrow } from '../ui.js';
import { editCourse, courseSheet, changed } from '../forms.js';
import { parseCourses, annotateConflicts, TEMPLATE } from '../csv.js';

let fullAxis = false;

function groupCourses(courses) {
  const groups = new Map();
  for (const course of courses) {
    const key = JSON.stringify([course.name, course.day, toMin(course.start), toMin(course.end),
      course.location || '', course.teacher || '', String(course.weekStart ?? ''),
      String(course.weekEnd ?? ''), course.parity || 'all']);
    const records = groups.get(key);
    if (records) records.push(course);
    else groups.set(key, [course]);
  }
  return [...groups.values()].sort(([a], [b]) => toMin(a.start) - toMin(b.start) || toMin(a.end) - toMin(b.end));
}

function openCourseRecords(records) {
  const [course] = records;
  if (records.length === 1) return courseSheet(course);
  const sheet = openSheet({
    title: course.name,
    content: h('div', {},
      h('p', { class: 'hint', text: course.start + '–' + course.end + ' · ' + records.length + ' 条相同课程记录。选一条查看或编辑。' }),
      ...records.map((record, index) => h('button', {
        type: 'button', class: 'btn btn-block tt-record',
        text: '记录 ' + (index + 1) + (record.demo ? ' · 示例课程' : ''),
        onclick: () => { sheet.close(); courseSheet(record); },
      }))),
    actions: [h('button', { class: 'btn', text: '关闭', onclick: () => sheet.close() })],
  });
  return sheet;
}

/** 连续两小时以上全周无课才折叠。有课的每分钟仍使用同一比例。 */
function timeAxis(startHour, endHour, days, compact) {
  const hourHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--axis-h')) || 52;
  const occupied = new Set();
  for (const { groups } of days) {
    for (const [course] of groups) {
      const first = Math.max(startHour, Math.floor(toMin(course.start) / 60));
      const last = Math.min(endHour, Math.ceil(toMin(course.end) / 60));
      for (let hour = first; hour < last; hour += 1) occupied.add(hour);
    }
  }
  const bands = [];
  let height = 0;
  for (let hour = startHour; hour < endHour;) {
    let next = hour + 1;
    if (compact && !occupied.has(hour)) {
      while (next < endHour && !occupied.has(next)) next += 1;
    }
    const folded = next - hour > 1;
    const size = folded ? Math.max(28, Math.round(hourHeight * 0.6)) : hourHeight;
    bands.push({ hour, next, top: height, size, folded });
    height += size;
    hour = next;
  }
  const start = startHour * 60, end = endHour * 60;
  const position = (minute) => {
    if (minute <= start) return 0;
    if (minute >= end) return height;
    const band = bands.find(({ next }) => minute < next * 60);
    return band.top + band.size * (minute / 60 - band.hour) / (band.next - band.hour);
  };
  return { start, end, bands, height, position };
}

/** 同一天重叠的课程并排分配列 */
function packDay(list) {
  const sorted = [...list].sort((a, b) => toMin(a.start) - toMin(b.start) || toMin(a.end) - toMin(b.end));
  const clusters = [];
  for (const c of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && toMin(c.start) < last.end) { last.items.push(c); last.end = Math.max(last.end, toMin(c.end)); }
    else clusters.push({ items: [c], end: toMin(c.end) });
  }
  const pos = new Map();
  for (const cl of clusters) {
    const colEnds = [];
    for (const c of cl.items) {
      let idx = colEnds.findIndex((end) => end <= toMin(c.start));
      if (idx < 0) { colEnds.push(toMin(c.end)); idx = colEnds.length - 1; }
      else colEnds[idx] = toMin(c.end);
      pos.set(c.id, { col: idx });
    }
    for (const c of cl.items) pos.get(c.id).cols = colEnds.length;
  }
  return pos;
}

function courseBlock(records, axis, packed = false) {
  const [c] = records;
  const [a, b] = courseColor(c.name);
  const top = axis.position(toMin(c.start));
  const height = axis.position(toMin(c.end)) - top - 3;
  const repeated = records.length > 1 ? ' · ' + records.length + ' 条相同记录' : '';
  // 并排的窄格放不下完整区间：退成只写开始时刻，时间仍可读，完整区间在 aria-label 和详情里
  const timeEl = packed
    ? (height >= 56 ? h('span', { class: 'tt-time', text: c.start }) : null)
    : h('span', { class: 'tt-time', text: `${c.start}-${c.end}` });
  const el = h('button', {
    class: `tt-course${c.parity && c.parity !== 'all' ? ' parity' : ''}`,
    style: `top:${top}px;height:${Math.max(18, height)}px;background:linear-gradient(150deg,${a},${b});`,
    title: `${c.name} ${c.start}-${c.end} ${c.location || ''}${repeated}\n${DOW[c.day - 1]} 第${c.weekStart}-${c.weekEnd}周 ${c.parity === 'odd' ? '单周' : c.parity === 'even' ? '双周' : '每周'}`,
    'aria-label': `${c.name}，${DOW[c.day - 1]} ${c.start} 到 ${c.end}${c.location ? `，${c.location}` : ''}${repeated}`,
    onclick: () => openCourseRecords(records),
  }, h('b', { text: c.name }, records.length > 1 ? h('small', { text: ' ×' + records.length }) : null),
  timeEl, height > (packed ? 74 : 58) ? h('span', { class: 'tt-loc', text: c.location || '' }) : null);
  return el;
}

let hintObs = null;

function grid(days, axisStart, axisEnd, compact) {
  const axis = timeAxis(axisStart, axisEnd, days, compact);
  const bandStyle = 'grid-template-rows:' + axis.bands.map(({ size }) => size + 'px').join(' ');
  const hourCells = h('div', { class: 'tt-hours', style: bandStyle },
    ...axis.bands.map(({ hour, next, folded }) => h('div', {
      class: folded ? 'tt-hour tt-hour-folded' : 'tt-hour',
      title: folded ? hour + ':00–' + next + ':00 全周无课' : null,
      text: folded ? hour + '–' + next : hour + ':00',
    })));
  const cols = days.map(({ date, groups }, dayIndex) => {
    const visible = groups.filter(([c]) => toMin(c.start) < axis.end && toMin(c.end) > axis.start);
    const pos = packDay(visible.map(([course]) => course));
    return h('div', { class: 'tt-col', style: 'height:' + axis.height + 'px' },
      h('div', { class: 'tt-axis-guide', style: bandStyle, 'aria-hidden': 'true' },
        ...axis.bands.map(({ folded }) => h('span', {
          class: folded ? 'tt-axis-folded' : null,
          text: folded && dayIndex === 0 ? '全周无课' : null,
        }))),
      ...visible.map((records) => {
        const placement = pos.get(records[0].id);
        const block = courseBlock(records, axis, placement.cols > 1);
        block.style.left = 'calc(' + (placement.col * 100) / placement.cols + '% + 2px)';
        block.style.width = 'calc(' + 100 / placement.cols + '% - 5px)';
        return block;
      }),
      isToday(date) ? nowLine(axis) : null,
    );
  });
  const hint = h('p', { class: 'tt-hint' }, icon('swipe'), h('span', { text: '左右滑动查看其他日期' }));
  const wrap = h('div', { class: 'tt-wrap' },
    h('div', { class: 'tt-grid' },
      h('div', { class: 'tt-corner', text: '时间' }),
      ...days.map(({ date: ds, groups }) => h('div', { class: `tt-dow${isToday(ds) ? ' today' : ''}` },
        h('div', { text: DOW[((new Date(`${ds}T12:00:00`).getDay() + 6) % 7)] }),
        h('div', { class: 'tt-day-meta', text: ds.slice(5).replace('-', '/') }),
        h('span', { class: 'tt-day-count', text: groups.length ? groups.length + ' 节' : '无课' }),
      )),
      hourCells, ...cols,
    ),
  );
  // 提示只在真的放不下时出现，宽屏上看不到这行。
  // 这里不能只等 rAF / ResizeObserver 回调：标签页在后台时两者都不执行（页面不产帧），所以挂载后先同步量一次，
  // 之后宽度再变化才交给 observer。
  const sync = () => hint.classList.toggle('on', wrap.scrollWidth - wrap.clientWidth > 4);
  if (hintObs) hintObs.disconnect();
  if (window.ResizeObserver) { hintObs = new ResizeObserver(sync); hintObs.observe(wrap); }
  requestAnimationFrame(sync);
  const box = h('div', {}, hint, wrap);
  box.syncHint = sync;
  return box;
}

function nowLine(axis) {
  const d = new Date();
  const mins = d.getHours() * 60 + d.getMinutes();
  if (mins < axis.start || mins >= axis.end) return null;
  return h('div', { class: 'tt-now', style: 'top:' + axis.position(mins) + 'px' });
}

/** 今日列表显示实际的今天，和网格当前查看的周次独立。 */
function todayList() {
  const ds = todayStr();
  const list = groupCourses(coursesOn(ds));
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (!list.length) return h('p', { class: 'tt-today-empty', text: '今天没有课' });
  return h('details', { class: 'fold tt-today' },
    h('summary', {},
      h('span', { class: 'fold-lead', text: '今日课程' }),
      h('span', { class: 'fold-now', text: `${list.length} 节` })),
    h('div', { class: 'fold-body' }, ...list.map((records) => {
      const [c] = records;
      const [a] = courseColor(c.name);
      const ongoing = nowMin >= toMin(c.start) && nowMin < toMin(c.end);
      const past = nowMin >= toMin(c.end);
      const repeated = records.length > 1 ? ' · ' + records.length + ' 条相同记录' : '';
      return h('button', {
        type: 'button',
        class: `tt-today-row${past ? ' past' : ''}${ongoing ? ' now' : ''}`,
        style: `border-left-color:${a}`,
        'aria-label': `${c.name}，${c.start} 到 ${c.end}${c.location ? `，${c.location}` : ''}${repeated}，点按查看详情`,
        onclick: () => openCourseRecords(records),
      },
        h('span', { class: 'tt-today-time', text: `${c.start}–${c.end}` }),
        h('span', { class: 'tt-today-main' },
          h('b', { text: c.name }),
          h('span', { class: 'tt-today-loc', text: (c.location || '未填地点') + repeated })),
        ongoing ? h('span', { class: 'tag ok', text: '进行中' }) : null);
    })));
}

// ---------- CSV / TSV 导入 ----------
function importSheet() {
  const ta = h('textarea', {
    rows: 8, spellcheck: 'false',
    placeholder: '把教务系统或 Excel 里的课程粘贴到这里（用逗号或 Tab 分隔都可以）。\n例：高等数学,周一,08:00,09:40,教一 301,王老师,1,16,每周',
    style: 'width:100%;font-family:var(--mono,ui-monospace,monospace);font-size:var(--fs-3)',
  });
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain' });
  const status = h('div', { class: 'hint', text: '支持 CSV / TSV。有表头会按列名识别；没有表头按：课程名称,星期,开始时间,结束时间,地点,老师,起始周,结束周,单双周。' });
  const listBox = h('div', { class: 'check-list', hidden: true });
  let parsed = null;
  let checks = [];

  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { ta.value = String(reader.result || ''); run(); };
    reader.onerror = () => toast('读取文件失败', '请改用「粘贴文本」的方式。', 'bad');
    reader.readAsText(f, 'utf-8');
  });

  function run() {
    const text = ta.value;
    if (!text.trim()) { status.textContent = '请先粘贴内容或选择文件。'; return; }
    parsed = parseCourses(text);
    if (parsed.error) { status.textContent = parsed.error; return; }
    annotateConflicts(parsed, state.courses);
    clear(listBox);
    checks = parsed.rows.map((r, i) => {
      const cb = h('input', { type: 'checkbox', checked: r.ok && !r.warnings.some((w) => w.includes('完全重复')) });
      r.checked = cb;
      const meta = [];
      if (r.ok) meta.push(h('span', { class: 'tag ok', text: '可导入' }));
      for (const e of r.errors) meta.push(h('span', { class: 'tag bad', text: e }));
      for (const w of r.warnings) meta.push(h('span', { class: 'tag warn', text: w }));
      return h('div', { class: `check-row${r.ok ? '' : ' bad'}` }, cb,
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: r.ok
            ? `${r.course.name} · ${DOW[(r.course.day || 1) - 1]} ${r.course.start}-${r.course.end}${r.course.location ? ` · ${r.course.location}` : ''}${r.course.parity !== 'all' ? ` · ${r.course.parity === 'odd' ? '单周' : '双周'}` : ''} 第${r.course.weekStart}-${r.course.weekEnd}周`
            : `第 ${r.line} 行：${r.input}` }),
          h('div', { class: 'row-meta' }, ...meta),
        ),
      );
    });
    listBox.append(...checks);
    listBox.hidden = false;
    const bad = parsed.rows.filter((r) => !r.ok).length;
    status.textContent = `解析出 ${parsed.rows.length} 行（分隔符：${parsed.delimiter}${parsed.headerFound ? '，已识别表头' : '，未识别到表头'}）。可导入 ${parsed.valid} 条${bad ? `，有问题 ${bad} 条` : ''}。请核对后确认。`;
  }

  async function apply() {
    const chosen = parsed.rows.filter((r) => r.ok && r.checked.checked).map((r) => r.course);
    if (!chosen.length) { toast('没有勾选任何可导入的行', '请检查勾选项或修正内容。', 'bad'); return; }
    const rows = chosen.map((c) => ({
      id: db.uid(), ...c, createdAt: new Date().toISOString(),
    }));
    await db.bulkPut('courses', rows);
    state.courses = [...state.courses, ...rows].sort((a, b) => a.day - b.day || toMin(a.start) - toMin(b.start));
    api.close();
    changed('course-import');
    toast(`已导入 ${rows.length} 门课程`, '课表已更新。导入前显示的是核对清单，未勾选的行没有写入。');
  }

  const api = openSheet({
    title: '批量导入课程表（CSV / TSV）',
    wide: true,
    content: h('div', {},
      h('div', { class: 'btn-row', style: 'margin-bottom:10px' },
        h('button', { class: 'btn btn-sm', onclick: run }, icon('spark'), h('span', { text: '解析并生成核对清单' })),
        h('button', { class: 'btn btn-sm', onclick: () => download('课表模板.csv', TEMPLATE, 'text/csv;charset=utf-8') }, h('span', { text: '下载模板' })),
        file,
      ),
      ta, status, listBox,
      h('p', { class: 'note', text: '这里没有图片识别课表的入口：识别服务没接上，就不摆一个识别不了的按钮。要接入需要另配服务端。' }),
    ),
    actions: [
      h('button', { class: 'btn', onclick: () => api.close(), text: '取消' }),
      h('button', { class: 'btn btn-primary', onclick: apply, text: '确认导入勾选的行' }),
    ],
  });
}

// ---------- 页面 ----------
export function render(root) {
  clear(root); // 页面自己也会再 render（导入/删除后），先清空才不会和路由重绘叠成两份
  const s = state.settings;
  let axisStart = Number(s.axisStart) || 7;
  let axisEnd = Number(s.axisEnd) || 23;
  if (axisEnd <= axisStart) axisEnd = Math.min(25, axisStart + 12);
  const dates = weekDates(state.week);
  const narrow = isNarrow();

  const axisSel = selectEl(
    Array.from({ length: 18 }, (_, i) => ({ value: String(5 + i), label: `${5 + i}:00` })),
    String(axisStart), { 'aria-label': '时间轴起点' },
  );
  const axisSelEnd = selectEl(
    Array.from({ length: 18 }, (_, i) => ({ value: String(8 + i), label: `${8 + i}:00` })),
    String(axisEnd), { 'aria-label': '时间轴终点' },
  );
  const redraw = () => {
    const days = dates.map((date) => ({ date, groups: groupCourses(coursesOn(date)) }));
    const compact = !narrow && !fullAxis && days.some(({ groups }) => groups.length > 0);
    const g = grid(days, Number(axisSel.value), Number(axisSelEnd.value), compact);
    body.replaceChildren(g);
    g.syncHint();
    const notThisWeek = state.courses.filter((c) => !dates.some((ds) => courseOn(c, ds))).length;
    const courses = days.flatMap(({ groups }) => groups.map(([course]) => course));
    const minutes = courses.reduce((sum, c) => sum + toMin(c.end) - toMin(c.start), 0);
    info.textContent = '本周 ' + courses.length + ' 节课 · 约 ' + (minutes / 60).toFixed(1) + ' 小时'
      + (notThisWeek ? ' · 另有 ' + notThisWeek + ' 条课程记录本周不出现' : '');
    axisNote.textContent = compact ? '连续两小时以上全周无课会合并显示' : '';
    axisToggle.textContent = compact ? '显示完整时间轴' : '恢复紧凑时间轴';
    updateTermLabel();
  };
  axisSel.addEventListener('change', () => {
    const start = Number(axisSel.value);
    const end = Math.max(Number(axisSelEnd.value), start + 1);
    axisSelEnd.value = String(end);
    db.saveSettings({ axisStart: start, axisEnd: end });
    state.settings = db.settings();
    redraw();
  });
  axisSelEnd.addEventListener('change', () => {
    if (Number(axisSelEnd.value) <= Number(axisSel.value)) { toast('终点要晚于起点', '已自动改回。', 'bad'); axisSelEnd.value = String(Math.min(25, Number(axisSel.value) + 12)); }
    db.saveSettings({ axisEnd: Number(axisSelEnd.value) }); state.settings = db.settings(); redraw();
  });

  const termInput = h('input', { type: 'date', value: s.termStart || '', 'aria-label': '学期起始日（第一周周一）' });
  termInput.addEventListener('change', async () => {
    db.saveSettings({ termStart: termInput.value });
    state.settings = db.settings();
    redraw();
    toast(termInput.value ? '学期起始日已设置' : '已清除学期起始日', termInput.value ? '单双周和周次按这个日期推算。' : '未设置时无法判断单双周，课程会全部显示。');
  });

  const info = h('p', { class: 'hint', text: '' });
  const body = h('div', { class: 'tt-body' });
  const axisNote = h('span', { class: 'tt-axis-note' });
  const axisToggle = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { fullAxis = !fullAxis; redraw(); } });
  const weekLabel = h('span', { class: 'tt-week-label', 'aria-live': narrow ? null : 'polite' });
  const termButton = h('button', { class: 'btn btn-sm btn-ghost', text: '设置学期起始日', onclick: () => {
    const details = termInput.closest('details');
    if (details) details.open = true;
    termInput.focus();
  } });
  const updateTermLabel = () => {
    const term = state.settings.termStart;
    const week = weekNumberOf(state.week, term);
    weekLabel.textContent = week !== null ? `第 ${week} 周` : term ? '不在学期周次内' : '未设置周次';
    termButton.hidden = Boolean(term);
  };

  const dateLabel = narrow
    ? `${dates[0].slice(5).replace('-', '/')} – ${dates[6].slice(5).replace('-', '/')}`
    : `${dates[0]} ~ ${dates[6]}`;
  const weekNav = (delta, label) => h('button', {
    type: 'button',
    class: narrow ? 'btn btn-ghost tt-week-nav' : 'btn btn-sm',
    'aria-label': label,
    dataset: { weekShift: String(delta) },
    onclick: () => {
      state.week = delta ? shiftWeek(state.week, delta) : state.curWeek;
      render(root);
      root.querySelector(`[data-week-shift="${delta || -1}"]`)?.focus({ preventScroll: true });
    },
  }, narrow && delta ? icon('right') : h('span', { text: label }));
  const addCourse = h('button', {
    type: 'button', class: narrow ? 'btn btn-primary tt-add-course' : 'btn btn-sm btn-primary',
    'aria-label': '添加课程', title: '添加课程', onclick: () => editCourse(null),
  }, icon('plus'), h('span', { text: narrow ? '添加' : '添加课程' }));
  const weekBar = h('div', { class: narrow ? 'tt-compact-week' : 'tt-toolbar' },
    weekNav(-1, '上一周'),
    narrow ? h('div', { class: 'tt-compact-date', 'aria-live': 'polite' }, weekLabel,
      h('span', { title: `${dates[0]} 至 ${dates[6]}`, text: dateLabel })) : weekLabel,
    weekNav(1, '下一周'),
    narrow || state.week === state.curWeek ? null : weekNav(0, '回到本周'),
    narrow ? null : h('span', { class: 'hint', text: dateLabel }),
    addCourse,
  );
  const importBtn = h('button', { class: 'btn btn-sm', onclick: () => importSheet() }, icon('inbox'), h('span', { text: '批量导入 CSV/TSV' }));
  const tuneBar = h('div', { class: 'tt-toolbar' },
    h('span', { class: 'tt-axis' }, h('label', { text: '从' }), axisSel, h('label', { text: '到' }), axisSelEnd),
    h('span', { class: 'tt-term' }, h('label', { text: '学期第 1 周的周一：' }), termInput),
  );
  const tail = h('p', { class: 'hint', text: '点课程卡片可以编辑或删除。导入前有核对清单，只有你确认的行才会写进来。' });

  root.append(
    h('div', { class: 'page-head' },
      h('h2', { class: 'page-title', text: '课程表' }),
      narrow ? null : h('p', { class: 'page-sub', text: '查看一周课程，点课程查看时间和地点。' }),
    ),
  );
  if (narrow) {
    root.append(h('div', { class: 'card tt-mobile-card' },
      weekBar,
      state.week === state.curWeek ? null : h('div', { class: 'tt-jump' }, weekNav(0, '回到本周')),
      todayList(),
      h('details', { class: 'fold tt-tools' },
        h('summary', {}, h('span', { class: 'fold-lead', text: '导入与课表设置' })),
        h('div', { class: 'fold-body' }, tuneBar, h('div', { class: 'btn-row' }, importBtn), info),
      ),
      body, tail,
    ));
  } else {
    weekBar.append(importBtn);
    root.append(h('div', { class: 'card tt-desktop-card' }, weekBar,
      h('div', { class: 'tt-context' }, info, axisToggle, termButton, axisNote),
      body,
      h('details', { class: 'tt-settings' }, h('summary', { text: '调整时间范围与学期' }), tuneBar),
      tail,
    ));
  }
  redraw();
}
