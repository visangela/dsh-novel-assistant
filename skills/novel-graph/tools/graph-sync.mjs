#!/usr/bin/env node
/**
 * 图谱数据同步：把设定库里已经写下的事实，补进两张图谱 Markdown 的表里。
 *
 *   node graph-sync.mjs [--project novel-project] [--init] [--check] [--json]
 *
 * 读：bible/characters/_index.md（姓名 / 身份 / 阵营 / 与主角关系 / 首次出场 / 状态 / 小传路径）
 *     bible/characters/*.md 的「## 关系网」表（对象 / 关系 / 张力来源 / 当前状态）
 *     bible/outline.md（主线一句话、分卷表、章节关键设定）
 *     bible/foreshadowing.md（伏笔编号 / 埋设章 / 回收章 / 状态）
 *     bible/digest.md 或 chapters/（已写到第几章）
 *
 * 写：补进 bible/relationship-map.md 的「人物档位」与「文字版关系表」；
 *     补进 bible/plot-map.md 的「故事线强度」与「伏笔埋收对照」。
 *     --init：文件不存在时先建骨架（含 Mermaid 初版）。
 *
 * 只**补缺**，不覆盖已有行：人写过的张力措辞、打过的强度分，脚本一律不动。
 * 退出码：0 无告警；1 有告警（缺强度值、关系标签冲突、人物缺小传等）；2 用法或读不到项目。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const opts = { project: 'novel-project', init: false, check: false, json: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--project') opts.project = args[++i];
  else if (a === '--init') opts.init = true;
  else if (a === '--check') opts.check = true;
  else if (a === '--json') opts.json = true;
}

const project = resolve(opts.project);
const bible = join(project, 'bible');
const chaptersDir = join(project, 'chapters');
if (!existsSync(bible)) {
  console.error(`读不到设定库：${bible}`);
  process.exit(2);
}

const warnings = [];
const notes = [];
const added = { people: [], edges: [], chapters: [], foreshadow: [] };
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);

/* ---------------------------------------------------------------- 表格工具 */

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** 返回 { header, rows, start, end } —— start/end 是该表在文件行数组里的下标区间 */
function findTable(lines, pred) {
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) continue;
    const header = splitRow(lines[i]);
    if (!pred(header)) continue;
    let j = i + 2;
    while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
    return { header, rows: lines.slice(i + 2, j).map(splitRow), start: i, end: j };
  }
  return null;
}

function upsertRow(lines, table, row, index) {
  const text = `| ${row.join(' | ')} |`;
  if (table) {
    lines.splice(table.end, 0, text);
    table.end += 1;
    table.rows.push(row);
  } else if (index !== undefined) {
    lines.splice(index, 0, text);
  }
}

/* ---------------------------------------------------------------- 读设定库 */

const idxFile = join(bible, 'characters', '_index.md');
const idxText = read(idxFile);
const people = [];
if (idxText) {
  const t = findTable(idxText.split(/\r?\n/), (h) => h.some((c) => /姓名/.test(c)));
  if (t) {
    for (const r of t.rows) {
      if (!r[0] || r[0] === '姓名') continue;
      people.push({ name: r[0], role: r[1] || '', camp: r[2] || '', rel: r[3] || '', first: r[4] || '', state: r[5] || '', sheet: r[6] || '' });
    }
  }
}
if (!people.length) {
  console.error('characters/_index.md 里没有人物表，没法同步图谱。');
  process.exit(2);
}

const protagonist = people.find((p) => /主角本人|主角/.test(p.rel) || /^本人$/.test((p.rel || '').trim()));

/** 从小传的「## 关系网」表抽边；返回 [{a,b,rel,tension,from}] */
const edges = new Map();
const NAMES = new Set(people.map((p) => p.name));
const KIN = /^(妹妹|姐姐|哥哥|弟弟|父亲|母亲|义父|义母|师父|师傅|徒弟|老师|大哥|二哥|表兄|表妹|堂兄|堂妹|亲妹|亲兄)/;
const aliases = [];
const unknownNames = new Set();

/** 把「妹妹沈云岫」这类称谓写法归一到登记过的姓名 */
function canonical(raw) {
  const name = String(raw).trim().replace(/（.*?）/g, '');
  if (NAMES.has(name)) return name;
  const stripped = name.replace(KIN, '');
  if (NAMES.has(stripped)) {
    aliases.push(`${name} → ${stripped}`);
    return stripped;
  }
  const hit = people.find((p) => name.includes(p.name));
  if (hit) {
    aliases.push(`${name} → ${hit.name}`);
    return hit.name;
  }
  if (!unknownNames.has(name)) unknownNames.add(name);
  return name;
}
for (const p of people) {
  if (!p.sheet) {
    warnings.push(`人物「${p.name}」在 _index.md 里没有小传路径，跳过关系网`);
    continue;
  }
  const file = join(bible, p.sheet.replace(/^characters\//, 'characters/'));
  const text = read(file);
  if (!text) {
    warnings.push(`小传读不到：${p.sheet}（${p.name}）`);
    continue;
  }
  const block = text.split('## 关系网')[1] || '';
  const t = findTable(block.split(/\r?\n/), (h) => h.some((c) => /对象/.test(c)));
  if (!t) {
    warnings.push(`小传「${p.name}」没有「## 关系网」表，关系图会缺这块`);
    continue;
  }
  for (const r of t.rows) {
    const [otherRaw, rel, tension] = r;
    if (!otherRaw || otherRaw === '对象') continue;
    const other = canonical(otherRaw);
    if (other === p.name) continue;
    const key = [p.name, other].sort().join('~~');
    const label = [rel, tension].filter(Boolean).join(' / ');
    if (edges.has(key)) {
      const prev = edges.get(key);
      if (label && !prev.labels.includes(label)) prev.labels.push(label);
      // 主角那一侧的写法优先，读起来最接近整体视角
      if (protagonist && p.name === protagonist.name && label) {
        prev.label = label;
        prev.from = p.name;
      }
      continue;
    }
    edges.set(key, { a: p.name, b: other, label, labels: [label], from: p.name });
  }
}

const degree = new Map();
for (const e of edges.values()) for (const n of [e.a, e.b]) degree.set(n, (degree.get(n) || 0) + 1);
// 主角的直系关系算「重要配角」，其余算「次要」：只看连接数的话，一张密网里人人都「重要」
const directToProtagonist = new Set();
if (protagonist) {
  for (const e of edges.values()) {
    if (e.a === protagonist.name) directToProtagonist.add(e.b);
    if (e.b === protagonist.name) directToProtagonist.add(e.a);
  }
}

function tierOf(p) {
  if (protagonist && p.name === protagonist.name) return '主角';
  if (directToProtagonist.has(p.name)) return '重要配角';
  if (!protagonist && (degree.get(p.name) || 0) >= 2) return '重要配角';
  return '次要';
}

/* 章节数：优先看正文，其次看大纲分卷范围 */
function writtenChapters() {
  if (!existsSync(chaptersDir)) return [];
  const out = [];
  for (const vol of readdirSync(chaptersDir)) {
    const dir = join(chaptersDir, vol);
    if (!statSync(dir).isDirectory() || vol === '.versions') continue;
    for (const f of readdirSync(dir)) {
      const m = f.match(/^ch-(\d{3})\.md$/);
      if (m) out.push(Number(m[1]));
    }
  }
  return out.sort((a, b) => a - b);
}

const outline = read(join(bible, 'outline.md')) || '';
function plannedChapterMax() {
  const t = findTable(outline.split(/\r?\n/), (h) => h.some((c) => /章节范围/.test(c)));
  let max = 0;
  if (t) {
    for (const r of t.rows) {
      const cell = r.find((c, i) => /–|-/.test(c) && /\d/.test(c)) || r.join(' ');
      const nums = (cell.match(/\d+/g) || []).map(Number);
      if (nums.length) max = Math.max(max, ...nums);
    }
  }
  return max;
}

function mainlineSentence() {
  const m = outline.match(/主线一句话[:：]\s*(.+)/);
  return m ? m[1].trim() : '';
}

/* 伏笔表 */
const fxText = read(join(bible, 'foreshadowing.md')) || '';
const fxRows = (() => {
  const t = findTable(fxText.split(/\r?\n/), (h) => h.some((c) => /编号/.test(c)));
  return t ? t.rows.filter((r) => /F\d{3}/.test(r[0] || '')) : [];
})();

/* ---------------------------------------------------------------- 写关系图 */

/** 线型约定表由脚本维护：老项目里可能是四行旧表，跑一次 sync 就升级成五行 */
const LEGEND_TABLE = [
  '## 线型约定', '',
  '| 线型 | 含义 |',
  '| --- | --- |',
  '| 粗实线 `==>` | 亲情（血缘、养育） |',
  '| 虚线带圈 `--o` | 师门（师徒、授业、传人、门生） |',
  '| 虚线 `-.->` | 爱情（含单恋、旧情、联姻中的真情） |',
  '| 带叉 `--x` | 敌对（仇恨、对立阵营、背叛） |',
  '| 细实线 `-->` | 利益（合作、利用、交易、上下级） |', '',
];

/** 用表里的数据重建 Mermaid 块：线型改了以后老图不必手工重画 */
function refreshMermaid(text) {
  const open = text.indexOf('```mermaid');
  if (open < 0) return text;
  const close = text.indexOf('```', open + 10);
  if (close < 0) return text;
  const rowsOf = (heading) => {
    const at = text.indexOf(heading);
    if (at < 0) return [];
    const body = text.slice(at + heading.length).split('\n## ')[0];
    return body.split('\n')
      .filter((l) => l.trim().startsWith('|') && !/^\|\s*-{2,}/.test(l.trim()) && !/\|\s*人物\s*\|/.test(l) && !/\|\s*人物 A/.test(l))
      .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  };
  const tierRows = rowsOf('## 人物档位').filter((r) => r.length >= 3);
  const edgeRows = rowsOf('## 文字版关系表').filter((r) => r.length >= 4).map((r) => [r[0], r[1], r[2], r[3], r[4] || '']);
  if (!tierRows.length || !edgeRows.length) return text;
  const block = mermaidFromTables(tierRows, edgeRows);
  return text.slice(0, open) + block + text.slice(close + 3);
}

function refreshLegend(text) {
  const start = text.indexOf('## 线型约定');
  if (start < 0) return text;
  const next = text.indexOf('\n## ', start + 4);
  const head = text.slice(0, start);
  const tail = next < 0 ? '' : text.slice(next + 1);
  return head + LEGEND_TABLE.join('\n') + '\n\n' + tail;
}

const relFile = join(bible, 'relationship-map.md');
let relText = read(relFile);
const relLines = relText ? relText.split(/\r?\n/) : null;

function mermaidFromTables(tierRows, edgeRows) {
  const idOf = new Map();
  let n = 0;
  const nodeId = (name) => {
    if (!idOf.has(name)) idOf.set(name, `N${++n}`);
    return idOf.get(name);
  };
  const kindOf = (label) => {
    if (/师徒|师父|师傅|恩师|师尊|徒弟|弟子|门生|传人|授业/.test(label)) return '--o';
    if (/亲情|父女|父子|母女|母子|兄弟|姐妹|叔侄|养育/.test(label)) return '==>';
    if (/爱情|爱慕|夫妻|恋人|情人/.test(label)) return '-.->';
    if (/敌对|仇|对立|背叛|构陷|陷害|杀/.test(label)) return '--x';
    return '-->';
  };
  const nodes = tierRows.map((r) => `  ${nodeId(r[0])}["${r[0]}${r[2] ? `（${r[2]}）` : ''}"]`).join('\n');
  const hub = protagonist ? protagonist.name : '';
  const links = edgeRows
    .map((r) => {
      let [x, y] = [r[0], r[1]];
      let [rel, ten] = [r[2], r[3]];
      if (hub && y === hub && x !== hub) [x, y] = [y, x];
      return `  ${nodeId(x)} ${kindOf(`${rel} ${ten}`)}|"${rel}${ten ? ` / ${ten}` : ''}"| ${nodeId(y)}`;
    })
    .join('\n');
  return `\`\`\`mermaid\ngraph LR\n${nodes}\n${links}\n  classDef main fill:#fff3c4,stroke:#333,stroke-width:2px\n  class ${protagonist ? nodeId(protagonist.name) : 'N1'} main\n\`\`\``;
}

if (!relLines) {
  if (!opts.init) {
    warnings.push('relationship-map.md 不存在：加 --init 可生成初版骨架');
  } else {
    const tierRows = people.map((p) => [p.name, tierOf(p), p.role.replace(/（.*?）/g, '').slice(0, 10)]);
    const edgeRows = [...edges.values()].map((e) => {
      const a = people.find((p) => p.name === e.a);
      return [e.a, e.b, (e.label.split(' / ')[0] || '').trim(), (e.label.split(' / ')[1] || '').trim(), ''];
    });
    const body = [
      '# 人物关系图', '',
      `> 范围：主要人物 ${people.length} 人｜含剧透｜${new Date().toISOString().slice(0, 10)}｜初版由 graph-sync 从人物小传推导，之后人工修订`,
      '> 图在支持 Mermaid 的阅读器里显示；渲染失败看本文文字表，配图见同目录 `relationship-map.svg`。', '',
      '## 线型约定', '',
      '| 线型 | 含义 |', '| --- | --- |',
      '| 粗实线 `==>` | 亲情（血缘、养育） |',
      '| 虚线带圈 `--o` | 师门（师徒、授业、传人） |',
      '| 虚线 `-.->` | 爱情（含单恋、旧情、联姻中的真情） |',
      '| 带叉 `--x` | 敌对（仇恨、对立阵营、背叛） |',
      '| 细实线 `-->` | 利益（合作、利用、交易、上下级） |', '',
      '## 人物档位', '',
      '| 人物 | 档位 | 身份 |', '| --- | --- | --- |',
      ...tierRows.map((r) => `| ${r.join(' | ')} |`), '',
      '## 关系图', '',
      mermaidFromTables(tierRows, edgeRows), '',
      '## 文字版关系表', '',
      '| 人物 A | 人物 B | 关系 | 张力 | 关键事件（章） |', '| --- | --- | --- | --- | --- |',
      ...edgeRows.map((r) => `| ${r.join(' | ')} |`), '',
    ].join('\n');
    if (!opts.check) writeFileSync(relFile, refreshLegend(body));
    added.people.push(...people.map((p) => p.name));
    added.edges.push(...[...edges.values()].map((e) => `${e.a}—${e.b}`));
  }
} else {
  const tierTable = findTable(relLines, (h) => h.some((c) => /人物|姓名/.test(c)) && h.some((c) => /档位|级别|重要/.test(c)));
  const edgeTable = findTable(relLines, (h) => h.some((c) => /人物\s*A/.test(c)) && h.some((c) => /人物\s*B/.test(c)));
  let dirty = false;
  const known = new Set((tierTable ? tierTable.rows : []).map((r) => r[0]));
  const newTierRows = people.filter((p) => !known.has(p.name));
  if (newTierRows.length) {
    if (!tierTable) {
      warnings.push('relationship-map.md 没有「人物档位」表，人物档位暂时只能按连接数猜');
    } else if (!opts.check) {
      for (const p of newTierRows) {
        upsertRow(relLines, tierTable, [p.name, tierOf(p), p.role.replace(/（.*?）/g, '').slice(0, 10)]);
        added.people.push(p.name);
      }
      dirty = true;
    }
  }
  const knownPairs = new Set(
    (edgeTable ? edgeTable.rows : []).map((r) => [r[0], r[1]].sort().join('~~')),
  );
  const newEdges = [...edges.entries()].filter(([k]) => !knownPairs.has(k));
  if (newEdges.length) {
    if (!edgeTable) {
      warnings.push('relationship-map.md 没有「文字版关系表」（人物 A｜人物 B），新关系补不进去');
    } else if (!opts.check) {
      for (const [, e] of newEdges) {
        const [rel, tension] = [e.label.split(' / ')[0] || '', e.label.split(' / ')[1] || ''];
        upsertRow(relLines, edgeTable, [e.a, e.b, rel, tension, '']);
        added.edges.push(`${e.a}—${e.b}`);
        if (e.labels.length > 1) {
          notes.push(`「${e.a}—${e.b}」两边小传写法不同：${e.labels.map((l) => `「${l}」`).join(' ／ ')}，已取主角侧`);
        }
      }
      dirty = true;
    }
  }
  if (dirty && !opts.check) writeFileSync(relFile, refreshLegend(relLines.join('\n')));
  // 表格没变化、但线型约定是旧版时也要刷新一次
  if (!opts.check && existsSync(relFile)) {
    const cur = readFileSync(relFile, 'utf8');
    const next = refreshMermaid(refreshLegend(cur));
    if (next !== cur) writeFileSync(relFile, next);
  }
}

/* ---------------------------------------------------------------- 写情节图 */

const plotFile = join(bible, 'plot-map.md');
let plotText = read(plotFile);
const written = writtenChapters();
const plannedMax = plannedChapterMax();
const needChapters = [...new Set([...written, ...Array.from({ length: Math.max(0, plannedMax) }, (_, i) => i + 1)])].sort((a, b) => a - b);

if (!plotText) {
  if (!opts.init) {
    warnings.push('plot-map.md 不存在：加 --init 可生成初版骨架');
  } else {
    const body = [
      '# 情节发展地图', '',
      `> 范围：全书｜含剧透｜${new Date().toISOString().slice(0, 10)}｜初版由 graph-sync 从大纲推导，之后人工修订`, '',
      '## 主线一句话', '',
      mainlineSentence() || '（待补：从 outline.md 的「主线一句话」抄过来）', '',
      '## 情节图（按卷）', '',
      '```mermaid\nflowchart TD\n  A1["待补：卷首事件"]\n```', '',
      '## 卷—事件—人物变化表', '',
      '| 卷 | 章号范围 | 核心事件 | 主角变化（起点→终点） | 冲突升级 | 卷末钩子 |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 一 | 待补 | 待补 | 待补 | 待补 | 待补 |', '',
      '## 故事线强度（每章 0–5）', '',
      '| 章 | 主线 |', '| --- | --- |',
      ...needChapters.map((c) => `| ${c} | — |`), '',
      '> `—` 表示还没打分；写细纲时填规划值，写完正文改成实测值。', '',
      '## 伏笔埋收对照', '',
      '| 编号 | 埋设章 | 回收章 | 状态 |', '| --- | --- | --- | --- |',
      ...fxRows.map((r) => `| ${r[0]} | ${r[1] || ''} | ${r[2] || ''} | ${r[3] || '未回收'} |`), '',
      '## 主线问题与回收', '', '- （待补）', '',
    ].join('\n');
    if (!opts.check) writeFileSync(plotFile, body);
    added.chapters.push(...needChapters);
  }
} else {
  const lines = plotText.split(/\r?\n/);
  const strength = findTable(lines, (h) => /^章/.test((h[0] || '').trim()));
  let dirty = false;
  if (!strength) {
    warnings.push('plot-map.md 没有「故事线强度」表（表头第一列必须是「章」），折线图画不出来');
  } else {
    const have = new Set(strength.rows.map((r) => Number(String(r[0]).replace(/[^\d]/g, ''))));
    const missing = needChapters.filter((c) => !have.has(c));
    if (missing.length && !opts.check) {
      for (const c of missing) {
        upsertRow(lines, strength, [c, ...Array(strength.header.length - 1).fill('—')]);
        added.chapters.push(c);
      }
      dirty = true;
    }
    const undone = (r) => r.slice(1).some((c) => c === '—' || c === '');
    const emptyWritten = strength.rows.filter((r) => undone(r) && written.includes(Number(String(r[0]).replace(/[^\d]/g, ''))));
    const emptyPlanned = strength.rows.filter((r) => undone(r) && !written.includes(Number(String(r[0]).replace(/[^\d]/g, ''))));
    if (emptyWritten.length) {
      warnings.push(`已写章节还有 ${emptyWritten.length} 章没打分：第 ${emptyWritten.map((r) => r[0]).join('、')} 章——折线会断开`);
    }
    if (emptyPlanned.length) {
      notes.push(`未写章节 ${emptyPlanned.length} 章暂未打分（正常，写细纲时补）`);
    }
  }

  // 伏笔对照：把 foreshadowing.md 里新增的编号补进来
  const fxTable = findTable(lines, (h) => h.some((c) => /编号/.test(c)));
  if (fxTable) {
    const have = new Set(fxTable.rows.map((r) => (r[0].match(/F\d{3}/) || [''])[0]));
    for (const r of fxRows) {
      const id = (r[0].match(/F\d{3}/) || [''])[0];
      if (!id || have.has(id)) continue;
      if (opts.check) continue;
      upsertRow(lines, fxTable, [r[0], r[1] || '', r[2] || '', r[3] || '未回收']);
      added.foreshadow.push(id);
      dirty = true;
    }
  }
  if (dirty && !opts.check) writeFileSync(plotFile, lines.join('\n'));
}

/* ---------------------------------------------------------------- 汇报 */

const result = { ok: warnings.length === 0, project: relative(process.cwd(), project), added, warnings, chapters: needChapters.length };
if (opts.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const lines = [];
  if (added.people.length) lines.push(`+ 人物 ${added.people.length}：${added.people.join('、')}`);
  else lines.push('人物：无新增');
  if (added.edges.length) lines.push(`+ 关系 ${added.edges.length}：${added.edges.join('、')}`);
  else lines.push('关系：无新增');
  if (added.chapters.length) lines.push(`+ 章节行 ${added.chapters.length}：第 ${added.chapters.join('、')} 章`);
  else lines.push(`章节行：无新增（全书 ${needChapters.length} 章）`);
  if (added.foreshadow.length) lines.push(`+ 伏笔 ${added.foreshadow.length}：${added.foreshadow.join('、')}`);
  if (aliases.length) lines.push(`· 称谓归一 ${new Set(aliases).size} 处：${[...new Set(aliases)].join('、')}`);
  if (unknownNames.size) lines.push(`! 关系网里有 ${unknownNames.size} 个未登记的名字：${[...unknownNames].join('、')}（要么补进人物库，要么改小传里的写法）`);
  for (const w of warnings) lines.push(`! ${w}`);
  for (const n of notes) lines.push(`· ${n}`);
  console.log(lines.join('\n'));
  if (!opts.check) console.log('\n下一步：node <技能 Base directory>/tools/render-graph.mjs --project ' + opts.project);
}
process.exit(warnings.length ? 1 : 0);
