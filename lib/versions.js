/**
 * 章节存档的共用实现：正文副本、hash、字数、manifest 读写。
 *
 * 三个地方用同一份实现，别各写一套：
 * - `skills/novel-draft/tools/reconcile-chapter.mjs`（命令行核对）
 * - `skills/novel-draft/tools/check-chapter.mjs`（字数口径）
 * - `lib/index.js`（Web 小说助手面板的状态与保存接口）
 *
 * 只用 Node 内置模块：这个包被 link 进 profile，不允许带依赖。
 * @module dsh-novel-assistant/lib/versions
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'

/** 存档目录（相对项目目录）。 */
export const VERSIONS_DIR = join('chapters', '.versions')

/** 存档目录里的索引的绝对路径。 */
export const manifestPathOf = (projectDir) => join(projectDir, VERSIONS_DIR, 'manifest.json')

/**
 * 编辑器保存会动行尾与多余空白，这些不算改稿。
 * @param {string} text 正文
 * @returns {string} 归一化结果
 */
export function normalizeText(text) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '')
}

/**
 * 归一化内容的短摘要（16 位十六进制）。与浏览器面板用同一算法。
 * @param {string} text 正文
 * @returns {string} 摘要
 */
export function shortSha(text) {
  return createHash('sha256').update(normalizeText(text), 'utf8').digest('hex').slice(0, 16)
}

const CJK_RUN = /[\u3400-\u9fff]+/gu

/**
 * 字数口径：去掉 HTML 注释、代码块与标题后，汉字逐字 + 拉丁/数字词。
 * @param {string} text 正文
 * @returns {number} 字数
 */
export function countWords(text) {
  const stripped = String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^```[\s\S]*?^```/gm, ' ')
    .replace(/^#{1,6}\s.*$/gm, ' ')
  const cjk = (stripped.match(CJK_RUN) ?? []).join('').length
  const latin = (stripped.match(/[A-Za-z0-9]+/g) ?? []).length
  return cjk + latin
}

/**
 * 读某一版存档的正文。
 * @param {string} projectDir 项目目录
 * @param {string} relKey `vol-01/ch-001.md`
 * @param {number} version 版本号
 * @returns {string} 正文
 */
export function readArchived(projectDir, relKey, version) {
  const name = relKey.split('/').pop().replace(/\.md$/, '')
  const dir = dirname(relKey)
  return readFileSync(join(projectDir, VERSIONS_DIR, dir, `${name}.v${version}.md`), 'utf8')
}

/**
 * 读存档目录里的索引；文件不存在时给一份空索引。
 * @param {string} projectDir 项目目录
 * @returns {{version: number, chapters: Record<string, any>}} 索引
 */
export function loadManifest(projectDir) {
  const file = manifestPathOf(projectDir)
  if (!existsSync(file)) return { version: 1, chapters: {} }
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || typeof parsed.chapters !== 'object') {
    throw new Error(`存档目录里的索引形状不对：${file}`)
  }
  return parsed
}

/**
 * 写存档目录里的索引。
 * @param {string} projectDir 项目目录
 * @param {object} manifest 索引
 */
/**
 * `.versions/` 自己的忽略规则：正文副本默认不进版本库，索引留下（只存 hash，clone 后仍能判断哪章被改）。
 * @param {string} projectDir 项目目录
 */
export function ensureVersionsIgnore(projectDir) {
  const file = join(projectDir, VERSIONS_DIR, '.gitignore')
  if (existsSync(file)) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, [
    '# 章节正文的历史副本默认不上传：体积大，且能从当前稿与本索引重建。',
    '# manifest.json 保留，它只存 hash 与字数，换台机器也认得出哪一章被改过。',
    '*.v[0-9]*.md',
    '',
  ].join('\n'), 'utf8')
}

export function saveManifest(projectDir, manifest) {
  const file = manifestPathOf(projectDir)
  mkdirSync(dirname(file), { recursive: true })
  ensureVersionsIgnore(projectDir)
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/**
 * 归档一份章节正文为下一版存档。
 * @param {string} projectDir 项目目录
 * @param {string} relKey 相对 chapters/ 的路径，如 `vol-01/ch-001.md`
 * @param {string} text 正文
 * @param {object} manifest 索引
 * @param {{quiet?: boolean}} [options] 选项
 * @returns {{entry: object, version: number, words: number, created: boolean}} 归档结果
 */
export function archiveChapter(projectDir, relKey, text, manifest, { quiet = false } = {}) {
  const fingerprint = shortSha(text)
  const entry = manifest.chapters[relKey] || { baseline: 0, history: [] }
  if (entry.sha256 === fingerprint) {
    return { entry, version: entry.baseline, words: entry.words, created: false }
  }
  const version = entry.baseline + 1
  const absolute = join(projectDir, 'chapters', relKey)
  const target = join(projectDir, VERSIONS_DIR, dirname(relKey), `${basename(relKey).replace(/\.md$/, '')}.v${version}.md`)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(absolute, target)
  const words = countWords(text)
  const archivedAt = new Date().toISOString()
  Object.assign(entry, {
    baseline: version,
    sha256: fingerprint,
    words,
    archivedAt,
    pending: null,
    history: [...(entry.history || []), { v: version, sha256: fingerprint, words, at: archivedAt }].slice(-20),
  })
  manifest.chapters[relKey] = entry
  saveManifest(projectDir, manifest)
  ensureVersionsIgnore(projectDir)
  if (!quiet) {
    const shown = posix.join('.versions', dirname(relKey), `${basename(relKey).replace(/\.md$/, '')}.v${version}.md`)
    process.stdout.write(`已存档 v${version}：${shown}（${words} 字）\n`)
  }
  return { entry, version, words, created: true }
}

/**
 * 记一笔「设定待更新」：正文改过，bible 还没跟上。
 *
 * 存存档只说明「这一稿定下来了」，不说明账本改过；这两件事分开记，
 * 面板才不会因为按了「存档」就把债务抹掉。
 * @param {string} projectDir 项目目录
 * @param {string} relKey 相对 chapters/ 的路径
 * @param {{level: number, report?: string|null, reasons?: string[]}} debt 级别与清单
 * @returns {object|null} 写进索引的那条记录
 */
export function markPending(projectDir, relKey, { level, report = null, reasons = [] }) {
  const manifest = loadManifest(projectDir)
  const entry = manifest.chapters[relKey]
  if (!entry) return null
  entry.pending = { level, report, reasons, at: new Date().toISOString() }
  saveManifest(projectDir, manifest)
  return entry.pending
}

/**
 * 清掉「设定待更新」：作者（或 agent）确认账本已经按清单改过了。
 * @param {string} projectDir 项目目录
 * @param {string} relKey 相对 chapters/ 的路径
 * @returns {boolean} 是否确实清掉了一条
 */
export function clearPending(projectDir, relKey) {
  const manifest = loadManifest(projectDir)
  const entry = manifest.chapters[relKey]
  if (!entry || !entry.pending) return false
  entry.pending = null
  saveManifest(projectDir, manifest)
  return true
}

/**
 * 列出 chapters/ 下的章节文件（跳过 .versions）。
 * @param {string} projectDir 项目目录
 * @returns {string[]} 相对 chapters/ 的路径
 */
export function listChapterFiles(projectDir) {
  const root = join(projectDir, 'chapters')
  const out = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (name === '.versions' || name === '_original') continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/^ch-\d{3}\.md$/.test(name)) out.push(full)
    }
  }
  walk(root)
  return out
    .map((full) => {
      const rel = full.slice(root.length + 1).split('\\').join('/')
      return rel
    })
    .sort()
}

/**
 * 只读扫描：每章与存档是否一致。面板与命令行体检共用。
 * @param {string} projectDir 项目目录
 * @returns {{
 *   projectDir: string,
 *   exists: boolean,
 *   chapters: Array<{key: string, chapter: number, words: number, status: 'ok'|'drift'|'missing', baseline: number|null, archivedAt: string|null}>,
 *   drift: number,
 *   missing: number,
 *   unregisteredOnDisk: string[]
 * }} 扫描结果
 */
export function scanProject(projectDir) {
  const chapters = []
  const manifest = existsSync(projectDir) ? loadManifest(projectDir) : { version: 1, chapters: {} }
  const files = existsSync(projectDir) ? listChapterFiles(projectDir) : []
  for (const key of files) {
    const text = readFileSync(join(projectDir, 'chapters', key), 'utf8')
    const entry = manifest.chapters[key]
    const chapter = Number((key.match(/ch-(\d{3})\.md$/) || [])[1] ?? 0)
    if (!entry) {
      chapters.push({ key, chapter, words: countWords(text), status: 'missing', baseline: null, archivedAt: null, pending: null })
      continue
    }
    const drift = entry.sha256 !== shortSha(text)
    chapters.push({
      key,
      chapter,
      words: countWords(text),
      status: drift ? 'drift' : 'ok',
      baseline: entry.baseline ?? null,
      archivedAt: entry.archivedAt ?? null,
      pending: entry.pending ?? null,
    })
  }
  const unregisteredOnDisk = Object.keys(manifest.chapters).filter((key) => !existsSync(join(projectDir, 'chapters', key)))
  return {
    projectDir,
    exists: existsSync(projectDir),
    chapters,
    drift: chapters.filter((c) => c.status === 'drift').length,
    missing: chapters.filter((c) => c.status === 'missing').length,
    pending: chapters.filter((c) => c.pending).length,
    unregisteredOnDisk,
  }
}
