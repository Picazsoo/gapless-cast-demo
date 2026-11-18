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
 *     the joined audio (retimed so that its length is a whole number of
 *     2.5 ms Opus frames: at most +-1.25 ms, about 0.75% at most for the full bridge,
 *     up to ~2% for the short one) is encoded again as Opus;
 *   - those few re-encoded packets ("the bridge") replace the originals, so
 *     the decoder runs straight from A into B with no reset and no gap.
 *
 * After the bridge B's original packets follow; the decoder state mismatch
 * fades within a frame or two. Per join that is ~0.1 s of decoding and
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
  var KA_SHORT = 2, KB_SHORT = 2;   // a short bridge when time is short: ~60% of the work, a little less exact for ~0.1 s
  var WUP = 1, PRE = 2;             // encoder warm-up frames; decoder pre-roll packets before them
  var SNAP = 0.25 * SR;             // tracks placed this close together are joined
  var BITRATE = 192000, COMPLEXITY = 0;   // 0: ~30% faster than 2, no measurable loss for 0.2 s of audio at 192 kbps
  var HOLD = 8 * SR;                // a seek this close to a track's end waits for the bridge before playing
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
  // The work is done in small steps with a rest after each (API.rest x the step's own
  // time), so a slow device's CPU is never hogged: the audio pipeline and the Cast
  // framework keep running while a bridge is being made.
  // When the join is close (less than about three times the last bridge's work away),
  // the rests are dropped: a join made in time matters more than a smooth CPU.
  API.rest = 0.5;
  var stepT = 0, busyTotal = 0, lastWork = 0;
  var fullWork = 0;                 // work (ms) of the last full bridge, or an estimate from the warm-up
  // owner: the wrapper whose work this is; once it is destroyed its work stops at the next step.
  var CANCELLED = 'cancelled';
  function pace(owner) {
    if (owner && owner.dead) return Promise.reject(new Error(CANCELLED));
    var busy = Date.now() - stepT;
    if (busy < 10) return Promise.resolve();     // fast device: keep going, a pause would cost more than the step
    busyTotal += busy;
    var rest = owner && owner.tight && owner.tight() ? 0 : API.rest;
    return new Promise(function (r, j) { setTimeout(function () { stepT = Date.now(); if (owner && owner.dead) j(new Error(CANCELLED)); else r(); }, Math.max(1, Math.round(busy * rest))); });
  }
  // One libopus handler for every wrapper: its encoder/decoder state must not be
  // shared by two jobs at once (a stopped stream's last bridge and the next one's start).
  var codecTail = Promise.resolve();
  function withCodec(fn) {
    var run = codecTail.then(fn);
    codecTail = run.catch(function () {});
    return run;
  }
  async function decodeAll(o, pkts, owner) {
    o.h._decoder_ctl(4028, 0);                                  // OPUS_RESET_STATE
    var total = 0, parts = [];
    stepT = Date.now();
    for (var j = 0; j < pkts.length; j++) {
      var pkt = pkts[j];
      o.m.HEAPU8.set(pkt, o.inP);
      var n = o.h._decode(o.inP, pkt.length, o.outP);
      if (n < 0) throw new Error('Opus decode error ' + n);
      var c = o.m.HEAPU16, b = o.outP >> 1, out = new Int16Array(n * 2);
      for (var i = 0; i < n * 2; i++) out[i] = c[b + 2 * i] | (c[b + 2 * i + 1] << 8);
      parts.push(out); total += n;
      await pace(owner);
    }
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
      var self = this;
      // Load libopus now and run it once on silence: on a slow device the first call
      // (while the JavaScript engine compiles it) is several times slower than later ones.
      this.queue(function () {
        return loadLib().then(function (o) {
          return withCodec(async function () {
            var t0 = Date.now(), z = new Int16Array(960 * 2);
            o.h._encoder_ctl(4028, 0); o.h._encoder_ctl(4010, COMPLEXITY);
            busyTotal = 0;
            for (var i = 0; i < 3; i++) { stepT = Date.now(); var f = encodeFrame(o, z, 0, 960); await pace(self); await decodeAll(o, [f], self); }
            var cpu = busyTotal + (Date.now() - stepT);
            if (!fullWork) fullWork = cpu / 3 * 10;     // a full bridge is about ten encode+decode pairs (a cold estimate: on the high side)
            log('libopus ready (warm-up ' + (Date.now() - t0) + ' ms, with rests)');
          }).catch(function (e) { if (e.message !== CANCELLED) throw e; });
        });
      });
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
    // Resolves with null when the real SourceBuffer took it, else with what went wrong.
    realOp(fn) {
      var real = this.real, self = this;
      return new Promise(function (resolve) {
        if (self.dead) return resolve(null);
        try { fn(); } catch (e) { return resolve(e); }
        if (!real.updating) return resolve(null);
        var failed = null;
        function onError() { failed = domError('AppendError', 'the real SourceBuffer rejected the data'); }
        real.addEventListener('error', onError, { once: true });
        real.addEventListener('updateend', function () { real.removeEventListener('error', onError); resolve(failed); }, { once: true });
      });
    }
    // An append that must get through: on a full buffer make room behind the playhead
    // and try again; anything else (or a buffer that stays full) is thrown.
    // An abort() (a seek restarting the stream) ends the retries: that data is obsolete.
    async appendReal(bytes, gen) {
      if (gen === undefined) gen = this.gen;
      for (var n = 0; ; n++) {
        if (this.dead || this.gen !== gen) return false;
        var err = await this.realOp(function () { this.real.appendBuffer(bytes); }.bind(this));
        if (!err) return true;                                   // true: the real buffer has it
        if (this.dead || this.gen !== gen) return false;
        if (err.name !== 'QuotaExceededError' || n >= 5) throw err;
        if (n === 0) log('MSE full; making room and retrying');
        var el = this.element(), rb = this.real.buffered, cut = el ? el.currentTime - 2 : 0;
        if (rb.length && rb.start(0) < cut) await this.realOp(function () { this.real.remove(0, cut); }.bind(this));
        await new Promise(function (r) { setTimeout(r, 300 * (n + 1)); });
      }
    }
    element() {
      var els = document.querySelectorAll('audio,video');
      for (var i = 0; i < els.length; i++) if (els[i].src && urlToMs.get(els[i].src) === this.ms) return els[i];
      return null;
    }
    // Audio the player was told is buffered never reached MSE: say so, and end the stream with an error.
    fail(err) {
      if (this.dead) return;
      log('ERROR ' + (err && err.name) + ': ' + (err && err.message) + '; ending the stream with an error');
      this.failed = true;
      var ms = this.ms;
      this.destroy();
      try { if (ms.readyState === 'open') origEos.call(ms, 'decode'); } catch (e) {}
    }

    appendBuffer(data) {
      if (this.dead) throw domError('InvalidStateError', 'SourceBuffer removed');
      if (this.updating) throw domError('InvalidStateError', 'updating');
      var bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.acc = concat([this.acc, bytes]);
      this.updating = true;
      var self = this, gen = this.gen, tso = this._tso, aws = this._aws;
      var error = null;
      this.queue(function () {
        return loadLib().then(function (o) {
          if (gen !== self.gen || self.dead) return;
          self.lib = o;
          var out = self.parse(o, tso, aws);
          return self.send(out, gen);
        }).catch(function (e) { error = e; });
      }).then(function () {
        if (gen !== self.gen || self.dead) return;                 // aborted: whatever went wrong no longer matters
        if (error) { self.updating = false; self.fire(['error', 'updateend']); self.fail(error); return; }
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
        return self.realOp(function () { if (r1 > r0) self.real.remove(r0, r1); }).then(function (e) { if (e) log('real remove: ' + e.message); });
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
      // One init segment for the whole stream (pre-skip is ours to cut). It counts as sent
      // only once the real buffer has accepted it: an aborted or failed one is sent again.
      if (!this.headSent && !this.initPending) {
        this.initPending = true;
        out.push({ init: concat([h.ebml, new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]), h.info, tr]) });
      }
      var durRaw = 0;                             // Info/Duration, to know after a seek how close the end is
      children(h.info, vint(h.info, 0, true).len + vint(h.info, vint(h.info, 0, true).len, false).len, h.info.length, function (id, p, d, s) {
        if (id === 0x4489) { var v = new DataView(h.info.buffer, h.info.byteOffset + d, s - d); durRaw = Math.round((s - d === 8 ? v.getFloat64(0) : v.getFloat32(0)) / 1000 * SR); }
      });
      var prev = this.cur;
      if (prev && prev.state === 'wait') { prev.state = 'pass'; }   // previous track never got its bridge: play it plain
      this.cur = { preskip: preskip, tso: Math.round(tso * SR), raw: null, d: null, held: [], ring: [], pend: [], pad: 0, endRaw: null, state: 'new', prev: prev, durRaw: durRaw };
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
        if (t.state === 'wait') { t.pend.push(k); if (t.pend.length >= KB + 2 && !t.queued) { t.queued = true; out.push({ job: t }); } return; }
        t.held.push(k);
        while (!t.holdAll && t.held.length > KA) self.emit(t, t.held.shift(), out);
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
      var joinable = p && p.endRaw !== null && t.raw === 0 && p.held.length >= KA && p.ring.length >= KA + WUP + PRE &&
        t.preskip + 960 <= KB * 960 &&                                     // (a pre-skip longer than the bridge can't be bridged)
        Math.abs(this.ppos(t, t.preskip) - this.ppos(p, p.endRaw)) < SNAP;
      if (joinable) { t.state = 'wait'; t.from = p; return; }
      if (p) this.flush(p, out, true);
      // Fresh start: packets play where the player put them; MSE's append window cuts the pre-skip.
      t.d = 0; t.state = 'pass'; t.fresh = true;
      // Started (after a seek) within HOLD of the track's end: hand over nothing until the
      // bridge into the next track is ready, so playback waits once here instead of
      // playing on and then stopping right before the join.
      if (t.raw > 0 && t.durRaw && t.durRaw + t.preskip - t.raw < HOLD) { t.holdAll = true; log('seek close to the end of a track: holding playback until the join is ready'); }
      out.push({ aws: Math.max(0, t.tso / SR) });
    }
    emit(t, k, out, pad) { out.push({ bytes: k.bytes, out: this.ppos(t, k.raw) + t.d, n: k.n, pad: pad || 0 }); }
    flush(t, out, isEnd) {
      var self = this;
      t.held.forEach(function (k, i) { self.emit(t, k, out, isEnd && i === t.held.length - 1 ? t.pad : 0); });
      t.held = [];
    }

    // The join being made is close to the playhead: work without rests.
    tight() {
      if (this.waiting) { if (!this.rushing) { this.rushing = true; log('playback waiting for the join: working without rests'); } return true; }
      if (this.deadline == null) return false;
      var el = this.element();
      if (!el) return false;
      var left = this.deadline - el.currentTime, need = Math.max(4, 3 * lastWork / 1000);
      if (left < need && !this.rushing) { this.rushing = true; log('join ' + Math.max(0, left).toFixed(1) + ' s away: working without rests'); }
      return left < need;
    }
    async bridge(o, b, out) {
      var a = b.from, t0 = Date.now();
      busyTotal = 0;
      b.from = null;
      // Where the join will play (the real buffer's timeline is the out position in seconds).
      // Where the bridge will play (the real buffer's timeline is the out position in seconds).
      var hk = a.held[Math.max(0, a.held.length - KA)];
      this.deadline = hk ? (this.ppos(a, hk.raw) + a.d) / SR : null; this.rushing = false;
      // Full bridge (KA+KB) when there is time for it, else the short one: the join itself must make it.
      // (Held after a seek near the end: playback is waiting for this bridge right now.)
      var el0 = this.element(), waiting = !!a.holdAll, tLeft = waiting ? 0 : this.deadline != null && el0 ? this.deadline - el0.currentTime : Infinity;
      this.waiting = waiting;
      var short = tLeft < 2 * fullWork / 1000 + 1, ka = short ? KA_SHORT : KA, kb = short ? KB_SHORT : KB;
      // The incoming packets must reach past B's pre-skip by at least one packet (a long pre-skip
      // needs more of them); if even the full bridge's packets don't, nothing changes here.
      if (short) kb = Math.min(KB, Math.max(kb, Math.ceil(b.preskip / 960) + 1));
      try {
        // A: decode pre-roll + warm-up + the ka held packets; keep the trimmed tail.
        var early = a.held.splice(0, a.held.length - ka), me0 = this;     // anything held back after a seek (or beyond a short bridge) plays now
        early.forEach(function (k) { me0.emit(a, k, out); });
        a.holdAll = false;
        var ctx = a.ring.slice(-(ka + WUP + PRE)), pa = await decodeAll(o, ctx.map(function (k) { return k.bytes; }), this);
        var aStartRaw = ctx[0].raw, heldRaw = a.held[0].raw;
        var aWarm = pa.subarray((heldRaw - WUP * 960 - aStartRaw) * 2, (heldRaw - aStartRaw) * 2);
        var aPart = pa.subarray((heldRaw - aStartRaw) * 2, (a.endRaw - aStartRaw) * 2);
        // B: decode from its start; drop the pre-skip.
        var pb = await decodeAll(o, b.pend.slice(0, kb + 2).map(function (k) { return k.bytes; }), this);   // the replaced packets + encoder look-ahead
        var endB = kb * 960 - b.preskip;
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
        stepT = Date.now();
        for (var w = 0; w < WUP; w++) { encodeFrame(o, Y, pos, 960); pos += 960; await pace(this); }
        var left = L2, rem = L2 % 960, sizes = [];
        [480, 240, 120].forEach(function (fs) { if (rem >= fs) { sizes.push(fs); rem -= fs; left -= fs; } });
        for (; left > 0; left -= 960) sizes.push(960);
        for (var q = 0; q < sizes.length; q++) { frames.push({ bytes: encodeFrame(o, Y, pos, sizes[q]), n: sizes[q] }); pos += sizes[q]; await pace(this); }
        if (this.dead) return;
        // Out positions: the bridge starts where A's held packets would have played.
        var at = this.ppos(a, heldRaw) + a.d;
        a.held = [];
        frames.forEach(function (fr) { out.push({ bytes: fr.bytes, out: at, n: fr.n }); at += fr.n; });
        b.d = at - this.ppos(b, kb * 960);
        b.state = 'pass';
        var rest = b.pend.slice(kb); b.pend = [];
        var self = this;
        rest.forEach(function (k) { b.held.push(k); while (b.held.length > KA) self.emit(b, b.held.shift(), out); });
        var ms = Date.now() - t0, cpu = busyTotal + (Date.now() - stepT);
        lastWork = cpu; this.deadline = null; this.waiting = false;
        fullWork = short ? cpu / 0.58 : cpu;          // (a short bridge is ~58% of a full one's work)
        API.stats.joins++; API.stats.ms += ms;
        log((short ? 'short bridge (' + (waiting ? 'playback waiting' : 'join ' + Math.max(0, tLeft).toFixed(1) + ' s away') + '): ' : 'bridge: ') + frames.length + ' packets re-encoded (' + (L2 / 48).toFixed(1) + ' ms, stretched ' + ((L2 / L - 1) * 100).toFixed(2) + '%) in ' + ms + ' ms (' + cpu + ' ms of work, the rest pauses)');
      } catch (e) {
        this.deadline = null; this.waiting = false;
        if (e.message === CANCELLED || this.dead) return;          // this stream was stopped meanwhile
        log('ERROR bridge failed (' + e.message + '); joining the plain way');
        this.flush(a, out, true);
        b.d = 0; b.state = 'pass'; out.push({ aws: Math.max(0, b.tso / SR) });
        var me = this; b.pend.forEach(function (k) { b.held.push(k); while (b.held.length > KA) me.emit(b, b.held.shift(), out); }); b.pend = [];
      }
    }

    // Hand parsed output to the real SourceBuffer: the init once, then clusters (~1 s each).
    send(items, gen) {
      var self = this, chain = Promise.resolve(), batch = [];
      if (gen === undefined) gen = this.gen;           // an abort() after this point makes the rest obsolete
      function push() {
        if (!batch.length) return;
        var pk = batch; batch = [];
        chain = chain.then(function () { if (!self.dead) return self.appendReal(cluster(pk), gen); });
      }
      items.forEach(function (it) {
        if (it.job) {                             // a bridge: made in steps, then sent like the rest
          push();
          chain = chain.then(function () { var o2 = []; return withCodec(function () { return self.bridge(self.lib, it.job, o2); }).then(function () { if (!self.dead && self.gen === gen) return self.send(o2, gen); }); });
          return;
        }
        if (it.init) { push(); chain = chain.then(function () { if (self.dead) return; try { self.real.timestampOffset = -1; } catch (e) {} return self.appendReal(it.init, gen).then(function (ok) { if (ok) self.headSent = true; }, function (e) { throw e; }).finally(function () { self.initPending = false; }); }); return; }
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
        return self.send(out).catch(function (e) { self.fail(e); });
      });
    }
    destroy() { this.dead = true; this.gen++; this.acc = new Uint8Array(0); this.cur = null; }
  }

  var urlToMs = new Map(), origCreate = URL.createObjectURL;
  URL.createObjectURL = function (o) { var u = origCreate.apply(this, arguments); if (o instanceof MS) urlToMs.set(u, o); return u; };
  var origRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = function (u) { urlToMs.delete(u); return origRevoke.apply(this, arguments); };
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
    var gen = p.gen;                              // a seek (abort) after this request cancels it
    p.finish().then(function () { if (!p.dead && !p.failed && p.gen === gen && ms.readyState === 'open') { log('all audio handed to MSE; endOfStream()'); origEos.apply(ms, args); } });
  };
  API.BridgeSourceBuffer = BridgeSourceBuffer;
})(window);
