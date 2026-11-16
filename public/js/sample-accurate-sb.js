/*
 * Sample-accurate SourceBuffer for gapless Opus playback through MSE.
 *
 * Drop-in for any MSE player that plays a queue by appending track after track
 * into ONE SourceBuffer (timestampOffset + appendWindowStart per track). Set
 * SampleAccurateSB.enabled = true before the player calls addSourceBuffer().
 * For an Opus type it then returns an object with the SourceBuffer API
 * (appendBuffer, remove, abort, buffered, updating, timestampOffset,
 * appendWindowStart/End, changeType, updateend/error events). Behind it:
 *
 *   1. the player's WebM appends are parsed and stored, still compressed;
 *   2. close to the playhead each cluster is decoded (with pre-roll from the
 *      previous cluster), the Opus pre-skip and end padding are trimmed by
 *      sample count, and consecutive tracks are snapped together to the sample;
 *   3. the PCM goes into the player's own MediaSource as lossless FLAC in
 *      fragmented MP4, through a real 'audio/mp4; codecs="flac"' SourceBuffer.
 *
 * Limits, as a drop-in: appendWindowStart/End are accepted but ignored (it
 * trims by sample count instead), and a seek back into a cluster that was
 * partly evicted is not refilled; clear the buffer with remove() and append
 * again from there, as QueuePlayer.reset() does. SampleAccurateSB.supported()
 * says whether it can work at all (it needs FLAC in fragmented MP4 in MSE);
 * without it addSourceBuffer() returns a plain SourceBuffer.
 *
 * The player, its queue and its media element are untouched; only the last
 * hop into MSE changes. buffered is reported in the player's own coordinates,
 * so its buffering logic keeps working. Needs flac-mp4.js (window.GaplessMux).
 *
 * MIT licence, see LICENSE.
 */
(function (global) {
  'use strict';
  var MS = global.MediaSource;
  var G = global.GaplessMux;
  var API = global.SampleAccurateSB = { enabled: false, onLog: null, supported: function () { return false; } };
  if (!MS || !G) return;
  var SR = 48000, EB = G.EBML, FLAC_MIME = 'audio/mp4; codecs="flac"';
  var SNAP = 0.25 * SR;                 // tracks placed this close together are joined exactly
  var AHEAD = 5;                        // seconds of PCM kept ahead in the real SourceBuffer
  var ID_EBML = 0x1A45DFA3;
  API.supported = function () { try { return MS.isTypeSupported(FLAC_MIME); } catch (e) { return false; } };

  function log(m) { if (API.onLog) API.onLog(m); else console.log('[sample-accurate] ' + m); }

  var urlToMs = new Map(), proxyOf = new WeakMap(), proxiesOf = new WeakMap();
  var origCreate = URL.createObjectURL;
  URL.createObjectURL = function (o) {
    var u = origCreate.apply(this, arguments);
    if (o instanceof MS) urlToMs.set(u, o);
    return u;
  };
  var origRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = function (u) { urlToMs.delete(u); return origRevoke.apply(this, arguments); };

  var decodeCtx = null;
  function ctx() { return decodeCtx || (decodeCtx = new OfflineAudioContext(2, 1, SR)); }
  function decode(bytes) {
    return new Promise(function (resolve, reject) {
      var p = ctx().decodeAudioData(bytes.buffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  function vint(b, p, keep) {
    if (p >= b.length) return null;
    var first = b[p], len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 8) throw new Error('bad EBML vint');
    if (p + len > b.length) return null;
    var v = keep ? first : (first & (mask - 1)), ones = (first & (mask - 1)) === mask - 1;
    for (var i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xFF) ones = false; }
    return { value: v, len: len, unknown: !keep && ones };
  }
  function concat(parts) {
    var n = 0, i; for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), p = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
    return out;
  }
  // Walk the direct children of an EBML master in b[start, end).
  function children(b, start, end, fn) {
    for (var p = start; p < end; ) {
      var id = vint(b, p, true), sz = vint(b, p + id.len, false);
      var data = p + id.len + sz.len, stop = sz.unknown ? end : Math.min(end, data + sz.value);
      fn(id.value, p, data, stop, id.len, sz.len);
      p = stop;
    }
  }
  function fakeRanges(list) {
    return { length: list.length, start: function (i) { return list[i][0]; }, end: function (i) { return list[i][1]; } };
  }
  function domError(name, msg) { try { return new DOMException(msg, name); } catch (e) { var x = new Error(msg); x.name = name; return x; } }

  // ------------------------------------------------------------------ proxy
  class WrappedSourceBuffer extends EventTarget {
    constructor(ms, real) {
      super();
      this.ms = ms; this.real = real; this.dead = false;
      this.updating = false; this.mode = 'segments';
      this._tso = 0; this._aws = 0; this._awe = Infinity;
      this.acc = new Uint8Array(0);
      this.init = null;          // current track: {head, preskip, scale, delta, tso, maxAbs1, n}
      this.prev = null;          // previous cluster of the current track (pre-roll + contiguity)
      this.lastTrackEnd = null;  // abs sample where the previous track's audio ended
      this.segs = [];            // {abs0, abs1, raw0, n, bytes, pre, head, sent, ver}
      this.ops = Promise.resolve();
      this.busy = false; this.seq = 1; this.frameNo = 0; this.ahead = AHEAD;
      this.appendGen = 0;        // bumped by abort(): a scheduled append that was aborted must not complete
      this.stats = { tracks: 0, joins: [] };
      var self = this;
      this.queueReal(function () { real.appendBuffer(G.flacInit(SR)); });
      this.timer = setInterval(function () { self.feed(); }, 150);
      log('SourceBuffer wrapped: player sees Opus/WebM, MSE gets FLAC');
    }
    get timestampOffset() { return this._tso; }
    set timestampOffset(v) { if (v !== this._tso) log('timestampOffset = ' + v); this._tso = +v; }
    get appendWindowStart() { return this._aws; }
    set appendWindowStart(v) { if (v !== this._aws) log('appendWindowStart = ' + v + ' (ignored: trimming is sample-exact here)'); this._aws = +v; }
    get appendWindowEnd() { return this._awe; }
    set appendWindowEnd(v) { if (v !== this._awe) log('appendWindowEnd = ' + v + ' (ignored)'); this._awe = +v; }
    get buffered() {
      // Reported in the player's own coordinates (where it placed the data, before
      // our trimming and snapping), so its buffer bookkeeping sees what a native
      // SourceBuffer would report. Playback itself follows the snapped timeline.
      var s = this.segs.filter(function (g) { return g.e1 > g.e0; }).map(function (g) { return [g.e0 / SR, g.e1 / SR]; });
      s.sort(function (a, b) { return a[0] - b[0]; });
      var out = [];
      s.forEach(function (r) {
        var l = out[out.length - 1];
        if (l && r[0] <= l[1] + 0.02) l[1] = Math.max(l[1], r[1]); else out.push([r[0], r[1]]);
      });
      return fakeRanges(out);
    }
    fire(names) { var self = this; names.forEach(function (n) { self.dispatchEvent(new Event(n)); }); }
    changeType(type) { log('changeType(' + type + ') ignored'); }

    appendBuffer(data) {
      if (this.dead) throw domError('InvalidStateError', 'SourceBuffer removed');
      if (this.updating) throw domError('InvalidStateError', 'updating');
      var bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.acc = concat([this.acc, bytes]);          // copies: the player may reuse its buffer
      this.updating = true;
      var self = this, gen = ++this.appendGen;
      if (this.ms.__eosPending) this.ms.__eosPending = false;
      setTimeout(function () {
        if (self.dead || gen !== self.appendGen) return;   // aborted (or removed) before it ran
        self.fire(['updatestart']);
        if (self.dead || gen !== self.appendGen) return;   // aborted from an updatestart listener
        try { self.parse(); self.updating = false; self.fire(['update', 'updateend']); }
        catch (e) { log('parse error: ' + e.message); self.acc = new Uint8Array(0); self.updating = false; self.fire(['error', 'updateend']); }
        self.feed();
      }, 0);
    }

    abort() {
      log('player abort()');
      this.acc = new Uint8Array(0); this.prev = null; this.appendGen++;
      if (this.updating) { this.updating = false; this.fire(['abort', 'updateend']); }
    }

    remove(start, end) {
      if (this.dead) throw domError('InvalidStateError', 'SourceBuffer removed');
      if (this.updating) throw domError('InvalidStateError', 'updating');
      log('player remove(' + (+start).toFixed(3) + ', ' + (end === Infinity ? 'Inf' : (+end).toFixed(3)) + ')');
      this.updating = true;
      var a = Math.round(start * SR), b = end === Infinity ? Infinity : Math.round(end * SR), self = this;
      var lo = Infinity, hi = -Infinity, keep = [], dmax = 0;
      this.segs.forEach(function (g) {                       // player coordinates → ours: + g.d
        if (g.e1 <= a || g.e0 >= b) { keep.push(g); return; }
        dmax = Math.max(dmax, Math.abs(g.d));
        lo = Math.min(lo, g.abs0); hi = Math.max(hi, g.abs1);
        g.ver++; g.sent = false;
        if (g.e0 < a) keep.push(Object.assign({}, g, { e1: a, abs1: Math.min(g.abs1, a + g.d), ver: 0 }));
        if (g.e1 > b) keep.push(Object.assign({}, g, { e0: b, abs0: Math.max(g.abs0, b + g.d), ver: 0 }));
      });
      this.segs = keep.filter(function (g) { return g.e1 > g.e0; }).sort(function (x, y) { return x.abs0 - y.abs0; });
      this.progress = null;
      // Drop the real buffer over the affected span (generously); what survives gets re-sent.
      var r0 = Math.max(0, Math.min(start, lo / SR) - dmax / SR - 0.1);
      var r1 = end === Infinity ? Infinity : Math.max(end, hi / SR) + dmax / SR + 0.1;
      this.segs.forEach(function (g) { if (g.sent && g.abs1 > r0 * SR && g.abs0 < r1 * SR) g.sent = false; });
      this.queueReal(function () { if (r1 > r0 && realState(self.ms) !== 'ended') { self.real.remove(Math.max(0, r0), r1); return true; } return false; })
        .then(function () { self.updating = false; self.fire(['update', 'updateend']); self.feed(); });
    }

    // Serialise every operation on the real SourceBuffer.
    queueReal(fn) {
      var real = this.real, self = this;
      this.ops = this.ops.then(function () {
        if (self.dead) return;
        return new Promise(function (resolve) {
          var started;
          try { started = fn(); } catch (e) { log('real SourceBuffer: ' + e.name + ' ' + e.message); resolve(e); return; }
          if (started === false || !real.updating) { resolve(); return; }
          var error = false;
          function failed() { error = true; }
          real.addEventListener('error', failed, { once: true });
          real.addEventListener('updateend', function () { real.removeEventListener('error', failed); resolve(error ? { error: true } : undefined); }, { once: true });
        });
      });
      return this.ops;
    }

    // ---------------------------------------------------------- WebM parsing
    parse() {
      var b = this.acc, p = 0;
      for (;;) {
        var id = vint(b, p, true); if (!id) break;
        var sz = vint(b, p + id.len, false); if (!sz) break;
        var data = p + id.len + sz.len;
        if (id.value === EB.Segment) { p = data; continue; }          // descend without waiting for its end
        if (sz.unknown) throw new Error('unknown-size element 0x' + id.value.toString(16));
        var end = data + sz.value;
        if (end > b.length) break;                                   // wait for the rest
        var el = b.slice(p, end);
        if (id.value === ID_EBML) this.pendingHead = { ebml: el };
        else if (id.value === EB.Info && this.pendingHead) this.pendingHead.info = el;
        else if (id.value === EB.Tracks && this.pendingHead) { this.pendingHead.tracks = el; this.startTrack(this.pendingHead); this.pendingHead = null; }
        else if (id.value === EB.Cluster) { if (this.init) this.cluster(el); }
        p = end;
      }
      this.acc = b.slice(p);
    }

    startTrack(h) {
      var scale = 1e6, codecDelayNs = 0, preskip = 0;
      children(h.info, vint(h.info, 0, true).len + vint(h.info, vint(h.info, 0, true).len, false).len, h.info.length, function (id, p, d, s) {
        if (id === EB.TimecodeScale) scale = G.readUint(h.info, d, s - d);
      });
      var tr = h.tracks;
      (function walk(start, end) {
        children(tr, start, end, function (id, p, d, s, il, sl) {
          if (id === EB.TrackEntry) walk(d, s);
          else if (id === EB.CodecDelay) { codecDelayNs = G.readUint(tr, d, s - d); G.voidOut(tr, p, il, sl, s - d); }
        });
      })(vint(tr, 0, true).len + vint(tr, vint(tr, 0, true).len, false).len, tr.length);
      for (var i = 0; i + 12 <= tr.length; i++) {                     // OpusHead pre-skip → 0
        if (tr[i] === 0x4F && tr[i + 1] === 0x70 && tr[i + 2] === 0x75 && tr[i + 3] === 0x73 && tr[i + 4] === 0x48 && tr[i + 5] === 0x65) {
          preskip = tr[i + 10] | (tr[i + 11] << 8); tr[i + 10] = 0; tr[i + 11] = 0; break;
        }
      }
      if (codecDelayNs) preskip = Math.round(codecDelayNs * 48e-6);
      var segHdr = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
      // An init with no clusters yet (a player may re-send headers after its own
      // seek) must not wipe out where the previous track's audio ended.
      if (this.init && this.init.maxAbs1 !== null) this.lastTrackEnd = this.init.maxAbs1;
      this.init = { head: concat([h.ebml, segHdr, h.info, tr]), preskip: preskip, scale: scale, delta: 0, tso: null, maxAbs1: null };
      this.prev = null;
      this.stats.tracks++;
      log('track init #' + this.stats.tracks + ': pre-skip ' + preskip + ' samples');
    }

    cluster(c) {
      var t = this.init, scale = t.scale, tc = 0, first = null, n = 0, pad = 0;
      var hdrLen = vint(c, 0, true).len + vint(c, vint(c, 0, true).len, false).len;
      function block(d) {
        var track = vint(c, d, false), q = d + track.len;
        var rel = G.readInt(c, q, 2);
        if (first === null) first = (tc + rel) * scale / 1e9;
        n += G.opusPacketSamples(c, q + 3);
      }
      children(c, hdrLen, c.length, function (id, p, d, s) {
        if (id === EB.Timecode) tc = G.readUint(c, d, s - d);
        else if (id === EB.SimpleBlock) block(d);
        else if (id === EB.BlockGroup) children(c, d, s, function (id2, p2, d2, s2, il, sl) {
          if (id2 === EB.Block) block(d2);
          else if (id2 === EB.DiscardPadding) { pad = Math.round(G.readInt(c, d2, s2 - d2) * 48e-6); G.voidOut(c, p2, il, sl, s2 - d2); }
        });
      });
      if (first === null || !n) return;
      if (t.tso !== this._tso) { t.tso = this._tso; t.delta = 0; this.prev = null; }
      var raw0, isFirst = first <= 0.001;
      var pv = this.prev;
      if (pv && Math.abs(first - pv.endTs) < 0.002) raw0 = pv.raw0 + pv.n;
      else raw0 = Math.round((this._tso + first) * SR) + t.delta;
      var front = isFirst ? t.preskip : 0;
      if (isFirst) {                                         // first audible sample of the track
        var p0 = raw0 + front;
        if (this.lastTrackEnd !== null && Math.abs(p0 - this.lastTrackEnd) < SNAP) {
          var d = this.lastTrackEnd - p0;
          t.delta += d; raw0 += d;
          this.stats.joins.push(d);
          log('join: track ' + this.stats.tracks + ' snapped by ' + d + ' samples (' + (d / 48).toFixed(2) + ' ms) onto the previous track\'s last sample');
        }
      }
      var abs0 = raw0 + front, abs1 = raw0 + n - pad;
      if (pad) log('track end: trimmed ' + pad + ' samples of padding; audio ends at ' + (abs1 / SR).toFixed(6) + ' s');
      var seg = { e0: raw0 - t.delta, e1: raw0 - t.delta + n, d: t.delta, abs0: abs0, abs1: abs1, raw0: raw0, n: n, bytes: c, head: t.head, pre: pv && pv.raw0 + pv.n === raw0 ? pv : null, sent: false, ver: 0 };
      this.prev = { bytes: c, raw0: raw0, n: n, endTs: first + n / SR };
      this.insert(seg);
      if (t.maxAbs1 === null || abs1 > t.maxAbs1) t.maxAbs1 = abs1;
    }

    insert(seg) {
      var keep = [], lo = Infinity, hi = -Infinity;
      this.segs.forEach(function (g) {                       // newer data replaces older (MSE rule)
        if (g.abs1 <= seg.abs0 || g.abs0 >= seg.abs1) { keep.push(g); return; }
        if (g.sent) { lo = Math.min(lo, g.abs0); hi = Math.max(hi, g.abs1); }
        g.ver++;
        if (g.abs0 < seg.abs0) keep.push(Object.assign({}, g, { abs1: seg.abs0, e1: Math.min(g.e1, seg.abs0 - g.d), sent: false, ver: 0 }));
        if (g.abs1 > seg.abs1) keep.push(Object.assign({}, g, { abs0: seg.abs1, e0: Math.max(g.e0, seg.abs1 - g.d), sent: false, ver: 0 }));
      });
      keep.push(seg);
      if (this.progress && this.segs.indexOf(this.progress.seg) >= 0 && keep.indexOf(this.progress.seg) < 0) this.progress = null;
      this.segs = keep.sort(function (x, y) { return x.abs0 - y.abs0; });
      if (hi > lo) { var self = this; this.queueReal(function () { self.real.remove(lo / SR, hi / SR); }); }
    }

    // ------------------------------------------------- feeding the real buffer
    element() {
      if (this.el && this.el.isConnected !== false) return this.el;
      var ms = this.ms, els = document.querySelectorAll('audio,video');
      for (var i = 0; i < els.length; i++) if (urlToMs.get(els[i].src) === ms) return (this.el = els[i]);
      return null;
    }
    // Hands the stored audio to MSE in ~1 s slices: the Chromecast Audio's MSE
    // quota (~2 MB = ~10 s of 16-bit stereo) can't take a whole cluster at once.
    feed() {
      if (this.dead || this.busy || this.real.updating || Date.now() < (this.backoff || 0)) return;
      var el = this.element(), t = el ? el.currentTime : 0, self = this;
      var rb; try { rb = this.real.buffered; } catch (e) { return; }
      this.stallReport(el, t, rb);
      // Once the stream has ended, touching the real buffer would reopen the
      // MediaSource and the element would wait for more audio forever.
      if (rb.length && rb.start(0) < t - 2.5 && realState(this.ms) !== 'ended') {  // evict what has been played
        var cut = t - 1.5;
        this.segs.forEach(function (g) { if (g.sent && g.abs1 <= cut * SR) { g.sent = false; g.pcm = null; } });
        if (this.progress && this.progress.seg.abs1 <= cut * SR) this.progress = null;
        this.busy = true;
        this.queueReal(function () { self.real.remove(0, cut); }).then(function () { self.busy = false; self.feed(); });
        return;
      }
      var seg = null;
      for (var i = 0; i < this.segs.length; i++) {
        var g = this.segs[i];
        if (!g.sent && g.abs1 > g.abs0 && g.abs1 > t * SR - SR * 0.05) { seg = g; break; }
      }
      if (!seg) {
        if (this.ms.__eosPending && realState(this.ms) === 'open' && !this.owed()) {
          this.ms.__eosPending = false; log('all audio handed to MSE; endOfStream()');
          try { origEos.call(this.ms); } catch (e) { log('endOfStream: ' + e.message); }
        }
        return;
      }
      var from = this.progress && this.progress.seg === seg ? this.progress.to : seg.abs0;
      if (from > (t + this.ahead) * SR) return;
      var ver = seg.ver;
      if (!seg.pcm) {                                       // decode the cluster once
        this.busy = true;
        this.render(seg).then(function (pcm) {
          if (!self.dead && seg.ver === ver) seg.pcm = pcm;
          self.busy = false; self.feed();
        }).catch(function (e) {
          // Keep the timeline moving: this cluster plays as silence instead of stalling everything after it.
          log('ERROR decoding the cluster at ' + (seg.abs0 / SR).toFixed(3) + ' s failed (' + (e && e.message || e) + '); it plays as silence');
          if (!self.dead && seg.ver === ver) seg.pcm = { L: new Float32Array(seg.n), R: null, base: -seg.raw0 };
          if (seg.pcm) seg.pcm.R = seg.pcm.L;
          self.busy = false; self.feed();
        });
        return;
      }
      var to = Math.min(seg.abs1, from + SR), bytes = this.slice(seg, from, to), started = false;
      this.busy = true;
      this.queueReal(function () {
        if (self.dead || seg.ver !== ver) return false;
        try { self.real.appendBuffer(bytes); started = true; }
        catch (e) {
          self.backoff = Date.now() + 300;
          if (e.name === 'QuotaExceededError') {
            if (self.ahead > 2) { self.ahead = Math.max(2, self.ahead - 0.5); log('MSE full; keeping at most ' + self.ahead.toFixed(1) + ' s ahead in the real buffer'); }
          } else self.appendFailed(e.name + ' ' + e.message);
          return false;
        }
      }).then(function (r) {
        self.busy = false;
        if (!started) return self.feed();
        if (r && r.error) return self.appendFailed('the real SourceBuffer rejected the segment');
        self.failures = 0;                                  // delivered: only now does it count
        if (seg.ver === ver) {
          self.progress = { seg: seg, to: to };
          if (to >= seg.abs1) { seg.sent = true; seg.pcm = null; self.progress = null; }
        }
        self.feed();
      });
    }
    // A FLAC segment didn't make it into MSE. Try again a few times, then end the
    // stream with an error, so the element (and whoever plays it) reports it
    // instead of waiting for audio forever.
    appendFailed(why) {
      this.failures = (this.failures || 0) + 1;
      if (this.failures < 3 && realState(this.ms) === 'open') { log('FLAC append failed (' + why + '); retrying'); this.backoff = Date.now() + 500; this.feed(); return; }
      log('ERROR FLAC append failed (' + why + '); giving up, ending the stream with an error');
      this.destroy();
      try { if (realState(this.ms) === 'open') origEos.call(this.ms, 'decode'); } catch (e) {}
    }
    // While the element is starved, say once every 2 s what each side holds.
    stallReport(el, t, rb) {
      if (!el || el.paused || el.readyState >= 3) { this.starved = 0; return; }
      var now = Date.now();
      if (!this.starved) { this.starved = now; return; }
      if (now - this.starved < 1000 || now < (this.nextReport || 0)) return;
      this.nextReport = now + 2000;
      function fmt(r) { var o = []; for (var i = 0; i < r.length; i++) o.push(r.start(i).toFixed(3) + '-' + r.end(i).toFixed(3)); return o.join(' ') || 'none'; }
      var unsent = this.segs.filter(function (g) { return !g.sent && g.abs1 > g.abs0; });
      log('STALL at ' + t.toFixed(3) + ' s (readyState ' + el.readyState + ', seeking ' + el.seeking + '): MSE has ' + fmt(rb) + '; player sees ' + fmt(this.buffered) +
        '; ' + unsent.length + ' clusters not yet handed over' + (unsent.length ? ' (first ' + (unsent[0].abs0 / SR).toFixed(3) + ' s)' : '') +
        '; lastTrackEnd ' + (this.lastTrackEnd === null ? 'none' : (this.lastTrackEnd / SR).toFixed(3)) + '; ms ' + realState(this.ms) + ', duration ' + this.ms.duration);
    }
    render(seg) {
      var parts = [seg.head];
      if (seg.pre) parts.push(seg.pre.bytes);
      parts.push(seg.bytes);
      var self = this;
      return decode(concat(parts)).then(function (ab) {
        var expect = (seg.pre ? seg.pre.n : 0) + seg.n;
        if (ab.length !== expect && !self.warned) { self.warned = true; log('decoder returned ' + ab.length + ' samples, expected ' + expect + ' (aligning on the end)'); }
        var base = ab.length - seg.n - seg.raw0;            // decoded index = abs sample + base
        var L = ab.getChannelData(0), R = ab.numberOfChannels > 1 ? ab.getChannelData(1) : L;
        return { L: L, R: R, base: base };
      });
    }
    slice(seg, from, to) {
      var p = seg.pcm, frames = [], sizes = [], durs = [], B = G.FLAC_BLOCK;
      for (var o = from; o < to; o += B) {
        var k = Math.min(B, to - o), f = G.flacFrame(p.L, p.R, o + p.base, k, this.frameNo++ & 0xFFFFF, 10);
        frames.push(f); sizes.push(f.length); durs.push(k);
      }
      return G.flacSegment(this.seq++, from, frames, sizes, durs);
    }
    // Audio still to hand to MSE before the stream can end. Clusters already
    // played and evicted from the real buffer don't count (they come back only
    // after a seek backwards, which reopens the stream anyway).
    owed() {
      var el = this.element(), lim = ((el ? el.currentTime : 0) - 0.05) * SR;
      return this.segs.some(function (g) { return !g.sent && g.abs1 > g.abs0 && g.abs1 > lim; });
    }
    destroy() { this.dead = true; this.appendGen++; clearInterval(this.timer); this.segs = []; this.prev = null; this.acc = new Uint8Array(0); }
  }

  // ------------------------------------------------------- MediaSource hooks
  var origAdd = MS.prototype.addSourceBuffer, origRemoveSb = MS.prototype.removeSourceBuffer, origEos = MS.prototype.endOfStream;
  MS.prototype.addSourceBuffer = function (type) {
    if (!API.enabled || !/opus/i.test(type)) return origAdd.call(this, type);
    if (!MS.isTypeSupported(FLAC_MIME)) { log('no MSE FLAC support; not wrapping'); return origAdd.call(this, type); }
    var real = origAdd.call(this, FLAC_MIME), p = new WrappedSourceBuffer(this, real);
    proxyOf.set(real, p);
    (proxiesOf.get(this) || proxiesOf.set(this, []).get(this)).push(p);
    this.addEventListener('sourceclose', function () { p.destroy(); }, { once: true });
    return p;
  };
  MS.prototype.removeSourceBuffer = function (sb) {
    if (sb instanceof WrappedSourceBuffer) { sb.destroy(); return origRemoveSb.call(this, sb.real); }
    return origRemoveSb.call(this, sb);
  };
  MS.prototype.endOfStream = function (err) {
    var list = proxiesOf.get(this);
    if (!err && list && list.some(function (p) { return !p.dead && p.owed(); })) {
      this.__eosPending = true; log('endOfStream() deferred until the wrapped buffer has handed over all audio');
      return;
    }
    return origEos.apply(this, arguments);
  };
  ['sourceBuffers', 'activeSourceBuffers'].forEach(function (k) {
    var d = Object.getOwnPropertyDescriptor(MS.prototype, k);
    if (!d || !d.get) return;
    Object.defineProperty(MS.prototype, k, { configurable: true, get: function () {
      var l = d.get.call(this), out = [];
      for (var i = 0; i < l.length; i++) out.push(proxyOf.get(l[i]) || l[i]);
      return out;
    } });
  });
  var rs = Object.getOwnPropertyDescriptor(MS.prototype, 'readyState');
  function realState(ms) { return rs && rs.get ? rs.get.call(ms) : ms.readyState; }
  if (rs && rs.get) Object.defineProperty(MS.prototype, 'readyState', { configurable: true, get: function () {
    var v = rs.get.call(this);
    return v === 'open' && this.__eosPending ? 'ended' : v;
  } });
  API.WrappedSourceBuffer = WrappedSourceBuffer;
})(window);
