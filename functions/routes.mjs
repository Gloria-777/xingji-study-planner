// 业务路由：浏览器只调用同源 /functions/v1/app，数据库与模型凭证仅存在于 Function 内。
// 依赖注入（db/env/BackendError）仅用于本地测试；部署入口 index.ts 保留 Deno.serve。
import {
  WORK_SYSTEM, MENTOR_SYSTEM, PARSE_COURSES_SYSTEM,
  nowCN, nowContext, scheduleContext, planPrompt,
} from './prompts.mjs';
import { verifyUploadedObject } from './storage-validation.mjs';
import { createLlm, createAiRouter } from './ai.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COURSE_COLS = 'id,visitor_id,name,day,start_time,end_time,location,teacher,week_start,week_end,created_at';
const TASK_COLS = 'id,visitor_id,title,subject,due_at,priority,note,status,done_at,created_at';
const MSG_COLS = 'id,visitor_id,agent,role,content,images,created_at';

// 迁移子集要求新增列可空且无默认值，所以 NULL 由这里解释为全周次。
const WEEK_MAX = 25;
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 3;
const IMAGE_ONLY_TEXT = '（学生只发来了图片，请先看懂图片内容，再自然地回应。）';
const OBJECT_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;

export function application({ db, env, storage, BackendError }) {
  const fail = (code, status) => { throw new BackendError(code, status); };
  const rows = (result) => { if (result.error) fail('database_unavailable', 503); return result.data ?? []; };
  const llm = createLlm({ env, BackendError });
  const aiRouter = createAiRouter({ env, BackendError, llm });

  async function input(request, maxBytes = 65536) {
    if (!request.headers.get('content-type')?.startsWith('application/json')) fail('invalid_input', 400);
    const reader = request.body?.getReader();
    if (!reader) fail('invalid_input', 400);
    let size = 0; const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { await reader.cancel(); fail('payload_too_large', 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('invalid_input', 400); }
  }

  const visitorOf = (request) => {
    const v = request.headers.get('x-visitor-id');
    if (!v || !UUID_RE.test(v)) fail('invalid_visitor', 400);
    return v;
  };

  // ---------- 校验 ----------
  const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
  const pad = (n) => String(n).padStart(2, '0');

  // 周次：两端都留空表示全周次（存 NULL）；填了则夹在 1..WEEK_MAX 且 start<=end。
  function normalizeWeek(start, end) {
    const s = Number(start);
    const e = Number(end);
    const hasS = Number.isInteger(s) && s >= 1;
    const hasE = Number.isInteger(e) && e >= 1;
    if (!hasS && !hasE) return { week_start: null, week_end: null };
    const lo = Math.min(WEEK_MAX, Math.max(1, hasS ? s : 1));
    const hi = Math.min(WEEK_MAX, Math.max(lo, hasE ? e : WEEK_MAX));
    return { week_start: lo, week_end: hi };
  }

  function normalizeCourse(c) {
    const name = String(c?.name || '').trim().slice(0, 60);
    const day = Number(c?.day);
    const start = String(c?.start || '').trim();
    const end = String(c?.end || '').trim();
    if (!name || !Number.isInteger(day) || day < 1 || day > 7) return null;
    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) return null;
    if (toMin(end) <= toMin(start)) return null;
    return {
      name, day,
      start_time: `${pad(+start.split(':')[0])}:${start.split(':')[1]}`,
      end_time: `${pad(+end.split(':')[0])}:${end.split(':')[1]}`,
      location: String(c.location || '').trim().slice(0, 60),
      teacher: String(c.teacher || '').trim().slice(0, 40),
      ...normalizeWeek(c?.week_start, c?.week_end),
    };
  }

  function normalizeTask(t) {
    const title = String(t?.title || '').trim().slice(0, 120);
    if (!title) return null;
    const due = String(t.due_at || '').trim();
    return {
      title,
      subject: String(t.subject || '').trim().slice(0, 40),
      due_at: /^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}/.test(due) ? due.slice(0, 16) : '',
      priority: ['low', 'medium', 'high'].includes(t.priority) ? t.priority : 'medium',
      note: String(t.note || '').trim().slice(0, 200),
    };
  }

  // ---------- 大模型（实现见 ai.mjs，与无状态 AI 路由共用一份调用契约） ----------
  function llmConfig() {
    return llm.config();
  }

  function extractJson(text) {
    return llm.extractJson(text);
  }

  async function chatCompletion(messages, options = {}) {
    return llm.complete(messages, options);
  }

  async function contextData(visitor) {
    const [courses, tasks] = await Promise.all([
      db.from('courses').select(COURSE_COLS).eq('visitor_id', visitor).order('day', { ascending: true }).order('start_time', { ascending: true }).limit(200),
      db.from('tasks').select(TASK_COLS).eq('visitor_id', visitor).order('created_at', { ascending: true }).limit(300),
    ]);
    return { courses: rows(courses), tasks: rows(tasks) };
  }

  const AGENTS = { work: WORK_SYSTEM, mentor: MENTOR_SYSTEM };
  const AGENT_NAMES = { work: '规划小助', mentor: '心事树洞' };

  // 两个 AI 共享近况：让对方空间的近期对话进入本次系统提示，避免"刚说完很累还被派重活"。
  async function peerContext(visitor, agent) {
    const other = agent === 'work' ? 'mentor' : 'work';
    const list = rows(await db.from('messages').select('role,content').eq('visitor_id', visitor).eq('agent', other).order('created_at', { ascending: false }).limit(8)).reverse();
    if (!list.length) return '';
    const lines = list.map((m) => `${m.role === 'user' ? '学生' : AGENT_NAMES[other]}：${String(m.content).slice(0, 400)}`);
    return `\n\n## 另一空间的近期对话（${AGENT_NAMES[other]}）\n${lines.join('\n')}\n\n这些是学生在另一个 AI 空间的真实近况，用来理解他们当下的状态（疲惫、焦虑、进度等）。不要逐字复述或提及"我看到了聊天记录"，只把它当作你已知的背景来调整回复与任务难度。`;
  }

  // ---------- 聊天图片附件 ----------
  // 目录段由服务端从访客 ID 派生；浏览器只能提交自己目录下的路径，路径本身不是权限证明。
  async function attachmentPrefix(visitor) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(visitor));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `chat/${hex.slice(0, 32)}`;
  }

  function ownAttachment(prefix, candidate) {
    if (typeof candidate !== 'string' || candidate.includes('..')) return null;
    const head = `${prefix}/`;
    if (!candidate.startsWith(head)) return null;
    return OBJECT_NAME_RE.test(candidate.slice(head.length)) ? candidate : null;
  }

  const requireStorage = () => { if (!storage) fail('storage_unavailable', 503); };

  async function viewUrl(objectPath) {
    try { return (await storage.createSignedUrl(objectPath, 3600)).signedUrl || ''; } catch { return ''; }
  }

  // 只为最近若干张图片签发地址，避免一次历史读取产生过多签名请求。
  async function imageUrlsFor(messages, cap = 30) {
    const jobs = [];
    for (let i = messages.length - 1; i >= 0 && jobs.length < cap; i -= 1) {
      for (const p of toPaths(messages[i].images)) {
        if (jobs.length >= cap) break;
        jobs.push({ index: i, path: p });
      }
    }
    const urls = await Promise.all(jobs.map((j) => viewUrl(j.path)));
    const byIndex = new Map();
    jobs.forEach((j, n) => {
      if (!urls[n]) return;
      const arr = byIndex.get(j.index) || [];
      arr.push(urls[n]);
      byIndex.set(j.index, arr);
    });
    return byIndex;
  }

  const imageParts = (text, urls) => ([
    { type: 'text', text },
    ...urls.map((u) => ({ type: 'image_url', image_url: { url: u } })),
  ]);

  // ---------- 路由 ----------
  return async (ctx) => {
    const request = ctx.request;
    const pathname = new URL(request.url).pathname;
    const match = pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
    if (!match) fail('not_found', 404);
    const path = match[1] || '/';
    const method = request.method;

    if (path === '/api/health' && method === 'GET') {
      return Response.json({ ok: true, llm: Boolean(llmConfig().key), configurable: false });
    }

    // ----- 无状态 AI（静态版本地数据 + 双助手）：不读云端库、不要求 visitor_id -----
    const aiResponse = await aiRouter({ path, method, request });
    if (aiResponse) return aiResponse;

    // 下面这些是 React 时代留下的云端接口。现在发布的静态版只调用 /api/ai/status 与
    // /api/ai/chat（数据全在浏览器本机），而这些旧接口的身份来自客户端自带的
    // x-visitor-id —— 任何人都能填一个 UUID 就读写对应桶，站点公开后就是一个没有上限的
    // 云端写入面（既是数据污染，也是费用风险）。所以整体停用；要恢复必须先加真实身份校验。
    fail('retired', 410);

    const visitor = visitorOf(request);

    // ----- 课表 -----
    if (path === '/api/courses' && method === 'GET') {
      return Response.json(rows(await db.from('courses').select(COURSE_COLS).eq('visitor_id', visitor).order('day', { ascending: true }).order('start_time', { ascending: true }).limit(200)).map(toCourseOut));
    }
    if (path === '/api/courses' && method === 'POST') {
      const c = normalizeCourse(await input(request));
      if (!c) fail('invalid_input', 400);
      const row = { id: crypto.randomUUID(), visitor_id: visitor, created_at: new Date().toISOString(), ...c };
      const inserted = rows(await db.from('courses').insert(row).select(COURSE_COLS));
      if (!inserted.length) fail('database_unavailable', 503);
      return Response.json(toCourseOut(inserted[0]), { status: 201 });
    }
    if (path === '/api/courses/bulk' && method === 'POST') {
      const body = await input(request);
      const list = Array.isArray(body?.courses) ? body.courses.slice(0, 40) : [];
      const toInsert = list.map(normalizeCourse).filter(Boolean)
        .map((c) => ({ id: crypto.randomUUID(), visitor_id: visitor, created_at: new Date().toISOString(), ...c }));
      if (toInsert.length) rows(await db.from('courses').insert(toInsert).select('id'));
      return Response.json({ added: toInsert.length, skipped: list.length - toInsert.length });
    }
    const courseId = path.match(/^\/api\/courses\/([0-9a-f-]{36})$/);
    if (courseId && method === 'PUT') {
      const c = normalizeCourse(await input(request));
      if (!c) fail('invalid_input', 400);
      const updated = rows(await db.from('courses').update(c).eq('id', courseId[1]).eq('visitor_id', visitor).select(COURSE_COLS));
      if (!updated.length) fail('not_found', 404);
      return Response.json(toCourseOut(updated[0]));
    }
    if (courseId && method === 'DELETE') {
      const deleted = rows(await db.from('courses').delete().eq('id', courseId[1]).eq('visitor_id', visitor).select('id'));
      if (!deleted.length) fail('not_found', 404);
      return Response.json({ ok: true });
    }
    if (path === '/api/courses/parse' && method === 'POST') {
      const body = await input(request);
      const text = String(body?.text || '').trim().slice(0, 2000);
      if (!text) fail('invalid_input', 400);
      const raw = await chatCompletion(
        [{ role: 'system', content: PARSE_COURSES_SYSTEM }, { role: 'user', content: `${nowContext()}\n\n${text}` }],
        { temperature: 0.1 },
      );
      const parsed = extractJson(raw);
      const courses = (parsed.courses || []).map(normalizeCourse).filter(Boolean).map(toCourseOut);
      return Response.json({ courses });
    }

    // ----- 任务 -----
    if (path === '/api/tasks' && method === 'GET') {
      return Response.json(rows(await db.from('tasks').select(TASK_COLS).eq('visitor_id', visitor).order('created_at', { ascending: true }).limit(300)).map(toTaskOut));
    }
    if (path === '/api/tasks' && method === 'POST') {
      const t = normalizeTask(await input(request));
      if (!t) fail('invalid_input', 400);
      const row = { id: crypto.randomUUID(), visitor_id: visitor, status: 'pending', done_at: null, created_at: new Date().toISOString(), ...t };
      const inserted = rows(await db.from('tasks').insert(row).select(TASK_COLS));
      if (!inserted.length) fail('database_unavailable', 503);
      return Response.json(toTaskOut(inserted[0]), { status: 201 });
    }
    if (path === '/api/tasks/bulk' && method === 'POST') {
      const body = await input(request);
      const list = Array.isArray(body?.tasks) ? body.tasks.slice(0, 40) : [];
      const toInsert = list.map(normalizeTask).filter(Boolean)
        .map((t) => ({ id: crypto.randomUUID(), visitor_id: visitor, status: 'pending', done_at: null, created_at: new Date().toISOString(), ...t }));
      if (toInsert.length) rows(await db.from('tasks').insert(toInsert).select('id'));
      return Response.json({ added: toInsert.length, skipped: list.length - toInsert.length });
    }
    const taskId = path.match(/^\/api\/tasks\/([0-9a-f-]{36})$/);
    if (taskId && method === 'PUT') {
      const body = await input(request);
      const patch = {};
      if (body.status !== undefined) {
        patch.status = body.status === 'done' ? 'done' : 'pending';
        patch.done_at = patch.status === 'done' ? new Date().toISOString() : null;
      }
      const t = normalizeTask(body);
      if (t) Object.assign(patch, t);
      if (!Object.keys(patch).length) fail('invalid_input', 400);
      const updated = rows(await db.from('tasks').update(patch).eq('id', taskId[1]).eq('visitor_id', visitor).select(TASK_COLS));
      if (!updated.length) fail('not_found', 404);
      return Response.json(toTaskOut(updated[0]));
    }
    if (taskId && method === 'DELETE') {
      const deleted = rows(await db.from('tasks').delete().eq('id', taskId[1]).eq('visitor_id', visitor).select('id'));
      if (!deleted.length) fail('not_found', 404);
      return Response.json({ ok: true });
    }

    // ----- AI 生成计划 -----
    if (path === '/api/plan/generate' && method === 'POST') {
      const body = await input(request);
      const goal = String(body?.goal || '').trim().slice(0, 500);
      const { courses, tasks } = await contextData(visitor);
      const peer = await peerContext(visitor, 'work');
      const raw = await chatCompletion([
        { role: 'system', content: WORK_SYSTEM + nowContext() + '\n\n' + scheduleContext(courses, tasks) + peer + '\n\n本次你只负责生成计划 JSON，不要输出 <actions> 块。' },
        { role: 'user', content: planPrompt(goal) },
      ], { temperature: 0.4 });
      const arr = extractJson(raw);
      const out = (Array.isArray(arr) ? arr : arr.tasks || []).map(normalizeTask).filter(Boolean).map(toTaskOut);
      return Response.json({ tasks: out });
    }

    // ----- 双 Agent 聊天 -----
    if (path === '/api/chat/attachments/sign' && method === 'POST') {
      requireStorage();
      const body = await input(request);
      const contentType = String(body?.contentType || '').split(';')[0].trim().toLowerCase();
      const ext = IMAGE_EXT[contentType];
      const size = Number(body?.size);
      if (!ext) fail('invalid_input', 400);
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_IMAGE_BYTES) fail('invalid_input', 400);
      const objectPath = `${await attachmentPrefix(visitor)}/${crypto.randomUUID()}.${ext}`;
      let uploadUrl;
      try { uploadUrl = (await storage.createSignedUploadUrl(objectPath, { upsert: false })).signedUrl; } catch { fail('storage_unavailable', 503); }
      return Response.json(
        { objectPath, uploadUrl, contentType, maxBytes: MAX_IMAGE_BYTES },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    if (path === '/api/chat/attachments/confirm' && method === 'POST') {
      requireStorage();
      const body = await input(request);
      const contentType = String(body?.contentType || '').split(';')[0].trim().toLowerCase();
      const size = Number(body?.size);
      const objectPath = ownAttachment(await attachmentPrefix(visitor), body?.objectPath);
      if (!objectPath || !IMAGE_EXT[contentType]) fail('invalid_input', 400);
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_IMAGE_BYTES) fail('invalid_input', 400);
      if (!objectPath.endsWith(`.${IMAGE_EXT[contentType]}`)) fail('invalid_input', 400);
      let actual;
      try {
        actual = await verifyUploadedObject(await storage.download(objectPath), {
          maxBytes: MAX_IMAGE_BYTES, expectedBytes: size, allowedContentTypes: [contentType],
        });
      } catch (error) {
        if (String(error?.message || '').startsWith('upload_')) fail('attachment_invalid', 400);
        fail('storage_unavailable', 503);
      }
      return Response.json(
        { objectPath, size: actual.size, contentType: actual.contentType, viewUrl: await viewUrl(objectPath) },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    const chatMsgs = path.match(/^\/api\/chat\/(work|mentor)\/messages$/);
    if (chatMsgs && method === 'GET') {
      const list = rows(await db.from('messages').select(MSG_COLS).eq('visitor_id', visitor).eq('agent', chatMsgs[1]).order('created_at', { ascending: false }).limit(100)).reverse();
      const urls = await imageUrlsFor(list);
      return Response.json(list.map((m, i) => toMsgOut(m, urls.get(i))));
    }
    if (chatMsgs && method === 'DELETE') {
      rows(await db.from('messages').delete().eq('visitor_id', visitor).eq('agent', chatMsgs[1]).select('id'));
      return Response.json({ ok: true });
    }
    const chatSend = path.match(/^\/api\/chat\/(work|mentor)$/);
    if (chatSend && method === 'POST') {
      const agent = chatSend[1];
      const body = await input(request);
      const content = String(body?.message || '').trim().slice(0, 4000);
      const prefix = await attachmentPrefix(visitor);
      const supplied = Array.isArray(body?.images) ? body.images : [];
      if (supplied.length > MAX_IMAGES) fail('invalid_input', 400);
      const images = [];
      for (const candidate of supplied) {
        const owned = ownAttachment(prefix, candidate);
        if (!owned) fail('invalid_input', 400);
        images.push(owned);
      }
      if (!content && !images.length) fail('invalid_input', 400);
      const now = new Date().toISOString();
      rows(await db.from('messages').insert({
        id: crypto.randomUUID(), visitor_id: visitor, agent, role: 'user', content,
        images: images.length ? images : null, created_at: now,
      }).select('id'));
      const [historyResult, ctx, peer] = await Promise.all([
        db.from('messages').select(MSG_COLS).eq('visitor_id', visitor).eq('agent', agent).order('created_at', { ascending: false }).limit(21),
        contextData(visitor),
        peerContext(visitor, agent),
      ]);
      const history = rows(historyResult).reverse();
      const system = AGENTS[agent] + nowContext() + '\n\n' + scheduleContext(ctx.courses, ctx.tasks) + peer;
      const [historyUrls, currentUrls] = await Promise.all([
        imageUrlsFor(history.slice(0, -1), 6),
        Promise.all(images.map((p) => viewUrl(p))),
      ]);
      const past = history.slice(0, -1).map((m, i) => {
        const urls = historyUrls.get(i) || [];
        return { role: m.role, content: urls.length ? imageParts(String(m.content ?? ''), urls) : String(m.content ?? '') };
      });
      const fresh = currentUrls.filter(Boolean);
      const turn = {
        role: 'user',
        content: fresh.length ? imageParts(content || IMAGE_ONLY_TEXT, fresh) : content,
      };
      let reply = await chatCompletion(
        [{ role: 'system', content: system }, ...past, turn],
        { temperature: agent === 'mentor' ? 0.8 : 0.5 },
      );
      let actions = [];
      const block = reply.match(/<actions>([\s\S]*?)<\/actions>/);
      if (block) {
        reply = reply.replace(block[0], '').trim();
        try {
          const arr = extractJson(block[1]);
          actions = (Array.isArray(arr) ? arr : []).filter((a) => a && typeof a === 'object').slice(0, 10);
        } catch { /* 忽略格式错误的 actions */ }
      }
      const msg = {
        id: crypto.randomUUID(), visitor_id: visitor, agent, role: 'assistant', content: reply,
        images: null, created_at: new Date().toISOString(),
      };
      rows(await db.from('messages').insert(msg).select('id'));
      return Response.json({ message: toMsgOut(msg), actions });
    }

    // ----- 工作 AI 行动确认 -----
    if (path === '/api/actions/apply' && method === 'POST') {
      const a = (await input(request))?.action;
      if (!a || typeof a !== 'object') fail('invalid_input', 400);
      if (a.type === 'add_course') {
        const c = normalizeCourse(a);
        if (!c) fail('invalid_input', 400);
        rows(await db.from('courses').insert({ id: crypto.randomUUID(), visitor_id: visitor, created_at: new Date().toISOString(), ...c }).select('id'));
        return Response.json({ ok: true, summary: `已录入课程「${c.name}」 周${'一二三四五六日'[c.day - 1]} ${c.start_time}-${c.end_time}` });
      }
      if (a.type === 'delete_course') {
        if (!UUID_RE.test(String(a.id))) fail('invalid_input', 400);
        const deleted = rows(await db.from('courses').delete().eq('id', String(a.id)).eq('visitor_id', visitor).select('id,name'));
        if (!deleted.length) fail('not_found', 404);
        return Response.json({ ok: true, summary: `已删除课程「${deleted[0].name}」` });
      }
      if (a.type === 'add_task') {
        const t = normalizeTask(a);
        if (!t) fail('invalid_input', 400);
        rows(await db.from('tasks').insert({ id: crypto.randomUUID(), visitor_id: visitor, status: 'pending', done_at: null, created_at: new Date().toISOString(), ...t }).select('id'));
        return Response.json({ ok: true, summary: `已创建任务「${t.title}」${t.due_at ? `，截止 ${t.due_at.replace('T', ' ')}` : ''}` });
      }
      fail('invalid_input', 400);
    }

    // ----- 提醒轮询（POST：会写入 fired 记录） -----
    if (path === '/api/reminders/poll' && method === 'POST') {
      const q = new URL(request.url).searchParams;
      const courseLead = clampLead(q.get('courseLead'), 15);
      const taskLead = clampLead(q.get('taskLead'), 10);
      const n = nowCN();
      const due = [];

      const courseRows = rows(await db.from('courses').select(COURSE_COLS).eq('visitor_id', visitor).eq('day', n.day).limit(100));
      for (const c of courseRows) {
        const startMin = toMin(c.start_time);
        const trigger = startMin - courseLead;
        if (n.nowMin >= trigger && n.nowMin <= startMin + 5) {
          due.push({
            key: `c${c.id}-${n.dateStr}`, type: 'course', title: '上课提醒',
            body: courseLead > 0 && n.nowMin < startMin
              ? `「${c.name}」将在 ${startMin - n.nowMin} 分钟后（${c.start_time}）开始${c.location ? `，地点：${c.location}` : ''}`
              : `「${c.name}」现在（${c.start_time}）开始${c.location ? `，地点：${c.location}` : ''}`,
          });
        }
      }

      const pendingTasks = rows(await db.from('tasks').select(TASK_COLS).eq('visitor_id', visitor).eq('status', 'pending').neq('due_at', '').limit(300));
      for (const t of pendingTasks) {
        const dueDate = new Date(`${t.due_at}:00+08:00`);
        if (isNaN(dueDate)) continue;
        const nowMs = Date.now();
        const triggerMs = dueDate.getTime() - taskLead * 60000;
        const graceMs = dueDate.getTime() + 15 * 60000;
        if (nowMs >= triggerMs && nowMs <= graceMs) {
          due.push({ key: `t${t.id}-${t.due_at}`, type: 'task', title: '任务提醒', body: `「${t.title}」计划 ${t.due_at.slice(11, 16)} 进行，轻轻推你一下～` });
        } else if (nowMs > graceMs) {
          due.push({ key: `t${t.id}-overdue-${n.dateStr}`, type: 'overdue', title: '计划调整提醒', body: `「${t.title}」已过原定时间。没关系的，去「学习计划」里顺延或拆小一点吧。` });
        }
      }

      if (!due.length) return Response.json({ reminders: [] });
      const firedRows = rows(await db.from('fired').select('fire_key').eq('visitor_id', visitor).in('fire_key', due.map((d) => d.key)).limit(500));
      const firedSet = new Set(firedRows.map((r) => r.fire_key));
      const fresh = due.filter((d) => !firedSet.has(d.key));
      if (fresh.length) {
        rows(await db.from('fired').insert(fresh.map((d) => ({ id: crypto.randomUUID(), visitor_id: visitor, fire_key: d.key, fired_at: new Date().toISOString() }))).select('id'));
      }
      return Response.json({ reminders: fresh.map(({ key, ...r }) => r) });
    }

    // ----- 今日概览 -----
    if (path === '/api/today' && method === 'GET') {
      const n = nowCN();
      const [courseRows, dueRows, overRows, doneRows] = await Promise.all([
        db.from('courses').select(COURSE_COLS).eq('visitor_id', visitor).eq('day', n.day).order('start_time', { ascending: true }).limit(50),
        db.from('tasks').select(TASK_COLS).eq('visitor_id', visitor).eq('status', 'pending').gte('due_at', `${n.dateStr}T00:00`).lte('due_at', `${n.dateStr}T23:59`).limit(100),
        db.from('tasks').select(TASK_COLS).eq('visitor_id', visitor).eq('status', 'pending').lt('due_at', `${n.dateStr}T00:00`).limit(100),
        db.from('tasks').select('id').eq('visitor_id', visitor).eq('status', 'done').gte('done_at', `${n.dateStr}T00:00:00+08:00`).limit(100),
      ]);
      return Response.json({
        date: n.dateStr,
        day: `周${'一二三四五六日'[n.day - 1]}`,
        courses: rows(courseRows).map(toCourseOut),
        dueToday: rows(dueRows).map(toTaskOut),
        overdue: rows(overRows).map(toTaskOut),
        doneCount: rows(doneRows).length,
      });
    }

    fail('not_found', 404);
  };
}

function clampLead(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(120, Math.round(n)));
}

// 数据库列名 → 前端契约字段名
function toCourseOut(r) {
  return {
    id: r.id, name: r.name, day: r.day, start: r.start_time, end: r.end_time,
    location: r.location, teacher: r.teacher,
    week_start: Number.isInteger(r.week_start) ? r.week_start : null,
    week_end: Number.isInteger(r.week_end) ? r.week_end : null,
  };
}
function toTaskOut(r) {
  return { id: r.id, title: r.title, subject: r.subject, due_at: r.due_at, priority: r.priority, note: r.note, status: r.status, done_at: r.done_at, created_at: r.created_at };
}
function toMsgOut(r, images) {
  return { id: r.id, agent: r.agent, role: r.role, content: r.content, created_at: r.created_at, images: images ?? [] };
}
// jsonb 列可能以数组或 JSON 字符串返回，两种都接受。
function toPaths(value) {
  if (!value) return [];
  let list = value;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  return list.filter((x) => typeof x === 'string').slice(0, MAX_IMAGES);
}
