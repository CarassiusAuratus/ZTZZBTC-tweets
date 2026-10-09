#!/usr/bin/env node
/**
 * 把 docs/*.md 中的 X 图床直链（pbs.twimg.com）下载到 assets/，
 * 并把文档里的图片链接改写成相对路径，使仓库离线自包含。
 *
 * 用法（需要 Node.js 18+，且本机网络能访问 pbs.twimg.com）：
 *   node tools/localize-images.js            # 下载并改写
 *   node tools/localize-images.js --dry-run  # 只统计，不写入
 *
 * 说明：如果只想改回直链，用 git checkout -- docs 撤销即可。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const ASSETS = path.join(ROOT, 'assets');
const DRY = process.argv.includes('--dry-run');
const UA = 'Mozilla/5.0 (compatible; ztzzbtc-archive/1.0)';

const IMG_RE = /https:\/\/pbs\.twimg\.com\/[^\s)"'>]+/g;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function fileNameFor(url, tweetId) {
  const base = url.split('?')[0].split('/').pop();
  const ext = (base.match(/\.(jpg|jpeg|png|webp|gif)$/i) || ['.jpg'])[0].toLowerCase();
  return `${tweetId}_${base.slice(0, 24)}${ext}`;
}

function download(url, dest) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Referer: 'https://x.com/' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, status: res.statusCode }); }
      const tmp = dest + '.part';
      const ws = fs.createWriteStream(tmp);
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => { fs.renameSync(tmp, dest); resolve({ ok: true, bytes: fs.statSync(dest).size }); }));
      ws.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

// 用所在章节中最近的 "## x.y 标题" 或 "## x.y" 编号推一个稳定的前缀
function tweetIdNear(text, index) {
  const before = text.slice(0, index);
  const m = [...before.matchAll(/^##\s+(\d+\.\d+)/gm)].pop();
  return m ? m[1].replace('.', '-') : 'img';
}

(async () => {
  fs.mkdirSync(ASSETS, { recursive: true });
  const files = walk(DOCS);
  const jobs = [];       // {url, rel}
  const rewrites = [];   // {file, from, to}

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMG_RE)) {
      const url = m[0];
      const rel = `assets/${fileNameFor(url, tweetIdNear(text, m.index))}`;
      jobs.push({ url, rel });
      rewrites.push({ file, from: url, to: '../' + rel });
    }
  }

  const unique = new Map();
  for (const j of jobs) if (!unique.has(j.url)) unique.set(j.url, j.rel);
  console.log(`发现图片引用 ${jobs.length} 处，去重后 ${unique.size} 张`);
  if (DRY) return;

  let ok = 0, failed = 0, bytes = 0, cursor = 0;
  const list = [...unique.entries()];
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;
      const [url, rel] = list[i];
      const dest = path.join(ROOT, rel);
      if (!fs.existsSync(dest)) {
        const r = await download(url, dest);
        if (r.ok) { ok++; bytes += r.bytes; } else { failed++; console.log('FAIL', url, r.error || r.status); }
      }
      if ((i + 1) % 25 === 0) console.log(`进度 ${i + 1}/${list.length}（${(bytes / 1048576).toFixed(1)} MB）`);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));

  let changed = 0;
  for (const file of files) {
    let text = fs.readFileSync(file, 'utf8');
    const before = text;
    for (const [url, rel] of unique) text = text.split(url).join('../' + rel);
    if (text !== before) { fs.writeFileSync(file, text, 'utf8'); changed++; }
  }
  console.log(`完成：下载 ${ok} 张（${(bytes / 1048576).toFixed(1)} MB），失败 ${failed} 张，改写文件 ${changed} 个。`);
  console.log('接下来：git add -A && git commit -m "本地化图片"');
})();
