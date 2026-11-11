#!/usr/bin/env node
// 上下文打包：写某一章之前，把「该读什么」和「跨了几十章的伏笔原句」一次取出来。
// 用法：
//   node context-pack.mjs <章号|章节文件> [--project novel-project] [--recent 3] [--tail 300] [--json]
// 退出码：0 正常（缺料会给 warn）/ 2 用法错或项目目录不存在

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法: node context-pack.mjs <章号|章节文件> [--project novel-project] [--recent 3] [--tail 300] [--json]');
  process.exit(2);
}

const opts = { project: 'novel-project', recent: 3, tail: 300, json: false };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--project') opts.project = args[++i];
  else if (a === '--recent') opts.recent = Math.max(0, parseInt(args[++i], 10) || 0);
  else if (a === '--tail') opts.tail = Math.max(0, parseInt(args[++i], 10) || 0);
  else if (a === '--json') opts.json = true;
  else if (a.startsWith('--')) { console.error(`未知参数: ${a}`); process.exit(2); }
  else positional.push(a);
}
if (!positional.length) { console.error('缺少章号或章节文件'); process.exit(2); }
if (!existsSync(opts.project) || !statSync(opts.project).isDirectory()) {
  console.error(`项目目录不存在: ${opts.project}`);
  process.exit(2);
}

const target = positional[0];
const numMatch = target.match(/(\d{1,4})/);
if (!numMatch) { console.error(`读不出章号: ${target}`); process.exit(2); }
const num = parseInt(numMatch[1], 10);
const pad = String(num).padStart(3, '0');

const warnings = [];
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const exists = (p) => existsSync(p);

function walk(dir, out = []) {
  if (!exists(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === '.versions' || name === '_original') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const chapterFile = (n) => {
  const p = String(n).padStart(3, '0');
  return walk(join(opts.project, 'chapters')).find((f) => new RegExp(`(^|[\\\\/])ch-${p}\\.md$`).test(f)) || '';
};
const outlineFile = (n) => {
  const p = String(n).padStart(3, '0');
  return walk(join(opts.project, 'outline')).find((f) => new RegExp(`(^|[\\\\/])ch-${p}\\.md$`).test(f)) || '';
};

const rel = (p) => (p ? relative(opts.project, p).split('\\').join('/') : '');

// ---------- 细纲 ----------
const outlinePath = outlineFile(num);
const outline = read(outlinePath);
if (!outline) warnings.push(`没有第 ${num} 章细纲（outline/），先回 novel-detailed-outline`);

// ---------- 伏笔表 ----------
function parseTable(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) continue;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    rows.push(cells);
  }
  return rows;
}

function chNum(s, { range = false } = {}) {
  if (!s) return null;
  if (range) {
    const r = s.match(/(\d+)\s*[–—\-~至到]+\s*(\d+)/);
    if (r) return [parseInt(r[1], 10), parseInt(r[2], 10)];
  }
  const m = s.match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return range ? [n, n] : n;
}

const fsRows = parseTable(read(join(opts.project, 'bible', 'foreshadowing.md')));
const foreshadowing = fsRows.slice(1).filter((c) => /^F\d{3}$/.test(c[0] || '')).map((c) => {
  const due = chNum(c[4], { range: true });
  return {
    id: c[0], content: c[1] || '', buried: chNum(c[2]), truth: c[3] || '',
    due, dueRaw: c[4] || '', status: c[5] || '', note: c[6] || '',
  };
});
if (!foreshadowing.length) warnings.push('bible/foreshadowing.md 里没有解析到 F 编号条目');

// 细纲点名的伏笔
const named = [...new Set((outline.match(/F\d{3}/g) || []))];
const involved = foreshadowing.filter((f) => named.includes(f.id));
// 到期未收的（预定回收章 ≤ 本章，且状态不是已回收）
const overdue = foreshadowing.filter((f) => f.due && f.due[1] <= num && f.status !== '已回收' && !named.includes(f.id));

// ---------- 取原句 ----------
const cjk = (s) => (s.match(/[\u3400-\u9fff]/g) || []).length;
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

function bigrams(s) {
  const clean = s.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '');
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

function locate(f) {
  if (!f.buried) return { file: '', paragraph: '', score: 0 };
  const file = chapterFile(f.buried);
  if (!file) return { file: '', paragraph: '', score: 0 };
  const paras = stripComments(read(file)).split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !p.startsWith('#'));
  const needle = bigrams(f.content);
  let best = { paragraph: '', score: -1, index: -1 };
  paras.forEach((p, i) => {
    const have = bigrams(p);
    let score = 0;
    for (const g of needle) if (have.has(g)) score++;
    if (score > best.score) best = { paragraph: p, score, index: i };
  });
  // 分数太低说明正文里根本没写这个物象——不假装找到了
  const ok = best.score >= Math.max(3, Math.ceil(needle.size * 0.12));
  return { file, paragraph: ok ? best.paragraph : '', score: best.score, index: best.index };
}

// ---------- 章节摘要 ----------
const digestRows = parseTable(read(join(opts.project, 'bible', 'digest.md')))
  .slice(1)
  .filter((c) => /^\d+$/.test((c[0] || '').trim()))
  .map((c) => ({ ch: parseInt(c[0], 10), time: c[1] || '', plot: c[2] || '', change: c[3] || '', fx: c[4] || '' }));
const recent = digestRows.filter((r) => r.ch < num).slice(-opts.recent);
const related = digestRows.filter((r) => r.ch < num && involved.some((f) => (r.fx || '').includes(f.id)));
if (!digestRows.length && num > 1) warnings.push('bible/digest.md 还没有第 1 章之后的摘要行');

// ---------- 上一章末尾 ----------
let prev = '';
for (let n = num - 1; n >= 1 && !prev; n--) prev = chapterFile(n);
const tailText = prev ? stripComments(read(prev)).trim().slice(-opts.tail) : '';
if (!tailText && num > 1) warnings.push(`找不到第 ${num - 1} 章正文，接不上上一章的钩子`);

const payload = {
  chapter: num,
  files: {
    outline: rel(outlinePath),
    style: 'bible/style.md',
    digest: 'bible/digest.md',
    timeline: 'bible/timeline.md',
    facts: 'bible/facts.md',
    prevChapter: rel(prev),
  },
  foreshadowing: involved.map((f) => {
    const loc = locate(f);
    return {
      id: f.id, status: f.status, buried: f.buried, dueRaw: f.dueRaw, content: f.content, truth: f.truth,
      source: rel(loc.file), quote: loc.paragraph,
    };
  }),
  overdue: overdue.map((f) => ({ id: f.id, status: f.status, dueRaw: f.dueRaw, content: f.content })),
  recent,
  related,
  prevTail: tailText,
  warnings,
};

if (opts.json) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const L = [];
L.push(`# 第 ${num} 章 · 上下文包`);
L.push('');
L.push('## 1 必读文件');
L.push('');
for (const [k, v] of Object.entries(payload.files)) if (v) L.push(`- ${k}：\`${v}\``);
L.push('');
L.push('## 2 本章伏笔');
L.push('');
if (!involved.length) L.push(outline ? '细纲没点名任何 F 编号。若本章要埋或收伏笔，先回细纲补上编号。' : '没有细纲，无法确定本章伏笔。');
for (const f of payload.foreshadowing) {
  L.push(`### ${f.id} · ${f.status} · 埋第 ${f.buried ?? '?'} 章 · 预定 ${f.dueRaw || '?'}`);
  L.push('');
  L.push(`- 内容：${f.content || '（表里空着，先补 bible/foreshadowing.md）'}`);
  if (f.truth) L.push(`- 指向：${f.truth}`);
  if (f.quote) {
    L.push(`- 原句（${f.source}）：`);
    L.push('');
    L.push(`  > ${f.quote.replace(/\n/g, '\n  > ')}`);
  } else {
    L.push(`- 原句：**在 ${f.source || '埋设章'} 里没找到这个物象**。要么伏笔表写的不是正文真写过的，要么当时的写法换了词——回收前先回头看那一段，别照着表里的描述硬编。`);
  }
  L.push('');
}
if (payload.overdue.length) {
  L.push('### 已到期、细纲没点名');
  L.push('');
  for (const f of payload.overdue) L.push(`- ${f.id}（${f.status}，预定 ${f.dueRaw}）：${f.content}`);
  L.push('');
}
L.push('## 3 章节摘要');
L.push('');
if (!recent.length) L.push('（digest.md 里没有本章之前的记录）');
else {
  L.push('| 章 | 时间 | 剧情 | 状态变化 | 埋/收 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const r of recent) L.push(`| ${r.ch} | ${r.time} | ${r.plot} | ${r.change} | ${r.fx} |`);
}
if (related.length && related.some((r) => !recent.find((x) => x.ch === r.ch))) {
  L.push('');
  L.push('跨章相关（按伏笔编号揪出来的旧章）：');
  L.push('');
  for (const r of related.filter((r) => !recent.find((x) => x.ch === r.ch))) {
    L.push(`- 第 ${r.ch} 章（${r.fx}）：${r.plot}；${r.change}`);
  }
}
L.push('');
L.push('## 4 上一章末尾');
L.push('');
L.push(tailText ? `  > ${tailText.replace(/\n/g, '\n  > ')}` : '（无）');
L.push('');
if (warnings.length) {
  L.push('## 5 缺料');
  L.push('');
  for (const w of warnings) L.push(`- ${w}`);
  L.push('');
}
L.push('---');
L.push('');
L.push('用法：第 2 节的「原句」是既成事实，**不许改写其中的物象、动作、数字**；回收时先让读者认出这个东西，再解释它是什么。第 4 节只用来接语气和钩子，不要复述上一章的剧情。');
console.log(L.join('\n'));
