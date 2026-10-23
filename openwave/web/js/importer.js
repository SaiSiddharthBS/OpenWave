// Import playlists from Spotify links, Exportify CSV files, YouTube playlists, plain lists or OpenWave backups.

import { store } from './store.js';
import { esc, icon, toast, openDialog } from './ui.js';

const BATCH = 20;

export function openImport() {
  openDialog(`<form method="dialog" class="import">
    <h3>Import playlists</h3>
    <p class="muted">Bring your music with you. We find every song on YouTube Music and build the playlist for you.</p>
    <div class="chips import-tabs">
      <button type="button" class="chip on" data-itab="link">${icon('link')} Link</button>
      <button type="button" class="chip" data-itab="file">${icon('download')} File</button>
      <button type="button" class="chip" data-itab="text">${icon('lyrics')} Paste list</button>
    </div>
    <div data-pane="link"><input type="text" name="url" placeholder="Spotify or YouTube playlist link" autocomplete="off">
      <p class="hint">Public Spotify playlists and albums (first 100 songs), or any YouTube / YouTube Music playlist.</p></div>
    <div data-pane="file" hidden><input type="file" name="file" accept=".csv,.txt,.json,text/csv,application/json">
      <p class="hint">A CSV from <a href="https://exportify.app" target="_blank" rel="noopener">Exportify</a> (all your Spotify playlists, any size), a text file, or an OpenWave backup.</p></div>
    <div data-pane="text" hidden><textarea name="text" rows="7" placeholder="Coldplay - Yellow&#10;Daft Punk - Get Lucky&#10;…"></textarea>
      <p class="hint">One song per line, as “Artist - Title”.</p></div>
    <div class="import-progress" hidden><div class="bar"><i></i></div><p class="muted" data-status></p></div>
    <div class="row-btns"><button class="btn" value="cancel">Cancel</button><button type="button" class="btn primary" data-go>Import</button></div>
  </form>`, { wide: true, onMount: mount });
}

function mount(d) {
  let tab = 'link';
  d.querySelectorAll('[data-itab]').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.itab;
      d.querySelectorAll('[data-itab]').forEach((x) => x.classList.toggle('on', x === b));
      d.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
    };
  });
  const go = d.querySelector('[data-go]');
  const progress = d.querySelector('.import-progress');
  const bar = progress.querySelector('i');
  const status = progress.querySelector('[data-status]');
  const setProgress = (done, total, text) => { progress.hidden = false; bar.style.width = `${total ? (done / total) * 100 : 5}%`; status.textContent = text; };

  go.onclick = async () => {
    const form = d.querySelector('form');
    let payload;
    if (tab === 'link') payload = { url: form.elements.url.value.trim() };
    else if (tab === 'text') payload = { text: form.elements.text.value };
    else {
      const file = form.elements.file.files[0];
      if (!file) { toast('Choose a file first'); return; }
      const text = await file.text();
      if (file.name.endsWith('.json')) {
        try { const n = store.importJSON(text); toast(`Imported ${n} items from your backup`); d.close('ok'); } catch (e) { toast(e.message); }
        return;
      }
      payload = file.name.endsWith('.csv') || text.includes(',') ? { csv: text } : { text };
    }
    if (!Object.values(payload)[0]) { toast('Add a link, file or list first'); return; }
    go.disabled = true;
    try {
      setProgress(0, 0, 'Reading playlist…');
      const parsed = await store.api('/api/import/parse', { method: 'POST', body: payload });
      let tracks = parsed.tracks || [];
      const missing = [];
      if (!tracks.length) {
        const items = parsed.items;
        for (let i = 0; i < items.length; i += BATCH) {
          setProgress(i, items.length, `Finding songs on YouTube Music… ${i} of ${items.length}`);
          const chunk = items.slice(i, i + BATCH);
          const { matches } = await store.api('/api/import/match', { method: 'POST', body: { items: chunk } });
          matches.forEach((m, n) => (m ? tracks.push(m) : missing.push(chunk[n])));
        }
      }
      if (!tracks.length) throw new Error('None of those songs could be found');
      const total = tracks.length + missing.length;
      const pl = store.createPlaylist(parsed.name || 'Imported playlist', tracks);
      setProgress(1, 1, `Imported ${tracks.length} of ${total} songs into “${pl.name}”.`);
      d.querySelector('[data-pane]:not([hidden])').hidden = true;
      d.querySelector('.import-tabs').hidden = true;
      if (missing.length) {
        status.insertAdjacentHTML('afterend', `<details class="missing"><summary>${missing.length} not found</summary><ul>${missing.map((m) => `<li>${esc(m.artist ? `${m.artist} – ${m.title}` : m.title)}</li>`).join('')}</ul></details>`);
      }
      if (parsed.note) status.insertAdjacentHTML('afterend', `<p class="hint">${esc(parsed.note)}</p>`);
      go.textContent = 'Open playlist';
      go.disabled = false;
      go.onclick = () => { d.close('ok'); location.hash = `#/my/${pl.id}`; };
    } catch (e) {
      go.disabled = false;
      progress.hidden = true;
      toast(e.message, 5000);
    }
  };
}

export const importButton = () => `<button class="btn" data-act="import-playlists">${icon('download')} Import</button>`;
