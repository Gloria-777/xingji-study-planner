// App（Capacitor 壳）里的原生提醒通道。
// 网页端 window.Capacitor 不存在，这里每个函数都直接返回「不可用」，网页行为完全不受影响。
const bridge = () => (window.Capacitor && window.Capacitor.Plugins ? window.Capacitor.Plugins.NativeReminder : null);

export const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
export const hasNativeReminder = () => !!bridge();

/** 状态栏/导航栏图标的深浅只由原生决定（edge-to-edge 下背景透页色），换外观时通知一次；网页端没这个插件，直接返回。 */
export async function syncNativeAppearance(t) {
  const p = window.Capacitor && window.Capacitor.Plugins ? window.Capacitor.Plugins.Appearance : null;
  if (!p) return;
  try {
    await p.setStatusBar({ light: t === 'light' });
  } catch { /* 桥没就绪不影响本次换肤 */ }
}

/**
 * 文案里指「数据存在哪一类环境」时的说法。
 * App 和浏览器是两套独立存储，所以「浏览器」这个词在 App 里是错的，不能照抄。
 */
export const dataPlace = () => (isNativeApp() ? '这台手机 App 的本机存储' : '这台设备的浏览器');
export const hostWord = () => (isNativeApp() ? '这个 App' : '这个网页');

/** 原生侧真实状态：通知权限、精确闹钟权限、厂商后台管控、已排条数。拿不到插件就返回 null。 */
export async function nativeStatus() {
  const p = bridge();
  if (!p) return null;
  try {
    return await p.status();
  } catch (e) {
    return null;
  }
}

export async function requestNativeNotifications() {
  const p = bridge();
  if (!p) return { granted: false, reason: '不在 App 里' };
  try {
    return await p.requestNotifications();
  } catch (e) {
    return { granted: false, reason: e && e.message ? e.message : '申请失败' };
  }
}

/**
 * 把「本机当前还没到点的提醒」整份交给系统闹钟：先清空原生侧的旧调度，再逐条重排。
 * 整份替换而不是增量改，是因为课表一改、提前几分钟一调，派生提醒的时间会成片变化；
 * 条数只有几十条，全量重排比维护两套状态更可靠。
 */
export async function nativeSync(items) {
  const p = bridge();
  if (!p) return { ok: false, reason: 'no-plugin' };
  try {
    await p.cancelAll();
  } catch (e) { /* 清空失败也继续重排，后面按 id 覆盖 */ }
  const list = (items || []).filter((i) => i && i.id && Number.isFinite(i.at) && i.at > Date.now());
  let exact = true;
  const failed = [];
  for (const i of list) {
    try {
      const r = await p.schedule({ id: String(i.id), title: i.title || '星迹提醒', body: i.body || '', at: i.at });
      if (!r || r.exact === false) exact = false;
      if (r && r.ok === false) failed.push(i.id);
    } catch (e) {
      failed.push(i.id);
    }
  }
  return { ok: failed.length === 0, count: list.length - failed.length, exact, failed };
}

export async function nativeCancel(id) {
  const p = bridge();
  if (!p) return { ok: false };
  try {
    await p.cancel({ id: String(id) });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message };
  }
}

export async function nativeRing() {
  const p = bridge();
  if (!p) return { ok: false, reason: '不在 App 里' };
  try {
    return await p.ringTest();
  } catch (e) {
    return { ok: false, reason: e && e.message };
  }
}

export const nativeOpen = {
  exact: 'openExactAlarmSettings',
  notify: 'openNotificationSettings',
  battery: 'openBatterySettings',
  app: 'openAppSettings',
};

export async function openNativeSettings(which) {
  const p = bridge();
  const fn = p && p[nativeOpen[which]];
  if (!fn) return { opened: false, reason: '不在 App 里' };
  try {
    return await fn();
  } catch (e) {
    return { opened: false, reason: e && e.message };
  }
}
