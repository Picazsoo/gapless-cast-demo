/*
 * Opus bridge SourceBuffer: gapless Opus through MSE with almost no decoding.
 *
 * PROTOTYPE. Same drop-in idea as sample-accurate-sb.js (set
 * OpusBridgeSB.enabled = true before the player calls addSourceBuffer() with
 * an Opus/WebM type), but the real SourceBuffer stays Opus/WebM: the album
 * becomes ONE continuous Opus stream with one init segment. Packets pass
 * through untouched, except around each track join:
 *
 *   - the last KA packets of track A and the first KB packets of track B are
 *     decoded, A's end padding and B's pre-skip are cut by sample count, and
 *     the joined audio (stretched by well under 1% so that its length is a
 *     whole number of 2.5 ms Opus frames) is encoded again as Opus;
 *   - those few re-encoded packets ("the bridge") replace the originals, so
 *     the decoder runs straight from A into B with no reset and no gap.
 *
 * After the bridge B's original packets follow; the decoder state mismatch
 * fades within a frame or two. Per join that is ~0.2 s of decoding and
 * encoding with libopus in JavaScript (asm.js, vendor/opusscript), so it also
 * suits devices without Web Audio or WebAssembly, where decoding everything
 * is too slow.
 *
 * Needs flac-mp4.js (window.GaplessMux, for its EBML helpers) and
 * sample-accurate-sb.js (for SampleAccurateSB.decoderUrl).
 *
 * MIT licence, see LICENSE.
 */
(function (global) {
  'use strict';
  var MS = global.MediaSource, G = global.GaplessMux;
  var API = global.OpusBridgeSB = { enabled: false, onLog: null, supported: function () { return false; } };
  if (!MS || !G) return;
  var SR = 48000, EB = G.EBML, OPUS_MIME = 'audio/webm; codecs="opus"';
  var KA = 3, KB = 6;               // packets of A / B replaced by the bridge
  var WUP = 3, PRE = 4;             // encoder warm-up frames; decoder pre-roll packets before them
  var SNAP = 0.25 * SR;             // tracks placed this close together are joined
  var BITRATE = 192000, COMPLEXITY = 5;
  API.supported = function () { try { return MS.isTypeSupported(OPUS_MIME); } catch (e) { return false; } };
  API.stats = { joins: 0, ms: 0 };
  function log(m) { if (API.onLog) API.onLog(m); else console.log('[opus-bridge] ' + m); }

  // ---- libopus (asm.js), one handler with encoder + decoder, reused.
  var lib = null;
  function loadLib() {
    if (lib) return lib;
    lib = new Promise(function (resolve, reject) {
      var url = global.SampleAccurateSB && global.SampleAccurateSB.decoderUrl;
      if (!url) { reject(new Error('no decoder URL')); return; }
      var prev = global.Module, s = document.createElement('script');
      s.src = url;
      s.onload = function () {
        var factory = global.Module; global.Module = prev;
        if (typeof factory !== 'function') { reject(new Error('Opus library did not load')); return; }
        Promise.resolve(factory()).then(resolve, reject);
      };
      s.onerror = function () { reject(new Error('could not load ' + url)); };
      document.head.appendChild(s);
    }).then(function (m) {
      var h = new m.OpusScriptHandler(SR, 2, 2049);
      return { m: m, h: h, inP: m._malloc(8192), outP: m._malloc(5760 * 2 * 4), pcmP: m._malloc(5760 * 2 * 8), intP: m._malloc(8) };
    });
    lib.catch(function () { lib = null; });
    return lib;
  }
  // opusscript moves every int16 sample as two 16-bit cells: low byte, then high byte.
  function decodeAll(o, pkts) {
    o.h._decoder_ctl(4028, 0);                                  // OPUS_RESET_STATE
    var total = 0, parts = [];
    pkts.forEach(function (pkt) {
      o.m.HEAPU8.set(pkt, o.inP);
      var n = o.h._decode(o.inP, pkt.length, o.outP);
      if (n < 0) throw new Error('Opus decode error ' + n);
      var c = o.m.HEAPU16, b = o.outP >> 1, out = new Int16Array(n * 2);
      for (var i = 0; i < n * 2; i++) out[i] = c[b + 2 * i] | (c[b + 2 * i + 1] << 8);
      parts.push(out); total += n;
    });
    var pcm = new Int16Array(total * 2), q = 0;
    parts.forEach(function (x) { pcm.set(x, q); q += x.length; });
    return pcm;
  }
  function encodeFrame(o, pcm, at, frame) {
    var c = o.m.HEAPU16, b = o.pcmP >> 1;
    for (var i = 0; i < frame * 2; i++) { var v = pcm[at * 2 + i] | 0; c[b + 2 * i] = v & 255; c[b + 2 * i + 1] = (v >> 8) & 255; }
    var n = o.h._encode(o.pcmP, frame * 4, o.inP, frame);
    if (n < 0) throw new Error('Opus encode error ' + n);
    return o.m.HEAPU8.slice(o.inP, o.inP + n);
  }

  // ---- WebM helpers
  function concat(parts) {
    var n = 0, i; for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), p = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
    return out;
  }
  function vint(b, p, keep) { return p < b.length ? G.vint(b, p, keep) : null; }
  function children(b, start, end, fn) {
    for (var p = start; p < end; ) {
      var id = vint(b, p, true), sz = vint(b, p + id.len, false);
      var data = p + id.len + sz.len, stop = sz.unknown ? end : Math.min(end, data + sz.value);
      fn(id.value, p, data, stop, id.len, sz.len);
      p = stop;
    }
  }
  function size8(n) { var o = [0x01]; for (var i = 6; i >= 0; i--) o.push(Math.floor(n / Math.pow(2, 8 * i)) & 255); return o; }
  function el(idBytes, body) { return concat([new Uint8Array(idBytes), new Uint8Array(size8(body.length)), body]); }
  // One cluster from [{bytes, out (sample), pad?}], timestamps in ms, written 1 s late
  // (cluster timecodes are unsigned; a pre-skip can start before 0) and taken back by timestampOffset = -1.
  function cluster(pkts) {
    var tc = Math.round(pkts[0].out / 48) + 1000, parts = [new Uint8Array([0xE7, 0x84, (tc >>> 24) & 255, (tc >> 16) & 255, (tc >> 8) & 255, tc & 255])];
    pkts.forEach(function (k) {
      var rel = Math.round(k.out / 48) + 1000 - tc;
      var hdr = new Uint8Array([0x81, (rel >> 8) & 255, rel & 255, k.pad ? 0x00 : 0x80]);
      if (!k.pad) { parts.push(el([0xA3], concat([hdr, k.bytes]))); return; }
      var ns = Math.round(k.pad * 1e9 / SR);
      var dp = new Uint8Array([0x75, 0xA2, 0x84, (ns >>> 24) & 255, (ns >> 16) & 255, (ns >> 8) & 255, ns & 255]);
      parts.push(el([0xA0], concat([el([0xA1], concat([hdr, k.bytes])), dp])));
    });
    return el([0x1F, 0x43, 0xB6, 0x75], concat(parts));
  }
  function fakeRanges(list) { return { length: list.length, start: function (i) { return list[i][0]; }, end: function (i) { return list[i][1]; } }; }
  function domError(name, msg) { try { return new DOMException(msg, name); } catch (e) { var x = new Error(msg); x.name = name; return x; } }

  class BridgeSourceBuffer extends EventTarget {
    constructor(ms, real) {
      super();
      this.ms = ms; this.real = real; this.dead = false; this.updating = false; this.mode = 'segments';
      this._tso = 0; this._aws = 0; this._awe = Infinity;
      this.acc = new Uint8Array(0); this.pendingHead = null;
      this.headSent = false;
      this.cur = null;           // current track: {preskip, tso, raw, d, held[], ring[], pend[], pad, endRaw, state}
      this.ranges = [];          // what the player appended, in its own coordinates (samples)
      this.ops = Promise.resolve(); this.gen = 0;
      loadLib().catch(function (e) { log('ERROR ' + e.message); });
      log('SourceBuffer wrapped: one continuous Opus stream, re-encoded only at the joins');
    }
    get timestampOffset() { return this._tso; }
    set timestampOffset(v) { this._tso = +v; }
    get appendWindowStart() { return this._aws; }
    set appendWindowStart(v) { this._aws = +v; }
    get appendWindowEnd() { return this._awe; }
    set appendWindowEnd(v) { this._awe = +v; }
    get buffered() {
      var s = this.ranges.slice().sort(function (a, b) { return a[0] - b[0]; }), out = [];
      s.forEach(function (r) { var l = out[out.length - 1]; if (l && r[0] <= l[1] + 960) l[1] = Math.max(l[1], r[1]); else out.push([r[0], r[1]]); });
      return fakeRanges(out.map(function (r) { return [r[0] / SR, r[1] / SR]; }));
    }
    fire(names) { var self = this; names.forEach(function (n) { self.dispatchEvent(new Event(n)); }); }
    changeType() {}

    // Serialise everything (parsing waits for the library; real appends wait for each other).
    queue(fn) {
      var self = this;
      this.ops = this.ops.then(function () { if (!self.dead) return fn(); }).catch(function (e) { log('ERROR ' + (e && e.message || e) + ' ' + (e && e.stack || '').split('\n').slice(1, 3).join(' ')); });
      return this.ops;
    }
    realOp(fn) {
      var real = this.real, self = this;
      return new Promise(function (resolve) {
        if (self.dead) return resolve();
        try { fn(); } catch (e) { log('real SourceBuffer: ' + e.name + ' ' + e.message); return resolve(); }
        if (!real.updating) return resolve();
        real.addEventListener('updateend', function () { resolve(); }, { once: true });
      });
    }

    appendBuffer(data) {
      if (this.dead) throw domError('InvalidStateError', 'SourceBuffer removed');
      if (this.updating) throw domError('InvalidStateError', 'updating');
      var bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.acc = concat([this.acc, bytes]);
      this.updating = true;
      var self = this, gen = this.gen, tso = this._tso, aws = this._aws;
      this.queue(function () {
        return loadLib().then(function (o) {
          if (gen !== self.gen || self.dead) return;
          var out = self.parse(o, tso, aws);
          return self.send(out);
        });
      }).then(function () {
        if (gen !== self.gen || self.dead) return;
        self.updating = false; self.fire(['update', 'updateend']);
      });
    }
    abort() {
      // The player calls abort() before every new track too: only drop unparsed bytes.
      this.acc = new Uint8Array(0); this.gen++;
      if (this.updating) { this.updating = false; this.fire(['abort', 'updateend']); }
    }
    remove(start, end) {
      if (this.dead) throw domError('InvalidStateError', 'SourceBuffer removed');
      if (this.updating) throw domError('InvalidStateError', 'updating');
      this.updating = true;
      var a = start * SR, b = end === Infinity ? Infinity : end * SR, keep = [], self = this;
      this.ranges.forEach(function (r) {
        if (r[1] <= a || r[0] >= b) { keep.push(r); return; }
        if (r[0] < a) keep.push([r[0], a]);
        if (r[1] > b) keep.push([b, r[1]]);
      });
      this.ranges = keep;
      if (end === Infinity) { this.cur = null; this.lastOut = null; }   // a restart: nothing to join onto
      var r0 = Math.max(0, start - (end === Infinity ? 0.1 : 0)), r1 = end === Infinity ? Infinity : Math.max(r0, end - 0.05);
      this.queue(function () {
        return self.realOp(function () { if (r1 > r0) self.real.remove(r0, r1); });
      }).then(function () { if (self.dead) return; self.updating = false; self.fire(['update', 'updateend']); });
    }

    parse(o, tso, aws) {
      var b = this.acc, p = 0, out = [];
      for (;;) {
        var id = vint(b, p, true); if (!id) break;
        var sz = vint(b, p + id.len, false); if (!sz) break;
        var data = p + id.len + sz.len;
        if (id.value === EB.Segment) { p = data; continue; }
        if (sz.unknown) throw new Error('unknown-size element 0x' + id.value.toString(16));
        var end = data + sz.value;
        if (end > b.length) break;
        var e = b.slice(p, end);
        if (id.value === 0x1A45DFA3) this.pendingHead = { ebml: e };
        else if (id.value === EB.Info && this.pendingHead) this.pendingHead.info = e;
        else if (id.value === EB.Tracks && this.pendingHead) { this.pendingHead.tracks = e; this.track(this.pendingHead, tso, out); this.pendingHead = null; }
        else if (id.value === EB.Cluster && this.cur) this.clusterIn(o, e, out);
        p = end;
      }
      this.acc = b.slice(p);
      return out;
    }

    track(h, tso, out) {
      var tr = h.tracks, preskip = 0, codecDelayNs = 0;
      (function walk(start, end) {
        children(tr, start, end, function (id, p, d, s, il, sl) {
          if (id === EB.TrackEntry) walk(d, s);
          else if (id === EB.CodecDelay) { codecDelayNs = G.readUint(tr, d, s - d); G.voidOut(tr, p, il, sl, s - d); }
        });
      })(vint(tr, 0, true).len + vint(tr, vint(tr, 0, true).len, false).len, tr.length);
      for (var i = 0; i + 12 <= tr.length; i++) {
        if (tr[i] === 0x4F && tr[i + 1] === 0x70 && tr[i + 2] === 0x75 && tr[i + 3] === 0x73 && tr[i + 4] === 0x48 && tr[i + 5] === 0x65) {
          preskip = tr[i + 10] | (tr[i + 11] << 8); tr[i + 10] = 0; tr[i + 11] = 0; break;
        }
      }
      if (codecDelayNs) preskip = Math.round(codecDelayNs * 48e-6);
      if (!this.headSent) {                       // one init segment for the whole stream; pre-skip is ours to cut
        this.headSent = true;
        out.push({ init: concat([h.ebml, new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]), h.info, tr]) });
      }
      var prev = this.cur;
      if (prev && prev.state === 'wait') { prev.state = 'pass'; }   // previous track never got its bridge: play it plain
      this.cur = { preskip: preskip, tso: Math.round(tso * SR), raw: null, d: null, held: [], ring: [], pend: [], pad: 0, endRaw: null, state: 'new', prev: prev };
    }

    // Player coordinates of raw sample r of a track (where a native SourceBuffer would play it).
    ppos(t, r) { return t.tso + r - t.preskip; }

    clusterIn(o, c, out) {
      var t = this.cur, tc = 0, scale = 1e6, first = null, pk = [];
      var hdr = vint(c, 0, true).len + vint(c, vint(c, 0, true).len, false).len;
      function block(d, s) {
        var q = d + vint(c, d, false).len;
        if (c[q + 2] & 0x06) throw new Error('laced WebM blocks are not supported');
        if (first === null) first = tc + G.readInt(c, q, 2);
        pk.push({ bytes: c.slice(q + 3, s), n: G.opusPacketSamples(c, q + 3) });
      }
      var pad = 0;
      children(c, hdr, c.length, function (id, p, d, s) {
        if (id === EB.Timecode) tc = G.readUint(c, d, s - d);
        else if (id === EB.SimpleBlock) block(d, s);
        else if (id === EB.BlockGroup) children(c, d, s, function (id2, p2, d2, s2) {
          if (id2 === EB.Block) block(d2, s2);
          else if (id2 === EB.DiscardPadding) pad = Math.round(G.readInt(c, d2, s2 - d2) * 48e-6);
        });
      });
      if (!pk.length) return;
      var raw = Math.round(first * scale / 1e9 * SR);
      if (t.raw !== null && Math.abs(raw - t.raw) > 48) { this.flush(t, out, false); t.raw = null; t.state = 'new'; }  // a jump within the track
      if (t.raw === null) t.raw = raw;
      if (t.state === 'new') this.begin(t, out);
      var self = this;
      pk.forEach(function (k) {
        k.raw = t.raw; t.raw += k.n;
        t.ring.push(k); if (t.ring.length > KA + WUP + PRE) t.ring.shift();
        self.ranges.push([Math.max(self.ppos(t, k.raw), t.tso), self.ppos(t, k.raw + k.n)]);
        if (t.state === 'wait') { t.pend.push(k); if (t.pend.length >= KB + 2) self.bridge(o, t, out); return; }
        t.held.push(k);
        while (t.held.length > KA) self.emit(t, t.held.shift(), out);
      });
      if (pad) { t.pad = pad; t.endRaw = t.raw - pad; }
      this.mergeRanges();
    }
    mergeRanges() {
      var s = this.ranges.sort(function (a, b) { return a[0] - b[0]; }), out = [];
      s.forEach(function (r) { var l = out[out.length - 1]; if (l && r[0] <= l[1] + 1) l[1] = Math.max(l[1], r[1]); else out.push([r[0], r[1]]); });
      this.ranges = out;
    }
    // A track's first cluster: join it onto the previous track, or start fresh.
    begin(t, out) {
      var p = t.prev;
      t.prev = null;
      if (p && p.endRaw === null && p.raw !== null) p.endRaw = p.raw;      // no end padding signalled
      var joinable = p && p.endRaw !== null && t.raw === 0 && p.held.length === KA && p.ring.length >= KA + WUP + PRE &&
        Math.abs(this.ppos(t, t.preskip) - this.ppos(p, p.endRaw)) < SNAP;
      if (joinable) { t.state = 'wait'; t.from = p; return; }
      if (p) this.flush(p, out, true);
      // Fresh start: packets play where the player put them; MSE's append window cuts the pre-skip.
      t.d = 0; t.state = 'pass'; t.fresh = true;
      out.push({ aws: Math.max(0, t.tso / SR) });
    }
    emit(t, k, out, pad) { out.push({ bytes: k.bytes, out: this.ppos(t, k.raw) + t.d, n: k.n, pad: pad || 0 }); }
    flush(t, out, isEnd) {
      var self = this;
      t.held.forEach(function (k, i) { self.emit(t, k, out, isEnd && i === t.held.length - 1 ? t.pad : 0); });
      t.held = [];
    }

    bridge(o, b, out) {
      var a = b.from, t0 = Date.now();
      b.from = null;
      try {
        // A: decode pre-roll + warm-up + the KA held packets; keep the trimmed tail.
        var ctx = a.ring.slice(-(KA + WUP + PRE)), pa = decodeAll(o, ctx.map(function (k) { return k.bytes; }));
        var aStartRaw = ctx[0].raw, heldRaw = a.held[0].raw;
        var aWarm = pa.subarray((heldRaw - WUP * 960 - aStartRaw) * 2, (heldRaw - aStartRaw) * 2);
        var aPart = pa.subarray((heldRaw - aStartRaw) * 2, (a.endRaw - aStartRaw) * 2);
        // B: decode from its start; drop the pre-skip.
        var pb = decodeAll(o, b.pend.map(function (k) { return k.bytes; }));
        var endB = KB * 960 - b.preskip;
        var bPart = pb.subarray(b.preskip * 2, (b.preskip + endB) * 2), bAfter = pb.subarray((b.preskip + endB) * 2);
        var L = aPart.length / 2 + endB, L2 = Math.max(120, Math.round(L / 120) * 120);
        var src = new Int16Array(L * 2); src.set(aPart, 0); src.set(bPart, aPart.length);
        var S = new Int16Array(L2 * 2);
        for (var k = 0; k < L2; k++) {
          var x = L2 > 1 ? k * (L - 1) / (L2 - 1) : 0, i = Math.floor(x), f = x - i, j = Math.min(i + 1, L - 1);
          S[2 * k] = Math.round(src[2 * i] + (src[2 * j] - src[2 * i]) * f);
          S[2 * k + 1] = Math.round(src[2 * i + 1] + (src[2 * j + 1] - src[2 * i + 1]) * f);
        }
        o.h._encoder_ctl(4028, 0);
        o.h._encoder_ctl(4002, BITRATE); o.h._encoder_ctl(4010, COMPLEXITY); o.h._encoder_ctl(4024, 3002);
        o.h._encoder_ctl(4027, o.intP);
        var la = o.m.HEAP32[o.intP >> 2];
        var X = new Int16Array((WUP * 960 + L2 + bAfter.length / 2) * 2);
        X.set(aWarm, 0); X.set(S, WUP * 960 * 2); X.set(bAfter, (WUP * 960 + L2) * 2);
        var Y = X.subarray(la * 2), pos = 0, frames = [];
        for (var w = 0; w < WUP; w++) { encodeFrame(o, Y, pos, 960); pos += 960; }
        var left = L2, rem = L2 % 960;
        [480, 240, 120].forEach(function (fs) { if (rem >= fs) { frames.push({ bytes: encodeFrame(o, Y, pos, fs), n: fs }); pos += fs; rem -= fs; left -= fs; } });
        while (left > 0) { frames.push({ bytes: encodeFrame(o, Y, pos, 960), n: 960 }); pos += 960; left -= 960; }
        // Out positions: the bridge starts where A's held packets would have played.
        var at = this.ppos(a, heldRaw) + a.d;
        a.held = [];
        frames.forEach(function (fr) { out.push({ bytes: fr.bytes, out: at, n: fr.n }); at += fr.n; });
        b.d = at - this.ppos(b, KB * 960);
        b.state = 'pass';
        var rest = b.pend.slice(KB); b.pend = [];
        var self = this;
        rest.forEach(function (k) { b.held.push(k); while (b.held.length > KA) self.emit(b, b.held.shift(), out); });
        var ms = Date.now() - t0;
        API.stats.joins++; API.stats.ms += ms;
        log('bridge: ' + frames.length + ' packets re-encoded (' + (L2 / 48).toFixed(1) + ' ms, stretched ' + ((L2 / L - 1) * 100).toFixed(2) + '%) in ' + ms + ' ms');
      } catch (e) {
        log('ERROR bridge failed (' + e.message + '); joining the plain way');
        this.flush(a, out, true);
        b.d = 0; b.state = 'pass'; out.push({ aws: Math.max(0, b.tso / SR) });
        var me = this; b.pend.forEach(function (k) { b.held.push(k); while (b.held.length > KA) me.emit(b, b.held.shift(), out); }); b.pend = [];
      }
    }

    // Hand parsed output to the real SourceBuffer: the init once, then clusters (~1 s each).
    send(items) {
      var self = this, chain = Promise.resolve(), batch = [];
      function push() {
        if (!batch.length) return;
        var pk = batch; batch = [];
        chain = chain.then(function () { return self.realOp(function () { self.real.appendBuffer(cluster(pk)); }); });
      }
      items.forEach(function (it) {
        if (it.init) { push(); chain = chain.then(function () { return self.realOp(function () { self.real.timestampOffset = -1; self.real.appendBuffer(it.init); }); }); return; }
        if (it.aws !== undefined) { push(); chain = chain.then(function () { try { self.real.appendWindowStart = 0; self.real.appendWindowStart = it.aws; } catch (e) { log('appendWindowStart: ' + e.message); } }); return; }
        if (batch.length && (it.out - batch[0].out > SR || it.pad)) push();
        batch.push(it);
        if (it.pad) push();
      });
      push();
      return chain;
    }
    // At the end of the stream: let go of the held tail, with its end padding.
    finish() {
      var self = this;
      return this.queue(function () {
        if (!self.cur) return;
        var out = []; self.flush(self.cur, out, true);
        return self.send(out);
      });
    }
    destroy() { this.dead = true; this.gen++; this.acc = new Uint8Array(0); this.cur = null; }
  }

  var origAdd = MS.prototype.addSourceBuffer, origRemove = MS.prototype.removeSourceBuffer, origEos = MS.prototype.endOfStream;
  var proxies = new WeakMap();
  MS.prototype.addSourceBuffer = function (type) {
    if (!API.enabled || !/opus/i.test(type) || !API.supported()) return origAdd.call(this, type);
    var real = origAdd.call(this, OPUS_MIME), p = new BridgeSourceBuffer(this, real);
    proxies.set(this, p);
    this.addEventListener('sourceclose', function () { p.destroy(); }, { once: true });
    return p;
  };
  MS.prototype.removeSourceBuffer = function (sb) {
    if (sb instanceof BridgeSourceBuffer) { sb.destroy(); return origRemove.call(this, sb.real); }
    return origRemove.call(this, sb);
  };
  MS.prototype.endOfStream = function (err) {
    var p = proxies.get(this), ms = this, args = arguments;
    if (err || !p || p.dead) return origEos.apply(this, args);
    p.finish().then(function () { if (!p.dead && ms.readyState === 'open') { log('all audio handed to MSE; endOfStream()'); origEos.apply(ms, args); } });
  };
  API.BridgeSourceBuffer = BridgeSourceBuffer;
})(window);
