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

  // Which element plays our stream. Normally the one we were given; when the
  // Cast framework loads the stream (opts.external), it sets the src itself, so
  // look for the element that holds our blob URL.
  QueuePlayer.prototype.element = function () {
    if (!this.external || !this.url) return this.el;
    var all = document.querySelectorAll('audio, video');
    for (var i = 0; i < all.length; i++) if (all[i].src === this.url) return all[i];
    return this.el;
  };

  // tracks: [{ url, title, duration (s) }]; starts at tracks[startIndex], startOffset s into it.
  // perTrack: the stock, non-gapless way instead: every track gets its own
  // fresh MediaSource, loaded when the previous one has ended.
  // opts.external: don't attach the MediaSource to the element; whoever loads
  // this.url (the Cast framework) does, and it also starts playback.
  QueuePlayer.prototype.play = function (tracks, startIndex, startOffset, perTrack, opts) {
    opts = opts || {};
    this.stop(!!opts.external);
    var self = this, ms = new MediaSource();
    this.external = !!opts.external; this.perTrack = !!perTrack;
    this.ms = ms; this.sb = null;
    this.url = URL.createObjectURL(ms);
    this.onEnded = function () {
      if (ms !== self.ms) return;
      if (perTrack && !self.external && startIndex + 1 < tracks.length) {
        self.emit('log', 'track ended: new MediaSource for the next track (stock behaviour)');
        self.play(tracks, startIndex + 1, 0, true);
      } else {                                // (external: whoever loaded us loads the next track)
        self.emit('ended', { perTrack: !!perTrack, index: startIndex });
        if (!self.external) self.stop();
      }
    };
    ms.addEventListener('sourceopen', function () {
      if (ms !== self.ms) return;
      var el = self.element();
      el.addEventListener('ended', self.onEnded); self.endedEl = el;
      self.sb = ms.addSourceBuffer(MIME);
      self.run(perTrack ? tracks.slice(startIndex, startIndex + 1) : tracks.slice(startIndex), startIndex, startOffset, 0);
      if (!self.external) el.play().catch(function (e) { self.emit('log', 'play(): ' + e.message); });
    }, { once: true });
    if (!this.external) this.el.src = this.url;
    var playingIndex = -1;
    this.timer = setInterval(function () {
      if (ms !== self.ms || !self.offsets) return;
      var at = self.position();
      if (!at) return;
      if (at.index !== playingIndex) { playingIndex = at.index; self.emit('track', { index: at.index, title: tracks[at.index].title }); }
      self.emit('time', { index: at.index, position: at.position, duration: tracks[at.index].duration });
    }, 250);
  };

  // Continue in the same MediaSource and SourceBuffer from another point:
  // clear the buffer and lay the queue out again further along the timeline.
  // The element and whatever owns it (the Cast framework) never see a new
  // source, only a seek. Returns false when there is nothing to reuse.
  QueuePlayer.prototype.reset = function (tracks, startIndex, startOffset) {
    var ms = this.ms, sb = this.sb, self = this;
    if (!ms || !sb || this.perTrack || ms.readyState === 'closed') return false;
    this.gen++;                                               // the running pump stops at its next step
    var gen = this.gen;
    function idle() { return sb.updating ? new Promise(function (r) { sb.addEventListener('updateend', function () { r(); }, { once: true }); }) : Promise.resolve(); }
    try { sb.abort(); } catch (e) {}
    idle().then(function () {
      if (gen !== self.gen) return;
      var el = self.element();
      var base = Math.ceil(Math.max(isFinite(ms.duration) ? ms.duration : 0, el.currentTime)) + 1;
      return new Promise(function (r) {
        sb.addEventListener('updateend', function () { r(); }, { once: true });
        try { sb.remove(0, Infinity); } catch (e) { r(); }
      }).then(function () {
        if (gen !== self.gen) return;
        self.emit('log', 'restart in place at track ' + (startIndex + 1) + ', ' + (startOffset || 0).toFixed(1) + ' s');
        self.run(tracks.slice(startIndex), startIndex, startOffset, base);
      });
    }).catch(function (e) { self.emit('error', 'reset: ' + (e.message || e)); });
    return true;
  };

  // Append list (album tracks from startIndex on) starting at timeline position base.
  QueuePlayer.prototype.run = function (list, startIndex, startOffset, base) {
    var self = this, gen = ++this.gen, ms = this.ms, sb = this.sb;
    var offsets = [], t0 = base;
    list.forEach(function (t) { offsets.push(t0); t0 = Math.round((t0 + t.duration) * 1000) / 1000; });
    this.list = list; this.offsets = offsets; this.base = startIndex;
    var cur = -1, files = [], current = null, next = 0, eos = false;
    var seekTo = base + (startOffset || 0);  // applied once data can be positioned
    function alive() { return gen === self.gen && ms === self.ms; }
    function el() { return self.element(); }
    function load(i) {
      if (!files[i]) {
        files[i] = fetch(list[i].url).then(function (r) {
          if (!r.ok) throw new Error(list[i].url + ': HTTP ' + r.status);
          return r.arrayBuffer();
        }).then(index);
        files[i].catch(function () { files[i] = null; });  // a failed fetch is retried by the next load(i)
      }
      return files[i];
    }
    async function loadNow(i) {                              // the track we need now: a few tries
      for (var n = 0; ; n++) {
        try { return await load(i); }
        catch (e) {
          if (n >= 2 || !alive()) throw e;
          self.emit('log', 'fetch failed (' + e.message + '), retrying');
          await sleep(1000 * (n + 1));
          if (!alive()) throw e;                              // stopped or restarted meanwhile: don't fetch for the old queue
        }
      }
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
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    async function pump() {
      // the whole queue, so a start offset is seekable (grows on every in-place restart)
      // (a wrapped SourceBuffer's real buffer may still be busy, and then MSE refuses a new duration: wait)
      for (var tries = 0; !(ms.duration >= t0) && alive(); tries++) {
        try { ms.duration = t0; } catch (e) { if (e.name !== 'InvalidStateError' || tries >= 50) throw e; await sleep(100); }
      }
      while (alive()) {
        var e = el();
        if (seekTo && e.readyState >= 1) { e.currentTime = seekTo; seekTo = 0; }
        var t = Math.max(e.currentTime, seekTo), r = buffered();
        // evict behind the playhead (not after endOfStream(): a remove would reopen the stream)
        if (!eos && r.length && r.start(0) < t - BEHIND - 5) { await remove(0, t - BEHIND); continue; }
        if (eos || aheadOf(t) > AHEAD) { await sleep(250); continue; }
        if (!current || next >= current.clusters.length) {               // start the next track
          if (cur + 1 >= list.length) { eos = true; ms.endOfStream(); self.emit('log', 'all tracks appended; endOfStream()'); continue; }
          cur++;
          current = await loadNow(cur); if (!alive()) return;
          if (cur + 1 < list.length) load(cur + 1).catch(function () {});  // prefetch (retried when needed)
          sb.abort();
          sb.timestampOffset = offsets[cur];
          sb.appendWindowStart = offsets[cur];
          await append(current.header); if (!alive()) return;
          next = 0;
          if (cur === 0 && startOffset) {                                 // seek: begin at the cluster holding startOffset
            while (next + 1 < current.clusters.length && current.clusters[next + 1].time <= startOffset) next++;
          }
          continue;
        }
        var c = current.clusters[next];
        try { await append(new Uint8Array(current.bytes, c.start, c.end - c.start)); next++; }
        catch (err) {
          if (!alive()) return;
          if (err.name === 'QuotaExceededError') { await sleep(500); continue; }
          throw err;
        }
      }
    }
    pump().catch(function (e) { if (alive()) self.emit('error', e.message || String(e)); });
  };

  // Where playback is now: { index, position } in album terms, or null when stopped.
  QueuePlayer.prototype.position = function () {
    if (!this.offsets || !this.ms) return null;
    var t = this.element().currentTime, o = this.offsets, i = 0;
    if (t < o[0] - 0.5) return { index: this.base, position: 0 };       // a restart that hasn't been positioned yet
    while (i + 1 < o.length && o[i + 1] <= t) i++;
    return { index: this.base + i, position: Math.max(0, t - o[i]) };
  };

  // keepElement: leave the element alone (the Cast framework owns it and loads the next source itself).
  QueuePlayer.prototype.stop = function (keepElement) {
    this.gen++;
    clearInterval(this.timer);
    if (this.onEnded && this.endedEl) this.endedEl.removeEventListener('ended', this.onEnded);
    this.onEnded = null; this.endedEl = null; this.offsets = null;
    var wasExternal = this.external, sb = this.sb, url = this.url;
    this.ms = null; this.sb = null; this.url = null;
    if (!keepElement && !wasExternal && this.el.src) { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); }
    // Let the old stream go: a sample-accurate buffer stops its timer and drops
    // its audio; the blob URL is no longer needed (an attached MediaSource keeps
    // playing without it, and whoever loads the next source gets a new one).
    if (sb && sb.destroy) sb.destroy();
    if (url) URL.revokeObjectURL(url);
  };
  QueuePlayer.prototype.pause = function () { this.element().pause(); };
  QueuePlayer.prototype.resume = function () { this.element().play(); };

  global.QueuePlayer = QueuePlayer;
})(window);
