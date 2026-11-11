#!/usr/bin/env node
/**
 * 章节机器校验：把「字数、残留标记、未登记人名、数字核对」这类不需要判断力的活交给脚本。
 * 主代理自写、自动代笔、手动回填三条通道，落盘后都要跑这一遍。
 *
 *   node check-chapter.mjs novel-project/chapters/vol-01/ch-001.md \
 *     --min 2000 --max 4000 --bible novel-project/bible [--facts <facts.md>]
 *
 * 退出码：0 = 通过（可能带 warn）；1 = 有 error，本章不算写完。
 * 只依赖 Node 内置模块。
 */
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

const CJK = /[\u3400-\u9fff]/u
const CJK_RUN = /[\u3400-\u9fff]+/gu

function parseArgs(argv) {
  const args = { file: '', min: 2000, max: 4000, bible: '', facts: '', json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--min') args.min = Number(argv[++i])
    else if (token === '--max') args.max = Number(argv[++i])
    else if (token === '--bible') args.bible = argv[++i]
    else if (token === '--facts') args.facts = argv[++i]
    else if (token === '--json') args.json = true
    else if (!token.startsWith('--')) args.file = token
  }
  return args
}

const findings = []
const add = (level, id, message, detail) => findings.push({ level, id, message, detail })

/** 字数口径：中日韩汉字逐字计，连续的拉丁字母/数字串按一个词计；注释与代码块不计。 */
function countWords(text) {
  const stripped = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^```[\s\S]*?^```/gm, ' ')
    .replace(/^#{1,6}\s.*$/gm, ' ')
  const cjk = (stripped.match(CJK_RUN) ?? []).join('').length
  const latin = (stripped.match(/[A-Za-z0-9]+/g) ?? []).length
  return cjk + latin
}

/** 数字 + 度量单位：把「七尺二寸」「三千石」「135 斤」抽成可比较的键。 */
const NUMBER_UNIT = /([〇零一二三四五六七八九十百千万两\d]+)(尺|寸|丈|石|斗|升|斤|贯|文|里|料)/g
const DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

function toNumber(text) {
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

/** 返回 Map<"7尺", 出现次数>。中文数字与阿拉伯数字归一，避免「七尺」和「7尺」被当成两回事。 */
function numberTokens(text) {
  const out = new Map()
  for (const match of text.matchAll(NUMBER_UNIT)) {
    const key = `${toNumber(match[1])}${match[2]}`
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

async function knownNames(bibleDir) {
  const names = new Set()
  if (!bibleDir) return names
  try {
    const dir = join(bibleDir, 'characters')
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      names.add(entry.name.replace(/\.md$/, ''))
    }
    const index = await readFile(join(dir, '_index.md'), 'utf8').catch(() => '')
    for (const line of index.split('\n')) {
      if (!line.trim().startsWith('|')) continue
      const first = line.split('|')[1]?.trim()
      if (first && first !== '姓名' && !first.startsWith('-') && first.length <= 12) names.add(first)
    }
  } catch {
    /* bible 目录缺失时跳过人名检查 */
  }
  return names
}

const args = parseArgs(process.argv.slice(2))
if (!args.file) {
  console.error('用法: node check-chapter.mjs <章节文件> [--min 2000] [--max 4000] [--bible novel-project/bible] [--facts <facts.md>]')
  process.exit(2)
}

let raw = ''
try {
  raw = await readFile(args.file, 'utf8')
} catch (error) {
  console.error(`读不到章节文件：${args.file}（${error.message}）`)
  process.exit(2)
}

const body = raw.trim()
if (!body) {
  console.error('章节文件是空的')
  process.exit(2)
}

if (!/^#\s*第\s*\S+\s*章/m.test(body)) add('error', 'title', '缺少「# 第 N 章 标题」一级标题')

const words = countWords(body)
if (words < args.min) add('error', 'length-low', `字数 ${words} 低于下限 ${args.min}`)
else if (words > args.max) add('warn', 'length-high', `字数 ${words} 超出上限 ${args.max}（超过 5000 应先删解释性段落）`)

if (/^\s*```/m.test(body)) add('error', 'fence', '正文里有代码围栏残留，序章/正文不该出现 ``` ')

if (/{{[^}]*}}/.test(body)) {
  const hits = [...new Set(body.match(/{{[^}]*}}/g) ?? [])].slice(0, 5)
  add('error', 'placeholder', '模板占位符没替换', hits.join(' '))
}

const open = (body.match(/<!--/g) ?? []).length
const close = (body.match(/-->/g) ?? []).length
if (open !== close) add('error', 'comment', `HTML 注释不闭合：<!-- ${open} 个，--> ${close} 个`)

for (const marker of ['本章视角人物', '本章发生的一件事', '本章结束时读者的情绪或疑问']) {
  if (body.includes(marker)) add('error', 'scratch-card', `开写前的三行小卡没删：${marker}`)
}

if (!/本章新增事实/.test(body)) add('warn', 'ledger', '末尾没有「本章新增事实」注释块，quick check 会缺账')

const names = await knownNames(args.bible)
if (names.size > 0) {
  const known = [...names]
  // 名字常出现在提示语前，但「脸上浮出」「心里想着」这类短语也会。两条过滤：含虚词的不算，
  // 全章只出现一次的也不算——真要反复登场的角色，不会只说一句话。
  const STOP = /[的了着过上下出起来去在是有个把被和与就都也还又很最更不没这那他她我你谁么什怎面眼手嘴心身头口脚脸耳鼻眉]/
  const hits = new Map()
  for (const match of body.matchAll(/([\u3400-\u9fff]{2,4})(?=[说问道答喊笑骂吼])/g)) {
    const candidate = match[1]
    if (STOP.test(candidate)) continue
    if (known.some((name) => name === candidate || name.includes(candidate) || candidate.includes(name))) continue
    hits.set(candidate, (hits.get(candidate) ?? 0) + 1)
  }
  const suspects = new Set([...hits].filter(([, count]) => count > 1).map(([candidate]) => candidate))
  if (suspects.size > 0) {
    add('warn', 'unknown-name', '疑似未登记人名（也可能是普通词，需人眼确认）', [...suspects].join('、'))
  }
}

const pendingFacts = [...new Set(body.match(/〔\s*待定[^〕]*〕/g) ?? [])]
if (pendingFacts.length > 0) {
  add('error', 'pending-fact', '设定库里没有、正文又需要的可核对事实被留成了待定标记', pendingFacts.slice(0, 5).join(' '))
}

if (args.bible || args.facts) {
  const factsPath = args.facts || join(args.bible, 'facts.md')
  const factsText = await readFile(factsPath, 'utf8').catch(() => '')
  if (!factsText) {
    add('warn', 'facts-missing', `没读到 ${factsPath}，本章数字无法与设定库核对`)
  } else {
    const known = numberTokens(factsText)
    const unknown = [...numberTokens(body)].filter(([key]) => !known.has(key)).sort((a, b) => b[1] - a[1])
    if (unknown.length > 0) {
      add('warn', 'unlisted-number', `有 ${unknown.length} 个数字/度量不在 facts.md 里（代笔不许自编；确认无误就入表）`, unknown.slice(0, 8).map(([key, count]) => `${key}×${count}`).join('、'))
    }
  }
}

const longParagraphs = body
  .split(/\n{2,}/)
  .map((paragraph, index) => ({ index, size: countWords(paragraph) }))
  .filter((paragraph) => paragraph.size > 500)
if (longParagraphs.length > 0) {
  add('warn', 'paragraph', `有 ${longParagraphs.length} 段超过 500 字，读起来会闷`)
}

const errors = findings.filter((item) => item.level === 'error')
if (args.json) {
  console.log(JSON.stringify({ file: args.file, words, findings, ok: errors.length === 0 }, null, 2))
} else {
  console.log(`${basename(args.file)}  ${words} 字  ${errors.length === 0 ? '通过' : '不通过'}`)
  for (const item of findings) {
    console.log(`${item.level === 'error' ? '✘' : '!'} [${item.id}] ${item.message}${item.detail ? ` — ${item.detail}` : ''}`)
  }
  if (findings.length === 0) console.log('✔ 全部检查通过')
}
process.exit(errors.length === 0 ? 0 : 1)
