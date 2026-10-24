// Listening insights: minutes, top artists & songs, when you listen — plus a shareable card.

import { img } from './api.js';
import { store } from './store.js';
import { esc, icon, trackList, empty, toast } from './ui.js';
import { shareFile } from './native.js';

const RANGES = [[7, 'Last 7 days'], [30, 'Last 30 days'], [365, 'This year'], [3650, 'All time']];
let last = null;

const fmt = (n) => Number(n || 0).toLocaleString();
const hourLabel = (h) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);

export async function insights({ days = 30 }) {
  days = +days || 30;
  const s = await store.api(`/api/me/stats?days=${days}&tz=${new Date().getTimezoneOffset()}`);
  last = { ...s, label: RANGES.find(([d]) => d === days)?.[1] || `Last ${days} days`, name: store.profile?.name };
  const chips = `<div class="chips">${RANGES.map(([d, l]) => `<a class="chip ${d === days ? 'on' : ''}" href="#/insights?days=${d}">${l}</a>`).join('')}</div>`;
  const head = `<div class="lib-head"><h1>Your insights</h1>${s.plays ? `<button class="btn" data-act="share-insights">${icon('share')} Share</button>` : ''}</div>`;
  if (!s.plays) {
    return { html: head + chips + empty('chart', 'Nothing here yet', 'Listen to a few songs (30 seconds or more) and your stats will show up here.') };
  }
  const tiles = [['Minutes listened', fmt(s.minutes)], ['Songs', fmt(s.tracks)], ['Artists', fmt(s.artists)], ['Plays', fmt(s.plays)]]
    .map(([k, v]) => `<div class="stat"><div class="stat-value">${v}</div><div class="stat-label">${k}</div></div>`).join('');
  const peak = Math.max(...s.hours, 1);
  const busiest = s.hours.indexOf(Math.max(...s.hours));
  const bars = s.hours.map((n, h) => `<div class="hbar" data-tip="${hourLabel(h)} · ${n} play${n === 1 ? '' : 's'}"><i style="height:${Math.max(n ? 4 : 0, (n / peak) * 100)}%"></i></div>`).join('');
  const artists = s.topArtists.map((a, i) => `<a class="card artist" ${a.id ? `href="#/artist/${encodeURIComponent(a.id)}"` : ''}>
      <div class="art"><img loading="lazy" src="${img(a.thumbnail, 300)}" alt=""></div>
      <div class="title">${i + 1}. ${esc(a.name)}</div><div class="sub">${fmt(a.plays)} plays</div></a>`).join('');
  return {
    tintColor: '60, 60, 160',
    collection: { tracks: s.topTracks, context: { label: 'Your top songs', href: `#/insights?days=${days}` }, kind: 'insights' },
    html: head + chips
      + `<div class="stats">${tiles}</div>`
      + `<section class="section"><div class="section-head"><h2>Top artists</h2></div><div class="shelf">${artists}</div></section>`
      + `<section class="section"><div class="section-head"><h2>Top songs</h2><button data-act="play-collection">${icon('play')} Play all</button></div>${trackList(s.topTracks, { numbered: true, context: { label: 'Your top songs' } })}</section>`
      + `<section class="section"><div class="section-head"><h2>When you listen</h2><span class="muted">Most active around ${hourLabel(busiest)}</span></div>
          <figure class="hours" aria-label="Plays by hour of day">${bars}
            <figcaption class="hours-axis"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span></figcaption>
            <div class="hours-tip" hidden></div></figure>
          <table class="sr-only"><caption>Plays by hour</caption><tbody>${s.hours.map((n, h) => `<tr><th>${hourLabel(h)}</th><td>${n}</td></tr>`).join('')}</tbody></table></section>`,
    mount: (root) => {
      const fig = root.querySelector('.hours');
      const tip = fig?.querySelector('.hours-tip');
      fig?.querySelectorAll('.hbar').forEach((b) => {
        b.onmouseenter = () => {
          tip.hidden = false;
          tip.textContent = b.dataset.tip;
          tip.style.left = `${b.offsetLeft + b.offsetWidth / 2}px`;
          tip.style.top = `${b.offsetTop + b.offsetHeight - b.firstElementChild.offsetHeight - 6}px`;
          b.classList.add('on');
        };
        b.onmouseleave = () => { tip.hidden = true; b.classList.remove('on'); };
      });
    },
  };
}

function loadImage(src) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > max) text = text.slice(0, -1);
  return `${text}…`;
}

/** Draw a 1080×1350 story card and share or download it. */
export async function shareInsights() {
  if (!last) return;
  const W = 1080, H = 1350;
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#141838'); g.addColorStop(0.55, '#0b0b16'); g.addColorStop(1, '#2a0f3c');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const logo = await loadImage('/icons/logo-mark-128.png');
  if (logo) ctx.drawImage(logo, 80, 80, 128 * (logo.width / logo.height) * 0.7, 128 * 0.7);
  ctx.fillStyle = '#fff';
  ctx.font = '800 44px system-ui, -apple-system, sans-serif';
  ctx.fillText('OpenWave', 80 + 128 * (logo ? logo.width / logo.height : 0) * 0.7 + 18, 140);
  ctx.fillStyle = '#a4a4b2'; ctx.font = '600 34px system-ui, sans-serif';
  ctx.fillText(`${last.name ? `${last.name} · ` : ''}${last.label}`, 80, 250);
  ctx.fillStyle = '#fff'; ctx.font = '850 150px system-ui, sans-serif';
  ctx.fillText(fmt(last.minutes), 80, 410);
  ctx.fillStyle = '#c9c9ff'; ctx.font = '700 40px system-ui, sans-serif';
  ctx.fillText('minutes of music', 84, 470);

  const col = (title, rows, x) => {
    ctx.fillStyle = '#a4a4b2'; ctx.font = '700 30px system-ui, sans-serif';
    ctx.fillText(title.toUpperCase(), x, 590);
    rows.slice(0, 5).forEach((r, i) => {
      ctx.fillStyle = '#7b7bff'; ctx.font = '800 40px system-ui, sans-serif';
      ctx.fillText(String(i + 1), x, 665 + i * 92);
      ctx.fillStyle = '#fff'; ctx.font = '700 38px system-ui, sans-serif';
      ctx.fillText(fit(ctx, r, 400), x + 50, 665 + i * 92);
    });
  };
  col('Top artists', last.topArtists.map((a) => a.name), 80);
  col('Top songs', last.topTracks.map((t) => t.title), 560);
  ctx.fillStyle = '#6d6d7c'; ctx.font = '600 30px system-ui, sans-serif';
  ctx.fillText('Free & open source · github.com/SaiSiddharthBS/OpenWave', 80, H - 80);

  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  if (await shareFile('my-openwave.png', blob)) return;
  const file = new File([blob], 'my-openwave.png', { type: 'image/png' });
  try {
    // Phones get the native share sheet; desktops save the image.
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'My OpenWave', text: 'My music, free on OpenWave' });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'my-openwave.png' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Saved your OpenWave card');
}
