// The README's composed images, made from the screenshots that scripts/screenshots.mjs takes: the
// hero (a Mac and an iPhone), the Mac app in its window, every device side by side, and the picture
// a link to the repository shows (social preview). Drawn as HTML in headless Chrome.
//
//   node scripts/compose_shots.mjs            # reads and writes docs/screenshots (and docs/)

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cdp, sleep } from '../tests/ui/harness.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = process.env.SHOTS_OUT || join(ROOT, 'docs', 'screenshots');
const DOCS = process.env.SHOTS_OUT || join(ROOT, 'docs');
const shot = (name) => `file://${join(SHOTS, `${name}.png`)}`;

const BASE = `*{box-sizing:border-box;margin:0}html,body{overflow:hidden;font-family:-apple-system,"SF Pro Display","Helvetica Neue",Arial,sans-serif}`;
const BACKDROP = `background:radial-gradient(60% 80% at 10% 15%,rgba(79,107,255,.42),transparent 62%),radial-gradient(55% 70% at 80% 110%,rgba(196,92,255,.36),transparent 62%),
  radial-gradient(40% 50% at 98% 0%,rgba(47,200,255,.22),transparent 60%),#07080f`;

// A Mac window: the screenshot with rounded corners, a hairline edge, the three window buttons and a shadow.
const macWindow = (width, extra = '') => {
  const k = width / 1440;     // the screenshot is 1440 points wide
  return `<div class="mac" style="width:${width}px;${extra}">
    <img src="${shot('mac-window')}" style="width:100%;display:block">
    ${[20, 40, 60].map((x, i) => `<i style="left:${(x - 6) * k}px;top:${8 * k}px;width:${12 * k}px;height:${12 * k}px;background:${['#ff5f57', '#febc2e', '#28c840'][i]}"></i>`).join('')}
  </div>`;
};
const MAC_CSS = `.mac{position:absolute;border-radius:14px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.14),0 40px 120px rgba(0,0,0,.6),0 10px 30px rgba(0,0,0,.4)}
  .mac i{position:absolute;border-radius:50%;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.25)}`;

// An iPhone: the screenshot inside a black frame, with the Dynamic Island and the clock.
const iphone = (name, width, extra = '') => {
  const k = width / 393;
  const icons = `<svg viewBox="0 0 66 12" style="height:${11 * k}px" fill="#fff"><rect x="0" y="7" width="3" height="5" rx="1"/><rect x="5" y="5" width="3" height="7" rx="1"/><rect x="10" y="2.5" width="3" height="9.5" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/>
    <path d="M30 3.2a10 10 0 0 1 13 0l-1.6 1.7a7.6 7.6 0 0 0-9.8 0zM32.6 6a6.3 6.3 0 0 1 7.8 0l-1.7 1.7a3.9 3.9 0 0 0-4.4 0zM36.5 11.5l-2-2a2.8 2.8 0 0 1 4 0z"/>
    <rect x="44" y="1" width="20" height="10" rx="3" fill="none" stroke="#fff" stroke-opacity=".5"/><rect x="45.7" y="2.7" width="14" height="6.6" rx="1.6"/><rect x="65" y="4" width="1.4" height="4" rx=".6" fill-opacity=".5"/></svg>`;
  return `<div class="phone" style="width:${width + 22 * k}px;padding:${11 * k}px;border-radius:${62 * k}px;${extra}">
    <div style="position:relative;border-radius:${51 * k}px;overflow:hidden">
      <img src="${shot(name)}" style="width:100%;display:block">
      <div style="position:absolute;left:50%;top:${11 * k}px;width:${124 * k}px;height:${36 * k}px;margin-left:${-62 * k}px;background:#000;border-radius:${18 * k}px"></div>
      <b style="position:absolute;left:${44 * k}px;top:${17 * k}px;font-size:${17 * k}px;font-weight:600;color:#fff;letter-spacing:-.01em">9:41</b>
      <span style="position:absolute;right:${30 * k}px;top:${20 * k}px">${icons}</span>
    </div></div>`;
};
const PHONE_CSS = `.phone{position:absolute;background:#0b0b0e;box-shadow:0 0 0 2px #2a2a30,0 40px 110px rgba(0,0,0,.65)}`;

// An iPad, upright.
const ipad = (name, width, extra = '') => `<div class="pad" style="width:${width}px;${extra}"><img src="${shot(name)}" style="width:100%;display:block;border-radius:${width * .035}px"></div>`;
const PAD_CSS = `.pad{position:absolute;padding:${16}px;background:#0b0b0e;border-radius:44px;box-shadow:0 0 0 2px #2a2a30,0 40px 110px rgba(0,0,0,.6)}`;

const PAGES = [
  { file: join(SHOTS, 'hero.png'), width: 2400, height: 1350, html: `<style>${BASE}${MAC_CSS}${PHONE_CSS}body{width:2400px;height:1350px;${BACKDROP}}</style>
    ${macWindow(1860, 'left:120px;top:150px')}
    ${iphone('mobile-now-playing', 470, 'left:1790px;top:170px')}` },
  { file: join(SHOTS, 'mac-app.png'), width: 2400, height: 1560, transparent: true, html: `<style>${BASE}${MAC_CSS}body{width:2400px;height:1560px}</style>
    ${macWindow(2160, 'left:120px;top:80px')}` },
  { file: join(SHOTS, 'every-device.png'), width: 2400, height: 1200, html: `<style>${BASE}${MAC_CSS}${PHONE_CSS}${PAD_CSS}body{width:2400px;height:1200px;${BACKDROP}}</style>
    ${macWindow(1500, 'left:90px;top:170px')}
    ${ipad('tablet-home', 600, 'left:1330px;top:110px')}
    ${iphone('mobile-home', 400, 'left:1900px;top:300px')}` },
  { file: join(DOCS, 'social-preview.png'), width: 1280, height: 640, html: `<style>${BASE}${MAC_CSS}${PHONE_CSS}body{width:1280px;height:640px;color:#f4f4f8;${BACKDROP}}
      .copy{position:absolute;left:72px;top:0;bottom:0;width:460px;display:flex;flex-direction:column;justify-content:center}
      .mark{width:150px;margin:0 0 18px -6px;filter:drop-shadow(0 10px 30px rgba(79,107,255,.45))}
      h1{font-size:78px;font-weight:800;letter-spacing:-.035em;line-height:1}
      h1 b{font-weight:inherit;background:linear-gradient(90deg,#2fc8ff,#4f6bff 48%,#c45cff);-webkit-background-clip:text;background-clip:text;color:transparent}
      p{margin-top:20px;font-size:27px;line-height:1.3;color:#c9c9d6;font-weight:500;letter-spacing:-.01em}
      .chips{display:flex;flex-wrap:wrap;gap:9px;margin-top:30px}
      .chips span{font-size:15px;font-weight:600;color:#dcdcea;padding:7px 14px;border-radius:999px;background:rgba(255,255,255,.08);box-shadow:inset 0 1px 0 rgba(255,255,255,.14)}
      .foot{margin-top:26px;font-size:16px;color:#8d8da0;font-weight:500}</style>
    <div class="copy"><img class="mark" src="file://${join(ROOT, 'docs', 'logo.png')}" alt=""><h1>Open<b>Wave</b></h1>
      <p>One music app.<br>Every device you own.</p>
      <div class="chips"><span>macOS</span><span>Windows</span><span>Linux</span><span>Android</span><span>iPhone</span></div>
      <div class="foot">Open source &middot; GPL-3.0 &middot; Self-hostable</div></div>
    ${macWindow(760, 'left:560px;top:96px;border-radius:10px')}
    ${iphone('mobile-now-playing', 196, 'left:1050px;top:150px')}` },
];

const dir = mkdtempSync(join(tmpdir(), 'openwave-compose-'));
const port = 47000 + Math.floor(Math.random() * 900);
const chrome = spawn(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
try {
  let tabs;
  for (let i = 0; i < 60 && !tabs; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(250); } }
  const page = await cdp(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await page.send('Page.enable');
  for (const p of PAGES) {
    const html = join(dir, 'page.html');
    writeFileSync(html, `<!doctype html><meta charset="utf-8">${p.html}`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: p.width, height: p.height, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setDefaultBackgroundColorOverride', p.transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
    await page.send('Page.navigate', { url: `file://${html}` });
    await sleep(1500);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(p.file, Buffer.from(data, 'base64'));
    console.log(`  ${p.file.replace(`${ROOT}/`, '')}`);
  }
  page.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
