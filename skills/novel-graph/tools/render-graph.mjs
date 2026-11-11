#!/usr/bin/env node
/**
 * 阶段 11 配图：把两张图谱 Markdown 里的表，画成两个 SVG。
 *
 *   node render-graph.mjs [--project novel-project] [--out novel-project/bible] [--check] [--json]
 *
 * 读：
 *   <project>/bible/relationship-map.md  「文字版关系表」（人物 A｜人物 B｜关系｜张力｜关键事件）
 *                                        可选「人物档位」表（人物｜档位｜身份），档位=主角/重要配角/次要
 *   <project>/bible/plot-map.md          「故事线强度」表（章｜线名…｜0–5）
 *
 * 写：
 *   <out>/relationship-map.svg
 *   <out>/plot-map.svg
 *
 * 退出码：0 成功；1 有可画的表但存在告警（如人数过多）；2 用法错误或读不到表。
 * 零依赖，只用 node 内置模块。
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Source Han Sans SC",system-ui,sans-serif';
const INK = '#e8e6e3';
const MUTE = '#9aa3b0';
const GRID = '#2a2f3a';
const BG = '#12141a';

/* ---------------------------------------------------------------- 参数 */

function parseArgs(argv) {
  const opts = { project: 'novel-project', out: null, check: false, json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') opts.project = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--check') opts.check = true;
    else if (a === '--clean') opts.clean = true;
    else if (a.startsWith('--layout=')) opts.layout = a.slice(9);
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else rest.push(a);
  }
  if (rest.length) opts.project = rest[0];
  return opts;
}

/* ---------------------------------------------------------------- 读表 */

/** 从 markdown 里找出所有表格：每张表 = {header:[...], rows:[[...],...]} */
function tables(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) continue;
    const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const header = cells(lines[i]);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) rows.push(cells(lines[j]));
    out.push({ header, rows });
    i = j - 1;
  }
  return out;
}

const findTable = (ts, pred) => ts.find((t) => pred(t.header));

const DEGREE = new Map();

/* ---------------------------------------------------------------- 关系图 */

const REL = {
  kin: { key: 'kin', stroke: '#e0b84c', width: 3.2, dash: null, text: '#f0d48a', label: '亲情' },
  master: { key: 'master', stroke: '#5fbf9a', width: 3, dash: '9 4', text: '#8fd8bd', label: '师门' },
  love: { key: 'love', stroke: '#d07ab0', width: 2.6, dash: '7 5', text: '#e6a8cd', label: '爱情' },
  foe: { key: 'foe', stroke: '#c0504d', width: 2.6, dash: '3 4', text: '#e08d8a', label: '敌对' },
  deal: { key: 'deal', stroke: '#7f8ea3', width: 1.3, dash: null, text: '#a9b6c6', label: '利益' },
};

/**
 * 把「关系」文字归类到四线型；表里有「类型」列时以列值优先。
 *
 * 中文的关系写法极短（亲兄 / 恩师 / 徒弟 / 父亲 / 上线），只匹配「兄弟」「父子」
 * 这种复合词会漏掉一大半，全掉进「利益」。所以这里按「先爱情、再师门、再亲情、再敌对、
 * 剩下才是利益」的顺序，用单字级词根 + 上下文词判断。
 */
function relKind(typeCell, relationText) {
  const s = `${typeCell || ''} ${relationText || ''}`.trim();
  if (!s) return REL.deal;

  // 1 爱情：婚姻与恋人优先，避免「夫妻」被当亲情
  if (/爱情|爱慕|爱恋|情人|恋人|夫妻|婚约|未婚|订婚|心上人|单恋|妾|红颜|相好/.test(s)) return REL.love;

  // 2 师门：师徒不是血缘，单列一条线
  if (/师父|师傅|恩师|师尊|师祖|师叔|师伯|师兄|师姐|师弟|师妹|徒弟|弟子|学徒|门生|传人|授业|门下/.test(s)) {
    return REL.master;
  }

  // 3 亲情：亲属称谓
  if (
    /亲情|亲属|亲人|血亲|嫡亲|族亲|长辈|父女|父子|母女|母子|兄弟|姐妹|叔侄|姑侄|舅甥|祖孙|养父|养母|养子|养女|义父|义母|义兄|义妹|亲兄|亲弟|亲姐|亲妹|父亲|母亲|兄长|姐姐|妹妹|弟弟|师父|师傅|恩师|师尊|徒弟|弟子|学徒|传人/.test(s)
    || /^[父母兄姐弟妹叔伯姑舅姨祖孙甥侄]/.test(s)
  ) {
    return REL.kin;
  }

  // 4 敌对：仇怨、陷害、你死我活
  if (/敌对|仇|宿敌|政敌|对头|对立|背叛|出卖|杀|灭|陷害|构陷|反目|死敌|暗算|灭口|胁迫|要挟/.test(s)) return REL.foe;

  // 5 其余都是利益往来（搭档、上线、靠山、互相利用、官场关系……）
  return REL.deal;
}

function tierOf(value) {
  const s = String(value || '');
  // 顺序要紧：「重要配角」里也有「配角」，先判次要，再判主角，最后才是配角
  if (/次要|龙套|路人|边缘|一带而过/.test(s)) return 3;
  if (/主角|主人公/.test(s)) return 1;
  if (/重要|主要|核心|关键|反派|女主|男主/.test(s)) return 2;
  if (/配角|辅助/.test(s)) return 2;
  return 0;
}

function fmt(n) {
  return Number(n).toFixed(1).replace(/\.0$/, '');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function edgeGeom(p1, p2, r1, r2, bow) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const x1 = p1.x + ux * r1;
  const y1 = p1.y + uy * r1;
  const x2 = p2.x - ux * r2;
  const y2 = p2.y - uy * r2;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return { x1, y1, x2, y2, cx: mx - uy * bow, cy: my + ux * bow, ux, uy };
}

function quadAt(g, t) {
  const u = 1 - t;
  return {
    x: u * u * g.x1 + 2 * u * t * g.cx + t * t * g.x2,
    y: u * u * g.y1 + 2 * u * t * g.cy + t * t * g.y2,
    dx: 2 * u * (g.cx - g.x1) + 2 * t * (g.x2 - g.cx),
    dy: 2 * u * (g.cy - g.y1) + 2 * t * (g.y2 - g.cy),
  };
}

function buildRelations(tbl) {
  const idx = (names) => tbl.header.findIndex((h) => names.some((n) => h.replace(/\s/g, '').includes(n)));
  const iA = idx(['人物A', '人物 A', '角色A', '甲方', '人物1']);
  const iB = idx(['人物B', '人物 B', '角色B', '乙方', '人物2']);
  const iRel = idx(['关系']);
  const iTen = idx(['张力']);
  const iType = idx(['类型', '线型', '关系类型']);
  if (iA < 0 || iB < 0) return null;
  const nodes = new Map();
  const edges = [];
  for (const row of tbl.rows) {
    const a = (row[iA] || '').replace(/（.*?）/g, '').trim();
    const b = (row[iB] || '').replace(/（.*?）/g, '').trim();
    if (!a || !b || a === b) continue;
    for (const n of [a, b]) if (!nodes.has(n)) nodes.set(n, { name: n, sub: '', tier: 0 });
    const rel = (row[iRel] || '').trim();
    const ten = (row[iTen] || '').trim();
    const label = [rel, ten].filter(Boolean).join(' / ');
    edges.push({ a, b, kind: relKind(iType >= 0 ? row[iType] : '', rel).key, label: label || rel });
  }
  return { nodes: [...nodes.values()], edges };
}

function withTiers(parsed, tierTable) {
  if (tierTable) {
    const iN = tierTable.header.findIndex((h) => /人物|姓名|角色/.test(h));
    const iT = tierTable.header.findIndex((h) => /档位|重要|级别|等级/.test(h));
    const iS = tierTable.header.findIndex((h) => /身份|职位|说明/.test(h));
    for (const row of tierTable.rows) {
      const n = (row[iN] || '').trim();
      const node = parsed.nodes.find((x) => x.name === n);
      if (!node) continue;
      const t = tierOf(row[iT]);
      if (t) node.tier = t;
      if (iS >= 0) node.sub = (row[iS] || '').trim();
    }
  }
  // 没有档位表时按度数猜：连接最多的是主角，只有一条线的降为次要
  const deg = new Map();
  for (const e of parsed.edges) {
    deg.set(e.a, (deg.get(e.a) || 0) + 1);
    deg.set(e.b, (deg.get(e.b) || 0) + 1);
  }
  const max = Math.max(1, ...deg.values());
  for (const n of parsed.nodes) {
    if (!n.tier) {
      const d = deg.get(n.name) || 0;
      n.tier = d === max ? 1 : d <= 1 ? 3 : 2;
    }
  }
  return parsed;
}

/**
 * 先算环半径，再定画布——人多环就大、画布跟着大。
 * 画布不会无限长：宽高都有上限，超过就把图缩放给你看（SVG 是矢量的）。
 */
function relationshipGeometry(parsed) {
  const hub = parsed.nodes.filter((n) => n.tier === 1);
  const useHub = hub.length === 1;
  const rest = parsed.nodes.filter((n) => !(useHub && n.tier === 1));
  const inner = rest.filter((n) => n.tier <= 2);
  const outer = rest.filter((n) => n.tier === 3);
  const twoRings = inner.length + outer.length > 8;
  // 每个圈按「弧长够放节点 + 标签」估直径：圆周长 / 节点数 ≥ 最小间距
  const ringRadius = (count) => Math.max(168, Math.ceil((count * 152) / (2 * Math.PI)));
  const innerR = ringRadius(twoRings ? inner.length : inner.length + outer.length);
  const outerR = twoRings ? innerR + 70 + ringRadius(outer.length) : innerR;
  return { useHub, inner, outer, twoRings, innerR, outerR };
}

function layoutNodes(parsed, geo, cx, cy) {
  const { useHub, inner, outer, twoRings, innerR, outerR } = geo;
  const pos = new Map();
  const hub = parsed.nodes.filter((n) => n.tier === 1);
  if (useHub) pos.set(hub[0].name, { x: cx, y: cy });
  const ring = (list, radius, phase) => {
    list.forEach((n, i) => {
      const a = -Math.PI / 2 + phase + (i * 2 * Math.PI) / Math.max(list.length, 1);
      pos.set(n.name, { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius * 0.94 });
    });
  };
  if (!twoRings) {
    ring([...inner, ...outer], innerR, useHub ? 0 : 0.4);
  } else {
    ring(inner, innerR, 0);
    ring(outer, outerR, useHub ? 0.35 : 0.2);
  }
  return pos;
}

/**
 * 簇状布局：几个核心人物各带一圈「和他最密切的人」，簇与簇之间再连。
 *
 * 为什么不用「主角居中、其余按档位画圈」：那样两个有关系的配角可能被摆到
 * 圆圈的两头，中间隔着整个画布。簇状布局保证「同一个人的关系」总是挨着。
 */
function clusterLayout(parsed) {
  const adj = new Map();
  const bump = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Map());
    adj.get(a).set(b, (adj.get(a).get(b) || 0) + 1);
    if (!adj.has(b)) adj.set(b, new Map());
    adj.get(b).set(a, (adj.get(b).get(a) || 0) + 1);
  };
  for (const e of parsed.edges) bump(e.a, e.b);
  const deg = (n) => [...(adj.get(n) || new Map()).values()].reduce((a, b) => a + b, 0);

  const byDegree = [...parsed.nodes].sort((a, b) => deg(b.name) - deg(a.name));
  const protagonist = parsed.nodes.find((n) => n.tier === 1);
  const k = Math.max(2, Math.min(6, Math.round(parsed.nodes.length / 4)));
  const hubs = [];
  if (protagonist) hubs.push(protagonist);
  for (const n of byDegree) {
    if (hubs.length >= k) break;
    if (!hubs.includes(n)) hubs.push(n);
  }

  // 分配：先看和哪个簇心连着，平手时往「人少的簇」放，避免一个簇吃满、别的簇空着
  const members = new Map(hubs.map((h) => [h.name, []]));
  const assign = new Map();
  hubs.forEach((h) => assign.set(h.name, h.name));
  for (const n of byDegree) {
    if (assign.has(n.name)) continue;
    let best = hubs[0].name;
    let bestScore = -Infinity;
    for (const h of hubs) {
      if (h.name === n.name) continue;
      const w = adj.get(n.name)?.get(h.name) || 0;
      const score = w * 10 - (members.get(h.name)?.length || 0) * 0.6;
      if (score > bestScore) { bestScore = score; best = h.name; }
    }
    assign.set(n.name, best);
    members.get(best)?.push(n);
  }

  // 一个簇心若一个成员都没分到（它的邻居全是别人簇里的），就把它降级成那个簇的成员
  for (let round = 0; round < 2; round++) {
    for (const h of [...hubs]) {
      if (h.tier === 1) continue;
      if ((members.get(h.name) || []).length) continue;
      let target = null;
      let bestW = -1;
      for (const h2 of hubs) {
        if (h2.name === h.name) continue;
        const w = adj.get(h.name)?.get(h2.name) || 0;
        if (w > bestW) { bestW = w; target = h2.name; }
      }
      if (!target) continue;
      hubs.splice(hubs.indexOf(h), 1);
      members.delete(h.name);
      assign.set(h.name, target);
      members.get(target)?.push(h);
    }
  }

  const R = { 1: 54, 2: 42, 3: 28 };
  const hubR = (name) => R[parsed.nodes.find((n) => n.name === name)?.tier] ?? 42;
  // 卫星圈的半径要同时满足：① 不压住核心人物本人 ② 一圈放得下所有卫星
  const satelliteR = (name) => {
    const n = Math.max(1, (members.get(name) || []).length);
    return Math.max(120, hubR(name) + 42 + 34, Math.ceil((n * (2 * 42 + 30)) / (2 * Math.PI)));
  };
  const clusterR = (name) => satelliteR(name) + 62;
  // 簇心排成一圈：相邻两簇的半径之和决定这一圈的周长下限
  let ringR = hubs.length === 1 ? 0 : 240;
  if (hubs.length > 1) {
    const half = Math.sin(Math.PI / hubs.length);
    for (let i = 0; i < hubs.length; i++) {
      const a = clusterR(hubs[i].name);
      const b = clusterR(hubs[(i + 1) % hubs.length].name);
      ringR = Math.max(ringR, (a + b + 96) / (2 * half));
    }
  }

  const cx = 0, cy = 0;
  const pos = new Map();
  const clusters = [];
  hubs.forEach((h, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / hubs.length;
    const hx = cx + Math.cos(a) * (hubs.length === 1 ? 0 : ringR);
    const hy = cy + Math.sin(a) * (hubs.length === 1 ? 0 : ringR * 0.9);
    pos.set(h.name, { x: hx, y: hy });
    const membersHere = members.get(h.name) || [];
    const rs = satelliteR(h.name);
    const base = Math.atan2(hy - cy, hx - cx);
    membersHere.forEach((n, j) => {
      const step = (2 * Math.PI) / Math.max(membersHere.length, 1);
      const ang = base + j * step;
      pos.set(n.name, { x: hx + Math.cos(ang) * rs, y: hy + Math.sin(ang) * rs * 0.94 });
    });
    clusters.push({ name: h.name, x: hx, y: hy, r: rs + 62, members: membersHere.map((m) => m.name) });
  });

  const pad = 150;
  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad * 0.8;
  const maxY = Math.max(...ys) + pad * 0.8;
  const W = Math.max(760, Math.min(1400, Math.round(maxX - minX)));
  const H = Math.max(560, Math.min(1200, Math.round(maxY - minY)));
  const shiftX = -minX;
  const shiftY = -minY;
  for (const p of pos.values()) { p.x += shiftX; p.y += shiftY; }
  clusters.forEach((c) => { c.x += shiftX; c.y += shiftY; });
  return { pos, W, H, clusters, hubs };
}

function hitRect(r, rects) {
  return rects.some((o) => Math.abs(r.x - o.x) < (r.w + o.w) / 2 + 6 && Math.abs(r.y - o.y) < (r.h + o.h) / 2 + 6);
}

/** 矩形与圆是否相交（按矩形最近点算，避免标签被节点盖住一截） */
function hitNode(r, pos, nodes, R) {
  for (const n of nodes) {
    const p = pos.get(n.name);
    if (!p) continue;
    const rn = R[n.tier] ?? 28;
    const nx = Math.max(r.x - r.w / 2, Math.min(p.x, r.x + r.w / 2));
    const ny = Math.max(r.y - r.h / 2, Math.min(p.y, r.y + r.h / 2));
    if (Math.hypot(nx - p.x, ny - p.y) < rn + 6) return true;
  }
  return false;
}

function relationshipSVG(parsed, meta, opts = {}) {
  const R = { 1: 54, 2: 42, 3: 28 };
  // 人少用「主角居中」的环形图，人多（≥9）换簇状：每簇一个核心人物带一圈关系最近的人
  const forced = opts.layout === 'ring' || opts.layout === 'cluster' ? opts.layout : null;
  const useCluster = forced ? forced === 'cluster' : parsed.nodes.length >= 9;
  let W;
  let H;
  let pos;
  let clusters = [];
  let clusterOf = null;
  if (useCluster) {
    const layout = clusterLayout(parsed);
    ({ W, H, pos, clusters } = layout);
    clusterOf = new Map();
    clusters.forEach((c, ci) => { clusterOf.set(c.name, ci); c.members.forEach((m) => clusterOf.set(m, ci)); });
  } else {
    const geo = relationshipGeometry(parsed);
    const margin = 200;
    W = Math.max(720, Math.min(1400, Math.round((geo.outerR + margin) * 2)));
    H = Math.max(520, Math.min(1200, Math.round((geo.outerR * 0.94 + margin) * 2)));
    pos = layoutNodes(parsed, geo, W / 2, H / 2 + 26);
  }
  const parts = [];
  parts.push(`<defs>
    <marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>
    <filter id="sh" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity=".45"/></filter>
    <style>
      g.edge { cursor: default }
      g.edge:hover rect { fill-opacity: 1; stroke-opacity: .85 }
    </style>
  </defs>`);

  const geoms = parsed.edges.map((e, i) => {
    const a = parsed.nodes.find((n) => n.name === e.a);
    const b = parsed.nodes.find((n) => n.name === e.b);
    const dist = Math.hypot(pos.get(e.b).x - pos.get(e.a).x, pos.get(e.b).y - pos.get(e.a).y);
    const bow = (i % 2 ? -1 : 1) * Math.min(26 + (i % 3) * 10, dist * 0.14);
    return edgeGeom(pos.get(e.a), pos.get(e.b), R[a.tier], R[b.tier], bow);
  });

  parsed.edges.forEach((e, i) => {
    const g = geoms[i];
    const s = REL[e.kind];
    const cross = clusterOf && clusterOf.has(e.a) && clusterOf.has(e.b) && clusterOf.get(e.a) !== clusterOf.get(e.b);
    parts.push(`<path d="M ${fmt(g.x1)} ${fmt(g.y1)} Q ${fmt(g.cx)} ${fmt(g.cy)} ${fmt(g.x2)} ${fmt(g.y2)}"
      fill="none" stroke="${s.stroke}" stroke-width="${s.width}" stroke-linecap="round"
      ${cross ? 'stroke-opacity=".38"' : ''}
      ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} marker-end="url(#arw)"/>`);
    if (e.kind === 'foe') {
      const m = quadAt(g, 0.5);
      const k = 6;
      parts.push(`<g stroke="${s.stroke}" stroke-width="2" stroke-linecap="round">
        <line x1="${fmt(m.x - k)}" y1="${fmt(m.y - k)}" x2="${fmt(m.x + k)}" y2="${fmt(m.y + k)}"/>
        <line x1="${fmt(m.x - k)}" y1="${fmt(m.y + k)}" x2="${fmt(m.x + k)}" y2="${fmt(m.y - k)}"/></g>`);
    }
  });

  // 标签：沿弧线找不撞节点、不撞已放标签的位置；被推离时画引线
  const placed = [];
  parsed.edges.forEach((e, i) => {
    const g = geoms[i];
    // 跨簇的连线只画线不摆字（悬停仍可看标签），否则 17 人的图会被说明文字埋掉
    if (clusterOf && clusterOf.has(e.a) && clusterOf.has(e.b) && clusterOf.get(e.a) !== clusterOf.get(e.b)) return;
    const s = REL[e.kind];
    const text = REL[e.kind]?.label || '';
    const tip = opts.clean ? '' : (e.label || '');
    // 两行：上行「关系」，下行「张力」；比一行 20 多字更容易塞进窄缝
    const wrap = (l) => {
      if (l.length <= 14) return [l];
      const m = l.match(/^(.{4,14})[，、；]/);
      return m ? [m[1], l.slice(m[0].length)] : [l];
    };
    const lines = (text.includes(' / ') ? text.split(' / ').slice(0, 2) : [text])
      .flatMap(wrap)
      .slice(0, 3);
    const w = Math.min(240, Math.max(...lines.map((l) => l.length)) * 11.4 + 14);
    const h = lines.length * 15 + 9;
    let best = null;
    let bestOff = 0;
    let bestPt = null;
    for (const off of [0, 16, -16, 34, -34, 52, -52, 72, -72, 92, -92]) {
      for (const t of [0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68]) {
        const m = quadAt(g, t);
        const len = Math.hypot(m.dx, m.dy) || 1;
        const nx = -m.dy / len;
        const ny = m.dx / len;
        const rect = { x: m.x + nx * off, y: m.y + ny * off, w, h };
        if (hitRect(rect, placed) || hitNode(rect, pos, parsed.nodes, R)) continue;
        best = rect;
        bestOff = off;
        bestPt = { x: m.x, y: m.y };
        break;
      }
      if (best) break;
    }
    if (!best) {
      const m = quadAt(g, 0.5);
      best = { x: m.x, y: m.y, w, h };
      bestPt = { x: m.x, y: m.y };
    }
    // 不管怎么推，都别让标签跑出画布
    best.x = Math.min(W - best.w / 2 - 10, Math.max(best.w / 2 + 10, best.x));
    best.y = Math.min(H - best.h / 2 - 10, Math.max(best.h / 2 + 10, best.y));
    // 兜底：候选位全撞时，从画布中心向外推，直到既不压节点也不压已有标签
    let guard = 0;
    while (guard++ < 24 && best && (hitNode(best, pos, parsed.nodes, R) || hitRect(best, placed))) {
      const ux = (best.x - W / 2) / (Math.hypot(best.x - W / 2, best.y - H / 2) || 1);
      const uy = (best.y - H / 2) / (Math.hypot(best.x - W / 2, best.y - H / 2) || 1);
      best = { ...best, x: best.x + ux * 26, y: best.y + uy * 26 };
      if (best.x < 12 || best.y < 12 || best.x > W - 12 || best.y > H - 12) break;
    }
    placed.push(best);
    if (bestOff !== 0) {
      parts.push(`<line x1="${fmt(bestPt.x)}" y1="${fmt(bestPt.y)}" x2="${fmt(best.x)}" y2="${fmt(best.y)}"
        stroke="${s.stroke}" stroke-width="1" stroke-opacity=".55" stroke-dasharray="2 3"/>`);
    }
    const clip = (l) => (l.length > 22 ? `${l.slice(0, 21)}…` : l);
    const ty = best.y - ((lines.length - 1) * 15) / 2 + 4;
    const tspans = lines
      .map((l, li) => `<tspan x="${fmt(best.x)}" y="${fmt(ty + li * 15)}">${esc(clip(l))}</tspan>`)
      .join('');
    parts.push(`<g class="edge" data-a="${esc(e.a)}" data-b="${esc(e.b)}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${tip ? `<title>${esc(tip)}</title>` : ''}<rect x="${fmt(best.x - w / 2)}" y="${fmt(best.y - h / 2)}" width="${fmt(w)}" height="${h}" rx="7"
      fill="#12141a" fill-opacity=".94" stroke="${s.stroke}" stroke-opacity=".35"/>
      <text text-anchor="middle" font-family='${FONT}' font-size="11.5" fill="${s.text}">${tspans}</text></g>`);
  });

  for (const n of parsed.nodes) {
    const p = pos.get(n.name);
    const r = R[n.tier];
    const main = n.tier === 1;
    const nameSize = main ? 17 : n.tier === 2 ? 15 : 13;
    const shown = n.name.length > 4 ? n.name.slice(0, 4) : n.name;
    parts.push(`<g class="node" data-node="${esc(n.name)}" filter="url(#sh)">
      <circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${r}" fill="#1c2029"
        stroke="${main ? '#f0d48a' : '#4a5260'}" stroke-width="${main ? 2.6 : 1.6}"/>
      <text x="${fmt(p.x)}" y="${fmt(p.y + (n.sub ? -2 : nameSize / 3.2))}" text-anchor="middle"
        font-family='${FONT}' font-size="${nameSize}" fill="${main ? '#f4e6bf' : INK}" font-weight="600">${esc(shown)}</text>
      ${n.sub && r >= 40 ? `<text x="${fmt(p.x)}" y="${fmt(p.y + 16)}" text-anchor="middle" font-family='${FONT}'
        font-size="10.5" fill="${MUTE}">${esc(n.sub.length > 9 ? `${n.sub.slice(0, 8)}…` : n.sub)}</text>` : ''}
    </g>`);
  }

  const legend = Object.values(REL)
    .map((s, i) => {
      const x = 34 + i * 96;
      return `<line x1="${x}" y1="72" x2="${x + 22}" y2="72" stroke="${s.stroke}" stroke-width="${s.width}"
        stroke-linecap="round" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/>
        <text x="${x + 28}" y="76" font-family='${FONT}' font-size="11" fill="${MUTE}">${s.label}</text>`;
    })
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <text x="34" y="40" font-family='${FONT}' font-size="14" fill="${INK}" font-weight="600">${esc(meta.title || '人物关系图')}</text>
  <text x="34" y="57" font-family='${FONT}' font-size="11" fill="${MUTE}">圈越大越重要｜共 ${parsed.nodes.length} 人 · ${parsed.edges.length} 条关系</text>
  ${legend}
  ${parts.join('\n  ')}
</svg>`;
}

/* ---------------------------------------------------------------- 情节折线图 */

function buildSeries(tbl) {
  const iChapter = tbl.header.findIndex((h) => /^章|章节|章号/.test(h.replace(/\s/g, '')));
  if (iChapter < 0) return null;
  const series = tbl.header
    .map((h, i) => ({ name: h, i }))
    .filter((s) => s.i !== iChapter && !/^[-:]+$/.test(s.name));
  const rows = [];
  for (const row of tbl.rows) {
    const raw = (row[iChapter] || '').match(/\d+/);
    if (!raw) continue;
    const values = {};
    let any = false;
    for (const s of series) {
      const v = Number(String(row[s.i] || '').replace(/[^\d.]/g, ''));
      if (Number.isFinite(v) && String(row[s.i] || '').trim() !== '') {
        values[s.name] = v;
        any = true;
      }
    }
    if (any) rows.push({ chapter: Number(raw[0]), values });
  }
  if (!rows.length) return null;
  return { series: series.map((s) => s.name), rows };
}

const PALETTE = ['#e0b84c', '#6d9bd6', '#c0504d', '#7bbf8a', '#c58fd0', '#d98f5a', '#5fbdc0', '#a8a04d'];

/** Fritsch–Carlson 单调三次插值：曲线不越过相邻数据点，不会冲出 0–上限 */
function monotonePath(pts) {
  const n = pts.length;
  if (n === 1) return `M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  const dx = pts[1].x - pts[0].x;
  const d = pts.map((p, i) => (i === 0 || i === n - 1 ? 0 : (pts[i + 1].y - pts[i].y) / dx));
  const m = new Array(n).fill(0);
  m[0] = d[1];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      m[i] = (3 * d[i] * a) / h;
      m[i + 1] = (3 * d[i] * b) / h;
    }
  }
  let out = `M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    out += ` C ${fmt(pts[i].x + dx / 3)} ${fmt(pts[i].y + (m[i] * dx) / 3)}, ${fmt(pts[i + 1].x - dx / 3)} ${fmt(pts[i + 1].y - (m[i + 1] * dx) / 3)}, ${fmt(pts[i + 1].x)} ${fmt(pts[i + 1].y)}`;
  }
  return out;
}

function plotSVG(data, meta) {
  const L = 60;
  const Rm = 34;
  const B = 52;
  const chapters = data.rows.map((r) => r.chapter);
  // 章越多、线越多，画布越大；上限之内放不下就等比缩放，点永远对得齐
  // 每章留 60px：正文长到 100 章时画布约 6000px，靠画框内滚动看，不把字压小
  const W = Math.max(720, Math.min(6000, Math.round(360 + 60 * chapters.length)));
  // 图例按实际文字宽度折行，不再用固定 x=470：故事线多了会挤到画框外
  const legend = [];
  let row = [];
  let rowW = 0;
  const avail = W - 34 * 2;
  for (const name of data.series) {
    const iw = 26 + name.length * 11.5 + 18;
    if (row.length && rowW + iw > avail) { legend.push(row); row = []; rowW = 0; }
    row.push({ name, x: rowW, w: iw });
    rowW += iw;
  }
  if (row.length) legend.push(row);
  const legendTop = 100; // 标题 40、说明 58、章数 74，图例从 100 起
  const legendRowH = 19;
  const T = Math.max(120, legendTop + legend.length * legendRowH + 14);
  const H = Math.max(420, Math.min(900, Math.round(T + 250 + 26 * data.series.length)));
  const allValues = data.rows.flatMap((r) => Object.values(r.values));
  const maxV = Math.max(5, Math.ceil(Math.max(...allValues, 0)));
  const X = (i) => L + (i * (W - L - Rm)) / Math.max(chapters.length - 1, 1);
  const Y = (v) => H - B - (v / maxV) * (H - B - T);
  const parts = [];
  for (let v = 0; v <= maxV; v++) {
    parts.push(`<line x1="${L}" y1="${fmt(Y(v))}" x2="${W - Rm}" y2="${fmt(Y(v))}" stroke="${GRID}" stroke-width="1"/>
      <text x="${L - 12}" y="${fmt(Y(v) + 4)}" text-anchor="end" font-family='${FONT}' font-size="11" fill="${MUTE}">${v}</text>`);
  }
  // 章多时横轴会挤：按可用宽度抽稀，保证标签之间至少 26px，首尾必显示
  const spacing = (W - L - Rm) / Math.max(chapters.length - 1, 1);
  const labelStep = Math.max(1, Math.ceil(26 / Math.max(spacing, 1)));
  chapters.forEach((c, i) => {
    if (i % labelStep !== 0 && i !== chapters.length - 1) return;
    // 章号本身是「溯源」入口：面板里点它会展开这一章的分数依据
    parts.push(`<text class="chapter-hit" data-chapter="${esc(String(c))}" x="${fmt(X(i))}" y="${H - B + 22}" text-anchor="middle" font-family='${FONT}' font-size="11" fill="${MUTE}" style="cursor:pointer">${c}</text>`);
  });
  parts.push(`<text x="${L}" y="${H - 14}" font-family='${FONT}' font-size="11" fill="${MUTE}">章</text>`);

  const seen = new Map(); // 两条线数值完全相同时会互相盖住：后画的改成虚线并微微错开
  data.series.forEach((name, si) => {
    const color = PALETTE[si % PALETTE.length];
    const raw = data.rows.map((r) => r.values[name]);
    const print = JSON.stringify(raw);
    const dup = seen.has(print);
    const dupIndex = dup ? seen.get(print) + 1 : 0;
    if (!dup) seen.set(print, 0);
    const dy = dup ? (dupIndex % 2 ? 1 : -1) * (H - B - T) * 0.012 : 0;
    const pts = [];
    data.rows.forEach((r, i) => {
      if (r.values[name] === undefined) return;
      pts.push({ x: X(i), y: Y(r.values[name]) + dy });
    });
    if (!pts.length) return;
    parts.push(`<path d="${monotonePath(pts)}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"
      ${dup ? 'stroke-dasharray="7 5"' : ''}/>`);
    pts.forEach((p, i) => {
      const chapter = data.rows[i] && data.rows[i].chapter;
      parts.push(`<circle class="point-hit" data-chapter="${esc(String(chapter))}" cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="9" fill="transparent" style="cursor:pointer"/>`);
      parts.push(`<circle class="point-hit" data-chapter="${esc(String(chapter))}" cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="3.2" fill="${BG}" stroke="${color}" stroke-width="2" style="cursor:pointer"/>`);
    });
  });

  let idx = 0;
  legend.forEach((items, rowIdx) => {
    items.forEach((item) => {
      const color = PALETTE[idx % PALETTE.length];
      const x = 34 + item.x;
      const y = legendTop + rowIdx * legendRowH;
      parts.push(`<line x1="${x}" y1="${y}" x2="${x + 20}" y2="${y}" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>
        <text x="${x + 26}" y="${y + 4}" font-family='${FONT}' font-size="11" fill="${INK}">${esc(item.name)}</text>`);
      idx += 1;
    });
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <text x="34" y="40" font-family='${FONT}' font-size="14" fill="${INK}" font-weight="600">${esc(meta.title || '情节发展地图 · 故事线强度')}</text>
  <text x="34" y="58" font-family='${FONT}' font-size="11" fill="${MUTE}">每条折线一条故事线｜转折处用单调三次曲线连接｜圆圈是每章实际取值</text>
  <text x="34" y="74" font-family='${FONT}' font-size="10.5" fill="${MUTE}">共 ${chapters.length} 章 · ${data.series.length} 条线</text>
  ${parts.join('\n  ')}
</svg>`;
}


/* ------------------------------------------------- 场景节点图（阶段 11） */

/** 解析「## 场景节点」表：章｜场景｜事件｜关键人物｜标记 */
function buildScenes(table) {
  if (!table || !table.rows) return null;
  const head = (table.header || table.head || []).map((h) => h.replace(/\s/g, ''));
  const iCh = head.findIndex((h) => /^章$/.test(h));
  const iSc = head.findIndex((h) => /场景/.test(h));
  const iEv = head.findIndex((h) => /事件|发生/.test(h));
  const iWho = head.findIndex((h) => /人物/.test(h));
  const iTag = head.findIndex((h) => /标记|标签/.test(h));
  if (iCh < 0 || iEv < 0) return null;
  const rows = [];
  for (const r of table.rows) {
    const ch = parseInt(String(r[iCh] || '').replace(/[^0-9]/g, ''), 10);
    const ev = (r[iEv] || '').trim();
    if (!ch || !ev) continue;
    rows.push({
      chapter: ch,
      scene: iSc >= 0 ? (r[iSc] || '').trim() : '',
      event: ev,
      who: iWho >= 0 ? (r[iWho] || '').trim() : '',
      tag: iTag >= 0 ? (r[iTag] || '').trim() : '',
    });
  }
  return rows.length ? rows : null;
}

function scenesCollapsedSVG(rows, meta) {
  const W = 900;
  const chapters = [...new Set(rows.map((r) => r.chapter))];
  const rowH = 58;
  const top = 92;
  const H = Math.max(320, top + chapters.length * rowH + 24);
  const parts = [];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#12141a"/>`);
  parts.push(`<text x="34" y="38" font-family='${FONT}' font-size="17" font-weight="600" fill="#e8ecf2">${esc(meta.title || '情节发展地图 · 场景节点')}</text>`);
  parts.push(`<text x="34" y="58" font-family='${FONT}' font-size="11" fill="${MUTE}">${rows.length} 个场景超过 30，已按章折叠；展开看场景请按卷拆分或改小 range</text>`);

  chapters.forEach((ch, i) => {
    const list = rows.filter((r) => r.chapter === ch);
    const y = top + i * rowH;
    const tags = [...new Set(list.map((r) => r.tag).filter(Boolean))].join(' · ');
    const first = list[0] ? list[0].event : '';
    const turns = list.filter((r) => /转折|反转/.test(r.tag || '')).length;
    parts.push(`<rect x="34" y="${y}" width="${W - 68}" height="${rowH - 14}" rx="8" fill="#171a21" stroke="#2a2f3a"/>`);
    parts.push(`<text x="50" y="${y + 24}" font-family='${FONT}' font-size="12.5" font-weight="600" fill="#c9d2de">第 ${ch} 章 · ${list.length} 个场景${turns ? ` · ${turns} 个转折` : ''}</text>`);
    parts.push(`<text x="50" y="${y + 41}" font-family='${FONT}' font-size="11" fill="${MUTE}">${esc(`${first}${tags ? ` ｜ ${tags}` : ''}`.slice(0, 62))}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${parts.join('\n')}
</svg>`;
}

function scenesSVG(rows, meta) {
  if (rows.length > 30) return scenesCollapsedSVG(rows, meta);
  const W = 900;
  const top = 74;
  const boxH = 80;
  const gapY = 26;
  const chapterGap = 40;
  const chapters = [...new Set(rows.map((r) => r.chapter))];
  let y = top;
  const layout = [];
  for (const ch of chapters) {
    const list = rows.filter((r) => r.chapter === ch);
    layout.push({ kind: 'chapter', chapter: ch, y });
    y += 34;
    list.forEach((r, i) => {
      layout.push({ kind: 'scene', row: r, y, side: i % 2 === 0 ? -1 : 1 });
      y += boxH + gapY;
    });
    y += chapterGap - gapY;
  }
  const H = Math.max(420, y + 30);

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#12141a"/>`);
  parts.push(`<text x="34" y="38" font-family='${FONT}' font-size="17" font-weight="600" fill="#e8ecf2">${meta.title || '情节发展地图 · 场景节点'}</text>`);
  parts.push(`<text x="34" y="58" font-family='${FONT}' font-size="11" fill="${MUTE}">按章自上而下；同一章内按场景顺序；红线为转折，黄线为埋点，青线为回收点</text>`);

  const cx = W / 2;
  // 主干
  parts.push(`<line x1="${cx}" y1="${top - 12}" x2="${cx}" y2="${H - 24}" stroke="#2a2f3a" stroke-width="2"/>`);

  layout.forEach((item, idx) => {
    if (item.kind === 'chapter') {
      parts.push(`<circle cx="${cx}" cy="${item.y + 8}" r="9" fill="#12141a" stroke="#7f8ea3" stroke-width="1.6"/>`);
      parts.push(`<text x="${cx + 22}" y="${item.y + 13}" font-family='${FONT}' font-size="12.5" font-weight="600" fill="#c9d2de">第 ${item.chapter} 章</text>`);
      return;
    }
    const r = item.row;
    const w = 330;
    const x = item.side < 0 ? cx - 40 - w : cx + 40;
    const tagColor = /回收|收/.test(r.tag) ? '#4f9d8b' : /埋/.test(r.tag) ? '#e0b84c' : /转折|反转/.test(r.tag) ? '#c0504d' : null;
    parts.push(`<line x1="${cx}" y1="${item.y + boxH / 2}" x2="${item.side < 0 ? x + w : x}" y2="${item.y + boxH / 2}" stroke="#2a2f3a" stroke-width="1.4"/>`);
    parts.push(`<rect x="${x}" y="${item.y}" width="${w}" height="${boxH}" rx="8" fill="#171a21" stroke="${tagColor || '#2a2f3a'}" stroke-width="${tagColor ? 1.6 : 1}"/>`);
    const wrap = (txt, n) => {
      const out = [];
      let rest = txt;
      while (rest.length > n && out.length < 2) {
        let cut = n;
        for (let k = n; k > n - 8 && k > 0; k--) if (/[，。；、」]/.test(rest[k - 1])) { cut = k; break; }
        if (/[」』）]/.test(rest[cut] || '')) cut += 1;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      if (rest) out.push(rest);
      return out.slice(0, 2);
    };
    // 徽章占掉右上角：先按徽章宽度算出正文一行能用几个字，避免文字钻到徽章底下
    const cw = r.tag ? Math.min(150, r.tag.length * 8.6 + 18) : 0;
    const wrapW = r.tag ? Math.max(10, Math.floor((w - 28 - cw - 10) / 12.4)) : 24;
    // 第一行要让开右上角徽章，第二行起可以整行到底
    const cut1 = (txt, n) => {
      if (txt.length <= n) return [txt, ''];
      let cut = n;
      for (let k = n; k > n - 8 && k > 0; k--) if (/[，。；、」]/.test(txt[k - 1])) { cut = k; break; }
      if (/[」』）]/.test(txt[cut] || '')) cut += 1;
      return [txt.slice(0, cut), txt.slice(cut)];
    };
    const [l1, r1] = cut1(r.event, wrapW);
    const lines = [l1, ...(r1 ? wrap(r1, 24) : [])].slice(0, 3);
    lines.forEach((ln, k) => {
      parts.push(`<text x="${x + 14}" y="${item.y + 22 + k * 16}" font-family='${FONT}' font-size="12.5" fill="#e8ecf2">${esc(ln)}${k === lines.length - 1 && r.event.length > lines.join('').length ? '…' : ''}</text>`);
    });
    // 标记做成右上角小徽章：不再和人物名挤一行，避免「转折」被卡框切掉
    if (r.tag) {
      const chipX = x + w - 12 - cw;
      parts.push(`<rect x="${fmt(chipX)}" y="${item.y + 9}" width="${fmt(cw)}" height="17" rx="8.5"
        fill="#171a21" stroke="${tagColor || '#3a4150'}" stroke-opacity=".7"/>`);
      parts.push(`<text x="${fmt(chipX + cw / 2)}" y="${item.y + 21}" text-anchor="middle" font-family='${FONT}'
        font-size="10" fill="${tagColor || MUTE}">${esc(r.tag)}</text>`);
    }
    const whoMax = 22;
    const who = r.who && r.who.length > whoMax ? `${r.who.slice(0, whoMax - 1)}…` : (r.who || '');
    if (who) {
      parts.push(`<text x="${x + 14}" y="${item.y + 30 + lines.length * 16}" font-family='${FONT}' font-size="10.5" fill="${MUTE}">${esc(who)}</text>`);
    }
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${FONT}'>
${parts.join('\n')}
</svg>
`;
}

/* ---------------------------------------------------------------- 主流程 */

function parseVolumes(text) {
  const t = tables(text).find((tb) => (tb.header || []).some((c) => /章节范围/.test(c)));
  if (!t) return [];
  const iVol = t.header.findIndex((c) => /^卷$/.test(String(c).trim()));
  const iTitle = t.header.findIndex((c) => /标题/.test(c));
  const iRange = t.header.findIndex((c) => /章节范围/.test(c));
  const out = [];
  (t.rows || []).forEach((row, idx) => {
    const raw = String(row[iRange] || '');
    const m = raw.match(/(\d+)\s*[–—\-~～至]\s*(\d+)/) || raw.match(/(\d+)/);
    if (!m) return;
    const from = Number(m[1]);
    const to = Number(m[2] || m[1]);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return;
    out.push({ vol: idx + 1, label: `卷${row[iVol] || idx + 1}${row[iTitle] ? ` ${row[iTitle]}` : ''}`, from, to });
  });
  return out;
}

function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('用法：node render-graph.mjs [--project novel-project] [--out <目录>] [--check] [--json]');
    process.exit(0);
  }
  const project = resolve(opts.project);
  if (!existsSync(project) || !statSync(project).isDirectory()) {
    console.error(`读不到项目目录：${project}`);
    process.exit(2);
  }
  const bible = join(project, 'bible');
  const outDir = resolve(opts.out || bible);

  const relFile = join(bible, 'relationship-map.md');
  const plotFile = join(bible, 'plot-map.md');
  const relText = readText(relFile);
  const plotText = readText(plotFile);
  if (!relText && !plotText) {
    console.error(`两张图谱都读不到：${relFile} / ${plotFile}\n先按 novel-graph 技能写出这两个文件，再生成图。`);
    process.exit(2);
  }

  const result = { ok: true, warnings: [], files: [], relations: null, plot: null };
  const warn = (m) => result.warnings.push(m);

  if (relText) {
    const ts = tables(relText);
    const relTable = findTable(ts, (h) => h.some((c) => /人物\s*A/.test(c)) && h.some((c) => /人物\s*B/.test(c)));
    const tierTable = findTable(ts, (h) => h.some((c) => /人物|姓名/.test(c)) && h.some((c) => /档位|级别|重要/.test(c)));
    if (!relTable) {
      warn('relationship-map.md 里没找到「人物 A｜人物 B」关系表，跳过关系图');
    } else {
      const parsed = buildRelations(relTable);
      if (!parsed || !parsed.nodes.length || !parsed.edges.length) {
        warn('关系表是空的（没有有效的 A—B 行），跳过关系图');
      } else {
        withTiers(parsed, tierTable);
        if (parsed.nodes.length > 30) warn(`关系图有 ${parsed.nodes.length} 人，超过 30：技能要求拆成主图 + 附表`);
        else if (parsed.nodes.length > 15) warn(`关系图有 ${parsed.nodes.length} 人，超过 15：建议只画主要人物，其余进文字表`);
        const svg = relationshipSVG(parsed, { title: opts.clean ? '人物关系图（无剧透版）' : '人物关系图' }, { clean: opts.clean, layout: opts.layout });
        const file = join(outDir, opts.clean ? 'relationship-map-clean.svg' : 'relationship-map.svg');
        if (!opts.check) writeFileSync(file, svg);
        const clean = join(outDir, 'relationship-map-clean.svg');
        if (!opts.check) writeFileSync(clean, relationshipSVG(parsed, { title: '人物关系图（无剧透版）' }, { clean: true, layout: opts.layout }));
        result.relations = { nodes: parsed.nodes.length, edges: parsed.edges.length, file: relative(process.cwd(), file) };
        if (!opts.check) result.files.push(result.relations.file);
      }
    }
  }

  if (plotText) {
    const ts = tables(plotText);
    const series = (findTable(ts, (h) => /^章/.test(h[0] || '')) && buildSeries(findTable(ts, (h) => /^章/.test(h[0] || '')))) || null;
    if (!series) {
      warn('plot-map.md 里没找到「章｜故事线…」强度表，跳过情节图（表头第一列必须是「章」）');
    } else {
      const sceneTable = findTable(ts, (h) => h.some((c) => /^章$/.test(c.replace(/\s/g, ''))) && h.some((c) => /事件|发生/.test(c)));
      const scenes = sceneTable ? buildScenes(sceneTable) : null;
      // 画布 6000px 上限 ≈ 94 章：超过就按卷切图，别把 100 章压进一屏
      const MAX_CHAPTERS = 94;
      const outlineText = readText(join(bible, 'outline.md'));
      const volumes = outlineText ? parseVolumes(outlineText) : [];
      const split = series.rows.length > MAX_CHAPTERS && volumes.length > 0;
      if (series.rows.length > MAX_CHAPTERS && !volumes.length) {
        warn(`情节图有 ${series.rows.length} 章，超过 ${MAX_CHAPTERS} 章上限，但 outline.md 里没有可分卷的章节范围：仍按 6000px 压缩`);
      }
      if (split) {
        const vols = [];
        for (const v of volumes) {
          const rows = series.rows.filter((r) => r.chapter >= v.from && r.chapter <= v.to);
          if (!rows.length) continue;
          const sub = { series: series.series, rows };
          const file = join(outDir, `plot-map-vol-${String(v.vol).padStart(2, '0')}.svg`);
          if (!opts.check) writeFileSync(file, plotSVG(sub, { title: `情节发展地图 · 故事线强度（${v.label}）` }));
          const rel = relative(process.cwd(), file);
          vols.push({ vol: v.vol, label: v.label, from: v.from, to: v.to, chapters: rows.length, file: rel });
          if (!opts.check) result.files.push(rel);
        }
        if (!vols.length) warn('按卷切图失败：分卷范围与强度表的章号对不上');
        result.plot = { chapters: series.rows.length, series: series.series.length, split: true, volumes: vols, file: null };
      } else {
        const svg = plotSVG(series, { title: '情节发展地图 · 故事线强度' });
        const file = join(outDir, 'plot-map.svg');
        if (!opts.check) writeFileSync(file, svg);
        result.plot = { chapters: series.rows.length, series: series.series.length, file: relative(process.cwd(), file) };
        if (!opts.check) result.files.push(result.plot.file);
      }
      if (scenes) {
        const sfile = join(outDir, 'plot-map-scenes.svg');
        if (!opts.check) writeFileSync(sfile, scenesSVG(scenes, { title: '情节发展地图 · 场景节点' }));
        result.scenes = { rows: scenes.length, collapsed: scenes.length > 30, file: relative(process.cwd(), sfile) };
        if (!opts.check) result.files.push(result.scenes.file);
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.relations) {
      console.log(`✔ 关系图：${result.relations.nodes} 人 / ${result.relations.edges} 条关系 → ${result.relations.file}`);
    }
    if (result.plot) {
      if (result.plot.split) {
        console.log(`✔ 情节图：${result.plot.chapters} 章 / ${result.plot.series} 条故事线 → 按卷切成 ${result.plot.volumes.length} 张`);
        for (const v of result.plot.volumes) console.log(`  · ${v.label}（第 ${v.from}–${v.to} 章，${v.chapters} 章）→ ${v.file}`);
      } else {
        console.log(`✔ 情节图：${result.plot.chapters} 章 / ${result.plot.series} 条故事线 → ${result.plot.file}`);
      }
    }
    if (result.scenes) {
      console.log(`✔ 场景节点图：${result.scenes.rows} 个场景${result.scenes.collapsed ? '（超过 30，按章折叠）' : ''} → ${result.scenes.file}`);
    }
    for (const w of result.warnings) console.log(`! ${w}`);
    if (!result.files.length && !opts.check) console.log('没有生成任何图。');
  }
  process.exit(result.warnings.length ? 1 : 0);
}

main();
