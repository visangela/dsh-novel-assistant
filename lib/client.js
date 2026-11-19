/**
 * 小说助手面板的浏览器半侧：章节列表 + 内嵌编辑器 + 保存即核对，另有图谱一页。
 *
 * 数据与写盘都走宿主半侧路由（`lib/index.js`）：
 *   GET  /novel-panel/status      列表与汇总
 *   GET  /novel-panel/chapter     取一章正文与存档状态
 *   POST /novel-panel/save        保存正文并自动核对（没有存档时先把旧稿存成 v1）
 *   POST /novel-panel/settle      设定已更新，清掉「待更新」标记
 *   POST /novel-panel/reconcile   只比对、不保存
 *
 * 浏览器没有任何文件系统权限，也不做判定：级别、清单文字全部由 Host 用
 * `lib/reconcile.js` 算出来，和命令行 `reconcile-chapter.mjs` 是同一份实现。
 *
 * 写法遵循 cordis 客户端插件约定：不 import 任何 Harness 客户端包，只用 react；
 * 颜色走 `--dsw-alias-*` 主题变量，不写死深色。
 * @module dsh-novel-assistant/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-novel-assistant',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'novel-edits'
    const STORAGE_KEY = 'novel-panel.project'
    const ORDER = 30
    const GRAPH_TITLE = { relationship: '人物关系图', plot: '情节发展地图', scenes: '情节场景节点' }

    /* ── 界面文案：跟随 DSH 语言（zh / en），字典以 zh 为键集真源 ───────── */
    const LOCALE_NS = 'novel-assistant'

    const ZH = {
      'common.loading': '读取中…',
      'common.reload': '重新读取',
      'common.none': '没有',
      'common.readFail': '读不到',
      'common.readFailMsg': '读取失败',
      'common.saveFail': '保存失败',
      'common.clearFail': '清除失败',
      'common.compareFail': '比对失败',
      'mark.turn': '转折',
      'mark.plant': '埋',
      'mark.pay': '收',
      'picker.empty': '这一层没有子目录。',
      'picker.isProject': '是项目',
      'picker.hasNovel': '含 novel-project',
      'chapter.unsavedLeave': '这一章还没保存，确定返回列表吗？',
      'settle.done': '已标记：设定库跟上这一章了。',
      'settle.none': '这一章本来就没有待更新的标记。',
      'settle.hint': '账本改完了就点这里，清掉「待更新设定」',
      'settle.disabled': '这一章没有待更新的设定',
      'lookback.hint': '保存时存档会前进，改动记录仍留在上一版里：拿它和现在比',
      'lookback.none': '这一章只有一版存档，还没有「上一次」可比',
      'lookback.noPrev': '读不到上一版',
      'font.label': '字号',
      'editor.styleHint': '黑体 · 单段空一行',
      'find.open': '查找（⌘F）',
      'find.close': '关闭查找',
      'find.placeholder': '在章内找…（选中一段再按 ⌘F 会带进来）',
      'find.keys': '⌘G 下一个 · ⇧⌘G 上一个',
      'graph.inSync': '与正文一致。',
      'graph.caption.relationship': '图由 bible/relationship-map.md 的「人物档位」与「文字版关系表」画出：圈越大越重要，实线亲情、虚线爱情、带叉敌对、点线师门；悬停关系卡可看细节。',
      'graph.caption.plot': '图由 bible/plot-map.md 的「故事线强度」表画出：横轴章号、纵轴 0–5，转折处用单调三次插值成弧，圆点是每章实际取值。',
      'graph.caption.scenes': '图由 bible/plot-map.md 的「场景节点」表画出：按章自上而下，同一章内按场景顺序；黄线是埋点、青线是回收、红线是转折。',
      'graph.caption.footer': '表由 agent 在阶段 3/6/7 补，脚本只补缺、不覆盖你改过的值。',
      'trace.noBrief': '没有找到这一章的细纲。',
      'hint.flow': '① 点开一章改正文　② ⌘S 保存（自动存一版并核对）　③ 只有挂上「待更新设定」的章才要你再动手：按清单改 bible/，回来点「设定已更新」。',
      'row.file': '文件',
      'row.status': '状态',
      'row.archive': '存档 · 字数',
      'panel.name': '小说助手',
      'level.1': '级别 1 · 措辞级',
      'level.2': '级别 2 · 事实级',
      'level.3': '级别 3 · 结构级',
      'level.hint': '级别 1 只是润色，存完就结束，不用点任何按钮；级别 2 是事实（数字/器物/谁在场），要改设定库；级别 3 是结构，先回对话里问。',
      'search.hits': '命中 {n} 章',
      'search.none': '没有匹配',
      'search.none.q': '没有找到「{q}」：换个人名、伏笔号或关键词试试',
      'search.ph': '搜摘要关键词：红契 / 裴渡 / 封仓；也可以输入章号',
      'search.hint': '每章下方是这一章的一句话摘要（来自 bible/digest.md）',
      'status.ok': '与存档一致',
      'result.reportTip': '清单：{file}',
      'result.delta': '{hunks} 处改动，{words} 字，{paras} 段',
      'chapter.archiveMeta': '当前存档 v{version}（{words} 字，{at}）',
      'chapter.prevAlive': ' · 上一版 v{n} 还在',
      'nav.volume': '卷{label}',
      'picker.readFail': '读不到这个目录',
      'chapter.rangeOne': '第 {n} 章',
      'chapter.rangeMany': '第 {first}–{last} 章',
      'chapter.groupMeta': '{chapters} 章 · {scenes} 个场景',
      'scenes.total': '{chapters} 章 · {scenes} 个场景',
      'scenes.hintLine': '点组展开 5 章，点章展开场景',
      'scenes.searchChapter': '第{n}章',
      'chapter.unsavedConfirm': '这一章有未保存的改动，确定切走吗？',
      'chapter.noArchiveHint': '还没有存档：保存时会把「保存前的这一稿」存成 v1，再和它比。',
      'graph.readSvgFail': '读不到这张图：{err}',
      'trace.chapterNo': '第 {n} 章',
      'nav.volAll': '全书',
      'nav.chapterTitle': '第 {n} 章 · {file}',
      'nav.chapterNo': '第 {n} 章',
      'nav.range': '第 {first}–{last} 章',
      'picker.willUse': '将使用：{dir}',
      'summary.consistent': '一致 {n}',
      'summary.drift': '改过未核对 {n}',
      'summary.missing': '没有存档 {n}',
      'summary.readFail': '读不到项目：{err}',
      'intro': '按章核对正文改动与设定库记录的差异，并给出需要同步的条目；人物关系、情节与场景随正文更新。',
      'chapter.noDigest': '（摘要还没写）',
      'chapter.words': '{n} 字',
      'graph.meta.people': '{people} 人 · {edges} 条关系',
      'graph.meta.plot': '{chapters} 章 · {lines} 条故事线',
      'graph.meta.scenes': '{scenes} 个场景 · {chapters} 章',
      'graph.noTable': '还没有图谱表：阶段 3 大纲完成后由 agent 生成',
      'graph.readFail': '读不到图谱：{err}',
      'graph.redrawHint': '点圆点或章号 → 看这一章的分怎么来的',
      'graph.missingStrength': '第 {list} 章已经写了，但强度表还是「—」：回对话里让 agent 补实测值',
      'scenes.empty': '还是空的：先让 agent 生成 `plot-map.md` 的「场景节点」表。',
      'scenes.readFail': '读不到场景：{err}',
      'scenes.groupMeta': '{chapters} 章 · {scenes} 个场景',
      'scenes.count': '{n} 个场景',
      'scenes.turn': '转折 {n}',
      'scenes.plant': '埋 {n}',
      'scenes.pay': '收 {n}',
      'trace.readFail': '读不到依据：{err}',
      'trace.title': '第 {n} 章 · 各线分数',
      'trace.digest': '摘要：{text}…',
      'trace.noDigest': '这一章还没写摘要行。',
      'trace.brief': '细纲 {file}：',
      'trace.hint': '想知道某个点为什么是这个分？点章号看依据（只读，不改正文与设定库）：',
      'row.pending': '待更新设定 · 级别 {n}',
      'row.words': '{n} 字',
      'row.unsaved': ' · 未保存',

      'status.drift': '改过，未核对',
      'status.missing': '没有存档',
      'next.dirty': '有未保存的改动',
      'next.save': '按 ⌘S 保存并核对',
      'next.structural': '这一章是结构级改动',
      'next.structuralDo': '先别动设定库：回对话里让 agent 查哪些后续章会失效，确认后再改',
      'next.debt': '设定库里还有一笔要还（级别 {n}）',
      'next.debtDo': '按清单改 bible/，改完点「设定已更新」；如果只是改回表里记的值，直接点也行',
      'next.nobaseline': '这一章还没有存档',
      'next.nobaselineDo': '按 ⌘S 保存：会先把现在这稿存成 v1，再和你改的比',
      'next.done': '这一章完事了',
      'next.doneDo': '设定库已经跟上，不用再点任何按钮',
      'result.same': '和存档一致，没有改动。',
      'result.unchanged': '正文没变，没有动文件。',
      'result.commentOnly': '只有末尾注释变了，正文没动——确认注释里的条目都进了设定库，就不用再管。',
      'result.level3': '结构级：先别急着改设定库。回对话里让 agent 查后续哪些章会失效，确认后再继续。',
      'result.report': '清单已写到 {file}——拿去对话里让 agent 按级别改设定库，改完按「设定已更新」。',
      'result.lookback': '回看：存档 v{v} → 现在（不是这次刚改的，是上一次保存留下的记录）',
      'result.structuralHint': '（可能到结构级）',
      'result.hunks': '改了 {n} 处；{delta}',


      'graph.relationship': '人物关系图',
      'graph.plot': '情节发展地图',
      'graph.scenes': '情节场景节点',
      'tab.chapters': '章节',
      'tab.relationship': '关系图谱',
      'tab.plot': '情节图谱',
      'tab.scenes': '场景图谱',
      'btn.back': '← 返回列表',
      'btn.save': '保存并核对（⌘S）',
      'btn.saving': '保存中…',
      'btn.reconcile': '只比对不保存',
      'btn.checking': '比对中…',
      'btn.settled': '设定已更新',
      'btn.settling': '标记中…',
      'btn.redraw': '重画',
      'btn.redrawing': '正在重画…',
      'btn.browse': '浏览…',
      'btn.refresh': '刷新',
      'btn.cancel': '取消',
      'btn.choose': '选这个目录',
      'btn.up': '上一级',
      'btn.fit': '适应宽度',
      'btn.reset': '100%',
      'picker.title': '选择项目目录',
      'hint.dir': '项目目录：可以点右边的「浏览…」选，也可以直接粘绝对路径（相对路径按 Host 工作目录解析）。',
      'ph.dir': '项目目录的绝对路径，或点「浏览…」选择',
      'empty.chapters': '这个目录下还没有章节。',
      'empty.chaptersHint': '要选的是含 PROJECT.md 与 chapters/ 的那一层；点「浏览…」进去后，可以直接点某一行右侧的「选这个」。',
      'stale': '图比表旧：点「重画」',
      'zoom': '缩放 {n}%',
      'pinned.bar': '已固定：{name}',
      'pinned.jump': '跳到第 {n} 章',
      'pinned.nowrite': '第 {n} 章（还没写到）',
      'pinned.clear': '取消（或双击图上任意处）',
      'pinned.hint': '单击人物可固定高亮，逐条查看他的关系；双击图上任意处还原。',
      'host.paths': 'Host 工作目录 {cwd} → 实际读取 {dir}',
      'empty.body': 'Host 返回了空响应（HTTP {status}）——面板后端没加载。先重启一次 DSH；仍然如此就升级插件（0.25.5 起才能在 0.2.1 宿主上用）。',
      'empty.body.short': 'Host 返回了空响应（HTTP {status}）',
      'err.bad-chapter-path': '章节路径不合法。',
      'err.empty-text': '正文是空的，没有保存。',
      'err.no-baseline': '这一章还没有存档。',
      'err.no-baseline-hint': '这一章还没有存档，先保存一次。',
      'err.no-previous': '这一章只有一版存档，没有「上次改了什么」可比。',
      'err.missing-chapter': '缺少 chapter 参数。',
      'err.dir-missing': '目录不存在。',
      'err.not-a-directory': '这不是一个目录。',
      'err.host-rejected': '请求未被 Host 准入。',
      'err.json-only': '接口只接受 JSON。',
      'err.server-error': '面板后端出错了。',
    }

    const EN = {
      'common.loading': 'Loading…',
      'common.reload': 'Reload',
      'common.none': 'none',
      'common.readFail': 'Cannot read',
      'common.readFailMsg': 'Read failed',
      'common.saveFail': 'Save failed',
      'common.clearFail': 'Clear failed',
      'common.compareFail': 'Compare failed',
      'mark.turn': 'turn',
      'mark.plant': 'plant',
      'mark.pay': 'payoff',
      'picker.empty': 'No subfolders here.',
      'picker.isProject': 'is a project',
      'picker.hasNovel': 'has novel-project',
      'chapter.unsavedLeave': 'This chapter has unsaved changes. Go back to the list anyway?',
      'settle.done': 'Marked: the settings library now matches this chapter.',
      'settle.none': 'This chapter had nothing pending to begin with.',
      'settle.hint': 'Click here once the ledgers are updated to clear “settings pending”',
      'settle.disabled': 'Nothing pending for this chapter',
      'lookback.hint': 'Saving advances the archive; the change record stays in the previous version — compare it with the current text',
      'lookback.none': 'Only one archive exists — nothing to compare against yet',
      'lookback.noPrev': 'Cannot read the previous version',
      'font.label': 'Size',
      'editor.styleHint': 'Sans · one blank line between paragraphs',
      'find.open': 'Find (⌘F)',
      'find.close': 'Close find',
      'find.placeholder': 'Find in chapter… (select text then ⌘F to prefill)',
      'find.keys': '⌘G next · ⇧⌘G previous',
      'graph.inSync': 'Matches the text.',
      'graph.caption.relationship': 'Drawn from the “tier” and “relations” tables in bible/relationship-map.md: larger circle = more important; solid = family, dashed = love, crossed = hostile, dotted = mentor; hover a relation card for details.',
      'graph.caption.plot': 'Drawn from the “storyline strength” table in bible/plot-map.md: chapters on x, 0–5 on y, monotone cubic arcs between points, dots are the actual values.',
      'graph.caption.scenes': 'Drawn from the “scene nodes” table in bible/plot-map.md: chapters top-down, scenes in order; yellow = plant, teal = payoff, red = turn.',
      'graph.caption.footer': 'The agent fills these tables in stages 3/6/7; the scripts only add missing rows and never overwrite your values.',
      'trace.noBrief': 'No brief found for this chapter.',
      'hint.flow': '① Open a chapter and edit　② ⌘S saves (archives a version and reconciles)　③ Only chapters marked “settings pending” need you: update bible/ per the list, then click “Settings updated”.',
      'row.file': 'File',
      'row.status': 'Status',
      'row.archive': 'Archive · words',
      'panel.name': 'Novel Assistant',
      'level.1': 'Level 1 · wording',
      'level.2': 'Level 2 · facts',
      'level.3': 'Level 3 · structure',
      'level.hint': 'Level 1 is wording only — saving is enough, no button needed. Level 2 is facts (numbers, objects, who was present) and needs the settings library updated. Level 3 is structural: ask the agent first.',
      'search.hits': '{n} chapters found',
      'search.none': 'No match',
      'search.none.q': 'Nothing matches “{q}” — try a character name, a foreshadow number, or another keyword.',
      'search.ph': 'Search digest: 红契 / 裴渡 / 封仓, or type a chapter number',
      'search.hint': 'Each chapter shows its one-line digest from bible/digest.md',
      'status.ok': 'Matches archive',
      'result.reportTip': 'List: {file}',
      'result.delta': '{hunks} changes, {words} words, {paras} paragraphs',
      'chapter.archiveMeta': 'Archive v{version} ({words} words, {at})',
      'chapter.prevAlive': ' · previous v{n} kept',
      'nav.volume': 'Vol. {label}',
      'picker.readFail': 'Cannot read this folder',
      'chapter.rangeOne': 'Chapter {n}',
      'chapter.rangeMany': 'Chapters {first}–{last}',
      'chapter.groupMeta': '{chapters} chapters · {scenes} scenes',
      'scenes.total': '{chapters} chapters · {scenes} scenes',
      'scenes.hintLine': 'Click a group to expand 5 chapters; click a chapter for its scenes',
      'scenes.searchChapter': 'chapter{n}',
      'chapter.unsavedConfirm': 'This chapter has unsaved changes. Leave anyway?',
      'chapter.noArchiveHint': 'No archive yet: saving first stores the current draft as v1, then compares against it.',
      'graph.readSvgFail': 'Cannot read the image: {err}',
      'trace.chapterNo': 'Chapter {n}',
      'nav.volAll': 'All',
      'nav.chapterTitle': 'Chapter {n} · {file}',
      'nav.chapterNo': 'Chapter {n}',
      'nav.range': 'Chapters {first}–{last}',
      'picker.willUse': 'Will use: {dir}',
      'summary.consistent': '{n} in sync',
      'summary.drift': '{n} edited, not reconciled',
      'summary.missing': '{n} without archive',
      'summary.readFail': 'Cannot read the project: {err}',
      'intro': 'Check each chapter’s text against the settings library and list what still needs syncing; characters, plot and scenes follow the text.',
      'chapter.noDigest': '(no digest yet)',
      'chapter.words': '{n} words',
      'graph.meta.people': '{people} characters · {edges} relations',
      'graph.meta.plot': '{chapters} chapters · {lines} storylines',
      'graph.meta.scenes': '{scenes} scenes · {chapters} chapters',
      'graph.noTable': 'No map tables yet — the agent creates them after stage 3 (outline).',
      'graph.readFail': 'Cannot read the map: {err}',
      'graph.redrawHint': 'Click a dot or a chapter number to see how that score was reached',
      'graph.missingStrength': 'Chapter {list} is written but its strengths are still “—”. Ask the agent to fill the measured values.',
      'scenes.empty': 'Still empty — ask the agent to generate the “场景节点” table in `plot-map.md`.',
      'scenes.readFail': 'Cannot read the scenes: {err}',
      'scenes.groupMeta': '{chapters} chapters · {scenes} scenes',
      'scenes.count': '{n} scenes',
      'scenes.turn': 'turns {n}',
      'scenes.plant': 'plants {n}',
      'scenes.pay': 'pays off {n}',
      'trace.readFail': 'Cannot read the evidence: {err}',
      'trace.title': 'Chapter {n} · storyline scores',
      'trace.digest': 'Digest: {text}…',
      'trace.noDigest': 'This chapter has no digest line yet.',
      'trace.brief': 'Brief {file}:',
      'trace.hint': 'Want to know why a score is what it is? Click a chapter number (read-only — never touches text or settings):',
      'row.pending': 'Settings pending · level {n}',
      'row.words': '{n} words',
      'row.unsaved': ' · unsaved',

      'status.drift': 'Edited, not reconciled',
      'status.missing': 'No archive',
      'next.dirty': 'Unsaved changes',
      'next.save': 'Press ⌘S to save & reconcile',
      'next.structural': 'This chapter is a structural change',
      'next.structuralDo': 'Leave the settings library alone: ask the agent which later chapters break, then decide.',
      'next.debt': 'The settings library still owes one update (level {n})',
      'next.debtDo': 'Update bible/ per the list, then click “Settings updated”; if you only restored the recorded value, just click it.',
      'next.nobaseline': 'This chapter has no archive yet',
      'next.nobaselineDo': 'Press ⌘S: the current draft is archived as v1 first, then compared with your edit.',
      'next.done': 'This chapter is done',
      'next.doneDo': 'The settings library is up to date — no buttons needed.',
      'result.same': 'Matches the archive — nothing changed.',
      'result.unchanged': 'No change in the text; no file written.',
      'result.commentOnly': 'Only the trailing comment changed. Once its items are in the settings library, nothing else to do.',
      'result.level3': 'Structural: do not touch the settings library yet. Ask the agent which later chapters break, then continue.',
      'result.report': 'The list was written to {file} — take it to the chat and let the agent update the settings library by level, then click “Settings updated”.',
      'result.lookback': 'Look-back: archive v{v} → now (not this edit — left by the previous save)',
      'result.structuralHint': ' (maybe structural)',
      'result.hunks': '{n} places changed; {delta}',


      'graph.relationship': 'Character relationships',
      'graph.plot': 'Plot map',
      'graph.scenes': 'Scene map',
      'tab.chapters': 'Chapters',
      'tab.relationship': 'Relationships',
      'tab.plot': 'Plot',
      'tab.scenes': 'Scenes',
      'btn.back': '← Back to list',
      'btn.save': 'Save & reconcile (⌘S)',
      'btn.saving': 'Saving…',
      'btn.reconcile': 'Compare only',
      'btn.checking': 'Comparing…',
      'btn.settled': 'Settings updated',
      'btn.settling': 'Marking…',
      'btn.redraw': 'Redraw',
      'btn.redrawing': 'Redrawing…',
      'btn.browse': 'Browse…',
      'btn.refresh': 'Refresh',
      'btn.cancel': 'Cancel',
      'btn.choose': 'Use this folder',
      'btn.up': 'Up',
      'btn.fit': 'Fit width',
      'btn.reset': '100%',
      'picker.title': 'Choose the project folder',
      'hint.dir': 'Project folder: pick one with “Browse…” on the right, or paste an absolute path (relative paths resolve against the Host working directory).',
      'ph.dir': 'Absolute path to the project, or pick with “Browse…”',
      'empty.chapters': 'No chapters in this folder yet.',
      'empty.chaptersHint': 'Pick the folder that contains PROJECT.md and chapters/ — after opening Browse…, you can click “Use this” on a row.',
      'stale': 'Map is older than the table — click Redraw',
      'zoom': 'Zoom {n}%',
      'pinned.bar': 'Pinned: {name}',
      'pinned.jump': 'Jump to chapter {n}',
      'pinned.nowrite': 'Chapter {n} (not written yet)',
      'pinned.clear': 'Clear (or double-click anywhere on the map)',
      'pinned.hint': 'Click a character to pin the highlight and read each relation; double-click anywhere to restore.',
      'host.paths': 'Host working directory {cwd} → reading {dir}',
      'empty.body': 'The Host returned an empty response (HTTP {status}) — the panel backend is not loaded. Restart DSH once; if it persists, upgrade the plugin (0.25.5+ works on a 0.2.1 Host).',
      'empty.body.short': 'The Host returned an empty response (HTTP {status})',
      'err.bad-chapter-path': 'Invalid chapter path.',
      'err.empty-text': 'The chapter is empty — nothing was saved.',
      'err.no-baseline': 'This chapter has no archive yet.',
      'err.no-baseline-hint': 'This chapter has no archive yet — save once first.',
      'err.no-previous': 'Only one version is archived, so there is nothing to compare against.',
      'err.missing-chapter': 'Missing the chapter parameter.',
      'err.dir-missing': 'That folder does not exist.',
      'err.not-a-directory': 'That path is not a folder.',
      'err.host-rejected': 'The Host rejected this request.',
      'err.json-only': 'This endpoint only accepts JSON.',
      'err.server-error': 'The panel backend failed.',
    }

    /** 安全取 locale 服务：拿不到就返回 undefined，绝不因访问服务而抛错。 */
    const getLocale = (ctx) => {
      try {
        if (ctx && typeof ctx.get === 'function') return ctx.get('locale')
      } catch (err) {
        /* 服务不存在或不允许访问 —— 退回中文 */
      }
      return undefined
    }

    /** 当前界面语言：读 <html lang>（由语言服务维护），只分辨中/英。 */
    const uiLang = () => {
      try {
        const lang = String((document && document.documentElement && document.documentElement.lang) || '')
        return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch (err) {
        return 'zh'
      }
    }

    /** 绑定后的翻译函数（拿到 locale 服务后才有）；没有就退回中文。 */
    let boundT = null
    /** 翻译：每次调用时再看一眼绑定，避免 apply 阶段服务还没就绪就把翻译固化成中文。 */
    const t = (key, params) => {
      if (boundT) {
        try {
          return boundT(key, params)
        } catch (err) {
          /* 服务异常时退回中文，不让界面因为一句文案崩掉 */
        }
      }
      const dict = ZH[key] ?? key
      return params ? dict.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? '')) : dict
    }

    const text = 'var(--dsw-alias-text-primary, #e8e8e8)'
    const dim = 'var(--dsw-alias-text-secondary, #9aa0a6)'
    const line = 'var(--dsw-alias-border-secondary, rgba(128,128,128,.28))'
    const bg = 'var(--dsw-alias-bg-secondary, rgba(128,128,128,.08))'

    /** 正文用黑体：见「字体」这一条需求。宋体只留给印刷稿，屏幕上黑体更清楚。 */
    const SANS = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Source Han Sans SC","Noto Sans CJK SC",system-ui,sans-serif'
    const FONT_KEY = 'novel-panel.fontSize'
    const FONT_DEFAULT = 17
    const FONT_MIN = 13
    const FONT_MAX = 30

    const STATUS = {
      ok: { key: 'status.ok', color: 'var(--dsw-alias-text-secondary, #8a8f94)' },
      drift: { key: 'status.drift', color: '#d08b2c' },
      missing: { key: 'status.missing', color: '#c0504d' },
    }

    /** 「下一步」条的语气：做/还债/别动/完事。 */
    const NEXT_TONE = {
      work: { bg: 'rgba(90,140,220,.14)', border: 'rgba(90,140,220,.45)', color: '#7aa2dd' },
      debt: { bg: 'rgba(208,139,44,.14)', border: 'rgba(208,139,44,.45)', color: '#d08b2c' },
      stop: { bg: 'rgba(192,80,77,.14)', border: 'rgba(192,80,77,.5)', color: '#c0504d' },
      done: { bg: 'rgba(128,128,128,.10)', border: 'rgba(128,128,128,.3)', color: 'var(--dsw-alias-text-secondary, #8a8f94)' },
    }

    /** 级别徽章：标签随语言变，颜色固定。 */
    const LEVEL = {
      1: { color: 'var(--dsw-alias-text-secondary, #8a8f94)', key: 'level.1' },
      2: { color: '#d08b2c', key: 'level.2' },
      3: { color: '#c0504d', key: 'level.3' },
    }
    const levelLabel = (n) => t(LEVEL[n] ? LEVEL[n].key : 'level.1')

    const button = (label, onClick, { disabled = false, primary = false, title } = {}) => h('button', {
      type: 'button',
      title,
      disabled,
      onClick,
      style: {
        padding: '6px 12px',
        color: primary ? '#fff' : text,
        background: primary ? '#3b6fd4' : bg,
        border: `1px solid ${primary ? '#3b6fd4' : line}`,
        borderRadius: 6,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        font: 'inherit',
      },
    }, label)

    /** 与 check-chapter 同口径的粗略字数：CJK 逐字 + 拉丁词。 */
    function countWords(source) {
      const body = source
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/^#{1,6}\s.*$/gm, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
      const cjk = (body.match(/[\u3400-\u9fff]/g) || []).length
      const latin = (body.match(/[A-Za-z0-9]+/g) || []).length
      return cjk + latin
    }

    /**
     * 取 JSON。宿主回空体或非 JSON 时给出可读错误，不要抛 `Unexpected end of JSON input`。
     * @param {string} url 地址
     * @param {object} [options] fetch 选项
     * @returns {Promise<object>} 解析后的 body
     */
    async function requestJson(url, options) {
      const response = await fetch(url, options)
      const raw = await response.text()
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = null
      }
      if (!body) {
        const backendMissing = response.status === 404 || response.status === 400 || response.status === 405
        throw new Error(t(backendMissing ? 'empty.body' : 'empty.body.short', { status: response.status }))
      }
      // Host 用 error 码表达失败原因；这里翻译，拿不到码就退回 Host 给的原话。
      if (body.ok === false) {
        const key = body.code ? `err.${body.code}` : ''
        const translated = key && ZH[key] ? t(key) : body.error
        const failure = new Error(translated || t('err.server-error'))
        failure.code = body.code
        throw failure
      }
      return body
    }

    function readFontSize() {
      try {
        const raw = Number(window.localStorage.getItem(FONT_KEY))
        if (Number.isFinite(raw) && raw >= FONT_MIN && raw <= FONT_MAX) return raw
      } catch {
        /* 隐身模式没有 storage */
      }
      return FONT_DEFAULT
    }

    /** 章内查找：不分大小写，返回每一处的位置。 */
    function findMatches(haystack, needle) {
      if (!needle) return []
      const lowerHay = haystack.toLowerCase()
      const lowerNeedle = needle.toLowerCase()
      const hits = []
      let from = 0
      while (hits.length < 2000) {
        const at = lowerHay.indexOf(lowerNeedle, from)
        if (at === -1) break
        hits.push({ start: at, end: at + needle.length })
        from = at + Math.max(1, needle.length)
      }
      return hits
    }

    function readProject() {
      try {
        return window.localStorage.getItem(STORAGE_KEY) || 'novel-project'
      } catch {
        return 'novel-project'
      }
    }

    function icon(size, active) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M3 2.5h7l3 3v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z' }),
        h('path', { d: 'M9.5 2.5v3.5H13' }),
        h('path', { d: active ? 'M5 9.5h6M5 11.8h4' : 'M5 8h6M5 10.5h4' }),
      )
    }

    function PanelIcon({ size, active }) {
      return icon(size, active)
    }

    function Row({ row, onOpen, query }) {
      const status = STATUS[row.status] || STATUS.ok
      const statusLabel = t(status.key)
      const pending = row.pending
      const badge = pending
        ? { label: `待更新设定 · 级别 ${pending.level}`, color: pending.level >= 3 ? '#c0504d' : '#d08b2c' }
        : status
      const [hover, setHover] = React.useState(false)
      const q = String(query || '').trim()
      const summary = row.summary || ''
      const at = q ? summary.toLowerCase().indexOf(q.toLowerCase()) : -1
      const shown = at < 0
        ? summary
        : [summary.slice(0, at),
            h('mark', {
              key: 'q',
              style: { background: 'rgba(208,139,44,.28)', color: 'inherit', borderRadius: 3, padding: '0 2px' },
            }, summary.slice(at, at + q.length)),
            summary.slice(at + q.length)]
      return h('div', {
        onClick: () => onOpen(row.key),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          borderTop: `1px solid ${line}`,
          cursor: 'pointer',
          background: hover ? bg : 'transparent',
          padding: '8px 10px',
        },
      },
        h('div', {
          style: { display: 'grid', gridTemplateColumns: '64px 1fr 96px 72px', gap: 12, alignItems: 'baseline' },
        },
          h('span', { style: { color: dim, fontVariantNumeric: 'tabular-nums' } }, `第 ${row.chapter || '?'} 章`),
          h('span', { style: { color: text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.key),
          h('span', { style: { color: badge.color }, title: pending ? t('result.reportTip', { file: pending.report || '—' }) : undefined }, t(badge.key)),
          h('span', { style: { color: dim, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } },
            row.baseline ? `v${row.baseline} · ${row.words}` : t('chapter.words', { n: row.words })),
        ),
        summary
          ? h('div', {
              style: {
                color: dim, fontSize: 12, lineHeight: 1.6, marginTop: 4, paddingLeft: 76,
                overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              },
            }, shown)
          : null,
      )
    }

    /** 保存后的核对结果：级别、依据、报告路径。 */
    function Result({ result }) {
      if (!result) return null
      if (result.changed === false) return h('div', { style: { color: dim, marginTop: 10 } }, t('result.unchanged'))
      if (!(result.hunks || []).length) {
        return h('div', { style: { color: dim, marginTop: 10 } }, t('result.same'))
      }
      const level = LEVEL[result.suggestedLevel] || LEVEL[1]
      return h('div', {
        style: { marginTop: 12, padding: '10px 12px', border: `1px solid ${line}`, borderRadius: 8, background: bg },
      },
        result.lookBack
          ? h('div', { style: { color: dim, marginBottom: 4 } },
              t('result.lookback', { v: result.baseline.version }))
          : null,
        h('div', { style: { color: level.color, fontWeight: 600 } },
          `${levelLabel(result.suggestedLevel)}${result.structuralHint ? t('result.structuralHint') : ''}`),
        result.commentOnly
          ? h('div', { style: { color: dim, marginTop: 4 } }, t('result.commentOnly'))
          : h('div', { style: { color: dim, marginTop: 4 } },
              t('result.delta', { hunks: (result.hunks || []).length, words: `${result.deltaWords >= 0 ? '+' : ''}${result.deltaWords}`, paras: `${result.deltaParagraphs >= 0 ? '+' : ''}${result.deltaParagraphs}` })),
        (result.reasons || []).length
          ? h('ul', { style: { margin: '6px 0 0 18px', padding: 0, color: text } },
              ...result.reasons.map((reason, index) => h('li', { key: index, style: { marginBottom: 2 } }, reason)))
          : null,
        result.report
          ? h('div', { style: { color: dim, marginTop: 6, fontSize: 12 } }, t('result.report', { file: result.report }))
          : null,
        result.suggestedLevel >= 3
          ? h('div', { style: { color: '#c0504d', marginTop: 6 } }, t('result.level3'))
          : null,
      )
    }

    function Panel() {
      const [project, setProject] = React.useState(readProject)
      const [draft, setDraft] = React.useState(readProject)
      /** 目录选择器：点「浏览…」后列子目录，点一行进去，点「选这个目录」用当前目录 */
      const [pick, setPick] = React.useState({ open: false, busy: false, dir: '', parent: null, entries: [], error: '' })
      const [list, setList] = React.useState({ phase: 'idle' })
      const [opened, setOpened] = React.useState(null) // { key, text, words, status, baseline, report, updatedAt }
      const [editing, setEditing] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState('')
      const [fontSize, setFontSize] = React.useState(readFontSize)
      const [tab, setTab] = React.useState('chapters')
      const [sceneData, setSceneData] = React.useState({ phase: 'idle' })
      const [openGroups, setOpenGroups] = React.useState(null)
      const [openChapters, setOpenChapters] = React.useState([])
      const [sceneVol, setSceneVol] = React.useState(0)
      const [chapterQuery, setChapterQuery] = React.useState('')
      const [sceneQuery, setSceneQuery] = React.useState('')
      const [graph, setGraph] = React.useState({ phase: 'idle' })
      const [graphBusy, setGraphBusy] = React.useState(false)
      const [svgText, setSvgText] = React.useState({ kind: '', text: '', error: '' })
      const [tip, setTip] = React.useState(null)
      const [view, setView] = React.useState({ scale: 1 })
      const [plotVol, setPlotVol] = React.useState(0) // 0 = 未分卷
      const [nat, setNat] = React.useState({ w: 900, h: 600 })
      const [hovered, setHovered] = React.useState('')
      // 点一下把人钉住：鼠标移开后高亮不散，方便顺着连线看关系内容；双击取消
      const [pinned, setPinned] = React.useState('')
      const [trace, setTrace] = React.useState({ phase: 'idle' })
      const [find, setFind] = React.useState({ open: false, query: '', index: 0 })
      const areaRef = React.useRef(null)
      const findInputRef = React.useRef(null)
      const boxRef = React.useRef(null)
      const backRef = React.useRef(null)
      const backInnerRef = React.useRef(null)

      const dirty = Boolean(opened) && editing !== opened.text
      const matches = React.useMemo(() => findMatches(editing, find.query), [editing, find.query])
      const hitAt = matches[Math.min(find.index, matches.length - 1)] || null

      /** 把正文切成「普通段 / 命中段」，命中段单独上底色。 */
      const segments = React.useMemo(() => {
        if (!find.open || !find.query || !matches.length) return [{ text: editing }]
        const out = []
        const current = Math.min(find.index, matches.length - 1)
        let cursor = 0
        matches.forEach((hit, index) => {
          if (hit.start > cursor) out.push({ text: editing.slice(cursor, hit.start) })
          out.push({ text: editing.slice(hit.start, hit.end), hit: true, current: index === current })
          cursor = hit.end
        })
        out.push({ text: editing.slice(cursor) })
        return out
      }, [editing, matches, find.open, find.index, find.query])

      /** 一句话说清「现在该做什么」：面板上只留一个主按钮，其余都是备选。 */
      const nextStep = () => {
        if (!opened) return null
        if (dirty) {
          return { tone: 'work', text: t('next.dirty'), action: t('next.save') }
        }
        if (opened.pending) {
          if (opened.pending.level >= 3) {
            return { tone: 'stop', text: t('next.structural'), action: t('next.structuralDo') }
          }
          return { tone: 'debt', text: t('next.debt', { n: opened.pending.level }), action: t('next.debtDo') }
        }
        if (opened.status === 'missing') {
          return { tone: 'work', text: t('next.nobaseline'), action: t('next.nobaselineDo') }
        }
        return { tone: 'done', text: t('next.done'), action: t('next.doneDo') }
      }

      const load = React.useCallback(async (target) => {
        setList({ phase: 'loading' })
        try {
          const body = await requestJson(`/novel-panel/status?project=${encodeURIComponent(target)}`, {
            headers: { accept: 'application/json' },
          })
          setList({ phase: 'ready', body })
        } catch (failure) {
          setList({ phase: 'failed', error: String((failure && failure.message) || failure) })
        }
      }, [])

      const loadGraph = React.useCallback(async (target) => {
        setGraph({ phase: 'loading' })
        try {
          const body = await requestJson(`/novel-panel/graph?project=${encodeURIComponent(target)}`, {
            headers: { accept: 'application/json' },
          })
          setGraph({ phase: 'ready', body })
        } catch (failure) {
          setGraph({ phase: 'failed', error: String((failure && failure.message) || failure) })
        }
      }, [])

      const loadScenes = React.useCallback(async (target) => {
        setSceneData({ phase: 'loading' })
        try {
          const body = await requestJson(`/novel-panel/scenes?project=${encodeURIComponent(target)}`, {
            headers: { accept: 'application/json' },
          })
          setSceneData({ phase: 'ready', body })
        } catch (failure) {
          setSceneData({ phase: 'failed', error: String((failure && failure.message) || failure) })
        }
      }, [])

      React.useEffect(() => {
        void load(project)
      }, [load, project])

      React.useEffect(() => {
        if (tab !== 'chapters') void loadGraph(project)
      }, [loadGraph, project, tab])

      // 缩放以「画框内滚动位置」为基准：放大后光标下的那一点仍在原处
      const zoomAt = (factor, clientX, clientY) => {
        const box = graphBox.current
        if (!box) return
        setView((prev) => {
          const next = Math.min(4, Math.max(0.15, Number((prev.scale * factor).toFixed(3))))
          if (next === prev.scale) return prev
          const rect = box.getBoundingClientRect()
          const px = clientX - rect.left + box.scrollLeft
          const py = clientY - rect.top + box.scrollTop
          const k = next / prev.scale
          window.requestAnimationFrame(() => {
            box.scrollLeft = px * k - (clientX - rect.left)
            box.scrollTop = py * k - (clientY - rect.top)
          })
          return { scale: next }
        })
      }

      const graphBox = React.useRef(null)
      const graphInner = React.useRef(null)
      React.useEffect(() => {
        const box = graphBox.current
        if (!box) return undefined
        const onWheel = (event) => {
          // 场景图不需要缩放，滚轮一律当滚动（m03427）
          if (svgText.kind === 'scenes') {
            const canScroll = box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1
            if (!canScroll) return
            event.preventDefault()
            box.scrollTop += event.deltaY
            box.scrollLeft += event.deltaX
            return
          }
          // ⌘/Ctrl + 滚轮：缩放；裸滚轮：留在画框里滚（不让整页跟着动）
          if (event.metaKey || event.ctrlKey) {
            event.preventDefault()
            zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY)
            return
          }
          const canScrollY = box.scrollHeight > box.clientHeight + 1
          const canScrollX = box.scrollWidth > box.clientWidth + 1
          if (!canScrollX && !canScrollY) return
          event.preventDefault()
          if (event.shiftKey) box.scrollLeft += event.deltaY
          else {
            box.scrollTop += event.deltaY
            box.scrollLeft += event.deltaX
          }
        }
        box.addEventListener('wheel', onWheel, { passive: false })
        return () => box.removeEventListener('wheel', onWheel)
      }, [svgText.kind, tab, nat.w, nat.h])

      // 关系内容只在「悬停关系卡」时出现：卡片是实体元素，命中有保障；
      // 顺带点亮卡片边框，并且对每一张卡都生效（原生 <title> 时有时无，已从 SVG 里去掉）。
      React.useEffect(() => {
        const box = graphBox.current
        if (!box || svgText.kind !== 'relationship') return
        const cards = [...box.querySelectorAll('g.edge')]
        const store = new Map()
        const lines = new Map()
        const lineFor = (a, b) => [...box.querySelectorAll('g.link')].find((g) => {
          const ga = g.getAttribute('data-a')
          const gb = g.getAttribute('data-b')
          return (ga === a && gb === b) || (ga === b && gb === a)
        })
        const onEnter = (card) => {
          // 固定/悬停某个人时，只有他的关系卡可悬停；别人的卡虽然压暗了，也不能抢提示
          const focus = pinned || hovered
          const ca = card.getAttribute('data-a')
          const cb = card.getAttribute('data-b')
          if (focus && ca !== focus && cb !== focus) return
          const rect = card.querySelector('rect')
          if (rect) {
            store.set(card, {
              stroke: rect.getAttribute('stroke'),
              opacity: rect.getAttribute('stroke-opacity'),
              width: rect.getAttribute('stroke-width'),
            })
            rect.setAttribute('stroke', '#9fc3ff')
            rect.setAttribute('stroke-opacity', '1')
            rect.setAttribute('stroke-width', '1.4')
            const box2 = rect.getBoundingClientRect()
            // 浮层会在 x+16 / y+18 处出现，这里留出一点余量，落在卡片右下方、不压住卡片
            setTip({ text: card.getAttribute('data-tip') || '', x: box2.right + 6, y: box2.top - 6 })
            // 卡片和线是同一件事的两端：悬停卡片时把这条线也点亮
            const link = lineFor(card.getAttribute('data-a'), card.getAttribute('data-b'))
            const path = link ? link.querySelector('path') : null
            if (link && path) {
              lines.set(link, {
                width: path.getAttribute('stroke-width'),
                opacity: link.style.opacity,
                marker: path.getAttribute('marker-end'),
              })
              path.setAttribute('stroke-width', '3.2')
              path.setAttribute('marker-end', 'url(#arw-lg)')
              link.style.opacity = '1'
            }
          } else {
            setTip(null)
          }
        }
        const onLeave = (card) => {
          const rect = card.querySelector('rect')
          const prev = store.get(card)
          if (rect && prev) {
            rect.setAttribute('stroke', prev.stroke || '')
            rect.setAttribute('stroke-opacity', prev.opacity || '0.35')
            rect.setAttribute('stroke-width', prev.width || '1')
          }
          const link = lineFor(card.getAttribute('data-a'), card.getAttribute('data-b'))
          const prevLine = link ? lines.get(link) : null
          if (link && prevLine) {
            const path = link.querySelector('path')
            if (path) {
              path.setAttribute('stroke-width', prevLine.width || '1.5')
              path.setAttribute('marker-end', prevLine.marker || 'url(#arw)')
            }
            link.style.opacity = prevLine.opacity || ''
            lines.delete(link)
          }
          setTip(null)
        }
        const bound = cards.map((card) => {
          const enter = () => onEnter(card)
          const leave = () => onLeave(card)
          card.addEventListener('pointerenter', enter)
          card.addEventListener('pointerleave', leave)
          return { card, enter, leave }
        })
        return () => bound.forEach(({ card, enter, leave }) => {
          card.removeEventListener('pointerenter', enter)
          card.removeEventListener('pointerleave', leave)
        })
      }, [svgText])

      // 悬停人物：只留这个人的关系，其余压暗
      React.useEffect(() => {
        const box = graphBox.current
        if (!box) return
        const hl = pinned || hovered
        // 悬停某人：他自己 + 与他直接相连的人保持明亮，其余压暗；
        // 连线仍只留他自己的那些（别人的关系不该因为邻居亮起来而一起亮）。
        const neighbor = new Set()
        if (hl) {
          box.querySelectorAll('[data-a]').forEach((el) => {
            const a = el.getAttribute('data-a')
            const b = el.getAttribute('data-b')
            if (a === hl && b) neighbor.add(b)
            else if (b === hl && a) neighbor.add(a)
          })
        }
        box.querySelectorAll('[data-node]').forEach((el) => {
          const name = el.getAttribute('data-node')
          const on = !hl || name === hl || neighbor.has(name)
          el.style.opacity = on ? '1' : '0.18'
        })
        box.querySelectorAll('[data-a]').forEach((el) => {
          const a = el.getAttribute('data-a')
          const b = el.getAttribute('data-b')
          const hit = !hl || a === hl || b === hl
          // 压暗的元素不再接鼠标：固定某人时，别人的线和卡都不该响应悬停
          if (!hit) el.style.pointerEvents = 'none'
          else el.style.pointerEvents = ''
          // 跨簇标签平时不显示（opacity="0"），只有它的两端被悬停时才露出来
          if (el.getAttribute('data-cross') === '1') {
            el.style.opacity = hit ? '1' : '0'
            // 隐藏时也不能挡住鼠标，显示出来才可悬停
            el.style.pointerEvents = hit ? 'auto' : 'none'
            return
          }
          el.style.opacity = hit ? '1' : '0.08'
        })
      }, [hovered, pinned, svgText])

      const dragRef = React.useRef(null)
      const onGraphPointerDown = (event) => {
        if (event.button !== 0) return
        const box = graphBox.current
        dragRef.current = {
          x: event.clientX,
          y: event.clientY,
          sx: box ? box.scrollLeft : 0,
          sy: box ? box.scrollTop : 0,
          moved: false,
        }
      }
      const onGraphPointerMove = (event) => {
        const d = dragRef.current
        const box = graphBox.current
        if (d && box) {
          const dx = event.clientX - d.x
          const dy = event.clientY - d.y
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
          box.scrollLeft = d.sx - dx
          box.scrollTop = d.sy - dy
          return
        }
        const node = event.target && event.target.closest ? event.target.closest('[data-node]') : null
        const name = node ? node.getAttribute('data-node') : ''
        if (name !== hovered) setHovered(name)
      }
      const endDrag = () => { dragRef.current = null }

      const openTrace = async (chapter) => {
        setTrace({ phase: 'loading', chapter })
        try {
          const body = await requestJson(`/novel-panel/trace?project=${encodeURIComponent(project)}&chapter=${chapter}`, {
            headers: { accept: 'application/json' },
          })
          setTrace(body.ok
            ? { phase: 'ready', chapter, body }
            : { phase: 'failed', chapter, error: body.error || t('common.readFail') })
        } catch (failure) {
          setTrace({ phase: 'failed', chapter, error: String((failure && failure.message) || failure) })
        }
      }

      const jumpToChapter = (chapter) => {
        const row = body && body.ok ? body.chapters.find((c) => c.chapter === chapter) : null
        if (!row) return
        setTab('chapters')
        void openChapter(row.key)
      }

      const loadSvg = React.useCallback(async (kind, stamp, vol) => {
        try {
          const volQuery = kind === 'plot' && vol ? `&vol=${String(vol).padStart(2, '0')}` : ''
          const response = await fetch(`/novel-panel/graph.svg?project=${encodeURIComponent(project)}&kind=${kind}${volQuery}&t=${stamp || 0}`, {
            headers: { accept: 'image/svg+xml' },
          })
          const body = await response.text()
          if (!response.ok) {
            setSvgText({ kind, text: '', error: body || `HTTP ${response.status}` })
            return
          }
          const size = body.match(/<svg[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/)
          setNat({ w: size ? Math.round(Number(size[1])) : 900, h: size ? Math.round(Number(size[2])) : 600 })
          setSvgText({ kind, text: body, error: '' })
        } catch (failure) {
          setSvgText({ kind, text: '', error: String((failure && failure.message) || failure) })
        }
      }, [project])

      React.useEffect(() => {
        setTip(null)
        setHovered('')
        if (tab === 'chapters') return
        if (tab === 'scenes') { void loadScenes(project); return }
        const status = graph.phase === 'ready' ? graph.body : null
        const stamp = status && status.updatedAt ? Math.round(status.updatedAt) : 0
        const vols = status && status.plotVolumes ? status.plotVolumes : []
        // 分卷后默认看最后一卷（也就是正在写的那一卷）
        const wanted = plotVol || (vols.length ? vols[vols.length - 1].vol : 0)
        void loadSvg(tab === 'plot' ? 'plot' : tab === 'scenes' ? 'scenes' : 'relationship', stamp, wanted)
      }, [graph, loadScenes, loadSvg, project, tab, plotVol])

      const submit = (next) => {
        const value = (next || '').trim() || 'novel-project'
        try {
          window.localStorage.setItem(STORAGE_KEY, value)
        } catch {
          /* 隐身模式没有 storage，不影响读取 */
        }
        setProject(value)
      }

      /** 直接采用某个子目录（不必先进去再点“选这个目录”）。 */
      const usePicked = (dir) => {
        setPick((prev) => ({ ...prev, open: false }))
        setDraft(dir)
        submit(dir)
      }

      /** 场景标记的动词要按界面语言翻（埋 / 收 / 转折 / 收束），编号与作者备注保持原样。 */
      const sceneTagText = (part) => {
        const name = String(part || '').trim()
        if (!name) return ''
        if (uiLang() === 'zh') return name
        if (/^收束/.test(name)) return t('tag.end')
        if (/^转折|^反转/.test(name)) return t('tag.turn')
        if (/^埋/.test(name)) return name.replace(/^埋\s*/, `${t('tag.plant')} `)
        if (/^收/.test(name)) return name.replace(/^收\s*/, `${t('tag.payoff')} `)
        return name
      }

      const goPick = async (dir) => {
        setPick((prev) => ({ ...prev, open: true, busy: true, error: '' }))
        try {
          const query = dir ? `?dir=${encodeURIComponent(dir)}` : ''
          const body = await requestJson(`/novel-panel/browse${query}`)
          if (body.ok === false) throw new Error(body.error || t('picker.readFail'))
          setPick({ open: true, busy: false, dir: body.dir, parent: body.parent, entries: body.entries || [], error: '' })
        } catch (failure) {
          setPick((prev) => ({ ...prev, busy: false, error: String((failure && failure.message) || failure) }))
        }
      }

      /** 打开选择器时，优先从当前填的路径（绝对路径）或它的上一级开始 */
      const openPick = () => {
        const start = (draft || '').trim()
        void goPick(start.startsWith('/') ? start : '')
      }

      const post = (path, body) => requestJson(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project, ...body }),
      })

      const redrawGraph = async () => {
        if (graphBusy) return
        setGraphBusy(true)
        try {
          // <html lang> 由语言服务维护；这里据此决定 SVG 里的文字用中文还是英文
          const pageLang = String((document && document.documentElement && document.documentElement.lang) || '')
          const lang = pageLang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
          const body = await post('/novel-panel/graph/sync', { lang })
          setGraph({ phase: 'ready', body: body.status, log: body.log, failed: body.ok === false })
        } catch (failure) {
          setGraph({ phase: 'failed', error: String((failure && failure.message) || failure) })
        } finally {
          setGraphBusy(false)
        }
      }

      const openChapter = async (key) => {
        if (dirty && !window.confirm(t('chapter.unsavedConfirm'))) return
        setBusy('open')
        setError('')
        setResult(null)
        try {
          const body = await requestJson(`/novel-panel/chapter?project=${encodeURIComponent(project)}&chapter=${encodeURIComponent(key)}`, {
            headers: { accept: 'application/json' },
          })
          if (!body.ok) throw new Error(body.error || t('common.readFailMsg'))
          setOpened(body)
          setEditing(body.text)
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setBusy('')
        }
      }

      const back = () => {
        if (dirty && !window.confirm(t('chapter.unsavedLeave'))) return
        setOpened(null)
        setEditing('')
        setResult(null)
        setError('')
        void load(project)
      }

      const save = async () => {
        if (!opened || busy) return
        setBusy('save')
        setError('')
        try {
          const body = await post('/novel-panel/save', { chapter: opened.key, text: editing })
          if (!body.ok) throw new Error(body.error || t('common.saveFail'))
          setResult(body)
          if (body.state) {
            setOpened(body.state)
            setEditing(body.state.text)
          }
          if (body.scan) setList({ phase: 'ready', body: { ok: true, cwd: list.body && list.body.cwd, ...body.scan } })
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setBusy('')
        }
      }

      /** 设定库改完了：清掉「待更新设定」，这一章才算真正收尾。 */
      const settle = async () => {
        if (!opened || busy) return
        setBusy('settle')
        setError('')
        try {
          const body = await post('/novel-panel/settle', { chapter: opened.key })
          if (!body.ok) throw new Error(body.error || t('common.clearFail'))
          if (body.state) setOpened(body.state)
          if (body.scan) setList({ phase: 'ready', body: { ok: true, cwd: list.body && list.body.cwd, ...body.scan } })
          setResult({ changed: false, note: body.cleared ? t('settle.done') : t('settle.none') })
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setBusy('')
        }
      }

      const reconcileAgain = async () => {
        if (!opened || busy) return
        setBusy('check')
        setError('')
        try {
          const body = await post('/novel-panel/reconcile', { chapter: opened.key })
          if (!body.ok) throw new Error(body.error || t('common.compareFail'))
          setResult(body)
          if (body.state) setOpened(body.state)
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setBusy('')
        }
      }

      const lookBack = async () => {
        if (!opened || busy) return
        setBusy('back')
        setError('')
        try {
          const body = await post('/novel-panel/last-change', { chapter: opened.key })
          if (!body.ok) throw new Error(body.error || t('lookback.noPrev'))
          setResult(body)
          if (body.state) setOpened(body.state)
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setBusy('')
        }
      }

      const clampFont = (size) => Math.max(FONT_MIN, Math.min(FONT_MAX, size))

      /**
       * 高亮层与正文框对齐：滚动位置、可用宽度都跟正文框一致。
       * 正文框自己的字是正常颜色，高亮层只画底色（字透明），所以不会出现双层重影，
       * 也就不用把正在输入的字（含输入法候选）藏起来。
       */
      const syncBack = React.useCallback(() => {
        const ta = areaRef.current
        const outer = backRef.current
        const inner = backInnerRef.current
        if (!ta || !outer || !inner) return
        outer.style.width = `${ta.clientWidth}px`
        inner.style.transform = `translateY(${-ta.scrollTop}px)`
      }, [])

      /**
       * 把第 start 个字符滚到视线中间。
       * textarea 没有「滚到某个字符」的接口，按行号估算会被折行骗（一段 150 字就是三四行），
       * 所以用一个同样字体、同样宽度、同样内边距的隐藏 div 把前文排一遍，量出真实位置。
       * @param {HTMLTextAreaElement} ta 正文框
       * @param {string} content 全文
       * @param {number} start 命中处起始下标
       */
      const scrollToChar = (ta, content, start) => {
        const style = window.getComputedStyle(ta)
        const mirror = document.createElement('div')
        const copy = [
          'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
          'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
          'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
          'tabSize', 'wordBreak', 'overflowWrap', 'direction',
        ]
        for (const name of copy) mirror.style[name] = style[name]
        mirror.style.position = 'absolute'
        mirror.style.top = '0'
        mirror.style.left = '-10000px'
        mirror.style.width = `${ta.clientWidth}px`
        mirror.style.boxSizing = 'border-box'
        mirror.style.whiteSpace = 'pre-wrap'
        mirror.style.overflowWrap = 'break-word'
        mirror.style.height = 'auto'
        mirror.style.visibility = 'hidden'

        const mark = document.createElement('span')
        mark.textContent = content.slice(start, start + 1) || '一'
        mirror.textContent = content.slice(0, start)
        mirror.appendChild(mark)
        document.body.appendChild(mirror)

        const top = mark.getBoundingClientRect().top - mirror.getBoundingClientRect().top
        const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.95
        mirror.remove()

        // 让命中行落在中间偏上一点：往下找的时候还能顺手看到后文
        ta.scrollTop = Math.max(0, top - ta.clientHeight * 0.4 + lineHeight / 2)
      }

      const reveal = React.useCallback((index) => {
        const ta = areaRef.current
        const hit = matches[index]
        if (!ta || !hit) return
        // 正在查找框里打字时别抢焦点，否则打第二个字就断了
        if (document.activeElement !== findInputRef.current) ta.focus()
        ta.setSelectionRange(hit.start, hit.start)
        scrollToChar(ta, editing, hit.start)
        syncBack()
      }, [matches, editing, fontSize])

      const goFind = (direction) => {
        if (!matches.length) return
        setFind((prev) => ({ ...prev, index: (prev.index + direction + matches.length) % matches.length }))
      }

      const openFind = () => {
        const ta = areaRef.current
        const picked = ta && ta.selectionEnd > ta.selectionStart ? editing.slice(ta.selectionStart, ta.selectionEnd) : ''
        setFind((prev) => ({ open: true, query: picked || prev.query, index: 0 }))
      }

      const closeFind = () => {
        setFind((prev) => ({ ...prev, open: false }))
        if (areaRef.current) areaRef.current.focus()
      }

      React.useEffect(() => {
        try {
          window.localStorage.setItem(FONT_KEY, String(fontSize))
        } catch {
          /* 隐身模式 */
        }
      }, [fontSize])

      React.useEffect(() => {
        if (!find.open) return
        const input = findInputRef.current
        if (input) {
          input.focus()
          input.select()
        }
      }, [find.open])

      React.useEffect(() => {
        syncBack()
      }, [syncBack, editing, fontSize, find.open])

      React.useEffect(() => {
        if (!opened) return undefined
        const onResize = () => syncBack()
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [opened, syncBack])

      React.useEffect(() => {
        if (!find.open || !matches.length) return
        reveal(Math.min(find.index, matches.length - 1))
        // 只在「查找条开着」时跟随，编辑正文时不抢光标
      }, [find.open, find.index, find.query, matches.length])

      React.useEffect(() => {
        if (!opened) return undefined
        const inside = () => {
          const box = boxRef.current
          return Boolean(box && (box.contains(document.activeElement) || find.open))
        }
        const onKey = (event) => {
          const meta = event.metaKey || event.ctrlKey
          if (!meta) return
          const key = event.key.toLowerCase()
          if (key === 'f') {
            if (!inside()) return
            event.preventDefault()
            openFind()
          } else if (key === 'g') {
            if (!find.open) return
            event.preventDefault()
            goFind(event.shiftKey ? -1 : 1)
          } else if (key === 's') {
            if (!inside()) return
            event.preventDefault()
            void save()
          } else if (key === '=' || key === '+' || key === '-') {
            if (!inside()) return
            event.preventDefault()
            setFontSize((size) => clampFont(size + (key === '-' ? -1 : 1)))
          } else if (key === '0') {
            if (!inside()) return
            event.preventDefault()
            setFontSize(FONT_DEFAULT)
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      })

      /**
       * 列表页：整页滚动。
       * 章节页（fill）：不滚动外层，把剩下的高度全给正文框——查找到靠后的位置也在视线里。
       */
      const frame = (children, { fill = false } = {}) => h('div', {
        ref: fill ? boxRef : undefined,
        style: {
          height: '100%',
          minHeight: 480,
          boxSizing: 'border-box',
          display: fill ? 'flex' : 'block',
          flexDirection: fill ? 'column' : undefined,
          overflow: fill ? 'hidden' : 'auto',
          padding: fill ? '18px 24px 16px' : '24px 28px 40px',
          color: text,
          font: '13px/1.6 var(--dsw-alias-font-family, system-ui, sans-serif)',
        },
      }, h('div', {
        style: {
          maxWidth: 980,
          width: '100%',
          margin: '0 auto',
          ...(fill ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : {}),
        },
      }, ...children))


      const picker = pick.open
        ? h('div', {
            style: {
              position: 'fixed', inset: 0, zIndex: 80, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,0,0,.55)',
            },
            onClick: (event) => { if (event.target === event.currentTarget) setPick((prev) => ({ ...prev, open: false })) },
          }, h('div', {
            style: {
              width: 'min(640px, 92vw)', maxHeight: '78vh', display: 'flex', flexDirection: 'column',
              background: 'var(--dsw-alias-bg-elevated, #1b1d23)',
              border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
              borderRadius: 10, boxShadow: '0 18px 50px rgba(0,0,0,.5)', overflow: 'hidden',
            },
          },
            h('div', { style: { padding: '12px 14px', borderBottom: `1px solid ${line}`, display: 'flex', gap: 8, alignItems: 'center' } },
              h('div', { style: { fontSize: 14, fontWeight: 600 } }, t('picker.title')),
              button(t('btn.up'), () => pick.parent && goPick(pick.parent), { disabled: !pick.parent || pick.busy }),
              h('div', { style: { color: dim, marginLeft: 'auto', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 } }, pick.dir),
            ),
            h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '6px 0' } },
              pick.busy ? h('div', { style: { color: dim, padding: 16 } }, t('common.loading'))
                : pick.error ? h('div', { style: { color: '#c0504d', padding: 16 } }, pick.error)
                  : pick.entries.length === 0 ? h('div', { style: { color: dim, padding: 16 } }, t('picker.empty'))
                    : pick.entries.map((entry) => h('div', {
                        key: entry.path,
                        onClick: () => goPick(entry.path),
                        style: {
                          display: 'flex', width: '100%', gap: 8, alignItems: 'center',
                          padding: '6px 14px', color: text, cursor: 'pointer',
                        },
                      },
                        h('span', { style: { opacity: .6 } }, '📁'),
                        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.name),
                        entry.isProject ? h('span', { style: { color: '#5fbf9a', fontSize: 11 } }, t('picker.isProject'))
                          : entry.hasNovel ? h('span', { style: { color: '#7fb0ff', fontSize: 11 } }, t('picker.hasNovel')) : null,
                        h('button', {
                          type: 'button',
                          onClick: (event) => { event.stopPropagation(); usePicked(entry.path) },
                          style: {
                            padding: '3px 9px', borderRadius: 6, cursor: 'pointer', font: 'inherit', fontSize: 12,
                            color: text, background: 'transparent', border: `1px solid ${line}`,
                          },
                        }, t('picker.choose')),
                      )),
            ),
            h('div', { style: { padding: '10px 14px', borderTop: `1px solid ${line}`, display: 'flex', gap: 8, alignItems: 'center' } },
              h('div', { style: { color: dim, fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                pick.dir ? t('picker.willUse', { dir: pick.dir }) : ''),
              button(t('btn.cancel'), () => setPick((prev) => ({ ...prev, open: false }))),
              button(t('btn.choose'), () => {
                const chosen = pick.dir
                setPick((prev) => ({ ...prev, open: false }))
                if (chosen) { setDraft(chosen); submit(chosen) }
              }, { primary: true, disabled: !pick.dir }),
            ),
          ))
        : null

      if (opened) {
        const status = STATUS[opened.status] || STATUS.ok
        const statusLabel = t(status.key)
        const pending = opened.pending
        const words = countWords(editing)
        const tipLayer = tip
        ? h('div', {
            style: {
              position: 'fixed',
              left: Math.min(tip.x + 16, (window.innerWidth || 1200) - 300),
              top: tip.y + 18,
              maxWidth: 280,
              padding: '7px 10px',
              borderRadius: 7,
              background: 'rgba(16,18,24,.97)',
              border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
              color: 'var(--dsw-alias-text-primary, #e8e8e8)',
              fontSize: 12,
              lineHeight: 1.6,
              pointerEvents: 'none',
              zIndex: 60,
              boxShadow: '0 6px 20px rgba(0,0,0,.45)',
            },
          }, tip.text)
        : null

      return frame([
          picker,
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline' } },
            button(t('btn.back'), back, { disabled: busy === 'save' }),
            h('div', { style: { fontSize: 17, fontWeight: 600 } }, t('nav.chapterTitle', { n: opened.chapter, file: opened.key })),
            h('div', {
              style: { color: pending ? (pending.level >= 3 ? '#c0504d' : '#d08b2c') : status.color, marginLeft: 'auto' },
            }, pending ? t('row.pending', { n: pending.level }) : statusLabel),
            h('div', { style: { color: dim, fontVariantNumeric: 'tabular-nums' } },
              `${t('chapter.words', { n: words })}${dirty ? t('row.unsaved') : ''}`),
          ),
          (() => {
            const step = nextStep()
            if (!step) return null
            const tone = NEXT_TONE[step.tone] || NEXT_TONE.done
            return h('div', {
              style: {
                display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap',
                margin: '10px 0 4px', padding: '8px 12px', borderRadius: 8,
                background: tone.bg, border: `1px solid ${tone.border}`, color: tone.color,
              },
            },
              h('div', { style: { fontWeight: 600 } }, step.text),
              h('div', { style: { opacity: 0.9 } }, `· ${step.action}`))
          })(),
          h('div', { style: { color: dim, margin: '6px 0 10px', fontSize: 12 } },
            opened.baseline
              ? `${t('chapter.archiveMeta', { version: opened.baseline.version, words: opened.baseline.words, at: opened.baseline.archivedAt || '—' })}${opened.previous ? t('chapter.prevAlive', { n: opened.previous.version }) : ''}`
              : t('chapter.noArchiveHint')),
          h('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
            button(busy === 'save' ? t('btn.saving') : t('btn.save'), save, { primary: !pending || dirty, disabled: Boolean(busy) }),
            button(busy === 'check' ? t('btn.checking') : t('btn.reconcile'), reconcileAgain, { disabled: Boolean(busy) }),
            button(busy === 'back' ? t('common.loading') : `看上次改了什么${opened.previous ? `（v${opened.previous.version}）` : ''}`, lookBack, {
              disabled: Boolean(busy) || !opened.previous,
              title: opened.previous
                ? t('lookback.hint')
                : t('lookback.none'),
            }),
            button(busy === 'settle' ? t('btn.settling') : t('btn.settled'), settle, {
              primary: Boolean(pending) && !dirty,
              disabled: Boolean(busy) || !pending,
              title: pending ? t('settle.hint') : t('settle.disabled'),
            }),
          ),
          error ? h('div', { style: { color: '#c0504d', marginBottom: 8 } }, error) : null,
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } },
            h('div', { style: { color: dim, fontSize: 12 } }, t('font.label')),
            button('A−', () => setFontSize((size) => clampFont(size - 1)), { title: '⌘−' }),
            h('div', {
              style: { color: dim, fontSize: 12, minWidth: 22, textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
            }, String(fontSize)),
            button('A+', () => setFontSize((size) => clampFont(size + 1)), { title: '⌘+' }),
            h('div', { style: { width: 10 } }),
            button(find.open ? t('find.close') : t('find.open'), () => (find.open ? closeFind() : openFind())),
            h('div', { style: { color: dim, fontSize: 12, marginLeft: 'auto' } }, t('editor.styleHint')),
          ),
          find.open
            ? h('div', {
              style: {
                display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8,
                padding: '6px 10px', background: bg, border: `1px solid ${line}`, borderRadius: 6,
              },
            },
            h('input', {
              ref: findInputRef,
              value: find.query,
              spellCheck: false,
              placeholder: t('find.placeholder'),
              onChange: (event) => setFind({ open: true, query: event.target.value, index: 0 }),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  goFind(event.shiftKey ? -1 : 1)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  closeFind()
                }
              },
              style: {
                flex: 1,
                minWidth: 0,
                padding: '5px 8px',
                color: text,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                font: `13px/1.6 ${SANS}`,
              },
            }),
            h('div', {
              style: {
                color: matches.length ? dim : '#c0504d',
                fontSize: 12,
                fontVariantNumeric: 'tabular-nums',
                minWidth: 44,
                textAlign: 'right',
              },
            }, find.query ? (matches.length ? `${Math.min(find.index + 1, matches.length)}/${matches.length}` : t('common.none')) : ''),
            button('↑', () => goFind(-1), { disabled: !matches.length }),
            button('↓', () => goFind(1), { disabled: !matches.length }),
            h('div', { style: { color: dim, fontSize: 12 } }, t('find.keys')),
          )
            : null,
          h('div', {
            style: {
              position: 'relative',
              flex: '1 1 0',
              minHeight: 220,
              background: bg,
              border: `1px solid ${line}`,
              borderRadius: 8,
              overflow: 'hidden',
            },
          },
          h('div', {
            ref: backRef,
            'aria-hidden': true,
            style: {
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              overflow: 'hidden',
              pointerEvents: 'none',
              color: 'transparent',
            },
          },
          h('div', {
            ref: backInnerRef,
            style: {
              boxSizing: 'border-box',
              width: '100%',
              padding: '18px 20px',
              font: `${fontSize}px/1.95 ${SANS}`,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'break-word',
              tabSize: 2,
              willChange: 'transform',
            },
          },
          ...segments.map((segment, index) => (segment.hit
            ? h('mark', {
              key: index,
              style: {
                color: 'transparent',
                background: segment.current ? 'rgba(90,140,220,.45)' : 'rgba(90,140,220,.16)',
                borderRadius: 2,
              },
            }, segment.text)
            : h('span', { key: index }, segment.text))),
          '\n')),
          h('textarea', {
            ref: areaRef,
            value: editing,
            spellCheck: false,
            onChange: (event) => setEditing(event.target.value),
            onScroll: syncBack,
            style: {
              position: 'absolute',
              inset: 0,
              boxSizing: 'border-box',
              width: '100%',
              height: '100%',
              padding: '18px 20px',
              border: 'none',
              outline: 'none',
              resize: 'none',
              background: 'transparent',
              color: text,
              font: `${fontSize}px/1.95 ${SANS}`,
              tabSize: 2,
            },
          })),
          (result && result.note) || result
            ? h('div', {
              style: { flex: '0 1 auto', maxHeight: '40%', overflow: 'auto', marginTop: 10, minHeight: 0 },
            },
            result && result.note
              ? h('div', { style: { color: dim } }, result.note)
              : h(Result, { result }))
            : null,
        ], { fill: true })
      }

      /** 图谱页：一页一张图，各自占满宽度，各自有重画按钮。 */
      /** 场景页：HTML 版。一章一行、五章一组折叠，40 章也能一屏看到骨架。 */
      const scenesView = () => {
        const GROUP = 5
        const data = sceneData.phase === 'ready' ? sceneData.body : null
        const all = data ? data.chapters : []
        const volumes = (data && data.volumes) || []
        const tone = { turn: '#c0504d', plant: '#d08b2c', pay: '#3f9e7a' }

        // 检索：命中摘要、场景事件、人物、标记，也可以直接输入章号
        const query = sceneQuery.trim()
        const needle = query.toLowerCase()
        const vol = sceneVol ? volumes.find((v) => v.vol === sceneVol) : null
        const hitRow = (row) => {
          if (!needle) return true
          const hay = [row.summary, row.when, row.changes, row.marks,
            ...row.scenes.map((scene) => `${scene.event} ${scene.who} ${scene.tag}`)].join(' ').toLowerCase()
          return hay.includes(needle) || String(row.n) === needle || t('scenes.searchChapter', { n: row.n }) === needle
        }
        const chapters = all.filter((row) => (!vol || (row.n >= vol.from && row.n <= vol.to)) && hitRow(row))

        // 把命中的词标出来；只有一处也标（多处的其余部分照样能看见）
        const hi = (text) => {
          const value = String(text || '')
          if (!needle) return value
          const at = value.toLowerCase().indexOf(needle)
          if (at < 0) return value
          return [value.slice(0, at),
            h('mark', {
              key: 'hit',
              style: { background: 'rgba(208,139,44,.28)', color: 'inherit', borderRadius: 3, padding: '0 2px' },
            }, value.slice(at, at + query.length)),
            value.slice(at + query.length)]
        }
        const chip = (label, color, key) => h('span', {
          key,
          style: {
            display: 'inline-block',
            padding: '1px 7px',
            marginRight: 6,
            borderRadius: 999,
            fontSize: 11,
            color,
            border: `1px solid ${color}55`,
            background: `${color}14`,
          },
        }, label)

        // 点阵：一眼看出「哪一段转折密、哪一段在埋不收」。
        // 超过 8 个就画 8 个点 + 「+n」，避免 40 章时一排几十个点变成噪点。
        const DOT_MAX = 8
        const dots = (count, color, key, label) => {
          if (!count) return null
          const shown = Math.min(count, DOT_MAX)
          const showTip = (event) => setTip({ text: `${label} ${count}`, x: event.clientX, y: event.clientY })
          return h('span', {
            key,
            // 原生 title 在这个容器里不弹（和之前 SVG 的 <title> 同一个坑），改用面板自己的浮层
            onMouseEnter: showTip,
            onMouseMove: showTip,
            onMouseLeave: () => setTip(null),
            style: { display: 'inline-flex', alignItems: 'center', gap: 3, marginRight: 10 },
          },
            h('span', { style: { display: 'inline-flex', gap: 2 } },
              ...Array.from({ length: shown }, (_, i) => h('span', {
                key: i,
                style: {
                  width: 7, height: 7, borderRadius: 2, background: color,
                  opacity: 0.9, boxShadow: `0 0 0 1px ${color}33`,
                },
              }))),
            count > DOT_MAX
              ? h('span', { style: { color, fontSize: 10, marginLeft: 1 } }, `+${count - DOT_MAX}`)
              : null)
        }

        const toggleIn = (list, setList, value) => setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value])
        const showGroups = !needle // 检索结果是零散命中，不再套「第 2–15 章」这种会骗人的区间标题
        const groups = []
        for (let i = 0; i < chapters.length; i += showGroups ? GROUP : chapters.length) {
          groups.push({ index: groups.length, rows: chapters.slice(i, i + (showGroups ? GROUP : chapters.length)) })
        }
        // 默认展开最后一组：正在写的通常在后面
        const expanded = needle
          ? groups.map((group) => group.index)
          : openGroups === null
            ? (groups.length ? [groups[groups.length - 1].index] : [])
            : openGroups

        const chapterRow = (row) => {
          const isOpen = needle ? true : openChapters.includes(row.n)
          return h('div', { key: row.n, style: { borderTop: `1px solid ${line}` } },
            h('div', {
              onClick: () => toggleIn(openChapters, setOpenChapters, row.n),
              style: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px', cursor: 'pointer' },
            },
              h('div', { style: { minWidth: 58, color: dim, fontSize: 12, paddingTop: 1 } }, t('nav.chapterNo', { n: row.n })),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { lineHeight: 1.6 } }, row.summary ? hi(row.summary) : t('chapter.noDigest')),
                h('div', { style: { marginTop: 4 } },
                  row.marksAgg.turn ? chip(t('scenes.turn', { n: row.marksAgg.turn }), tone.turn, 't') : null,
                  row.marksAgg.plant ? chip(t('scenes.plant', { n: row.marksAgg.plant }), tone.plant, 'p') : null,
                  row.marksAgg.pay ? chip(t('scenes.pay', { n: row.marksAgg.pay }), tone.pay, 'y') : null,
                  h('span', { style: { color: dim, fontSize: 11 } }, t('scenes.count', { n: row.scenes.length })),
                ),
              ),
              h('div', { style: { color: dim, fontSize: 12, paddingTop: 1 } }, isOpen ? '▾' : '▸'),
            ),
            isOpen && row.scenes.length
              ? h('div', { style: { padding: '2px 12px 10px 70px' } },
                  ...row.scenes.map((scene) => h('div', {
                    key: scene.no,
                    style: { display: 'flex', gap: 8, padding: '3px 0', borderTop: `1px dashed ${line}33` },
                  },
                    h('div', { style: { color: dim, fontSize: 11, minWidth: 18 } }, `${scene.no}`),
                    h('div', { style: { flex: 1, minWidth: 0 } },
                      h('div', { style: { lineHeight: 1.55 } }, hi(scene.event)),
                      h('div', { style: { color: dim, fontSize: 11, marginTop: 2 } },
                        scene.who,
                        scene.tag
                          ? h('span', {},
                              ' · ',
                              ...(() => {
                              let sceneTone = dim
                              return scene.tag.split('、').map((part, i) => {
                                const name = part.trim()
                                if (!name) return null
                                // 「埋 F001、F002、F004」只有第一段带动词，后面是编号：
                                // 记住上一个标记的类型，后面的编号沿用同一个颜色
                                if (/转折/.test(name)) sceneTone = tone.turn
                                else if (/^埋/.test(name)) sceneTone = tone.plant
                                else if (/^收/.test(name)) sceneTone = tone.pay
                                else if (!sceneTone) sceneTone = dim
                                return h('span', { key: i, style: { color: sceneTone, marginRight: 6 } }, sceneTagText(name))
                              })
                              })())
                          : null),
                    ),
                  )))
              : null,
          )
        }

        return h('div', {},
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 } },
            button(t('common.reload'), () => loadScenes(project)),
            h('div', { style: { color: dim, fontSize: 12 } },
              data ? t('scenes.total', { chapters: data.total, scenes: data.scenes }) : ''),
            h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', marginLeft: 4, fontSize: 11, color: dim } },
              h('span', {}, h('span', { style: { display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: tone.turn, marginRight: 4 } }), t('mark.turn')),
              h('span', {}, h('span', { style: { display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: tone.plant, marginRight: 4 } }), t('mark.plant')),
              h('span', {}, h('span', { style: { display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: tone.pay, marginRight: 4 } }), t('mark.pay'))),
            h('div', { style: { color: dim, fontSize: 11 } }, t('scenes.hintLine')),
          ),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' } },
            volumes.length > 1
              ? h('div', { style: { display: 'flex', gap: 6, marginRight: 6 } },
                  h('div', {
                    onClick: () => setSceneVol(0),
                    style: {
                      padding: '3px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                      color: sceneVol === 0 ? text : dim,
                      border: `1px solid ${sceneVol === 0 ? line : 'transparent'}`,
                    },
                  }, t('nav.volAll')),
                  ...volumes.map((v) => h('div', {
                    key: v.vol,
                    onClick: () => setSceneVol(v.vol),
                    style: {
                      padding: '3px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                      color: sceneVol === v.vol ? text : dim,
                      border: `1px solid ${sceneVol === v.vol ? line : 'transparent'}`,
                    },
                  }, `${t('nav.volume', { label: v.label })}${v.title ? ` ${v.title}` : ''}`)))
              : null,
            h('input', {
              value: sceneQuery,
              onChange: (event) => setSceneQuery(event.target.value),
              placeholder: t('search.ph'),
              style: {
                flex: '0 1 320px', minWidth: 200, padding: '5px 9px', borderRadius: 6,
                border: `1px solid ${line}`, background: 'rgba(128,128,128,.08)',
                color: text, fontSize: 12, outline: 'none',
              },
            }),
            needle
              ? h('div', { style: { color: dim, fontSize: 12 } },
                  chapters.length ? t('search.hits', { n: chapters.length }) : t('search.none'))
              : null),
          data && needle && !chapters.length
            ? h('div', { style: { color: dim, padding: '16px 0' } }, t('search.none.q', { q: query }))
            : null,
          sceneData.phase === 'failed'
            ? h('div', { style: { color: '#c0504d' } }, t('scenes.readFail', { err: sceneData.error }))
            : null,
          sceneData.phase === 'loading' ? h('div', { style: { color: dim } }, t('common.loading')) : null,
          data && !chapters.length
            ? h('div', { style: { color: dim, padding: '16px 0' } }, t('scenes.empty'))
            : null,
          data && chapters.length
            ? h('div', { style: { border: `1px solid ${line}`, borderRadius: 8, overflow: 'hidden' } },
                ...groups.map((group) => {
                  const isOpen = expanded.includes(group.index)
                  const agg = group.rows.reduce((acc, row) => ({
                    turn: acc.turn + row.marksAgg.turn,
                    plant: acc.plant + row.marksAgg.plant,
                    pay: acc.pay + row.marksAgg.pay,
                    scenes: acc.scenes + row.scenes.length,
                  }), { turn: 0, plant: 0, pay: 0, scenes: 0 })
                  const first = group.rows[0].n
                  const last = group.rows[group.rows.length - 1].n
                  return h('div', { key: group.index },
                    showGroups ? h('div', {
                      onClick: () => toggleIn(expanded, setOpenGroups, group.index),
                      style: {
                        display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px',
                        cursor: 'pointer', background: 'rgba(128,128,128,.06)',
                        borderTop: group.index ? `1px solid ${line}` : 'none',
                      },
                    },
                      h('div', { style: { minWidth: 96, fontSize: 13 } }, first === last ? t('chapter.rangeOne', { n: first }) : t('chapter.rangeMany', { first, last })),
                      h('div', { style: { flex: 1, minWidth: 0, color: dim, fontSize: 12 } },
                        t('chapter.groupMeta', { chapters: group.rows.length, scenes: agg.scenes })),
                      dots(agg.turn, tone.turn, 'dot-turn', t('mark.turn')),
                      dots(agg.plant, tone.plant, 'dot-plant', t('mark.plant')),
                      dots(agg.pay, tone.pay, 'dot-pay', t('mark.pay')),
                      h('div', { style: { color: dim, fontSize: 12 } }, isOpen ? '▾' : '▸'),
                    ) : null,
                    ...(isOpen ? group.rows.map(chapterRow) : []),
                  )
                }))
            : null,
        )
      }

      const graphView = (kind) => {
        const status = graph.phase === 'ready' ? graph.body : null
        const isPlot = kind === 'plot'
        const isScenes = kind === 'scenes'
        const trouble = []
        if (status && !status.hasTables) trouble.push(t('graph.noTable'))
        if (status && isPlot && status.missingStrength && status.missingStrength.length) {
          trouble.push(`第 ${status.missingStrength.join('、')} 章已经写了，但强度表还是「—」：回对话里让 agent 补实测值`)
        }
        if (status && status.staleSvg) trouble.push(t('stale'))
        return h('div', {},
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 } },
            button(graphBusy ? t('btn.redrawing') : t('btn.redraw'), redrawGraph, { disabled: graphBusy, primary: Boolean(status && (status.staleSvg || !status.hasSvg)) }),
            isPlot ? h('div', { style: { color: dim, fontSize: 12 } }, t('graph.redrawHint')) : null,
            isPlot && status && status.plotVolumes && status.plotVolumes.length > 1
              ? h('div', { style: { display: 'flex', gap: 6, marginLeft: 4 } },
                  status.plotVolumes.map((v) => h('div', {
                    key: v.vol,
                    onClick: () => setPlotVol(v.vol),
                    style: {
                      padding: '3px 10px',
                      borderRadius: 999,
                      fontSize: 12,
                      cursor: 'pointer',
                      color: (plotVol || status.plotVolumes[status.plotVolumes.length - 1].vol) === v.vol ? text : dim,
                      border: `1px solid ${(plotVol || status.plotVolumes[status.plotVolumes.length - 1].vol) === v.vol ? line : 'transparent'}`,
                    },
                  }, v.label)))
              : null,
            !isScenes ? h('div', { style: { color: dim, fontSize: 12 } }, t('zoom', { n: Math.round(view.scale * 100) })) : null,
            !isScenes ? button(t('btn.fit'), () => {
              const box = graphBox.current
              if (!box || !nat.w) return
              setView({ scale: Math.min(1, Math.max(0.15, Number((box.clientWidth / nat.w).toFixed(3)))) })
              window.requestAnimationFrame(() => { box.scrollLeft = 0; box.scrollTop = 0 })
            }) : null,
            !isScenes ? button(t('btn.reset'), () => {
              setView({ scale: 1 })
              const box = graphBox.current
              window.requestAnimationFrame(() => { if (box) { box.scrollLeft = 0; box.scrollTop = 0 } })
            }) : null,
            status
              ? h('div', { style: { color: dim } },
                  isScenes
                    ? t('graph.meta.scenes', { scenes: status.scenes, chapters: status.chapters })
                    : isPlot
                      ? t('graph.meta.plot', { chapters: status.chapters, lines: status.lines })
                      : t('graph.meta.people', { people: status.people, edges: status.edges }))
              : null,
          ),
          graph.phase === 'failed'
            ? h('div', { style: { color: '#c0504d' } }, t('graph.readFail', { err: graph.error }))
            : null,
          trouble.length
            ? h('div', { style: { color: '#d08b2c', margin: '0 0 12px', lineHeight: 1.7 } },
                ...trouble.map((line, index) => h('div', { key: index }, `· ${line}`)))
            : status
              ? h('div', { style: { color: 'var(--dsw-alias-text-secondary, #8a8f94)', margin: '0 0 12px' } }, t('graph.inSync'))
              : null,
          kind === 'relationship'
            ? h('div', {
                // 常驻一行、固定高度：钉住与未钉住之间切换时图谱不能上下跳
                style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '0 0 10px', minHeight: 26, fontSize: 12, color: text },
              },
                pinned ? h('span', null, t('pinned.bar', { name: pinned })) : h('span', { style: { color: dim } }, t('pinned.hint')),
                ...(() => {
                  if (!pinned) return []
                  const c = status && status.characters ? status.characters.find((x) => x.name === pinned) : null
                  // 只有那一章真的写了才给跳转链接；设定里写了「首次出场第 3 章」但正文没到，
                  // 点了没反应会让人以为坏了，所以显式说明。
                  const written = c && c.first && body && body.ok
                    ? body.chapters.some((row) => row.chapter === c.first)
                    : false
                  if (c && c.first && !written) {
                    return [h('span', { key: 'nowrite', style: { color: dim, fontSize: 12 } }, t('pinned.nowrite', { n: c.first }))]
                  }
                  return c && c.first
                    ? [h('button', {
                        key: 'jump',
                        type: 'button',
                        onClick: () => jumpToChapter(c.first),
                        style: { font: 'inherit', fontSize: 12, padding: '3px 10px', color: text, background: 'transparent', border: `1px solid ${line}`, borderRadius: 999, cursor: 'pointer' },
                      }, t('pinned.jump', { n: c.first }) + ' →')]
                    : []
                })(),
                pinned ? h('button', {
                  key: 'off',
                  type: 'button',
                  onClick: () => setPinned(''),
                  style: { font: 'inherit', fontSize: 12, padding: '3px 10px', color: dim, background: 'transparent', border: 'none', cursor: 'pointer' },
                }, t('pinned.clear')) : null,
              )
            : null,
          status && status.hasSvg
            ? h('div', {
                // 画框贴着画布走：图比面板窄时不留一圈灰边，图更宽时才铺满并允许滚动
                style: {
                  display: isScenes ? 'block' : 'inline-block',
                  verticalAlign: 'top',
                  maxWidth: '100%',
                  border: `1px solid ${line}`,
                  borderRadius: 8,
                  padding: 8,
                  background: 'rgba(18,20,26,.6)',
                },
              },
                h('div', { style: { color: dim, fontSize: 12, marginBottom: 6 } }, t('graph.' + kind) || GRAPH_TITLE[kind]),
                svgText.kind === kind && svgText.text
                  ? h('div', {
                      ref: graphBox,
                      style: {
                        position: 'relative',
                        width: '100%',
                        maxHeight: '72vh',
                        overflow: 'auto',
                        overscrollBehavior: 'contain',
                        touchAction: 'none',
                        borderRadius: 6,
                        cursor: dragRef.current ? 'grabbing' : 'default',
                      },
                      onPointerDown: onGraphPointerDown,
                      onPointerMove: (event) => {
                        onGraphPointerMove(event)
                        // 提示不再靠「鼠标压到哪条线」，改由下面那个按距离找最近线的 effect 负责
                      },
                      onPointerUp: (event) => {
                        const d = dragRef.current
                        endDrag()
                        if (d && d.moved) return
                        // 情节图：点圆点或章号 → 展开这一章的分数依据（只读）
                        const hitChapter = event.target && event.target.closest ? event.target.closest('[data-chapter]') : null
                        if (hitChapter && svgText.kind === 'plot') {
                          const n = Number(hitChapter.getAttribute('data-chapter'))
                          if (Number.isFinite(n)) void openTrace(n)
                          return
                        }
                        const node = event.target && event.target.closest ? event.target.closest('[data-node]') : null
                        if (!node) return
                        // 单击＝把人钉住（鼠标移开后高亮不散，方便顺着连线读关系）；双击取消
                        setPinned(node.getAttribute('data-node') || '')
                      },
                      onPointerLeave: () => { endDrag(); setHovered(''); setTip(null) },
                      onDoubleClick: () => {
                        if (pinned) { setPinned(''); return }
                        if (!isScenes) setView({ scale: 1 })
                      },
                    },
                    isScenes
                      ? h('div', {
                          ref: graphInner,
                          dangerouslySetInnerHTML: {
                            __html: svgText.text.replace('<svg ', '<svg style="width:100%;height:auto;display:block" '),
                          },
                        })
                      : h('div', { ref: graphInner, style: { width: nat.w * view.scale, height: nat.h * view.scale } },
                        h('div', {
                          style: { width: nat.w, height: nat.h, transform: `scale(${view.scale})`, transformOrigin: '0 0' },
                          dangerouslySetInnerHTML: {
                            __html: svgText.text.replace('<svg ', `<svg style="width:${nat.w}px;height:${nat.h}px;display:block" `),
                          },
                        })))
                  : svgText.kind === kind && svgText.error
                    ? h('div', { style: { color: '#c0504d', padding: '12px 0' } }, t('graph.readSvgFail', { err: svgText.error }))
                    : h('div', { style: { color: dim, padding: '12px 0' } }, t('common.loading')))
            : null,
          isPlot && status && status.chapters
            ? h('div', { style: { marginTop: 14 } },
                h('div', { style: { color: dim, fontSize: 12, marginBottom: 8 } },
                  t('trace.hint')),
                h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  ...Array.from({ length: status.chapters }, (_, i) => i + 1).map((n) => h('button', {
                    key: n,
                    type: 'button',
                    onClick: () => void openTrace(n),
                    style: {
                      padding: '4px 10px',
                      color: trace.chapter === n ? text : dim,
                      background: trace.chapter === n ? bg : 'transparent',
                      border: `1px solid ${trace.chapter === n ? line : 'transparent'}`,
                      borderRadius: 999,
                      cursor: 'pointer',
                      font: 'inherit',
                      fontSize: 12,
                    },
                  }, t('trace.chapterNo', { n })))),
                trace.phase === 'loading'
                  ? h('div', { style: { color: dim, marginTop: 8, fontSize: 12 } }, t('common.loading'))
                  : trace.phase === 'failed'
                    ? h('div', { style: { color: '#c0504d', marginTop: 8, fontSize: 12 } }, t('trace.readFail', { err: trace.error }))
                    : trace.phase === 'ready' && trace.body
                      ? h('div', { style: { marginTop: 10, border: `1px solid ${line}`, borderRadius: 8, padding: 10, background: 'rgba(18,20,26,.6)' } },
                          h('div', { style: { color: dim, fontSize: 12, marginBottom: 6 } },
                            t('trace.title', { n: trace.body.chapter })),
                          h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 } },
                            ...(trace.body.scores || []).map((row, index) => h('div', {
                              key: index,
                              style: { fontSize: 12, color: text },
                            }, `${row.line} ${row.value}`))),
                          trace.body.digest
                            ? h('div', { style: { fontSize: 12, lineHeight: 1.7, color: text } },
                                t('trace.digest', { text: (trace.body.digest[2] || '').slice(0, 120) }))
                            : h('div', { style: { fontSize: 12, color: dim } }, t('trace.noDigest')),
                          trace.body.brief
                            ? h('div', { style: { marginTop: 8, fontSize: 12, lineHeight: 1.8, color: dim } },
                                t('trace.brief', { file: trace.body.brief.file }),
                                ...(trace.body.brief.sections || [])
                                  .filter((sec) => (sec.lines || []).length)
                                  .map((sec, index) => h('div', { key: index },
                                    `${sec.heading}：${(sec.lines || []).join('；').slice(0, 110)}`)))
                            : h('div', { style: { marginTop: 8, fontSize: 12, color: dim } }, t('trace.noBrief')))
                      : null)
            : null,
          graph.log
            ? h('pre', {
                style: { marginTop: 12, maxHeight: 160, overflow: 'auto', color: dim, fontSize: 12, whiteSpace: 'pre-wrap', background: bg, padding: 10, borderRadius: 6 },
              }, graph.log)
            : null,
          h('div', { style: { color: dim, marginTop: 14, fontSize: 12, lineHeight: 1.7 } },
            isScenes
              ? t('graph.caption.scenes')
              : isPlot
                ? t('graph.caption.plot')
                : '图由 bible/relationship-map.md 的「人物档位」与「文字版关系表」画出：圈越大越重要，实线亲情、虚线爱情、带叉敌对、细实线利益；把鼠标停在关系标签上看张力说明。'),
          h('div', { style: { color: dim, marginTop: 6, fontSize: 12 } },
            t('graph.caption.footer')),
        )
      }

      const body = list.body
      const summary = body && body.ok
        ? [
            body.pending ? `待更新设定 ${body.pending}` : '',
            body.drift ? t('summary.drift', { n: body.drift }) : '',
            body.missing ? t('summary.missing', { n: body.missing }) : '',
            t('summary.consistent', { n: body.chapters.length - body.drift - body.missing }),
          ].filter(Boolean).join(' · ')
        : ''

      // 章节页的检索：只搜摘要/文件名/故事时间/章号，不读正文
      const chapterNeedle = chapterQuery.trim().toLowerCase()
      const chapterList = body && body.ok
        ? body.chapters.filter((row) => !chapterNeedle
            || [row.summary, row.key, row.when, `第${row.chapter}章`].join(' ').toLowerCase().includes(chapterNeedle))
        : []

      const tipLayer = tip
        ? h('div', {
            style: {
              position: 'fixed',
              left: Math.min(tip.x + 16, (window.innerWidth || 1200) - 300),
              top: tip.y + 18,
              maxWidth: 280,
              padding: '7px 10px',
              borderRadius: 7,
              background: 'rgba(16,18,24,.97)',
              border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
              color: 'var(--dsw-alias-text-primary, #e8e8e8)',
              fontSize: 12,
              lineHeight: 1.6,
              pointerEvents: 'none',
              zIndex: 60,
              boxShadow: '0 6px 20px rgba(0,0,0,.45)',
            },
          }, tip.text)
        : null

      return frame([
        picker,
        h('div', { style: { fontSize: 17, fontWeight: 600 } }, t('panel.name')),
        h('div', { style: { color: dim, margin: '4px 0 12px' } },
          t('intro')),

        h('div', { style: { display: 'flex', gap: 6, marginBottom: 12 } },
          ...[['chapters', t('tab.chapters')], ['relationship', t('tab.relationship')], ['plot', t('tab.plot')], ['scenes', t('tab.scenes')]].map(([id, label]) => h('button', {
            key: id,
            type: 'button',
            onClick: () => setTab(id),
            style: {
              padding: '5px 12px',
              color: tab === id ? text : dim,
              background: tab === id ? bg : 'transparent',
              border: `1px solid ${tab === id ? line : 'transparent'}`,
              borderRadius: 999,
              cursor: 'pointer',
              font: 'inherit',
            },
          }, label)),
        ),

        tab === 'chapters'
          ? h('div', { style: { color: dim, margin: '0 0 10px' } },
              t('hint.flow'))
          : null,
        tab === 'chapters'
          ? h('div', { style: { color: dim, margin: '0 0 18px', fontSize: 12 } },
              t('level.hint'))
          : null,

        h('div', { style: { color: dim, fontSize: 12, margin: '0 0 6px' } },
          t('hint.dir')),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('input', {
            value: draft,
            spellCheck: false,
            placeholder: t('ph.dir'),
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') submit(draft) },
            style: {
              flex: 1,
              minWidth: 0,
              padding: '7px 10px',
              color: text,
              background: bg,
              border: `1px solid ${line}`,
              borderRadius: 6,
              font: 'inherit',
            },
          }),
          button(t('btn.browse'), openPick),
          button(t('btn.refresh'), () => submit(draft)),
        ),

        h('div', { style: { color: dim, margin: '10px 0 16px', minHeight: 20 } },
          list.phase === 'loading' ? t('common.loading')
            : list.phase === 'failed' ? `读不到：${list.error}`
              : body && body.ok ? summary
                : body ? t('summary.readFail', { err: body.error }) : ''),

        tab === 'relationship' ? graphView('relationship') : null,
        tab === 'plot' ? graphView('plot') : null,
        tab === 'scenes' ? scenesView() : null,

        tab === 'chapters' && body && body.ok && body.chapters.length === 0
          ? h('div', { style: { color: dim, padding: '16px 0', lineHeight: 1.7 } },
              t('empty.chapters'),
              h('div', { style: { fontSize: 12, opacity: .8 } }, t('empty.chaptersHint')))
          : null,

        tab === 'chapters' && body && body.ok && body.chapters.length > 0
          ? h('div', {},
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 } },
                h('input', {
                  value: chapterQuery,
                  onChange: (event) => setChapterQuery(event.target.value),
                  placeholder: t('search.ph'),
                  style: {
                    flex: '0 1 340px', minWidth: 200, padding: '5px 9px', borderRadius: 6,
                    border: `1px solid ${line}`, background: 'rgba(128,128,128,.08)',
                    color: text, fontSize: 12, outline: 'none',
                  },
                }),
                chapterNeedle
                  ? h('div', { style: { color: dim, fontSize: 12 } },
                      chapterList.length ? t('search.hits', { n: chapterList.length }) : t('search.none'))
                  : h('div', { style: { color: dim, fontSize: 12 } }, t('search.hint')),
              ),
              chapterNeedle && !chapterList.length
                ? h('div', { style: { color: dim, padding: '12px 0' } }, t('search.none', { q: chapterQuery.trim() }))
                : null,
              chapterList.length
                ? h('div', { style: { border: `1px solid ${line}`, borderRadius: 8, overflow: 'hidden' } },
              h('div', {
                style: {
                  display: 'grid',
                  gridTemplateColumns: '64px 1fr 96px 72px',
                  gap: 12,
                  padding: '8px 10px',
                  color: dim,
                  fontSize: 12,
                },
              },
                h('span', {}, '章'),
                h('span', {}, t('row.file')),
                h('span', {}, t('row.status')),
                h('span', { style: { textAlign: 'right' } }, t('row.archive')),
              ),
              ...chapterList.map((row) => h(Row, { key: row.key, row, onOpen: openChapter, query: chapterQuery })),
                )
                : null,
            )
          : null,

        tab === 'chapters' && error ? h('div', { style: { color: '#c0504d', marginTop: 12 } }, error) : null,
        tipLayer,

        body && body.ok && body.unregisteredOnDisk.length
          ? h('div', { style: { color: '#c0504d', marginTop: 12 } },
              `索引里有 ${body.unregisteredOnDisk.length} 章在磁盘上找不到：${body.unregisteredOnDisk.join('、')}`)
          : null,

        body && body.ok
          ? h('div', { style: { color: dim, marginTop: 16, fontSize: 12 } },
              t('host.paths', { cwd: body.cwd, dir: body.projectDir }))
          : null,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots
        if (!slots) return

        // 语言：注册中英字典并绑定翻译。两种时机都试：
        // ① 现在就取得到 locale 服务；② 现在还取不到（插件激活早于语言服务）—用 ctx.inject 等服务就绪。
        // 注意：绝不能直接读 ctx.locale，cordis 对未注入的服务属性会抛错，apply 一抛整条 entry 就激活失败。
        const attachLocale = (locale) => {
          if (!locale || typeof locale.register !== 'function') return
          try {
            locale.register(LOCALE_NS, { zh: ZH, en: EN })
            if (typeof locale.bind === 'function') boundT = locale.bind(LOCALE_NS)
          } catch (err) {
            console.warn('[novel-assistant] locale registration failed, falling back to Chinese', err)
          }
        }
        attachLocale(getLocale(ctx))
        let injectService = null
        try {
          injectService = ctx.inject
        } catch (err) {
          /* 严格 ctx 下读属性就会抛 —— 那就只走上面那条路 */
        }
        if (!boundT && typeof injectService === 'function') {
          try {
            injectService.call(ctx, ['locale'], (inner) => {
              let locale = getLocale(inner)
              if (!locale) {
                try { locale = inner.locale } catch (err) { locale = null }
              }
              attachLocale(locale)
            })
          } catch (err) {
            /* 老宿主没有 inject —— 就一直是中文 */
          }
        }

        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: ORDER,
          label: () => t('panel.name'),
        }, PanelIcon))

        slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
        }, Panel))
      },
    }
  },
})
