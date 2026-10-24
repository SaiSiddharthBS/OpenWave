// Import playlists from other music apps: links (Spotify, YouTube Music, Apple Music, Deezer,
// JioSaavn), export files (Exportify, TuneMyMusic for Amazon Music & co., Soundiiz, Spotify's data
// download, the Apple Music app, Google Takeout), plain lists or OpenWave backups.

import { store } from './store.js';
import { esc, icon, toast, openDialog } from './ui.js';

const BATCH = 25;

const LINK_SERVICES = ['Spotify', 'YouTube Music', 'Apple Music', 'Deezer', 'JioSaavn'];

const FILE_HELP = [
  ['Spotify (every song)', 'Go to <a href="https://exportify.app" target="_blank" rel="noopener">exportify.app</a>, sign in and export your playlists. Or in Spotify: Account → Privacy → <b>Download your data</b> and pick <code>Playlist1.json</code>.'],
  ['Amazon Music, Tidal, SoundCloud and more', 'On <a href="https://www.tunemymusic.com" target="_blank" rel="noopener">tunemymusic.com</a> (free), choose your app as the source, pick playlists, then <b>Export to file</b> and import the CSV here.'],
  ['Apple Music', 'In the Music app on a computer, select a playlist, then <b>File → Library → Export Playlist…</b> and import the text or XML file.'],
  ['YouTube Music', 'Use <a href="https://takeout.google.com" target="_blank" rel="noopener">Google Takeout</a> → YouTube and YouTube Music → playlists. Import any of the CSV files.'],
  ['OpenWave backup', 'A file from Settings → Back up library.'],
];

export function openImport() {
  openDialog(`<form method="dialog" class="import">
    <h3>Import playlists</h3>
    <p class="muted">Bring your music from any app. OpenWave finds every song and builds the playlist for you.</p>
    <div class="chips import-tabs">
      <button type="button" class="chip on" data-itab="link">${icon('link')} Link</button>
      <button type="button" class="chip" data-itab="file">${icon('download')} File</button>
      <button type="button" class="chip" data-itab="text">${icon('lyrics')} Paste list</button>
    </div>
    <div data-pane="link"><input type="text" name="url" placeholder="Paste a playlist or album link" autocomplete="off" inputmode="url">
      <p class="hint">Works with ${LINK_SERVICES.map((s) => `<b>${s}</b>`).join(', ')}. Spotify links bring the first 100 songs; use a file for more. Amazon Music: use the File tab.</p></div>
    <div data-pane="file" hidden><input type="file" name="file" accept=".csv,.txt,.json,.xml,text/csv,text/plain,application/json,text/xml">
      <details class="import-help"><summary>Where do I get a file?</summary>
        ${FILE_HELP.map(([title, how]) => `<p><b>${title}</b><br>${how}</p>`).join('')}
      </details></div>
    <div data-pane="text" hidden><textarea name="text" rows="7" placeholder="Coldplay - Yellow&#10;Daft Punk - Get Lucky&#10;…"></textarea>
      <p class="hint">One song per line, as “Artist - Title”. You can paste a song list copied from any app.</p></div>
    <div class="import-progress" hidden><div class="bar"><i></i></div><p class="muted" data-status></p></div>
    <div class="import-results"></div>
    <div class="row-btns"><button class="btn" value="cancel" data-cancel>Cancel</button><button type="button" class="btn primary" data-go>Import</button></div>
  </form>`, { wide: true, onMount: mount });
}

/** Text of a chosen file, decoding the UTF-16 files Apple's Music app exports. */
async function readFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

function mount(d) {
  let tab = 'link';
  let cancelled = false;
  d.querySelectorAll('[data-itab]').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.itab;
      d.querySelectorAll('[data-itab]').forEach((x) => x.classList.toggle('on', x === b));
      d.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
    };
  });
  d.querySelector('[data-cancel]').addEventListener('click', () => { cancelled = true; });
  const go = d.querySelector('[data-go]');
  const progress = d.querySelector('.import-progress');
  const bar = progress.querySelector('i');
  const status = progress.querySelector('[data-status]');
  const results = d.querySelector('.import-results');
  const setProgress = (done, total, text) => { progress.hidden = false; bar.style.width = `${total ? Math.max(3, (done / total) * 100) : 4}%`; status.textContent = text; };

  go.onclick = async () => {
    const form = d.querySelector('form');
    let payload;
    if (tab === 'link') payload = { url: form.elements.url.value.trim() };
    else if (tab === 'text') payload = { text: form.elements.text.value };
    else {
      const file = form.elements.file.files[0];
      if (!file) { toast('Choose a file first'); return; }
      const text = await readFile(file);
      if (/\.json$/i.test(file.name) && text.includes('"app"') && text.includes('openwave')) {
        try { const n = store.importJSON(text); toast(`Imported ${n} items from your backup`); d.close('ok'); } catch (e) { toast(e.message); }
        return;
      }
      payload = { file: text, filename: file.name };
    }
    if (!Object.values(payload)[0]) { toast('Add a link, file or list first'); return; }
    go.disabled = true;
    cancelled = false;
    try {
      setProgress(0, 0, 'Reading playlist…');
      const { playlists } = await store.api('/api/import/parse', { method: 'POST', body: payload });
      const total = playlists.reduce((n, p) => n + (p.tracks.length || p.items.length), 0);
      let done = 0;
      const made = [];
      for (const [n, p] of playlists.entries()) {
        const tracks = [...p.tracks];
        const missing = [];
        const label = playlists.length > 1 ? ` (${n + 1} of ${playlists.length}: ${p.name})` : '';
        done += tracks.length;
        for (let i = 0; i < p.items.length && !cancelled; i += BATCH) {
          setProgress(done, total, `Finding songs… ${done} of ${total}${label}`);
          const chunk = p.items.slice(i, i + BATCH);
          const { matches } = await store.api('/api/import/match', { method: 'POST', body: { items: chunk } });
          chunk.forEach((item, k) => (matches[k] ? tracks.push(matches[k]) : missing.push(item)));
          done += chunk.length;
        }
        if (cancelled) break;
        if (tracks.length) made.push({ pl: store.createPlaylist(p.name, tracks), found: tracks.length, of: tracks.length + missing.length, missing, note: p.note });
      }
      if (!made.length) throw new Error(cancelled ? 'Import cancelled' : 'None of those songs could be found');
      const songs = made.reduce((n, m) => n + m.found, 0);
      setProgress(1, 1, made.length > 1 ? `Imported ${made.length} playlists, ${songs} songs.` : `Imported ${songs} of ${made[0].of} songs into “${made[0].pl.name}”.`);
      d.querySelectorAll('[data-pane], .import-tabs').forEach((el) => { el.hidden = true; });
      results.innerHTML = made.map((m) => `<div class="import-result">
        ${made.length > 1 ? `<a href="#/my/${esc(m.pl.id)}" data-close-dialog><b>${esc(m.pl.name)}</b> <span class="muted">${m.found} of ${m.of} songs</span></a>` : ''}
        ${m.missing.length ? `<details class="missing"><summary>${m.missing.length} not found${made.length > 1 ? ` in ${esc(m.pl.name)}` : ''}</summary><ul>${m.missing.map((x) => `<li>${esc(x.artist ? `${x.artist} – ${x.title}` : x.title)}</li>`).join('')}</ul></details>` : ''}
        ${m.note ? `<p class="hint">${esc(m.note)}</p>` : ''}</div>`).join('');
      results.querySelectorAll('[data-close-dialog]').forEach((a) => a.addEventListener('click', () => d.close('ok')));
      go.textContent = made.length > 1 ? 'Open library' : 'Open playlist';
      go.disabled = false;
      d.querySelector('[data-cancel]').textContent = 'Done';
      go.onclick = () => { d.close('ok'); location.hash = made.length > 1 ? '#/library' : `#/my/${made[0].pl.id}`; };
    } catch (e) {
      go.disabled = false;
      progress.hidden = true;
      toast(e.message, 6000);
    }
  };
}

export const importButton = () => `<button class="btn" data-act="import-playlists">${icon('download')} Import</button>`;
