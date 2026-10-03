// 共用卡片庫的每日產生腳本（由 .github/workflows/library.yml 執行）
//
// 做法：在 repo 目錄起一個靜態伺服器，用無頭 Chromium 開啟 index.html#kx-build，
// 並在載入前注入管理者的 Gemini 金鑰；網頁會公開 window.__kxBuild，
// 讓這裡直接呼叫網站本身的準確度管線（makePoint：找來源 → 摘要 → 分類校正）與出題（askQuestions）。
// 產卡邏輯只有 index.html 這一份。
//
// 卡片庫格式（v2）：依「大領域／難度／月份」切檔，使用者只下載自己領域與難度的檔案。
//   library/index.json              { v:2, updated, total, cells:{ "math/master":["2026-10", …] } }
//   library/math/master/2026-10.json { v:2, cell, month, cards:[…] }
//   library/removed.json            { v:1, items:{ 卡片id:{ t, issue } } }
// 路徑代碼（CAT_SLUG、LEVEL_SLUG）直接從 index.html 讀取，對照表只有一份。
//
// 環境變數：
//   GEMINI_API_KEY     管理者的金鑰（repo Secrets）
//   GITHUB_TOKEN       Actions 內建權杖，用來讀取與關閉「下架」Issue
//   GITHUB_REPOSITORY  例如 frogjason0214/Smarter.gemini（Actions 自動提供）
//   KX_COUNT           只產生幾張（測試用）；0 或未設定 = 16 個大領域 × 5 個難度全部

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const LIB = path.join(ROOT, 'library');
const KEY = (process.env.GEMINI_API_KEY || '').trim();
const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_REPOSITORY || '';
const COUNT = Number(process.env.KX_COUNT || 0) || 0;
const MAX_REQUESTS = 450;      // 免費額度約每天 500 次，保留少量餘裕給重試與備援
const TARGET = 10;             // 每個「大領域＋難度」的最低庫存；不足的格子每天輪流多產生，補齊後回到每格每天 1 張
const TIME_LIMIT_MS = 150 * 60e3;   // 產生階段最多跑多久（排程上限 180 分鐘，保留提交時間）
const GAP_MS = 5000;           // 每次呼叫後等待，避免超過每分鐘請求上限
const BATCH = 5;               // 每幾張卡一起出題（一次請求）
const WARN_BYTES = 500 * 1024 * 1024;   // 卡片庫超過 500 MB 時提醒討論保存期限
const TAKEDOWN_LABEL = '下架';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJSON = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, JSON.stringify(data) + '\n'); };
const taipeiDate = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- 從 index.html 讀取路徑代碼對照表 ----------
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const readTable = name => {
  const m = new RegExp(`const ${name} = (\\{[\\s\\S]*?\\});`).exec(html);
  if (!m) throw new Error(`index.html 裡找不到 ${name}`);
  return new Function(`return ${m[1]}`)();
};
const CAT_SLUG = readTable('CAT_SLUG'), LEVEL_SLUG = readTable('LEVEL_SLUG');
const cellOf = (cat, level) => CAT_SLUG[cat] && LEVEL_SLUG[level] ? `${CAT_SLUG[cat]}/${LEVEL_SLUG[level]}` : '';
const monthOf = id => { const m = /^L(\d{4})(\d{2})\d{2}-\d+$/.exec(id || ''); return m ? `${m[1]}-${m[2]}` : ''; };

// ---------- 讀入現有卡片庫 ----------
fs.mkdirSync(LIB, { recursive:true });
const indexFile = path.join(LIB, 'index.json'), removedFile = path.join(LIB, 'removed.json');
let index = readJSON(indexFile, { v:2, updated:null, cells:{} });
const removed = readJSON(removedFile, { v:1, items:{} });
const files = {};      // "math/master/2026-10" → { v:2, cell, month, cards }
const dirty = new Set();
const loadFile = (cell, month) => (files[`${cell}/${month}`] ||= readJSON(path.join(LIB, cell, `${month}.json`), { v:2, cell, month, cards:[] }));
const addCard = card => {
  const cell = cellOf(card.cat, card.level), month = monthOf(card.id);
  if (!cell || !month) return false;
  loadFile(cell, month).cards.push(card); dirty.add(`${cell}/${month}`);
  return true;
};

// 舊格式（v1：按日期切檔）自動搬到新格式，卡片 ID 不變
if (index.v === 1){
  for (const d of index.days || []){
    const old = path.join(LIB, d.file);
    for (const c of readJSON(old, { cards:[] }).cards) addCard(c);
    fs.rmSync(old, { force:true });
    log('已搬移舊格式檔案', d.file);
  }
  index = { v:2, updated:index.updated, cells:{} };
}
index.cells ||= {};
for (const [cell, months] of Object.entries(index.cells)) for (const m of months) loadFile(cell, m);
const seenKeys = new Set(Object.values(files).flatMap(f => f.cards.map(c => c.srcKey)).filter(Boolean));

// ---------- 處理下架：管理者在 Issue 加上「下架」標籤 ----------
async function gh(method, url, body){
  const res = await fetch(`https://api.github.com/repos/${REPO}${url}`, {
    method, headers:{ Authorization:`Bearer ${TOKEN}`, Accept:'application/vnd.github+json', 'Content-Type':'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`GitHub API ${method} ${url} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}
async function takedowns(){
  if (!TOKEN || !REPO){ log('沒有 GITHUB_TOKEN，略過下架處理'); return; }
  const issues = await gh('GET', `/issues?state=open&per_page=100&labels=${encodeURIComponent(TAKEDOWN_LABEL)}`);
  for (const issue of issues.filter(i => !i.pull_request)){
    const id = (/L\d{8}-\d{1,4}/.exec(`${issue.title}\n${issue.body || ''}`) || [])[0];
    if (!id){
      await gh('POST', `/issues/${issue.number}/comments`, { body:'找不到卡片 ID（格式如 L20261005-07），無法自動下架。請補上卡片 ID 後重新加上「下架」標籤。' });
      await gh('DELETE', `/issues/${issue.number}/labels/${encodeURIComponent(TAKEDOWN_LABEL)}`);
      continue;
    }
    // 卡片 ID 只含日期，找出同月份的所有格子逐一移除
    const month = monthOf(id);
    for (const [key, f] of Object.entries(files)){
      if (f.month !== month || !f.cards.some(c => c.id === id)) continue;
      f.cards = f.cards.filter(c => c.id !== id); dirty.add(key);
    }
    removed.items[id] = { t:Date.now(), issue:issue.number };
    await gh('POST', `/issues/${issue.number}/comments`, { body:`已從共用卡片庫下架 ${id}。已讀過這張卡片的使用者，網站下次載入時會看到「已下架」標示，這張卡也不會再出現在測驗中。` });
    await gh('PATCH', `/issues/${issue.number}`, { state:'closed', state_reason:'completed' });
    log('已下架', id, `#${issue.number}`);
  }
}

// ---------- 產生新卡片 ----------
function serve(){
  const types = { '.html':'text/html; charset=utf-8', '.json':'application/json', '.js':'text/javascript' };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){ res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

async function generate(){
  if (!KEY) throw new Error('讀不到 GEMINI_API_KEY。請確認 repo 的 Settings → Secrets and variables → Actions 的「Secrets」分頁（不是 Variables）有名稱完全相同的 GEMINI_API_KEY。');
  const server = await serve();
  const browser = await chromium.launch();
  try{
    const page = await browser.newPage();
    let requests = 0;
    page.on('request', r => { if (r.url().includes('generativelanguage.googleapis.com')) requests++; });
    page.on('pageerror', e => log('網頁錯誤：', e.message));
    await page.addInitScript(key => { window.__KX_BUILD__ = { key }; }, KEY);
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html#kx-build`);
    await page.waitForFunction(() => window.__kxBuild, null, { timeout:60000 });
    const { FIELDS, LEVELS } = await page.evaluate(() => ({ FIELDS:window.__kxBuild.FIELDS, LEVELS:window.__kxBuild.LEVELS }));

    // 今天的流水號：接續今天已產生的卡（同一天重跑時不重複）
    const date = taipeiDate(), prefix = `L${date.replace(/-/g, '')}-`;
    let seq = Object.values(files).flatMap(f => f.cards).filter(c => String(c.id).startsWith(prefix))
      .reduce((m, c) => Math.max(m, Number(String(c.id).split('-')[1]) || 0), 0);
    // 產生順序：第一輪每格 1 張（每天的固定產量）；之後只輪流替庫存不到 TARGET 張的格子補，每輪每格 1 張，
    // 直到全部達標、用到請求上限或時間上限為止。手動測試（KX_COUNT > 0）只跑指定張數，不回補。
    const all = Object.keys(FIELDS).flatMap(cat => LEVELS.map(lv => ({ cat, lv, key:cellOf(cat, lv) })));
    const stock = {};
    for (const f of Object.values(files)) stock[f.cell] = (stock[f.cell] || 0) + f.cards.length;
    const failures = {};
    const startedAt = Date.now();
    const rounds = function* (){
      if (COUNT > 0){ yield* shuffle(all).slice(0, COUNT); return; }
      yield* shuffle(all);
      for (;;){
        const short = all.filter(c => (stock[c.key] || 0) < TARGET && (failures[c.key] || 0) < 2);
        if (!short.length) return;
        yield* shuffle(short);
      }
    };
    const low = all.filter(c => (stock[c.key] || 0) < TARGET).length;
    log(`開始產生 ${date}：${COUNT > 0 ? `測試 ${COUNT} 張` : `每格 1 張，另有 ${low} 格庫存不到 ${TARGET} 張，會輪流回補`}`);

    const fresh = [];
    let pending = [];
    // 每 BATCH 張卡出一次題，題目存進卡片，使用者測驗時就不必再呼叫 Gemini
    const askBatch = async () => {
      if (!pending.length) return;
      const batch = pending; pending = [];
      const r = await page.evaluate(cards => window.__kxBuild.questions(cards), batch.map(c => ({ id:c.id, title:c.title, body:c.body })));
      await sleep(GAP_MS);
      if (r.error){ log('出題失敗：', r.error); return; }
      for (const q of r.items){
        const card = batch.find(c => c.id === q.id);
        if (card) card.questions = [{ q:q.q, options:q.options, answer:q.answer, explain:q.explain }];
      }
    };
    for (const { cat, lv, key } of rounds()){
      // 預留這一張卡與它的出題請求
      if (requests + 2 > MAX_REQUESTS){ log('已達請求上限，停止產生'); break; }
      if (Date.now() - startedAt > TIME_LIMIT_MS){ log('已達時間上限，停止產生'); break; }
      const r = await page.evaluate(([cat, lv, seen]) => window.__kxBuild.makePoint(cat, lv, seen), [cat, lv, [...seenKeys]]);
      await sleep(GAP_MS);
      if (r.error){ failures[key] = (failures[key] || 0) + 1; log(`略過 ${cat}／${lv}：${r.error}`); continue; }
      const c = r.card;
      seq++;
      const card = { id:`${prefix}${String(seq).padStart(2, '0')}`,
        title:c.title, english:c.english, field:c.field, cat:c.cat, sub:c.sub, level:c.level,
        srcType:c.srcType, srcKey:c.srcKey, sources:c.sources, body:c.body, terms:c.terms, consensus:c.consensus,
        model:c.model, createdAt:Date.now(), questions:[] };
      if (!addCard(card)){ failures[key] = 9; log(`略過 ${cat}／${lv}：分類 ${c.cat}／${c.level} 沒有對應的路徑代碼`); continue; }
      if (c.srcKey) seenKeys.add(c.srcKey);
      const ck = cellOf(card.cat, card.level);
      stock[ck] = (stock[ck] || 0) + 1;
      fresh.push(card); pending.push(card);
      log(`${card.id} ${cat}／${card.sub}／${lv}：${card.title}`);
      if (pending.length >= BATCH) await askBatch();
    }
    await askBatch();
    const stillLow = all.filter(c => (stock[c.key] || 0) < TARGET).length;
    log(`完成：新增 ${fresh.length} 張，Gemini 請求 ${requests} 次${stillLow ? `；仍有 ${stillLow} 格不到 ${TARGET} 張，明天繼續回補` : '；每格都已達標'}`);
    if (!fresh.length) throw new Error('這次一張卡片都沒有產生成功，請查看上方每一格的「略過」原因。');
  } finally {
    await browser.close();
    server.close();
  }
}

// ---------- 主流程 ----------
let failed = false;
try{ await takedowns(); }catch(e){ failed = true; log('下架處理失敗：', e.message); }
try{ await generate(); }catch(e){ failed = true; log('產生失敗：', e.message); }

for (const key of dirty){
  const f = files[key];
  writeJSON(path.join(LIB, `${key}.json`), f);
  const months = new Set(index.cells[f.cell] || []);
  if (f.cards.length) months.add(f.month); else months.delete(f.month);
  if (months.size) index.cells[f.cell] = [...months].sort().reverse(); else delete index.cells[f.cell];
}
const total = Object.values(files).reduce((s, f) => s + f.cards.length, 0);
if (dirty.size){ index.updated = new Date().toISOString(); index.total = total; }
writeJSON(indexFile, index);
writeJSON(removedFile, removed);

const bytes = dir => fs.readdirSync(dir, { withFileTypes:true }).reduce((s, e) =>
  s + (e.isDirectory() ? bytes(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
const size = bytes(LIB);
log(`卡片庫共 ${total} 張、${Object.keys(index.cells).length} 格、${(size / 1048576).toFixed(1)} MB、已下架 ${Object.keys(removed.items).length} 張`);
if (size > WARN_BYTES){
  console.log(`::warning title=卡片庫超過 500 MB::目前 ${(size / 1048576).toFixed(0)} MB，請討論是否設定舊卡片的保存期限。`);
}
if (failed) process.exitCode = 1;
