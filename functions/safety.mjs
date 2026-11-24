// 服务端高风险消息流程：命中即跳过大模型，直接返回固定的求助指引。
// 只依赖模型的提示词不构成安全处理，所以这一层写在函数里；这里只是关键词/短语的初步识别，尽力而为，
// 识别不了所有风险，会漏检也会误检，不能当成经过认证的风险评估。
const CRISIS_PHRASES = [
  // 中文：明确指向自杀/自伤/即时危险的说法
  '自杀', '轻生', '寻死', '不想活', '活不下去', '不想活着', '结束自己的生命',
  '了结自己', '死了算了', '死掉算了', '去死', '不想在这个世界上', '不在了就好',
  '自残', '伤害自己', '割腕', '割自己', '划伤自己', '吞药', '吃药自杀', '过量吃药', '烧炭',
  '写遗书', '留遗书', '交代后事', '安排身后事', '最后一次跟你说',
  '跳下去', '从楼上跳', '从桥上跳', '卧轨', '上吊', '站马路中间',
  '一起死', '同归于尽', '带他死', '无法保证安全', '我现在很危险', '有人要伤害我',
  // 英文
  'kill myself', 'end my life', 'end ones life', 'suicide', 'suicidal', 'take my own life',
  'no reason to live', 'want to die', 'dont want to live', 'dont want to be alive',
  'self harm', 'selfharm', 'hurt myself', 'cut myself', 'overdose', 'jump off', 'hang myself',
  'goodbye letter', 'cant go on', "can't go on",
];

// 只用于减轻误检：这些说法里带「死」但基本是吐槽，不是危险信号。
const SOFTENERS = ['累死', '忙死', '笑死', '饿死', '热死', '冻死', '急死', '烦死', '气死', '困死', '卷死', '社死', '想睡死', '考死', '难死', '哭死', '爱死', '想死你'];

function normalize(text) {
  return String(text || '')
    .replace(/[\r\n\t]+/g, ' ')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ');
}

/**
 * @param {string} text 学生这一轮说的话（服务端已经截断过长度）
 * @returns {{crisis: boolean, hits: string[]}}
 */
export function assessRisk(text) {
  const flat = normalize(text);
  if (!flat) return { crisis: false, hits: [] };
  const cleaned = SOFTENERS.reduce((s, w) => s.split(w).join(''), flat);
  const hits = CRISIS_PHRASES.filter((p) => cleaned.includes(p));
  return { crisis: hits.length > 0, hits };
}

const COMMON = `我先停下手上的安排，说一句比学习重要的话。

你写的这些让我担心你此刻的安全。请先做三件事：
1. 离开可能伤害到自己的东西或地方，去一个有人的、亮的空间。
2. 现在就联系一个现实中可信任的人（家人、朋友、室友、老师、辅导员），把你在哪、什么状态告诉他/她。如果马上有危险，拨 110；需要医疗帮助，拨 120。
3. 想跟受过训练的人说话，可以拨 12356（中国大陆全国统一心理援助热线，24 小时）；不在中国大陆就用当地的危机热线。

我是学习和时间规划的工具，不是心理危机服务，这件事不该由我来接。等你确认自己安全了，学习的事随时再谈——到时候我会把安排放到最轻。`;

/** 固定回复：不调用模型，不给动作，不写任何云端数据。 */
export function crisisReply(agent) {
  const lead = agent === 'work'
    ? '这一轮我没有生成任何课程、任务或时间安排。'
    : '这一轮我只是按服务端的安全流程回你，没有让大模型来接这段话。';
  return `${lead}\n\n${COMMON}`;
}
