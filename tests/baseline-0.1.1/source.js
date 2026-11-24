/*
 * LrcRed Lyrics 0.1.1 — standalone getLyrics-only plugin for Lyrico API 5.
 * Original independent implementation, with matching/validation behavior
 * adapted from music-tag-lyrics v1.8.5 (core/fetchers/lrc_red.py).
 * Data provider: https://lrc.red — credit and link back whenever shown.
 *
 * QuickJS: no require(), fetch(), timers, filesystem, or Node APIs.
 */
var LR_PLUGIN_TAG = "LrcRedLyrics";
var LR_BASE = "https://lrc.red";
var LR_APP_URL = "https://github.com/sxsxhhi/music-tag-lyrics";
var LR_BUDGET_MS = 11700;
var LR_MAX_REQUESTS = 6;
var LR_JSON_LIMIT = 1048576;
var LR_TTML_LIMIT = 2097152;
var LR_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
var LR_COOLDOWN_MS = 90 * 1000;
var LR_CACHE_NS = "lrcred.v01.";
var LR_ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
var LR_CONTACT_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

function lrString(value) {
  return value === undefined || value === null ? "" : String(value);
}
function lrLog(level, text) {
  try {
    if (typeof Platform !== "undefined" && Platform.log && typeof Platform.log[level] === "function") {
      Platform.log[level](LR_PLUGIN_TAG, lrString(text));
    }
  } catch (_) { /* diagnostics are optional */ }
}
function lrConfig(req, key, fallback) {
  var o = req && req.config;
  return o && Object.prototype.hasOwnProperty.call(o, key) && o[key] !== undefined && o[key] !== null
    ? o[key] : fallback;
}
function lrContact(req) {
  var mail = lrString(lrConfig(req, "contact_email", "")).trim();
  return mail.length > 0 && mail.length <= 254 && LR_CONTACT_RE.test(mail) ? mail : "";
}
function lrCacheGet(key) {
  try { return Platform.cache && Platform.cache.get ? lrString(Platform.cache.get(LR_CACHE_NS + key)) : ""; }
  catch (_) { return ""; }
}
function lrCacheSet(key, value, ttlMs) {
  try { if (Platform.cache && Platform.cache.set) Platform.cache.set(LR_CACHE_NS + key, lrString(value), ttlMs); }
  catch (_) { /* cache must never interrupt lyrics lookup */ }
}
function lrNow() { return Date.now(); }
function lrIsrc(raw) {
  var s = lrString(raw).replace(/[\s\-]/g, "").toUpperCase();
  return LR_ISRC_RE.test(s) ? s : "";
}
function lrNorm(text) {
  var s = lrString(text);
  try { s = s.normalize("NFKC"); } catch (_) {}
  s = s.toLowerCase().replace(/[\u200b-\u200f\ufeff]/g, "");
  try { s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (_) {}
  return s;
}
function lrVersionTags(text) {
  var s = lrNorm(text);
  var defs = [
    ["live", /\blive\b|现场版|演唱会/],
    ["remix", /\bremix\b|混音版|重混/],
    ["acoustic", /\bacoustic\b|不插电/],
    ["instrumental", /\binstrumental\b|伴奏版|纯音乐/],
    ["karaoke", /\bkaraoke\b|卡拉ok/],
    ["cover", /\bcover\b|翻唱版/],
    ["demo", /\bdemo\b|小样版/],
    ["remaster", /\bremaster(?:ed)?\b|重制版/],
    ["radio_edit", /\bradio\s+edit\b/],
    ["extended", /\bextended\b|加长版/],
    ["sped_up", /\bsped[ -]?up\b|加速版/],
    ["slowed", /\bslowed\b|慢速版/],
    ["taylor_version", /taylor.?s\s+version/],
    ["nightcore", /\bnightcore\b/]
  ];
  var out = [];
  for (var i = 0; i < defs.length; i++) if (defs[i][1].test(s)) out.push(defs[i][0]);
  return out;
}
function lrVersionsConflict(a, b) {
  var x = lrVersionTags(a), y = lrVersionTags(b);
  for (var i = 0; i < x.length; i++) if (y.indexOf(x[i]) < 0) return true;
  for (var j = 0; j < y.length; j++) if (x.indexOf(y[j]) < 0) return true;
  return false;
}
function lrTitleCore(text) {
  var s = lrNorm(text);
  s = s.replace(/\b(?:feat(?:uring)?|ft)\.?\s+[^()\[\]，,]+/g, "");
  s = s.replace(/[（(\[【][^）)\]】]*(?:live|remix|acoustic|instrumental|karaoke|cover|demo|remaster|radio\s+edit|extended|sped.up|slowed|taylor|nightcore|现场版|混音版|重制版)[^）)\]】]*[）)\]】]/g, "");
  return s.replace(/[^\p{L}\p{N}]+/gu, "");
}
function lrArtistSet(value) {
  var s = lrNorm(value).replace(/\b(?:feat(?:uring)?|ft)\.?\s+/g, "/");
  var parts = s.split(/\s+&\s+|\s+and\s+|\s*[,，、;；/|+]\s*/);
  var result = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].replace(/[^\p{L}\p{N}]+/gu, "");
    if (p && result.indexOf(p) < 0) result.push(p);
  }
  return result;
}
function lrArtistCompatible(local, remote) {
  var a = lrArtistSet(local), b = lrArtistSet(remote);
  if (!a.length || !b.length) return false;
  for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) return true;
  return false;
}
function lrAlbumCore(text) {
  return lrNorm(text).replace(/[^\p{L}\p{N}]+/gu, "");
}
function lrSongContext(request) {
  var song = (request && request.song) || {};
  var f = song.fields || {};
  var title = lrString(song.title || f.title).trim();
  var artist = lrString(song.artist || f.artist).trim();
  var album = lrString(song.album || f.album).trim();
  var date = lrString(song.date || f.date).trim();
  var duration = Number(song.duration || song.durationMs || f.duration || 0);
  if (!isFinite(duration) || duration < 0 || duration > 86400000) duration = 0;
  var isrc = lrIsrc(song.isrc || f.isrc || "");
  return { title: title, artist: artist, album: album, date: date, duration: duration, isrc: isrc };
}
function lrDeadline(state) { return lrNow() >= state.deadline; }
function lrGet(state, url, maxChars) {
  if (lrDeadline(state) || state.requests >= LR_MAX_REQUESTS || state.rateLimited) return null;
  if (lrCacheGet("cooldown")) { state.rateLimited = true; return null; }
  state.requests += 1;
  var remaining = state.deadline - lrNow();
  var opts = {
    headers: {
      "Accept": maxChars === LR_TTML_LIMIT ? "application/xml,text/xml,*/*" : "application/json",
      "User-Agent": "LrcRedLyrics/0.1.1 (+" + LR_APP_URL + "; contact: " + state.email + ")",
      "X-Client-ID": "LrcRedLyrics/0.1.1 (+" + LR_APP_URL + "; contact: " + state.email + ")"
    },
    connectTimeoutMs: Math.min(2500, Math.max(250, remaining)),
    readTimeoutMs: Math.min(4000, Math.max(250, remaining)),
    followRedirects: true
  };
  try {
    var res = Platform.http.get(url, opts);
    var code = Number(res && res.code || 0);
    if (code === 429 || code === 503) {
      var cooldown = code === 429 ? LR_COOLDOWN_MS : 30000;
      var headers = (res && res.headers) || {};
      var retryRaw = headers["Retry-After"] || headers["retry-after"] || "";
      if (Array.isArray(retryRaw)) retryRaw = retryRaw[0] || "";
      var retrySeconds = Number(retryRaw);
      if (lrString(retryRaw).trim() && isFinite(retrySeconds) && retrySeconds > 0) {
        cooldown = Math.min(300000, Math.max(cooldown, Math.floor(retrySeconds * 1000)));
      }
      lrCacheSet("cooldown", "1", cooldown);
      state.rateLimited = true;
      lrLog("warn", "lrc.red returned " + code + "; temporary request cooldown active");
      return { code: code, body: "" };
    }
    var body = lrString(res && res.body);
    if (body.length > maxChars) {
      lrLog("warn", "lrc.red payload rejected: too large");
      return { code: 0, body: "" };
    }
    return { code: code, body: body };
  } catch (err) {
    lrLog("warn", "lrc.red network error: " + lrString(err && err.message ? err.message : err).slice(0, 120));
    return { code: 0, body: "" };
  }
}
function lrGetJson(state, url) {
  var r = lrGet(state, url, LR_JSON_LIMIT);
  if (!r || r.code !== 200 || !r.body) return null;
  try { var obj = JSON.parse(r.body); return obj && typeof obj === "object" ? obj : null; }
  catch (_) { return null; }
}
function lrGetText(state, url) {
  var r = lrGet(state, url, LR_TTML_LIMIT);
  return r && r.code === 200 ? r.body : "";
}
function lrRankHits(hits, song, mode) {
  if (!Array.isArray(hits)) return [];
  var ranked = [], visited = {};
  var n = Math.min(hits.length, 45);
  var titleCore = lrTitleCore(song.title);
  for (var i = 0; i < n; i++) {
    var h = hits[i];
    if (!h || typeof h !== "object") continue;
    var isrc = lrIsrc(h.isrc);
    if (!isrc || visited[isrc]) continue;
    var ht = lrString(h.title || ""), ha = lrString(h.artist || "");
    if (!ht || !ha || !titleCore || lrTitleCore(ht) !== titleCore) continue;
    if (lrVersionsConflict(song.title + " " + song.album, ht + " " + lrString(h.album))) continue;
    if (song.artist && !lrArtistCompatible(song.artist, ha)) continue;
    var dur = Number(h.duration || 0) * 1000;
    if (!isFinite(dur) || dur < 0 || dur > 86400000) dur = 0;
    var hasDuration = song.duration > 0 && dur > 0;
    var diff = hasDuration ? Math.abs(song.duration - dur) : 0;
    if (hasDuration && diff > 5000) continue;
    if (mode === "strict" && (!hasDuration || diff > 3000)) continue;
    visited[isrc] = true; // Only dedupe valid candidates; an earlier bad hit must not hide a valid duplicate.
    var score = 100;
    if (lrNorm(ht).replace(/\s+/g, "") === lrNorm(song.title).replace(/\s+/g, "")) score += 15;
    if (song.album && h.album && lrAlbumCore(song.album) === lrAlbumCore(h.album)) score += 20;
    if (hasDuration) score += 18 - Math.floor(diff / 300);
    else score -= 12;
    ranked.push({ hit: h, isrc: isrc, score: score });
  }
  ranked.sort(function (a, b) { return b.score - a.score || (a.isrc < b.isrc ? -1 : 1); });
  return ranked;
}
function lrValidateIdentity(song, meta, mode) {
  if (!meta || !meta.title || !meta.artist) return false;
  if (!song.title || !song.artist) return false;
  if (lrTitleCore(song.title) !== lrTitleCore(meta.title)) return false;
  if (lrVersionsConflict(song.title + " " + song.album, meta.title + " " + lrString(meta.album))) return false;
  if (!lrArtistCompatible(song.artist, meta.artist)) return false;
  var dur = Number(meta.duration || 0) * 1000;
  if (!isFinite(dur) || dur < 0) dur = 0;
  if (song.duration && dur && Math.abs(song.duration - dur) > (mode === "strict" ? 3000 : 5000)) return false;
  if (mode === "strict" && (!song.duration || !dur)) return false;
  if (meta.byModel === true) return false;
  return true;
}
function lrNormalizeTtml(input) {
  var s = lrString(input);
  // lrc.red uses lrc:timing / lrc:key with its own URI; Lyrico's TTML parser
  // recognizes the Apple/AMLL iTunes internal namespace for those attributes.
  var legacy = /xmlns:lrc\s*=\s*(["'])http:\/\/lrc\.red\/lyric-ttml-internal\1/i;
  if (!legacy.test(s)) return s;
  var itunesDeclared = /xmlns:itunes\s*=/.test(s);
  s = s.replace(legacy, itunesDeclared ? "" : 'xmlns:itunes="http://music.apple.com/lyric-ttml-internal"');
  s = s.replace(/\blrc:/g, "itunes:");
  return s;
}
function lrTtmlCheck(ttml, song, mode) {
  if (typeof ttml !== "string" || ttml.length < 70 || ttml.length > LR_TTML_LIMIT) return false;
  if (!/<(?:[A-Za-z0-9_\-]+:)?tt(?:\s|>)/.test(ttml) || !/<\/(?:[A-Za-z0-9_\-]+:)?tt\s*>/.test(ttml)) return false;
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(ttml)) return false;
  if (!Platform.xml || typeof Platform.xml.findElements !== "function") return false;
  try {
    // findElements is backed by Lyrico's XML parser. Malformed XML must be rejected.
    var paragraphs = Platform.xml.findElements(ttml, {tag: "p"});
    if (!Array.isArray(paragraphs) || !paragraphs.length) return false;
    var original = 0, timed = 0, lastEnd = 0;
    for (var i = 0; i < paragraphs.length; i++) {
      var p = paragraphs[i] || {}, pa = p.attrs || {};
      var role = lrString(pa["ttm:role"] || pa.role);
      if (role === "x-bg" || role === "x-translation" || role === "x-roman" || role === "x-romanization") continue;
      if (!lrString(p.text).trim()) continue;
      original++;
      var spans = p.children || [], found = false;
      for (var j = 0; j < spans.length; j++) {
        var node = spans[j] || {}, tag = lrString(node.tag).split(":").pop(), attrs = node.attrs || {};
        var spanRole = lrString(attrs["ttm:role"] || attrs.role);
        if (tag === "span" && spanRole !== "x-bg" && spanRole !== "x-translation" &&
            spanRole !== "x-roman" && (attrs.begin || attrs.end) && lrString(node.text).trim()) {
          found = true; break;
        }
      }
      if (found) timed++;
      var lineStart = lrParseTtmlTime(pa.begin || "");
      var e = lrParseTtmlTime(pa.end || "");
      if (e > 0 && e < lineStart) return false;
      // Reject inverted time ranges instead of passing malformed synced words.
      var wordEndMax = 0;
      for (var k = 0; k < spans.length; k++) {
        var child = spans[k] || {}, at = child.attrs || {};
        if (lrString(child.tag).split(":").pop() !== "span") continue;
        var a = lrParseTtmlTime(at.begin || ""), b = lrParseTtmlTime(at.end || "");
        if (at.begin && at.end && b < a) return false;
        if (b > wordEndMax) wordEndMax = b;
      }
      if (e === 0) e = wordEndMax; // TTML without paragraph end: use timed words.
      if (e > lastEnd) lastEnd = e;
    }
    if (original < 1 || timed < 1) return false;
    if (timed / original < (mode === "strict" ? 0.95 : 0.8)) return false;
    if (song.duration > 0 && lastEnd > 0) {
      if (lastEnd > song.duration + 10000) return false;
      if (lastEnd / song.duration < 0.5) return false;
    }
    return true;
  } catch (_) { return false; }
}
function lrParseTtmlTime(value) {
  var s = lrString(value).trim();
  if (!s) return 0;
  var m = s.match(/^(\d+):(\d\d):(\d\d)(?:\.(\d+))?$/);
  if (m) return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Math.round(Number("0." + (m[4] || "0")) * 1000);
  m = s.match(/^(\d+):(\d\d)(?:\.(\d+))?$/);
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Math.round(Number("0." + (m[3] || "0")) * 1000);
  m = s.match(/^(\d+(?:\.\d+)?)s$/);
  if (m) return Math.round(Number(m[1]) * 1000);
  m = s.match(/^(\d+(?:\.\d+)?)ms$/);
  if (m) return Math.round(Number(m[1]));
  // lrc.red serializes TTML clock values as bare fractional seconds, e.g. 16.906.
  m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return Math.round(Number(m[1]) * 1000);
  return 0;
}
function lrTrackMeta(details, hit) {
  var d = details || {}, h = hit || {};
  return {
    isrc: lrIsrc(d.isrc || h.isrc),
    title: lrString(d.title || h.title),
    artist: lrString(d.artist || h.artist),
    album: lrString(d.album || h.album),
    released: lrString(d.released || d.date || h.released),
    year: lrString(d.year || h.year),
    duration: d.duration || h.duration || 0,
    byModel: d.byModel,
    source: typeof d.source === "string" ? d.source : ""
  };
}
function lrGetTrack(state, isrc, hit) {
  var key = "track." + isrc;
  var cached = lrCacheGet(key);
  if (cached && cached.length <= LR_TTML_LIMIT + LR_JSON_LIMIT) {
    try {
      var obj = JSON.parse(cached);
      if (obj && obj.isrc === isrc && typeof obj.rawTtml === "string") return obj;
    } catch (_) { /* stale invalid cache */ }
  }
  var base = LR_BASE + "/s/" + isrc;
  var songDoc = lrGetJson(state, base + ".song.json");
  var meta = lrTrackMeta(songDoc, hit);
  var ttml = meta.source;
  if (!ttml) {
    var moreMeta = lrGetJson(state, base + ".json");
    meta = lrTrackMeta(moreMeta, meta);
    ttml = lrGetText(state, base + ".ttml");
  }
  if (!ttml || ttml.length > LR_TTML_LIMIT) return null;
  var out = {isrc: isrc, meta: meta, rawTtml: lrNormalizeTtml(ttml)};
  // Never poison the positive cache with a broken or non-word-timed payload.
  if (!lrTtmlCheck(out.rawTtml, {duration: 0}, "balanced")) return null;
  if (out.rawTtml.length <= 262144) lrCacheSet(key, JSON.stringify(out), LR_CACHE_TTL_MS);
  return out;
}
function lrCandidate(record, song, mode) {
  if (!record) return null;
  var meta = record.meta || {};
  if (!lrValidateIdentity(song, meta, mode)) return null;
  if (!lrTtmlCheck(record.rawTtml, song, mode)) return null;
  var title = lrString(meta.title), artist = lrString(meta.artist);
  var album = lrString(meta.album || song.album).trim();
  var date = lrString(meta.released || meta.year || song.date).trim();
  if (!title || !artist || !album || !date) return null; // API 5: mandatory candidate judgement tags.
  var sourceUrl = LR_BASE + "/s/" + record.isrc;
  return {
    type: "rawTtml",
    tags: {
      ti: title,
      ar: artist,
      al: album,
      date: date,
      source: "lrc.red",
      url: sourceUrl
    },
    rawTtml: record.rawTtml
  };
}
function lrFindCandidates(state, song, mode, url) {
  var obj = lrGetJson(state, url);
  return obj && Array.isArray(obj.hits) ? lrRankHits(obj.hits, song, mode) : [];
}
function lrTryRanks(state, ranks, song, mode, output, seen) {
  for (var i = 0; i < ranks.length && output.length < 2; i++) {
    if (lrDeadline(state) || state.rateLimited) break;
    var item = ranks[i];
    if (seen[item.isrc]) continue;
    if (i > 0 && ranks[0] && item.score < ranks[0].score - 25) break;
    seen[item.isrc] = true;
    var track = lrGetTrack(state, item.isrc, item.hit);
    var result = lrCandidate(track, song, mode);
    if (result) output.push(result);
    if (i >= 2) break; // at most three remote candidates per search strategy.
  }
}
function getLyrics(request) {
  var email = lrContact(request);
  if (!email) {
    lrLog("warn", "Configure a valid contact email in the LrcRed Lyrics plugin settings");
    return [];
  }
  var song = lrSongContext(request);
  if (!song.title || !song.artist) {
    lrLog("warn", "Song requires title and artist");
    return [];
  }
  if (!Platform || !Platform.http || typeof Platform.http.get !== "function" ||
      !Platform.xml || typeof Platform.xml.findElements !== "function") {
    lrLog("warn", "Lyrico Host HTTP/XML API is unavailable; upgrade the application");
    return [];
  }
  var mode = lrConfig(request, "match_mode", "balanced") === "strict" ? "strict" : "balanced";
  var fallback = lrConfig(request, "search_fallback", "true") !== "false";
  var state = {email: email, requests: 0, deadline: lrNow() + LR_BUDGET_MS, rateLimited: false};
  var results = [], seen = {};
  try {
    if (song.isrc) {
      var direct = lrCandidate(lrGetTrack(state, song.isrc, {isrc: song.isrc}), song, mode);
      if (direct) results.push(direct);
      seen[song.isrc] = true;
    }
    if (!results.length && !lrDeadline(state)) {
      var params = "track=" + encodeURIComponent(song.title) + "&artist=" + encodeURIComponent(song.artist);
      if (song.album) params += "&album=" + encodeURIComponent(song.album);
      if (song.duration > 0) params += "&duration=" + Math.round(song.duration / 1000);
      lrTryRanks(state, lrFindCandidates(state, song, mode, LR_BASE + "/match.json?" + params), song, mode, results, seen);
    }
    if (!results.length && fallback && !lrDeadline(state) && !state.rateLimited) {
      var search = encodeURIComponent(song.title + " " + song.artist);
      lrTryRanks(state, lrFindCandidates(state, song, mode, LR_BASE + "/search.json?q=" + search), song, mode, results, seen);
    }
  } catch (err) {
    lrLog("warn", "Lookup failed safely: " + lrString(err && err.message ? err.message : err).slice(0, 120));
  }
  lrLog("debug", "getLyrics done; results=" + results.length + ", requests=" + state.requests +
    ", elapsedMs=" + (LR_BUDGET_MS - (state.deadline - lrNow())));
  return results;
}
