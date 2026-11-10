// Smart mix, part 2: deciding how two songs meet. Pure arithmetic on two analyses (mix-analysis.js),
// so it is tested in Node.
//
//   plan(outgoing, incoming, { graph }) -> what mix.js plays
//
// Four ways, best first, each used only when what it needs is there:
//
//   blend  Both songs keep a steady beat at the ends that meet and their tempos are within a few per
//          cent. The next song comes in on a downbeat, beat for beat with this one, both nudged to a
//          tempo between theirs. Its bass is held back until halfway, when the two swap bass on a
//          downbeat, then this song fades out over the rest. The length is the next song's intro: it
//          is fully in just as this one has gone. Keys that clash get a shorter blend.
//   echo   This song has a clear beat but the tempos are too far apart to blend: it is cut on a
//          downbeat with its last beat echoing away, and the next song starts on that downbeat.
//   fade   No clear beat (a ballad, a live recording): a smooth six-second crossfade that ends just as
//          this song's music does, not its silence, into the next song's first sound.
//
// Without the audio graph (WebKit: see mix.js) two songs can't be lined up beat for beat, so each
// hands over to the next as its music ends: a quick two-second fade where both have a beat (so the
// beats aren't heard out of step for long), six seconds where they don't.
//
// Times are each song's own seconds; `rate` is the playback speed each song is set to.

// How far either song's speed may move. Speed moves pitch too (as on a turntable: see mix.js), and
// 3.5 % is about 0.6 of a semitone at most; a blend usually needs half that or less, as both move.
const MAX_STRETCH = 0.035;
const FADE = 6;            // seconds, for a fade
const PREROLL = 2;         // seconds the next song needs to play silently to lock its beat
const QUICK = 2;           // seconds, for a handover between two songs with beats, without the graph

/** How well two keys go together: 0 same or neighbours on the wheel, 1 a step further, 2 a clash. */
export function keyDistance(a, b) {
  if (!a || !b) return 0;
  const d = Math.min((a.wheel - b.wheel + 12) % 12, (b.wheel - a.wheel + 12) % 12);
  const sameLetter = a.camelot.slice(-1) === b.camelot.slice(-1);
  if (d === 0 || (d === 1 && sameLetter)) return 0;
  if (d <= 2) return 1;
  return 2;
}

/** Where the outgoing song's music really ends: its end, or where a fade has got quiet. */
function musicEnd(a) {
  const o = a.outro;
  if (o?.fades && o.quietAt) return Math.min(a.end, o.quietAt);
  return a.end;
}

export function plan(a, b, { graph = true } = {}) {
  const reason = [];
  const fade = (why, length = FADE) => {
    const end = a ? musicEnd(a) : null;
    reason.push(why);
    return {
      style: 'fade', reason: reason.join('; '), length,
      outAt: end != null ? Math.max(0, end - length) : null, outEnd: end,
      inAt: b ? Math.max(0, b.start - 0.05) : 0, inFrom: b ? Math.max(0, b.start - 0.05) : 0, rateA: 1, rateB: 1,
    };
  };
  if (!a || !b) return fade('a song wasn’t analysed');
  if (a.end - a.start < 45 || b.end - b.start < 45) return fade('a song is too short to mix');
  const o = a.outro, i = b.intro;
  const end = musicEnd(a);
  // WebKit: its clock can't line two songs up (see mix.js), so it hands over as the music ends. Where
  // both have a beat the fade is short, so two beats are never heard out of step for long.
  if (!graph) return fade(o?.steady && i?.steady ? 'a quick handover (beat matching needs the audio graph)' : 'a fade', o?.steady && i?.steady ? QUICK : FADE);

  // ---------------------------------------------------------------- blend
  const tempoA = o?.period, tempoB = i?.period;
  let rateA = 1, rateB = 1, apart = Infinity;
  if (o?.steady && i?.steady) {
    // Meet in the middle: both move half way (in ratio) to a common beat length.
    const common = Math.sqrt(tempoA * tempoB);
    rateA = tempoA / common;
    rateB = tempoB / common;
    apart = Math.abs(tempoB / tempoA - 1);
    if (Math.abs(rateA - 1) > MAX_STRETCH + 1e-9 || Math.abs(rateB - 1) > MAX_STRETCH + 1e-9) {
      reason.push(`tempos ${(60 / tempoA).toFixed(1)} and ${(60 / tempoB).toFixed(1)} are too far apart to blend`);
    } else {
      const clash = keyDistance(a.key, b.key);
      const keysSure = (a.key?.confidence || 0) > 0.04 && (b.key?.confidence || 0) > 0.04;
      const build = i.build ?? 0, tail = o.tail ?? 0;
      let bars = build >= 16 && tail >= 8 ? 16 : build >= 8 ? 8 : build >= 4 ? 4 : 2;
      if (keysSure && clash === 2) { bars = Math.min(bars, 4); reason.push('keys clash: a short blend'); }
      const barA = o.bar;
      // The latest downbeat that leaves room for the blend before this song's music ends; the last
      // bar may ring on past the end of the music by half a bar.
      for (; bars >= 2; bars /= 2) {
        const k = Math.floor((end + 0.5 * barA - o.first) / barA) - bars;
        const outAt = o.first + k * barA;
        if (k < 0 || outAt < a.start + 30) continue;
        // Start the next song on its first downbeat, or a few bars into a long build so its full
        // sound lands as this one goes.
        let skip = Math.max(0, Math.min(8, build - bars - 4));
        // It starts playing silently a few seconds early, so its beat is locked before it's heard;
        // a song whose first downbeat is right at its start joins a bar in to leave room for that
        // (its first bar is heard under this song's outro at best, and intros repeat their first bar).
        while (i.first + skip * i.bar < PREROLL && skip < 4) skip++;
        const inAt = i.first + skip * i.bar;
        const swap = outAt + (bars / 2) * barA;
        const inFrom = Math.max(0, inAt - 3);
        reason.push(`blend: ${bars} bars at ${(60 / tempoA).toFixed(1)} → ${(60 / tempoB).toFixed(1)} BPM`);
        return {
          style: 'blend', reason: reason.join('; '), bars, beats: 4 * bars, rateA, rateB,
          outAt, outEnd: outAt + bars * barA, swap, inAt, inFrom, inSwap: inAt + (bars / 2) * i.bar,
          beatA: tempoA, beatB: tempoB, barA, barB: i.bar, apart, key: { a: a.key?.camelot, b: b.key?.camelot, clash },
        };
      }
      reason.push('no room to blend before the song ends');
    }
  } else {
    reason.push(!o?.steady ? 'this song has no steady beat at its end' : 'the next song has no steady beat at its start');
  }

  // ---------------------------------------------------------------- echo
  if (o?.steady) {
    // Cut on the latest downbeat at least a bar before the music ends (so the cut isn't on its last
    // ringing chord), echoing the beat before it.
    const k = Math.floor((end - o.bar - o.first) / o.bar);
    const outAt = o.first + Math.max(0, k) * o.bar;
    if (outAt > a.start + 30 && end - outAt < 40) {
      // The next song's first downbeat lands on the cut; anything before it (a pickup) plays just
      // before, rising under the last beat. A long beatless opening is played from the cut instead.
      const first = i?.steady ? i.first : b.start;
      const inAt = first - b.start <= 4 ? first : Math.max(0, b.start - 0.05);
      const inFrom = Math.max(0, Math.min(inAt, b.start - 0.05));
      reason.push('echo out on the downbeat');
      return {
        style: 'echo', reason: reason.join('; '), outAt, outEnd: outAt, inAt, inFrom,
        rateA: 1, rateB: 1, beatA: o.period, barA: o.bar,
      };
    }
  }
  return fade('no clear beat to mix on');
}
