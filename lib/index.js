/**
 * 小说助手面板的宿主半侧：状态、读章、清「设定待更新」、保存并自动核对、生成图谱。
 *
 * 浏览器半侧（`lib/client.js`）没有文件系统权限，所有读写都在 Host 进程里做：
 * 面板只负责显示与编辑，判断级别、写清单、存档全部复用
 * `lib/versions.js` 与 `lib/reconcile.js`——与命令行 `reconcile-chapter.mjs`
 * 是同一份实现，面板给出的结论必须和命令一致。
 *
 * 路由：
 *   GET  /novel-panel/status?project=<绝对路径 | 相对 Host 工作目录>
 *   GET  /novel-panel/browse?dir=<绝对路径>    ← 面板「浏览…」用的目录列举
 *   GET  /novel-panel/chapter?project=…&chapter=vol-01/ch-001.md
 *   POST /novel-panel/archive   { project, chapter }
 *   POST /novel-panel/save      { project, chapter, text }
 *   POST /novel-panel/reconcile { project, chapter }
 *   POST /novel-panel/last-change { project, chapter }  ← 回头看：上一版存档 → 这一版存档
 *
 * 写操作只有两个：保存正文（写回章节文件并把存档前进），与清「设定待更新」标记。
 * 账本（bible/）一律不动——那是 agent 按清单去改的事。
 * @module dsh-novel-assistant
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { archiveChapter, clearPending, countWords, loadManifest, markPending, readArchived, scanProject, shortSha } from './versions.js'
import { buildPayload, digestRow, knownNames, paragraphs, writeReport } from './reconcile.js'

/** Cordis 插件名。 */
export const name = 'novel-panel'

/** 依赖宿主 Web 服务提供路由表。 */
export const inject = ['webServer']

const CHAPTER_KEY = /^(?:[^/\\]+\/)?ch-\d{3}\.md$/

/**
 * 把 `project` 参数解析成绝对目录。
 * @param {string} asked 用户给的项目路径
 * @param {string} fallback 配置里的默认值
 * @returns {string} 绝对路径
 */
/** 图谱工具所在目录（随包发布，和脚本同一份实现）。 */
const GRAPH_TOOLS = fileURLToPath(new URL('../skills/novel-graph/tools/', import.meta.url))

/** 跑一个图谱脚本，返回退出码与输出；失败不抛，交给调用方判断。 */
function runTool(script, args) {
  return new Promise((done) => {
    execFile(process.execPath, [join(GRAPH_TOOLS, script), ...args], { timeout: 60000 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

/** 把 markdown 表格拆成行数组（去掉表头与分隔行）。 */
function tableRows(text) {
  const rows = []
  let inTable = false
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) { inTable = false; continue }
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
    if (!inTable) { inTable = true; continue } // 表头
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue // 分隔行
    rows.push(cells)
  }
  return rows
}

/** digest.md：章号 → 一句话剧情，给「章节」页做概要行与检索。 */
function readDigests(projectDir) {
  const file = join(projectDir, 'bible', 'digest.md')
  if (!existsSync(file)) return new Map()
  const map = new Map()
  for (const row of tableRows(readFileSync(file, 'utf8'))) {
    const n = Number.parseInt(row[0], 10)
    if (!Number.isFinite(n)) continue
    map.set(n, { summary: (row[2] || '').trim(), when: (row[1] || '').trim() })
  }
  return map
}

/** 扫一遍项目，并给每章挂上 digest 的一句话剧情。 */
function withDigest(projectDir) {
  const scan = scanProject(projectDir)
  const digests = readDigests(projectDir)
  return {
    ...scan,
    chapters: (scan.chapters || []).map((row) => {
      const hit = digests.get(row.chapter)
      return { ...row, summary: hit ? hit.summary : '', when: hit ? hit.when : '' }
    }),
  }
}

/** 分卷：读 outline.md 的分卷表，给场景页做卷视图与检索。 */
function readVolumes(projectDir) {
  const file = join(projectDir, 'bible', 'outline.md')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const at = lines.findIndex((line) => /^##\s*[一二三四五六七八九十]+、\s*分卷/.test(line.trim()))
  if (at < 0) return []
  let end = lines.length
  for (let i = at + 1; i < lines.length; i += 1) if (/^##\s/.test(lines[i].trim())) { end = i; break }
  return tableRows(lines.slice(at, end).join('\n'))
    .map((row, index) => {
      const rangeCell = (row[2] || '').replace(/\s/g, '')
      const pair = rangeCell.match(/(\d+)\D+(\d+)/)
      const single = rangeCell.match(/(\d+)/)
      const from = pair ? Number.parseInt(pair[1], 10) : single ? Number.parseInt(single[1], 10) : null
      const to = pair ? Number.parseInt(pair[2], 10) : from
      if (!Number.isFinite(from) || !Number.isFinite(to)) return null
      return { vol: index + 1, label: (row[0] || `卷${index + 1}`).trim(), title: (row[1] || '').trim(), from, to }
    })
    .filter(Boolean)
}

/** 场景节点 + 章节摘要：面板「场景图谱」用 HTML 画，不再依赖静态 SVG。 */
function scenesPayload(projectDir) {
  const bible = join(projectDir, 'bible')
  const plotFile = join(bible, 'plot-map.md')
  const digestFile = join(bible, 'digest.md')
  const plotText = existsSync(plotFile) ? readFileSync(plotFile, 'utf8') : ''
  const digestText = existsSync(digestFile) ? readFileSync(digestFile, 'utf8') : ''

  const plotLines = plotText.split(/\r?\n/)
  const at = plotLines.findIndex((line) => /^##\s*场景节点/.test(line.trim()))
  let end = plotLines.length
  if (at >= 0) for (let i = at + 1; i < plotLines.length; i += 1) if (/^##\s/.test(plotLines[i].trim())) { end = i; break }
  const sceneRows = at >= 0 ? tableRows(plotLines.slice(at, end).join('\n')) : []

  const digestRows = digestText ? tableRows(digestText) : []
  const digest = new Map()
  for (const row of digestRows) {
    const n = Number.parseInt(row[0], 10)
    if (!Number.isFinite(n)) continue
    digest.set(n, {
      when: (row[1] || '').trim(),
      summary: (row[2] || '').trim(),
      changes: (row[3] || '').trim(),
      marks: (row[4] || '').trim(),
    })
  }

  const byChapter = new Map()
  for (const row of sceneRows) {
    const n = Number.parseInt(row[0], 10)
    if (!Number.isFinite(n)) continue
    if (!byChapter.has(n)) byChapter.set(n, [])
    byChapter.get(n).push({
      no: Number.parseInt(row[1], 10) || byChapter.get(n).length + 1,
      event: (row[2] || '').trim(),
      who: (row[3] || '').trim(),
      tag: (row[4] || '').trim(),
    })
  }

  const numbers = [...new Set([...byChapter.keys(), ...digest.keys()])].sort((a, b) => a - b)
  const chapters = numbers.map((n) => {
    const d = digest.get(n) || { when: '', summary: '', changes: '', marks: '' }
    const scenes = byChapter.get(n) || []
    const turn = scenes.filter((s) => /转折/.test(s.tag)).length
    const plant = scenes.reduce((acc, s) => acc + (s.tag.match(/埋/g) || []).length, 0)
    const pay = scenes.reduce((acc, s) => acc + (s.tag.match(/收/g) || []).length, 0)
    return { n, ...d, scenes, marksAgg: { turn, plant, pay }, hasScenes: scenes.length > 0 }
  })

  return {
    project: relative(projectDir, projectDir) || '.',
    total: chapters.length,
    scenes: sceneRows.length,
    volumes: readVolumes(projectDir),
    chapters,
  }
}

/** 图谱现状：两份表有什么、两张图是不是落后、哪些已写章节还没打分。 */
function graphStatus(projectDir) {
  const bible = join(projectDir, 'bible')
  const relMd = join(bible, 'relationship-map.md')
  const plotMd = join(bible, 'plot-map.md')
  const relSvg = join(bible, 'relationship-map.svg')
  const plotSvg = join(bible, 'plot-map.svg')
  const sceneSvg = join(bible, 'plot-map-scenes.svg')
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
  const mtime = (file) => (existsSync(file) ? statSync(file).mtimeMs : 0)

  // 章数超过上限时 render-graph 会按卷切图：plot-map-vol-01.svg…
  const plotVolumes = []
  try {
    for (const name of readdirSync(bible)) {
      const hit = name.match(/^plot-map-vol-(\d+)\.svg$/)
      if (!hit) continue
      const body = existsSync(join(bible, name)) ? readFileSync(join(bible, name), 'utf8') : ''
      const title = body.match(/<text[^>]*font-weight="600"[^>]*>([^<]*)</)
      const label = title ? (title[1].match(/（(.+?)）/)?.[1] || title[1]) : `卷${Number(hit[1])}`
      plotVolumes.push({ vol: Number(hit[1]), file: name, label })
    }
    plotVolumes.sort((a, b) => a.vol - b.vol)
  } catch (failure) {
    // 目录读不到就当没有分卷
  }

  const relText = read(relMd)
  const plotText = read(plotMd)
  const relLines = relText.split(/\r?\n/)
  const tierAt = relLines.findIndex((line) => /^##\s*人物档位/.test(line.trim()))
  const edgeAt = relLines.findIndex((line) => /^##\s*文字版关系表/.test(line.trim()))
  const tierRows = tierAt >= 0 ? tableRows(relLines.slice(tierAt, edgeAt > tierAt ? edgeAt : undefined).join('\n')) : []
  const edgeRows = edgeAt >= 0 ? tableRows(relLines.slice(edgeAt).join('\n')) : []

  const plotLines = plotText.split(/\r?\n/)
  const strengthAt = plotLines.findIndex((line) => /^##\s*故事线强度/.test(line.trim()))
  let strengthEnd = plotLines.length
  if (strengthAt >= 0) {
    for (let i = strengthAt + 1; i < plotLines.length; i += 1) {
      if (/^##\s/.test(plotLines[i].trim())) { strengthEnd = i; break }
    }
  }
  const strengthSection = strengthAt >= 0 ? plotLines.slice(strengthAt, strengthEnd) : []
  const strengthRows = strengthAt >= 0 ? tableRows(strengthSection.join('\n')) : []
  const sceneAt = plotLines.findIndex((line) => /^##\s*场景节点/.test(line.trim()))
  let sceneEnd = plotLines.length
  if (sceneAt >= 0) {
    for (let i = sceneAt + 1; i < plotLines.length; i += 1) {
      if (/^##\s/.test(plotLines[i].trim())) { sceneEnd = i; break }
    }
  }
  const sceneRows = sceneAt >= 0 ? tableRows(plotLines.slice(sceneAt, sceneEnd).join('\n')) : []
  const lines = strengthRows.length ? strengthRows[0].length - 1 : 0
  const chapters = strengthRows.length

  const written = new Set((scanProject(projectDir).chapters || []).map((row) => row.chapter))
  const missingStrength = strengthRows
    .filter((row) => row.slice(1).some((cell) => /^[—\-–]$/.test(cell)))
    .map((row) => Number.parseInt(row[0], 10))
    .filter((n) => Number.isFinite(n) && written.has(n))

  const idxFile = join(bible, 'characters', '_index.md')
  const idxRows = existsSync(idxFile) ? tableRows(readFileSync(idxFile, 'utf8')) : []
  const characters = idxRows
    .map((row) => {
      const name = (row[0] || '').trim()
      if (!name || /姓名/.test(name)) return null
      // 「首次出场」一格可能是「第 1 章（提及）/ 第 3 章」：只取第一个数字，忽略「提及」
      const firstCell = row.find((cell, i) => i > 0 && /章/.test(cell || '') && /\d/.test(cell || ''))
      const num = firstCell ? Number.parseInt(String(firstCell).replace(/\D+/, ''), 10) : null
      return { name, first: Number.isFinite(num) ? num : null }
    })
    .filter(Boolean)

  return {
    characters,
    bible: relative(projectDir, bible) || 'bible',
    people: tierRows.length,
    edges: edgeRows.length,
    chapters,
    lines,
    written: written.size,
    missingStrength,
    hasTables: Boolean(relText && plotText),
    scenes: sceneRows.length,
    plotVolumes,
    hasSvg: Boolean(existsSync(relSvg) && (existsSync(plotSvg) || plotVolumes.length > 0)),
    staleSvg: mtime(relSvg) < mtime(relMd)
      || (plotVolumes.length ? Math.min(...plotVolumes.map((v) => mtime(join(bible, v.file)))) : mtime(plotSvg)) < mtime(plotMd)
      || (sceneRows.length > 0 && mtime(sceneSvg) < mtime(plotMd)),
    updatedAt: Math.max(mtime(relSvg), mtime(plotSvg), mtime(sceneSvg)) || 0,
  }
}

/**
 * 列出一个目录下的子目录，供面板「浏览」选择。
 * 只列目录、跳过隐藏目录、最多 300 条；顺带标出「本身是项目」与「含 novel-project」。
 * @param {string} raw 目标目录；空则从用户主目录开始
 * @returns {{dir: string, parent: string|null, entries: Array<{name: string, path: string, isProject: boolean, hasNovel: boolean}>}}
 */
function browseDir(raw) {
  const dir = resolve(String(raw || '').trim() || homedir())
  if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`)
  if (!statSync(dir).isDirectory()) throw new Error(`不是目录：${dir}`)
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .slice(0, 300)
    .map((d) => {
      const path = join(dir, d.name)
      return {
        name: d.name,
        path,
        isProject: existsSync(join(path, 'PROJECT.md')),
        hasNovel: existsSync(join(path, 'novel-project', 'PROJECT.md')),
      }
    })
    .sort((a, b) => (b.isProject || b.hasNovel ? 1 : 0) - (a.isProject || a.hasNovel ? 1 : 0) || a.name.localeCompare(b.name))
  const parent = dirname(dir)
  return { dir, parent: parent === dir ? null : parent, entries }
}

function projectDirOf(asked, fallback) {
  const target = asked || fallback
  return isAbsolute(target) ? target : resolve(process.cwd(), target)
}

/**
 * 章节 key 的安全检查：只允许 `vol-XX/ch-YYY.md`，不许跳出 chapters/。
 * @param {string} key 相对路径
 * @returns {boolean} 是否合法
 */
const safeKey = (key) => typeof key === 'string' && CHAPTER_KEY.test(key) && !key.includes('..')

/**
 * 读一章的当前状态。
 * @param {string} projectDir 项目目录
 * @param {string} key `vol-01/ch-001.md`
 * @returns {object} 章节状态
 */
function chapterState(projectDir, key) {
  const file = join(projectDir, 'chapters', key)
  const text = readFileSync(file, 'utf8')
  const manifest = loadManifest(projectDir)
  const entry = manifest.chapters[key]
  const sha = shortSha(text)
  const chapter = Number((key.match(/ch-(\d{3})\.md$/) || [])[1] ?? 0)
  const report = join(projectDir, 'reviews', 'draft-edits', `ch-${String(chapter).padStart(3, '0')}.md`)
  return {
    chapter,
    key,
    text,
    words: countWords(text),
    paragraphs: paragraphs(text).length,
    status: !entry ? 'missing' : entry.sha256 === sha ? 'ok' : 'drift',
    baseline: entry ? { version: entry.baseline, words: entry.words, archivedAt: entry.archivedAt ?? null } : null,
    previous: entry && entry.baseline > 1
      ? { version: entry.baseline - 1, at: (entry.history || []).find((h) => h.v === entry.baseline - 1)?.at ?? null }
      : null,
    pending: entry?.pending ?? null,
    report: existsSync(report) ? relative(projectDir, report) : null,
    updatedAt: statSync(file).mtime.toISOString(),
  }
}

/**
 * 读某一版存档的正文。
 * @param {string} projectDir 项目目录
 * @param {string} key 章节 key
 * @param {number} version 存档版本
 * @returns {string} 存档正文
 */
function baselineText(projectDir, key, version) {
  return readArchived(projectDir, key, version)
}

/**
 * 核对两稿并写清单。`beforeText` 由调用方给：保存时用内存里读到的旧稿，
 * 免得先归档一次、版本号凭空多一跳。
 * @param {string} projectDir 项目目录
 * @param {string} key 章节 key
 * @param {string} beforeText 改前正文
 * @param {string} afterText 改后正文
 * @param {{version: number|null, archivedAt?: string|null}} baseline 存档信息（只用于报告）
 * @returns {object} 核对结果（含 report 路径）
 */
/** 读设定库里的硬事实表（判断改动是不是改回表里记的值）。 */
function readFacts(projectDir) {
  const file = join(projectDir, 'bible', 'facts.md')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function reconcileAgainst(projectDir, key, beforeText, afterText, baseline) {
  const chapter = Number((key.match(/ch-(\d{3})\.md$/) || [])[1] ?? 0)
  const payload = buildPayload({
    chapter,
    key,
    beforeText,
    afterText,
    names: knownNames(projectDir),
    baseline,
    digestRowText: digestRow(projectDir, chapter),
    factsText: readFacts(projectDir),
  })
  payload.report = writeReport(projectDir, payload)
  return payload
}

/**
 * 注册面板路由。
 * @param {object} ctx Cordis 根上下文
 * @param {{project?: string}} [config] 插件配置：默认项目目录
 */
export function apply(ctx, config = {}) {
  const fallback = config.project || 'novel-project'

  /**
   * 写一个 JSON 响应（node:http 的 ServerResponse）。
   * @param {import('node:http').ServerResponse} response 响应
   * @param {object} payload 内容
   * @param {number} [status] 状态码
   */
  const sendJson = (response, payload, status = 200) => {
    const body = JSON.stringify(payload)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  /**
   * 读 POST body。读不动就当空对象，交给后续校验报错。
   * @param {import('node:http').IncomingMessage} request 请求
   * @returns {Promise<object>} 解析后的 body
   */
  const readBody = (request) => new Promise((resolveBody) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 8 * 1024 * 1024) request.destroy()
    })
    request.on('end', () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {})
      } catch {
        resolveBody({})
      }
    })
    request.on('error', () => resolveBody({}))
  })

  /**
   * GET 路由。`webServer` 的 `resource` 只接 GET/HEAD，其余方法回空体 405，
   * 所以读接口走这里、写接口走 `handlerRoute`。
   * @param {(args: {projectDir: string, url: URL}) => Promise<object>|object} handler 处理函数
   * @returns {(request: Request) => Promise<Response>} 路由处理函数
   */
  const methodOf = (request) => String(request?.method || 'GET').toUpperCase()

  const getJsonRoute = (handler) => async (request, response) => {
    try {
      if (methodOf(request) !== 'GET' && methodOf(request) !== 'HEAD') {
        sendJson(response, { ok: false, error: 'GET only' }, 405)
        return
      }
      const url = new URL(request.url, 'http://localhost')
      const projectDir = projectDirOf(url.searchParams.get('project'), fallback)
      const result = await handler({ projectDir, url })
      sendJson(response, { ok: true, cwd: process.cwd(), ...result })
    } catch (error) {
      sendJson(response, { ok: false, error: String(error?.message ?? error) }, 400)
    }
  }

  const sendRaw = (response, body, status, type) => {
    response.writeHead(status, {
      'content-type': type,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  const getSvgRoute = (handler) => async (request, response) => {
    try {
      if (methodOf(request) !== 'GET' && methodOf(request) !== 'HEAD') {
        sendRaw(response, 'GET only', 405, 'text/plain; charset=utf-8')
        return
      }
      const url = new URL(request.url, 'http://localhost')
      const projectDir = projectDirOf(url.searchParams.get('project'), fallback)
      const result = await handler({ projectDir, url })
      sendRaw(response, result.body, result.status, result.type)
    } catch (error) {
      sendRaw(response, String(error?.message ?? error), 500, 'text/plain; charset=utf-8')
    }
  }

  /**
   * POST 路由。必须用 `handler`：它拿到 node 原生 req/res，才能读 body、
   * 指定状态码与 content-type（`resource` 在非 GET/HEAD 上是空体 405）。
   * @param {(args: {projectDir: string, body: any}) => Promise<object>|object} handler 处理函数
   * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>} 路由处理函数
   */
  const handlerRoute = (handler) => async (request, response) => {
    try {
      if (request.method !== 'POST') {
        sendJson(response, { ok: false, error: 'POST only' }, 405)
        return
      }
      const body = await readBody(request)
      const projectDir = projectDirOf(body.project, fallback)
      const result = await handler({ projectDir, body })
      sendJson(response, { ok: true, cwd: process.cwd(), ...result })
    } catch (error) {
      sendJson(response, { ok: false, error: String(error?.message ?? error) }, 400)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/novel-panel/status',
    handler: getJsonRoute(({ projectDir, url }) => ({
      requested: url.searchParams.get('project') || fallback,
      projectDir,
      ...withDigest(projectDir),
    })),
  }), 'novel-panel: GET /novel-panel/status')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/novel-panel/browse',
    handler: getJsonRoute(({ url }) => browseDir(url.searchParams.get('dir'))),
  }), 'novel-panel: GET /novel-panel/browse')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/novel-panel/chapter',
    handler: getJsonRoute(({ projectDir, url }) => {
      const key = url.searchParams.get('chapter') || ''
      if (!safeKey(key)) throw new Error(`章节路径不合法：${key || '（空）'}，应形如 vol-01/ch-001.md`)
      return chapterState(projectDir, key)
    }),
  }), 'novel-panel: GET /novel-panel/chapter')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/novel-panel/archive',
    handler: handlerRoute(({ projectDir, body }) => {
      const key = body.chapter || ''
      if (!safeKey(key)) throw new Error(`章节路径不合法：${key || '（空）'}`)
      const file = join(projectDir, 'chapters', key)
      const text = readFileSync(file, 'utf8')
      const manifest = loadManifest(projectDir)
      const result = archiveChapter(projectDir, key, text, manifest, { quiet: true })
      return {
        archived: result.created,
        version: result.version,
        words: result.words,
        scan: scanProject(projectDir),
        state: chapterState(projectDir, key),
      }
    }),
  }), 'novel-panel: POST /novel-panel/archive')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/novel-panel/save',
    handler: handlerRoute(({ projectDir, body }) => {
      const key = body.chapter || ''
      if (!safeKey(key)) throw new Error(`章节路径不合法：${key || '（空）'}`)
      if (typeof body.text !== 'string' || !body.text.trim()) throw new Error('正文是空的，没有保存。')
      const file = join(projectDir, 'chapters', key)
      const before = readFileSync(file, 'utf8')
      if (shortSha(before) === shortSha(body.text)) {
        return { changed: false, scan: scanProject(projectDir), state: chapterState(projectDir, key) }
      }
      const manifest = loadManifest(projectDir)
      const entry = manifest.chapters[key]
      // 先核对（旧稿在内存里），再写盘，最后把存档前进到新稿：
      // 第一次保存只会产生 v1，不会因为「先归档旧稿」多出一版。
      const payload = reconcileAgainst(projectDir, key, before, body.text, {
        version: entry?.baseline ?? null,
        archivedAt: entry?.archivedAt ?? null,
      })
      const tmp = `${file}.tmp-${Date.now()}`
      writeFileSync(tmp, body.text, 'utf8')
      renameSync(tmp, file)
      archiveChapter(projectDir, key, body.text, loadManifest(projectDir), { quiet: true })
      // 存档只说明这一稿定下来了；级别 2/3 还得改 bible，单独记一笔债务。
      if (payload.suggestedLevel >= 2) {
        markPending(projectDir, key, {
          level: payload.suggestedLevel,
          report: payload.report,
          reasons: payload.reasons || [],
        })
      }
      return { ...payload, changed: true, scan: scanProject(projectDir), state: chapterState(projectDir, key) }
    }),
  }), 'novel-panel: POST /novel-panel/save')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/novel-panel/settle',
    handler: handlerRoute(({ projectDir, body }) => {
      const key = body.chapter || ''
      if (!safeKey(key)) throw new Error(`章节路径不合法：${key || '（空）'}`)
      const cleared = clearPending(projectDir, key)
      return { cleared, scan: scanProject(projectDir), state: chapterState(projectDir, key) }
    }),
  }), 'novel-panel: POST /novel-panel/settle')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/novel-panel/last-change',
    handler: handlerRoute(({ projectDir, body }) => {
      const key = body.chapter || ''
      if (!safeKey(key)) throw new Error(`章节路径不合法：${key || '（空）'}`)
      const entry = loadManifest(projectDir).chapters[key]
      if (!entry) throw new Error('这一章还没有存档。')
      if (entry.baseline < 2) throw new Error('这一章只有一版存档，没有「上次改了什么」可比。')
      const previous = entry.baseline - 1
      const beforeText = readArchived(projectDir, key, previous)
      const afterText = readArchived(projectDir, key, entry.baseline)
      const payload = reconcileAgainst(projectDir, key, beforeText, afterText, {
        version: previous,
        archivedAt: (entry.history || []).find((h) => h.v === previous)?.at ?? null,
      })
      // 这是「回头看」，不动待更新标记
      return { ...payload, changed: true, lookBack: true, state: chapterState(projectDir, key) }
    }),
  }), 'novel-panel: POST /novel-panel/last-change')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/novel-panel/reconcile',
    handler: handlerRoute(({ projectDir, body }) => {
      const key = body.chapter || ''
      if (!safeKey(key)) throw new Error(`章节路径不合法：${key || '（空）'}`)
      const manifest = loadManifest(projectDir)
      const entry = manifest.chapters[key]
      if (!entry) throw new Error('这一章还没有存档，先保存一次，或跑 `reconcile-chapter.mjs --archive`。')
      const text = readFileSync(join(projectDir, 'chapters', key), 'utf8')
      const payload = reconcileAgainst(projectDir, key, baselineText(projectDir, key, entry.baseline), text, {
        version: entry.baseline,
        archivedAt: entry.archivedAt,
      })
      return { ...payload, changed: true, scan: scanProject(projectDir), state: chapterState(projectDir, key) }
    }),
  }), 'novel-panel: POST /novel-panel/reconcile')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/novel-panel/graph',
    handler: getJsonRoute(({ projectDir }) => graphStatus(projectDir)),
  }), 'novel-panel: GET /novel-panel/graph')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/novel-panel/trace',
    handler: getJsonRoute(({ projectDir, url }) => {
      const num = Number.parseInt(url.searchParams.get('chapter') || '', 10)
      if (!Number.isFinite(num)) throw new Error('缺少 chapter 参数')
      const bible = join(projectDir, 'bible')
      const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
      // 1) 章节摘要那一行
      const digestRows = tableRows(read(join(bible, 'digest.md')))
      const digest = digestRows.find((row) => Number.parseInt(row[0], 10) === num) || null
      // 2) 细纲：outline 下的 ch-00N.md，取小标题与前几条要点
      let brief = null
      const outlineRoot = join(projectDir, 'outline')
      if (existsSync(outlineRoot)) {
        const want = `ch-${String(num).padStart(3, '0')}.md`
        const walk = (dir) => {
          for (const item of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, item.name)
            if (item.isDirectory()) {
              const hit = walk(full)
              if (hit) return hit
            } else if (item.name === want) return full
          }
          return null
        }
        const file = walk(outlineRoot)
        if (file) {
          const lines = readFileSync(file, 'utf8').split(/\r?\n/)
          const sections = []
          let current = null
          for (const line of lines) {
            const head = line.match(/^##\s+(.+)/)
            if (head) { current = { heading: head[1].trim(), lines: [] }; sections.push(current); continue }
            // 细纲各节既有 `- ` 列表，也有 `**加粗**：…` 与表格：都算要点
            const text = line.trim()
            if (current && text && !text.startsWith('#') && !text.startsWith('---') && !text.startsWith('|') && current.lines.length < 3) {
              current.lines.push(text.replace(/^[-*]\s+/, '').slice(0, 120))
            }
          }
          brief = { file: relative(projectDir, file), sections: sections.slice(0, 6) }
        }
      }
      // 3) 这一章各条线几分
      const plotLines = read(join(bible, 'plot-map.md')).split(/\r?\n/)
      const at = plotLines.findIndex((line) => /^##\s*故事线强度/.test(line.trim()))
      let end = plotLines.length
      if (at >= 0) for (let i = at + 1; i < plotLines.length; i += 1) if (/^##\s/.test(plotLines[i].trim())) { end = i; break }
      const rows = at >= 0 ? tableRows(plotLines.slice(at, end).join('\n')) : []
      const header = plotLines.slice(at, end).find((line) => line.trim().startsWith('|'))
      const names = header ? header.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()).slice(1) : []
      const scoreRow = rows.find((row) => Number.parseInt(row[0], 10) === num)
      const scores = scoreRow ? names.map((line, i) => ({ line, value: (scoreRow[i + 1] || '—').trim() })) : []
      return { ok: true, chapter: num, digest, brief, scores }
    }),
  }), 'novel-panel: GET /novel-panel/trace')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/novel-panel/scenes',
    handler: getJsonRoute(({ projectDir }) => scenesPayload(projectDir)),
  }), 'novel-panel: GET /novel-panel/scenes')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/novel-panel/graph.svg',
    handler: getSvgRoute(async ({ projectDir, url }) => {
      const rawKind = url.searchParams.get('kind')
      const kind = rawKind === 'plot' ? 'plot' : rawKind === 'scenes' ? 'scenes' : 'relationship'
      const vol = url.searchParams.get('vol')
      const volFile = vol && /^\d+$/.test(vol) ? `plot-map-vol-${vol.padStart(2, '0')}.svg` : null
      const file = join(projectDir, 'bible',
        kind === 'plot' ? (volFile || 'plot-map.svg') : kind === 'scenes' ? 'plot-map-scenes.svg' : 'relationship-map.svg')
      if (!existsSync(file)) {
        return {
          body: `还没有${kind === 'plot' ? '情节图' : kind === 'scenes' ? '场景图' : '关系图'}：先点「重画图谱」`,
          status: 404,
          type: 'text/plain; charset=utf-8',
        }
      }
      return { body: readFileSync(file, 'utf8'), status: 200, type: 'image/svg+xml; charset=utf-8' }
    }),
  }), 'novel-panel: GET /novel-panel/graph.svg')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/novel-panel/graph/sync',
    handler: handlerRoute(async ({ projectDir, body }) => {
      const args = ['--project', projectDir]
      const steps = body && body.tablesOnly ? [['graph-sync.mjs', args]] : [['graph-sync.mjs', args], ['render-graph.mjs', args]]
      const logs = []
      for (const [script, argv] of steps) {
        const result = await runTool(script, argv)
        logs.push(`$ node ${script} ${argv.join(' ')}\n${(result.stdout || '').trim()}${result.stderr ? `\n${result.stderr.trim()}` : ''}`)
        if (result.code !== 0) {
          return { ok: false, code: result.code, log: logs.join('\n\n'), status: graphStatus(projectDir) }
        }
      }
      return { ok: true, code: 0, log: logs.join('\n\n'), status: graphStatus(projectDir) }
    }),
  }), 'novel-panel: POST /novel-panel/graph/sync')

}
