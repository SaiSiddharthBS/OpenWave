// Smart mix: the analysis (mix-analysis.js) runs here, off the page, so the screen never stutters
// while a song is being listened to. mix.js sends mono samples and gets the analysis back.

import { analyse } from './mix-analysis.js';

self.onmessage = ({ data: { id, samples } }) => {
  try {
    self.postMessage({ id, result: analyse(samples) });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
