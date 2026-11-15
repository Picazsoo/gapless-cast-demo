/*
 * Small byte-level helpers shared by the demo: WebM/EBML reading, Opus packet
 * durations, and a minimal writer for verbatim FLAC frames in fragmented MP4
 * (what MSE accepts as 'audio/mp4; codecs="flac"').
 *
 * MIT licence, see LICENSE.
 */
(function (global) {
  'use strict';
  var EBML = {
    Segment: 0x18538067, Info: 0x1549A966, TimecodeScale: 0x2AD7B1,
    Tracks: 0x1654AE6B, TrackEntry: 0xAE, CodecDelay: 0x56AA,
    Cluster: 0x1F43B675, SeekHead: 0x114D9B74, Cues: 0x1C53BB6B, Timecode: 0xE7, SimpleBlock: 0xA3,
    BlockGroup: 0xA0, Block: 0xA1, DiscardPadding: 0x75A2
  };
  function vint(b, p, keepMarker) {
    var first = b[p], len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 8) throw new Error('bad EBML vint at ' + p);
    var v = keepMarker ? first : (first & (mask - 1)), allOnes = (first & (mask - 1)) === mask - 1;
    for (var i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xFF) allOnes = false; }
    return { value: v, len: len, unknown: !keepMarker && allOnes };
  }
  function readUint(b, p, n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; }
  function readInt(b, p, n) { var v = readUint(b, p, n); return n && b[p] & 0x80 ? v - Math.pow(2, 8 * n) : v; }

  function voidOut(b, start, idLen, sizeLen, dataLen) {
    // Rewrite [id][size][data] as [0xEC][size'][data] with identical total length.
    var L = idLen + sizeLen - 1;                 // ≥ 2 for both elements we blank
    b[start] = 0xEC;
    var v = dataLen;
    for (var i = L; i >= 1; i--) { b[start + i] = v & 0xFF; v = Math.floor(v / 256); }
    b[start + 1] |= (0x80 >> (L - 1));
  }

  function opusPacketSamples(b, p) {
    var toc = b[p], cfg = toc >> 3, ms;
    if (cfg < 12) ms = [10, 20, 40, 60][cfg & 3];
    else if (cfg < 16) ms = [10, 20][cfg & 1];
    else ms = [2.5, 5, 10, 20][cfg & 3];
    var c = toc & 3, frames = c === 0 ? 1 : c < 3 ? 2 : (b[p + 1] & 0x3F);
    return Math.round(ms * 48 * frames);         // Opus always runs at 48 kHz
  }

  var FLAC_BLOCK = 4096;

  var CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
  (function () {
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xFF : (c << 1) & 0xFF;
      CRC8[i] = c;
      var d = i << 8;
      for (k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xFFFF : (d << 1) & 0xFFFF;
      CRC16[i] = d;
    }
  })();

  function flacFrame(L, R, off, n, frameNo, rateCode) {
    var hdr = [0xFF, 0xF8, ((n === FLAC_BLOCK ? 12 : 7) << 4) | rateCode, (1 << 4) | (4 << 1)];  // stereo L/R, 16 bit
    if (frameNo < 0x80) hdr.push(frameNo);                                       // UTF-8 style frame number
    else if (frameNo < 0x800) hdr.push(0xC0 | (frameNo >> 6), 0x80 | (frameNo & 63));
    else if (frameNo < 0x10000) hdr.push(0xE0 | (frameNo >> 12), 0x80 | ((frameNo >> 6) & 63), 0x80 | (frameNo & 63));
    else hdr.push(0xF0 | (frameNo >> 18), 0x80 | ((frameNo >> 12) & 63), 0x80 | ((frameNo >> 6) & 63), 0x80 | (frameNo & 63));
    if (n !== FLAC_BLOCK) hdr.push(((n - 1) >> 8) & 0xFF, (n - 1) & 0xFF);
    var c8 = 0;
    for (var i = 0; i < hdr.length; i++) c8 = CRC8[c8 ^ hdr[i]];
    hdr.push(c8);
    var size = hdr.length + 2 * (1 + 2 * n) + 2, out = new Uint8Array(size), p = 0;
    out.set(hdr, 0); p = hdr.length;
    [L, R].forEach(function (ch) {
      out[p++] = 0x02;                                                           // VERBATIM subframe
      for (var j = 0; j < n; j++) {
        var v = ch[off + j];
        v = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
        out[p++] = (v >> 8) & 0xFF; out[p++] = v & 0xFF;
      }
    });
    var c16 = 0;
    for (i = 0; i < p; i++) c16 = ((c16 << 8) & 0xFFFF) ^ CRC16[(c16 >> 8) ^ out[i]];
    out[p++] = c16 >> 8; out[p++] = c16 & 0xFF;
    return out;
  }

  // --- minimal fragmented-MP4 writer
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function u16(n) { return [(n >> 8) & 255, n & 255]; }
  function str(s) { return s.split('').map(function (c) { return c.charCodeAt(0); }); }
  function box(type) {
    var parts = [].slice.call(arguments, 1), len = 8, i;
    parts = parts.map(function (x) { return x instanceof Uint8Array ? x : new Uint8Array(x); });
    for (i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Uint8Array(len), p = 8;
    out.set(u32(len), 0); out.set(str(type), 4);
    for (i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
    return out;
  }
  function full(type, ver, flags) { return box.apply(null, [type, [ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]].concat([].slice.call(arguments, 3))); }
  var MATRIX = [].concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));

  function flacInit(rate) {
    var si = new Uint8Array(34);                       // STREAMINFO
    si.set(u16(FLAC_BLOCK), 0); si.set(u16(FLAC_BLOCK), 2);
    // sample rate (20) | channels-1 (3) | bits-1 (5) | total samples (36, 0 = unknown)
    si[10] = (rate >> 12) & 255; si[11] = (rate >> 4) & 255;
    si[12] = ((rate & 15) << 4) | (1 << 1) | (15 >> 4);
    si[13] = (15 & 15) << 4;
    var dfla = full('dfLa', 0, 0, [0x80, 0, 0, 34], si);  // last-metadata-block flag + STREAMINFO
    var entry = box('fLaC', [0, 0, 0, 0, 0, 0, 0, 1], u32(0), u32(0), u16(2), u16(16), u16(0), u16(0), u32(rate * 65536 >>> 0), dfla);
    var stbl = box('stbl', full('stsd', 0, 0, u32(1), entry), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)),
                   full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
    var minf = box('minf', full('smhd', 0, 0, u32(0)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
    var mdia = box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(rate), u32(0), u16(0x55C4), u16(0)),
                   full('hdlr', 0, 0, u32(0), str('soun'), u32(0), u32(0), u32(0), str('flac'), [0]), minf);
    var trak = box('trak', full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, u32(0), u32(0)), mdia);
    var mvex = box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(FLAC_BLOCK), u32(0), u32(0)));
    var moov = box('moov', full('mvhd', 0, 0, u32(0), u32(0), u32(rate), u32(0), u32(0x10000), u16(0x0100), u16(0), u32(0), u32(0), MATRIX,
                   u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(2)), trak, mvex);
    var ftyp = box('ftyp', str('iso6'), u32(0), str('iso6'), str('mp41'));
    var out = new Uint8Array(ftyp.length + moov.length);
    out.set(ftyp, 0); out.set(moov, ftyp.length);
    return out;
  }

  function flacSegment(seq, baseTime, frames, sizes, durations) {
    var n = frames.length, mdatLen = 8, i;
    for (i = 0; i < n; i++) mdatLen += frames[i].length;
    var entries = [];
    for (i = 0; i < n; i++) entries = entries.concat(u32(durations[i]), u32(sizes[i]));
    var hi = Math.floor(baseTime / 4294967296), lo = baseTime >>> 0;
    function moofWith(dataOffset) {
      return box('moof', full('mfhd', 0, 0, u32(seq)),
        box('traf', full('tfhd', 0, 0x020000, u32(1)), full('tfdt', 1, 0, u32(hi), u32(lo)),
            full('trun', 0, 0x000301, u32(n), u32(dataOffset), entries)));
    }
    var moofLen = moofWith(0).length, moof = moofWith(moofLen + 8);
    var out = new Uint8Array(moofLen + mdatLen), p = moofLen + 8;
    out.set(moof, 0); out.set(u32(mdatLen), moofLen); out.set(str('mdat'), moofLen + 4);
    for (i = 0; i < n; i++) { out.set(frames[i], p); p += frames[i].length; }
    return out;
  }

  global.GaplessMux = {
    EBML: EBML, vint: vint, readUint: readUint, readInt: readInt, voidOut: voidOut,
    opusPacketSamples: opusPacketSamples, flacFrame: flacFrame, flacInit: flacInit,
    flacSegment: flacSegment, FLAC_BLOCK: FLAC_BLOCK
  };
})(window);
