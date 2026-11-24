// AI 助手页：规划小助 + 心事树洞。对话与本机数据都留在浏览器，服务端函数只负责调模型。
import { h, icon, clear, toast, openSheet, confirmSheet, isNarrow } from '../ui.js';
import {
  AGENTS, send, historyOf, clearHistory, snapshot, privacyOf,
  normalizeAction, runActions, probeWrite, markApplied, errorMessage, appendHistory,
} from '../ai.js';
import { state } from '../state.js';
import { dataPlace } from '../native.js';
import { openNotice } from '../notice.js';
import * as db from '../store.js';
import { suggestPlan, validateSlot } from '../schedule.js';
import { writeRow, changed } from '../forms.js';

const PRIVACY_LABEL = { courses: '课表', tasks: '任务与计划', focus: '近 7 天专注', peer: '另一个空间的对话' };

let agent = 'work';
let messages = [];
const pending = { work: null, mentor: null };
const errors = { work: '', mentor: '' };
// 没打完的一句话按助手分开存，并写一份到本机 localStorage：切页、刷新、切助手都不串内容。
const DRAFT_KEY = 'xj-draft';

function readDrafts() {
  try {
    const m = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
    return {
      work: typeof m.work === 'string' ? m.work : '',
      mentor: typeof m.mentor === 'string' ? m.mentor : '',
    };
  } catch (e) { return { work: '', mentor: '' }; }
}

let drafts = readDrafts();
let draftTimer = 0;

function flushDraft() {
  clearTimeout(draftTimer);
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch (e) { /* 隐私模式写不进去，页面内照样保留 */ }
}

function setDraft(owner, text) {
  drafts[owner] = String(text || '');
  // 打字不必每个字符都同步写一次 localStorage——手机 WebView 里这是主线程上的同步 IO。
  // 停手 400ms 再落盘；发出去、切后台这些时刻会主动补一次，不会把草稿丢掉。
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 400);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDraft(); });
let redraw = () => {};

/** 别的页面（如今日页快捷按钮）指定进入哪个助手 */
export function openAs(which) { if (AGENTS[which]) agent = which; }


async function loadMessages(owner = agent) {
  const rows = await historyOf(owner);
  if (agent === owner) messages = rows;
}

async function doSend(text) {
  const owner = agent;
  const original = String(text || '');
  const body = original.trim();
  if (!body || pending[owner]) return;
  const controller = new AbortController();
  pending[owner] = controller;
  errors[owner] = '';
  setDraft(owner, original);
  flushDraft();
  redraw();
  const visible = () => state.page === 'assistants' && agent === owner;
  try {
    const out = await send(owner, body, { signal: controller.signal });
    if (drafts[owner] === original) {
      setDraft(owner, '');
      flushDraft();
    }
    await loadMessages(owner);
    if (visible() && out.actions.length) {
      toast('有待确认的建议', `这条回复有 ${out.actions.length} 条建议，查看后可以逐条采纳。`);
    }
  } catch (e) {
    if (e.code === 'aborted') {
      if (visible()) toast('已停止等待回复', '输入仍保留在这里。');
    } else {
      errors[owner] = e.message || errorMessage('offline');
    }
  } finally {
    pending[owner] = null;
    if (visible()) redraw();
  }
}

/* 逐条留痕里「还能再挑出来重试」的两类：上次没勾选的、上次写入失败的。
   校验没过（invalid）的条目本来就勾不上，不算可重试。 */
const RETRYABLE = new Set(['unchecked', 'failed']);
const statusesOf = (m) => (Array.isArray(m.actionStatuses) ? m.actionStatuses : null);
function leftCount(st) { return st.filter((x) => x && RETRYABLE.has(x.status)).length; }

function confirmActionsSheet(msg) {
  const items = msg.actions.map(normalizeAction);
  const prev = statusesOf(msg) || [];
  const isDone = (i) => Boolean(prev[i]) && prev[i].status === 'applied';
  const boxes = items.map((it, i) => h('input', {
    type: 'checkbox', checked: it.ok && !isDone(i), disabled: !it.ok || isDone(i), 'aria-label': `确认：${it.label}`,
  }));
  const lastTag = (i) => {
    const r = prev[i];
    if (!r) return null;
    if (r.status === 'applied') return h('span', { class: 'tag ok', text: '已写入本机' });
    if (r.status === 'failed') return h('span', { class: 'tag bad', text: `上次没写进去：${r.error || '写入失败'}` });
    if (r.status === 'invalid') return h('span', { class: 'tag', text: '本机校验没过' });
    return h('span', { class: 'tag', text: '上次没勾选' });
  };
  const countsNow = () => `${state.courses.length}/${state.tasks.length}/${state.plans.length}`;
  // 每一行都可以「让它直接写试试」。这一试走的是 runActions 同一套本机校验，但绝不调用写入函数：
  // 拦下来时把当场算出的理由演给看（撞哪门课 / 落在午休 / 已过截止时间），过得去时也要说出来——
  // 因为第二道闸是「你勾选」，程序不替人决定，也不替自己开门。
  const probes = items.map(() => h('div', { class: 'probe-out' }));
  const content = h('div', {},
    h('p', { class: 'note', text: `下面是助手建议写入${dataPlace()}（IndexedDB）的改动。每一条都在本机重新校验过：安排的时段会再和课程、午休、晚餐、已有计划查一次冲突，还要过任务截止时间，冲突或信息不足的条目勾不上，也就写不进去。这一步没走完之前，你的数据不会有任何变化；写了几条以本机返回结果为准，没写入的那几条会留在这条消息里，可以再点一次。` }),
    ...items.map((it, i) => h('div', { class: 'check-row' },
      boxes[i],
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title', text: `${it.label} · ${it.ok ? '校验通过' : '有问题'}` }),
        h('div', { class: 'row-meta' },
          h('span', { text: it.detail }),
          it.error ? h('span', { class: 'tag bad', text: it.error }) : null,
          lastTag(i),
        ),
        h('div', { class: 'row-meta' }, h('button', {
          class: 'btn btn-ghost probe-btn',
          text: '让它直接写试试',
          onclick: (ev) => {
            const btn = ev.currentTarget;
            const before = countsNow();
            const r = probeWrite(it.raw, agent);
            clear(probes[i]);
            probes[i].append(
              h('span', { class: r.blocked ? 'tag bad' : 'tag ok', text: r.blocked ? `本机拦下：${r.reason}` : '本机校验过得去' }),
              h('span', { class: 'probe-line', text: r.blocked
                ? `这一条没进日历，原因是上面那句由本机排程器当场算出来的，不是模型的说法。库里课程/任务/计划仍是 ${before}。`
                : `但这一条还是没写进去——写入要你勾上左边的框。这里有两道闸：程序拦时段冲突，你拦要不要落库。库里课程/任务/计划仍是 ${before}。` }),
            );
            btn.textContent = '再试一次';
          },
        })),
        probes[i],
      ),
    )));
  const sheet = openSheet({
    title: '确认这些改动写进本机',
    content,
    actions: [
      h('button', { class: 'btn', onclick: () => sheet.close(), text: '一条都不写' }),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-primary',
        onclick: async (ev) => {
          const btn = ev.currentTarget;
          const chosen = [];
          items.forEach((it, i) => { if (it.ok && boxes[i].checked && !isDone(i)) chosen.push({ it, i }); });
          if (!chosen.length) { sheet.close(); return; }
          btn.disabled = true;
          try {
            const res = await runActions(chosen.map((x) => x.it.raw), agent);
            // 留痕按这条消息自己的序号写，runActions 的 results 与 chosen 一一对应
            const next = items.map((it, i) => prev[i] || { status: it.ok ? 'unchecked' : 'invalid', error: it.ok ? '' : it.error });
            chosen.forEach((c, k) => {
              const r = res.results[k];
              next[c.i] = r && r.ok ? { status: 'applied', text: r.text } : { status: 'failed', error: (r && r.error) || '写入失败' };
            });
            const wrote = next.filter((x) => x.status === 'applied').length;
            await markApplied(agent, msg.id, wrote, next);
            const miss = chosen.length - res.applied.length;
            await loadMessages();
            sheet.close();
            redraw();
            toast(miss ? '部分已写入' : '已写入本机', miss
              ? `这条建议里已写入 ${wrote} 条，这次没写进去 ${miss} 条：${res.failed.join('　·　')}。剩下的还在这条消息上，可以再点一次。`
              : `这条建议里已写入 ${wrote} 条，全部落库。`);
          } catch (e) {
            // 失败时这个按钮还在原 DOM 里，把它放开让人改勾选重试；ev.currentTarget 在 await 后已经是 null
            if (btn.isConnected) btn.disabled = false;
            toast('写入失败', e.message || String(e), 'bad');
          }
        },
        text: '写入勾选的改动',
      }),
    ],
  });
}

function safetyRow(sf) {
  if (!sf) return null;
  if (sf.rule === 'crisis') {
    return h('div', { class: 'safety', role: 'status' },
      h('div', { class: 'row-meta' },
        h('span', { class: 'tag warn', text: '服务端安全流程接住了这条' }),
        h('span', { class: 'tag', text: sf.modelCalled ? '模型也参与了' : '这一轮没调用大模型' }),
      ),
      h('p', { class: 'note', text: '这一步只是关键词初步识别，由本机调用的服务端函数判定，不靠模型自己决定，也不是风险评估：它识别不了所有风险，会漏掉委婉说法，也可能误判。所以这句话只是提醒，不是诊断。' }),
    );
  }
  if (sf.rule === 'no_write_actions') {
    return h('div', { class: 'safety', role: 'status' },
      h('div', { class: 'row-meta' },
        h('span', { class: 'tag', text: `教练不能写你的日程：这条回复里的 ${sf.dropped || 0} 个写入动作在服务端就被丢掉了` }),
      ),
      h('p', { class: 'note', text: '想让安排真的落到日历上，去「规划小助」那边让它出一个要你确认的提案。' }),
    );
  }
  return null;
}

function outcomeTag(m, st, actionCount, wrote) {
  if (!st) {
    return actionCount - (m.appliedCount || 0) > 0
      ? h('span', { class: 'tag bad', text: `另有 ${actionCount - (m.appliedCount || 0)} 条没过本机校验或被你取消，没写进数据库（这一条留痕早于逐条记录，挑不出剩余项）` })
      : h('span', { class: 'tag', text: '全部建议都落库了' });
  }
  const n = (k) => st.filter((x) => x && x.status === k).length;
  const bits = [`已写入 ${wrote}/${actionCount} 条`];
  if (n('unchecked')) bits.push(`你取消勾选 ${n('unchecked')} 条`);
  if (n('failed')) bits.push(`没写进去 ${n('failed')} 条`);
  if (n('invalid')) bits.push(`校验没过 ${n('invalid')} 条`);
  return h('span', { class: (n('failed') || n('invalid')) ? 'tag bad' : 'tag', text: bits.join(' · ') });
}

/** 用户主动转交：从树洞回复里挑一句「愿意尝试的下一步」→ 本机规则排程 → 预览查冲突 → 确认写入。
 *  只把用户确认的那一句交给排程；树洞的完整对话不转交，隐私设置也不改。 */
const HANDOFF_NOTE = '用户确认的下一步 · 规则排程 · 未调用 AI';

function handoffSheet(m) {
  const source = String(m.content || '');
  const ta = h('textarea', { rows: 2, maxlength: 120, placeholder: '从上面的树洞原话里挑一句你愿意试的下一步，写在这里', 'aria-label': '愿意尝试的下一步' });
  const estEl = h('input', { type: 'number', min: 5, max: 480, step: 5, value: 30, 'aria-label': '预计分钟' });
  const preview = h('div', {});
  let draft = null;
  let saving = false;

  const renderPreview = () => {
    clear(preview);
    if (!draft) { preview.append(h('p', { class: 'hint', text: '先写下要安排的那一步，再点「生成预览」。' })); return; }
    const res = draft.res;
    if (!res.items.length) {
      preview.append(h('div', { class: 'card' },
        h('h4', { text: '这一句没有排出空档' }),
        res.skipped.length
          ? h('p', { class: 'warn-bar', text: res.skipped.map((x) => x.reason).join('；') })
          : h('p', { class: 'empty', text: '没有可用时段。' }),
      ));
      return;
    }
    const rows = res.items.map((it) => {
      it.keep = true;
      const cb = h('input', { type: 'checkbox', checked: true, 'aria-label': `保留 ${it.title}` });
      cb.addEventListener('change', () => { it.keep = cb.checked; });
      const errs = validateSlot({ date: it.date, start: it.start, min: it.min, dueAt: null });
      return h('div', { class: 'check-row' }, cb,
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: it.title }),
          h('div', { class: 'row-meta' },
            h('span', { class: errs.length ? 'tag bad' : 'tag ok', text: errs.length ? `冲突：${errs[0]}` : '空闲时段内' }),
            it.basis ? h('span', { class: 'note muted', text: `依据：${it.basis}` }) : null,
          ),
        ),
      );
    });
    preview.append(h('div', { class: 'check-list' }, ...rows));
    preview.append(h('p', { class: 'note muted', text: `将写入：1 条任务「${draft.task.title}」+ 上面勾选的时段；除此之外没有别的内容从树洞转过来。` }));
  };

  const generate = () => {
    const sentence = ta.value.trim();
    if (!sentence) { toast('先写一句要安排的下一步', '从树洞原话里挑一句，或自己写一句。', 'bad'); return; }
    const est = Math.max(5, Math.min(480, Number(estEl.value) || 30));
    const task = { id: db.uid(), title: sentence, estMin: est, priority: 'medium', dueAt: '', status: 'pending', note: '来自心事树洞 · 你确认要试的下一步', subject: '', addedBy: 'handoff', createdAt: new Date().toISOString() };
    const res = suggestPlan({ tasks: [task], horizonDays: 7, chunkMax: 45 });
    draft = { task, res };
    renderPreview();
  };

  const save = async () => {
    if (saving || !draft) return;
    const chosen = draft.res.items.filter((x) => x.keep);
    if (!chosen.length) { toast('没有勾选任何时段', '勾几条，或取消。', 'bad'); return; }
    saving = true;
    try {
      const task = draft.task;
      if (!(await writeRow(() => db.put('tasks', task)))) return;
      state.tasks = [...state.tasks, task];
      const rows = chosen.map((it) => ({
        id: db.uid(), taskId: task.id, title: task.title, date: it.date, start: it.start, min: Number(it.min),
        status: 'scheduled', statusAt: null, source: 'rule', basis: it.basis || null, createdAt: new Date().toISOString(),
      }));
      await db.bulkPut('plans', rows);
      state.plans = [...state.plans, ...rows];
      // 把「已安排」这一步回显进树洞，只记用户采纳的决定，不转交树洞的原文
      await appendHistory('mentor', 'user', `我已把「${task.title}」安排进计划（${rows.length} 个时段）。`);
      await loadMessages();
      redraw();
      sheet.close();
      changed('handoff');
      toast('这一步已安排', `「${task.title}」写进了任务，并排了 ${rows.length} 个时段；树洞里记了一条「已安排」的回显。完整对话没有转交，隐私设置也没改。`);
    } finally { saving = false; }
  };

  const sheet = openSheet({
    title: '把这一步安排进计划',
    content: h('div', {},
      h('p', { class: 'hint', text: '只把你确认的这一步交给排程；树洞的完整对话不会转交，你的隐私设置也不变。' }),
      h('details', {}, h('summary', { class: 'note', text: '树洞原话（从这里挑一句）' }), h('pre', { class: 'ctx-json', text: source.slice(0, 600) })),
      h('div', { class: 'field' }, h('label', { text: '愿意尝试的下一步' }), ta),
      h('div', { class: 'field-row' }, h('div', { class: 'field' }, h('label', { text: '预计分钟' }), estEl)),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: generate, text: '生成预览' })),
      h('div', { class: 'row-meta', style: 'margin-top:8px' }, h('span', { class: 'tag', text: HANDOFF_NOTE })),
      h('p', { class: 'note muted', text: '实际转交：只有你在上面写下的那一句 + 预计分钟。树洞的完整对话、以及你和树洞的其他内容都不会发出去，也不会发给任何模型；这一步是本机按课表、截止时间和空闲时段算出来的规则排程，不是两个大模型在协商。' }),
      preview,
    ),
    actions: [
      h('button', { class: 'btn', onclick: () => sheet.close(), text: '取消' }),
      h('button', { class: 'btn btn-primary', onclick: save, text: '确认写入勾选的时段' }),
    ],
  });
  return sheet;
}

function messageRow(m) {
  const who = m.role === 'user' ? '你' : AGENTS[agent].name;
  const canWrite = AGENTS[agent].canWrite === true;
  const actionCount = m.role === 'assistant' && Array.isArray(m.actions) ? m.actions.length : 0;
  const st = statusesOf(m);
  const left = st ? leftCount(st) : 0;
  const wrote = st ? st.filter((x) => x && x.status === 'applied').length : (m.appliedCount || 0);
  return h('div', { class: `msg ${m.role}` },
    h('div', { class: 'msg-who', text: `${who} · ${new Date(m.at).toLocaleString('zh-CN', { hour12: false })}` }),
    m.content || '（这条没有文字内容）',
    m.role === 'assistant' && !canWrite
      ? h('div', { class: 'btn-row', style: 'margin-top:6px' },
          h('button', { class: 'btn btn-sm', onclick: () => handoffSheet(m), text: '安排这一步' }),
          h('span', { class: 'note muted', text: '只把你确认的一句交给排程，不转交完整对话。' }))
      : null,
    canWrite && actionCount
      ? h('div', { class: 'btn-row' },
        // 有逐条留痕、且还有没写进去的可重试条目时，按钮留在原地；旧记录没有留痕，不假装能追溯重试
        (!m.applied || left > 0)
          ? h('button', { class: 'btn btn-sm', onclick: () => confirmActionsSheet(m), text: m.applied ? `继续确认剩下的 ${left} 条本机写入` : `确认这 ${actionCount} 条本机写入` })
          : h('span', { class: 'tag ok', text: `已写入本机 ${wrote} 条（建议 ${actionCount} 条，逐条确认过）` }),
        m.applied ? outcomeTag(m, st, actionCount, wrote) : h('span', { class: 'tag', text: '不确认就不写库' }),
      )
      : null,
    safetyRow(m.safety),
  );
}

function thread() {
  const box = h('div', { class: 'thread', role: 'log', 'aria-live': 'polite', 'aria-label': `${AGENTS[agent].name}的对话` });
  if (!messages.length) {
    const words = agent === 'work'
      ? '告诉我想完成什么、还有多少时间。安排会先检查冲突，确认后才会写入。'
      : '说说哪里卡住了，我可以陪你找一个容易开始的小步骤。对话不会改动你的日历或任务。';
    box.append(h('div', { class: 'chat-empty' },
      h('div', { class: 'chat-welcome' },
        h('h2', { text: agent === 'work' ? '今天想推进哪件事？' : '从能做的一小步开始' }),
        h('p', { text: words }),
        agent === 'mentor' ? h('p', { class: 'note', text: '学习心态陪练不能替代心理治疗或紧急求助。紧急情况请联系 110 / 120，也可拨打 12356 寻求心理援助。' }) : null),

    ));
  }
  for (const m of messages) box.append(messageRow(m));
  if (pending[agent]) box.append(h('div', { class: 'thinking' },
    h('span', { class: 'tdots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    h('span', { text: `${AGENTS[agent].name}正在想…` }),
  ));
  return box;
}

function composer() {
  const owner = agent;
  const request = pending[owner];
  const ta = h('textarea', {
    rows: 1,
    maxlength: 4000,
    placeholder: agent === 'work' ? '说说你想完成什么' : '说说你现在的感受',
    'aria-label': `对${AGENTS[agent].name}说话`,
  });
  ta.value = drafts[owner];
  // 输入框跟着内容长高（豆包那种两行三行自动变大），超过约 5 行后内部滚动
  const MAX_INPUT_H = 120;
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_INPUT_H)}px`;
  };
  ta.addEventListener('input', () => { setDraft(owner, ta.value); grow(); });
  requestAnimationFrame(grow);
  let composing = false;
  let composeEndedAt = -Infinity;
  ta.addEventListener('compositionstart', () => { composing = true; });
  ta.addEventListener('compositionend', () => {
    composing = false;
    composeEndedAt = performance.now();
  });
  ta.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey) return;
    if (composing || ev.isComposing || ev.keyCode === 229) return;
    // 部分输入法先结束组合输入，随后才交给页面确认候选词的回车。
    if (performance.now() - composeEndedAt < 100) return;
    ev.preventDefault();
    if (owner === agent) doSend(ta.value);
  });
  const sendBtn = h('button', {
    class: `btn chat-send${request ? '' : ' btn-primary'}`,
    onclick: () => {
      if (request) request.abort();
      else if (owner === agent) doSend(ta.value);
    },
    text: request ? '停止' : '发送',
  });
  return h('div', { class: 'composer chat-composer' },
    h('div', { class: 'chat-input' }, ta),
    sendBtn);
}


async function clearAgent() {
  const owner = agent;
  if (pending[owner]) return;
  const ok = await confirmSheet({
    title: `清空和${AGENTS[owner].name}的对话`,
    message: `只删${dataPlace()}里这个助手的对话记录，你的课表、任务、计划、专注记录都不受影响。

另一个助手（${AGENTS[owner === 'work' ? 'mentor' : 'work'].name}）的对话会保留，记忆互通会跟着变。`,
    confirmText: '清空对话',
    danger: true,
  });
  if (!ok || pending[owner]) return;
  await clearHistory(owner);
  errors[owner] = '';
  if (agent === owner) {
    await loadMessages(owner);
    redraw();
  }
  toast('已清空', `${AGENTS[owner].name}的对话记录从本机删掉了。`);
}

let switchRequest = 0;
async function switchAgent(key) {
  const request = ++switchRequest;
  if (key === agent) return;
  try {
    const rows = await historyOf(key);
    if (request !== switchRequest || state.page !== 'assistants') return;
    const focusedRole = document.activeElement?.closest('.chat-agents');
    agent = key;
    messages = rows;
    redraw();
    if (focusedRole) document.querySelector('.chat-agents [aria-pressed="true"]')?.focus({ preventScroll: true });
  } catch (e) {
    if (request === switchRequest && state.page === 'assistants') toast('暂时无法切换助手', '请重试。', 'bad');
  }
}

/** 对话菜单含助手简介、会话管理和使用须知。 */
function openAgentMenu() {
  let sheet;
  const agentRow = (key, info) => h('button', {
    type: 'button', class: 'more-item', 'aria-pressed': key === agent ? 'true' : 'false',
    onclick: () => {
      sheet.close();
      switchAgent(key);
    },
  }, h('span', { class: 'more-ico' }, icon(key === 'work' ? 'target' : 'spark')),
     h('span', { class: 'row-main' }, h('b', { text: info.name }), h('small', { text: info.role })),
     h('span', { class: 'more-go' }, key === agent ? h('span', { class: 'tag ok', text: '当前' }) : icon('right')));
  sheet = openSheet({
    title: '助手与对话',
    content: h('div', { class: 'more-groups' },
      h('section', { class: 'more-group' },
        h('h4', { class: 'more-group-title', text: '切换助手' }),
        h('div', { class: 'more-list' }, ...Object.entries(AGENTS).map(([k, v]) => agentRow(k, v)))),
      h('section', { class: 'more-group' },
        h('h4', { class: 'more-group-title', text: '对话' }),
        h('div', { class: 'more-list' },
          h('button', { type: 'button', class: 'more-item', 'aria-label': '清空这个助手的对话', disabled: Boolean(pending[agent]), onclick: () => { sheet.close(); clearAgent(); } },
            h('span', { class: 'more-ico' }, icon('trash')), h('b', { text: '清空这个助手的对话' }), h('span', { class: 'more-go' }, icon('right'))),
          h('button', { type: 'button', class: 'more-item', onclick: () => { sheet.close(); openNotice(); } },
            h('span', { class: 'more-ico' }, icon('book')), h('b', { text: '使用须知与边界' }), h('span', { class: 'more-go' }, icon('right'))))),
      h('p', { class: 'note muted', text: `对话只存在${dataPlace()}里，两位助手各自一份；AI 的回答可能出错，写进本机前都要你逐条确认。` })),
  });
}

function paint(root) {
  function draw() {
    if (state.page !== 'assistants') return;
    const errBar = errors[agent] ? h('div', { class: 'err', role: 'alert', text: errors[agent] }) : null;
    clear(root);
    const inputArea = composer();
    const conversation = thread();
    const chat = h('div', { class: messages.length || pending[agent] ? 'chat-screen' : 'chat-screen chat-new' },
      h('div', { class: 'chat-head' },
        h('div', { class: 'chat-agents', role: 'group', 'aria-label': '切换助手' },
          ...Object.entries(AGENTS).map(([key, info]) => h('button', {
            type: 'button', class: 'btn btn-ghost chat-agent', 'aria-pressed': key === agent ? 'true' : 'false',
            onclick: () => switchAgent(key), text: info.name,
          }))),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': '助手与对话菜单', 'aria-haspopup': 'dialog', onclick: openAgentMenu }, icon('dots'))),
      errBar,
      conversation,
      h('div', { class: 'chat-bottom' }, inputArea),
    );
    root.append(chat);
    const box = root.querySelector('.thread');
    if (box && messages.length) box.scrollTop = box.scrollHeight;
  }
  redraw = draw;
  draw();
}

export async function render(root) {
  await loadMessages();
  if (state.page === 'assistants') paint(root);
}
