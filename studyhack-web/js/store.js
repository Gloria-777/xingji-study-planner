// 数据层：IndexedDB 为主存储，设置项放 localStorage。刷新不丢数据，全部留在本机浏览器。
// goals 是第 8 个库（v2 加的）：只新增，既有 7 个库的 objectStore 与字段一个都没动，
// v1 的库升上来时只会多出这张空表，原来的课程/任务/计划/专注/复盘/提醒照旧读得到。
export const STORES = ['courses', 'tasks', 'plans', 'sessions', 'reviews', 'reminders', 'goals', 'meta'];
const DB_NAME = 'xingji-studyhack';
const DB_VERSION = 2;
const SETTINGS_KEY = 'xj-settings';

export const DEFAULT_SETTINGS = {
  termStart: '',            // YYYY-MM-DD，学期第一周的周一
  axisStart: 7,             // 课表时间轴起点（小时）
  axisEnd: 23,
  lunchStart: '12:00',
  lunchEnd: '14:00',
  dinnerStart: '18:00',
  dinnerEnd: '19:00',
  dailyCapMin: 240,         // 计划每天最多安排的学习分钟数
  taskLeadMin: 10,          // 任务到期前多少分钟提醒
  courseLeadMin: 15,        // 上课前多少分钟提醒
  remindersEnabled: false,  // 用户主动点「开启网页提醒」后置为 true
  bell: 'triad',            // ding | triad | chime | none
  volume: 0.6,
  notifyOnly: false,        // 仅显示通知，不播放声音
  mutedKinds: [],           // 已关闭的提醒类型：course | task | custom
  quietEnabled: true,
  quietFrom: '23:00',
  quietTo: '07:30',
  dockEnabled: false,       // 桌面底部悬浮停靠栏：可选第二排入口，默认关（左导航是默认入口）
  // AI 每轮能带走哪些本机数据；false 的类目根本不会出现在请求体里。
  // peer 默认关：跨助手带走的是另一位对话的原文，里面更容易出现没说出口的话。
  privacy: { courses: true, tasks: true, focus: true, peer: false },
};

let dbPromise = null;

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('这个浏览器不支持 IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    // 另一个标签页还占着旧版本时，open 会一直卡在这里（不报错也不成功），整页都渲染不出来。
    // 说清楚该做什么，而不是让用户对着转圈的屏幕发呆。
    req.onblocked = () => reject(new Error('另一个标签页还开着这个应用的旧版本，关掉它再刷新'));
  }).catch((err) => {
    // 打开失败不能永久缓存这一枚 rejected promise：否则一次失败之后所有操作都跟着一起失败。
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.onerror = () => reject(t.error || new Error('存储操作失败'));
    t.onabort = () => reject(t.error || new Error('存储操作被中断'));
    // 读操作在请求成功时就能拿到结果；写操作必须等事务提交完再回执——
    // 配额满或事务在提交前中断时，提前 resolve 会让界面显示「已保存」而库里其实没落盘。
    let value;
    if (req) req.onsuccess = () => { value = req.result; if (mode === 'readonly') resolve(value); };
    t.oncomplete = () => resolve(mode === 'readonly' ? value : true);
  }));
}

export const list = (store) => tx(store, 'readonly', (s) => s.getAll());
export const get = (store, id) => tx(store, 'readonly', (s) => s.get(id));
export const put = (store, obj) => tx(store, 'readwrite', (s) => s.put(obj));
export const del = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));
export const clearStore = (store) => tx(store, 'readwrite', (s) => s.clear());
export const count = (store) => tx(store, 'readonly', (s) => s.count());

export function bulkPut(store, rows) {
  if (!rows.length) return Promise.resolve(true);
  return tx(store, 'readwrite', (s) => { for (const r of rows) s.put(r); });
}

export function bulkDelete(store, ids) {
  if (!ids.length) return Promise.resolve(true);
  return tx(store, 'readwrite', (s) => { for (const id of ids) s.delete(id); });
}

/** 删任务时一次事务处理任务、它的计划、还没响的提醒：任何一条失败整笔回滚，
    不会出现「任务没了、计划还挂着它」或反过来的半截状态。 */
export async function removeTaskCascade(taskId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(['tasks', 'plans', 'reminders'], 'readwrite'); }
    catch (err) { reject(err); return; }
    t.onerror = () => reject(t.error || new Error('存储操作失败'));
    t.onabort = () => reject(t.error || new Error('删除被中断，原有数据没有变化'));
    t.oncomplete = () => resolve(true);
    t.objectStore('tasks').delete(taskId);
    const plans = t.objectStore('plans');
    const planReq = plans.getAll();
    planReq.onsuccess = () => {
      for (const p of planReq.result) if (p.taskId === taskId) plans.delete(p.id);
    };
    const reminders = t.objectStore('reminders');
    const remReq = reminders.getAll();
    remReq.onsuccess = () => {
      for (const r of remReq.result) if (r.refId === taskId && r.status === 'active') reminders.delete(r.id);
    };
  });
}

/** 删目标：同一事务里把任务解绑（goalId/stageId 置空）再删目标，任务一条不删。 */
export async function deleteGoalCascade(goalId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(['goals', 'tasks'], 'readwrite'); }
    catch (err) { reject(err); return; }
    t.onerror = () => reject(t.error || new Error('存储操作失败'));
    t.onabort = () => reject(t.error || new Error('删除被中断，原有数据没有变化'));
    t.oncomplete = () => resolve(true);
    t.objectStore('goals').delete(goalId);
    const tasks = t.objectStore('tasks');
    const req = tasks.getAll();
    req.onsuccess = () => {
      for (const row of req.result) {
        if (row.goalId === goalId) tasks.put({ ...row, goalId: null, stageId: null });
      }
    };
  });
}

export async function metaGet(key) {
  const row = await get('meta', key);
  return row ? row.value : undefined;
}
export async function metaSet(key, value) {
  return put('meta', { id: key, value });
}

// ---------- 设置（localStorage） ----------
export function settings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { saved = {}; }
  return { ...DEFAULT_SETTINGS, ...saved };
}

export function saveSettings(patch) {
  const next = { ...settings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

// ---------- 备份 ----------
/* 两位助手的对话存在 meta 里（ai.js 按 chat:work / chat:mentor 整段存）。
   备份要能带走它，就得单开一节而不是整表导 meta：meta 里还有 lastDeletedPlan
   这类一次性快照，整表带回另一台机器就是把过期状态也一起复原了。 */
export const CHAT_IDS = { work: 'chat:work', mentor: 'chat:mentor' };
export const CHAT_KEYS = Object.values(CHAT_IDS);

export async function exportAll({ withChat = false } = {}) {
  const out = { app: 'xingji-studyhack', version: DB_VERSION, exportedAt: new Date().toISOString(), settings: settings() };
  for (const name of STORES) if (name !== 'meta') out[name] = await list(name);
  if (withChat) {
    const chat = [];
    for (const key of CHAT_KEYS) {
      const row = await get('meta', key);
      if (Array.isArray(row?.value) && row.value.length) chat.push({ id: row.id, value: row.value });
    }
    if (chat.length) out.chat = chat;
  }
  return out;
}

export function validateBackup(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('文件内容不是有效的 JSON 对象');
  const ver = Number(payload.version);
  if (Number.isFinite(ver) && ver > DB_VERSION) throw new Error(`备份来自更新的版本（v${ver}），当前只支持到 v${DB_VERSION}；请先升级应用再导入`);
  const known = STORES.filter((s) => s !== 'meta');
  const found = known.filter((s) => Array.isArray(payload[s]));
  const chat = payload.chat === undefined ? null : payload.chat;
  if (chat !== null && !Array.isArray(chat)) throw new Error('聊天记录那一节不是数组，已停止导入');
  if (!found.length && !chat) throw new Error('文件里没有可识别的数据集合（courses / tasks / plans / sessions / reviews / reminders / goals）');
  let total = 0;
  for (const s of found) {
    if (payload[s].length > 20000) throw new Error(`${s} 有 ${payload[s].length} 条，超过单次导入上限 20000 条，已停止导入`);
    total += payload[s].length;
    const seen = new Set();
    for (const row of payload[s]) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) throw new Error(`${s} 中存在缺少 id 的记录，已停止导入`);
      if (seen.has(row.id)) throw new Error(`${s} 里有重复的 id（${row.id}），继续导入会静默覆盖其中一条，已停止`);
      seen.add(row.id);
    }
  }
  if (total > 50000) throw new Error(`文件里共有 ${total} 条记录，超过单次导入上限 50000 条，已停止导入`);
  let chatRows = 0;
  if (chat) {
    const seenChat = new Set();
    for (const row of chat) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !Array.isArray(row.value)) throw new Error('聊天记录里有不完整的段落，已停止导入');
      if (!CHAT_KEYS.includes(row.id)) throw new Error(`聊天记录里出现了不认识的助手标识 ${row.id}，已停止导入`);
      if (seenChat.has(row.id)) throw new Error(`聊天记录里 ${row.id} 出现了两次，已停止导入`);
      seenChat.add(row.id);
      chatRows += row.value.length;
    }
  }
  return { found, chat, rows: total + chatRows };
}

export async function importPreview(payload) {
  const { found, chat } = validateBackup(payload);
  const current = {};
  for (const s of found) current[s] = await count(s);
  let currentChat = 0;
  for (const row of chat || []) currentChat += (await get('meta', row.id))?.value?.length || 0;
  return {
    collections: found.map((s) => ({ name: s, incoming: payload[s].length, current: current[s] })),
    chat: chat ? { incoming: chat.reduce((n, r) => n + r.value.length, 0), current: currentChat, agents: chat.map((r) => r.id) } : null,
    settings: payload.settings || null,
  };
}

/** 导入走一个跨集合的事务：任何一条写失败都会整笔回滚，不会留下「课程进来了、任务没进来」的半个备份 */
export async function importApply(payload, mode) {
  const { found, chat } = validateBackup(payload);
  const names = chat ? [...found, 'meta'] : found;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction(names, 'readwrite');
    let failed = null;
    t.onerror = () => reject(failed || t.error || new Error('导入失败，原有数据没有变化'));
    t.onabort = () => reject(failed || t.error || new Error('导入中断，原有数据没有变化'));
    t.oncomplete = () => resolve(true);
    try {
      for (const s of found) {
        const os = t.objectStore(s);
        if (mode === 'replace') os.clear();
        for (const row of payload[s]) os.put(row);
      }
      if (chat) {
        const os = t.objectStore('meta');
        for (const row of chat) os.put(row);
      }
    } catch (err) {
      failed = err;
      try { t.abort(); } catch { /* 已经自己断了 */ }
      reject(err);
    }
  });
  let settingsError = null;
  if (payload.settings && typeof payload.settings === 'object') {
    try { saveSettings(payload.settings); }
    catch (err) { settingsError = (err && err.message) || '设置写不进去'; }
  }
  return { collections: found, chatAgents: chat ? chat.map((r) => r.id) : [], settingsError };
}

export async function wipeAll() {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(STORES, 'readwrite'); }
    catch (err) { reject(err); return; }
    t.onerror = () => reject(t.error || new Error('存储操作失败'));
    t.onabort = () => reject(t.error || new Error('清空被中断，原有数据没有变化'));
    t.oncomplete = () => resolve(true);
    for (const name of STORES) t.objectStore(name).clear();
  });
  let settingsCleared = true;
  try { localStorage.removeItem(SETTINGS_KEY); } catch { settingsCleared = false; }
  return { settingsCleared };
}

// ---------- 示例数据（日期相对今天，永远看起来是"当前这一周"） ----------
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d;
};
const iso = (d, hhmm) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${hhmm}`;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 本周一（学期起始日默认对齐本周一）
export function mondayOf(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export function sampleData() {
  const mon = mondayOf();
  const course = (name, dayIdx, start, end, location, teacher, extra = {}) => ({
    id: uid(), name, day: dayIdx, start, end, location, teacher,
    weekStart: 1, weekEnd: 16, parity: 'all', createdAt: new Date().toISOString(), demo: 'basic', ...extra,
  });

  const courses = [
    course('高等数学', 1, '08:00', '09:40', '教一 301', '王老师'),
    course('概率论', 1, '10:00', '11:40', '教一 305', '李老师'),
    course('大学英语', 2, '10:00', '11:40', '外语楼 202', 'Ms. Chen'),
    course('思想政治', 2, '14:00', '15:40', '图书馆报告厅', '张老师'),
    course('数据结构', 3, '14:00', '15:40', '教三 110', '赵老师'),
    course('程序设计实验', 3, '15:00', '16:40', '机房 B203', '孙老师', { parity: 'odd' }),
    course('线性代数', 4, '08:00', '09:40', '教一 208', '周老师', { parity: 'even' }),
    course('编译原理', 4, '10:00', '11:40', '教三 205', '吴老师'),
    course('体育（羽毛球）', 5, '16:00', '17:40', '体育馆', '教练：郑'),
  ];

  const task = (title, dueDate, hhmm, estMin, priority, extra = {}) => ({
    id: uid(), title, dueAt: iso(dueDate, hhmm), estMin, priority,
    status: 'pending', note: '', goalId: null, createdAt: new Date().toISOString(), demo: 'basic', ...extra,
  });

  const tasks = [
    task('高数：把第一章课后题前 5 题做完', day(0), '21:30', 45, 'high', { subject: '高等数学' }),
    task('英语：过 60 个单词（只看不背也行）', day(1), '20:00', 25, 'medium', { subject: '大学英语' }),
    task('数据结构：写二分查找的代码', day(2), '22:00', 60, 'high', { subject: '数据结构' }),
    task('编译原理：读讲义第 2 节，做批注', day(4), '21:00', 40, 'low', { subject: '编译原理' }),
    task('整理这周的错题（只挑 3 道）', day(5), '19:00', 30, 'medium', { subject: '复盘' }),
    { ...task('预约机房做实验预习', day(-1), '18:00', 20, 'medium'), status: 'done', doneAt: iso(day(-1), '17:40') },
  ];

  const sessions = [
    { id: uid(), taskId: tasks[5].id, plannedMin: 20, actualMin: 25, endedAt: iso(day(-1), '18:05'), note: '', demo: 'basic' },
    { id: uid(), taskId: tasks[0].id, plannedMin: 45, actualMin: 30, endedAt: iso(day(-2), '21:30'), note: '中间去取了快递', demo: 'basic' },
    { id: uid(), taskId: null, plannedMin: 25, actualMin: 25, endedAt: iso(day(0), '10:20'), note: '', demo: 'basic' },
  ];

  const reviews = [
    { id: uid(), date: ymd(day(-2)), taskId: tasks[0].id, plannedMin: 45, actualMin: 30, blocker: '课后题第 3 题卡住，反复看例题', nextStep: '明天只做第 3、4 题，先写条件再写循环', createdAt: new Date().toISOString(), demo: 'basic' },
  ];

  const reminders = [
    {
      id: uid(), kind: 'custom', refId: null, title: '起来倒杯水，顺便看看窗外',
      body: '坐着超过 90 分钟就动一下，这是给身体的小休。',
      at: Date.now() + 45 * 60 * 1000, status: 'active', firedAt: null, snoozeUntil: null, skipDate: null,
      createdAt: new Date().toISOString(), demo: 'basic',
    },
  ];

  // 一条「今天早上已经结束、还没做」的计划 + 一条昨天没做完的：让「今天的计划 → 没做完」和「重拾行动」在示例里一进来就有东西可点
  const plans = [
    { id: uid(), taskId: tasks[0].id, title: '高数：把第一章课后题前 5 题做完', date: ymd(day(0)), start: '07:00', min: 30, status: 'scheduled', statusAt: null, source: 'rule', basis: '优先级「优先」第 1 位；赶在截止前；今天的空闲段，避开课程、午休晚餐与已保存计划', createdAt: new Date().toISOString(), demo: 'basic' },
    { id: uid(), taskId: tasks[3].id, title: '编译原理：读讲义第 2 节', date: ymd(day(-1)), start: '19:00', min: 40, status: 'scheduled', statusAt: null, source: 'rule', basis: '优先级「随缘」第 2 位；避开课程、午休晚餐的空闲段', createdAt: new Date().toISOString(), demo: 'basic' },
  ];

  return { courses, tasks, plans, sessions, reviews, reminders, goals: [], settings: { termStart: ymd(mon) } };
}

// ---------- 场景包 ----------
// 为什么不是只给一份通用示例：期末周、考研、课设、毕设这四段是大学生真的会崩的地方，
// 节奏、任务粒度、目标周期完全不同；一个空的起点看不出这个工具替你做什么。
// 每个包都带一段「过去的专注记录」，让历史校准和预算一进来就有东西可算。
// 这些行一律带 demo 标记：界面会写清楚这条建议是从示例记录算出来的，还是从你自己的记录算出来的。
export const SCENARIOS = [
  { id: 'finals', label: '期末周', desc: '5 门课挤在 9 天里，靠每天摊开而不是通宵' },
  { id: 'kaoyan', label: '考研冲刺', desc: '12 周的长目标，每天量不大但不能断' },
  { id: 'design', label: '课程设计周', desc: '一门课的大作业，交付日卡死' },
  { id: 'thesis', label: '毕业设计', desc: '文献、实验、初稿三段并行，周期最长' },
];

function scenarioData(id) {
  const mon = mondayOf();
  const mkCourse = (name, dayIdx, start, end, location) => ({
    id: uid(), name, day: dayIdx, start, end, location, teacher: '',
    weekStart: 1, weekEnd: 16, parity: 'all', createdAt: new Date().toISOString(), demo: id,
  });
  const mkGoal = (title, note, dueOffset, estMin, extra = {}) => ({
    id: uid(), title, note, subject: extra.subject || '',
    dueAt: dueOffset === null ? '' : iso(day(dueOffset), '23:59'),
    estMin, status: extra.status || 'active', doneAt: extra.doneAt || null,
    createdAt: iso(day(-21), '09:00'), demo: id,
    ...(extra.stages ? { stages: extra.stages.map((s) => ({ id: uid(), title: s.title, note: s.note || '' })) } : {}),
  });
  const mkTask = (title, dueOffset, hhmm, estMin, priority, goalId, subject, extra = {}) => ({
    id: uid(), title, dueAt: iso(day(dueOffset), hhmm), estMin, priority,
    status: 'pending', note: '', subject, goalId: goalId || null,
    createdAt: iso(day(dueOffset - 3), '20:00'), demo: id, ...extra,
  });
  // 过去的专注记录：plannedMin 是你当时估的，actualMin 是真做了多久
  const mkSession = (taskId, plannedMin, actualMin, dayOffset, hhmm, note = '') => ({
    id: uid(), taskId, plannedMin, actualMin, endedAt: iso(day(dayOffset), hhmm), note: '', demo: id,
  });

  if (id === 'finals') {
    const goals = [mkGoal('期末周：5 门课过一遍，不挂科', '范围就是这 5 份往年题 + 讲义；不做额外预习', 9, 640)];
    const tasks = [
      mkTask('高数：往年题 3 套，只做提高题以外的', 2, '22:00', 150, 'high', goals[0].id, '高等数学'),
      mkTask('数据结构：图与树的遍历手写一遍', 4, '22:00', 120, 'high', goals[0].id, '数据结构'),
      mkTask('概率论：把 6 类题型各挑 2 题', 6, '22:00', 130, 'medium', goals[0].id, '概率论'),
      mkTask('英语：作文背 2 个模板并默写一次', 7, '21:00', 60, 'medium', goals[0].id, '大学英语'),
      mkTask('思想政治：只背 5 个大题框架', 8, '22:30', 90, 'low', goals[0].id, '思想政治'),
      mkTask('把这周错题重做（只挑 6 道）', 8, '23:00', 90, 'medium', goals[0].id, '复盘'),
    ];
    const sessions = [
      mkSession(tasks[0].id, 45, 62, -6, '21:10'), mkSession(tasks[0].id, 45, 55, -4, '20:50'),
      mkSession(tasks[1].id, 40, 58, -3, '22:20'), mkSession(tasks[2].id, 30, 34, -2, '19:40'),
      mkSession(tasks[2].id, 30, 47, -1, '21:30'), mkSession(null, 25, 22, -5, '16:20'),
      mkSession(tasks[3].id, 25, 40, -1, '23:10'),
    ];
    return {
      courses: [
        mkCourse('高等数学', 1, '08:00', '09:40', '教一 301'),
        mkCourse('数据结构复习课', 2, '10:00', '11:40', '教三 110'),
        mkCourse('概率论', 3, '14:00', '15:40', '教一 305'),
        mkCourse('思想政治', 4, '08:00', '09:40', '图书馆报告厅'),
      ],
      tasks, goals,
      plans: [],
      sessions,
      reviews: [
        { id: uid(), date: ymd(day(-1)), taskId: tasks[0].id, plannedMin: 75, actualMin: 117, blocker: '中值定理那两道一直回去翻例题', nextStep: '明天先把定理条件抄一遍，再做题', createdAt: iso(day(-1), '23:30'), demo: id },
      ],
      reminders: [],
      settings: { termStart: ymd(mon), dailyCapMin: 180, lunchStart: '12:00', lunchEnd: '13:30' },
    };
  }

  if (id === 'kaoyan') {
    const goals = [
      mkGoal('考研数学：1000 题基础篇过完', '按章节走，每天一小块，进度看题数不看时长', 45, 900, {
        stages: [
          { title: '极限与连续', note: '先把这一章的过关卡清，再往后走' },
          { title: '导数与微分' },
          { title: '积分与级数' },
        ],
      }),
      mkGoal('考研英语：背完高频词 + 精读 20 篇', '每天 25 分钟，断了就接着走，不补', 60, 600, { subject: '英语' }),
    ];
    const tasks = [
      mkTask('数学：极限章节 40 题（做不完也先记题号）', 1, '22:00', 90, 'high', goals[0].id, '考研数学', { stageId: goals[0].stages[0].id }),
      mkTask('数学：导数章节 40 题', 3, '22:00', 90, 'high', goals[0].id, '考研数学', { stageId: goals[0].stages[1].id }),
      mkTask('英语：高频词 100 个（只看不背也行）', 0, '21:00', 25, 'medium', goals[1].id, '考研英语'),
      mkTask('英语：精读 1 篇，只拆长难句', 2, '20:00', 35, 'medium', goals[1].id, '考研英语'),
      mkTask('专业课：把参考书第 3 章框架抄成一页', 5, '22:30', 70, 'medium', null, '专业课'),
      { ...mkTask('数学：上周错题重做 12 题', -1, '21:00', 60, 'high', goals[0].id, '考研数学', { stageId: goals[0].stages[0].id }), status: 'done', doneAt: iso(day(-1), '21:50') },
    ];
    const sessions = [
      mkSession(tasks[5].id, 60, 82, -1, '21:50', '中间被打断两次'),
      mkSession(tasks[0].id, 90, 105, -2, '22:10'), mkSession(tasks[2].id, 25, 27, -3, '21:20'),
      mkSession(tasks[3].id, 35, 52, -4, '20:40'), mkSession(tasks[1].id, 90, 96, -5, '22:00'),
      mkSession(tasks[2].id, 25, 30, -6, '21:15'), mkSession(null, 45, 20, -7, '15:30', '状态不好，只做了一小半'),
    ];
    return {
      courses: [
        mkCourse('专业课（上）', 1, '10:00', '11:40', '教二 210'),
        mkCourse('英语精读', 3, '08:00', '09:40', '外语楼 202'),
      ],
      tasks, goals, plans: [], sessions,
      reviews: [
        { id: uid(), date: ymd(day(-2)), taskId: tasks[0].id, plannedMin: 90, actualMin: 105, blocker: '第 27 题卡了 20 分钟', nextStep: '先把同类型 3 题连着做，别跳着做', createdAt: iso(day(-2), '22:20'), demo: id },
      ],
      reminders: [],
      settings: { termStart: ymd(mon), dailyCapMin: 210 },
    };
  }

  if (id === 'design') {
    const goals = [mkGoal('课程设计：做一个能跑的课程表小工具并交报告', '交付 = 能演示的功能 + 3000 字报告 + 答辩 5 分钟', 6, 520)];
    const tasks = [
      mkTask('定功能清单，砍到 4 条以内', 0, '18:00', 40, 'high', goals[0].id, '课程设计'),
      mkTask('搭骨架：能新建、能列出、能存住', 1, '23:00', 120, 'high', goals[0].id, '课程设计'),
      mkTask('加导入功能（CSV 就行，别做界面花活）', 3, '23:00', 100, 'medium', goals[0].id, '课程设计'),
      mkTask('写报告前半：需求与结构图', 4, '22:00', 90, 'medium', goals[0].id, '课程设计'),
      mkTask('报告后半 + 答辩 5 分钟讲稿', 5, '22:00', 90, 'medium', goals[0].id, '课程设计'),
      mkTask('演示前自测：把功能清单逐条走一遍', 6, '12:00', 60, 'high', goals[0].id, '课程设计'),
    ];
    const sessions = [
      mkSession(tasks[0].id, 30, 45, -1, '19:20'), mkSession(tasks[1].id, 90, 140, -2, '23:30', '调 bug 调到很晚'),
      mkSession(tasks[2].id, 60, 75, -3, '22:10'), mkSession(null, 25, 30, -4, '16:00'),
    ];
    return {
      courses: [
        mkCourse('程序设计课程设计', 4, '14:00', '17:40', '机房 B203'),
        mkCourse('数据结构', 3, '14:00', '15:40', '教三 110'),
      ],
      tasks, goals, plans: [], sessions,
      reviews: [
        { id: uid(), date: ymd(day(-2)), taskId: tasks[1].id, plannedMin: 90, actualMin: 140, blocker: '存数据那块反复返工', nextStep: '先定死一个最小格式再写代码', createdAt: iso(day(-2), '23:40'), demo: id },
      ],
      reminders: [],
      settings: { termStart: ymd(mon), dailyCapMin: 240 },
    };
  }

  // thesis
  const goals = [
    mkGoal('毕设：文献综述 8000 字读完并做笔记', '只读与选题直接相关的 25 篇，其余先不碰', 30, 700, {
      stages: [
        { title: '精读与笔记', note: '每篇只记方法与结论' },
        { title: '综述大纲' },
        { title: '综述成稿' },
      ],
    }),
    mkGoal('毕设：实验跑完并整理成图表', '实验部分卡住就先去写综述，别硬等', 55, 900, { subject: '毕业设计（实验）' }),
    mkGoal('毕设：初稿 3 万字交导师', '初稿允许烂，先把结构写满', 75, 1200, { status: 'paused' }),
  ];
  const tasks = [
    mkTask('文献：精读 3 篇，每篇只记方法与结论', 1, '22:00', 120, 'high', goals[0].id, '毕业设计（文献）', { stageId: goals[0].stages[0].id }),
    mkTask('文献：综述大纲（一级标题就好）', 4, '22:00', 60, 'medium', goals[0].id, '毕业设计（文献）', { stageId: goals[0].stages[1].id }),
    mkTask('实验：把采集脚本跑通一次', 3, '18:00', 150, 'high', goals[1].id, '毕业设计（实验）'),
    mkTask('实验：整理第一批数据成 2 张图', 8, '22:00', 100, 'medium', goals[1].id, '毕业设计（实验）'),
    mkTask('初稿：先把目录和方法章节的骨架写满', 12, '22:00', 90, 'low', goals[2].id, '毕业设计（写作）'),
    { ...mkTask('文献：读完前 5 篇的摘要', -2, '21:00', 60, 'medium', goals[0].id, '毕业设计（文献）', { stageId: goals[0].stages[0].id }), status: 'done', doneAt: iso(day(-2), '21:55') },
  ];
  const sessions = [
    mkSession(tasks[5].id, 60, 55, -2, '21:55'), mkSession(tasks[0].id, 120, 150, -3, '23:00', '参考文献格式反复改'),
    mkSession(tasks[2].id, 90, 130, -5, '20:30'), mkSession(null, 30, 35, -7, '15:20'),
    mkSession(tasks[3].id, 45, 30, -9, '19:30', '状态一般'),
  ];
  return {
    courses: [
      mkCourse('毕业设计（中期检查）', 2, '14:00', '16:40', '实验楼 305'),
      mkCourse('专业课（最后两节）', 5, '10:00', '11:40', '教二 118'),
    ],
    tasks, goals, plans: [], sessions,
    reviews: [
      { id: uid(), date: ymd(day(-3)), taskId: tasks[0].id, plannedMin: 120, actualMin: 150, blocker: '参考文献格式反复改，正文没推进', nextStep: '格式最后统一处理，读的时候只记方法与结论', createdAt: iso(day(-3), '23:10'), demo: id },
    ],
    reminders: [],
    settings: { termStart: ymd(mon), dailyCapMin: 240 },
  };
}

/** 示例数据的落库也是一个跨集合事务：替换模式下不能先删后写、写到一半留下半份示例。 */
async function writeSamplePack(data, mode, packId) {
  const names = ['courses', 'tasks', 'plans', 'sessions', 'reviews', 'reminders', 'goals'];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let t, written = false;
    try { t = db.transaction(names, 'readwrite'); }
    catch (err) { reject(err); return; }
    t.onerror = () => reject(t.error || new Error('示例数据没写完，原有数据没有变化'));
    t.onabort = () => reject(t.error || new Error('示例数据写入被中断，原有数据没有变化'));
    t.oncomplete = () => resolve(written);
    const write = () => {
      try {
        for (const s of names) {
          const os = t.objectStore(s);
          if (mode === 'replace') os.clear();
          for (const row of data[s] || []) os.put(row);
        }
        written = true;
      } catch (err) {
        try { t.abort(); } catch { /* 已经自己断了 */ }
        reject(err);
      }
    };
    if (mode === 'replace') { write(); return; }
    // 检查和写入共用读写事务，连续点击或多个标签页也只加入一次。
    // 识别旧版本的 demo 标记，保留用户已经修改过的示例和所有真实数据。
    let remaining = names.length, exists = false;
    for (const s of names) {
      const req = t.objectStore(s).getAll();
      req.onsuccess = () => {
        exists ||= req.result.some((row) => row.demo === packId);
        if (--remaining === 0 && !exists) write();
      };
    }
  });
}

export async function loadSample(mode = 'merge', packId = 'basic') {
  packId ||= 'basic';
  if (packId !== 'basic' && !SCENARIOS.some((pack) => pack.id === packId)) throw new Error('没有找到这个示例场景');
  const data = packId !== 'basic' ? scenarioData(packId) : sampleData();
  if (!(await writeSamplePack(data, mode, packId))) return { alreadyLoaded: true, settingsError: null };
  // 合并模式只补一个空的学期起始日，绝不覆盖用户已经调好的每日上限/作息；
  // 替换模式才按示例包设置走。设置写失败不回滚已经写入的数据，但要把原因带回去让界面说清楚。
  let settingsError = null;
  try {
    if (mode === 'replace') saveSettings(data.settings);
    else if (!settings().termStart && data.settings?.termStart) saveSettings({ termStart: data.settings.termStart });
  } catch (err) { settingsError = (err && err.message) || '设置写不进去'; }
  return { ...data, settingsError };
}

export async function isEmpty() {
  return (await count('courses')) === 0 && (await count('tasks')) === 0;
}
