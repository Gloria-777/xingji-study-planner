// 外观主题：三档「跟随系统 / 深色 / 浅色」。
// 偏好只存本机 localStorage，和「使用须知」那一档确认（xj-notice-ack）同类：
// 不写进 IndexedDB，不随导出/导入走，也不跨设备同步——换一台机器就得重新选一次。
import { syncNativeAppearance } from './native.js';

const KEY = 'xj-theme-mode';
const mqLight = matchMedia('(prefers-color-scheme: light)');
const listeners = new Set();

export const MODES = [
  ['system', '跟随系统', '按操作系统现在的深浅色走，系统改了这边跟着改。'],
  ['dark', '深色', '分层星空与玻璃卡片，一直以来的样子。'],
  ['light', '浅色', '近中性浅灰蓝底、白卡细描边，顶部留一点天蓝光晕；紫蓝保留但整个压深一档，不出场的是星点与深空层。'],
];

/* 没设过偏好的人取「深色」，不是「跟随系统」：
   这一版之前界面只有深色一张脸，默认档必须还是那张脸——否则操作系统是浅色的人一打开就被换了样。
   「跟随系统」是这一页上明确选出来的第三档。 */
const readMode = () => {
  let m = '';
  try { m = localStorage.getItem(KEY) || ''; } catch { return 'dark'; }
  return m === 'dark' || m === 'light' || m === 'system' ? m : 'dark';
};

// 三档模式落到实际生效的那一档。
export const resolve = (mode) => {
  const m = mode || readMode();
  return m === 'system' ? (mqLight.matches ? 'light' : 'dark') : m;
};

export const theme = () => document.documentElement.dataset.theme || 'dark';
export const getMode = readMode;

export function apply(mode) {
  const t = resolve(mode);
  document.documentElement.dataset.theme = t;
  // 系统那一条状态栏底色跟着令牌走，别再手写一个和 --bg-0 不同的十六进制
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim());
  syncNativeAppearance(t);
  for (const fn of listeners) fn(t);
  return t;
}

export function setMode(mode) {
  try { localStorage.setItem(KEY, mode); } catch { /* 隐私模式写不进去：本次浏览内仍然生效 */ }
  return apply(mode);
}

export const onTheme = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// 「跟随系统」这一档是活的：系统切换深浅色时，没手动选过的人应该立刻跟着变。
if (mqLight.addEventListener) mqLight.addEventListener('change', () => { if (readMode() === 'system') apply(); });
