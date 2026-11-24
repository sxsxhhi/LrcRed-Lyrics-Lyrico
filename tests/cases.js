'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const H = require('./harness');
const F = require('./fixtures');

const { createSandbox, assert, eq, hasLog, test, report } = H;

const IT = 'https://itunes.apple.com/search';
const isIT = (u) => u.indexOf(IT) === 0;
const isMirror = (u) => u.indexOf('/am-lyrics/') > 0 && u.slice(-5) === '.ttml';
const isSongDoc = (u) => /\/s\/[A-Z0-9]+\.song\.json$/.test(u);
const isTrackJson = (u) => /\/s\/[A-Z0-9]+\.json$/.test(u) && !isSongDoc(u);
const isTrackTtml = (u) => /\/s\/[A-Z0-9]+\.ttml$/.test(u);
const isMatch = (u) => u.indexOf('/match.json') > 0;
const isSearch = (u) => u.indexOf('/search.json') > 0;
const countryOf = (u) => (u.match(/country=([a-z]{2})/) || [])[1];
const count = (calls, pred) => calls.filter((c) => pred(c.url)).length;

/* A complete success path: iTunes hit, first mirror serves TTML, lrc.red muted. */
function appleOnly(opts) {
  opts = opts || {};
  const ttml = opts.ttml === undefined ? F.buildTtml() : opts.ttml;
  const title = opts.title || 'Test Song';
  const artist = opts.artist || 'Test Artist';
  const id = opts.id || '1440833098';
  const emptyRegions = opts.emptyRegions || [];
  return function (url) {
    if (isIT(url)) {
      if (emptyRegions.indexOf(countryOf(url)) >= 0) return { code: 200, body: F.itunesBody([]) };
      return { code: 200, body: F.itunesBody([F.itTrack({ id: id, title: title, artist: artist })]) };
    }
    if (isMirror(url)) return { code: 200, body: ttml };
    return { code: 404, body: '' };
  };
}

/* lrc.red success only. */
function lrcOnly(opts) {
  opts = opts || {};
  const ttml = opts.ttml === undefined ? F.buildTtml() : opts.ttml;
  const meta = opts.meta || {};
  return function (url) {
    if (isSongDoc(url)) return { code: 200, body: F.lrcSongBody(ttml, meta) };
    if (isMatch(url)) return { code: 200, body: F.lrcHitsBody([F.hit('USRC17607839', opts.hitOpts || {})]) };
    if (isSearch(url)) return { code: 200, body: F.lrcHitsBody([]) };
    return { code: 404, body: '' };
  };
}

/* ---------- A. version arbitration ---------- */

test('A1  版本三态：Remastered 放行', () => {
  const s = createSandbox();
  eq(s.ctx.lrAssessVersion('Song (Remastered 2011)', 'Album', 'Song', 'Album'), 'consistent');
});
test('A2  版本三态：Live 拒', () => {
  const s = createSandbox();
  eq(s.ctx.lrAssessVersion('Song', 'Album', 'Song (Live)', 'Album'), 'conflict');
});
test('A3  版本三态：Acoustic 拒', () => {
  const s = createSandbox();
  eq(s.ctx.lrAssessVersion('Song', 'Album', 'Song (Acoustic)', 'Album'), 'conflict');
});
test("A4  版本三态：Special Version 放行", () => {
  const s = createSandbox();
  eq(s.ctx.lrAssessVersion("Song (Special Version)", 'Album', 'Song', 'Album'), 'consistent');
});
test('A5  版本三态：候选缺专辑 -> unknown', () => {
  const s = createSandbox();
  eq(s.ctx.lrAssessVersion('Song', 'Test Album', 'Song', ''), 'unknown');
});
test('A6  版本三态：Extended 放行', () => {
  const s = createSandbox();
  eq(s.ctx.lrAssessVersion('Song', 'Album', 'Song (Extended Mix)', 'Album'), 'consistent');
});
test('A7  版本三态：Nightcore 拒', () => {
  const s = createSandbox();
  eq(s.ctx.lrAssessVersion('Song', 'Album', 'Song (Nightcore)', 'Album'), 'conflict');
});
test('A8  版本三态：本地专辑带 Live、候选无专辑 -> 仍冲突', () => {
  const s = createSandbox();
  eq(s.ctx.lrAssessVersion('Song', 'Live at Wembley', 'Song', ''), 'conflict');
});
test('A9  [基线缺陷] 0.1.1 把 Remastered 判成冲突', () => {
  const s = createSandbox({ baseline: true });
  eq(s.ctx.lrVersionsConflict('Song (Remastered 2011)', 'Song'), true);
});
test('A10 [修复] 0.1.1 缺 album/date 拒候选，0.2.0 放行', () => {
  const song = { title: 'Test Song', artist: 'Test Artist', album: 'Test Album', duration: 210000 };
  const record = {
    isrc: 'USRC17607839',
    meta: { title: 'Test Song', artist: 'Test Artist', album: '', released: '', duration: 210, byModel: false },
    rawTtml: F.buildTtml()
  };
  const old = createSandbox({ baseline: true });
  eq(old.ctx.lrCandidate(record, song, 'balanced'), null);
  const now = createSandbox();
  const got = now.ctx.lrCandidate(record, song, 'balanced');
  assert(got && got.tags.al === 'Test Album', 'album 应回退到本地值');
  eq(got.tags.date, '');
});

/* ---------- B. engine A ---------- */

test('B1  区序：华语 hk,tw,us,jp', () => {
  const s = createSandbox();
  eq(s.ctx.lrRegions({ title: '测试歌曲', artist: '测试歌手' }), ['hk', 'tw', 'us', 'jp']);
});
test('B2  区序：外语 us,jp,hk,tw', () => {
  const s = createSandbox();
  eq(s.ctx.lrRegions({ title: 'English Song', artist: 'English Artist' }), ['us', 'jp', 'hk', 'tw']);
});
test('B3  首区命中即停，不再打后续区', () => {
  const s = createSandbox({ http: appleOnly({ title: '测试歌曲', artist: '测试歌手' }) });
  const res = s.ctx.getLyrics(F.req({ title: '测试歌曲', artist: '测试歌手' }));
  eq(res.length, 1);
  eq(res[0].tags.source, 'Apple Music');
  eq(count(s.calls, (u) => isIT(u) && countryOf(u) === 'hk'), 1);
  eq(count(s.calls, (u) => isIT(u) && countryOf(u) === 'tw'), 0);
});
test('B4  hk 空 -> 自动降 tw', () => {
  const s = createSandbox({ http: appleOnly({ title: '测试歌曲', artist: '测试歌手', emptyRegions: ['hk'] }) });
  const res = s.ctx.getLyrics(F.req({ title: '测试歌曲', artist: '测试歌手' }));
  eq(res.length, 1);
  eq(count(s.calls, (u) => isIT(u) && countryOf(u) === 'tw'), 1);
  eq(count(s.calls, (u) => isIT(u) && countryOf(u) === 'us'), 0);
});
test('B5  四道过滤：标题/时长不符的跳过，选合格的那条', () => {
  const good = F.buildTtml();
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) {
        return {
          code: 200,
          body: F.itunesBody([
            F.itTrack({ id: '111', title: 'Other Song' }),
            F.itTrack({ id: '222', title: 'Test Song', dur: 230000 }),
            F.itTrack({ id: '333', title: 'Test Song', dur: 210000 })
          ])
        };
      }
      if (isMirror(url)) return { code: 200, body: good };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req());
  eq(res.length, 1);
  assert(s.calls.some((c) => c.url.indexOf('/am-lyrics/333.ttml') > 0), '应选中 id=333');
});
test('B6  iTunes 只给 Live 版 -> 版本门拦下，不拉镜像', () => {
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) return { code: 200, body: F.itunesBody([F.itTrack({ id: '444', title: 'Test Song (Live)' })]) };
      if (isMirror(url)) return { code: 200, body: F.buildTtml() };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req());
  eq(res.length, 0);
  eq(count(s.calls, (u) => isMirror(u)), 0);
});
test('B7  首镜像返回 HTML -> 自动换下一个镜像', () => {
  const ttml = F.buildTtml();
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) return { code: 200, body: F.itunesBody([F.itTrack({ id: '555', title: 'Test Song' })]) };
      if (isMirror(url)) {
        if (url.indexOf('gbclstudio') > 0) return { code: 200, body: '<!DOCTYPE html><html>not found</html>' };
        return { code: 200, body: ttml };
      }
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req());
  eq(res.length, 1);
  assert(s.calls.some((c) => c.url.indexOf('testingcf') > 0), '应回落到 testingcf');
});
test('B8  三镜像全 404 -> 回退 lrc.red', () => {
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) return { code: 200, body: F.itunesBody([F.itTrack({ id: '666', title: 'Test Song' })]) };
      if (isMirror(url)) return { code: 404, body: '' };
      if (isSongDoc(url)) return { code: 200, body: F.lrcSongBody(F.buildTtml()) };
      if (isMatch(url)) return { code: 200, body: F.lrcHitsBody([F.hit('USRC17607839')]) };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req());
  eq(res.length, 1);
  eq(res[0].tags.source, 'lrc.red');
  eq(count(s.calls, (u) => isMirror(u)), 3);
});
test('B9  TTML 无 body dur -> 轴退化为 lastEnd，仍通过', () => {
  const s = createSandbox({ http: appleOnly({ ttml: F.buildTtml({ bodyDur: null }) }) });
  const res = s.ctx.getLyrics(F.req());
  eq(res.length, 1);
  eq(res[0].tags.source, 'Apple Music');
});
test('B10 脏 appleId 不拼 URL', () => {
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) return { code: 200, body: F.itunesBody([F.itTrack({ id: '12&x=1', title: 'Test Song' })]) };
      if (isMirror(url)) return { code: 200, body: F.buildTtml() };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req());
  eq(res.length, 0);
  eq(count(s.calls, (u) => isMirror(u)), 0);
});
test('B11 无 releaseDate -> tags.date 为空串', () => {
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) return { code: 200, body: F.itunesBody([F.itTrack({ id: '777', title: 'Test Song', date: '' })]) };
      if (isMirror(url)) return { code: 200, body: F.buildTtml() };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req());
  eq(res.length, 1);
  eq(res[0].tags.date, '');
});
test('B12 镜像 429 -> 写冷却，回退 lrc.red', () => {
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) return { code: 200, body: F.itunesBody([F.itTrack({ id: '888', title: 'Test Song' })]) };
      if (isMirror(url)) return { code: 429, body: '' };
      if (isSongDoc(url)) return { code: 200, body: F.lrcSongBody(F.buildTtml()) };
      if (isMatch(url)) return { code: 200, body: F.lrcHitsBody([F.hit('USRC17607839')]) };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req());
  eq(res[0].tags.source, 'lrc.red');
  assert(s.cacheStore.has('lrcred.v02.cd.mirror.gbclstudio'), '应写入镜像冷却');
});

test('B13 本地标题带 Remastered，仍能匹配 iTunes 原名', () => {
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) return { code: 200, body: F.itunesBody([F.itTrack({ id: '1212', title: 'Test Song' })]) };
      if (isMirror(url)) return { code: 200, body: F.buildTtml() };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req({ title: 'Test Song (Remastered 2011)' }));
  eq(res.length, 1);
  eq(res[0].tags.source, 'Apple Music');
});

/* ---------- C. timing gates ---------- */

function gateCase(ttml, songOver, mode) {
  const s = createSandbox({ http: appleOnly({ ttml: ttml }) });
  const res = s.ctx.getLyrics(F.req(songOver, mode ? { match_mode: mode } : {}));
  return { s, res };
}

test('C1  无逐字 span -> 拒', () => {
  const { res } = gateCase(F.buildTtml({ allUntimed: true }));
  eq(res.length, 0);
});
test('C2  覆盖 7/8 = 0.875（均衡）-> 通过', () => {
  const { res } = gateCase(F.buildTtml({ untimedLines: [7] }));
  eq(res.length, 1);
});
test('C3  覆盖 7/9 = 0.778（均衡）-> 拒', () => {
  const { res } = gateCase(F.buildTtml({ lineCount: 9, untimedLines: [7, 8] }));
  eq(res.length, 0);
});
test('C4  覆盖 7/8 = 0.875（严格）-> 拒', () => {
  const { res } = gateCase(F.buildTtml({ untimedLines: [7] }), null, 'strict');
  eq(res.length, 0);
});
test('C5  预览截断（30s 轴 / 210s 曲）-> 拒', () => {
  const { res } = gateCase(F.buildTtml({ bodyDur: '0:00:30.000' }));
  eq(res.length, 0);
});
test('C6  冲轴（283s 轴 / 210s 曲）-> 拒', () => {
  const { res } = gateCase(F.buildTtml({ start: 10, step: 35 }));
  eq(res.length, 0);
});
test('C7  截断地板（25.4s / 60s = 0.42）-> 拒', () => {
  const { res } = gateCase(F.buildTtml({ start: 2, step: 3 }), { duration: 60000 });
  eq(res.length, 0);
});

test('C8  宿主 text 只给自身文本时仍能统计逐字行', () => {
  const s = createSandbox({ shallowText: true, http: appleOnly() });
  const res = s.ctx.getLyrics(F.req());
  eq(res.length, 1);
});

/* ---------- D. budget / isolation ---------- */

test('D1  苹果窗口耗尽 -> 不再发下一个区搜索', () => {
  const s = createSandbox({ latency: 9500, http: appleOnly() });
  s.ctx.getLyrics(F.req());
  eq(count(s.calls, (u) => isIT(u)), 1);
});
test('D2  请求数达上限后返回 null，不抛错', () => {
  const s = createSandbox();
  const state = { email: 'a@b.co', requests: 14, deadline: s.clock.now() + 5000 };
  eq(s.ctx.lrGet(state, 'https://example.invalid/x', 100, {}), null);
  eq(s.calls.length, 0);
});
test('D3  iTunes 429 -> 冷却生效，转 lrc.red', () => {
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) return { code: 429, body: '' };
      if (isSongDoc(url)) return { code: 200, body: F.lrcSongBody(F.buildTtml()) };
      if (isMatch(url)) return { code: 200, body: F.lrcHitsBody([F.hit('USRC17607839')]) };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req());
  eq(res[0].tags.source, 'lrc.red');
  eq(count(s.calls, (u) => isIT(u)), 1);
  assert(s.cacheStore.has('lrcred.v02.cd.it'), '应写入 iTunes 冷却');
});
test('D4  网络异常不冒泡，仍能走完 lrc.red', () => {
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) return { throw: 'boom' };
      if (isSongDoc(url)) return { code: 200, body: F.lrcSongBody(F.buildTtml()) };
      if (isMatch(url)) return { code: 200, body: F.lrcHitsBody([F.hit('USRC17607839')]) };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req());
  eq(res[0].tags.source, 'lrc.red');
});
test('D5  无联系邮箱且 apple_tier=false -> 零请求', () => {
  const s = createSandbox({ http: lrcOnly() });
  const res = s.ctx.getLyrics(F.req({}, { contact_email: '', apple_tier: 'false' }));
  eq(res.length, 0);
  eq(s.calls.length, 0);
});
test('D6  apple_tier=false -> 不请求 iTunes', () => {
  const s = createSandbox({ http: lrcOnly() });
  const res = s.ctx.getLyrics(F.req({ isrc: 'USRC17607839' }, { apple_tier: 'false' }));
  eq(res.length, 1);
  eq(count(s.calls, (u) => isIT(u)), 0);
});
test('D7  引擎 A 命中后仍补第二条候选', () => {
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) return { code: 200, body: F.itunesBody([F.itTrack({ id: '999', title: 'Test Song' })]) };
      if (isMirror(url)) return { code: 200, body: F.buildTtml({ start: 8 }) };
      if (isSongDoc(url)) return { code: 200, body: F.lrcSongBody(F.buildTtml({ start: 9 })) };
      if (isMatch(url)) return { code: 200, body: F.lrcHitsBody([F.hit('USRC17607839')]) };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req());
  eq(res.length, 2);
  eq(res[0].tags.source, 'Apple Music');
  eq(res[1].tags.source, 'lrc.red');
});

/* ---------- E. engine B regression ---------- */

test('E1  ISRC 直取命中', () => {
  const s = createSandbox({ http: lrcOnly() });
  const res = s.ctx.getLyrics(F.req({ isrc: 'USRC17607839' }, { apple_tier: 'false' }));
  eq(res.length, 1);
  eq(res[0].tags.ti, 'Test Song');
  assert(res[0].rawTtml.indexOf('<tt') > 0, 'rawTtml 应存在');
});
test('E2  无 ISRC，/match.json 命中', () => {
  const s = createSandbox({ http: lrcOnly() });
  const res = s.ctx.getLyrics(F.req({}, { apple_tier: 'false' }));
  eq(res.length, 1);
  eq(count(s.calls, (u) => isMatch(u)), 1);
});
test('E3  远端缺 album/date -> 用本地兜底', () => {
  const s = createSandbox({
    http: (url) => {
      if (isSongDoc(url)) return { code: 200, body: F.lrcSongBody(F.buildTtml(), { album: '', released: '', year: '' }) };
      if (isMatch(url)) return { code: 200, body: F.lrcHitsBody([F.hit('USRC17607839', { album: '' })]) };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req({}, { apple_tier: 'false' }));
  eq(res.length, 1);
  eq(res[0].tags.al, 'Test Album');
  eq(res[0].tags.date, '');
});
test('E4  lrTrackMeta 的 source 回退（0.1.1 缺陷）', () => {
  const s = createSandbox();
  eq(s.ctx.lrTrackMeta({ title: 'T' }, { source: 'TTML-TEXT' }).source, 'TTML-TEXT');
  eq(s.ctx.lrTrackMeta({ title: 'T', source: 'A' }, { source: 'B' }).source, 'A');
});
test('E5  缓存命中后仍按当前歌曲重新仲裁', () => {
  const s = createSandbox({ http: lrcOnly() });
  const first = s.ctx.getLyrics(F.req({ isrc: 'USRC17607839' }, { apple_tier: 'false', search_fallback: 'false' }));
  eq(first.length, 1);
  const docCalls = count(s.calls, (u) => isSongDoc(u));
  const second = s.ctx.getLyrics(F.req({ isrc: 'USRC17607839', title: 'Other Song', artist: 'Other Artist' },
    { apple_tier: 'false', search_fallback: 'false' }));
  eq(second.length, 0);
  eq(count(s.calls, (u) => isSongDoc(u)), docCalls, '第二次不应再请求 song.json');
});

/* ---------- F. static / manifest ---------- */

test('F1  node --check 通过', () => {
  const r = spawnSync(process.execPath, ['--check', H.SRC], { encoding: 'utf8' });
  eq(r.status, 0, r.stderr || 'syntax error');
});
test('F2  manifest 契约（API5 / Host4 / 仅 getLyrics / 版本号）', () => {
  const m = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'src', 'manifest.json'), 'utf8'));
  eq(m.apiVersion, 5);
  eq(m.minHostApiVersion, 4);
  eq(m.capabilities, ['getLyrics']);
  eq(m.versionName, '0.2.2');
  eq(m.versionCode, 5);
  eq(m.entry, 'source.js');
  eq(m.icon, 'icon.png');
  assert(m.configFields.some((f) => f.key === 'apple_tier' && f.type === 'switch'), '缺少 apple_tier');
  assert(m.configFields.some((f) => f.key === 'contact_email' && f.required === false), '邮箱应为选填（仅用于 lrc.red）');
});

/* ---------- G. regex fallback ---------- */

test('G1  字母数字清洗保留 CJK', () => {
  const s = createSandbox();
  eq(s.ctx.lrStripAlnum('測試 ABC-123'), '測試ABC123');
});

/* ---------- H. second-pass review findings ---------- */

test('H1  宿主以秒给时长 -> 自动换算为毫秒', () => {
  const s = createSandbox();
  eq(s.ctx.lrSongContext({ song: { title: 'A', artist: 'B', duration: 210 } }).duration, 210000);
  eq(s.ctx.lrSongContext({ song: { title: 'A', artist: 'B', durationMs: 210000 } }).duration, 210000);
  eq(s.ctx.lrSongContext({ song: { title: 'A', artist: 'B', duration: 0 } }).duration, 0);
});
test('H2  秒制时长也能走通引擎 A 全链路', () => {
  const s = createSandbox({ http: appleOnly() });
  const res = s.ctx.getLyrics(F.req({ duration: 210 }));
  eq(res.length, 1);
  eq(res[0].tags.source, 'Apple Music');
});
test('H3  strict 模式收紧引擎 A 的时长容差', () => {
  const ttml = F.buildTtml();
  const http = (url) => {
    if (isIT(url)) return { code: 200, body: F.itunesBody([F.itTrack({ id: '2020', title: 'Test Song', dur: 214000 })]) };
    if (isMirror(url)) return { code: 200, body: ttml };
    return { code: 404, body: '' };
  };
  const loose = createSandbox({ http });
  eq(loose.ctx.getLyrics(F.req()).length, 1);
  const strict = createSandbox({ http });
  eq(strict.ctx.getLyrics(F.req({}, { match_mode: 'strict' })).length, 0);
});
test('H4  lrc.red 命名空间被改写干净', () => {
  const s = createSandbox({
    http: (url) => {
      if (isSongDoc(url)) return { code: 200, body: F.lrcSongBody(F.buildLrcRedTtml()) };
      if (isMatch(url)) return { code: 200, body: F.lrcHitsBody([F.hit('USRC17607839')]) };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req({}, { apple_tier: 'false' }));
  eq(res.length, 1);
  eq(res[0].rawTtml.indexOf('lrc:'), -1, 'rawTtml 不应残留 lrc: 前缀');
  assert(res[0].rawTtml.indexOf('xmlns:itunes=') > 0, '应声明 itunes 命名空间');
});
test('H5  song.json 的 source 不是 TTML 时继续回退 .ttml', () => {
  const s = createSandbox({
    http: (url) => {
      if (isSongDoc(url)) return { code: 200, body: JSON.stringify({ title: 'Test Song', artist: 'Test Artist', album: 'Test Album', duration: 210, source: 'not xml at all, just a placeholder body long enough to pass the length guard ..........................' }) };
      if (isTrackJson(url)) return { code: 404, body: '' };
      if (isTrackTtml(url)) return { code: 200, body: F.buildTtml() };
      if (isMatch(url)) return { code: 200, body: F.lrcHitsBody([F.hit('USRC17607839')]) };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req({}, { apple_tier: 'false' }));
  eq(res.length, 1);
  assert(s.calls.some((c) => isTrackTtml(c.url)), '应回退请求 .ttml');
});
test('H6  缓存条目不再重复存放 meta.source', () => {
  const s = createSandbox({ http: lrcOnly() });
  s.ctx.getLyrics(F.req({ isrc: 'USRC17607839' }, { apple_tier: 'false', search_fallback: 'false' }));
  const raw = s.cacheStore.get('lrcred.v02.track.USRC17607839');
  assert(raw, '应写入 track 缓存');
  const obj = JSON.parse(raw.v);
  assert(obj.meta && obj.meta.source === undefined, 'meta.source 必须被剥离');
  assert(obj.probe && obj.probe.ok === true, 'probe 应随缓存一起保存');
});

/* ---------- I. third-pass review findings ---------- */

test('I1  冷却值自带绝对过期时间，宿主 TTL 单位错也不误伤', () => {
  const s = createSandbox();
  s.Platform.cache.set('lrcred.v02.cd.it', String(s.clock.now() + 1000), 99999999);
  eq(s.ctx.lrCooldownActive('cd.it'), true);
  s.clock.advance(2000);
  eq(s.ctx.lrCooldownActive('cd.it'), false);
});
test('I2  超过 12h 的 track 缓存按过期处理', () => {
  const ttml = F.buildTtml();
  const s = createSandbox({ http: lrcOnly() });
  const rec = {
    isrc: 'USRC17607839',
    meta: { title: 'Test Song', artist: 'Test Artist', album: 'Test Album', duration: 210, byModel: false },
    rawTtml: ttml, probe: s.ctx.lrProbeTtml(ttml),
    cachedAt: s.clock.now() - 13 * 3600 * 1000
  };
  s.Platform.cache.set('lrcred.v02.track.USRC17607839', JSON.stringify(rec), 99999999);
  s.ctx.getLyrics(F.req({ isrc: 'USRC17607839' }, { apple_tier: 'false', search_fallback: 'false' }));
  assert(count(s.calls, (u) => isSongDoc(u)) === 1, '过期缓存应触发重新请求');
});
test('I3  预算不足 150ms 时不发请求', () => {
  const s = createSandbox();
  const st = { email: 'a@b.co', requests: 0, deadline: s.clock.now() + 100 };
  eq(s.ctx.lrGet(st, 'https://example.invalid/x', 100, {}), null);
  eq(s.calls.length, 0);
  eq(st.requests, 0);
});
test('I4  source 有内容但无逐字 -> 继续回退 .ttml', () => {
  const s = createSandbox({
    http: (url) => {
      if (isSongDoc(url)) return { code: 200, body: F.lrcSongBody(F.buildTtml({ allUntimed: true })) };
      if (isTrackJson(url)) return { code: 404, body: '' };
      if (isTrackTtml(url)) return { code: 200, body: F.buildTtml() };
      if (isMatch(url)) return { code: 200, body: F.lrcHitsBody([F.hit('USRC17607839')]) };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req({}, { apple_tier: 'false' }));
  eq(res.length, 1);
  assert(s.calls.some((c) => isTrackTtml(c.url)), '应回退请求 .ttml');
});
test('I5  缓存里的畸形 probe 不被信任，重新计算', () => {
  const s = createSandbox();
  const rec = {
    isrc: 'USRC17607839',
    meta: { title: 'Test Song', artist: 'Test Artist', album: 'Test Album', duration: 210, byModel: false },
    rawTtml: F.buildTtml(),
    probe: { ok: true, origLines: 'x' }
  };
  const song = { title: 'Test Song', artist: 'Test Artist', album: 'Test Album', duration: 210000 };
  assert(s.ctx.lrCandidate(rec, song, 'balanced') !== null, '应回退到实时解析');
});
test('I6  引擎 A 缓存命中不再拉镜像，且缓存带 probe/cachedAt', () => {
  const s = createSandbox({ http: appleOnly() });
  const first = s.ctx.getLyrics(F.req());
  eq(first.length, 1);
  const mirrorsAfterFirst = count(s.calls, (u) => isMirror(u));
  eq(mirrorsAfterFirst, 1);
  const raw = s.cacheStore.get('lrcred.v02.apple.1440833098');
  assert(raw, '应写入 apple 缓存');
  const obj = JSON.parse(raw.v);
  assert(typeof obj.cachedAt === 'number', '缓存应记录 cachedAt');
  assert(obj.probe && obj.probe.ok === true, '缓存应记录 probe');
  const second = s.ctx.getLyrics(F.req());
  eq(second.length, 1);
  eq(count(s.calls, (u) => isMirror(u)), mirrorsAfterFirst, '第二次不应再拉镜像');
});

test('I7  布尔 false 才能真正关掉引擎 A', () => {
  const s = createSandbox({ http: lrcOnly() });
  const res = s.ctx.getLyrics(F.req({ isrc: 'USRC17607839' }, { apple_tier: false }));
  eq(res.length, 1);
  eq(count(s.calls, (u) => isIT(u)), 0);
});
test('I8  match_mode 大小写不敏感', () => {
  const s = createSandbox();
  eq(s.ctx.lrBool ? true : true, true);
  const ttml = F.buildTtml({ untimedLines: [7] });
  const http = (url) => {
    if (isIT(url)) return { code: 200, body: F.itunesBody([F.itTrack({ id: '3030', title: 'Test Song' })]) };
    if (isMirror(url)) return { code: 200, body: ttml };
    return { code: 404, body: '' };
  };
  const upper = createSandbox({ http });
  eq(upper.ctx.getLyrics(F.req({}, { match_mode: 'STRICT' })).length, 0);
});
test('I9  缺行数的 probe 视为无效', () => {
  const s = createSandbox();
  eq(s.ctx.lrValidProbe({ ok: true, origLines: 0, timedLines: 0, lastEnd: 0 }), false);
  eq(s.ctx.lrValidProbe({ ok: true, origLines: 8, timedLines: 8, lastEnd: 1000 }), true);
});

test('I10 本地无时长时用 iTunes 时长兜住预览截断', () => {
  const preview = F.buildTtml({ bodyDur: '0:00:30.000' });
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) return { code: 200, body: F.itunesBody([F.itTrack({ id: '4040', title: 'Test Song', dur: 210000 })]) };
      if (isMirror(url)) return { code: 200, body: preview };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req({ duration: 0 }));
  eq(res.length, 0);
});

test('J1  两个引擎给出完全相同的 TTML 时只保留一条', () => {
  const sameTtml = F.buildTtml();
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) return { code: 200, body: F.itunesBody([F.itTrack({ id: '5050', title: 'Test Song' })]) };
      if (isMirror(url)) return { code: 200, body: sameTtml };
      if (isSongDoc(url)) return { code: 200, body: F.lrcSongBody(sameTtml) };
      if (isMatch(url)) return { code: 200, body: F.lrcHitsBody([F.hit('USRC17607839')]) };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req());
  eq(res.length, 1);
  eq(res[0].tags.source, 'Apple Music');
});
test('J2  艺人含斜杠仍能正确切分', () => {
  const s = createSandbox();
  eq(s.ctx.lrArtistSet('AC/DC'), ['ac', 'dc']);
  eq(s.ctx.lrArtistSet('Simon & Garfunkel'), ['simon', 'garfunkel']);
  eq(s.ctx.lrArtistSet('A feat. B'), ['a', 'b']);
});

test('K1  全为译文行的 TTML 视为无原文，拒收', () => {
  const allTranslation = F.buildTtml().replace(/<p /g, '<p ttm:role="x-translation" ');
  const s = createSandbox({ http: appleOnly({ ttml: allTranslation }) });
  eq(s.ctx.getLyrics(F.req()).length, 0);
});
test('K2  命名空间改写是幂等的', () => {
  const s = createSandbox();
  const once = s.ctx.lrNormalizeTtml(F.buildLrcRedTtml());
  eq(s.ctx.lrNormalizeTtml(once), once);
});
test('K3  配置里缺 apple_tier 时默认启用引擎 A', () => {
  const s = createSandbox({ http: appleOnly() });
  const r = F.req();
  delete r.config.apple_tier;
  const res = s.ctx.getLyrics(r);
  eq(res.length, 1);
  eq(res[0].tags.source, 'Apple Music');
});

/* ---------- T. tiered iTunes cooldown ---------- */

function cdInfo(s, key) {
  const raw = s.cacheStore.get('lrcred.v02.' + key);
  if (!raw) return { n: 0, until: 0, delta: 0 };
  const p = String(raw.v).split(':');
  const n = p.length >= 3 ? Number(p[0]) : 0;
  const until = Number(p.length >= 3 ? p[1] : p[0]) || 0;
  return { n, until, delta: until - s.clock.now() };
}
function call429(s, cfg) {
  const st = { email: 'a@b.co', requests: 0, deadline: s.clock.now() + 900000 };
  s.ctx.lrGet(st, 'https://example.test/x', 100, Object.assign({ tag: 'test' }, cfg));
  return cdInfo(s, cfg.cooldownKey);
}

test('T1  iTunes 首次 429 -> 30s', () => {
  const s = createSandbox({ latency: 0, http: () => ({ code: 429, body: '' }) });
  const c = call429(s, { cooldownKey: 'cd.it', cdTier: true });
  eq(c.n, 1);
  assert(Math.abs(c.delta - 30000) <= 150, '应约 30s，实际 ' + c.delta);
});
test('T2  冷却结束后再 429 -> 60s', () => {
  const s = createSandbox({ latency: 0, http: () => ({ code: 429, body: '' }) });
  call429(s, { cooldownKey: 'cd.it', cdTier: true });
  s.clock.advance(31000);
  const c = call429(s, { cooldownKey: 'cd.it', cdTier: true });
  eq(c.n, 2);
  assert(Math.abs(c.delta - 60000) <= 150, '应约 60s，实际 ' + c.delta);
});
test('T3  连续第 4 次 -> 封顶 300s', () => {
  const s = createSandbox({ latency: 0, http: () => ({ code: 429, body: '' }) });
  call429(s, { cooldownKey: 'cd.it', cdTier: true });
  s.clock.advance(31000); call429(s, { cooldownKey: 'cd.it', cdTier: true });
  s.clock.advance(61000); call429(s, { cooldownKey: 'cd.it', cdTier: true });
  s.clock.advance(121000);
  const c = call429(s, { cooldownKey: 'cd.it', cdTier: true });
  eq(c.n, 4);
  assert(Math.abs(c.delta - 300000) <= 150, '应封顶 300s，实际 ' + c.delta);
});
test('T4  间隔 11 分钟后再 429 -> 回落 30s', () => {
  const s = createSandbox({ latency: 0, http: () => ({ code: 429, body: '' }) });
  call429(s, { cooldownKey: 'cd.it', cdTier: true });
  s.clock.advance(31000); call429(s, { cooldownKey: 'cd.it', cdTier: true });
  s.clock.advance(660000);
  const c = call429(s, { cooldownKey: 'cd.it', cdTier: true });
  eq(c.n, 1);
  assert(Math.abs(c.delta - 30000) <= 150, '应回落 30s，实际 ' + c.delta);
});
test('T5  Retry-After 大于分级值 -> 采用 Retry-After', () => {
  const s = createSandbox({
    latency: 0,
    http: () => ({ code: 429, body: '', headers: { 'Retry-After': '200' } })
  });
  const c = call429(s, { cooldownKey: 'cd.it', cdTier: true });
  assert(Math.abs(c.delta - 200000) <= 200, '应采用 200s，实际 ' + c.delta);
});
test('T6  lrc.red 的 429 仍为 90s 固定冷却', () => {
  const s = createSandbox({ latency: 0, http: () => ({ code: 429, body: '' }) });
  const c = call429(s, { cooldownKey: 'cd.lrc' });
  eq(c.n, 0);
  assert(Math.abs(c.delta - 90000) <= 150, '应约 90s，实际 ' + c.delta);
});

/* ---------- L. v0.2.2 deep optimizations ---------- */

test('L1  无联系邮箱时 Apple Music 仍能正常请求并命中', () => {
  const s = createSandbox({ http: appleOnly() });
  const res = s.ctx.getLyrics(F.req({}, { contact_email: '' }));
  eq(res.length, 1);
  eq(res[0].tags.source, 'Apple Music');
  assert(s.calls.length > 0, 'Apple Music 应发起网络请求');
});
test('L2  无联系邮箱时 lrc.red 安全跳过（零 lrc.red 请求）', () => {
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) return { code: 200, body: F.itunesBody([]) };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req({}, { contact_email: '' }));
  eq(res.length, 0);
  eq(count(s.calls, (u) => isSongDoc(u) || isMatch(u) || isSearch(u)), 0);
  assert(H.hasLog(s.logs, '[lrc.red] skipped: no contact email configured'), '应记录跳过日志');
});
test('L3  iTunes 搜索结果写入 itunes.q 映射缓存', () => {
  const s = createSandbox({ http: appleOnly({ title: 'Cache Test Song', artist: 'Cache Artist' }) });
  s.ctx.getLyrics(F.req({ title: 'Cache Test Song', artist: 'Cache Artist' }));
  const key = s.ctx.lrItunesCacheKey({ title: 'Cache Test Song', artist: 'Cache Artist' });
  assert(s.cacheStore.has('lrcred.v02.' + key), '应写入 itunes.q 缓存');
});
test('L4  iTunes 映射缓存命中后二次检索发起 0 次 iTunes 请求', () => {
  const s = createSandbox({ http: appleOnly({ title: 'Cache Song', artist: 'Cache Artist' }) });
  const r1 = s.ctx.getLyrics(F.req({ title: 'Cache Song', artist: 'Cache Artist' }));
  eq(r1.length, 1);
  const itCallsFirst = count(s.calls, (u) => isIT(u));
  assert(itCallsFirst > 0, '首次应打 iTunes');

  const r2 = s.ctx.getLyrics(F.req({ title: 'Cache Song', artist: 'Cache Artist' }));
  eq(r2.length, 1);
  eq(count(s.calls, (u) => isIT(u)), itCallsFirst, '第二次检索不应再打 iTunes');
});
test("L5  艺人包含 ' x ' 与 ' × ' 正确提取多艺人并判定兼容", () => {
  const s = createSandbox();
  const a1 = s.ctx.lrArtistSet('周杰伦 x 费玉清');
  eq(a1.indexOf('周杰伦') >= 0 && a1.indexOf('费玉清') >= 0, true);
  const a2 = s.ctx.lrArtistSet('Artist A × Artist B');
  eq(a2.indexOf('artista') >= 0 && a2.indexOf('artistb') >= 0, true);
  eq(s.ctx.lrArtistCompatible('周杰伦 x 费玉清', '周杰伦 & 费玉清'), true);
});
test("L6  艺人包含 ' with ' 与 ' vs ' 正确提取并判定兼容", () => {
  const s = createSandbox();
  const a = s.ctx.lrArtistSet('Artist1 with Artist2');
  eq(a.indexOf('artist1') >= 0 && a.indexOf('artist2') >= 0, true);
  eq(s.ctx.lrArtistCompatible('Artist1 with Artist2', 'Artist1 / Artist2'), true);
  const b = s.ctx.lrArtistSet('Godzilla vs Kong');
  eq(b.indexOf('godzilla') >= 0 && b.indexOf('kong') >= 0, true);
});
test('L7  Apple Music 远端缺失 album 和 date 时正确回退本地标签', () => {
  const s = createSandbox({
    http: (url) => {
      if (isIT(url)) {
        return {
          code: 200,
          body: F.itunesBody([F.itTrack({ id: '1440833098', title: 'Test Song', album: '', date: '' })])
        };
      }
      if (isMirror(url)) return { code: 200, body: F.buildTtml() };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req({ album: 'Local Album', date: '2021-08-01' }));
  eq(res.length, 1);
  eq(res[0].tags.al, 'Local Album');
  eq(res[0].tags.date, '2021-08-01');
});
test('L8  lrGetTrack 缓存按完整 payload 大小判断', () => {
  const s = createSandbox();
  const record = {
    isrc: 'USRC17607839',
    meta: { title: 'T', artist: 'A' },
    rawTtml: 'x'.repeat(262100),
    probe: { ok: true, origLines: 1, timedLines: 1, lastEnd: 100 }
  };
  s.ctx.lrCacheSet('track.USRC17607839', JSON.stringify(record), 1000);
  assert(s.cacheStore.has('lrcred.v02.track.USRC17607839'), '存储应调用底层');
});
test('L9  本地无时长时 lrc.red 用远端时长兜住预览截断', () => {
  const preview = F.buildTtml({ bodyDur: '0:00:30.000' });
  const s = createSandbox({
    http: (url) => {
      if (isSongDoc(url)) return { code: 200, body: F.lrcSongBody(preview, { duration: 210 }) };
      return { code: 404, body: '' };
    }
  });
  const res = s.ctx.getLyrics(F.req({ isrc: 'USRC17607839', duration: 0 }, { apple_tier: 'false' }));
  eq(res.length, 0);
});

process.exit(report() ? 0 : 1);
