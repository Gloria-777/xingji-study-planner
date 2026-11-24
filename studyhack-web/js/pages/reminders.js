// 提醒：网页提醒开关、铃声与通知授权、静音时段、今日/未来/已错过列表
import * as db from '../store.js';
import { state } from '../state.js';
import { h, icon, clear, put, toast, selectEl, openSheet, fmtDateTime, fmtDayTime, relTime, parseLocal, ymd, pad2 } from '../ui.js';
import {
  BELL_OPTIONS, audition, notifyPermission, notifySupported, requestNotify,
  addCustom, syncDerived, inQuietHours, kindLabel, limitText, pendingCount, missedCount, nextUp,
  startEngine, stopEngine, reconcileNative, nativeLast, REPEAT_LABEL, advanceRepeat,
} from '../remind.js';
import { hasNativeReminder, nativeStatus, requestNativeNotifications, nativeRing, openNativeSettings } from '../native.js';
import { changed } from '../forms.js';

let toggleSeq = 0;
function toggle(label, checked, onChange, hint) {
  const id = `rem-switch-${(toggleSeq += 1)}`;
  const cb = h('input', { type: 'checkbox', id, checked });
  cb.addEventListener('change', () => onChange(cb.checked));
  return h('div', { class: 'field' },
    h('div', { class: 'switch' }, cb, h('label', { for: id, text: label })),
    hint ? h('p', { class: 'hint', text: hint }) : null,
  );
}

async function rerender() {
  await refresh();
  changed('reminder');
}
async function refresh() {
  const rows = await db.list('reminders');
  state.reminders = rows;
  // 列表一刷新就顺手把系统闹钟对齐到当前状态（推迟/跳过/删除都会走到这里）
  await reconcileNative();
}

function statusTag(r) {
  const map = {
    active: ['tag', '待提醒'], fired: ['tag ok', '已提醒'], missed: ['tag bad', '已错过'],
    skipped: ['tag warn', '今天跳过'], done: ['tag ok', '已完成'], closed: ['tag', '已关闭此类'], snoozed: ['tag', '已推迟'],
  };
  const [cls, text] = map[r.status] || ['tag', r.status];
  return h('span', { class: cls, text });
}

function reminderRow(r) {
  const ops = [];
  if (r.status === 'active') {
    for (const m of [5, 10, 30]) {
      ops.push(h('button', {
        class: 'btn btn-sm', text: `+${m}分`, title: `推迟 ${m} 分钟`,
        onclick: async () => { r.at = Date.now() + m * 60000; r.snoozeCount = (r.snoozeCount || 0) + 1; await db.put('reminders', r); await rerender(); },
      }));
    }
    ops.push(h('button', {
      class: 'btn btn-sm', text: '跳过今天',
      onclick: async () => {
        r.status = 'skipped'; r.skipDate = ymd(new Date());
        await db.put('reminders', r);
        if (r.repeat && r.repeat !== 'none') await advanceRepeat(r);
        await rerender();
      },
    }));
    ops.push(h('button', {
      class: 'btn btn-sm', text: '完成',
      onclick: async () => {
        r.status = 'done';
        await db.put('reminders', r);
        if (r.repeat && r.repeat !== 'none') await advanceRepeat(r);
        await rerender();
      },
    }));
  }
  if (r.status === 'missed') {
    ops.push(h('button', {
      class: 'btn btn-sm btn-primary', text: '安排到 15 分钟后',
      onclick: async () => {
        r.at = Date.now() + 15 * 60000; r.status = 'active'; r.originAt = r.at; r.key = `${r.kind}|${r.refId || 'manual'}|${r.originAt}`;
        await db.put('reminders', r);
        await syncDerived();
        await rerender();
        toast('已重新安排', `${fmtDayTime(r.at)} 会提醒你。`);
      },
    }));
  }
  ops.push(h('button', {
    class: 'icon-btn', title: '删除这条提醒', 'aria-label': '删除这条提醒',
    onclick: async () => { await db.del('reminders', r.id); await rerender(); },
  }, icon('trash')));

  return h('div', { class: 'row' },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title', text: r.title }),
      h('div', { class: 'row-meta' },
        statusTag(r),
        h('span', { class: 'tag', text: kindLabel(r.kind) }),
        r.repeat && r.repeat !== 'none' ? h('span', { class: 'tag', text: REPEAT_LABEL[r.repeat] }) : null,
        h('span', { text: `${fmtDateTime(r.at)} · ${relTime(r.at)}` }),
        r.snoozeCount ? h('span', { class: 'tag warn', text: `已推迟 ${r.snoozeCount} 次` }) : null,
      ),
      r.body ? h('div', { class: 'row-meta', text: r.body }) : null,
    ),
    h('div', { class: 'row-ops' }, ...ops),
  );
}

function newCustomSheet() {
  const fTitle = h('input', { type: 'text', maxlength: 40, placeholder: '例：起来走 5 分钟', dataset: { autofocus: '' }, 'aria-label': '提醒内容' });
  const fWhen = h('input', { type: 'datetime-local', value: `${ymd(new Date())}T${pad2(Math.min(23, new Date().getHours() + 1))}:00`, 'aria-label': '提醒时间' });
  const fRepeat = selectEl([
    { value: 'none', label: '不重复' },
    { value: 'daily', label: '每天同一时间' },
    { value: 'weekly', label: '每周同一天' },
  ], 'none', { 'aria-label': '重复' });
  const fBody = h('input', { type: 'text', maxlength: 80, placeholder: '补充一句（选填）', 'aria-label': '补充说明' });
  const api = openSheet({
    title: '新建一条网页提醒',
    content: h('div', {},
      h('p', { class: 'hint', text: '按绝对时间戳判断到期。只有这个网页开着才会响；错过的会标成「已错过」，不会补响。' }),
      h('p', { class: 'hint', text: '设成每天/每周后，到点处理完（完成、跳过或直接关掉弹窗）会自动排下一次；在 App 里，后续那条要等下次打开 App 才会重新排进系统闹钟。' }),
      h('div', { class: 'field' }, h('label', { text: '提醒什么' }), fTitle),
      h('div', { class: 'field' }, h('label', { text: '什么时候' }), fWhen),
      h('div', { class: 'field' }, h('label', { text: '重复' }), fRepeat),
      h('div', { class: 'field' }, h('label', { text: '补充（选填）' }), fBody),
    ),
    actions: [
      h('button', { class: 'btn', onclick: () => api.close(), text: '取消' }),
      h('button', {
        class: 'btn btn-primary', text: '保存',
        onclick: async () => {
          const title = fTitle.value.trim();
          const at = parseLocal(fWhen.value);
          const repeat = fRepeat.value || 'none';
          if (!title) { toast('写点内容', '总得告诉未来的你做什么。', 'bad'); return; }
          if (!at) { toast('时间不对', '请选择日期和时间。', 'bad'); return; }
          await addCustom({ title, body: fBody.value.trim(), at, repeat });
          api.close();
          await rerender();
          toast(at > Date.now() ? '提醒已设置' : '这条时间已经过了',
            at > Date.now()
              ? `${fmtDateTime(at)} 会提示你${repeat !== 'none' ? `，${REPEAT_LABEL[repeat]}重复` : ''}。`
              : '已标成「已错过」，可以重新安排。');
        },
      }),
    ],
  });
}

// 通知权限被拒 / 不支持时的恢复指引：权限由浏览器记住，页面代码改不了，只能给准确的操作路径
function permHelpCard(perm, onRecheck) {
  const denied = perm === 'denied';
  const origin = location.origin && location.origin !== 'null' ? location.origin : '本地文件（file://，通知权限基本不可用）';
  const steps = [
    'Chrome / Edge：点地址栏最左边那个图标 → 「网站设置」→ 找到「通知」→ 改成「自动允许此网站发送通知」或「允许」。',
    '或者直接打开地址栏输入 chrome://settings/content/notifications（Edge 是 edge://settings/content/notifications），在「阻止」列表里找到这个地址，删除或改成允许。',
    'Firefox：点地址栏左边的权限图标 → 「编辑权限」→ 改为「允许」，或者「清除设置」后重新申请；也可以在 about:preferences#privacy 的通知区域移除本站点。',
    'Safari：菜单栏 Safari → 设置 → 网站 → 通知，选中这个地址改成「允许」。',
    '改完一般不用重启浏览器，但多数版本需要刷新本页才会重新读到新权限。',
  ];
  return h('div', { class: 'card' },
    h('h3', {},
      h('span', { text: denied ? '系统通知被拒绝了，怎么改回来' : '这个浏览器不支持系统通知' }),
      h('span', { class: 'tag warn', style: 'margin-left:8px', text: denied ? `当前地址：${origin}` : '与代码无关' }),
    ),
    h('p', {
      class: 'hint',
      text: denied
        ? `这个地址的通知权限现在是 denied。浏览器一旦记住「阻止」，页面里再点多少次「申请通知」都不会弹窗，也不会报错——所以点了按钮没反应不是坏了。要恢复只能到浏览器自己的站点设置里改。`
        : '当前环境没有暴露 Notification 接口（常见于隐私模式、某些精简内核，或 file:// 打开）。提醒引擎不依赖它，站内提示和铃声照常工作。',
    }),
    denied ? h('ol', { style: 'margin:8px 0 0;padding-left:22px;color:var(--ink-soft);font-size:var(--fs-3);line-height:1.75' },
      ...steps.map((t) => h('li', { text: t }))) : null,
    h('p', { class: 'note muted', text: '权限一直改不过来也不影响使用：网页开着的时候，站内提示、铃声、顶部的待响计数都照常；只是不会在浏览器外面弹系统通知，也不会在关掉页面后叫醒你（这一点任何网页都做不到）。' }),
    h('div', { class: 'btn-row', style: 'margin-top:10px' },
      h('button', { class: 'btn btn-primary', onclick: () => onRecheck(), text: '我改完了，重新检查权限' }),
      h('button', { class: 'btn', onclick: () => audition(), text: '先试听铃声' }),
    ),
  );
}

// App 版独有的系统状态卡：这几项是系统权限，页面只能读状态 + 跳到对应设置页，不能替用户打开。
function nativeCard(st) {
  if (!st) {
    return h('div', { class: 'card' },
      h('h3', { text: 'App 原生提醒状态' }),
      h('p', { class: 'hint', text: '读不到系统侧的原生提醒模块，说明当前不是 App 环境或插件没装好；这时提醒仍然走网页那套（页面开着才有效）。' }),
    );
  }
  const last = nativeLast();
  const yesNo = (v) => (v ? '是' : '否');
  const row = (k, v, cls) => h('div', { class: 'kv' }, h('b', { text: k }), h('span', { class: cls || '', text: v }));
  const openBtn = (which, text) => h('button', {
    class: 'btn btn-sm', text,
    onclick: async () => {
      const r = await openNativeSettings(which);
      toast(r && r.opened ? `已打开${text.replace('打开', '')}` : '这个系统页面打不开', (r && r.opened) ? '在系统里改完回到 App，本页状态会跟着变。' : (r && r.reason) || '机型没有提供这个入口。');
    },
  });
  return h('div', { class: 'card' },
    h('h3', {}, h('span', { text: 'App 原生提醒状态' }), h('span', { class: 'tag', style: 'margin-left:8px', text: `${st.brand} ${st.model} · Android ${st.release}` })),
    row('通知权限', st.notificationsAllowed ? '已允许（到点会在应用外面弹系统通知）' : '未允许（现在只会在 App 里面提示）', st.notificationsAllowed ? 'ok' : 'bad'),
    row('精确闹钟', st.exactAlarmsAllowed ? '已允许（按你设的时间点唤醒）' : '未允许（系统会合并到附近的唤醒点，可能晚几分钟）', st.exactAlarmsAllowed ? 'ok' : 'warn'),
    row('电池优化', st.ignoringBatteryOptimization ? '本 App 已在免优化列表' : '仍受电池优化限制', st.ignoringBatteryOptimization ? '' : 'warn'),
    row('厂商后台管控', st.vendorBackgroundManaged ? '这个机型另有私有省电策略，页面里改不了，需要去系统设置里放行' : '未见额外的厂商管控标记'),
    row('系统已登记', `${st.pendingCount} 条`),
    row('最近一次同步', last
      ? (last.ok ? `${last.count} 条已交给系统闹钟 · ${last.exact ? '精确调度' : '非精确（可能被合并延迟）'}` : `${last.count} 条成功，${(last.failed || []).length} 条没排上`)
      : '还没同步过（开启网页提醒后会自动同步）'),
    h('div', { class: 'btn-row', style: 'margin-top:10px' },
      h('button', {
        class: 'btn btn-primary', text: '申请通知权限',
        onclick: async () => {
          const r = await requestNativeNotifications();
          toast(r && r.granted ? '通知权限已允许' : '通知权限还没拿到', r && r.granted ? '现在可以试听一条真实系统通知。' : (r && (r.reason || r.message)) || '请到系统设置里手动放行。');
          await rerender();
        },
      }),
      h('button', { class: 'btn', text: '试听系统通知', onclick: async () => { const r = await nativeRing(); toast(r && r.ok ? '已发出一条系统通知' : '这条没发出去', r && r.ok ? '看通知栏；没声音请检查通知音量与免打扰。' : (r && r.reason) || '系统拒绝了这个请求。'); } }),
      openBtn('notify', '打开通知设置'),
      openBtn('exact', '打开精确闹钟设置'),
      openBtn('battery', '打开电池优化列表'),
      openBtn('app', '打开应用详情'),
    ),
    h('p', { class: 'hint', text: '上面几项都是系统持有的权限，App 只能读状态和把你送到对应设置页，不会自动替自己打开任何开关。' }),
  );
}

export async function render(root) {  clear(root); // 开关/删除提醒后页面会再 render 一次，先清空才不会和路由重绘叠成两份
  const s = state.settings;
  const perm = notifyPermission();
  const enabled = !!s.remindersEnabled;
  const quiet = inQuietHours();
  const nat = hasNativeReminder() ? await nativeStatus() : null;

  async function recheckPerm() {
    // 权限已经是 denied 时 requestPermission 不会再弹窗，直接返回 denied——这是浏览器的规则，不是代码没生效
    if (notifySupported) await requestNotify();
    const now = notifyPermission();
    changed('reminders-recheck');
    toast(
      now === 'granted' ? '系统通知已允许' : now === 'denied' ? '权限仍然是「被拒绝」' : '还没拿到系统通知权限',
      now === 'granted'
        ? '从现在起浏览器可以在页面之外弹通知了。'
        : now === 'denied'
          ? '浏览器还记着这个地址的「阻止」。按上面的步骤在站点设置里改成允许，改完刷新本页再点一次。这期间站内提示和铃声不受影响。'
          : '这个浏览器没有通知接口，用站内提示 + 铃声。',
      now === 'granted' ? '' : 'bad',
    );
  }
  const upcoming = state.reminders.filter((r) => r.status === 'active').sort((a, b) => a.at - b.at);
  const missed = state.reminders.filter((r) => r.status === 'missed').sort((a, b) => b.at - a.at);
  const history = state.reminders.filter((r) => ['fired', 'done', 'skipped', 'closed'].includes(r.status)).sort((a, b) => (b.firedAt || b.at) - (a.firedAt || a.at)).slice(0, 12);
  const nxt = nextUp();

  put(root,
    h('div', { class: 'page-head' },
      h('h2', { class: 'page-title', text: '提醒' }),
      h('p', { class: 'page-sub', text: nat ? '上课前提前提醒、任务到期前提醒，也可以自己加一条。App 到点交给系统闹钟；这台 vivo 实测划掉最近任务后闹钟会被冻结。逐条边界看下面那张卡。' : '上课前提前提醒、任务到期前提醒，也可以自己加一条。到点弹站内提示、放铃声、发系统通知（授权后）；关页或后台冻结时不提醒。逐条边界看下面那张卡。' }),
    ),
    h('section', { class: 'card reminder-status' },
      h('h3', { text: nat ? '运行环境能力状态（App）' : '浏览器能力状态' }),
      h('div', { class: 'reminder-status-rows' },
        h('div', { class: 'kv' }, h('b', { text: nat ? 'App 内提醒' : '网页提醒' }), h('span', { text: enabled ? (nat ? '已开启（站内弹窗 + 铃声；系统闹钟由原生侧登记）' : '已开启（这个标签页开着才有效）') : '未开启' })),
        nat ? null : h('div', { class: 'kv' }, h('b', { text: '系统通知权限' }), h('span', { text: { granted: '已允许', denied: '被拒绝（需在浏览器/系统设置里改）', unsupported: '这个浏览器不支持 Notification' }[perm] || '未申请（点下面的按钮才申请）' })),
        h('div', { class: 'kv' }, h('b', { text: '声音' }), h('span', { text: s.notifyOnly ? '已选择「仅显示通知」' : quiet ? `现在是静音时段（${s.quietFrom}–${s.quietTo}）` : '可播放内置铃声' })),
      ),
      h('div', { class: 'btn-row reminder-actions' },
        h('button', {
          class: `btn ${enabled ? '' : 'btn-primary'}`,
          onclick: async () => {
            if (!enabled) {
              // 按钮写着「申请通知权限」，App 里就必须真的去申请系统权限；
              // WebView 没有 window.Notification，requestNotify() 在那边是空转。
              const p = nat
                ? (await requestNativeNotifications()).granted ? 'granted' : 'denied'
                : notifySupported ? await requestNotify() : 'unsupported';
              db.saveSettings({ remindersEnabled: true });
              state.settings = db.settings();
              await syncDerived();
              startEngine();
              toast(nat ? '提醒已开启' : '网页提醒已开启', nat
                ? (p === 'granted'
                  ? '系统通知权限已拿到；系统闹钟会收下当前所有还没到点的提醒，精确闹钟授权情况看下面「App 原生提醒状态」。'
                  : '系统通知权限还没拿到，到点不会在通知栏出现。用下面「App 原生提醒状态」里的按钮申请或去系统设置放行；站内弹窗和铃声不受影响。')
                : (p === 'granted' ? '系统通知也拿到了授权。' : p === 'denied' ? '系统通知被拒绝，站内提示和铃声仍然会工作。' : '这个浏览器不支持系统通知，用站内提示。'));
            } else {
              db.saveSettings({ remindersEnabled: false });
              state.settings = db.settings();
              stopEngine();
              await reconcileNative(true);
              toast(nat ? '已关闭提醒' : '已关闭网页提醒', nat ? '站内弹窗停了，交给系统闹钟的那几条也一并撤销。' : '到点不再弹出提示。');
            }
            changed('reminders-toggle');
          },
          text: enabled ? (nat ? '关闭提醒' : '关闭网页提醒') : (nat ? '开启提醒（申请通知权限）' : '开启网页提醒（申请通知权限）'),
        }),
        h('button', {
          class: 'btn', onclick: () => audition(), text: '试听铃声（授权声音）',
        }),
        h('button', { class: 'btn btn-sm', onclick: newCustomSheet }, icon('plus'), h('span', { text: '自定义提醒' })),
      ),
      h('p', { class: 'hint', text: enabled ? `下一次提醒：${nxt ? `${fmtDateTime(nxt.at)} · ${nxt.title}` : '暂时没有待响的提醒'}` : '关闭状态下不会弹出任何提醒。' }),
    ),
    h('div', { class: 'card reminder-upcoming' },
      h('h3', { text: `待提醒（${pendingCount()}）` }),
      nxt && enabled ? h('p', { class: 'hint', text: `最近一次：${nxt.title} · ${fmtDayTime(nxt.at)}` }) : null,
      upcoming.length ? h('div', {}, ...upcoming.map(reminderRow)) : h('p', { class: 'empty', text: '没有待响的提醒。开启网页提醒后，课表和任务会自动生成。' }),
    ),
    h('section', { class: 'card reminder-settings' },
      h('h3', { text: '铃声与静音' }),
      h('div', { class: 'reminder-settings-fields' },
        h('div', { class: 'reminder-setting-group' },
          h('div', { class: 'field-row' },
            h('div', { class: 'field' }, h('label', { text: '铃声' }), (() => {
              const sel = selectEl(BELL_OPTIONS, s.bell, { 'aria-label': '选择铃声' });
              sel.addEventListener('change', async () => { db.saveSettings({ bell: sel.value }); state.settings = db.settings(); audition(sel.value); });
              return sel;
            })()),
            h('div', { class: 'field' }, h('label', { text: `音量 ${Math.round((s.volume ?? 0.6) * 100)}%` }), (() => {
              const rg = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s.volume ?? 0.6, 'aria-label': '铃声音量' });
              rg.addEventListener('input', () => { db.saveSettings({ volume: Number(rg.value) }); state.settings = db.settings(); });
              rg.addEventListener('change', () => audition());
              return rg;
            })()),
          ),
          toggle('仅显示通知，不播放声音', !!s.notifyOnly, (v) => { db.saveSettings({ notifyOnly: v }); state.settings = db.settings(); changed('settings'); }),
        ),
        h('div', { class: 'reminder-setting-group' },
          toggle('启用静音时段', !!s.quietEnabled, (v) => { db.saveSettings({ quietEnabled: v }); state.settings = db.settings(); changed('settings'); }, '静音时段内不播放声音，只保留站内提示。'),
          h('div', { class: 'field-row' },
            h('div', { class: 'field' }, h('label', { text: '静音开始' }), (() => { const t = h('input', { type: 'time', value: s.quietFrom, 'aria-label': '静音开始' }); t.addEventListener('change', () => { db.saveSettings({ quietFrom: t.value }); state.settings = db.settings(); }); return t; })()),
            h('div', { class: 'field' }, h('label', { text: '静音结束' }), (() => { const t = h('input', { type: 'time', value: s.quietTo, 'aria-label': '静音结束' }); t.addEventListener('change', () => { db.saveSettings({ quietTo: t.value }); state.settings = db.settings(); }); return t; })()),
          ),
        ),
        h('div', { class: 'reminder-setting-group' },
          h('h4', { text: '提前提醒' }),
          h('div', { class: 'field-row' },
            h('div', { class: 'field' }, h('label', { text: '任务提前几分钟提醒' }), (() => { const n = h('input', { type: 'number', min: 0, max: 180, step: 5, value: s.taskLeadMin, 'aria-label': '任务提前分钟' }); n.addEventListener('change', async () => { db.saveSettings({ taskLeadMin: Number(n.value) }); state.settings = db.settings(); await syncDerived(); changed('settings'); }); return n; })()),
            h('div', { class: 'field' }, h('label', { text: '上课前几分钟提醒' }), (() => { const n = h('input', { type: 'number', min: 0, max: 120, step: 5, value: s.courseLeadMin, 'aria-label': '上课前分钟' }); n.addEventListener('change', async () => { db.saveSettings({ courseLeadMin: Number(n.value) }); state.settings = db.settings(); await syncDerived(); changed('settings'); }); return n; })()),
          ),
        ),
      ),
      (s.mutedKinds || []).length ? h('div', { class: 'warn-bar' },
        h('span', { text: `已关闭：${s.mutedKinds.map(kindLabel).join('、')} 类提醒。` }),
        h('button', {
          class: 'btn btn-sm', style: 'margin-left:8px', text: '重新开启',
          onclick: async () => { db.saveSettings({ mutedKinds: [] }); state.settings = db.settings(); await syncDerived(); changed('settings'); },
        }),
      ) : null,
    ),
    nat ? nativeCard(nat) : null,
    !nat && (perm === 'denied' || perm === 'unsupported') ? permHelpCard(perm, recheckPerm) : null,
    h('div', { class: 'card' },
      h('h3', { text: nat ? 'App 提醒的边界' : '浏览器做不到什么' }),
      h('ul', { style: 'margin:0;padding-left:18px;color:var(--ink-soft);font-size:var(--fs-3);line-height:1.7' }, ...limitText().map((t) => h('li', { text: t }))),
    ),
    missed.length ? h('div', { class: 'card' },
      h('h3', { text: `已错过（${missed.length}）` }),
      h('p', { class: 'hint', text: '这些是页面关闭期间到点的提醒。没有连续补响，避免一打开就炸出一堆。' }),
      h('div', {}, ...missed.map(reminderRow)),
    ) : null,
    history.length ? h('div', { class: 'card' },
      h('h3', { text: '最近记录' }),
      h('div', {}, ...history.map(reminderRow)),
    ) : null,
    h('p', {
      class: 'hint',
      text: `${missedCount()} 条已错过 · ${pendingCount()} 条待提醒。提醒数据保存在${nat ? '这台手机 App 的本机存储里' : '本机浏览器里'}，不会上传。`,
    }),
  );
}
