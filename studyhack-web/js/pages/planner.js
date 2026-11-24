// 计划：本地规则排程 → 预览 → 勾选/修改 → 确认保存 → 可撤销
// 明确标注：没有调用任何 AI，建议完全来自课表、截止时间、午休晚餐与每日上限这些规则。
import * as db from '../store.js';
import { state, todayStr, fmtRange, planStatus, planStats, spentMinForPlan, dateOfWeek, taskById } from '../state.js';
import { calibratedMin, provenance } from '../history.js';
import { suggestPlan, validateSlot } from '../schedule.js';
import { h, icon, clear, toast, selectEl, confirmSheet, toMin, PLAN_STATUS_LABEL, planSourceLabel } from '../ui.js';
import { editPlan, removePlan, planStatusPills, changed } from '../forms.js';
import { reblockSheet } from '../reblock.js';

const AI_NOTE = '规则生成 · 未调用 AI';
let savedFeedback = null;

function batchOf() { return db.metaGet('lastBatch'); }
async function setBatch(b) { await db.metaSet('lastBatch', b); }

export async function render(root) {
  clear(root); // 保存/撤销后页面会自己再 render 一次，先清空才不会和路由重绘叠成两份
  const s = state.settings;
  const head = h('div', { class: 'page-head' },
    h('h2', { class: 'page-title', text: '学习计划' }),
    h('p', { class: 'page-sub', text: '根据课表和作息找空档，预览并确认后再保存。' }),
  );
  root.append(head);
  const lastBatch = await batchOf();
  const lastDeleted = await db.metaGet('lastDeletedPlan');
  if (!head.isConnected) return;
  const controls = h('div', { class: 'card planner-controls' });
  const preview = h('div', { class: 'planner-preview' });
  const existing = h('section', { class: 'card saved-plans', 'aria-labelledby': 'saved-plans-title' });

  const fHorizon = selectEl([
    { value: '1', label: '只排今天' },
    { value: '3', label: '今天起 3 天' },
    { value: '7', label: '今天起 7 天' },
    { value: '14', label: '今天起 14 天' },
  ], '7', { 'aria-label': '排程范围' });
  const fChunk = selectEl([
    { value: '', label: '不拆分（放不下的任务先不排）' },
    { value: '45', label: '拆成不超过 45 分钟' },
    { value: '60', label: '拆成不超过 60 分钟' },
    { value: '90', label: '拆成不超过 90 分钟' },
  ], '45', { 'aria-label': '长任务拆分' });
  const fCap = h('input', { type: 'number', min: 30, max: 720, step: 10, value: s.dailyCapMin, 'aria-label': '每天最多学习分钟数' });
  const fLunch = h('input', { type: 'time', value: s.lunchStart, 'aria-label': '午休开始' });
  const fLunchEnd = h('input', { type: 'time', value: s.lunchEnd, 'aria-label': '午休结束' });
  const fDinner = h('input', { type: 'time', value: s.dinnerStart, 'aria-label': '晚餐开始' });
  const fDinnerEnd = h('input', { type: 'time', value: s.dinnerEnd, 'aria-label': '晚餐结束' });

  const fieldsBlock = h('div', {},
    h('div', { class: 'field-row field-row-wide' },
      h('div', { class: 'field' }, h('label', { text: '排到几天内' }), fHorizon),
      h('div', { class: 'field' }, h('label', { text: '长任务处理' }), fChunk),
      h('div', { class: 'field' }, h('label', { text: '每天最多（分钟）' }), fCap),
    ),
    h('div', { class: 'field-row' },
      h('div', { class: 'field' }, h('label', { text: '午休开始' }), fLunch),
      h('div', { class: 'field' }, h('label', { text: '午休结束' }), fLunchEnd),
      h('div', { class: 'field' }, h('label', { text: '晚餐开始' }), fDinner),
      h('div', { class: 'field' }, h('label', { text: '晚餐结束' }), fDinnerEnd),
    ),
  );
  const hintText = h('p', { class: 'hint', text: '排程会避开这些时段，以及每天的课程和已保存的计划。改动这里不会写入设置，只有点「生成预览」时才生效；想永久修改请到设置页。' });
  const savedActions = h('div', { class: 'btn-row saved-plan-actions' },
      lastBatch && state.plans.some((p) => p.batch === lastBatch) ? h('button', {
        class: 'btn',
        onclick: async () => {
          const rows = state.plans.filter((p) => p.batch === lastBatch);
          const keep = rows.filter((p) => planStatus(p) !== 'scheduled' || p.updatedAt || spentMinForPlan(p.id) > 0);
          const del = rows.filter((p) => !keep.includes(p));
          const linked = state.sessions.filter((x) => del.some((p) => p.id === x.planId)).length;
          if (!del.length) {
            await setBatch(null);
            changed('plan-undo');
            toast('这批已经不用撤销', `这 ${keep.length} 条都做过、改过或已有专注记录，保留原样。`);
            return;
          }
          const ok = await confirmSheet({
            title: '撤销这一批计划',
            message: `删除 ${del.length} 条由本次预览保存、之后没动过的计划。${keep.length ? `另有 ${keep.length} 条已经改过、做过或有关联专注记录，会保留。` : ''}${linked ? `其中 ${linked} 条专注记录关联了要删的计划：记录会保留，只在专注页显示「计划已删除」，累计时长不变。` : ''}`,
            confirmText: '撤销',
          });
          if (!ok) return;
          try { await db.bulkDelete('plans', del.map((p) => p.id)); }
          catch (e) { toast('没撤销成', (e && e.message) || '这台设备的存储写不进去，计划没有变化。', 'bad'); return; }
          const gone = new Set(del.map((p) => p.id));
          state.plans = state.plans.filter((p) => !gone.has(p.id));
          await setBatch(null);
          if (savedFeedback?.batch === lastBatch) savedFeedback = null;
          changed('plan-undo');
          toast('已撤销', `${del.length} 条计划已删除${keep.length ? `；${keep.length} 条改过/做过的保留` : ''}。`);
        }, text: `撤销上一批（${state.plans.filter((p) => p.batch === lastBatch).length} 条）`,
      }) : null,
      lastDeleted && lastDeleted.plan ? h('button', {
        class: 'btn',
        onclick: async () => {
          const p = lastDeleted.plan;
          if (state.plans.some((x) => x.id === p.id)) {
            await db.metaSet('lastDeletedPlan', null);
            changed('plan-restore');
            toast('这条计划还在', `${p.date} ${p.start} · ${p.title} 没有丢失，快照已清掉。`);
            return;
          }
          // 恢复的是用户自己删掉的那一条，日期可能本来就在过去：过去的日期不该拦，冲突照旧拦
          const errs = validateSlot({ date: p.date, start: p.start, min: p.min, ignoreId: p.id, allowPast: true });
          if (errs.length) {
            const ok = await confirmSheet({
              title: '恢复会和现在的安排撞上',
              message: `「${p.date} ${p.start} · ${p.title}」：${errs[0]}。\n\n仍要恢复吗？恢复后可以在这条上点「修改」换个时间。`,
              confirmText: '仍然恢复',
            });
            if (!ok) return;
          }
          await db.put('plans', p);
          state.plans = [...state.plans, p].sort((a, b) => String(a.date).localeCompare(String(b.date)) || toMin(a.start) - toMin(b.start));
          await db.metaSet('lastDeletedPlan', null);
          changed('plan-restore');
          toast('已恢复这条计划', `${p.date} ${p.start} · ${p.title}${lastDeleted.linked ? `。之前关联的 ${lastDeleted.linked} 条专注记录本来就还在，累计时长自动接回来。` : ''}这个快照只能用一次，已经清掉了。`);
        },
        text: `恢复刚才删除的计划（${lastDeleted.plan.date === todayStr() ? '今天' : lastDeleted.plan.date.slice(5)} ${lastDeleted.plan.start} · ${lastDeleted.plan.title}）`,
      }) : null,
  );

  const now = h('span', { class: 'fold-now' });
  const setNow = () => {
    const horizon = fHorizon.selectedOptions[0]?.text || '';
    const chunk = fChunk.value ? `每段 ≤ ${fChunk.value} 分钟` : '不拆分';
    now.textContent = `${horizon} · ${chunk} · 每天最多 ${fCap.value || '—'} 分钟`;
  };
  [fHorizon, fChunk, fCap].forEach((el) => el.addEventListener('input', setNow));
  setNow();
  controls.append(
    h('div', { class: 'planner-intro' },
      h('div', {}, h('h3', { text: '自动排程' }), now),
      h('button', { class: 'btn btn-primary', onclick: generate }, icon('spark'), h('span', { text: '生成预览' }))),
    h('details', { class: 'plan-details planner-options' },
      h('summary', { text: '调整排程参数' }),
      fieldsBlock, hintText),
  );

  // ---------- 预览 ----------
  let draft = null;
  let saving = false;
  async function generate() {
    // 预览只临时套用页面上的参数，不写入 localStorage
    const base = state.settings;
    state.settings = {
      ...base,
      dailyCapMin: Number(fCap.value) || base.dailyCapMin,
      lunchStart: fLunch.value || base.lunchStart, lunchEnd: fLunchEnd.value || base.lunchEnd,
      dinnerStart: fDinner.value || base.dinnerStart, dinnerEnd: fDinnerEnd.value || base.dinnerEnd,
    };
    const res = suggestPlan({ horizonDays: Number(fHorizon.value), chunkMax: fChunk.value ? Number(fChunk.value) : null });
    state.settings = base;
    draft = res.items.map((it) => ({ ...it, keep: true, id: `d${Math.random().toString(36).slice(2, 9)}`, orig: { date: it.date, start: it.start, min: it.min } }));
    renderPreview(res);
  }

  function renderPreview(res) {
    clear(preview);
    if (!draft.length) {
      preview.append(h('div', { class: 'card' },
        h('h3', { text: '预览结果：这一轮没有可保存的安排' }),
        res.skipped.length
          ? h('ul', { style: 'margin:0;padding-left:18px;color:var(--ink-soft);font-size:var(--fs-3)' }, ...res.skipped.map((x) => h('li', { text: `${x.task.title}：${x.reason}` })))
          : h('p', { class: 'empty', text: '没有待排的任务。' }),
        h('p', { class: 'note', text: '程序没有把任务硬塞进已满的时间段。可以试试：拆分任务、减少每天上限冲突、放宽午休/晚餐，或先删掉几条已保存的计划。' }),
      ));
      return;
    }
    const count = h('b', {});
    const revalidators = [];
    // 同一批预览里的条目要互相检查：否则改时间把两条压到一起时，界面还会说「空闲时段内」。
    const siblingsFor = (self) => draft
      .filter((x) => x !== self && x.keep)
      .map((x) => ({ date: x.date, start: toMin(x.start), end: toMin(x.start) + Number(x.min), title: x.title }));
    const rows = draft.map((d) => {
      const cb = h('input', { type: 'checkbox', checked: d.keep, 'aria-label': `保留 ${d.title}` });
      const dateEl = h('input', { type: 'date', value: d.date, 'aria-label': '日期' });
      // 排程结果可以是任意分钟（尾巴并进最后一块后会出现 48 这类值），step 收到 1 分钟，否则输入框会被判成无效
      const startEl = h('input', { type: 'time', value: d.start, step: 60, 'aria-label': '开始时间' });
      const minEl = h('input', { type: 'number', min: 5, max: 480, step: 1, value: d.min, 'aria-label': '时长' });
      const tip = h('div', { class: 'row-meta' });
      const basisEl = h('div', { class: 'row-meta' });
      // 依据跟着排程时的事实走：时间三要素一旦被手改，原依据就不再适用，明说而不是继续挂着
      const timeTouched = () => d.orig && (d.date !== d.orig.date || d.start !== d.orig.start || Number(d.min) !== Number(d.orig.min));
      // 时长建议：只有这条任务真的关联得到、而且这台设备上的记录够用时才出现。
      // 改了的是任务的预计时长（不是这一块的分钟数），下一轮预览就会跟着走。
      const linkedTask = d.taskId ? taskById(d.taskId) : null;
      const cal = calibratedMin(linkedTask?.estMin || 0, linkedTask?.subject || '');
      const calEl = h('div', { class: 'row-meta' });
      if (cal.suggested) {
        let applied = false;
        const btn = h('button', { class: 'btn btn-sm btn-ghost', text: `改成 ${cal.suggested} 分钟` });
        const label = h('span', { class: 'tag', text: `按你自己的历史，这条更像 ${cal.suggested} 分钟（任务上填的是 ${Math.round(linkedTask.estMin)} 分钟）` });
        calEl.append(label, btn);
        btn.addEventListener('click', async () => {
          if (applied) return;
          const t = taskById(d.taskId);
          if (!t) { calEl.replaceChildren(h('span', { class: 'tag warn', text: '这条任务已经不在了，没改任何时长。' })); applied = true; return; }
          const next = { ...t, estMin: cal.suggested };
          try { await db.put('tasks', next); }
          catch (e) { toast('没改成', (e && e.message) || '这台设备的存储写不进去。', 'bad'); return; }
          const i = state.tasks.findIndex((x) => x.id === t.id);
          if (i >= 0) state.tasks[i] = next;
          d.estMin = cal.suggested;
          applied = true;
          calEl.replaceChildren(h('span', { class: 'tag ok', text: `已把这条任务的预计改成 ${cal.suggested} 分钟 · ${provenance(cal.est)}` }));
          revalidate();
          toast('这条任务的预计时长改了', `${next.title} → 预计 ${cal.suggested} 分钟。这一轮的排程没动，下一轮预览按新数算。`);
        });
      } else if (cal.est.enough && linkedTask) {
        calEl.append(h('span', { class: 'tag', text: `历史比例 ${Math.round(cal.est.rawFactor * 100)}%，这条只差不到 5 分钟，不建议动` }));
      }
      const revalidate = () => {
        Object.assign(d, { keep: cb.checked, date: dateEl.value, start: startEl.value, min: Number(minEl.value) });
        basisEl.replaceChildren(...[
          timeTouched()
            ? h('span', { class: 'tag warn', text: '时间已手改，原依据不再适用' })
            : d.basis ? h('span', { class: 'note muted', text: `依据：${d.basis}` }) : null,
        ].filter(Boolean));
        if (!cb.checked) { tip.replaceChildren(h('span', { class: 'tag', text: '未勾选，不会保存' })); refreshCount(); return; }
        const errs = validateSlot({ date: d.date, start: d.start, min: d.min, extra: siblingsFor(d) });
        const spentHint = d.spentMin > 0 && d.estMin > 0
          ? h('span', { class: 'tag', text: `已投入 ${d.spentMin} / 预计 ${d.estMin} 分钟，本轮排 ${d.min} 分钟` })
          : null;
        tip.replaceChildren(...[
          errs.length
            ? h('span', { class: 'tag bad', text: `冲突：${errs[0]}` })
            : h('span', { class: 'tag ok', text: `空闲时段内 · ${fmtRange(toMin(d.start), d.min)}` }),
          spentHint,
        ].filter(Boolean));
        refreshCount();
      };
      revalidators.push(revalidate);
      const onChange = () => { for (const fn of revalidators) fn(); };
      cb.addEventListener('change', onChange);
      for (const el of [dateEl, startEl, minEl]) el.addEventListener('change', onChange);
      revalidate();
      return h('div', { class: 'check-row' }, cb,
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: d.title }),
          h('div', { class: 'field-row', style: 'margin-top:5px' },
            h('div', { class: 'field', style: 'margin:0' }, h('label', { text: '日期', style: 'font-size:11.5px' }), dateEl),
            h('div', { class: 'field', style: 'margin:0' }, h('label', { text: '开始', style: 'font-size:11.5px' }), startEl),
            h('div', { class: 'field', style: 'margin:0' }, h('label', { text: '分钟', style: 'font-size:11.5px' }), minEl),
          ),
          tip,
          basisEl.childElementCount ? basisEl : null,
          calEl.childElementCount ? calEl : null,
        ),
      );
    });
    preview.append(h('div', { class: 'card' },
      h('h3', {}, h('span', { text: '预览（还没保存）' }), h('span', { class: 'tag', style: 'margin-left:8px', text: AI_NOTE })),
      h('p', { class: 'hint' }, count, h('span', { text: ` · 本机已保存 ${state.plans.length} 条计划` })),
      h('div', { class: 'check-list' }, ...rows),
      res.skipped.length
        ? h('div', { class: 'warn-bar' },
            h('b', { text: `有 ${res.skipped.length} 条任务本轮没有写入，没有硬塞：` }),
            h('ul', { style: 'margin:6px 0 0;padding-left:18px' }, ...res.skipped.map((x) => h('li', { text: `${x.task.title}：${x.reason}` }))),
          )
        : null,
      res.partial.length
        ? h('div', { class: 'warn-bar' },
            h('b', { text: `有 ${res.partial.length} 条任务只排下了一部分：` }),
            h('ul', { style: 'margin:6px 0 0;padding-left:18px' }, ...res.partial.map((x) => h('li', {
              text: `${x.task.title}：需要 ${x.placed + x.missing} 分钟，本轮排了 ${x.placed} 分钟，剩下 ${x.missing} 分钟不足最小块 ${x.minBlock} 分钟，而且最后那段空闲也塞不下——没有硬塞，下一轮会接着排。`,
            }))),
          )
        : null,
      h('div', { class: 'btn-row', style: 'margin-top:12px' },
        h('button', {
          class: 'btn btn-primary', onclick: confirmSave, text: '确认保存勾选的安排',
        }),
        h('button', { class: 'btn', onclick: () => { draft = null; clear(preview); render(root); }, text: '放弃这次预览' }),
      ),
      h('p', { class: 'hint', text: '确认前可以自由改时间、时长或取消勾选；保存后仍可以逐条修改或删除。' }),
    ));
    function refreshCount() {
      const n = draft.filter((d) => d.keep).length;
      const mins = draft.filter((d) => d.keep).reduce((m, d) => m + Number(d.min || 0), 0);
      count.textContent = `已勾选 ${n} 条（约 ${mins} 分钟）会被保存`;
    }
    refreshCount();
  }

  async function confirmSave() {
    if (saving) return;
    saving = true;
    try {
      const chosen = draft.filter((d) => d.keep);
      if (!chosen.length) { toast('没有勾选任何安排', '请先勾几条，或放弃这次预览。', 'bad'); return; }
      const blocksOf = (x) => ({ date: x.date, start: toMin(x.start), end: toMin(x.start) + Number(x.min), title: x.title });
      const bad = chosen.flatMap((d) => validateSlot({ ...d, extra: chosen.filter((x) => x !== d).map(blocksOf) }).map((e) => `${d.title}：${e}`));
      if (bad.length) {
        const ok = await confirmSheet({ title: '这些时间与已有安排冲突', message: `${bad.slice(0, 4).join('；')}\n\n仍要保存吗？（建议先改时间）`, confirmText: '仍然保存', danger: true });
        if (!ok) return;
      }
      const batch = `b${Date.now()}`;
      const rows = chosen.map((d) => ({
        id: db.uid(), taskId: d.taskId || null, title: d.title, date: d.date, start: d.start, min: Number(d.min),
        status: 'scheduled', source: 'rule', batch, createdAt: new Date().toISOString(),
        // 手改过时间的条目不带旧依据入库：依据描述的是排程那一刻的事实
        basis: d.orig && d.date === d.orig.date && d.start === d.orig.start && Number(d.min) === Number(d.orig.min) ? (d.basis || null) : null,
      }));
      try { await db.bulkPut('plans', rows); }
      catch (e) { toast('没保存成功', (e && e.message) || '这台设备的存储写不进去，预览还在，可以重试。', 'bad'); return; }
      state.plans = [...state.plans, ...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)) || toMin(a.start) - toMin(b.start));
      try { await setBatch(batch); }
      catch { toast('计划已保存', '但这批的撤销入口没记上；仍可在下面逐条删除。', 'bad'); }
      draft = null;
      if (preview.isConnected) savedFeedback = { batch, count: rows.length, reveal: true };
      changed('plan-confirm');
    } finally {
      saving = false;
    }
  }

  // ---------- 已保存 ----------
  function planRow(p) {
    const spent = spentMinForPlan(p.id);
    const st = planStatus(p);
    return h('div', { class: `row saved-plan${st === 'done' ? ' plan-done' : st === 'skipped' ? ' plan-skipped' : ''}` },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title', text: `${p.start} · ${p.title}` }),
        h('div', { class: 'row-meta' },
          h('span', { class: `tag ${st === 'done' ? 'ok' : st === 'skipped' ? 'warn' : ''}`, text: PLAN_STATUS_LABEL[st] }),
          h('span', { text: `${p.min} 分钟` }),
        ),
        h('details', { class: 'plan-details' },
          h('summary', { text: '详情与操作', 'aria-label': `${p.start} ${p.title}的详情与操作` }),
          h('p', { class: 'hint', text: [
            planSourceLabel(p), spent ? `已专注 ${spent} 分钟` : '还没有专注记录',
            p.blockReason ? `受阻：${p.blockReason}` : '',
          ].filter(Boolean).join(' · ') }),
          p.basis ? h('p', { class: 'note muted', text: `依据：${p.basis}` }) : null,
          planStatusPills(p, drawExisting),
          h('div', { class: 'btn-row' },
            st === 'skipped' ? h('button', { class: 'btn btn-sm', title: '受阻后调整', onclick: () => reblockSheet(p, { onDone: drawExisting }), text: '调整' }) : null,
            h('button', { class: 'btn btn-sm btn-ghost', title: '修改时间', onclick: () => editPlan(p), text: '修改时间' }),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => removePlan(p), text: '删除' }),
          ),
        ),
      ),
      h('button', { class: 'btn btn-sm', onclick: () => startFocus(p) }, icon('play'), h('span', { text: '开始' })),
    );
  }

  function drawExisting() {
    clear(existing);
    const sorted = state.plans.slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || toMin(a.start) - toMin(b.start));
    const upcoming = sorted.filter((p) => p.date >= todayStr());
    const past = sorted.filter((p) => p.date < todayStr()).slice(-10);
    const dates = sorted.map((p) => p.date);
    const overall = dates.length ? planStats(dates[0], dates[dates.length - 1]) : planStats(todayStr(), todayStr());
    const week = planStats(todayStr(), dateOfWeek(todayStr(), 6));

    const heading = h('h3', { id: 'saved-plans-title', tabindex: '-1', text: '已保存的计划' });
    existing.append(h('div', { class: 'saved-plans-head' }, heading, savedActions.childElementCount ? savedActions : null));
    const feedback = savedFeedback;
    const savedCount = feedback ? sorted.filter((p) => p.batch === feedback.batch).length : 0;
    if (feedback && savedCount) {
      existing.append(h('p', { class: 'plan-saved-status', role: 'status', text: savedCount === feedback.count
        ? `已保存 ${savedCount} 条计划`
        : `这批还有 ${savedCount} 条计划` }));
      if (feedback.reveal) requestAnimationFrame(() => {
        if (!heading.isConnected || state.page !== 'planner' || savedFeedback !== feedback || !feedback.reveal) return;
        feedback.reveal = false;
        heading.focus({ preventScroll: true });
        existing.scrollIntoView({ block: 'start' });
      });
    }
    if (sorted.length) {
      existing.append(
        h('p', { class: 'hint', text: `共 ${sorted.length} 条计划` }),
        h('details', { class: 'plan-details' },
          h('summary', { text: '查看完成统计' }),
          h('p', {
            class: 'hint',
            text: `全部：已完成 ${overall.done} · 已跳过 ${overall.skipped} · 计划中 ${overall.scheduled} · 完成率 ${overall.rate}%。`
              + ` 今天起 7 天：完成 ${week.done} / ${week.total} 条，完成率 ${week.rate}%。`,
          }),
          h('p', { class: 'hint', text: '完成率按全部计划计算，只有标为已完成的条目计入完成数。计时结束后可手动标记完成。' }),
        ),
      );
    }
    if (!sorted.length) existing.append(h('p', { class: 'empty', text: '还没有保存任何计划。点上面的「生成预览」看看能排出什么。' }));

    const byDate = new Map();
    for (const p of upcoming) {
      if (!byDate.has(p.date)) byDate.set(p.date, []);
      byDate.get(p.date).push(p);
    }
    for (const [ds, list] of byDate) {
      const st = planStats(ds, ds);
      existing.append(
        h('div', { class: 'plan-slot' },
          h('div', { class: 'plan-time' },
            h('b', { text: ds === todayStr() ? '今天' : ds.slice(5) }),
            h('div', { class: 'hint', text: `完成 ${st.done}/${st.total}` }),
          ),
          h('div', { class: 'row-main' },
            ...list.map(planRow),
          ),
        ),
      );
    }
    if (past.length) {
      existing.append(h('h4', { style: 'font-size:var(--fs-3);margin:14px 0 4px;color:var(--ink-dim)', text: `更早的条目（最近 ${past.length} 条，状态仍可修改并计入复盘）` }));
      for (const p of past) existing.append(planRow(p));
    }
  }
  function startFocus(p) {
    state.focusSeed = { taskId: p.taskId || null, planId: p.id, title: p.title, min: p.min };
    document.dispatchEvent(new CustomEvent('xj:goto', { detail: 'focus' }));
  }

  root.append(controls, preview, existing);
  drawExisting();
}
