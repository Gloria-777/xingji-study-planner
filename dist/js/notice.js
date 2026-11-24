// 使用须知：把散在各页的边界声明收在这一处，首次进入确认一次，之后只在设置页和状态抽屉里可查。
import { h, openSheet } from './ui.js';
import { isNativeApp, dataPlace } from './native.js';
import { limitText } from './remind.js';

// 内容改了才需要重新确认：文案有实质变化时把这个值往前推一格。
// v2：新增「目标」这一库、拆解与间隔复习是提案、以及本机历史统计的口径与不足——这些都算实质变化。
const ACK_VERSION = 'v2-2026-11';
const ACK_KEY = 'xj-notice-ack';

export function isAcked() {
  try { return localStorage.getItem(ACK_KEY) === ACK_VERSION; } catch (e) { return false; }
}
export function markAcked() {
  try { localStorage.setItem(ACK_KEY, ACK_VERSION); } catch (e) { /* 隐私模式写不进，下次还会问 */ }
}

export function noticeSections() {
  const nat = isNativeApp();
  return [
    {
      title: '本机存储与备份',
      lines: [
        `课程、任务、计划、专注、复盘、提醒、目标和对话记录保存在${dataPlace()}里（IndexedDB + localStorage）。没有账号、云端同步或电话功能。AI 请求发送的数据见下一节。`,
        '存储按「来源」隔离：localhost 与 127.0.0.1、http 与 https、不同端口各有一份库，互相看不见。',
        nat
          ? 'App 里这份库和你手机浏览器里那份网页数据是两个独立的库，不会互相同步，也不会互相覆盖。'
          : null,
        '换设备或换浏览器：在原来这边「设置 → 导出 JSON 备份」，再到目标环境「设置 → 导入 JSON」，导入前会先给写入预览，确认了才落库。',
        '「目标」是数据库第 2 版新加的那一个库：升级只创建缺失的库，前面七个库和已经存在的记录一条都不动；没有目标字段的旧备份照样能导入，导入时不会清空你的目标。',
        nat
          ? '清除 App 数据或卸载会一起删掉，本应用无法替你恢复。存放位置：IndexedDB「xingji-studyhack」+ localStorage「xj-settings」（这份须知的确认状态另记在 localStorage「xj-notice-ack」），交给系统闹钟的几条另存在 App 私有的 SharedPreferences「xj-native-reminders」里（只在这台手机的 App 私有目录，不写外部存储、不上传）。'
          : '清除浏览器站点数据会一起删掉，本应用无法替你恢复。存放位置：IndexedDB「xingji-studyhack」+ localStorage「xj-settings」（这份须知的确认状态另记在 localStorage「xj-notice-ack」）。',
      ].filter(Boolean),
    },
    {
      title: '两个 AI 助手会做什么、不会做什么',
      lines: [
        '规划小助（学习与工作规划）：提案的时间段先由本机程序查课程、午休、晚餐和已有计划的冲突，冲突或信息不足就不给保存；每条写入都要你逐条确认，实际写了几条以本机返回结果为准。',
        '心事树洞（学习心态教练）：服务端和本机都不允许它写你的日历或任务，它只接状态、不替你决定。',
        '看到「规则生成 · 未调用 AI」或「规则统计 · 未调用 AI」这两个标记，说明那条内容来自本机的规则排程或历史统计，没有调用任何大模型；AI 只出现在助手页。计划页、复盘页、目标页和今日页的建议目前都是这一类。',
        `两位助手要真的回答，需要服务端函数配好模型密钥。密钥只存在服务端环境变量里，不经过这个页面、不写进本机、也不会出现在导出文件里；没配好时页面会直接报未接入，不会用假回答糊弄你。${nat ? '这个 App 的 WebView 身份（https://localhost）会被平台网关拒掉（实测 403），要用助手请用手机浏览器或电脑打开网页版；App 里的规则排程、专注计时、系统闹钟不受影响。' : ''}`,
        '向 AI 发送消息时，服务端会收到当前消息、这个助手的近期对话、允许共享的学习详情，以及作息设置、记录条数、提醒计数等概况。关闭共享会移除对应的详情，概况仍随请求发送。开启「记忆互通」时，也会发送另一位助手的近期对话。服务端函数不把对话写入数据库或文件。',
        '提问有频率保护：这台设备每 5 分钟最多 20 次（按浏览器自报的设备号分桶，换浏览器或清缓存就能绕过，它只是额度保护，不是身份认证）；服务端实例另有每 5 分钟 200 次兜底，平台网关另有每分钟上限。高风险消息在计数之前就被服务端接住，这一类不花模型的钱。',
        '模型调用会产生费用，真实花费由上游服务商账户的额度与计费设置决定。本项目没有、也无法设置金额上限。',
      ],
    },
    {
      title: '心态方面：它不是心理治疗',
      lines: [
        '心事树洞是学习心态陪练，不是心理治疗，也不是紧急求助服务；它做不了诊断，也不替代专业帮助。',
        '高风险（例如自伤）消息由服务端函数按关键词做初步筛查后单独接住：不调用模型，也不只靠提示词。这只是关键词初步识别，不能识别所有风险——会漏掉委婉说法，也可能把「累死了」这类话误判；命中时只给求助渠道和建议，不做诊断。',
        '如果你或身边的人正处在危险里，请直接打 110 / 120，或拨 12356（全国心理援助热线）。这个应用不能代替它们。',
      ],
    },
    {
      title: nat ? 'App 提醒能做到哪一步（含真机实测）' : '网页提醒能做到哪一步',
      lines: [...limitText(), '提醒数据保存在本机，不会上传。这里不做真实电话或短信提醒，回访演练也只是模拟。'],
    },
    {
      title: '「你的步幅」「还要几天」这些数字怎么来的',
      lines: [
        '这四类说法——今日页的步幅、计划预览里的时长建议、目标页的「按你自己的步幅还要几天」、复盘页的偏差趋势——全部只读本机的专注记录做统计，不调用任何模型、不联网、不发数据。开启任务共享后，AI 请求可能包含目标标题和阶段名称。',
        '口径固定：用中位数而不是平均数（一次通宵能把平均值带走 40%，带走不了中位数）；预计和实际都要在 5 分钟以上的记录才进样本；估偏系数夹在 0.6–2.2 之间，超出这个范围只进统计、不改你的日程。',
        '样本不够就不说：同类记录不足 4 段、有专注记录的天数不足 5 天，页面会直说「还不够」，不会硬凑一个系数冒充了解你。这时「摊到每一天」也会拒绝按步幅拆，让你自己按天分几条。',
        '进度没有手填入口：目标页的百分比是它下面任务的状态和真实专注时长现算出来的。删掉一段专注记录，进度会跟着降——这是有意的，做完的目标也要经得起回看。',
        '「摊到每一天」拆出来的是任务提案，逐条勾选才写库，而且只决定「哪天做什么、大概多久」；具体落在哪个时段仍然由计划页的空闲排程和冲突检查管。间隔复习（1 / 2 / 4 / 7 / 15 天）同样是提案，一条一段可以自己改日期或取消。',
        '四个场景包（期末周、考研冲刺、课程设计周、毕业设计）带来的课程、任务、目标和专注记录都带「示例」标记。统计时示例和你自己的记录会分开数一遍，页面会写明「其中 N 段来自示例数据」；如果你还没做几次专注，校准的说法会是「全部来自示例数据，不是你自己的记录」，不会假装成你的历史。',
      ],
    },
    {
      title: '哪些话是实测来的',
      lines: [
        nat
          ? '写「真机实测」的条目来自 2026-11-05 在 vivo V2408A（Android 16）上的实测结果。换一台厂商、一个系统版本，后台冻结策略就可能不同，这些结论不能直接搬过去。'
          : '网页端的提醒、通知与铃声行为来自本机 Chrome / Edge 的实际表现；系统通知和后台冻结在不同浏览器上不保证一致。',
        '其余描述来自代码行为与该设备浏览器的能力边界，没有在其它机型上做统一验证。',
        '界面上一句「未实测」或「请到网页版」不是客气话：没跑通的功能不会说成已经工作。',
      ],
    },
  ];
}

function noticeOverview({ expanded = false } = {}) {
  return h('div', { class: 'notice-overview' },
    h('ul', { class: 'notice-key-points' },
      h('li', {}, h('strong', { text: '学习记录保存在本机。' }), ' 数据不会自动同步，换设备可用 JSON 备份。'),
      h('li', {}, h('strong', { text: '使用 AI 时会发送对话。' }), ' 服务端还会收到获准共享的学习详情，以及条数、作息等概况。'),
      h('li', {}, h('strong', { text: '提醒受设备与权限限制。' }), ' 心事树洞用于学习心态陪练，不能替代专业或紧急帮助。'),
    ),
    h('details', { class: 'notice-details', open: expanded },
      h('summary', { text: '查看完整使用须知' }),
      noticeBody(),
    ),
  );
}

function noticeBody() {
  return h('div', { class: 'notice' },
    ...noticeSections().map((sec) => h('div', { class: 'notice-sec' },
      h('h4', { text: sec.title }),
      h('ul', {}, ...sec.lines.map((t) => h('li', { text: t }))),
    )),
  );
}

/** 常驻入口：设置页和状态抽屉都用它，看完随时能再打开 */
export function openNotice({ expanded = false } = {}) {
  // 关闭必须走 api.close()：手动摘掉 .mask 的话 openSheets 里那条还留着，
  // 背景的 inert 不会解除，关掉须知后整个应用就点不动了。
  const api = openSheet({
    title: '使用须知',
    wide: true,
    content: noticeOverview({ expanded }),
    actions: [h('button', { class: 'btn btn-primary', onclick: () => api.close(), text: '关闭' })],
  });
  api.sheet.classList.add('notice-sheet');
  return api;
}

/**
 * 首次进入的一次性确认。不可点遮罩关闭，底部给两条路：
 * 确认（写标记，之后不再出现）或不同意（不写标记，本次不开提醒引擎）。
 */
export function openNoticeGate({ onAck, onDecline }) {
  let api;
  const finish = (acked) => {
    api.close();
    if (acked) { markAcked(); onAck?.(); } else onDecline?.();
  };
  api = openSheet({
    title: '用之前，先看这几条',
    wide: true,
    dismissible: false,
    labelledBy: 'notice-gate-title',
    content: noticeOverview(),
    actions: [
      h('button', { class: 'btn', onclick: () => finish(false), text: '我还不同意' }),
      h('button', { class: 'btn btn-primary', 'data-autofocus': true, onclick: () => finish(true), text: '我已了解，进入' }),
    ],
  });
  api.sheet.classList.add('notice-sheet');
  return api;
}
