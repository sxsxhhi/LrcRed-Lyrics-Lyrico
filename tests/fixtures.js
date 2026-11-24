'use strict';
/* Synthetic fixtures only: no real lyrics, no real catalogue data. */

function pad(n) { return String(n).padStart(2, '0'); }

function ts(sec) {
  const total = Math.round(sec * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  return pad(h) + ':' + pad(m) + ':' + pad(s) + '.' + String(ms).padStart(3, '0');
}

/*
 * buildTtml({
 *   lineCount, start, step, bodyDur (string|null), untimedLines: [i], allUntimed
 * })
 * Default 8 lines from 6s with 24s steps -> lastEnd 193.2s, fits a 210s track.
 */
function buildTtml(o) {
  o = o || {};
  const n = o.lineCount === undefined ? 8 : o.lineCount;
  const start = o.start === undefined ? 6 : o.start;
  const step = o.step === undefined ? 24 : o.step;
  const untimed = new Set(o.untimedLines || []);
  const lines = [];
  for (let i = 0; i < n; i++) {
    const b = start + i * step;
    const e = b + step * 0.8;
    const w1 = 'la' + i + 'a';
    const w2 = 'la' + i + 'b';
    if (o.allUntimed || untimed.has(i)) {
      lines.push('      <p begin="' + ts(b) + '" end="' + ts(e) + '">' + w1 + ' ' + w2 + '</p>');
    } else {
      lines.push(
        '      <p begin="' + ts(b) + '" end="' + ts(e) + '">' +
        '<span begin="' + ts(b) + '" end="' + ts(b + step * 0.4) + '">' + w1 + '</span> ' +
        '<span begin="' + ts(b + step * 0.4) + '" end="' + ts(e) + '">' + w2 + '</span>' +
        '</p>'
      );
    }
  }
  const lastEnd = start + (n - 1) * step + step * 0.8;
  const bodyOpen = o.bodyDur === null ? '  <body>' : '  <body dur="' + (o.bodyDur || ts(lastEnd)) + '">';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"',
    '    xmlns:itunes="http://music.apple.com/lyric-ttml-internal">',
    '  <head><metadata><iTunesMetadata><songId>1440833098</songId></iTunesMetadata></metadata></head>',
    bodyOpen,
    '    <div>',
    lines.join('\n'),
    '    </div>',
    '  </body>',
    '</tt>'
  ].join('\n');
}

/* lrc.red flavoured TTML: own namespace prefix on both the declaration and
 * the paragraph attributes, so the namespace rewrite is actually exercised. */
function buildLrcRedTtml(o) {
  return buildTtml(o || {})
    .replace('xmlns:itunes="http://music.apple.com/lyric-ttml-internal"',
             'xmlns:lrc="http://lrc.red/lyric-ttml-internal"')
    .replace(/<p begin=/g, '<p lrc:key="k" begin=');
}

function itTrack(o) {
  return {
    trackId: o.id,
    trackName: o.title,
    artistName: o.artist === undefined ? 'Test Artist' : o.artist,
    collectionName: o.album === undefined ? 'Test Album' : o.album,
    releaseDate: o.date === undefined ? '2020-05-01T07:00:00Z' : o.date,
    trackTimeMillis: o.dur === undefined ? 210000 : o.dur
  };
}
function itunesBody(results) {
  return JSON.stringify({ resultCount: results.length, results: results });
}
function lrcSongBody(ttml, meta) {
  const base = {
    source: ttml,
    title: 'Test Song',
    artist: 'Test Artist',
    album: 'Test Album',
    duration: 210,
    byModel: false
  };
  return JSON.stringify(Object.assign(base, meta || {}));
}
function lrcHitsBody(list) {
  return JSON.stringify({ hits: list });
}
function hit(isrc, o) {
  o = o || {};
  return {
    isrc: isrc,
    title: o.title === undefined ? 'Test Song' : o.title,
    artist: o.artist === undefined ? 'Test Artist' : o.artist,
    album: o.album === undefined ? 'Test Album' : o.album,
    duration: o.duration === undefined ? 210 : o.duration
  };
}

function req(over, cfg) {
  const song = Object.assign({ title: 'Test Song', artist: 'Test Artist', album: 'Test Album', duration: 210000 }, over || {});
  const config = Object.assign({
    contact_email: 'tester@example.com',
    match_mode: 'balanced',
    search_fallback: 'true',
    apple_tier: 'true'
  }, cfg || {});
  return { song, config };
}

module.exports = {
  ts, buildTtml, buildLrcRedTtml,
  itTrack, itunesBody, lrcSongBody, lrcHitsBody, hit, req
};
