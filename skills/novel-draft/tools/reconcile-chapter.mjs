#!/usr/bin/env node
/**
 * 改稿核对：作者手改过正文之后，把「改了哪几段、动了哪些数字/伏笔/人物」列成清单，
 * 并给一句建议级别。级别 2/3 会挂「设定待更新」，存档同时前进到这一稿；
 * 它不判断级别、也不改账本——那两步要人（或主代理）来做。
 *
 *   node reconcile-chapter.mjs novel-project/chapters/vol-01/ch-001.md
 *   node reconcile-chapter.mjs 1 --project novel-project --archive
 *   node reconcile-chapter.mjs --all                 # 开写前体检：哪几章被改过没核对、哪几章设定库还没跟上
 *
 * 参数：
 *   <章号|章节文件>   章号会去 chapters/ 里找 ch-YYY.md
 *   --project <dir>   项目目录，默认 novel-project
 *   --archive         把当前稿存成新的一版存档（写完一章、或改完设定库后跑，会清掉「设定待更新」）
 *   --no-write        只打印，不写 reviews/draft-edits/
 *   --all             体检全部已登记章节，列出与存档不一致的、设定库还没跟上的
 *   --json            机器可读输出
 *
 * 退出码：0 = 与存档一致 / 已存档；1 = 有改动待处理（清单已写）；
 *         2 = 用法错或读不到文件；3 = 这一章还没有存档。
 * 只依赖 Node 内置模块；差异与判定与 Web 面板共用 lib/reconcile.js。
 */
import { readFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname, basename, posix } from 'node:path'
// 存档的实现只有一份：lib/versions.js（面板与命令行共用，别在这里重写）。
import {
  archiveChapter,
  clearPending,
  markPending,
  countWords,
  shortSha,
  loadManifest as readManifest,
  readArchived,
} from '../../../lib/versions.js'
// 差异、判定与清单渲染也只有一份：lib/reconcile.js。
import {
  buildPayload,
  digestRow,
  knownNames,
  writeReport,
} from '../../../lib/reconcile.js'

const USAGE = 'node reconcile-chapter.mjs <章号|章节文件> [--project novel-project] [--archive] [--since N] [--no-write] [--all] [--json]'

const argv = process.argv.slice(2)
const opts = { project: 'novel-project', archive: false, write: true, all: false, json: false, since: 0 }
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i]
  if (token === '--project') opts.project = argv[++i]
  else if (token === '--archive') opts.archive = true
  else if (token === '--since') opts.since = parseInt(argv[++i], 10) || 0
  else if (token === '--no-write') opts.write = false
  else if (token === '--all') opts.all = true
  else if (token === '--json') opts.json = true
  else if (token === '--help' || token === '-h') { console.log(USAGE); process.exit(0) }
  else if (token.startsWith('--')) { console.error(`未知参数: ${token}\n${USAGE}`); process.exit(2) }
  else positional.push(token)
}

const abs = (p) => join(opts.project, p)
const read = (p, fallback = '') => { try { return readFileSync(p, 'utf8') } catch { return fallback } }
const exists = (p) => existsSync(p)

if (!exists(opts.project) || !statSync(opts.project).isDirectory()) {
  console.error(`项目目录不存在: ${opts.project}`)
  process.exit(2)
}
if (!opts.all && !positional.length) {
  console.error(`缺少章号或章节文件\n${USAGE}`)
  process.exit(2)
}

// ---------- 章节发现 ----------
function walk(dir, out = []) {
  if (!exists(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === '.versions') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const chapterFiles = () => walk(abs('chapters')).filter((f) => /ch-\d{3,4}\.md$/.test(f))
const relKey = (p) => relative(abs('chapters'), p).split('\\').join('/')

function resolveChapter(target) {
  if (/\.md$/i.test(target) && exists(target)) return target
  const asFile = abs(join('chapters', target))
  if (exists(asFile)) return asFile
  const m = String(target).match(/(\d{1,4})/)
  if (!m) return ''
  const pad = m[1].padStart(3, '0')
  const candidates = chapterFiles().filter((f) => !f.includes('/_original/'))
  return candidates.find((f) => basename(f) === `ch-${pad}.md`) || ''
}

const chNumOf = (file) => {
  const m = basename(file).match(/ch-(\d{1,4})/)
  return m ? parseInt(m[1], 10) : 0
}

// ---------- 存档 ----------
const VERSIONS = abs(join('chapters', '.versions'))

function loadManifest() {
  try {
    return readManifest(opts.project)
  } catch (error) {
    console.error(`存档索引读不了（${join(VERSIONS, 'manifest.json')}）：${error.message}\n先修好或删掉它，再重跑。`)
    process.exit(2)
  }
}

const sha = (text) => shortSha(text)

// ---------- 归档 ----------
function archive(file, text, manifest, { quiet = false } = {}) {
  const key = relKey(file)
  const result = archiveChapter(opts.project, key, text, manifest, { quiet: true })
  if (!result.created) {
    if (!quiet) console.log(`已是最新存档 v${result.version}，没有重复归档。`)
    return result.entry
  }
  if (!quiet) {
    const shown = posix.join('.versions', key.replace(/\.md$/, `.v${result.version}.md`))
    console.log(`已存档 v${result.version}：${shown}（${result.words} 字）`)
  }
  return result.entry
}

// ---------- --all 体检 ----------
if (opts.all) {
  const manifest = loadManifest()
  const files = chapterFiles()
  const drift = []
  const missing = []
  const pending = []
  for (const file of files) {
    const key = relKey(file)
    const entry = manifest.chapters[key]
    const text = read(file)
    if (!entry) { missing.push({ file: key, words: countWords(text) }); continue }
    if (entry.pending) pending.push({ file: key, level: entry.pending.level, report: entry.pending.report })
    if (entry.sha256 !== sha(text)) {
      drift.push({ file: key, chapter: chNumOf(file), baseline: entry.baseline, before: entry.words, now: countWords(text) })
    }
  }
  const unregisteredOnDisk = Object.keys(manifest.chapters).filter((key) => !exists(abs(join('chapters', key))))

  if (opts.json) {
    console.log(JSON.stringify({ consistent: files.length - drift.length - missing.length, drift, missing, pending, unregisteredOnDisk }, null, 2))
    process.exit(drift.length ? 1 : 0)
  }
  console.log(`# 改稿体检 · ${files.length} 章`)
  console.log('')
  if (!files.length) console.log('chapters/ 下还没有 ch-NNN.md，没有可核对的章节。')
  else if (!drift.length && !missing.length && !pending.length) console.log('全部与存档一致，设定库也都跟上了。')
  if (pending.length) {
    console.log('## 设定库要跟上（正文改过，清单还没处理）')
    console.log('')
    for (const item of pending) console.log(`- ${item.file}（级别 ${item.level}，清单：${item.report || '—'}）——改完设定库跑 \`--archive\` 清标记`)
    console.log('')
  }
  if (drift.length) {
    console.log('## 改过、还没核对')
    console.log('')
    for (const d of drift) console.log(`- ${d.file}（存档 v${d.baseline}，${d.before} → ${d.now} 字）`)
    console.log('')
    console.log('逐章跑 `reconcile-chapter.mjs <章号>` 拿清单。')
  }
  if (missing.length) {
    console.log('')
    console.log('## 没有存档（老章或刚写完）')
    console.log('')
    for (const m of missing) console.log(`- ${m.file}（${m.words} 字）——对账完跑 \`--archive\``)
  }
  if (unregisteredOnDisk.length) {
    console.log('')
    console.log('## 索引里有、磁盘上已没有')
    console.log('')
    for (const key of unregisteredOnDisk) console.log(`- ${key}（文件被删或改名了，确认后在 manifest.json 里删掉这条）`)
  }
  process.exit(drift.length ? 1 : 0)
}

// ---------- 单章 ----------
const file = resolveChapter(positional[0])
if (!file) {
  console.error(`找不到章节文件: ${positional[0]}`)
  process.exit(2)
}
const key = relKey(file)
const num = chNumOf(file)
const text = read(file)
const manifest = loadManifest()
const entry = manifest.chapters[key]

if (!entry) {
  if (opts.archive) {
    archive(file, text, manifest)
    process.exit(0)
  }
  if (opts.json) {
    console.log(JSON.stringify({ chapter: num, file: key, error: 'no-baseline', hint: `先跑 reconcile-chapter.mjs ${num} --archive` }, null, 2))
  } else {
    console.error(`第 ${num} 章还没有存档（没跑过 --archive）。先跑：node reconcile-chapter.mjs ${num} --archive`)
  }
  process.exit(3)
}

const currentSha = sha(text)
if (!opts.since && currentSha === entry.sha256) {
  const cleared = opts.archive ? clearPending(opts.project, key) : false
  if (opts.json) {
    console.log(JSON.stringify({
      chapter: num,
      file: key,
      changed: false,
      cleared,
      baseline: { version: entry.baseline, words: entry.words, archivedAt: entry.archivedAt },
    }, null, 2))
  } else {
    console.log(`第 ${num} 章与存档 v${entry.baseline} 一致，没有改动。${cleared ? '「设定待更新」的标记已清掉。' : ''}`)
  }
  process.exit(0)
}

// 改动：先拿存档里的旧稿。--since N = 回头看：拿第 N 版与当前稿比。
const sinceVersion = opts.since > 0 ? opts.since : 0
if (sinceVersion && sinceVersion > entry.baseline) {
  console.error(`--since ${sinceVersion} 超过了最新存档 v${entry.baseline}。`)
  process.exit(2)
}
let before
if (sinceVersion) {
  try {
    before = readArchived(opts.project, key, sinceVersion)
  } catch {
    console.error(`存档 v${sinceVersion} 读不到（chapters/.versions/${dirname(key)}/）。现有版本：v1–v${entry.baseline}。`)
    process.exit(2)
  }
} else {
  const baselinePath = join(VERSIONS, dirname(key), `${basename(file).replace(/\.md$/, '')}.v${entry.baseline}.md`)
  before = read(baselinePath)
  if (!before) {
    console.error(`存档正文丢了：${baselinePath}。修好它，或直接 --archive 用当前稿重建存档。`)
    process.exit(2)
  }
}

const payload = buildPayload({
  chapter: num,
  key,
  beforeText: before,
  afterText: text,
  names: knownNames(opts.project),
  baseline: { version: sinceVersion || entry.baseline, archivedAt: entry.archivedAt },
  digestRowText: digestRow(opts.project, num),
  factsText: read(abs(join('bible', 'facts.md'))),
})

if (opts.write) {
  mkdirSync(abs(join('reviews', 'draft-edits')), { recursive: true })
  payload.report = writeReport(opts.project, payload)
  // 回头看（--since）只是读旧版本，不前进存档、不挂标记。
  if (!sinceVersion) {
    // 存档前进到刚核对过的这稿（和面板同一套语义：存档≠账本已改）。
    archiveChapter(opts.project, key, text, loadManifest(), { quiet: true })
    // 级别 2/3 说明 bible 得改：记一笔「设定待更新」，等改完设定库再 --archive 清掉。
    if (payload.suggestedLevel >= 2) {
      markPending(opts.project, key, {
        level: payload.suggestedLevel,
        report: payload.report,
        reasons: payload.reasons || [],
      })
    }
  }
}

if (opts.json) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  console.log(`# 第 ${num} 章 · ${sinceVersion ? `回看 v${sinceVersion} → 现在` : '有改动'}`)
  console.log('')
  console.log(`存档 v${sinceVersion || entry.baseline}：${payload.wordsBefore} 字 / ${payload.paragraphsBefore} 段 → 现在 ${payload.wordsAfter} 字 / ${payload.paragraphsAfter} 段（${payload.deltaWords >= 0 ? '+' : ''}${payload.deltaWords}）`)
  if (payload.commentOnly) console.log('只有末尾注释变了，正文没动。')
  else {
    console.log(`改动 ${payload.hunks.length} 处；建议级别 ${payload.suggestedLevel}${payload.structuralHint ? '（可能到结构级）' : ''}`)
    for (const r of payload.reasons) console.log(`- ${r}`)
  }
  if (payload.report) console.log(`\n清单已写：${payload.report}`)
}

if (opts.archive) {
  console.log('')
  archive(file, text, loadManifest())
  clearPending(opts.project, key)
  console.log('「设定待更新」的标记已清掉（`--archive` 视为设定库已跟上）。')
  process.exit(0)
}
console.log('级别由你判定；级别 3 先问用户。改完设定库再 --archive 清标记。')
process.exit(payload.hunks.length ? 1 : 0)
