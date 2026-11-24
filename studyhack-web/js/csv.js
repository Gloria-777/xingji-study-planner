// CSV / TSV 课表解析：纯函数，导入前先出核对清单，用户确认才写入
import { DOW, toMin, WEEK_MAX } from './ui.js';

const HEADER_MAP = {
  name: ['name', '课程', '课程名称', '科目', '课程名'],
  day: ['day', 'weekday', '星期', '周', 'dayofweek', '周几'],
  start: ['start', '开始时间', '开始', 'starttime', 'from'],
  end: ['end', '结束时间', '结束', 'endtime', 'to'],
  location: ['location', 'room', '地点', '教室', '上课地点'],
  teacher: ['teacher', '老师', '教师', '任课教师'],
  weekStart: ['weekstart', '起始周', '开始周', '起', '第几周起'],
  weekEnd: ['weekend', '结束周', '截止周', '止', '第几周止'],
  parity: ['parity', '单双周', '单周双周', 'weektype'],
};

function splitLines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
}
/** 支持带引号字段： "高等数学,上",周一 */
function splitRow(line, delim) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}
function detectDelim(lines) {
  const head = lines[0] || '';
  const count = (d) => (head.match(new RegExp(`\\${d}`, 'g')) || []).length;
  const tab = count('\t'), comma = count(','), semi = count(';');
  const best = Math.max(tab, comma, semi);
  if (!best) return null;
  return best === tab ? '\t' : best === comma ? ',' : ';';
}
function headerKeys(header, delim) {
  const cells = header.split(delim).map((x) => x.trim().toLowerCase().replace(/\s+/g, ''));
  const idx = {};
  for (const [key, alts] of Object.entries(HEADER_MAP)) {
    const i = cells.findIndex((c) => alts.includes(c) || alts.some((a) => c === a.replace(/\s+/g, '')));
    if (i >= 0) idx[key] = i;
  }
  return idx;
}
function normDay(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s.replace(/[^\d]/g, ''));
  if (n >= 1 && n <= 7 && /^\d+$/.test(s)) return n;
  const bare = s.replace(/^(星期|礼拜|周)/, '');
  if (/^\d$/.test(bare)) return bare === '0' ? 7 : Number(bare);
  const i = DOW.findIndex((x) => x === s);
  if (i >= 0) return i + 1;
  const m = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
  const ch = s.replace(/[^一-龥]/g, '').slice(-1);
  return m[ch] || null;
}
function normTime(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{1,2})[:：.．]?(\d{2})?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2] || 0);
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
function normParity(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'all';
  if (/单/.test(s)) return 'odd';
  if (/双/.test(s)) return 'even';
  if (/^1$/.test(s)) return 'odd';
  if (/^2$/.test(s)) return 'even';
  if (/全|每周|all/i.test(s)) return 'all';
  return 'all';
}
const normWeek = (v, dflt) => {
  const n = Number(String(v ?? '').replace(/[^\d]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.round(n), WEEK_MAX);
};

export const TEMPLATE = `课程名称,星期,开始时间,结束时间,地点,老师,起始周,结束周,单双周
高等数学,周一,08:00,09:40,教一 301,王老师,1,16,每周
数据结构,周三,14:00,15:40,教三 110,赵老师,1,16,单周`;

/**
 * @returns {{rows:Array<{ok:boolean,errors:string[],warnings:string[],course:Object,line:number,input:string}>, delimiter:string, headerFound:boolean, valid:number}}
 */
export function parseCourses(text) {
  const lines = splitLines(text);
  if (!lines.length) return { rows: [], delimiter: '', headerFound: false, valid: 0, error: '内容为空' };
  const delim = detectDelim(lines);
  const usedDelim = delim || '\t';
  const keys = delim ? headerKeys(lines[0], delim) : {};
  const headerFound = delim && Object.keys(keys).length >= 2;
  const body = (headerFound ? lines.slice(1) : lines).filter((l) => l.replace(/[,;，、\t\s]/g, '') !== '');
  // 无表头时按模板列序
  const order = ['name', 'day', 'start', 'end', 'location', 'teacher', 'weekStart', 'weekEnd', 'parity'];
  const rows = body.map((line, i) => {
    const cells = splitRow(line, usedDelim);
    const get = (key) => {
      const idx = headerFound ? keys[key] : order.indexOf(key);
      return idx === undefined || idx < 0 ? '' : cells[idx] ?? '';
    };
    const course = {
      name: String(get('name') || '').trim(),
      day: normDay(get('day')),
      start: normTime(get('start')),
      end: normTime(get('end')),
      location: String(get('location') || '').trim(),
      teacher: String(get('teacher') || '').trim(),
      weekStart: normWeek(get('weekStart'), 1),
      weekEnd: normWeek(get('weekEnd'), 16),
      parity: normParity(get('parity')),
    };
    const errors = [];
    const warnings = [];
    if (cells.every((c) => !c)) { errors.push('这一行是空的'); }
    if (!course.name) errors.push('缺少课程名称');
    if (!course.day) errors.push('星期无法识别（支持 周一 / 1 / 三）');
    if (!course.start) errors.push('开始时间无法识别（支持 08:00 / 8:00 / 8）');
    if (!course.end) errors.push('结束时间无法识别');
    if (course.start && course.end && toMin(course.end) <= toMin(course.start)) errors.push('结束时间不晚于开始时间');
    if (course.weekEnd < course.weekStart) { errors.push('结束周早于起始周'); }
    if (course.parity !== 'all' && course.weekEnd - course.weekStart < 1) warnings.push('只有 1 周且设了单双周，可能只显示一次');
    return {
      ok: errors.length === 0,
      errors, warnings, course, line: (headerFound ? i + 2 : i + 1), input: line,
    };
  });

  // 重复行检测
  const seen = new Map();
  for (const r of rows) {
    if (!r.ok) continue;
    const k = `${r.course.name}|${r.course.day}|${r.course.start}|${r.course.end}`;
    if (seen.has(k)) r.warnings.push(`与第 ${seen.get(k)} 行完全重复，默认不勾选`);
    else seen.set(k, r.line);
  }
  return { rows, delimiter: usedDelim === '\t' ? 'Tab' : usedDelim, headerFound, valid: rows.filter((r) => r.ok).length };
}

/** 与已有课程/本次导入内部的冲突提示 */
export function annotateConflicts(parsed, existing) {
  const mine = parsed.rows.filter((r) => r.ok).map((r) => ({ ...r.course, _row: r }));
  const all = [...existing, ...mine];
  for (const r of parsed.rows) {
    if (!r.ok || r.course._done) continue;
    const clash = all.filter((c) => c._row !== r && c.day === r.course.day
      && toMin(c.start) < toMin(r.course.end) && toMin(c.end) > toMin(r.course.start));
    if (clash.length) {
      r.warnings = [...new Set([...r.warnings, `与 ${clash.map((c) => `${c.name}(${c.start}-${c.end})`).join('、')} 时间重叠`])];
    }
  }
  return parsed;
}
