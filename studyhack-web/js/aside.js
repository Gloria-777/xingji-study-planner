// 宽屏右栏：只放这台设备上的真实计数和页面里已经写过的口径，不加新承诺、不编数据。
// 桌面档在 ≥1240px 才显示（css/desktop.css）；手机与 App 既看不到也不占位。
import { h } from './ui.js';
import { state } from './state.js';

const len = (arr) => (Array.isArray(arr) ? arr.length : 0);

export function factsCard() {
  const tasks = state.tasks || [];
  const todo = tasks.filter((t) => t.status !== 'done').length;
  const reminders = state.reminders || [];
  const activeRem = reminders.filter((r) => r.status === 'active').length;
  const rows = [
    ['课程', len(state.courses)],
    ['任务', `${tasks.length}（待做 ${todo}）`],
    ['目标', len(state.goals)],
    ['计划', len(state.plans)],
    ['专注记录', len(state.sessions)],
    ['提醒', `${reminders.length}（待响 ${activeRem}）`],
  ];
  return h('div', { class: 'card card-aside' },
    h('h3', { text: '本机数据' }),
    h('div', { class: 'aside-facts' }, ...rows.map(([k, v]) => h('div', { class: 'aside-fact' },
      h('span', { text: k }), h('b', { text: String(v) })))),
    h('p', { class: 'hint', text: '只统计这台设备上的记录；换设备要用导出 / 导入。' }),
  );
}

export function quoteCard(title, lines) {
  return h('div', { class: 'card card-aside' },
    h('h3', { text: title }),
    h('ul', { class: 'aside-list' }, ...lines.map((t) => h('li', { text: t }))),
  );
}

export function pageAside(...cards) {
  return h('aside', { class: 'page-aside', 'aria-label': '本页补充' }, ...cards);
}
