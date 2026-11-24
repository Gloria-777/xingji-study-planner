// 设计事实来源页：所有读数都从浏览器当场取，不写死。
// 这个页面不 import 任何产品模块，不碰 IndexedDB / localStorage。
const h = (tag, attrs = {}, kids = []) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};

/* ---------- 实时读数：把令牌挂到一个探针元素上，读浏览器算出来的值 ---------- */
const probeHost = h('span', { style: 'position:absolute;left:-9999px;top:0;pointer-events:none' });
document.body.append(probeHost);
const CACHE = new Map();
function read(token, prop) {
  const key = `${token}|${prop}`;
  if (CACHE.has(key)) return CACHE.get(key);
  const p = h('span');
  p.style[prop] = `var(${token})`;
  probeHost.append(p);
  const v = getComputedStyle(p)[prop];
  p.remove();
  CACHE.set(key, v);
  return v;
}
const px = (v) => parseFloat(v) || 0;

/* ---------- :root 里到底声明了哪些令牌：直接从样式表规则里读，不抄清单 ---------- */
function rootDecls() {
  const out = new Map();
  for (const s of document.styleSheets) {
    const file = (s.href || '').split('/').pop();
    let rules; try { rules = s.cssRules; } catch { continue; }
    const hunt = (list, media) => {
      for (const r of list) {
        if (r.cssRules && !r.selectorText) { hunt(r.cssRules, r.media ? r.media.mediaText : media); continue; }
        if (r.selectorText !== ':root' || !r.style) continue;
        for (const p of r.style) {
          if (!p.startsWith('--')) continue;
          const name = p.trim();
          if (!out.has(name)) out.set(name, []);
          out.get(name).push({ file, raw: r.style.getPropertyValue(name).trim(), media: media || '（无条件）' });
        }
      }
    };
    hunt(rules, '');
  }
  return out;
}
const ROOT = rootDecls();

/* ---------- 第二套值：主题块里覆盖了哪些令牌 ----------
   主题块的选择器不是 :root，所以它不算进上面那张表（数目对账仍然是「:root 声明了几个」），
   但它必须被单独核对：覆盖了一个 :root 里没有的名字，就是给浅色留了个死令牌。 */
const THEME_SELECTOR = /^:root\[data-theme="([a-z]+)"\]$/;
function themeDecls() {
  const out = new Map();
  for (const s of document.styleSheets) {
    const file = (s.href || '').split('/').pop();
    let rules; try { rules = s.cssRules; } catch { continue; }
    for (const r of rules) {
      const m = r.selectorText && THEME_SELECTOR.exec(r.selectorText);
      if (!m || !r.style) continue;
      for (const p of r.style) {
        if (!p.startsWith('--')) continue;
        if (!out.has(p)) out.set(p, { theme: m[1], by: [], dark: '', light: '' });
        const t = out.get(p);
        t.by.push(file);
        t.light = r.style.getPropertyValue(p).trim();
        const inRoot = ROOT.get(p);
        if (inRoot) t.dark = inRoot[0].raw;
        else t.dark = '（:root 里没有这一条）';
      }
    }
  }
  return out;
}
const THEME = themeDecls();

/* ---------- 令牌清单：用途注释写在这里，档位真值从样式表里读 ---------- */
const GROUPS = [
  {
    id: 'dg-type', title: '字阶', prop: 'font-size', kind: 'type',
    note: '十档整数正文阶 + 三档展示级 clamp。半像素一律向下取整档。',
    items: [
      ['--fs-0', '微：课表格子第三行、日历芯片'],
      ['--fs-1', '标注：周副标题、消息作者、环下小字'],
      ['--fs-2', '次要：说明、行元信息、标签'],
      ['--fs-3', '控件：按钮、输入、界面正文'],
      ['--fs-4', '卡片正文、须知段落'],
      ['--fs-5', '页面基准（html/body）'],
      ['--fs-6', '卡片标题'],
      ['--fs-7', '弹层标题、品牌名'],
      ['--fs-8', '页面主标题（宽屏基准）'],
      ['--fs-9', '宽屏页面主标题'],
      ['--fs-title', '手机端页面主标题'],
      ['--fs-hero', '专注大字（无环时）'],
      ['--fs-dial', '专注环环心'],
      ['--fs-overlay', '全屏倒计时'],
    ],
  },
  {
    id: 'dg-space', title: '间距阶', prop: 'padding-top', kind: 'bar',
    note: '4px 基准的十档。1px 的发丝间隙不算档位，它是分隔线本身。',
    items: [
      ['--sp-0', '2px：一行内的微差'], ['--sp-1', '4px：标签与图标'], ['--sp-2', '6px：控件之间'],
      ['--sp-3', '8px：按钮内边、栅格缝'], ['--sp-4', '10px：行内元素'], ['--sp-5', '12px：卡片内边'],
      ['--sp-6', '16px：块之间'], ['--sp-7', '20px：区块之间'], ['--sp-8', '24px：页面级留白'], ['--sp-9', '28px：页脚与顶栏'],
    ],
  },
  {
    id: 'dg-radius', title: '圆角', prop: 'border-radius', kind: 'round',
    note: '按角色分档：小控件、控件、卡片、胶囊、圆形。',
    items: [
      ['--r-xs', '小控件：图标钮、芯片、迷你条'], ['--r-sm', '控件：按钮、输入、导航项、消息泡'],
      ['--r-md', '卡片与网格容器'], ['--r-pill', '胶囊：进度条、筛选片'], ['--r-full', '圆形：状态点、头像位'],
    ],
  },
  {
    id: 'dg-color', title: '颜色', prop: 'color', kind: 'swatch',
    note: '底色与文字一组；强调色按「真的被用到的那一档」留台阶，不是每个色都凑满五档——' +
      '凑出来的空台阶会被下面「没人引用」那一项抓住（这一轮就删掉了 --blue-line 与 --accent-press 两枚）。白色只按角色分七档。',
    items: [
      ['--bg-0', '页面最底'], ['--bg-1', '天空上端'],
      ['--ink', '正文'], ['--ink-soft', '次级正文'], ['--ink-dim', '注释与占位'],
      ['--ink-cool', '冷白标签与等宽数字'], ['--ink-on-brand', '品牌底上的文字'],
      ['--ink-on-ok', '浅蓝底上的文字'], ['--ink-on-warn', '浅黄底上的文字'], ['--ink-on-danger', '浅橙底上的文字'],
      ['--brand', '主色'], ['--brand-2', '主色的冷端'], ['--accent', '强调紫'], ['--danger', '风险橙'], ['--warn', '提醒黄'], ['--ok', '信息蓝'],
      ['--on-fill', '淡填充'], ['--on-hair', '弱分隔与虚线'], ['--on-glass', '玻璃面'], ['--on-line', '描边'],
      ['--on-press', '按压与悬停底'], ['--on-edge', '强调描边与指示'], ['--on-bright', '最实的一档'],
      ['--brand-tint', '品牌·填充'], ['--brand-press', '品牌·选中'], ['--brand-line', '品牌·描边'], ['--brand-edge', '品牌·强调'], ['--brand-strong', '品牌·光晕'],
      ['--blue-tint', '冷蓝·填充'], ['--blue-press', '冷蓝·选中'],
      ['--accent-tint', '强调紫·填充'], ['--accent-line', '强调紫·描边'], ['--accent-strong', '强调紫·光晕'],
      ['--danger-tint', '风险橙·填充'], ['--danger-press', '风险橙·选中'], ['--danger-line', '风险橙·描边'], ['--danger-strong', '风险橙·强调'],
      ['--warn-tint', '提醒黄·填充'], ['--warn-line', '提醒黄·描边'],
      ['--ok-tint', '信息蓝·填充'], ['--ok-line', '信息蓝·描边'], ['--ok-strong', '信息蓝·光晕'],
    ],
  },
  {
    id: 'dg-depth', title: '阴影', prop: 'box-shadow', kind: 'shadow',
    note: '五档：控件、手机端卡片、面板与弹层、抽屉、课表块。第三档「无」也是选择，不是遗漏。' +
      '浅色那档把主三档压到 8–10% 的蓝灰——近中性底上的阴影一重就脏，这一档靠描边与留白分层不靠投影。',
    items: [
      ['--shadow-sm', '课表格子与卡片浮起'], ['--shadow-md', '手机端卡片'],
      ['--shadow', '弹层与抽屉'], ['--shadow-drawer', '手机端底部抽屉（往上投影）'], ['--shadow-chip', '宽屏课表块：靠阴影分层，不靠一圈白边'],
    ],
  },
  {
    id: 'dg-surface', title: '面与玻璃', prop: 'background-color', kind: 'swatch',
    note: '卡片面单独一档：深色里它就是那层玻璃，浅色里它是不透明白——' +
      '而 --glass/--on-fill 在浅色里仍然是淡按压底，两个角色在深色恰好重合、在浅色必须分开。',
    items: [
      ['--surface-card', '卡片、气泡、胶囊的面'],
      ['--card-filter', '卡片那层玻璃（浅色为 none）', 'backdrop-filter'],
      ['--shell-filter', '手机端外壳那层（浅色为 none）', 'backdrop-filter'],
      ['--blur', '卡片玻璃的模糊半径', 'padding-top'],
      ['--blur-lg', '外壳与工具条的模糊半径', 'padding-top'],
    ],
  },
  {
    id: 'dg-glow', title: '光晕与渐变端点', prop: 'color', kind: 'swatch',
    note: '主按钮与品牌标记的光晕、进度条与「现在」线的另一端、按压与悬停时渐变往哪边偏。' +
      '这些原来都是写在规则里的字面值，双主题一上来就必须先有名字。',
    items: [
      ['--glow-brand', '品牌标记的光晕'], ['--glow-btn', '主按钮的光晕'], ['--glow-btn-press', '主按钮按下时的光晕'],
      ['--now-line', '课表「现在」那一根线'], ['--bar-act-end', '实际投入条的冷端'], ['--bar-over-end', '超额进度条的末端'],
      ['--btn-press-a', '主按钮按下的紫端'], ['--btn-press-b', '主按钮按下的冷端'],
      ['--btn-hover-a', '主按钮悬停的紫端'], ['--btn-hover-b', '主按钮悬停的冷端'],
    ],
  },
  {
    id: 'dg-landing', title: '文字落在什么底上', prop: 'color', kind: 'swatch',
    note: '实心品牌底上的字两档主题都用白（浅色的品牌色已经压深到 #5b45c9/#2f6ec4，白字 5.6:1 与 4.7:1）；' +
      '淡底（tint / press 那一层）上的字在浅色必须换成深字，否则白字压在浅紫上直接看不见。',
    items: [
      ['--ink-on-solid', '实底上的字（主按钮、课表块、选中胶囊）'], ['--ink-on-tint', '淡底上的字（侧栏选中、须知强调）'],
      ['--ink-bright', '渐变标题的最亮端'], ['--hero-end', '专注大字的渐变末端'],
      ['--ink-notice', '须知分节标题'], ['--grip', '弹层拉手那一横（画在面板上）'],
    ],
  },
  {
    id: 'dg-sky', title: '分层、遮罩与外壳底色', prop: 'color', kind: 'swatch',
    note: '深色那一套「天空」专用的量：星云、滚动深空、全屏倒计时底、遮罩、面板、须知底部那条钉住的带、' +
      '手机端应用栏与底栏。浅色块换掉的就是这 22 个值，规则的写法一行没动。',
    items: [
      ['--sky-end', '天空渐变的最底一段'],
      ['--neb-a', '星云：右上'], ['--neb-b', '星云：左上'], ['--neb-c', '星云：下方'], ['--neb-hi', '首屏重音那一块上的亮点'],
      ['--deep-glow', '滚动深空层顶上的辉光'], ['--deep-top', '滚动深空层的上端'], ['--deep-bot', '滚动深空层的下端'],
      ['--overlay-a', '全屏倒计时底的上端'], ['--overlay-b', '全屏倒计时底的下端'],
      ['--scrim', '弹层遮罩'], ['--panel-a', '弹层面板的上端'], ['--panel-b', '弹层面板的下端'],
      ['--pin-bg', '须知里钉在底部的确认带'], ['--toast-bg', '提示条的面'],
      ['--field-deep', '对话输入区（比卡片沉一档）'], ['--code-bg', '上下文 JSON 那块的底'], ['--inset-soft', '消息里安全提示的底'],
      ['--chrome-a', '应用栏的上端'], ['--chrome-b', '应用栏的下端'], ['--chrome-c', '底栏的上端'], ['--chrome-d', '底栏的下端'],
    ],
  },
  {
    id: 'dg-theme', title: '浅色那一档换了哪些值', prop: 'color', kind: 'swatch',
    note: '第二套值不是第二套界面：这一节由脚本从 :root[data-theme="light"] 里读出来，' +
      '列的是「同一个令牌在两档主题里各是多少」。左边的色块按当前这一档渲染。',
    items: [],
    themePair: true,
  },
];

const MOTION = [
  ['--t-press', '按下去的时长', 'transition-duration'],
  ['--t-lift', '抬起/描边变化', 'transition-duration'],
  ['--t-in', '进场', 'transition-duration'],
  ['--ease-out', '缓动曲线', 'transition-timing-function'],
  ['--ring', '键盘焦点环', 'box-shadow'],
  ['--hairline', '分隔线', 'border-top-color'],
  ['--line', '描边', 'border-top-color'],
  ['--line-soft', '弱描边', 'border-top-color'],
  ['--glass', '玻璃底', 'background-color'],
  ['--glass-strong', '玻璃底（重）', 'background-color'],
  ['--axis-h', '课表一小时行高', 'height'],
];

/* ---------- 页头元信息 ---------- */
function meta() {
  const isLight = document.documentElement.dataset.theme === 'light';
  const sheets = [...document.styleSheets].map((s) => {
    const href = (s.href || '').split('/').pop();
    let n = -1; try { n = s.cssRules.length; } catch { n = -1; }
    return { href, n, on: s.media.length === 0 ? true : matchMedia(s.media.mediaText).matches };
  });
  const d = [
    ['视口', `${innerWidth}×${innerHeight}`],
    ['devicePixelRatio', String(devicePixelRatio)],
    // 链接上没有 media，生效与否只能问视口：按 link.media 判会永远说「生效」
    ['手机版式层', matchMedia('(max-width: 900px)').matches ? '生效（≤900px）' : '未生效（>900px）'],
    ['宽屏版式层', matchMedia('(min-width: 901px)').matches ? '生效（≥901px）' : '未生效（≤900px）'],
    ['本页样式表', sheets.map((s) => `${s.href} ${s.n < 0 ? '读数被拦' : s.n + ' 条规则'}`).join('，')],
    ['减弱动效', matchMedia('(prefers-reduced-motion: reduce)').matches ? '系统已开启' : '系统未开启'],
    ['这一屏的主题', isLight ? '浅色（地址带 ?theme=light）' : '深色（默认）'],
    ['浅色覆盖的令牌数', String(THEME.size)],
    ['本页数据来源', '无（不读 IndexedDB / localStorage）'],
  ];
  const dl = document.getElementById('dg-meta');
  dl.replaceChildren(...d.map(([k, v]) => h('div', {}, [h('dt', { text: k }), h('dd', { text: v })])));
  const cur = document.getElementById('dg-cur-theme');
  if (cur) cur.textContent = isLight ? '浅色' : '深色';
  document.documentElement.dataset.dgPageTheme = isLight ? 'light' : 'dark';
}

/* ---------- 令牌表 ---------- */
function rows(group) {
  const box = h('div', { class: 'dg-rows' });
  for (const item of group.items) {
    // 第三格可选：这一行的令牌按哪个属性量。阴影档要用 box-shadow、模糊档要用 padding-top，
    // 同一节里两类都有，写在组上就会有一类读出来是空话。
    const [token, use, itemProp] = item;
    const v = read(token, itemProp || group.prop);
    const sw = h('span', { class: `dg-chip ${group.kind === 'bar' ? 'bar' : group.kind === 'round' ? 'round' : ''}` });
    if (group.kind === 'swatch') sw.style.background = `var(${token})`;
    if (group.kind === 'shadow') sw.style.boxShadow = `var(${token})`;
    if (group.kind === 'bar') { sw.style.width = v; sw.style.maxWidth = '100%'; }
    if (group.kind === 'round') sw.style.borderRadius = `var(${token})`;
    const cells = [h('code', { class: 'dg-k', text: token }), sw, h('span', { class: 'dg-v', text: v }), h('span', { class: 'dg-use', text: use })];
    // 字阶放不下 32px 的样本列：展示级会被裁成半个字，看上去像渲染坏了。这一组把样本挪到整行下面。
    if (group.kind === 'type') {
      const spec = h('div', { class: 'dg-spec', text: '星迹 A 123' });
      spec.style.font = `var(${token})/1.25 sans-serif`;
      box.append(h('div', { class: 'dg-row dg-spec-row' }, [cells[0], cells[2], cells[3], spec]));
      continue;
    }
    box.append(h('div', { class: 'dg-row' }, cells));
  }
  return box;
}

/* ---------- 浅色那一档：从 :root[data-theme="light"] 现读，不抄清单 ---------- */
/* 这一节里的每一个数都是脚本从样式表里读出来的声明原文。
   它不参与散账（散账跳主题块），也不参与 :root 数目对账里「多出来」的那一侧：
   列出的令牌名和上面各节重合，Set 会去重，所以对账仍然等于 :root 声明数。 */
function themeRows() {
  const box = h('div', { class: 'dg-rows' });
  for (const [token, t] of THEME) {
    const sw = h('span', { class: 'dg-chip' });
    // 只有值确实是个颜色时才涂色块：--card-filter 那一档两主题写的是 blur(...) 与 none，涂上去是空的
    const colorish = /^(var\(--|#|rgba?\()/.test(t.light);
    if (colorish) sw.style.background = `var(${token})`;
    const ghost = t.dark === '（:root 里没有这一条）';
    const use = ghost
      ? '⚠ 越界：:root 里没有这一条，深色读不到对照值——散账核对那一节会把它列出来。'
      : `${colorish ? `这一屏按当前档读到 ${read(token, 'color')}；` : ''}${t.by.join('，')} 声明`;
    box.append(h('div', { class: 'dg-row' }, [
      h('code', { class: 'dg-k', text: token }), sw,
      h('span', { class: 'dg-v', text: `${t.dark} → ${t.light}` }),
      h('span', { class: 'dg-use', text: use }),
    ]));
  }
  return box;
}

function buildGroups() {
  for (const g of GROUPS) {
    const sec = document.getElementById(g.id);
    if (!sec) continue;
    if (g.themePair) {
      sec.querySelector('.dg-note').textContent =
        `第二套值不是第二套界面：这一节由脚本从 :root[data-theme="light"] 里读出 ${THEME.size} 条覆盖，` +
        '列的是「同一个令牌在两档主题里各是多少」，左边色块按当前这一档渲染。规则的写法一行没动。';
    }
    sec.append(g.themePair ? themeRows() : rows(g));
  }
}

/* ---------- 动效与别名 ---------- */
function buildMotion() {
  const box = document.getElementById('dg-motion-demo');
  const rowsBox = h('div', { class: 'dg-rows' });
  for (const [token, use, prop] of MOTION) {
    rowsBox.append(h('div', { class: 'dg-row' }, [
      h('code', { class: 'dg-k', text: token }), h('span', { class: 'dg-chip' }),
      h('span', { class: 'dg-v', text: read(token, prop) }), h('span', { class: 'dg-use', text: use }),
    ]));
  }
  box.append(rowsBox);

  const live = h('div', { class: 'dg-note-box', id: 'dg-motion-live' });
  const btn = h('button', { class: 'btn btn-primary', type: 'button', text: '按住我' });
  const show = () => {
    const cs = getComputedStyle(btn);
    live.textContent = `按下时：transform=${cs.transform}，背景=${cs.backgroundColor}，过渡=${cs.transitionDuration}。松手回到 ${getComputedStyle(document.querySelector('.dg')).fontSize} 的正文阶。`;
  };
  btn.addEventListener('pointerdown', () => { btn.classList.add('xj-press'); show(); });
  btn.addEventListener('pointerup', () => { btn.classList.remove('xj-press'); show(); });
  btn.addEventListener('pointerleave', () => { btn.classList.remove('xj-press'); });
  show();
  box.append(h('div', { class: 'dg-cell' }, [h('span', { class: 'dg-name', text: '按压反馈（真实事件）' }), btn, live]));
}

/* ---------- 控件原子：直接用产品样式表里的类名 ---------- */
function atom(cls, name) {
  const el = h('span', { class: cls, text: name });
  const fig = h('figure', { class: 'dg-cell' });
  const probe = el.cloneNode(true);
  probe.style.cssText = 'position:absolute;left:-9999px;visibility:hidden';
  document.body.append(probe);
  const c = getComputedStyle(probe);
  const label = `${cls} → 字号 ${c.fontSize}，圆角 ${c.borderRadius}，内边 ${c.paddingTop}/${c.paddingLeft}，底 ${c.backgroundColor}，描边 ${c.borderTopWidth} ${c.borderTopColor}`;
  probe.remove();
  fig.append(el, h('figcaption', { text: label }));
  return fig;
}

function buildAtoms() {
  const box = document.getElementById('dg-atoms-demo');
  const items = [
    atom('btn', '普通按钮'), atom('btn btn-primary', '主按钮'), atom('btn btn-ghost', '次按钮'),
    atom('btn btn-danger', '危险按钮'), atom('btn btn-sm', '小按钮'), atom('icon-btn', '图标钮'),
    atom('chip', '胶囊标签'), atom('chip on', '胶囊·选中'), atom('tag', '状态标签'),
    atom('tag p-high', '标签·高优先'), atom('tag ok', '标签·正常'), atom('tag warn', '标签·提醒'), atom('tag bad', '标签·风险'),
    atom('pill', '预设片'), atom('pill-sm', '小片'), atom('hint', '提示文字'),
  ];
  const input = h('input', { class: '', type: 'text', value: '输入框' });
  const sel = h('select', { class: '' }); sel.append(h('option', { text: '下拉框' }));
  const ta = h('textarea', { class: '', text: '多行输入' });
  for (const [el, nm] of [[input, '输入框'], [sel, '下拉框'], [ta, '多行输入']]) {
    // 量的是克隆体：把定位样式抹在真样本上的话，这一格会变成看不见的样本，截图里还以为是渲染正常
    const probe = el.cloneNode(true);
    probe.style.cssText = 'position:absolute;left:-9999px;visibility:hidden';
    document.body.append(probe);
    const cs = getComputedStyle(probe);
    const line = `${nm} → 字号 ${cs.fontSize}，圆角 ${cs.borderRadius}，内边 ${cs.paddingTop}/${cs.paddingLeft}，底 ${cs.backgroundColor}`;
    probe.remove();
    box.append(h('figure', { class: 'dg-cell' }, [el, h('figcaption', { text: line })]));
  }
  box.append(...items);
  box.append(h('figure', { class: 'dg-cell' }, [
    h('div', { class: 'bar-row' }, [h('span', { text: '预计 vs 实际' }), h('div', { class: 'bar' }, [h('i', { style: 'width:62%' })]), h('span', { class: 'bar-val', text: '62%' })]),
    h('figcaption', { text: '进度条 .bar-row / .bar → 条高 ' + getComputedStyle(h('div', { class: 'bar' })).height }),
  ]));
}

function buildSurfaces() {
  const box = document.getElementById('dg-surfaces-demo');
  const card = h('div', { class: 'card dg-card' }, [
    h('h3', { text: '卡片 .card' }),
    h('div', { class: 'row' }, [
      h('div', { class: 'row-main' }, [h('div', { class: 'row-title', text: '行标题 .row-title' }), h('div', { class: 'row-meta', text: '行元信息 .row-meta · 12 档间距' })]),
      h('div', { class: 'row-ops' }, [h('button', { class: 'icon-btn', type: 'button', text: '✓' })]),
    ]),
  ]);
  const cs = (() => { const p = h('div', { class: 'card' }); p.style.cssText = 'position:absolute;left:-9999px;visibility:hidden'; document.body.append(p); const c = getComputedStyle(p); p.remove(); return c; })();
  box.append(h('figure', { class: 'dg-cell' }, [card, h('figcaption', { text: `.card → 圆角 ${cs.borderRadius}，内边 ${cs.paddingTop}，底 ${cs.backgroundColor}，模糊 ${cs.backdropFilter}` })]));

  const grid = h('div', { class: 'dg-cell' }, [
    // 产品里 .tt-grid 外面永远包着 .tt-wrap（横向滚动那一层）。样本不包就等于在参考页上
    // 演示了另一种装法：7 天轨道合计 634px 会把整页顶宽，真页面里顶宽的是那一层而不是页面。
    h('div', { class: 'tt-wrap', style: 'width:100%' },
      h('div', { class: 'tt-grid' }, [
        h('div', { class: 'tt-corner', text: '时间' }),
        h('div', { class: 'tt-dow today', text: '周三' }),
        h('div', { class: 'tt-hours', style: '--axis-h:28px' }, [h('div', { class: 'tt-hour', text: '8:00' }), h('div', { class: 'tt-hour', text: '9:00' })]),
        h('div', { class: 'tt-col' }, [h('button', { class: 'tt-course today', type: 'button', style: 'top:0;height:56px;left:2px;right:2px;background:linear-gradient(160deg,var(--accent),var(--brand))' }, [h('b', { text: '高等数学' }), h('span', { text: '08:00-09:40' }), h('span', { text: '教一 301' })])]),
      ])),
    h('figcaption', { text: '课表 .tt-wrap / .tt-grid / .tt-course（这一格按真实结构装：窄屏时横向滚动发生在 .tt-wrap 里，不撑宽页面。行高压到 28px 只为放进这一页）' }),
  ]);
  box.append(grid);

  const cal = h('div', { class: 'dg-cell' }, [
    h('div', { class: 'cal-grid', style: 'max-width:280px' }, [
      h('button', { class: 'cal-cell today', type: 'button' }, [h('span', { class: 'cal-date', text: '5' }), h('span', { class: 'cal-chip', text: '高数 作业' }), h('span', { class: 'cal-chip task', text: '编译原理' }), h('span', { class: 'cal-chip pd', text: '计划·完成' })]),
      h('button', { class: 'cal-cell', type: 'button' }, [h('span', { class: 'cal-date', text: '6' }), h('span', { class: 'cal-chip plan', text: '计划' }), h('span', { class: 'cal-chip ps', text: '已跳过' }), h('span', { class: 'cal-more', text: '+2 项' })]),
    ]),
    h('figcaption', { text: '日历 .cal-cell 与四种 .cal-chip' }),
  ]);
  box.append(cal);

  const chat = h('div', { class: 'dg-cell dg-stack' }, [
    h('div', { class: 'msg user' }, [h('div', { class: 'msg-who', text: '你' }), h('div', { text: '今晚只有 40 分钟，来得及吗？' })]),
    h('div', { class: 'msg assistant' }, [h('div', { class: 'msg-who', text: '规划小助手' }), h('div', { text: '来得及。把高数作业拆成 25 分钟一段，剩下 15 分钟收尾。' })]),
    h('div', { class: 'note' }, [h('div', { class: 'tag ok', text: '规则生成 · 未调用 AI' }), h('div', { text: '这一条是气泡与状态标签的静态样本，本页不发起任何请求。' })]),
    h('figcaption', { text: '对话气泡 .msg.user / .msg.assistant 与 .note' }),
  ]);
  box.append(chat);

  const toast = h('div', { class: 'dg-cell' }, [
    h('div', { class: 'toast', style: 'position:static' }, [h('span', { text: '已保存' })]),
    h('div', { class: 'toast bad', style: 'position:static' }, [h('span', { text: '这一条没存下' })]),
    h('figcaption', { text: '提示条 .toast / .toast.bad（产品里是钉在屏幕上的，这里摆平了好截图）' }),
  ]);
  box.append(toast);
}

function buildSpecial() {
  const box = document.getElementById('dg-special-demo');
  box.append(h('figure', { class: 'dg-cell' }, [
    h('div', { class: 'dg-sky', style: 'width:100%' }),
    h('figcaption', { text: '今日页主卡片的天空渐变：三个强调色的 tint 依次退到最淡的一档填充，用的是档位，不是新数' }),
  ]));
  box.append(h('figure', { class: 'dg-cell' }, [
    h('div', { class: 'dg-depth', style: 'width:100%' }),
    h('figcaption', { text: '星空分层：这一格的两条色标现在都是令牌（body 背景走 --bg-0/--bg-1/--sky-end，亮点走 --neb-c）。浅色档把 --neb-c 换成几乎看不见的淡紫，深空层整条关掉（--deep-* 为透明），所以这块在浅色下就是一张白卡——分层还在，只是不再画星星。' }),
  ]));
  box.append(h('div', { class: 'dg-note-box' }, [
    '双主题之后，正文里不许再出现任何颜色字面值——连「天空本身」也进了档位，浅色才有东西可换。' +
    '唯一留下的两类是纯黑遮罩：mask-image 要的亮度、以及渐变里「完全透明」那一站，它们跟主题无关。' +
    '再加上数值侧的发丝级 1px 间隙与 0。下面这张表就是允许名单，每一行都写了为什么允许——加一行就得写一句理由。',
  ]));
  const allow = h('div', { class: 'dg-rows' });
  for (const [k, why] of SKY_STOPS) allow.append(h('div', { class: 'dg-row' }, [
    h('code', { class: 'dg-k', text: `rgb(${k})` }), h('span', { class: 'dg-chip', style: `background:rgb(${k.split(', ')[0]}, ${k.split(', ')[1]}, ${k.split(', ')[2]})` }),
    h('span', { class: 'dg-v', text: 'rgba 允许' }), h('span', { class: 'dg-use', text: why }),
  ]));
  for (const [k, why] of SKY_HEX) allow.append(h('div', { class: 'dg-row' }, [
    h('code', { class: 'dg-k', text: `#${k}` }), h('span', { class: 'dg-chip', style: `background:#${k}` }),
    h('span', { class: 'dg-v', text: 'hex 允许' }), h('span', { class: 'dg-use', text: why }),
  ]));
  box.append(h('p', { class: 'dg-note', text: `允许名单：${SKY_STOPS.size} 组 rgba + ${SKY_HEX.size} 个 hex。` }), allow);
}

/* ---------- 其余令牌：把 :root 里没被上面各节列到的全部补齐 ---------- */
/* 只数令牌行：允许名单那一节的 .dg-k 写的是 rgb()/#hex，不是 :root 里的属性名，
   混进来的话「本页列出数」会比 :root 声明数多出一截，对账就没意义了。 */
const isTokenName = (t) => t.startsWith('--');
function buildRest() {
  const shown = new Set([...document.querySelectorAll('.dg-k')].map((e) => e.textContent.trim()).filter(isTokenName));
  const rest = [...ROOT.keys()].filter((k) => !shown.has(k));
  // 反向也要对得上：页面上列了、:root 里却没有的，是这一页自己留下的死引用
  const ghost = [...shown].filter((k) => !ROOT.has(k));
  const sec = h('section', { class: 'dg-sec', id: 'dg-rest' });
  sec.append(h('h2', { text: `其余令牌（补齐 ${rest.length} 个）` }));
  sec.append(h('p', { class: 'dg-note', text: '上面各节按角色列的是视觉档位；这一节收的是剩下的外壳几何与安全区，一行一条声明原文。列全只为让数目对得上：上面各节加这一节，正好等于 :root 声明的令牌总数。' }));
  const box = h('div', { class: 'dg-rows' });
  for (const k of rest) {
    const d = ROOT.get(k).map((x) => `${x.file}${x.media === '（无条件）' ? '' : `（${x.media}）`} 声明为 ${x.raw}`).join('；');
    box.append(h('div', { class: 'dg-row' }, [
      h('code', { class: 'dg-k', text: k }), h('span', { class: 'dg-chip' }),
      h('span', { class: 'dg-v', text: read(k, 'padding-top') }), h('span', { class: 'dg-use', text: d }),
    ]));
  }
  for (const k of ghost) {
    box.append(h('div', { class: 'dg-row' }, [
      h('code', { class: 'dg-k', text: k }), h('span', { class: 'dg-chip' }),
      h('span', { class: 'dg-v', text: '读不到值' }), h('span', { class: 'dg-use', text: '这一页列了它，但三张样式表的 :root 里都没有这条声明——要么在 :root 补上，要么把这一行删掉。' }),
    ]));
  }
  sec.append(box);
  document.querySelector('.dg-main').append(sec);
  document.documentElement.dataset.dgRootTokens = String(ROOT.size);
  document.documentElement.dataset.dgListed = String(shown.size + rest.length);
  document.documentElement.dataset.dgGhost = ghost.join(',') || 'none';
}

/* ---------- 散账核对：用浏览器自己解析出来的规则树，比读文本可靠 ---------- */
const SPACE_PROPS = ['font-size', 'gap', 'row-gap', 'column-gap', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'border-radius'];

// 颜色特例名单：双主题之后，正文里连「天空本身」的色标都进了令牌，
// 只剩遮罩与渐隐用到的那两档纯黑可以写字面值。加一条就得在这里写一句为什么。
const SKY_STOPS = new Map([
  ['0, 0, 0', 'mask-image 要的是亮度不是颜色：这一档两档主题都一样，跟着主题走反而是错的'],
  ['0, 0, 0, 0', '渐变里的「完全透明」那一站（写 transparent 也是它）'],
]);
const SKY_HEX = new Map([]);
const isAllowedColor = (lit) => {
  const s = lit.replace(/\s+/g, ' ').trim();
  // 纯白不再是免检：白字要落在实底还是淡底，是两个不同的角色，必须写令牌名（--ink-on-solid / --ink-on-tint）。
  // 纯黑只留给上面那两档遮罩用途。
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return /^#000$/i.test(s);
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return false;
  const parts = m[1].split(',').map((x) => x.trim());
  const triple = parts.slice(0, 3).join(', ');
  if (SKY_STOPS.has(s.replace(/, 0?\.\d+\)$/, ')'))) return true;   // 不带透明度的分层色
  return SKY_STOPS.has(triple);
};

/* ---------- 原文核对 ----------
   为什么还要读一遍源文本：这一版浏览器把带 var() 的简写序列化成了一串空的长写
   （body { background: 四段渐变 } 的 cssText 只剩 background-image: ; …），
   所以只按 CSSOM 扫颜色的话，「字面值和 var() 写在同一条简写里」的那一类是隐形的；
   「谁引用了这枚令牌」也会跟着漏报，假档位检查就跟着一起骗人。
   数值那一半（margin/padding/gap/圆角/字号）浏览器拆得干净，仍然走 CSSOM。 */
const splitBlocks = (text) => {
  const res = [];
  let i = 0, selStart = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      let d = 1, j = i + 1;
      while (j < text.length && d) { if (text[j] === '{') d++; else if (text[j] === '}') d--; j++; }
      res.push({ sel: text.slice(selStart, i).trim().replace(/\s+/g, ' '), body: text.slice(i + 1, j - 1) });
      i = j; selStart = j;
    } else i++;
  }
  return res;
};
function textAudit(text, file, out) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const hunt = (chunk, media) => {
    for (const b of splitBlocks(chunk)) {
      if (b.sel.startsWith('@')) { hunt(b.body, b.sel.startsWith('@media') ? b.sel : media); continue; }
      // :root 与主题块写的就是令牌真值，那些数本来就该是字面的
      if (b.sel === ':root' || THEME_SELECTOR.test(b.sel) || /(^|,)\s*:root/.test(b.sel)) continue;
      const lits = b.body.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g) || [];
      const bad = [...new Set(lits.filter((c) => !isAllowedColor(c)))];
      if (bad.length) out.push({ file, sel: `${media ? `[${media}] ` : ''}${b.sel}`, prop: '（颜色·原文）', v: b.body.trim().slice(0, 90), why: '颜色没走令牌：' + bad.join('，') });
    }
  };
  hunt(src, '');
}
async function loadSources() {
  const map = new Map();
  for (const s of document.styleSheets) {
    if (!s.href) continue;
    const file = s.href.split('/').pop();
    try { const r = await fetch(s.href); map.set(file, r.ok ? await r.text() : null); }
    catch { map.set(file, null); }
  }
  return map;
}

function walk(rules, file, out, media) {
  for (const r of rules) {
    // 分组规则（@media/@supports）与样式规则在这一版浏览器里都有 .cssRules：
    // 后者是个空表，但仍然为真。按「有没有 cssRules」分流会把 251 条样式规则全跳过去，
    // 散账于是永远读不到东西——0 处是假的通过。只有真的嵌了子规则才递归。
    if (r.cssRules && r.cssRules.length) walk(r.cssRules, file, out, r.media ? `${media || ''} ${r.media.mediaText}`.trim() : media);
    if (!r.selectorText || !r.style) continue;
    // 主题块不参与散账：它写的就是「同一令牌在另一档主题里的真值」，那些数本来就该是字面的。
    // 它另外有属于自己的核对：见下面 dgThemeGhost。
    if (r.selectorText === ':root' || THEME_SELECTOR.test(r.selectorText)) continue;
    const where = `${media ? `[${media}] ` : ''}${r.selectorText}`;
    for (const prop of SPACE_PROPS) {
      const v = r.style.getPropertyValue(prop);
      if (!v || /var\(|calc\(|env\(|clamp\(/.test(v)) continue;
      const bad = v.split(/\s+/).filter((p) => /^[0-9]+(\.[0-9]+)?px$/.test(p) && parseFloat(p) !== 1 && parseFloat(p) !== 0);
      if (bad.length) out.push({ file, sel: where, prop, v, why: '没走档位：' + bad.join(' ') });
    }
    const text = r.style.cssText || '';
    const lits = text.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g) || [];
    const bad = [...new Set(lits.filter((c) => !isAllowedColor(c)))];
    if (bad.length) out.push({ file, sel: where, prop: '（颜色）', v: text.slice(0, 90), why: '颜色没走令牌：' + bad.join('，') });
  }
}

function buildAudit(srcTexts) {
  const sec = h('section', { class: 'dg-sec', id: 'dg-audit' });
  const box = h('div', { class: 'dg-demo' });
  const findings = [];
  let blocked = [];
  const unread = [];
  // 谁被真的用过：CSSOM 与源文本各收一遍，取并集（简写里的 var() 只有原文看得见）
  const refs = new Set();
  const collect = (rules) => {
    for (const r of rules) {
      if (r.cssRules && r.cssRules.length) collect(r.cssRules);
      if (!r.style) continue;
      for (const m of (r.style.cssText || '').matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) refs.add(m[1]);
    }
  };
  for (const s of document.styleSheets) {
    const file = (s.href || '').split('/').pop();
    try { walk(s.cssRules, file, findings, ''); collect(s.cssRules); } catch { blocked.push(file); }
    const text = srcTexts.get(file);
    if (text == null) { if (file) unread.push(file); continue; }
    textAudit(text, file, findings);
    for (const m of text.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) refs.add(m[1]);
  }
  const unref = [...ROOT.keys()].filter((k) => !refs.has(k));
  const ghost = [...THEME.keys()].filter((k) => !ROOT.has(k));
  const verdict = h('p', { class: 'dg-note' });
  verdict.textContent = (blocked.length || unread.length)
    ? `有 ${new Set([...blocked, ...unread]).size} 张样式表没被完整核对（规则读不到：${blocked.join('，') || '无'}；原文读不到：${unread.join('，') || '无'}）——这一项在本机算「未测」，不算通过。`
    : findings.length
      ? `散账 ${findings.length} 处：正文里还有没走档位的数值或没走令牌的颜色。逐条列在下面。`
      : '散账 0 处：正文里每个数值都能在上面的令牌表里找到对应档位，每条颜色都走令牌（CSSOM 与源文本各扫一遍）。';
  const list = h('div', { class: 'dg-rows' });
  const extra = (sel, text) => list.append(h('div', { class: 'dg-row' }, [
    h('code', { class: 'dg-k', text: sel }), h('span', { class: 'dg-chip' }),
    h('span', { class: 'dg-v', text: '—' }), h('span', { class: 'dg-use', text }),
  ]));
  for (const f of findings) {
    list.append(h('div', { class: 'dg-row' }, [
      h('code', { class: 'dg-k', text: `${f.file}:${f.sel.slice(0, 24)}` }),
      h('span', { class: 'dg-chip' }),
      h('span', { class: 'dg-v', text: `${f.prop}: ${f.v}` }),
      h('span', { class: 'dg-use', text: f.why }),
    ]));
  }
  for (const k of unref) extra('未被引用', `${k} 在 :root 里声明了，但三张样式表里没有任何一处 var() 引用它——要么用上，要么删掉，别让它当一份假档位。`);
  for (const k of ghost) extra('主题块越界', `${k} 只在主题块里覆盖，:root 里没有这一条：浅色会读到一个没有深色对照的值。`);
  box.append(verdict, list);
  sec.append(h('h2', { text: '散账核对（规则树 + 源文本，两路各扫一遍）' }));
  sec.append(h('p', { class: 'dg-note', text: '数值走浏览器解析出来的规则树；颜色走源文本。分开是有原因的：这一版浏览器把带 var() 的简写序列化成了一串空的长写，' +
    '只看规则树的话，「字面色和 var() 写在同一条 background 里」那类会整条消失，而且「这枚令牌没人引用」也会跟着误报。' +
    ':root 与主题块两边都不算散账——那些数本来就该是字面的。' }));
  sec.append(box);
  document.querySelector('.dg-main').append(sec);
  const root = document.documentElement;
  root.dataset.dgFindings = String(findings.length);
  root.dataset.dgBlocked = blocked.join(',') || 'none';
  root.dataset.dgSrcUnread = unread.join(',') || 'none';
  root.dataset.dgSheets = String(document.styleSheets.length);
  root.dataset.dgUnref = unref.join(',') || 'none';
  root.dataset.dgThemeGhost = ghost.join(',') || 'none';
  root.dataset.dgThemeCount = String(THEME.size);
  root.dataset.dgUnlisted = String(Number(root.dataset.dgListed) - Number(root.dataset.dgRootTokens));
  root.dataset.dgReduce = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'on' : 'off';
  // 两档必须真的分得开：浅色若没盖住底与字，上面那些断言全过但页面是瞎的。
  // 这里量的是令牌本身，不是 body 的计算样式——body 的底是一条渐变，背景色那一格是透明的。
  const lum = (rgb) => {
    const [r, g, b] = rgb.match(/\d+/g).map(Number).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const bg = read('--bg-0', 'background-color');
  const ink = read('--ink', 'color');
  const [l1, l2] = [lum(bg), lum(ink)].sort((a, b) => b - a);
  root.dataset.dgFace = JSON.stringify({ bg, ink, ratio: ((l1 + 0.05) / (l2 + 0.05)).toFixed(2) });
  root.dataset.dgSample = JSON.stringify({
    fs3: read('--fs-3', 'font-size'), sp5: read('--sp-5', 'padding-top'), rsm: read('--r-sm', 'border-radius'),
    fill: read('--on-fill', 'color'), press: read('--on-press', 'color'),
    // 动效这一档不能用计算样式来验：系统开了「减弱动效」时，末尾那条 reduce 规则会把
    // 所有 transition-duration 压成 0.001ms，量到的是「生效值」而不是令牌值。所以读声明原文。
    tpress: (ROOT.get('--t-press') || [{}])[0].raw || '',
  });
}

meta();
buildGroups();
buildMotion();
buildAtoms();
buildSurfaces();
buildSpecial();
buildRest();
// 源文本要异步取；取不到就带空表进核对，页面会把它标成「未测」而不是悄悄通过。
loadSources().then(buildAudit).catch(() => buildAudit(new Map()));
addEventListener('resize', () => { meta(); });
