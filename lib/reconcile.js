/**
 * 改稿核对的纯函数层：段落差异、信号统计、建议级别、清单渲染。
 *
 * 命令行（`skills/novel-draft/tools/reconcile-chapter.mjs`）与 Web 面板
 * （`lib/index.js` 的 `/novel-panel/*` 路由）共用这一份实现，所以两条路径
 * 给出的级别、段数、报告文字必须一致——不要在任何一侧另写一套。
 *
 * 只用 Node 内置模块。
 * @module dsh-novel-assistant/lib/reconcile
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { countWords, normalizeText } from './versions.js'

// ---------- 字数与信号 ----------
/** 带单位的数字。单位表与 check-chapter.mjs 保持一致。 */
export const NUMBER_UNIT = /([〇零一二三四五六七八九十百千万两\d]+)(尺|寸|丈|石|斗|升|斤|贯|文|里|料)/g
const DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/**
 * 中文数字转阿拉伯数字（只处理到「万」，够用）。
 * @param {string} text 数字文本
 * @returns {number} 数值
 */
export function toNumber(text) {
  if (/^\d+$/.test(text)) return Number(text)
  let total = 0
  let section = 0
  let num = 0
  for (const ch of text) {
    if (ch in DIGIT) num = DIGIT[ch]
    else if (ch === '十') { section += (num || 1) * 10; num = 0 }
    else if (ch === '百') { section += (num || 1) * 100; num = 0 }
    else if (ch === '千') { section += (num || 1) * 1000; num = 0 }
    else if (ch === '万') { total += (section + num) * 10000; section = 0; num = 0 }
  }
  return total + section + num
}

/**
 * 正文里的「数字+单位」集合（已归一，七尺 = 7尺）。
 * @param {string} text 正文
 * @returns {Set<string>} 归一后的数字 token
 */
export const numberTokens = (text) => new Set([...text.matchAll(NUMBER_UNIT)].map((m) => `${toNumber(m[1])}${m[2]}`))

/** 「几尺几寸」这类复合量，用来判断改动是不是在往设定库记的值靠。 */
const COMPOUND = /[〇零一二三四五六七八九十百千万两\d]+尺[〇零一二三四五六七八九十百千万两\d]+寸/g

/**
 * 复合量集合（原文写法，不归一：七尺二寸）。
 * @param {string} text 正文
 * @returns {Set<string>} 复合量
 */
export const compoundTokens = (text) => new Set(text.match(COMPOUND) ?? [])

/**
 * 伏笔编号集合（F001 形式）。
 * @param {string} text 正文
 * @returns {Set<string>} 编号
 */
export const fxTokens = (text) => new Set(text.match(/F\d{3}/g) ?? [])

/** 这些字打头/结尾的多半不是人名，用来压掉「他说」里的噪声。 */
export const STOP_NAME = /[的了着过上下出起来去在是有个把被和与就都也还又很最更不没这那他她我你谁么什怎面眼手嘴心身头口脚脸耳鼻眉]/

/**
 * 已知人名：小传文件是拼音命名（zhao-gui.md），正文里写的是汉字，所以必须读内容。
 * 先看 _index.md 的表格首列，再补每个小传的 H1 标题。
 * @param {string} projectDir 项目目录
 * @returns {Set<string>} 人名
 */
export function knownNames(projectDir) {
  const names = new Set()
  const dir = join(projectDir, 'bible', 'characters')
  if (!existsSync(dir)) return names
  const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
  const index = read(join(dir, '_index.md'))
  for (const line of index.split(/\r?\n/)) {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
    const first = cells[0] || ''
    if (/^[\u3400-\u9fff]{2,4}$/.test(first) && first !== '姓名') names.add(first)
  }
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md') || entry.startsWith('_')) continue
    const heading = read(join(dir, entry)).match(/^#\s+([^\s（(]{2,4})/m)
    if (heading) names.add(heading[1])
  }
  return names
}

/**
 * 正文段落：去掉注释、标题与空段。
 * @param {string} text 正文
 * @returns {string[]} 段落
 */
export function paragraphs(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^#{1,6}\s.*$/gm, ' ')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

const squash = (s) => s.replace(/\s+/g, '')

/**
 * 段落级差异：LCS，相邻的删 + 增合并成一处「改写」。
 * @param {string[]} before 旧段落
 * @param {string[]} after 新段落
 * @returns {Array<{at: string, removed: string[], added: string[]}>} 改动处
 */
export function diffParagraphs(before, after) {
  const a = before.map(squash)
  const b = after.map(squash)
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'equal', oldIndex: i, newIndex: j }); i += 1; j += 1 }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'delete', oldIndex: i }); i += 1 }
    else { ops.push({ type: 'insert', newIndex: j }); j += 1 }
  }
  while (i < n) { ops.push({ type: 'delete', oldIndex: i }); i += 1 }
  while (j < m) { ops.push({ type: 'insert', newIndex: j }); j += 1 }

  const hunks = []
  for (let k = 0; k < ops.length; k += 1) {
    const op = ops[k]
    if (op.type === 'equal') continue
    const group = [op]
    while (k + 1 < ops.length && ops[k + 1].type !== 'equal') { k += 1; group.push(ops[k]) }
    const removed = group.filter((g) => g.type === 'delete').map((g) => before[g.oldIndex])
    const added = group.filter((g) => g.type === 'insert').map((g) => after[g.newIndex])
    hunks.push({
      at: (removed.length ? `原第 ${group.find((g) => g.type === 'delete').oldIndex + 1} 段` : `新第 ${group.find((g) => g.type === 'insert').newIndex + 1} 段`),
      removed,
      added,
    })
  }
  return hunks
}

/**
 * 摘要用的截断。
 * @param {string} s 文本
 * @param {number} [n] 上限字数
 * @returns {string} 截断结果
 */
export const clip = (s, n = 180) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 取 digest.md 里这一章的行。
 * @param {string} projectDir 项目目录
 * @param {number} num 章号
 * @returns {string} 表格行，没有则空串
 */
export function digestRow(projectDir, num) {
  try {
    const rows = readFileSync(join(projectDir, 'bible', 'digest.md'), 'utf8').split(/\r?\n/)
    return rows.find((line) => new RegExp(`^\\|\\s*${num}\\s*\\|`).test(line)) || ''
  } catch {
    return ''
  }
}

// ---------- 建议级别 ----------
// 「可能改变事件结果」的动词。列不全也无妨——它只用来提示按结构级复核，误报的代价是多问一句。
export const EVENT_VERB = /(死|杀|伤|斩|处死|结案|定罪|收监|押|抓捕|捕|招供|供出|供|画押|盖印|签字|革职|逐出|流放|发配|封仓|开仓|放人|放走|答应|认下|反悔|取消|揭穿|烧|藏|瞒|离开|叛|换|娶|嫁|夺|救)/

/**
 * 按信号给建议级别。脚本只数信号，级别最终由人判定。
 * @param {Array<{at: string, removed: string[], added: string[]}>} hunks 改动处
 * @param {Set<string>} names 已知人名
 * @param {string} before 旧正文
 * @param {string} after 新正文
 * @returns {{level: number, structural: boolean, reasons: string[], fxNow: string[], fxGone: string[], numNow: string[], numGone: string[]}} 判定
 */
export function classify(hunks, names, before, after, facts = '') {
  const addedText = hunks.flatMap((h) => h.added).join('\n')
  const removedText = hunks.flatMap((h) => h.removed).join('\n')
  const beforeFx = fxTokens(before)
  const afterFx = fxTokens(after)
  // 伏笔编号按整章比：「这一章还提不提它」才是关键信号。
  const fxNow = [...afterFx].filter((f) => !beforeFx.has(f))
  const fxGone = [...beforeFx].filter((f) => !afterFx.has(f))
  // 数字必须按「改动的那几段」局部比，不能按整章集合差：
  // 「七尺二寸」改成「七尺一寸」时，只要「一寸」「二寸」在别处还出现过，
  // 整章集合差就是空的 —— 这正是用户遇到的「数字改了却报级别 1」。
  const numNow = new Set()
  const numGone = new Set()
  for (const h of hunks) {
    const addedNums = numberTokens(h.added.join('\n'))
    const removedNums = numberTokens(h.removed.join('\n'))
    for (const t of addedNums) if (!removedNums.has(t)) numNow.add(t)
    for (const t of removedNums) if (!addedNums.has(t)) numGone.add(t)
  }
  const numNowList = [...numNow].sort()
  const numGoneList = [...numGone].sort()
  // 「改回设定库记的值」不算事实改动：hunk 里新写的复合量在 facts.md 里，旧的不在。
  // 例：把误改成「七尺一寸」的闸深改回 facts.md 的「七尺二寸」——这明明是收口，不该再挂债。
  const factsCompounds = compoundTokens(facts)
  let alignedWithFacts = ''
  if (factsCompounds.size) {
    for (const h of hunks) {
      const added = compoundTokens(h.added.join('\n'))
      const removed = compoundTokens(h.removed.join('\n'))
      const back = [...added].find((t) => factsCompounds.has(t))
      const away = [...removed].some((t) => factsCompounds.has(t))
      if (back && !away) { alignedWithFacts = back; break }
    }
  }
  // 人名与台词只在「新出现」时才算事实变化：同一个人的段落换了个形容词不是改事实。
  const namesInAdded = [...names].filter((name) => addedText.includes(name))
  const nameAdd = namesInAdded.filter((name) => !removedText.includes(name))
  const nameGone = [...names].filter((name) => removedText.includes(name) && !addedText.includes(name))
  const quoteAdd = /[「“"]/.test(addedText) && !/[「“"]/.test(removedText)
  const hasEvent = EVENT_VERB.test(addedText)
  const reasons = []
  if (fxNow.length) reasons.push(`新出现伏笔编号 ${fxNow.join('、')}`)
  if (fxGone.length) reasons.push(`不再出现的伏笔编号 ${fxGone.join('、')}（若是被删掉，伏笔表的埋设章要跟着改）`)
  if (alignedWithFacts) reasons.push(`改回设定库记的 ${alignedWithFacts}（与 bible/facts.md 一致）`)
  else if (numNowList.length) reasons.push(`新出现数字 ${numNowList.join('、')}`)
  if (!alignedWithFacts && numGoneList.length) reasons.push(`不再出现的数字 ${numGoneList.join('、')}`)
  if (nameAdd.length) reasons.push(`新出场／新被提到 ${nameAdd.join('、')}`)
  if (nameGone.length) reasons.push(`不再出现 ${nameGone.join('、')}（可能是删了戏份）`)
  if (quoteAdd) reasons.push('新加/新删了台词（「谁说了什么」变了）')
  if (hasEvent) reasons.push('出现事件性动词（可能改变事件结果，需人工判定）')

  let level = 1
  const numberMoved = alignedWithFacts ? false : Boolean(numNowList.length || numGoneList.length)
  if (fxNow.length || fxGone.length || numberMoved || nameAdd.length || nameGone.length || quoteAdd) level = 2
  // 事件性动词 + 有具体人物 → 建议按结构级复核。宁可多提示一次，也别让改结局悄悄过去。
  const structural = hasEvent && namesInAdded.length > 0
  if (structural) level = 3
  return { level, structural, reasons, fxNow, fxGone, numNow: numNowList, numGone: numGoneList, alignedWithFacts }
}

/**
 * 把「旧稿 → 新稿」算成一份核对 payload。命令行与面板都从这里拿结论。
 * @param {object} input 输入
 * @param {number} input.chapter 章号
 * @param {string} input.key `vol-01/ch-001.md` 形式的相对路径
 * @param {string} input.beforeText 存档正文
 * @param {string} input.afterText 当前正文
 * @param {Set<string>} input.names 已知人名
 * @param {{version: number, archivedAt?: string}} input.baseline 存档信息
 * @param {string} [input.digestRowText] 现有摘要行
 * @returns {object} 核对结果
 */
export function buildPayload({ chapter, key, beforeText, afterText, names, baseline, digestRowText = '', factsText = '' }) {
  const beforeParas = paragraphs(beforeText)
  const afterParas = paragraphs(afterText)
  const hunks = diffParagraphs(beforeParas, afterParas)
  const verdict = classify(hunks, names, beforeText, afterText, factsText)
  const beforeWords = countWords(beforeText)
  const afterWords = countWords(afterText)
  return {
    chapter,
    file: key,
    changed: true,
    baseline: { version: baseline.version, words: beforeWords, archivedAt: baseline.archivedAt ?? null },
    current: { words: afterWords, paragraphs: afterParas.length },
    deltaWords: afterWords - beforeWords,
    deltaParagraphs: afterParas.length - beforeParas.length,
    commentOnly: hunks.length === 0 && normalizeText(beforeText) !== normalizeText(afterText),
    suggestedLevel: verdict.level,
    structuralHint: verdict.structural,
    reasons: verdict.reasons,
    hunks,
    fxAdded: verdict.fxNow,
    fxRemoved: verdict.fxGone,
    numberAdded: verdict.numNow,
    numberRemoved: verdict.numGone,
    alignedWithFacts: verdict.alignedWithFacts || '',
    digestRow: digestRowText,
    wordsBefore: beforeWords,
    wordsAfter: afterWords,
    paragraphsBefore: beforeParas.length,
    paragraphsAfter: afterParas.length,
  }
}

/**
 * 渲染清单正文（Markdown）。命令行落盘与面板显示用同一段文字。
 * @param {object} payload {@link buildPayload} 的结果
 * @returns {string} Markdown
 */
export function renderReport(payload) {
  const { chapter, baseline, wordsBefore, wordsAfter, paragraphsBefore, paragraphsAfter, hunks, suggestedLevel, structuralHint } = payload
  const L = []
  L.push(`# 第 ${chapter} 章 · 改稿清单`)
  L.push('')
  L.push(`- 存档：v${baseline.version ?? '—'}（${baseline.archivedAt || '时间未记'}，${wordsBefore} 字，${paragraphsBefore} 段）`)
  L.push(`- 当前：${wordsAfter} 字（${payload.deltaWords >= 0 ? '+' : ''}${payload.deltaWords}），${paragraphsAfter} 段（${payload.deltaParagraphs >= 0 ? '+' : ''}${payload.deltaParagraphs}）`)
  L.push(`- 生成时间：${new Date().toISOString()}`)
  L.push('')
  if (payload.commentOnly) {
    L.push('## 结论：只有末尾注释变了，正文没动')
    L.push('')
    L.push('这是记账动作，不是改稿：确认注释里的条目都落到了设定库，这一章就算完，不会有「待更新设定」。')
    return `${L.join('\n')}\n`
  }
  L.push(`## 结论：有改动，脚本建议级别 ${suggestedLevel}${structuralHint ? '（可能到结构级）' : ''}`)
  L.push('')
  L.push('**级别由你判定，脚本只数信号。** 依据：')
  for (const r of payload.reasons.length ? payload.reasons : ['没有伏笔编号、数字、人物名或台词变化']) L.push(`- ${r}`)
  L.push('')
  L.push('## 1 改了哪几段')
  L.push('')
  hunks.forEach((h, index) => {
    L.push(`### ${index + 1}. ${h.at}`)
    L.push('')
    for (const p of h.removed) L.push(`- 原：${clip(p)}`)
    for (const p of h.added) L.push(`- 现：${clip(p)}`)
    L.push('')
  })
  L.push('## 2 汇总')
  L.push('')
  L.push('| 项 | 存档 | 当前 |')
  L.push('| --- | --- | --- |')
  L.push(`| 字数 | ${wordsBefore} | ${wordsAfter} |`)
  L.push(`| 段数 | ${paragraphsBefore} | ${paragraphsAfter} |`)
  L.push('')
  if (payload.fxAdded.length) L.push(`新出现的伏笔编号：${payload.fxAdded.join('、')}——若是新埋，先补 bible/foreshadowing.md 再继续。`)
  if (payload.fxRemoved.length) L.push(`不再出现的伏笔编号：${payload.fxRemoved.join('、')}——若是删掉了埋设，伏笔表那一行要改或作废。`)
  if (payload.numberAdded.length) L.push(`新出现的数字：${payload.numberAdded.join('、')}——核对 bible/facts.md，表里没有就先补表。`)
  if (payload.numberRemoved.length) L.push(`不再出现的数字：${payload.numberRemoved.join('、')}——表里若记着这个值，确认是改值还是删掉了这个说法。`)
  L.push('')
  L.push('## 3 按级别要动的账本')
  L.push('')
  L.push('| 级别 | 判断标准 | 要改的地方 |')
  L.push('| --- | --- | --- |')
  L.push('| 1 措辞级 | 换比喻、删形容词、调句序，人物/事件/数字都没变 | 设定库不动；改完即完（存档已自动前进） |')
  L.push('| 2 事实级 | 数字、器物、谁在场、谁说了什么变了 | `facts.md` / `timeline.md` / `characters/` / `digest.md` 四张表逐项核对，改完再清「设定待更新」 |')
  L.push('| 3 结构级 | 事件结果、信息差、伏笔取消或提前、人物动机变了 | **先停**：grep 后续细纲与已写正文，列「哪些章哪段会失效」，用户确认后才动 `outline/` 与细纲 |')
  L.push('')
  L.push('## 4 这一章现有的摘要行')
  L.push('')
  L.push(payload.digestRow ? `\`${payload.digestRow}\`` : '（`bible/digest.md` 里没有这一章的行）')
  L.push('')
  L.push('级别 ≥ 2 且改了状态变化，就把这一行改掉，行尾加「（改）」。')
  L.push('')
  L.push('## 5 下一步')
  L.push('')
  L.push('1. 你判定级别（上面给的只是建议）。')
  L.push('2. 按级别改表；级别 3 先问用户，不要静默改大纲。')
  L.push(`3. 改完设定库：面板按「设定已更新」，或跑 \`reconcile-chapter.mjs ${chapter} --archive\` 清掉「设定待更新」。`)
  return `${L.join('\n')}\n`
}

/**
 * 落盘清单到 `reviews/draft-edits/ch-YYY.md`。
 * @param {string} projectDir 项目目录
 * @param {object} payload 核对结果
 * @returns {string} 相对项目目录的报告路径
 */
export function writeReport(projectDir, payload) {
  const dir = join(projectDir, 'reviews', 'draft-edits')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `ch-${String(payload.chapter).padStart(3, '0')}.md`)
  writeFileSync(file, renderReport(payload), 'utf8')
  return relative(projectDir, file)
}
