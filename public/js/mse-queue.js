/*
 * A deliberately ordinary MSE queue player: the same pattern a streaming
 * player's gapless queue mode uses.
 *
 *   - one MediaSource and ONE SourceBuffer for the whole queue;
 *   - each track's WebM is appended at timestampOffset = where the previous
 *     track ends (its duration, rounded to the millisecond), with
 *     appendWindowStart at the same point;
 *   - data is fetched and appended cluster by cluster (using the file's Cues),
 *     a few tens of seconds ahead of the playhead, and evicted behind it.
 *
 * Nothing here knows about encoder delay or padding. With plain MSE that
 * leaves a small gap or click at every track change (more on a Chromecast).
 * Turn on SampleAccurateSB.enabled before play() and the same code becomes
 * sample-accurate, because only the SourceBuffer underneath changes.
 * play(..., perTrack = true) is the stock comparison: one MediaSource per
 * track, the next one loaded after 'ended', so every boundary has a gap.
 *
 * MIT licence, see LICENSE.
 */
(function (global) {
  'use strict';
  var X = global.GaplessMux, EB = X.EBML;
  var AHEAD = 30, BEHIND = 10;            // seconds of compressed audio kept around the playhead
  var MIME = 'audio/webm; codecs="opus"';

  // Header bytes plus each cluster's byte range and start time, from the Cues.
  function index(bytes) {
    var b = new Uint8Array(bytes), p = 0, segData = -1, cues = [], scale = 1e6, firstCluster = -1, durationMs = 0;
    var id = X.vint(b, 0, true), sz = X.vint(b, id.len, false);
    p = id.len + sz.len + sz.value;                                 // skip the EBML header
    id = X.vint(b, p, true); sz = X.vint(b, p + id.len, false);
    if (id.value !== EB.Segment) throw new Error('no Segment');
    segData = p + id.len + sz.len; p = segData;
    while (p < b.length) {
      id = X.vint(b, p, true); sz = X.vint(b, p + id.len, false);
      var d = p + id.len + sz.len, end = d + sz.value;
      if (id.value === EB.Cluster) { firstCluster = p; break; }
      if (id.value === EB.Info) walk(d, end, function (cid, cd, cend) {
        if (cid === EB.TimecodeScale) scale = X.readUint(b, cd, cend - cd);
        if (cid === 0x4489) durationMs = cend - cd === 8 ? new DataView(bytes, cd, 8).getFloat64(0) : new DataView(bytes, cd, 4).getFloat32(0);
      });
      if (id.value === EB.Cues) walk(d, end, function (cid, cd, cend) {
        if (cid !== 0xBB) return;                                   // CuePoint
        var cue = {};
        walk(cd, cend, function (k, kd, kend) {
          if (k === 0xB3) cue.time = X.readUint(b, kd, kend - kd);
          if (k === 0xB7) walk(kd, kend, function (q, qd, qend) { if (q === 0xF1) cue.pos = X.readUint(b, qd, qend - qd); });
        });
        cues.push(cue);
      });
      p = end;
    }
    function walk(s, e, fn) {
      for (var q = s; q < e; ) {
        var i = X.vint(b, q, true), z = X.vint(b, q + i.len, false), dd = q + i.len + z.len;
        fn(i.value, dd, dd + z.value); q = dd + z.value;
      }
    }
    if (firstCluster < 0 || !cues.length) throw new Error('WebM without Cues / Clusters');
    var clusters = cues.map(function (c, i) {
      var start = segData + c.pos, stop = i + 1 < cues.length ? segData + cues[i + 1].pos : b.length;
      return { start: start, end: stop, time: c.time * scale / 1e9 };
    });
    return { header: bytes.slice(0, firstCluster), clusters: clusters, bytes: bytes, duration: durationMs * scale / 1e9 };
  }

  function QueuePlayer(el, onEvent) {
    this.el = el; this.emit = onEvent || function () {};
    this.gen = 0;
  }

  // tracks: [{ url, title, duration (s) }]; starts at tracks[startIndex], startOffset s into it.
  // perTrack: the stock, non-gapless way instead: every track gets its own
  // fresh MediaSource, loaded when the previous one has ended.
  QueuePlayer.prototype.play = function (tracks, startIndex, startOffset, perTrack) {
    this.stop();
    var self = this, gen = ++this.gen, el = this.el;
    startIndex = startIndex || 0;
    var list = perTrack ? tracks.slice(startIndex, startIndex + 1) : tracks.slice(startIndex), offsets = [], t0 = 0;
    list.forEach(function (t) { offsets.push(t0); t0 = Math.round((t0 + t.duration) * 1000) / 1000; });
    this.list = list; this.offsets = offsets; this.base = startIndex;
    this.onEnded = function () {
      if (!alive()) return;
      if (perTrack && startIndex + 1 < tracks.length) {
        self.emit('log', 'track ended: new MediaSource for the next track (stock behaviour)');
        self.play(tracks, startIndex + 1, 0, true);
      } else { self.emit('ended', {}); self.stop(); }
    };
    el.addEventListener('ended', this.onEnded);
    var ms = new MediaSource(), sb = null, cur = -1, files = [], current = null, next = 0, eos = false, playingIndex = -1;
    var seekTo = startOffset || 0;          // applied once the first init segment is in
    el.src = URL.createObjectURL(ms);
    this.ms = ms;
    function alive() { return gen === self.gen; }
    function load(i) {
      if (!files[i]) files[i] = fetch(list[i].url).then(function (r) {
        if (!r.ok) throw new Error(list[i].url + ': HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(index);
      return files[i];
    }
    function buffered() { try { return sb.buffered; } catch (e) { return { length: 0 }; } }
    function aheadOf(t) { var r = buffered(); for (var i = 0; i < r.length; i++) if (r.end(i) > t && r.start(i) <= t + 0.5) return r.end(i) - t; return 0; }
    function append(bytes) {
      return new Promise(function (resolve, reject) {
        function done() { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); resolve(); }
        function fail() { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); reject(new Error('append error')); }
        sb.addEventListener('updateend', done); sb.addEventListener('error', fail);
        try { sb.appendBuffer(bytes); } catch (e) { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); reject(e); }
      });
    }
    function remove(a, b) {
      return new Promise(function (resolve) {
        sb.addEventListener('updateend', function () { resolve(); }, { once: true });
        sb.remove(a, b);
      });
    }
    async function pump() {
      while (alive()) {
        if (seekTo && el.readyState >= 1) { el.currentTime = seekTo; seekTo = 0; }
        var t = Math.max(el.currentTime, seekTo), r = buffered();
        if (r.length && r.start(0) < t - BEHIND - 5) { await remove(0, t - BEHIND); continue; }
        if (eos || aheadOf(t) > AHEAD) { await sleep(250); continue; }
        if (!current || next >= current.clusters.length) {               // start the next track
          if (cur + 1 >= list.length) { eos = true; ms.endOfStream(); self.emit('log', 'all tracks appended; endOfStream()'); continue; }
          cur++;
          current = await load(cur); if (!alive()) return;
          if (cur + 1 < list.length) load(cur + 1);                       // prefetch
          sb.abort();
          sb.timestampOffset = offsets[cur];
          sb.appendWindowStart = offsets[cur];
          await append(current.header);
          next = 0;
          if (cur === 0 && startOffset) {                                 // seek: begin at the cluster holding startOffset
            while (next + 1 < current.clusters.length && current.clusters[next + 1].time <= startOffset) next++;
          }
          continue;
        }
        var c = current.clusters[next];
        try { await append(new Uint8Array(current.bytes, c.start, c.end - c.start)); next++; }
        catch (e) {
          if (e.name === 'QuotaExceededError') { await sleep(500); continue; }
          throw e;
        }
      }
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    ms.addEventListener('sourceopen', function () {
      if (!alive()) return;
      ms.duration = t0;                     // the whole queue, so a start offset is seekable
      sb = ms.addSourceBuffer(MIME);
      pump().catch(function (e) { if (alive()) self.emit('error', e.message || String(e)); });
      el.play().catch(function (e) { self.emit('log', 'play(): ' + e.message); });
    }, { once: true });
    this.timer = setInterval(function () {
      if (!alive()) return;
      var t = el.currentTime, i = 0;
      while (i + 1 < offsets.length && offsets[i + 1] <= t) i++;
      if (i !== playingIndex) { playingIndex = i; self.emit('track', { index: self.base + i, title: list[i].title }); }
      self.emit('time', { index: self.base + i, position: t - offsets[i], duration: list[i].duration });
    }, 250);
  };

  // Where playback is now: { index, position } in album terms, or null when stopped.
  QueuePlayer.prototype.position = function () {
    if (!this.offsets || !this.el.src) return null;
    var t = this.el.currentTime, o = this.offsets, i = 0;
    while (i + 1 < o.length && o[i + 1] <= t) i++;
    return { index: this.base + i, position: Math.max(0, t - o[i]) };
  };

  QueuePlayer.prototype.stop = function () {
    this.gen++;
    clearInterval(this.timer);
    if (this.onEnded) { this.el.removeEventListener('ended', this.onEnded); this.onEnded = null; }
    if (this.el.src) { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); }
  };
  QueuePlayer.prototype.pause = function () { this.el.pause(); };
  QueuePlayer.prototype.resume = function () { this.el.play(); };

  global.QueuePlayer = QueuePlayer;
})(window);
