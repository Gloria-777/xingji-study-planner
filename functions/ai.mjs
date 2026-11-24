// 无状态 AI 层：密钥只从环境变量读；学生的课表/任务/计划由浏览器本机随请求带来，服务端不写库、不存对话。
import { WORK_SYSTEM, MENTOR_SYSTEM, nowContext } from './prompts.mjs';
import { assessRisk, crisisReply } from './safety.mjs';

const AGENT_NAMES = { work: '规划小助', mentor: '心事树洞' };
const PEER_OF = { work: 'mentor', mentor: 'work' };
// 教练只说话，不动数据：动作在服务端就被丢掉，不依赖模型自觉。
const WRITING_AGENTS = new Set(['work']);
// 隐私栏目 -> 提示词里的段落；学生关掉共享时这里显示"没共享"，跟"本机是空的"区分开。
const NOT_SHARED = '（学生没有共享这一类数据，你没有也不需要猜测它）';

const MAX_MESSAGE = 4000;
const MAX_HISTORY = 24;
const MAX_HISTORY_CHARS = 2000;
const MAX_PEER = 10;
const MAX_PEER_CHARS = 400;
const MAX_ITEMS = 120;
const MAX_TEXT = 60;
const MAX_CONTEXT_TEXT = 12000;
const MAX_BODY_BYTES = 96 * 1024;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = 20;
// 实例级总量闸门：x-xj-device 是客户端自带的、可以随便换，所以再加一层「同一个实例 5 分钟内
// 总共放行多少条」的上限，作为公网下的费用兜底。换实例或重启仍可绕过，不是安全边界。
const RATE_GLOBAL_MAX = 200;
const rateGlobal = [];
// 尽力而为的额度保护：内存计数、按设备声明的 id 分桶，换个 id 或换实例就绕过，不是安全边界。
const rateBuckets = new Map();

function clip(value, max) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

function int(value, dflt = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : dflt;
}

export function createLlm({ env, BackendError }) {
  const config = () => ({
    key: env('LLM_API_KEY') || '',
    base: (env('LLM_BASE_URL') || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    model: env('LLM_MODEL') || 'deepseek-chat',
  });

  async function complete(messages, { temperature = 0.7, maxTokens = 2000 } = {}) {
    const cfg = config();
    if (!cfg.key) throw new BackendError('service_not_configured', 503);
    const controller = new AbortController();
    // 计时器要罩住整个来回，包括读响应体：原来 headers 一到就 clearTimeout，
    // 上游慢慢滴 body 时这条请求可以一直挂着，60 秒那道闸就形同虚设了。
    const timer = setTimeout(() => controller.abort(), 60000);
    let res;
    try {
      res = await fetch(`${cfg.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({ model: cfg.model, messages, temperature, max_tokens: maxTokens }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // 401/403 是密钥的问题，429 是额度的问题，400 多半是上下文太长——处理的人不一样，
        // 压成同一句「网络问题」谁都修不动。状态码只进日志，不进给用户看的话，也不带上游原文。
        console.log(`llm_upstream_status=${res.status}`);
        if (res.status === 401 || res.status === 403) throw new BackendError('service_not_configured', 503);
        if (res.status === 429) throw new BackendError('model_rate_limited', 429);
        throw new BackendError('model_unavailable', 503);
      }
      let json;
      try {
        json = await res.json();
      } catch (err) {
        if (err instanceof SyntaxError) throw new BackendError('model_bad_output', 502);
        throw err;
      }
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new BackendError('model_bad_output', 502);
      return content;
    } catch (err) {
      // 只认自己分过类的那些（code 是字符串）：DOMException 上也有 .code，但是个数字，
      // 顺着它抛出去就等于把「AbortError」这种内部话直接甩给用户。
      if (err && typeof err.code === 'string') throw err;
      if (controller.signal.aborted) throw new BackendError('model_timeout', 504);
      throw new BackendError('model_unavailable', 503);
    } finally {
      clearTimeout(timer);
    }
  }

  function extractJson(text) {
    const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fence ? fence[1] : String(text);
    const start = candidate.search(/[[{]/);
    if (start === -1) throw new BackendError('model_bad_output', 502);
    const open = candidate[start];
    const close = open === '[' ? ']' : '}';
    const end = candidate.lastIndexOf(close);
    if (end <= start) throw new BackendError('model_bad_output', 502);
    try { return JSON.parse(candidate.slice(start, end + 1)); }
    catch { throw new BackendError('model_bad_output', 502); }
  }

  return { config, complete, extractJson };
}

// ---------- 本机快照 → 提示词文本 ----------
function dayName(day) {
  const n = int(day);
  return n >= 1 && n <= 7 ? `周${'一二三四五六日'[n - 1]}` : `周${n}`;
}

function coursesSection(rows) {
  const list = (Array.isArray(rows) ? rows : []).slice(0, MAX_ITEMS);
  if (!list.length) return '（本机课表为空）';
  return list
    .slice()
    .sort((a, b) => int(a.day) - int(b.day) || String(a.start).localeCompare(String(b.start)))
    .map((c) => {
      const weeks = c.weeks ? ` 第${c.weeks}周` : '';
      const where = clip(c.location, MAX_TEXT) ? ` @${clip(c.location, MAX_TEXT)}` : '';
      const who = clip(c.teacher, MAX_TEXT) ? `（${clip(c.teacher, MAX_TEXT)}）` : '';
      return `- ${dayName(c.day)} ${clip(c.start, 5)}-${clip(c.end, 5)} ${clip(c.name, MAX_TEXT)}${where}${who}${weeks}`;
    })
    .join('\n');
}

function tasksSection(rows) {
  const list = (Array.isArray(rows) ? rows : []).slice(0, MAX_ITEMS);
  if (!list.length) return '（暂无学习任务）';
  return list.map((t) => {
    const est = int(t.estMin);
    const spent = int(t.spentMin);
    const progress = est > 0 ? `已投入 ${spent}/${est} 分钟，还剩 ${Math.max(0, est - spent)} 分钟` : `已投入 ${spent} 分钟（学生没填预计时长）`;
    const status = t.status === 'done' ? '已完成' : (t.dueAt && Date.parse(t.dueAt) < Date.now() ? '已过期未做' : '待做');
    const subject = clip(t.subject, MAX_TEXT);
    const note = clip(t.note, 120);
    return `- ${clip(t.title, MAX_TEXT)}${subject ? `（${subject}）` : ''}｜${status}${t.dueAt ? ` 截止 ${clip(t.dueAt, 16).replace('T', ' ')}` : ' 无截止时间'}｜优先级 ${clip(t.priority, 10) || 'medium'}｜${progress}${note ? `｜备注：${note}` : ''}`;
  }).join('\n');
}

function plansSection(rows) {
  const list = (Array.isArray(rows) ? rows : []).slice(0, MAX_ITEMS);
  if (!list.length) return '（未来 7 天没有排好的学习计划）';
  const label = { done: '已完成', skipped: '已跳过', scheduled: '计划中' };
  return list.map((p) => {
    const spent = int(p.spentMin);
    return `- ${clip(p.date, 10)} ${clip(p.start, 5)} · ${clip(p.title, MAX_TEXT)}｜${label[p.status] || '计划中'}｜${int(p.min)} 分钟${spent > 0 ? `，已投入 ${spent} 分钟` : '，还没有专注记录'}`;
  }).join('\n');
}

function goalsSection(rows) {
  const list = (Array.isArray(rows) ? rows : []).slice(0, 5);
  if (!list.length) return '（本机没有学习目标）';
  return list.map((g) => {
    const stages = (Array.isArray(g.stages) ? g.stages : []).map((x) => clip(x, 40)).filter(Boolean);
    return `- [id=${clip(g.id, 40)}] ${clip(g.title, MAX_TEXT)}｜${stages.length ? `现有路线：${stages.join(' → ')}` : '还没有路线'}`;
  }).join('\n');
}

function focusSection(rows) {
  const list = (Array.isArray(rows) ? rows : []).slice(0, 14);
  if (!list.length) return '（近 7 天没有专注记录）';
  return list.map((f) => `- ${clip(f.date, 10)}：${int(f.count)} 次，计划 ${int(f.plannedMin)} 分钟，实际 ${int(f.actualMin)} 分钟`).join('\n');
}

function reminderSection(r) {
  if (!r || typeof r !== 'object') return '';
  const pending = int(r.pending);
  const missed = int(r.missed);
  if (!pending && !missed) return `\n\n提醒：${pending} 条待响、${missed} 条已错过。`;
  return `\n\n提醒：${pending} 条待响、${missed} 条已错过（已错过只代表页面没开着时没响，不代表任务失败）。`;
}

/** 共享门控只有一个来源：顶层 privacy 优先，缺了就退回快照里那一份。
 *  两处各自判、一处 fail-open 一处 fail-closed 的话，提示词里写的「已共享」和实际带没带会说的不一样。 */
function privacyOf(body, snap) {
  const top = body?.privacy && typeof body.privacy === 'object' ? body.privacy : null;
  const inner = snap && typeof snap === 'object' && snap.privacy && typeof snap.privacy === 'object' ? snap.privacy : null;
  return top || inner || {};
}

export function localContextText(snap, privacy = null) {
  const s = snap && typeof snap === 'object' ? snap : {};
  const counts = s.counts && typeof s.counts === 'object' ? s.counts : {};
  const pv = privacy && typeof privacy === 'object' ? privacy : (s.privacy && typeof s.privacy === 'object' ? s.privacy : {});
  // 只有显式 true 才算共享：缺字段、旧版本、被人改包，一律按最保守的那一档处理
  const on = (k) => pv[k] === true;
  const section = (key, body) => (on(key) ? body : NOT_SHARED);
  const meals = [
    s.lunch ? `午休 ${clip(s.lunch, 16)}` : '',
    s.dinner ? `晚餐 ${clip(s.dinner, 16)}` : '',
  ].filter(Boolean).join('、');
  const text = `## 学生本机数据（只存在学生浏览器里，随本次请求带来）
今天：${clip(s.today, 10) || '未知'}${s.todayName ? ` ${clip(s.todayName, 6)}` : ''}
共享设置：课表${on('courses') ? '已共享' : '未共享'} · 任务与计划${on('tasks') ? '已共享' : '未共享'} · 近 7 天专注${on('focus') ? '已共享' : '未共享'} · 另一个空间的对话${on('peer') ? '已共享' : '未共享'}
数据量：${[
  on('courses') ? `课程 ${int(counts.courses)} 门` : '',
  on('tasks') ? `任务 ${int(counts.tasks)} 条 · 计划 ${int(counts.plans)} 条` : '',
  on('focus') ? `专注记录 ${int(counts.sessions)} 条` : '',
].filter(Boolean).join(' · ') || '（学生没有共享任何本机数据）'}

### 课表（每周重复）
${section('courses', coursesSection(s.courses))}

### 学习任务（含本机累计的专注投入）
${section('tasks', tasksSection(s.tasks))}

### 学习目标（set_stages 的 goal_id 只能从这里取）
${section('tasks', goalsSection(s.goals))}

### 未来 7 天的学习计划
${section('tasks', plansSection(s.plans))}

### 近 7 天专注（计划时长 vs 实际时长）
${section('focus', focusSection(s.focus))}

### 时间余量
${on('tasks') ? `今天到 23:00 还剩约 ${int(s.freeTodayMin)} 分钟空闲；每天学习上限 ${int(s.dailyCapMin)} 分钟${meals ? `；固定避开 ${meals}` : ''}。` : NOT_SHARED}${reminderSection(on('tasks') ? s.reminders : null)}

这些数字是学生浏览器里的真实记录。请据此安排，不要假设别的数据，也不要把"计时结束"当成"任务完成"——状态是学生手动标的。没共享的栏目就是没有，不要猜，也不要求学生打开。`;
  return text.slice(0, MAX_CONTEXT_TEXT);
}

function peerText(agent, rows) {
  const list = (Array.isArray(rows) ? rows : []).slice(-MAX_PEER);
  if (!list.length) return '';
  const other = PEER_OF[agent];
  const lines = list
    .map((m) => `${m.role === 'user' ? '学生' : AGENT_NAMES[other]}：${clip(m.content, MAX_PEER_CHARS)}`)
    .filter((l) => l.length > 3);
  if (!lines.length) return '';
  return `\n\n## 另一空间的近期对话（${AGENT_NAMES[other]}）\n${lines.join('\n')}\n\n这些是学生在另一个 AI 空间的真实近况，用来理解他们当下的状态（疲惫、焦虑、进度等）。不要逐字复述或提及"我看到了聊天记录"，只把它当作你已知的背景来调整回复与任务难度。`;
}

function historyText(rows) {
  const list = (Array.isArray(rows) ? rows : []).slice(-MAX_HISTORY);
  return list
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: clip(m.content, MAX_HISTORY_CHARS) }))
    .filter((m) => m.content);
}

// ---------- 请求体 / 来源 / 限流 ----------
async function readJson(request, BackendError) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) throw new BackendError('payload_too_large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new BackendError('invalid_input', 400);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value?.byteLength || 0;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new BackendError('payload_too_large', 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new BackendError('invalid_input', 400); }
}

// 来源校验不在这里做：平台网关已经拦掉「无 Origin」和「外站 Origin」的 POST（403
// sites_gateway_origin_forbidden），实测见 dev/public-surface-check.mjs 的说明。函数内部再比一次
// 反而会误杀真浏览器——边缘运行时给出的 request.url / Host 并不等于站点的公网 host，
// 之前就是这个原因让公网版的所有对话都返回 invalid_origin。
// 返回 0 表示放行，否则返回「还要等多少秒」。
// 挡下来时必须给得出这个数：只回一个 429，界面只能写成「等一会儿再问」，而额度窗口是 5 分钟，
// 学生根本不知道自己是再敲一次回车就行，还是要等到下课。
function rateWait(clientId) {
  const raw = clip(clientId, 64);
  // 设备 id 是客户端自己声明的，前端那条约束是 8–64 位。这里按同一把尺子收：
  // 太短或没有的一律落进同一个 anonymous 桶，不给「每次换一个 1 字符 id 就领一个新桶」的刷法。
  const id = raw.length >= 8 ? raw : 'anonymous';
  const now = Date.now();
  const since = now - RATE_WINDOW_MS;
  const after = (t) => Math.max(1, Math.ceil((t + RATE_WINDOW_MS - now) / 1000));
  while (rateGlobal.length && rateGlobal[0] <= since) rateGlobal.shift();
  if (rateGlobal.length >= RATE_GLOBAL_MAX) return after(rateGlobal[0]);
  const hits = (rateBuckets.get(id) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    rateBuckets.set(id, hits);
    return after(hits[0]);
  }
  hits.push(now);
  rateBuckets.set(id, hits);
  rateGlobal.push(now);
  // 原来这里是 size > 5000 就 clear()：只要灌进 5001 个新 id，就能把所有老实学生的额度一起清零，
  // 等于给公网上的脚本一个「重置限流」按钮。改成按插入顺序逐个丢掉最旧的桶，上限不变但不再清零。
  while (rateBuckets.size > 5000) {
    const oldest = rateBuckets.keys().next();
    if (oldest.done) break;
    rateBuckets.delete(oldest.value);
  }
  return 0;
}

// 只放行课表/任务/时间安排/目标路线四类动作，每条字段由浏览器再校验一次（含冲突检查）才写库。
function pickActions(raw, extractJson) {
  const whole = String(raw ?? '');
  const block = whole.match(/<actions>([\s\S]*?)<\/actions>/);
  // 先把动作块从可见回复里剥掉，再去解析它：原来解析一失败就把原文整个当回复返回，
  // 那一段 <actions>[...]</actions> 会直接漏进学生看得见的话里。
  const text = block ? whole.replace(block[0], '').trim() : whole.trim();
  let arr = null;
  try { arr = extractJson(block ? block[1] : whole); } catch { return { text, actions: [] }; }
  const list = Array.isArray(arr) ? arr : (Array.isArray(arr?.actions) ? arr.actions : []);
  const allowed = new Set(['add_course', 'delete_course', 'add_task', 'add_plan', 'set_stages']);
  return { text, actions: list.filter((a) => a && typeof a === 'object' && allowed.has(a.type)).slice(0, 10) };
}

export function createAiRouter({ env, BackendError, llm }) {
  const status = () => {
    const cfg = llm.config();
    return {
      configured: Boolean(cfg.key),
      model: cfg.key ? cfg.model : null,
      // 不返回 base 之外的任何配置；host 只用于让学生知道请求发到哪一类服务。
      host: cfg.key ? (() => { try { return new URL(cfg.base).host; } catch { return null; } })() : null,
      reason: cfg.key ? null : 'service_not_configured',
    };
  };

  return async ({ path, method, request }) => {
    if (path === '/api/ai/status' && method === 'GET') return Response.json(status());

    if (path === '/api/ai/chat' && method === 'POST') {
      const body = await readJson(request, BackendError);
      const agent = body?.agent === 'mentor' ? 'mentor' : 'work';
      const message = clip(body?.message, MAX_MESSAGE);
      if (!message) throw new BackendError('invalid_input', 400);

      // 高风险消息由服务端自己的流程接：不看密钥配没配、不进限流队列、不调模型、不留云端记录。
      const risk = assessRisk(message);
      if (risk.crisis) {
        return Response.json({
          agent,
          reply: crisisReply(agent),
          actions: [],
          model: null,
          safety: { handled: 'server', rule: 'crisis', matched: risk.hits.length, modelCalled: false },
        });
      }

      const cfg = llm.config();
      if (!cfg.key) throw new BackendError('service_not_configured', 503);
      const wait = rateWait(request.headers.get('x-xj-device'));
      // 这一条不走 BackendError：平台那层的错误体只有 code，装不下「还要等多久」。
      // 自己应答，形状仍按自家约定用 error 字段，前端按同一把尺子读，只是多带一个 retry_after。
      if (wait) {
        return Response.json({ error: 'rate_limited', retry_after: wait },
          { status: 429, headers: { 'retry-after': String(wait), 'cache-control': 'no-store' } });
      }

      const pv = privacyOf(body, body.context);
      // 跨助手这一档 fail-closed：客户端没明说 true（旧版本、缺字段、被人改包）就不带对面对话原文。
      // 与前端新默认一致（store.js 的 privacy.peer 默认 false），而且和上面快照里那一档同一个来源，
      // 不会出现提示词写「已共享」、实际什么都没带的那种自相矛盾。
      const system = (agent === 'work' ? WORK_SYSTEM : MENTOR_SYSTEM)
        + nowContext()
        + '\n\n'
        + localContextText(body.context, pv)
        + peerText(agent, pv.peer === true ? body.peer : []);

      const raw = await llm.complete(
        [{ role: 'system', content: system }, ...historyText(body.history), { role: 'user', content: message }],
        { temperature: agent === 'mentor' ? 0.8 : 0.5, maxTokens: agent === 'mentor' ? 900 : 2000 },
      );
      const { text, actions } = pickActions(raw, llm.extractJson);
      // 教练不许动日历：就算模型输出了动作，服务端也不放行（客户端还会再挡一次）。
      const canWrite = WRITING_AGENTS.has(agent);
      if (!text && (!canWrite || !actions.length)) throw new BackendError('model_bad_output', 502);
      return Response.json({
        agent,
        reply: text || '我整理了几条待确认的建议，请逐条核对。',
        actions: canWrite ? actions : [],
        model: cfg.model,
        safety: !canWrite && actions.length ? { handled: 'server', rule: 'no_write_actions', dropped: actions.length } : null,
      });
    }

    return null;
  };
}
