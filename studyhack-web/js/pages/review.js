// 复盘：预计 vs 实际，卡点与下一步；规则建议，不使用责备或打卡压力文案
import * as db from '../store.js';
import { state, todayStr, sessionsOnDate, dayTotals, planStats, planStatus } from '../state.js';
import { h, icon, clear, toast, selectEl, openSheet, confirmSheet, ymd, fmtDateTime, DOW, PLAN_STATUS_LABEL, isNarrow } from '../ui.js';
import { changed } from '../forms.js';
import { biasTrend, estimateFor, provenance, timeOfDayProfile, CALIBRATION_RULE_NOTE } from '../history.js';
import { goPage } from '../app.js';

let daySel = todayStr();

const sessionsOn = (ds) => sessionsOnDate(ds);

/** 最近 7 天（含今天）的日期字符串，从早到晚 */
function last7Dates() {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(ymd(d));
  }
  return out;
}

function last7Rows() {
  return last7Dates().map((ds) => {
    const list = sessionsOn(ds);
    const tot = dayTotals(list);
    const st = planStats(ds, ds);
    return { ds, count: list.length, ...tot, ...st, linkedMin: list.filter((x) => x.planId).reduce((n, x) => n + Math.max(0, Number(x.actualMin) || 0), 0) };
  });
}

/** 规则建议：只根据本地数据，没有调用任何 AI */
export function ruleAdvice(ds) {
  const list = sessionsOn(ds);
  const out = [];
  if (!list.length) return ['如果这天有做过的学习，可以到专注页点「补记一次专注」。'];
  const tot = dayTotals(list);
  const planned = tot.planned;
  const actual = tot.actual;
  if (actual < planned * 0.7) {
    out.push('下次把最大的一项拆成 5 分钟能开始的动作，例如打开文件，先写 3 行。');
  } else if (actual > planned * 1.3) {
    out.push('下次为同类任务多预留约三成时间，给自己留一点缓冲。');
  } else {
    out.push('下次做同类任务时，可以沿用这次的预计时长。');
  }
  const overdue = state.tasks.filter((t) => t.status !== 'done' && t.dueAt && t.dueAt.slice(0, 10) < ds);
  if (overdue.length) out.push(`还有 ${overdue.length} 条任务已经过了截止时间。挑一条改成更小的目标，其余先推迟，别让列表一直红着。`);
  const withNote = list.filter((x) => x.note);
  if (withNote.length) out.push(`你在备注里提到：${withNote.map((x) => `「${x.note}」`).join('、')}。如果这是反复出现的卡点，下次可以把它单独写成一条任务。`);
  const legacy = list.filter((x) => !x.planId).length;
  if (legacy) out.push(`其中 ${legacy} 条没有关联计划条目（旧记录或手动补记），所以只计入当天时长，不计入任何计划的投入。`);
  return out;
}

/** 近 7 天：预计 vs 实际 + 计划完成数/完成率，口径写在卡片里 */
function weekCard() {
  const rows = last7Rows();
  const maxMin = Math.max(30, ...rows.map((r) => Math.max(r.planned, r.actual)));
  const sum = rows.reduce((a, r) => ({
    count: a.count + r.count, planned: a.planned + r.planned, actual: a.actual + r.actual,
    total: a.total + r.total, done: a.done + r.done, skipped: a.skipped + r.skipped, linked: a.linked + r.linkedMin,
  }), { count: 0, planned: 0, actual: 0, total: 0, done: 0, skipped: 0, linked: 0 });
  const rate = sum.total ? Math.round((sum.done / sum.total) * 100) : 0;
  return h('div', { class: 'card' },
    h('h3', { text: '近 7 天：预计 vs 实际 · 计划完成' }),
    h('div', { class: 'wk' },
      h('div', { class: 'wk-row wk-hd' },
        h('span', { text: '日期' }), h('span', { text: '专注' }), h('span', { text: '预计 / 实际（分钟）' }), h('span', { text: '计划完成数与完成率' }),
      ),
      ...rows.map((r) => h('div', { class: `wk-row${r.ds === todayStr() ? ' today' : ''}` },
        h('div', { class: 'wk-d' },
          h('b', { text: r.ds.slice(5) }),
          h('span', { text: DOW[((new Date(`${r.ds}T12:00:00`).getDay() + 6) % 7)] }),
        ),
        h('div', { class: 'wk-n', text: r.count ? `${r.count} 段` : '—' }),
        h('div', { class: 'wk-bars' },
          h('div', { class: 'mini' }, h('i', { style: `width:${barW(r.planned, maxMin)}%` })),
          h('div', { class: 'mini act' }, h('i', { style: `width:${barW(r.actual, maxMin)}%` })),
          h('span', { class: 'wk-val', text: r.count ? `${r.planned} / ${r.actual}（${r.diff >= 0 ? '+' : ''}${r.diff}）` : '无记录' }),
        ),
        h('div', { class: 'wk-plan' },
          r.total
            ? h('span', {}, h('b', { text: `${r.done}/${r.total} 条 · ${r.rate}%` }), h('span', { class: 'wk-sub', text: `跳过 ${r.skipped} · 计划中 ${r.scheduled}${r.linkedMin ? ` · 关联计划投入 ${r.linkedMin} 分钟` : ''}` }))
            : h('span', { class: 'wk-sub', text: '这天没有计划条目' }),
        ),
      )),
    ),
    h('p', { class: 'hint', text: `这 7 天合计：${sum.count} 段专注，预计 ${sum.planned} 分钟、实际 ${sum.actual} 分钟（差值 ${sum.actual - sum.planned >= 0 ? '+' : ''}${sum.actual - sum.planned}），其中关联到计划条目的实际投入 ${sum.linked} 分钟。计划 ${sum.done}/${sum.total} 条已完成、${sum.skipped} 条已跳过，完成率 ${rate}%。` }),
    h('p', { class: 'note muted', text: '统计口径：① 预计与实际全部来自专注记录的 plannedMin / actualMin，按记录结束时间所在的本地日期归入当天；一条记录只算一次，删掉或修改后重新汇总，不会重复累计。② 计划完成数 = 当天状态为「已完成」的计划条数；完成率 = 已完成 ÷ 当天计划总条数，四舍五入到整数百分比；「已跳过」单独统计、不进分子；没有状态字段的历史条目按「计划中」处理，不会被猜成已完成。③ 计划的实际投入按记录里的 planId 汇总，没有 planId 的旧记录只进当天时长，不进任何计划的投入。' }),
  );
}

/** 偏差趋势：不是「今天估得准不准」，而是「你是不是一贯性地往一个方向估偏」。
 *  这7天里可比的天数不足 4 天就不给结论——页面宁可说一句「看不出来」，也不编一个趋势。 */
function trendCard() {
  const t = biasTrend(7);
  const overall = estimateFor('');
  const maxRatio = Math.max(1.4, ...t.rows.filter((r) => r.ratio).map((r) => r.ratio));
  return h('div', { class: 'card' },
    h('div', { class: 'btn-row', style: 'margin-bottom:4px' },
      h('h3', { style: 'margin:0', text: '近 7 天的预估偏差' }),
      h('span', { class: 'spacer', style: 'flex:1' }),
      h('span', { class: 'tag', text: CALIBRATION_RULE_NOTE }),
    ),
    h('div', {}, ...t.rows.map((r) => (r.empty || r.ratio === null
      ? h('div', { class: 'row' },
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title', text: `${r.date.slice(5)} ${DOW[((new Date(`${r.date}T12:00:00`).getDay() + 6) % 7)]}` }),
            h('div', { class: 'row-meta' }, h('span', { class: 'tag', text: r.empty ? '这天没有专注记录' : `有 ${r.count} 段，但预计合计不足 5 分钟，不拿来算比例` })),
          ))
        : h('div', { class: 'row' },
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title', text: `${r.date.slice(5)} ${DOW[((new Date(`${r.date}T12:00:00`).getDay() + 6) % 7)]}` }),
              h('div', { class: 'row-meta' },
                h('span', { class: 'tag', text: `预计 ${r.planned} / 实际 ${r.actual}` }),
                h('span', { class: `tag${r.ratio >= 1.1 ? ' bad' : r.ratio <= 0.9 ? ' warn' : ' ok'}`, text: `实际是预计的 ${Math.round(r.ratio * 100)}%` }),
              ),
              h('div', { class: 'bar-row bar-sm' },
                h('span', { text: '100%' }),
                h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, Math.round((1 / maxRatio) * 100))}%` })),
                h('div', { class: 'bar act' }, h('i', { style: `width:${Math.min(100, Math.round((r.ratio / maxRatio) * 100))}%` })),
                h('span', { class: 'bar-val', text: `${r.actual - r.planned >= 0 ? '+' : ''}${r.actual - r.planned} 分` }),
              ),
            ),
          )))),
    h('p', { class: t.enough && t.verdict === 'under' ? 'warn-bar' : 'hint', text: t.text }),
    h('p', { class: 'note muted', text: overall.enough
      ? `口径：每条比例用当天「实际合计 ÷ 预计合计」，只统计预计合计在 5 分钟以上的天；趋势用中位数，一次意外带不跑它。记录来源：${provenance(overall)}。这里没有调用任何 AI。`
      : '口径：可比记录不足 4 段时，这一页不会说你的步幅怎么样。这里没有调用任何 AI。' }),
    h('div', { class: 'btn-row', style: 'margin-top:10px' },
      h('button', { class: 'btn btn-sm', onclick: () => goPage('goals'), text: '看看这个步幅下的目标还剩几天' }),
    ),
  );
}

/** 时段效率：近 28 天按上午/下午/晚上统计实际完成，只陈述事实、不推断原因 */
function slotCard() {
  const p = timeOfDayProfile(28);
  const maxAct = Math.max(1, ...p.buckets.map((b) => b.actual));
  return h('div', { class: 'card' },
    h('div', { class: 'btn-row', style: 'margin-bottom:4px' },
      h('h3', { style: 'margin:0', text: '你在哪个时段做得动' }),
      h('span', { class: 'spacer', style: 'flex:1' }),
      h('span', { class: 'tag', text: CALIBRATION_RULE_NOTE }),
    ),
    h('div', {}, ...p.buckets.map((b) => h('div', { class: 'row' },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title', text: b.label }),
        h('div', { class: 'row-meta' },
          h('span', { class: 'tag', text: b.count ? `${b.count} 段 · 实际 ${b.actual} 分钟` : '还没有记录' }),
          b.planned ? h('span', { class: 'tag', text: `预计 ${b.planned} 分钟` }) : null,
        ),
        b.count ? h('div', { class: 'bar-row bar-sm' },
          h('div', { class: 'bar' }, h('i', { style: `width:${barW(b.actual, maxAct)}%` }))) : null,
      ),
    ))),
    h('p', { class: 'hint', text: p.enough
      ? `近 28 天你在「${p.best.label}」完成的专注最多（合计 ${p.best.actual} 分钟）。排计划时可以把最需要集中精神的那条放到这个时段；这句只来自你自己的记录，不推断原因，也不会自动改你的排程。`
      : '专注记录不足 4 段时，这里不猜你哪个时段状态好。' }),
  );
}

function reviewForm(existing = null) {
  const r = existing || { date: daySel, taskId: null, plannedMin: 0, actualMin: 0, blocker: '', nextStep: '' };
  const fTask = selectEl([{ value: '', label: '不关联具体任务' }, ...state.tasks.map((t) => ({ value: t.id, label: t.title }))], r.taskId || '', { 'aria-label': '关联任务' });
  const fBlocker = h('textarea', { rows: 3, maxlength: 200, value: r.blocker || '', placeholder: '例：第 3 题看不懂例题，反复回看', 'aria-label': '卡点' });
  const fNext = h('input', { type: 'text', maxlength: 120, value: r.nextStep || '', placeholder: '例：明天只做第 3、4 题，先写循环条件', 'aria-label': '下一步' });
  const api = openSheet({
    title: existing ? '修改复盘' : '写一条复盘',
    content: h('div', {},
      h('p', { class: 'hint', text: '只回答两个问题：刚才卡在哪里、下一步做什么最小的事。不打分、不比较。' }),
      h('div', { class: 'field' }, h('label', { text: '关联任务（选填）' }), fTask),
      h('div', { class: 'field' }, h('label', { text: '卡点' }), fBlocker),
      h('div', { class: 'field' }, h('label', { text: '下一步（尽量小）' }), fNext),
    ),
    actions: [
      h('button', { class: 'btn', onclick: () => api.close(), text: '取消' }),
      h('button', {
        class: 'btn btn-primary', text: '保存',
        onclick: async () => {
          const blocker = fBlocker.value.trim();
          const nextStep = fNext.value.trim();
          if (!blocker && !nextStep) { toast('至少写一项', '卡点或下一步，写一个就好。', 'bad'); return; }
          const rows = sessionsOn(daySel);
          const obj = {
            id: r.id || db.uid(), date: daySel, taskId: fTask.value || null,
            plannedMin: rows.reduce((n, x) => n + (x.plannedMin || 0), 0),
            actualMin: rows.reduce((n, x) => n + (x.actualMin || 0), 0),
            blocker, nextStep, createdAt: r.createdAt || new Date().toISOString(),
          };
          await db.put('reviews', obj);
          const i = state.reviews.findIndex((x) => x.id === obj.id);
          if (i >= 0) state.reviews[i] = obj; else state.reviews.unshift(obj);
          api.close();
          changed('review-save');
          toast('已保存复盘', '下一步会显示在今日页，方便明天直接开始。');
        },
      }),
    ],
  });
}

function render(root) {
  clear(root);
  const list = sessionsOn(daySel);
  const tot = dayTotals(list);
  const planned = tot.planned;
  const actual = tot.actual;
  const maxMin = Math.max(planned, actual);
  const dayPlan = planStats(daySel, daySel);
  const [nextAction, ...adviceDetails] = ruleAdvice(daySel);
  const narrow = isNarrow();
  const dayInput = h('input', { type: 'date', value: daySel, max: ymd(new Date()), 'aria-label': '复盘日期' });
  dayInput.addEventListener('change', () => {
    daySel = dayInput.value || todayStr();
    render(root);
    root.querySelector('input[type="date"]')?.focus({ preventScroll: true });
  });

  const bars = (planned || actual)
    ? h('div', {},
        h('div', { class: 'bar-row' }, h('span', { text: '预计' }), h('div', { class: 'bar' }, h('i', { style: `width:${barW(planned, maxMin)}%` })), h('span', { class: 'bar-val', text: `${planned} 分` })),
        h('div', { class: 'bar-row' }, h('span', { text: '实际' }), h('div', { class: 'bar act' }, h('i', { style: `width:${barW(actual, maxMin)}%` })), h('span', { class: 'bar-val', text: `${actual} 分` })),
        h('p', { class: 'hint', text: actual === planned
          ? '实际与预计用时相同'
          : `实际比预计${actual > planned ? '多' : '少'} ${Math.abs(actual - planned)} 分钟` }),
      )
    : h('p', { class: 'empty', text: '这一天还没有专注记录，所以没有可比较的时长。' });

  root.append(
    h('div', { class: 'page-head' },
      h('h2', { class: 'page-title', text: '复盘' }),
      narrow ? null : h('p', { class: 'page-sub', text: '看实际用时和计划完成情况，记下卡点与下一步。' }),
    ),
    h('div', { class: 'grid grid-2 review-overview' },
      h('div', { class: 'card review-day' },
        h('div', { class: 'review-date' }, h('label', { text: '复盘日期' }, dayInput)),
        h('h3', { text: '预计与实际' }),
        bars,
        h('p', { class: 'review-done' }, dayPlan.total
          ? [h('strong', { text: `计划完成 ${dayPlan.done} / ${dayPlan.total} 条` }), ` · ${dayPlan.rate}%`]
          : '这一天没有计划'),
        dayPlan.total ? h('p', { class: 'review-status', text: `已跳过 ${dayPlan.skipped} 条 · 计划中 ${dayPlan.scheduled} 条` }) : null,
        list.length ? h('details', { class: 'review-detail', open: !narrow },
          h('summary', { text: `专注明细（${list.length} 段）` }),
          ...list.map((x) => {
            const p = x.planId ? state.plans.find((y) => y.id === x.planId) : null;
            return h('div', { class: 'row' },
              h('div', { class: 'row-main' },
                h('div', { class: 'row-title', text: x.title || '自由专注' }),
                h('div', { class: 'row-meta' },
                  h('span', { class: 'tag', text: `预计 ${x.plannedMin}` }),
                  h('span', { class: 'tag', text: `实际 ${x.actualMin}` }),
                  h('span', { text: fmtDateTime(x.endedAt) }),
                  h('span', { class: p ? 'tag' : x.planId ? 'tag warn' : 'tag', text: p ? `计划 ${p.start} · ${PLAN_STATUS_LABEL[planStatus(p)]}` : x.planId ? '计划已删除（记录保留）' : '未关联计划' }),
                  x.note ? h('span', { text: x.note }) : null,
                ),
              ),
            );
          })) : null,
      ),
      h('div', { class: 'card review-next' },
        h('div', { class: 'review-next-title' }, h('h3', { text: '下一步' }), h('span', { class: 'tag', text: '规则生成 · 未调用 AI' })),
        h('p', { class: 'review-advice', text: nextAction }),
        h('button', { class: 'btn btn-primary', onclick: () => reviewForm(null) }, icon('edit'), h('span', { text: '写一条复盘' })),
        adviceDetails.length ? h('details', { class: 'review-detail' },
          h('summary', { text: '更多复盘线索' }),
          h('ul', {}, ...adviceDetails.map((line) => h('li', { text: line })))) : null,
        h('details', { class: 'review-detail review-method' },
          h('summary', { text: '统计口径' }),
          h('ul', {},
            h('li', { text: '完成率 = 已完成条数 ÷ 该区间全部计划条数，已跳过单独统计。' }),
            h('li', { text: '预计与实际来自专注记录，编辑记录后会重新汇总。' }))),
      ),
    ),
    h('details', { class: 'card review-detail review-trends', open: !narrow },
      h('summary', { text: '近况趋势与专注时段' }),
      h('div', { class: 'review-trend-cards' }, weekCard(), trendCard(), slotCard()),
    ),
    h('div', { class: 'card' },
      h('h3', { text: `历史复盘（${state.reviews.length}）` }),
      state.reviews.length ? h('div', {}, ...state.reviews.map((r) => h('div', { class: 'row' },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: `${r.date} · ${r.blocker || '（没写卡点）'}` }),
          h('div', { class: 'row-meta' },
            r.nextStep ? h('span', { class: 'tag ok', text: `下一步：${r.nextStep}` }) : null,
            (r.plannedMin || r.actualMin) ? h('span', { class: 'tag', text: `预计 ${r.plannedMin} / 实际 ${r.actualMin}` }) : null,
          ),
        ),
        h('div', { class: 'row-ops' },
          h('button', { class: 'icon-btn', title: '修改', 'aria-label': '修改这条复盘', onclick: () => reviewForm(r) }, icon('edit')),
          h('button', {
            class: 'icon-btn', title: '删除', 'aria-label': '删除这条复盘',
            onclick: async () => {
              const ok = await confirmSheet({ title: '删除这条复盘', message: `删除「${(r.blocker || r.nextStep || '这条复盘').slice(0, 24)}」？写下的卡点和下一步找不回来。`, confirmText: '删除', danger: true });
              if (!ok) return;
              await db.del('reviews', r.id); state.reviews = state.reviews.filter((x) => x.id !== r.id); changed('review-del');
            },
          }, icon('trash')),
        ),
      ))) : h('p', { class: 'empty', text: '还没有写过复盘。写过一次之后，这里会积累你的卡点。' }),
    ),
  );
}
const barW = (v, max) => (max <= 0 ? 0 : Math.min(100, Math.round((v / max) * 100)));

export { render };
