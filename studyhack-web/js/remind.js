// 电脑端网页提醒：只用浏览器真实具备的能力（绝对时间戳轮询 + WebAudio 铃声 + 通知 API）。
// 明确不承诺：关闭网页、电脑休眠、后台标签被冻结、系统静音/免打扰时能准点响铃。
// 在 App（Capacitor 壳）里额外走一条原生通道：到点由系统闹钟发通知，页面冻没冻结都照发，见 native.js。
import * as db from './store.js';
import { state, effectiveTasks } from './state.js';
import { h, icon, openSheet, toast, fmtDayTime, relTime, ymd, parseLocal } from './ui.js';
import { hasNativeReminder, nativeSync, nativeCancel } from './native.js';

// ---------- 内置铃声（WebAudio 合成，不依赖任何音频文件） ----------
const BELLS = {
  ding: { desc: '单声「叮」（最轻）', notes: [[880, 0, 0.9]] },
  triad: { desc: '三音上行 · 推荐', notes: [[659, 0, 0.35], [784, 0.36, 0.35], [1046, 0.72, 0.7]] },
  chime: { desc: '四音铃铛（最响）', notes: [[523, 0, 0.3], [659, 0.28, 0.3], [784, 0.56, 0.3], [1046, 0.84, 0.6]] },
  none: { desc: '静音（只显示提示）', notes: [] },
};
export const BELL_OPTIONS = Object.entries(BELLS).map(([value, v]) => ({ value, label: v.desc }));

let audioCtx = null;
export function audioUnlocked() {
  return !!(audioCtx && audioCtx.state === 'running');
}
export async function ensureCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('这个浏览器不支持 WebAudio，无法播放铃声');
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state !== 'running') await audioCtx.resume();
  return audioCtx;
}
/** 在用户手势里播放一次；返回 {ok, reason} */
export async function playBell(name = state.settings.bell, { volume } = {}) {
  const s = state.settings;
  const bell = BELLS[name] || BELLS.triad;
  if (!bell.notes.length) return { ok: true, silent: true };
  const vol = volume ?? s.volume;
  try {
    const ctx = await ensureCtx();
    const t0 = ctx.currentTime + 0.02;
    for (const [freq, offset, dur] of bell.notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + offset);
      gain.gain.linearRampToValueAtTime(Math.max(0.001, vol * 0.5), t0 + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + offset + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + dur + 0.05);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message || '浏览器阻止了声音' };
  }
}
export function audition(name) {
  return playBell(name).then((r) => {
    if (!r.ok) toast('浏览器阻止了声音', '请点击「试听铃声」重新授权，并检查系统音量与免打扰。', 'warn');
    else if (r.silent) toast('当前选择的是静音', '只会显示站内提示和系统通知。');
    else toast('试听成功', '如果没听到，请检查系统音量、浏览器标签页是否被静音。');
    return r;
  });
}

// ---------- 通知权限（只在用户主动点击时申请） ----------
export const notifySupported = 'Notification' in window;
export const notifyPermission = () => (notifySupported ? Notification.permission : 'unsupported');
export async function requestNotify() {
  if (!notifySupported) return 'unsupported';
  try {
    const p = await Notification.requestPermission();
    return p;
  } catch {
    return Notification.permission;
  }
}
function systemNotify(title, body, tag) {
  if (!notifySupported || Notification.permission !== 'granted') return false;
  try {
    const n = new Notification(title, { body, tag, silent: true });
    setTimeout(() => { try { n.close(); } catch { /* 忽略 */ } }, 90000);
    return true;
  } catch {
    return false;
  }
}

// ---------- 静音时段 ----------
export function inQuietHours(d = new Date(), s = state.settings) {
  if (!s.quietEnabled) return false;
  const cur = d.getHours() * 60 + d.getMinutes();
  const from = parseHM(s.quietFrom), to = parseHM(s.quietTo);
  if (from === to) return false;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}
const parseHM = (hhmm) => { const [a, b] = String(hhmm || '0:0').split(':').map(Number); return (a || 0) * 60 + (b || 0); };

// ---------- 原生通道：只在 App 里工作，网页端这些函数全是空转 ----------
let nativeFp = null;
let nativeLastResult = null;
export const nativeLast = () => nativeLastResult;

/**
 * 把本机「开着提醒 + 还没到点」的清单整份同步给系统闹钟。
 * 用内容指纹去重：课表/任务改一次就重排一次，纯粹刷新页面不会重复申请。
 * id 用派生提醒的 key（课程/任务变了 key 才变），这样同一节课改时间也能对上同一条闹钟。
 */
export async function reconcileNative(force = false) {
  if (!hasNativeReminder()) return null;
  const on = !!state.settings.remindersEnabled;
  const items = on
    ? state.reminders
        .filter((r) => r.status === 'active' && r.at > Date.now())
        .map((r) => ({ id: r.key || r.id, title: r.title, body: r.body, at: r.at }))
    : [];
  const fp = items.map((i) => `${i.id}@${i.at}@${i.title}@${i.body || ''}`).sort().join('|');
  if (!force && nativeFp === fp) return nativeLastResult;
  nativeFp = fp;
  nativeLastResult = await nativeSync(items);
  return nativeLastResult;
}

// ---------- 由课表 / 任务派生的提醒 ----------
function keyOf(kind, refId, originAt) { return `${kind}|${refId}|${originAt}`; }

let derivedSync = Promise.resolve();
export function syncDerived(dateStr = ymd(new Date())) {
  const run = derivedSync.catch(() => {}).then(() => syncDerivedNow(dateStr));
  derivedSync = run;
  return run;
}

async function syncDerivedNow(dateStr) {
  const s = state.settings;
  const muted = s.mutedKinds || [];
  const want = [];
  const mk = (kind, refId, at, title, body) => {
    if (at == null || !Number.isFinite(at)) return;
    if (muted.includes(kind)) return;
    want.push({ kind, refId, at, originAt: at, title, body });
  };
  // 课程：今天与明天的课
  for (const c of state.courses) {
    for (const ds of [dateStr, nextDay(dateStr)]) {
      if (!courseOnDate(c, ds)) continue;
      const base = new Date(`${ds}T00:00:00`);
      const [hh, mm] = c.start.split(':').map(Number);
      base.setHours(hh, mm - (Number(s.courseLeadMin) || 0));
      mk('course', c.id, base.getTime(), `${c.name} 快上课了`, `${ds === dateStr ? '今天' : '明天'} ${c.start} 在 ${c.location || '地点未填'}。提前动身。`);
    }
  }
  // 任务：到期前提醒
  for (const t of effectiveTasks()) {
    if (t.status === 'done' || !t.dueAt) continue;
    const ms = parseLocal(t.dueAt);
    if (ms === null) continue;
    const at = ms - (Number(s.taskLeadMin) || 0) * 60000;
    mk('task', t.id, at, `任务：${t.title}`, `截止时间 ${fmtDayTime(t.dueAt)}。做不到全部就先做一小步。`);
  }
  const existing = state.reminders.filter((r) => r.kind === 'course' || r.kind === 'task');
  const byKey = new Map(existing.map((r) => [r.key, r]));
  const wantKeys = new Set(want.map((w) => keyOf(w.kind, w.refId, w.originAt)));

  const toAdd = [];
  for (const w of want) {
    const k = keyOf(w.kind, w.refId, w.originAt);
    if (byKey.has(k)) continue;
    toAdd.push({
      id: db.uid(), key: k, kind: w.kind, refId: w.refId, title: w.title, body: w.body,
      at: w.at, originAt: w.originAt, status: w.at < Date.now() ? 'missed' : 'active',
      firedAt: null, snoozeCount: 0, skipDate: null, createdAt: new Date().toISOString(),
    });
  }
  // 源数据已删除/改期/已静音 → 清掉还没响的派生提醒
  const toDel = existing.filter((r) => !wantKeys.has(r.key) && (r.status === 'active' || r.status === 'missed'));
  for (const r of toDel) { await db.del('reminders', r.id); }
  if (toAdd.length) {
    await db.bulkPut('reminders', toAdd);
    state.reminders = [...state.reminders, ...toAdd];
  }
  for (const r of toDel) state.reminders = state.reminders.filter((x) => x.id !== r.id);
  await reconcileNative();
  return { added: toAdd.length, removed: toDel.length };
}

/** 任务/课程变化后，把已派生但仍 active 的提醒同步到新时间 */
export async function resyncTask(task) {
  const related = state.reminders.filter((r) => r.kind === 'task' && r.refId === task.id && r.status === 'active');
  for (const r of related) { await db.del('reminders', r.id); }
  state.reminders = state.reminders.filter((r) => !related.includes(r));
  await syncDerived();
}

function nextDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + 1);
  return ymd(d);
}
function courseOnDate(c, dateStr) {
  const dow = ((new Date(`${dateStr}T12:00:00`).getDay() + 6) % 7) + 1;
  if (Number(c.day) !== dow) return false;
  const week = weekNum(dateStr);
  const s = Number(c.weekStart) || 1, e = Number(c.weekEnd) || 25;
  if (week !== null && (week < s || week > e)) return false;
  const parity = c.parity || 'all';
  if (week !== null && parity !== 'all') {
    const same = (week - s) % 2 === 0;
    if (parity === 'odd' && !same) return false;
    if (parity === 'even' && same) return false;
  }
  return true;
}
function weekNum(dateStr) {
  const ts = state.settings.termStart;
  if (!ts) return null;
  const a = new Date(`${dateStr}T12:00:00`), b = new Date(`${ts}T12:00:00`);
  const mon = (x) => { const d = new Date(x); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(0, 0, 0, 0); return d; };
  return Math.round((mon(a) - mon(b)) / (7 * 864e5)) + 1;
}

// ---------- 触发引擎 ----------
let timer = null;
const queue = [];
let showModal = false;

export function startEngine() {
  stopEngine();
  markMissed();
  timer = setInterval(tick, 15000);
  document.addEventListener('visibilitychange', onVisible);
  tick();
  // App 里同时把清单交给系统闹钟：网页引擎会被冻结，闹钟不会。
  if (hasNativeReminder()) Promise.resolve(reconcileNative(true)).catch(() => { /* 提醒页会显示具体原因 */ });
}
export function stopEngine() {
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisible);
}
function onVisible() {
  if (document.visibilityState === 'visible') tick();
}

/** 打开页面时：把已经过期但还没响的提醒标成「已错过」，不补响 */
export async function markMissed() {
  const now = Date.now();
  const changed = [];
  for (const r of state.reminders) {
    if (r.status === 'active' && r.at < now) { r.status = 'missed'; r.missedAt = now; changed.push(r); }
  }
  if (!changed.length) return;
  try {
    // 一批写进同一个事务，并且等它真的落盘再报「已错过」
    await db.bulkPut('reminders', changed);
  } catch (e) {
    // 没写进去就把状态还原：不然库里还是 active，下次打开又报一遍同样的错过
    for (const r of changed) { r.status = 'active'; delete r.missedAt; }
    return;
  }
  toast(`有 ${changed.length} 条提醒已错过`, '没有补响，避免一次弹出很多条。可在提醒页重新安排。', 'warn');
  // 重复提醒错过了也要滚到下一轮，否则「每天」在没开页面那天就断了
  for (const r of changed) if (r.repeat && r.repeat !== 'none') advanceRepeat(r).catch(() => {});
}

async function tick() {
  const now = Date.now();
  for (const r of state.reminders) {
    if (r.status === 'active' && r.at <= now) await fire(r);
  }
  if (queue.length && !showModal) drain();
}

async function fire(r) {
  r.status = 'fired';
  r.firedAt = Date.now();
  await db.put('reminders', r);
  const s = state.settings;
  const quiet = inQuietHours(new Date(), s);
  queue.push(r);
  if (s.notifyOnly || quiet) {
    /* 静音时段或「仅显示通知」时不播放声音 */
  } else {
    const res = await playBell(s.bell);
    if (!res.ok) r.audioError = res.reason;
  }
  // App 里系统闹钟已经发过一条同内容的通知，这里再发一条就是重复骚扰，只留站内弹窗和铃声。
  if (!hasNativeReminder()) systemNotify(r.title, r.body, r.id);
  if (quiet) toast('静音时段：本次没有播放声音', `${s.quietFrom}–${s.quietTo} 之间只显示提示。`, 'warn');
  drain();
}
function drain() {
  if (showModal || !queue.length) return;
  const r = queue.shift();
  showModal = true;
  openFireSheet(r, () => { showModal = false; setTimeout(() => drain(), 350); });
}

export function nextUp() {
  const now = Date.now();
  return state.reminders
    .filter((r) => r.status === 'active' && r.at > now)
    .sort((a, b) => a.at - b.at)[0] || null;
}
export const pendingCount = () => state.reminders.filter((r) => r.status === 'active').length;
export const missedCount = () => state.reminders.filter((r) => r.status === 'missed').length;

// ---------- 到点弹窗：完成 / 稍后 5·10·30 / 今天跳过 / 关闭此类提醒 ----------
function openFireSheet(r, onClosed) {
  const isTask = r.kind === 'task';
  const close = () => { sheet.close(); onClosed?.(); };
  const act = async (fn) => { await fn(); close(); };

  const buttons = [
    h('button', {
      class: 'btn btn-primary',
      onclick: () => act(async () => {
        r.status = 'done'; await db.put('reminders', r);
        await reconcileNative();
        if (isTask) {
          const t = state.tasks.find((x) => x.id === r.refId);
          if (t && t.status !== 'done') {
            t.status = 'done'; t.doneAt = new Date().toISOString();
            await db.put('tasks', t);
          }
        }
        toast('已完成', isTask ? '任务已标记为做完。' : '这条提醒收下了。');
        document.dispatchEvent(new CustomEvent('xj:changed', { detail: { reason: 'reminder-done' } }));
      }),
    }, icon('check'), h('span', { text: isTask ? '完成（任务标记已做）' : '完成' })),
  ];
  for (const m of [5, 10, 30]) {
    buttons.push(h('button', {
      class: 'btn',
      onclick: () => act(async () => {
        r.at = Date.now() + m * 60000;
        r.status = 'active';
        r.snoozeCount = (r.snoozeCount || 0) + 1;
        await db.put('reminders', r);
        await reconcileNative();
        toast(`已推迟 ${m} 分钟`, `${fmtDayTime(r.at)} 会再提醒你一次。`);
      }),
    }, h('span', { text: `稍后 ${m} 分钟` })));
  }
  buttons.push(h('button', {
    class: 'btn',
    onclick: () => act(async () => {
      r.status = 'skipped';
      r.skipDate = ymd(new Date());
      await db.put('reminders', r);
      await reconcileNative();
      toast('今天跳过', '明天同一时间还会正常提醒。');
    }),
  }, h('span', { text: '今天跳过' })));
  buttons.push(h('button', {
    class: 'btn btn-ghost',
    onclick: () => act(async () => {
      const s = db.saveSettings({ mutedKinds: [...new Set([...(state.settings.mutedKinds || []), r.kind])] });
      state.settings = s;
      r.status = 'closed';
      await db.put('reminders', r);
      await reconcileNative();
      toast('已关闭此类提醒', `${kindLabel(r.kind)}类提醒不再弹出。可在「设置 → 提醒」里重新打开。`);
    }),
  }, h('span', { text: '关闭此类提醒' })));

  const sheet = openSheet({
    title: r.title,
    content: h('div', { class: 'fire-body' },
      h('p', { text: r.body || '' }),
      h('p', { class: 'hint', text: `计划时间 ${fmtDayTime(r.at)} · ${relTime(r.at)} · ${kindLabel(r.kind)}` }),
      r.audioError ? h('p', { class: 'warn-bar', text: `浏览器阻止了声音：${r.audioError}。请点击「试听铃声」并检查系统音量。` }) : null,
    ),
    actions: buttons,
    dismissible: true,
    // 完成 / 跳过 / 直接关掉弹窗都算这一轮处理完，重复提醒滚下一次；
    // 「稍后」是 active、「关闭此类」是 closed，都不滚。
    onClose: () => {
      if (['fired', 'done', 'skipped'].includes(r.status)) advanceRepeat(r).catch(() => {});
    },
  });
  sheet.mask.addEventListener('click', (e) => { if (e.target === sheet.mask) close(); });
  return sheet;
}

export const kindLabel = (k) => ({ course: '上课', task: '任务', custom: '自定义', snooze: '推迟' }[k] || k);

// ---------- 重复提醒（自定义提醒专用） ----------
export const REPEAT_LABEL = { none: '不重复', daily: '每天', weekly: '每周' };
function nextRepeatAt(baseAt, repeat) {
  if (repeat !== 'daily' && repeat !== 'weekly') return null;
  const step = repeat === 'daily' ? 1 : 7;
  let t = new Date(baseAt).getTime();
  const now = Date.now();
  // 页面关着的时候可能错过好几轮：一次推进到最近一个还没到的点
  for (let i = 0; i < 500 && t <= now; i++) {
    const n = new Date(t);
    n.setDate(n.getDate() + step);
    t = n.getTime();
  }
  return t > now ? t : null;
}
/** 重复提醒滚到下一次：这一轮留在历史里，另开一条 active。 */
export async function advanceRepeat(r) {
  if (!r || !r.repeat || r.repeat === 'none') return;
  const nextAt = nextRepeatAt(r.originAt || r.at, r.repeat);
  if (!nextAt) return;
  const clone = {
    ...r, id: db.uid(), key: keyOf('custom', 'manual', nextAt),
    at: nextAt, originAt: nextAt, status: 'active',
    firedAt: null, missedAt: null, snoozeCount: 0, skipDate: null,
    createdAt: new Date().toISOString(),
  };
  await db.put('reminders', clone);
  state.reminders.push(clone);
  await reconcileNative();
}

/** 自定义提醒（用户手动加的），kind=custom */
export async function addCustom({ title, body, at, repeat = 'none' }) {
  const r = {
    id: db.uid(), key: keyOf('custom', 'manual', at), kind: 'custom', refId: null,
    title, body: body || '', at, originAt: at, status: at < Date.now() ? 'missed' : 'active',
    repeat: REPEAT_LABEL[repeat] ? repeat : 'none',
    firedAt: null, snoozeCount: 0, skipDate: null, createdAt: new Date().toISOString(),
  };
  await db.put('reminders', r);
  state.reminders.push(r);
  await reconcileNative();
  return r;
}

export const WEB_LIMITS = [
  '提醒只在「这个网页开着」的时候有效。关闭标签页、电脑休眠、浏览器被系统冻结后台时，无法准点响铃。',
  '切到别的标签页、按 Home 退回桌面或锁屏时，这个页面会停掉计时器；回到前台才重新开始，期间到点的按「已错过」处理。',
  '计时是每 15 秒轮询一次，到点和实际弹出之间可能有十几秒误差。',
  '手机浏览器（Chrome、Safari 以及各家国产浏览器）的后台省电与冻结策略由系统决定，网页绕不过去；需要准点提醒请让页面保持在前台。本页不做真实电话或短信提醒。',
  '声音受系统音量、标签页静音、系统免打扰控制，网页不能突破这些限制，也不会像系统闹钟那样强制响铃。',
  '第一次必须由你点「试听铃声」，浏览器才允许网页发声；也必须点「开启网页提醒」才会申请系统通知权限。',
  '重新打开网页后，错过的提醒会标成「已错过」，不会一次性补响。',
];

// App 版多了系统闹钟，边界和网页版不一样，分开写而不是套用同一份文案。
export const NATIVE_LIMITS = [
  'App 版到点交给系统闹钟（AlarmManager）：App 退到桌面、屏幕熄灭时，闹钟仍在系统排期里，到点由系统唤醒并发通知栏消息。这是和网页版最实质的区别。',
  '但「把 App 从最近任务里划掉」不等于到点还会响。2026-11-05 在 vivo V2408A（Android 16）真机实测：划掉任务的那一刻，系统把这台机器上登记的 8 条待触闹钟全部标记为 frozen 移除，到点没有唤醒、进程没重启、通知栏没有任何记录；重新打开 App 才会按当前清单重排，已经过点的不补响。',
  '前提是「通知」权限给到，Android 12+ 还要「精确闹钟」权限。上面那台真机两项都没给：通知处于 importance=NONE，闹钟到点把 App 唤醒了、notify() 也被系统丢弃，所以看不到通知。没给精确闹钟时系统会把提醒合并到附近的批量唤醒点，可能早也可能晚几分钟，状态卡会写明当前是不是精确调度。',
  '厂商（vivo / OPPO / 小米 / 华为）另有自己的后台冻结与省电策略，不归标准 API 管，也可能直接清掉待触闹钟。上面那条划掉实验就是这个策略的结果，不是本 App 能绕开的。',
  '通知的声音、震动、横幅由系统通知渠道和免打扰决定，App 突破不了静音键与免打扰，也不会像系统时钟那样强制响铃。',
  '重启手机后原来登记的闹钟会全部失效，App 靠开机自启重新排一遍还没到点的；没开这个权限时，重启后需要打开一次 App 才会重新排程。已过点的同样不补响。',
  'App 不做真实电话或短信提醒。',
  'App 里存的课程/任务/计划和你手机浏览器里那份是两套独立存储，不会自动同步；要挪数据请用设置里的导出/导入。',
];

export const limitText = () => (hasNativeReminder() ? NATIVE_LIMITS : WEB_LIMITS);
