// 设置：学期与作息参数、数据备份（导出/导入/清空）、能力与隐私边界说明
import * as db from '../store.js';
import { state, refreshData } from '../state.js';
import { h, icon, clear, toast, selectEl, openSheet, confirmSheet, download, ymd, DOW } from '../ui.js';
import { changed } from '../forms.js';
import { syncDerived, reconcileNative } from '../remind.js';
import { hasNativeReminder, dataPlace } from '../native.js';
import { openNotice } from '../notice.js';
import { MODES, getMode, setMode, theme, onTheme } from '../theme.js';
import { goPage, syncDock } from '../app.js';
import { pageAside, factsCard, quoteCard } from '../aside.js';

// 「外观」这一档不写 IndexedDB：它和「使用须知」的确认一样，是设备内的偏好，
// 只存本机 localStorage，导出的 JSON 里没有它，也不需要它跟着数据跑。
let offTheme = null;
const appearanceGroup = () => {
  const cur = getMode();
  const live = h('p', { class: 'hint' });
  const say = () => {
    const m = getMode();
    live.textContent = m === 'system'
      ? `跟随系统：操作系统现在是${theme() === 'light' ? '浅色' : '深色'}，页面就跟到那一档。`
      : `已固定为${theme() === 'light' ? '浅色' : '深色'}，不跟系统走。`;
  };
  const row = h('div', {});
  for (const [value, label] of MODES) {
    const id = `theme-mode-${value}`;
    const radio = h('input', { type: 'radio', name: 'theme-mode', id, value, checked: cur === value });
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const t = setMode(value);
      say();
      toast('外观已换档', `现在是${t === 'light' ? '浅色' : '深色'}。这个选择只存在本机：不进数据库，也不在导出的 JSON 里。`);
    });
    row.append(h('div', { class: 'radio-line' }, radio, h('label', { for: id, text: label })));
  }
  say();
  if (offTheme) offTheme();
  offTheme = onTheme(say);
  return h('div', { class: 'set-group' },
    h('h4', { text: '外观' }),
    row,
    live,
    h('p', { class: 'hint', text: '两档是同一套界面：浅色那档换成近中性浅灰蓝底、只在屏幕顶部留一点天蓝光晕，去掉星点与玻璃模糊，字色、强调色与版式档位两档共用。' }),
  );
};

// 两列窄格里带单位的标签最容易被折进括号里（「…（小 / 时）」），单位整体不拆，要换行就换到括号前。
const fieldLabel = (label) => {
  const m = /^(.*?)(（[^）]*）)$/.exec(label);
  return m ? h('label', {}, m[1], h('span', { class: 'nw', text: m[2] })) : h('label', { text: label });
};
const num = (label, key, { min = 0, max = 999, step = 1, hint = '' } = {}) => {
  const input = h('input', { type: 'number', min, max, step, value: state.settings[key], 'aria-label': label });
  const errorId = `settings-${key}-error`;
  const error = h('p', { class: 'field-error', id: errorId, role: 'status' });
  input.setAttribute('aria-describedby', errorId);
  const wrap = h('div', { class: 'field' }, fieldLabel(label), input, error, hint ? h('p', { class: 'hint', text: hint }) : null);
  input.addEventListener('input', () => { error.textContent = ''; });
  input.addEventListener('change', () => {
    const v = input.valueAsNumber;
    if (!Number.isFinite(v) || v < min || v > max) {
      input.value = state.settings[key];
      error.textContent = `请输入 ${min} 到 ${max} 之间的数值，已恢复为 ${input.value}。`;
      return;
    }
    error.textContent = '';
    db.saveSettings({ [key]: v });
    state.settings = db.settings();
    changed('settings');
  });
  return wrap;
};
const time = (label, key) => {
  const input = h('input', { type: 'time', value: state.settings[key], 'aria-label': label, step: 300 });
  input.addEventListener('change', () => {
    db.saveSettings({ [key]: input.value });
    state.settings = db.settings();
    changed('settings');
  });
  return h('div', { class: 'field' }, fieldLabel(label), input);
};

async function exportJson(withChat = false) {
  const payload = await db.exportAll({ withChat });
  const counts = Object.fromEntries(Object.entries(payload).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
  const chatMsgs = (payload.chat || []).reduce((n, r) => n + r.value.length, 0);
  download(`星迹备份-${ymd(new Date())}.json`, JSON.stringify(payload, null, 2));
  toast('已导出备份', `课程 ${counts.courses || 0} · 任务 ${counts.tasks || 0} · 计划 ${counts.plans || 0} · 专注 ${counts.sessions || 0} · 复盘 ${counts.reviews || 0} · 目标 ${counts.goals || 0}${withChat ? ` · 聊天记录 ${chatMsgs} 条` : ' · 未含聊天记录'}`);
}

async function importFlow(file) {
  // 大文件先在门口挡住：JSON.parse 与预览都会把整份内容放进内存，太大时页面会直接卡死
  if (file.size > 25 * 1024 * 1024) {
    toast('文件太大', '备份超过 25 MB，已停止导入；请确认选的是本项目导出的 JSON。', 'bad');
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    toast('文件读不了', '请确认是本项目导出的 JSON 备份。', 'bad');
    return;
  }
  let preview;
  try {
    preview = await db.importPreview(payload);
  } catch (e) {
    toast('导入已停止', e.message, 'bad');
    return;
  }
  const modeSel = selectEl([
    { value: 'merge', label: '合并（同 id 覆盖，其他保留）' },
    { value: 'replace', label: '替换（先清空这些集合再写入）' },
  ], 'merge', { 'aria-label': '导入方式' });
  const api = openSheet({
    title: '确认导入备份',
    wide: true,
    content: h('div', {},
      h('p', { class: 'hint', text: '导入前先看这份清单。选「替换」会清空对应集合，请确认你已经导出了当前数据。' }),
      h('div', { class: 'check-list' }, ...preview.collections.map((c) => h('div', { class: 'check-row' },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: `${LABEL[c.name] || c.name}` }),
          h('div', { class: 'row-meta' },
            h('span', { class: 'tag', text: `文件里 ${c.incoming} 条` }),
            h('span', { class: 'tag', text: `当前 ${c.current} 条` }),
            modeSel.value === 'replace' && c.current > 0 ? h('span', { class: 'tag bad', text: '会被清空' }) : null,
          ),
        ),
      )),
        preview.chat ? h('div', { class: 'check-row' },
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title', text: 'AI 聊天记录' }),
            h('div', { class: 'row-meta' },
              h('span', { class: 'tag', text: `文件里 ${preview.chat.incoming} 条` }),
              h('span', { class: 'tag', text: `当前 ${preview.chat.current} 条` }),
              modeSel.value === 'replace' && preview.chat.current > 0 ? h('span', { class: 'tag bad', text: '会被替换' }) : null,
            ),
          )) : null,
      ),
      h('div', { class: 'field' }, h('label', { text: '导入方式' }), modeSel),
      preview.settings ? h('p', { class: 'note', text: '这个备份文件里包含设置项（学期起始日、午休晚餐、铃声等），导入时会一并覆盖。' }) : h('p', { class: 'hint', text: '这个备份文件没有设置项，只导入数据。' }),
    ),
    actions: [
      h('button', { class: 'btn', onclick: () => api.close(), text: '取消' }),
      h('button', {
        class: 'btn btn-primary', text: '确认导入',
        onclick: async () => {
          let res;
          try { res = await db.importApply(payload, modeSel.value); }
          catch (e) {
            toast('导入失败', (e && e.message) || '文件没有写进去，原有数据没有变化。', 'bad');
            return;
          }
          api.close();
          await refreshData();
          await syncDerived();
          changed('import');
          const warn = res.settingsError ? ` 设置项没有写进去（${res.settingsError}），数据已导入。` : '';
          toast('导入完成', `${res.collections.map((c) => LABEL[c] || c).join('、')} 已写入${res.chatAgents.length ? `，聊天记录（${res.chatAgents.length} 位助手）也一起恢复` : ''}。${warn}`);
        },
      }),
    ],
  });
  modeSel.addEventListener('change', () => {
    const rows = api.sheet.querySelectorAll('.check-row .row-meta');
    rows.forEach((el) => {
      const cur = Number((el.children[1]?.textContent || '').match(/\d+/)?.[0] ?? 0);
      const warn = el.querySelector('.tag.bad');
      if (modeSel.value === 'replace' && cur > 0 && !warn) el.append(h('span', { class: 'tag bad', text: '会被清空' }));
      if (modeSel.value === 'merge' && warn) warn.remove();
    });
  });
}
const LABEL = { courses: '课程', tasks: '任务', plans: '计划', sessions: '专注记录', reviews: '复盘', reminders: '提醒' };

/** AI 接入卡片：只读状态，不接受任何密钥；接口地址可改是为了本地联调 */
/**
 * AI 能看什么：关掉的那一类不会进请求体，服务端函数只会看到「学生没有共享这一类」。
 * privacy 是整体对象写入，因为 saveSettings 只做浅合并。
 */
const PRIVACY_ITEMS = [
  {
    key: 'courses',
    label: '课表（课程名、星期、时间、教室、老师）',
    hint: '关掉后规划助手不知道你哪天几点有课，只能按你口头说的排；它给的时段也没法和你真实的课比对冲突。',
  },
  {
    key: 'tasks',
    label: '任务与计划（标题、截止时间、预计与已投入分钟）',
    hint: '关掉后助手看不到待办和已排好的安排，提案更依赖你自己描述，也更容易被判成信息不足而不给保存。',
  },
  {
    key: 'focus',
    label: '近 7 天专注（每天几次、计划与实际分钟）',
    hint: '关掉后助手不知道你这周真正投了多少时间，不会主动按疲劳程度把任务变小。',
  },
  {
    key: 'peer',
    label: '两个助手之间的对话互通（最近若干条）',
    hint: '默认关闭。打开后「心事树洞」里说的话会进入规划助手的提示词，反过来也一样；两边的聊天记录本身都还在本机，这个开关只决定发出去的那份快照里带不带。',
  },
];

function privacyCard() {
  const save = (patch) => {
    db.saveSettings({ privacy: { ...state.settings.privacy, ...patch } });
    state.settings = db.settings();
    const on = Object.keys(state.settings.privacy).filter((k) => state.settings.privacy[k] === true);
    toast('共享范围已改', on.length === PRIVACY_ITEMS.length
      ? '四类本机数据都允许共享。'
      : `现在只共享：${PRIVACY_ITEMS.filter((x) => on.includes(x.key)).map((x) => x.label.split('（')[0]).join('、') || '一样都不共享'}。下一句话就按这个来。`);
  };
  return h('div', { class: 'card' },
    h('h3', { text: 'AI 能看什么' }),
    h('p', { class: 'hint', text: '发送消息时，服务端会收到近期对话，以及作息、记录条数、提醒计数等概况。下面四个开关控制课表、任务等详情和另一位助手的近期对话。关闭开关后，对应详情不会随请求发送。' }),
    h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => openNotice(), text: '查看使用须知' }),
    ...PRIVACY_ITEMS.map((it) => {
      const id = `pv-switch-${it.key}`;
      const cb = h('input', { type: 'checkbox', id, checked: state.settings.privacy[it.key] === true });
      cb.addEventListener('change', async () => {
        // 跨助手这一档默认关着，打开前把「打开后会带走什么」说一遍：
        // 另一边可能是心事树洞里的话，这类内容不该被一次顺手滑动静默共享出去。
        if (it.key === 'peer' && cb.checked) {
          const ok = await confirmSheet({
            title: '打开跨助手共享？',
            message: '打开后，下一句话发给规划小助时会附上「心事树洞」最近若干条对话原文，反过来也一样。它的作用是让规划助手知道你最近状态如何，从而把安排放轻一点。\n\n只想让两位助手各管各的，就保持关闭；聊天记录仍保存在本机，发送消息时只附带另一位助手的近期对话。',
            confirmText: '我了解，打开',
          });
          if (!ok) { cb.checked = false; return; }
        }
        save({ [it.key]: cb.checked });
      });
      return h('div', { class: 'set-group' },
        h('div', { class: 'switch' }, cb, h('label', { for: id, text: it.label })),
        h('p', { class: 'hint', text: it.hint }),
      );
    }),
    h('p', { class: 'hint', text: '无论开关怎么设：高风险消息由服务端单独接住，不靠模型自觉；写进本机的动作仍然要你逐条确认。' }),
  );
}

// 停靠栏是布局偏好，跟数据一起存（导出的 JSON 里带它）；外观三档才是只存本机的设备偏好
const dockGroup = () => {
  const id = 'dock-switch';
  const cb = h('input', { type: 'checkbox', id, checked: state.settings.dockEnabled === true });
  cb.addEventListener('change', () => {
    db.saveSettings({ dockEnabled: cb.checked });
    state.settings = db.settings();
    syncDock();
    toast(cb.checked ? '停靠栏已打开' : '停靠栏已收起',
      cb.checked ? '宽屏底部多一排悬浮入口，左导航仍然在。' : '桌面只留左导航和首页入口，少一层重复。');
  });
  return h('div', { class: 'set-group' },
    h('h4', { text: '桌面停靠栏' }),
    h('div', { class: 'switch' }, cb, h('label', { for: id, text: '在宽屏底部显示悬浮停靠栏' })),
    h('p', { class: 'hint', text: '默认关：左侧导航已经覆盖全部页面，停靠栏是可选的第二排入口。只在宽屏出现，手机端不受影响。' }),
  );
};

let section = null;
// 离开设置页就回到分节列表：下次进来从顶端开始，不会困在上次打开的小节里
window.addEventListener('hashchange', () => {
  if (!String(location.hash).startsWith('#settings')) section = null;
});

const SECTIONS = [
  ['term', '学期与课表', '起始周与时间轴范围'],
  ['day', '作息与排程', '午休、晚餐、每日学习上限'],
  ['look', '外观', '深色 / 浅色 / 跟随系统'],
  ['remind', '提醒', '提前分钟；铃声与权限在提醒页'],
  ['data', '数据与备份', '导出 / 导入 / 示例数据 / 清空'],
  ['privacy', '隐私与服务边界', 'AI 能看什么、数据存在哪'],
  ['about', '版本与能力', '这个版本有什么、没有什么'],
];
const SET_ICONS = { term: 'calendar', day: 'clock', look: 'star', remind: 'bell', data: 'inbox', privacy: 'gear', about: 'book' };

export async function render(root) {
  clear(root);
  const s = state.settings;
  const nat = hasNativeReminder();
  const term = h('input', { type: 'date', value: s.termStart || '', 'aria-label': '学期起始日' });
  term.addEventListener('change', async () => {
    db.saveSettings({ termStart: term.value });
    state.settings = db.settings();
    await syncDerived();
    changed('settings');
    toast(term.value ? '已设置学期起始日' : '已清除学期起始日', term.value ? '单双周与周次按这一周推算。' : '没有起始日时无法判断单双周。');
  });
  const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': '选择备份文件' });
  const chatBox = h('input', { type: 'checkbox', checked: true, 'aria-label': '备份里带上两位助手的聊天记录' });
  file.addEventListener('change', () => { if (file.files?.[0]) importFlow(file.files[0]); });
  const counts = {};
  for (const name of ['courses', 'tasks', 'plans', 'sessions', 'reviews', 'reminders']) counts[name] = (await db.list(name)).length;

  const termCard = () => h('div', { class: 'card' },
    h('div', { class: 'set-group' },
      h('h4', { text: '学期与课表' }),
      h('div', { class: 'field' }, h('label', { text: '学期第 1 周的周一' }), term,
        h('p', { class: 'hint', text: '用于推算周次和单双周。课程表页也能改。' })),
      h('div', { class: 'field-row' },
        num('时间轴起点（小时）', 'axisStart', { min: 5, max: 12 }),
        num('时间轴终点（小时）', 'axisEnd', { min: 13, max: 24 }),
      )));

  const dayCard = () => h('div', { class: 'card' },
    h('div', { class: 'set-group' },
      h('h4', { text: '作息（排程会避开这些时段）' }),
      h('div', { class: 'field-row' }, time('午休开始', 'lunchStart'), time('午休结束', 'lunchEnd')),
      h('div', { class: 'field-row' }, time('晚餐开始', 'dinnerStart'), time('晚餐结束', 'dinnerEnd')),
      num('每天最多安排学习（分钟）', 'dailyCapMin', { min: 30, max: 720, step: 10, hint: '超过这个上限，计划页会说「放不下」而不是硬塞。' })));

  const remindCard = () => h('div', { class: 'card' },
    h('div', { class: 'set-group' },
      h('h4', { text: '提醒' }),
      h('div', { class: 'field-row' },
        num('任务到期前提醒（分钟）', 'taskLeadMin', { min: 0, max: 180, step: 5 }),
        num('上课前提醒（分钟）', 'courseLeadMin', { min: 0, max: 120, step: 5 }),
      ),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-sm', onclick: () => goPage('reminders'), text: '去提醒页设置铃声、静音时段与权限' }))));

  const dataCard = () => h('div', { class: 'card' },
    h('div', { class: 'set-group' },
      h('h4', { text: '当前数据（本机浏览器）' }),
      ...Object.entries(counts).map(([k, v]) => h('div', { class: 'kv' }, h('b', { text: LABEL[k] }), h('span', { text: `${v} 条` }))),
    ),
    h('div', { class: 'set-group' },
      h('h4', { text: '备份与恢复' }),
      h('div', { class: 'check-row' }, chatBox,
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: '备份里带上两位助手的聊天记录' }),
          h('div', { class: 'row-meta', text: '聊天记录存在本机的 meta 集合里，默认不带就走不掉。勾上之后，换浏览器或换设备导入时对话能一起回来；对话原文也会写进这份 JSON，别把它发给别人。' }))),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-sm', onclick: () => exportJson(chatBox.checked) }, icon('inbox'), h('span', { text: '导出 JSON 备份' })),
        file,
      ),
      h('p', { class: 'hint', text: '导入前会显示「文件里多少条 / 当前多少条」的清单，并让你选合并或替换；不会静默覆盖。导入在一个事务里完成，中途出错整笔回滚，不会留下写了一半的数据。' }),
    ),
    h('div', { class: 'set-group' },
      h('h4', { text: '示例数据' }),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn btn-sm', text: '加载示例数据（合并）',
          onclick: async () => {
            try {
              const res = await db.loadSample('merge');
              await refreshData();
              await syncDerived();
              changed('sample');
              toast(res.alreadyLoaded ? '示例数据已经加入过了' : '已加入示例数据', res.alreadyLoaded ? '保留现有记录，不会重复添加。' : res.settingsError ? `原有数据保留；设置项没写进去（${res.settingsError}）。` : '原有数据保留，设置没有被覆盖。');
            } catch (e) { toast('示例数据没加载完', (e && e.message) || '这台设备的存储写不进去，原有数据没有变化。', 'bad'); }
          },
        }),
        h('button', {
          class: 'btn btn-sm btn-danger', text: '用示例数据替换全部',
          onclick: async () => {
            const ok = await confirmSheet({ title: '替换全部数据', message: '会清空课程、任务、计划、专注、复盘、提醒、目标，然后写入示例数据。', confirmText: '清空并写入', danger: true });
            if (!ok) return;
            try {
              const res = await db.loadSample('replace');
              await refreshData();
              await syncDerived();
              changed('sample');
              toast('已写入示例数据', res.settingsError ? `设置项没写进去（${res.settingsError}）。` : '');
            } catch (e) { toast('替换没完成', (e && e.message) || '写入失败，原有数据没有变化。', 'bad'); }
          },
        }),
      ),
      h('div', { class: 'btn-row', style: 'margin-top:8px' },
        ...db.SCENARIOS.map((pack) => h('button', {
          class: 'btn btn-sm', text: `场景包：${pack.label}`,
          title: pack.desc,
          onclick: async () => {
            const had = state.courses.length + state.tasks.length + state.goals.length;
            if (had) {
              const ok = await confirmSheet({ title: `合并加入「${pack.label}」`, message: `这台设备上已经有数据（课程 ${state.courses.length} 门、任务 ${state.tasks.length} 条、目标 ${state.goals.length} 个）。\n\n场景包只往里加，不删除、不覆盖；它带来的记录会标成「示例」，统计口径里会分开说明其中多少来自示例。`, confirmText: '合并加入' });
              if (!ok) return;
            }
            try {
              const res = await db.loadSample('merge', pack.id);
              await refreshData();
              await syncDerived();
              changed('scenario');
              toast(res.alreadyLoaded ? `「${pack.label}」已经加入过了` : `已加入「${pack.label}」`, res.alreadyLoaded ? '保留现有记录，不会重复添加。' : res.settingsError ? `设置项没写进去（${res.settingsError}）。` : '这些记录带「示例」标记，目标页和今日页会写明其中多少来自示例数据。');
            } catch (e) { toast('场景包没加载完', (e && e.message) || '写入失败，原有数据没有变化。', 'bad'); }
          },
        })),
      ),
      h('p', { class: 'hint', text: '四个场景包各带一份课表、几条任务、一个目标和一段过去的专注记录，用来试「摊到每一天」和时长建议。它们和你自己的记录在同一台设备的同一个库里，靠 demo 标记区分；不想留就逐条删，或者用上面的清空。' }),
    ),
    h('div', { class: 'set-group' },
      h('h4', { text: '危险区域' }),
      h('button', {
        class: 'btn btn-sm btn-danger', text: '清空本机所有数据',
        onclick: async () => {
          const ok = await confirmSheet({ title: '清空全部数据', message: '课程、任务、计划、专注记录、复盘、提醒、目标和设置都会删除，无法恢复。建议先导出一份 JSON 备份。', confirmText: '我确定，清空', danger: true });
          if (!ok) return;
          let res;
          try { res = await db.wipeAll(); }
          catch (e) { toast('没清空', (e && e.message) || '这台设备的存储写不进去，数据没有变化。', 'bad'); return; }
          state.courses = []; state.tasks = []; state.plans = []; state.sessions = []; state.reviews = []; state.reminders = []; state.goals = [];
          state.settings = db.settings();
          await reconcileNative(true);
          changed('wipe');
          toast('已清空', res.settingsCleared ? '现在可以从首页重新加载示例数据。' : '数据已清空，但设置没移除（本机存储只读）。');
        },
      }),
    ));

  const aboutCard = () => h('div', { class: 'card' },
    h('h3', { text: '这个版本有什么、没有什么' }),
    h('div', { class: 'grid grid-2' },
      h('div', {},
        h('h4', { style: 'font-size:var(--fs-3);margin:0 0 6px;color:var(--ink-on-ok)', text: '有' }),
        h('ul', { style: 'margin:0;padding-left:18px;color:var(--ink-soft);font-size:var(--fs-3);line-height:1.7' },
          h('li', { text: '课程表（按周翻页、单双周、起止周、时间轴可调、重叠并排）' }),
          h('li', { text: 'CSV / TSV 批量导入，导入前有核对清单' }),
          h('li', { text: '任务的增删改、完成、推迟' }),
          h('li', { text: '日历同屏显示课程 + 计划 + 任务，点日期看当天' }),
          h('li', { text: '计划条目三态：计划中 / 已完成 / 已跳过，可随时手动改，完成或跳过的时间会重新空出来' }),
          h('li', { text: '本地规则排程：找空闲、查冲突、放不下会说明，先预览后保存，可撤销；排程按「预计 − 已投入」的剩余时间排' }),
          h('li', { text: '专注计时（含全屏、提前结束并记录），记录可关联计划条目和任务，事后还能修改或删除' }),
          h('li', { text: '任务显示「已投入 X / 预计 Y 分钟」，超出预计标注已超时，不会出现负数' }),
          h('li', { text: '复盘：单日与近 7 天的预计 vs 实际、计划完成数与完成率，并写明统计口径' }),
          h('li', { text: nat ? 'App 内提醒：站内弹窗 + 铃声，同时把没到点的提醒登记进系统闹钟（AlarmManager），到点由系统发通知栏消息；App 退到桌面、屏幕熄灭时仍然会响。注意：把 App 从最近任务划掉后，这台 vivo 实测会把待触闹钟冻结掉、到点不响，重新打开 App 才会重排' : '网页提醒：站内弹窗 + 铃声 + 系统通知（按浏览器真实能力）' }),
          h('li', { text: '两个独立 AI 角色：规划小助（学习与工作规划，提案由程序查课程/午休/晚餐/已有计划冲突，冲突或信息不足不给保存，写入逐条确认、以本机返回结果为准）与心事树洞（学习心态教练，服务端与本机都不允许它写日历或任务）；各自的聊天记录分开放在本机，切换角色不丢；需要服务端配好密钥才真的回答' }),
          h('li', { text: '「AI 能看什么」四个开关：关闭开关会移除对应的详情，记录条数等概况仍随请求发送；高风险（自伤等）消息由服务端函数按关键词初步筛查单独处理，不调用模型，也不只靠提示词' }),
          h('li', { text: 'JSON 导出 / 导入备份' }),
        ),
      ),
      h('div', {},
        h('h4', { style: 'font-size:var(--fs-3);margin:0 0 6px;color:var(--ink-on-danger)', text: nat ? '没有（按这个 App 的真实边界）' : '没有（按静态网页的边界）' }),
        h('ul', { style: 'margin:0;padding-left:18px;color:var(--ink-soft);font-size:var(--fs-3);line-height:1.7' },
          h('li', { text: '没有真实电话、短信和手机号，也没有图片识别课表的入口——识别服务没接上，就不摆个假按钮。' }),
          nat
            ? h('li', { text: '没有账号、云端和同步：App 这份库和手机浏览器里那份各存各的，谁也不覆盖谁。' })
            : h('li', { text: '没有账号、云端和同步：这些数据的唯一存放位置是本机浏览器。' }),
          h('li', { text: '计划页和复盘页的建议仍是规则生成，页面上标着「规则生成 · 未调用 AI」。' }),
          nat
            ? h('li', { text: '不保证静音、免打扰和厂商省电策略下还能准点响：闹钟交给系统调度，实测结论写在须知第 4 条。' })
            : h('li', { text: '不保证关机或关掉网页后还能响：浏览器做不到，提醒只在页面开着时有效。' }),
          h('li', { text: '两位助手的其余限制——AI 会看到什么、心态方面接不住什么、密钥和费用——都集中在一份须知里，不在各页重复。' }),
        ),
        h('div', { class: 'btn-row', style: 'margin-top:10px' },
          h('button', { class: 'btn btn-sm', onclick: () => openNotice({ expanded: true }), text: '打开完整使用须知' }),
        ),
      ),
    ),
    h('p', {
      class: 'hint',
      text: nat
        ? `数据存储：App 本机存储 —— IndexedDB「xingji-studyhack」+ localStorage「xj-settings」（使用须知的确认状态另记在「xj-notice-ack」），另外交给系统闹钟的那几条存在 App 私有的 SharedPreferences「xj-native-reminders」里（只在这台手机的 App 私有目录，不写外部存储、不上传）。卸载 App 或在系统里「清除数据」会一起清掉。`
        : `数据存储：IndexedDB「xingji-studyhack」+ localStorage「xj-settings」（使用须知的确认状态另记在「xj-notice-ack」）。清除浏览器站点数据会一起清掉。`,
    }),
  );

  if (!section) {
    root.append(
      h('div', { class: 'page-head' },
        h('h2', { class: 'page-title', text: '设置' }),
        h('p', { class: 'page-sub', text: `学习记录保存在${dataPlace()}里。AI 请求的数据范围见「隐私与服务边界」。` })),
      h('div', { class: 'more-groups' },
        h('section', { class: 'more-group' },
          h('div', { class: 'more-list' },
            ...SECTIONS.map(([id, label, desc]) => h('button', {
              type: 'button', class: 'more-item', dataset: { section: id }, onclick: () => { section = id; render(root); },
            }, h('span', { class: 'more-ico' }, icon(SET_ICONS[id])),
               h('span', { class: 'row-main' }, h('b', { text: label }), h('small', { text: desc })),
               h('span', { class: 'more-go' }, icon('right'))))))),
      pageAside(factsCard(), quoteCard('存储与边界', [
        '学习记录保存在本机。AI 请求可发送近期对话和获准共享的学习数据，应用没有账号或云端同步。',
        '清除浏览器站点数据会一起清掉；换设备要用「数据与备份」里的导出 / 导入。',
        '使用须知的确认状态也在这台设备上，不进导出的 JSON。',
      ])),
    );
    return;
  }
  const cur = SECTIONS.find((x) => x[0] === section);
  const body = section === 'term' ? termCard()
    : section === 'day' ? dayCard()
    : section === 'look' ? h('div', { class: 'card' }, appearanceGroup(), dockGroup())
    : section === 'remind' ? remindCard()
    : section === 'data' ? dataCard()
    : section === 'privacy' ? h('div', {}, privacyCard())
    : aboutCard();
  root.append(
    h('div', { class: 'page-head' },
      h('div', { class: 'btn-row', style: 'margin-bottom:4px' },
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { section = null; render(root); }, text: '‹ 返回设置' }),
        h('b', { style: 'font-size:var(--fs-4)', text: cur ? cur[1] : '设置' })),
      h('h2', { class: 'page-title', text: cur ? cur[1] : '设置' }),
    ),
    body,
  );
}
