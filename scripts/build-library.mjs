// 共用卡片庫的每日產生腳本（由 .github/workflows/library.yml 執行）
//
// 做法：在 repo 目錄起一個靜態伺服器，用無頭 Chromium 開啟 index.html#kx-build，
// 並在載入前注入管理者的 Gemini 金鑰；網頁會公開 window.__kxBuild，
// 讓這裡直接呼叫網站本身的準確度管線（makePoint：找來源 → 摘要 → 分類校正）與出題（askQuestions）。
// 產卡邏輯只有 index.html 這一份。
//
// 環境變數：
//   GEMINI_API_KEY     管理者的金鑰（repo Secrets）；沒有時只處理下架
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
const MAX_REQUESTS = 350;      // 免費額度約每天 500 次，保留餘裕給重試與備援
const GAP_MS = 5000;           // 每次呼叫後等待，避免超過每分鐘請求上限
const BATCH = 5;               // 每幾張卡一起出題（一次請求）
const TAKEDOWN_LABEL = '下架';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data) + '\n');
const taipeiDate = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- 讀入現有卡片庫 ----------
fs.mkdirSync(LIB, { recursive:true });
const indexFile = path.join(LIB, 'index.json'), removedFile = path.join(LIB, 'removed.json');
const index = readJSON(indexFile, { v:1, updated:null, days:[] });
const removed = readJSON(removedFile, { v:1, items:{} });
const dayCache = {};
const loadDay = file => (dayCache[file] ||= readJSON(path.join(LIB, file), { v:1, date:file.slice(0, 10), cards:[] }));
const dirty = new Set();
for (const d of index.days) loadDay(d.file);
const seenKeys = new Set(Object.values(dayCache).flatMap(d => d.cards.map(c => c.srcKey)).filter(Boolean));
const summarize = file => {
  const cards = loadDay(file).cards, by = {};
  for (const c of cards) by[`${c.cat}|${c.level}`] = (by[`${c.cat}|${c.level}`] || 0) + 1;
  return { date:file.slice(0, 10), file, n:cards.length, by };
};

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
    const file = `${id.slice(1, 5)}-${id.slice(5, 7)}-${id.slice(7, 9)}.json`;
    const day = index.days.some(d => d.file === file) ? loadDay(file) : null;
    if (day){ day.cards = day.cards.filter(c => c.id !== id); dirty.add(file); }
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
  if (!KEY){ log('沒有 GEMINI_API_KEY，略過產生新卡片'); return; }
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

    const date = taipeiDate(), file = `${date}.json`;
    const day = loadDay(file);
    let seq = day.cards.reduce((m, c) => Math.max(m, Number(String(c.id).split('-')[1]) || 0), 0);
    let cells = Object.keys(FIELDS).flatMap(cat => LEVELS.map(lv => ({ cat, lv })));
    cells = COUNT > 0 ? shuffle(cells).slice(0, COUNT) : shuffle(cells);
    log(`開始產生 ${date}：${cells.length} 格`);

    const fresh = [];
    for (const { cat, lv } of cells){
      if (requests >= MAX_REQUESTS){ log('已達請求上限，停止產生'); break; }
      const r = await page.evaluate(([cat, lv, seen]) => window.__kxBuild.makePoint(cat, lv, seen), [cat, lv, [...seenKeys]]);
      await sleep(GAP_MS);
      if (r.error){ log(`略過 ${cat}／${lv}：${r.error}`); continue; }
      const c = r.card;
      seq++;
      const card = { id:`L${date.replace(/-/g, '')}-${String(seq).padStart(2, '0')}`,
        title:c.title, english:c.english, field:c.field, cat:c.cat, sub:c.sub, level:c.level,
        srcType:c.srcType, srcKey:c.srcKey, sources:c.sources, body:c.body, terms:c.terms, consensus:c.consensus,
        model:c.model, createdAt:Date.now(), questions:[] };
      if (c.srcKey) seenKeys.add(c.srcKey);
      day.cards.push(card); fresh.push(card); dirty.add(file);
      log(`${card.id} ${cat}／${card.sub}／${lv}：${card.title}`);
    }

    // 每 BATCH 張卡出一次題，題目存進卡片，使用者測驗時就不必再呼叫 Gemini
    for (let i = 0; i < fresh.length; i += BATCH){
      if (requests >= MAX_REQUESTS){ log('已達請求上限，剩下的卡片暫不出題'); break; }
      const batch = fresh.slice(i, i + BATCH);
      const r = await page.evaluate(cards => window.__kxBuild.questions(cards), batch.map(c => ({ id:c.id, title:c.title, body:c.body })));
      await sleep(GAP_MS);
      if (r.error){ log('出題失敗：', r.error); continue; }
      for (const q of r.items){
        const card = batch.find(c => c.id === q.id);
        if (card) card.questions = [{ q:q.q, options:q.options, answer:q.answer, explain:q.explain }];
      }
    }
    log(`完成：新增 ${fresh.length} 張，Gemini 請求 ${requests} 次`);
  } finally {
    await browser.close();
    server.close();
  }
}

// ---------- 主流程 ----------
let failed = false;
try{ await takedowns(); }catch(e){ failed = true; log('下架處理失敗：', e.message); }
try{ await generate(); }catch(e){ failed = true; log('產生失敗：', e.message); }

for (const file of dirty){
  writeJSON(path.join(LIB, file), loadDay(file));
  index.days = index.days.filter(d => d.file !== file);
  if (loadDay(file).cards.length) index.days.push(summarize(file));
}
index.days.sort((a, b) => b.date.localeCompare(a.date));
if (dirty.size) index.updated = new Date().toISOString();
writeJSON(indexFile, index);
writeJSON(removedFile, removed);
log(`卡片庫共 ${index.days.reduce((s, d) => s + d.n, 0)} 張、${index.days.length} 天、已下架 ${Object.keys(removed.items).length} 張`);
if (failed) process.exitCode = 1;
