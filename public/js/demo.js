/*
 * Glue shared by index.html (play in this browser) and receiver.html (play on
 * a Cast device): loads the album, runs QueuePlayer in one of three modes
 * (stock per-track, plain MSE queue, sample-accurate), switches modes in
 * place, and reports what happens.
 *
 * MIT licence, see LICENSE.
 */
(function (global) {
  'use strict';
  var album = null, player = null, report = function () {};

  function loadAlbum() {
    if (album) return Promise.resolve(album);
    return fetch('album/album.json').then(function (r) { return r.json(); }).then(function (a) {
      a.tracks.forEach(function (t) { t.url = 'album/' + t.file; });
      return (album = a);
    });
  }

  var MODES = {
    'stock': 'per-track loading (stock, one MediaSource per track)',
    'plain': 'plain MSE gapless queue (one SourceBuffer)',
    'sample-accurate': 'sample-accurate SourceBuffer (one SourceBuffer)',
    'opus-bridge': 'Opus bridge (one continuous Opus stream, joins re-encoded) [prototype]',
    'auto': 'automatic (picks a gapless mode from what this device supports)'
  };
  // 'auto': choose by feature set. Web Audio + FLAC in MSE: lossless sample-accurate.
  // Otherwise (lightweight speakers without Web Audio): the Opus bridge. Else the plain queue.
  function autoMode() {
    var sa = global.SampleAccurateSB, ob = global.OpusBridgeSB;
    if (sa && sa.supported() && sa.decoder() === 'Web Audio') return { mode: 'sample-accurate', why: 'Web Audio and FLAC in MSE available' };
    var lacks = !sa || !sa.supported() ? (sa ? sa.missing() : 'the sample-accurate code') : 'Web Audio';
    if (ob && ob.supported()) return { mode: 'opus-bridge', why: 'no ' + lacks + ', so only the joins are re-encoded' };
    // Safety net only: every mode here streams Opus through MSE, so a device without it can't play this demo at all.
    return { mode: 'plain', why: 'this device reports no Opus support in MSE, so none of the modes is likely to play' };
  }
  var mode = 'sample-accurate', paused = false, startGen = 0;

  function start(index, offset) {
    var gen = ++startGen;                        // a Stop (or a newer Play) while the album loads cancels this one
    return loadAlbum().then(function (a) {
      if (gen !== startGen) return;
      var fellBack = false, actual = mode;
      if (mode === 'auto') {
        var pick = autoMode(); actual = pick.mode;
        report('log', 'automatic mode chose ' + MODES[actual] + ': ' + pick.why);
      }
      if (actual === 'sample-accurate' && !SampleAccurateSB.supported()) {
        report('error', 'sample-accurate mode needs ' + SampleAccurateSB.missing() + ', which this browser lacks; using the plain gapless queue');
        actual = 'plain'; fellBack = true;
        if (mode === 'sample-accurate') mode = 'plain';
      }
      SampleAccurateSB.enabled = actual === 'sample-accurate';
      if (global.OpusBridgeSB) OpusBridgeSB.enabled = actual === 'opus-bridge';
      report('log', 'mode: ' + MODES[actual] + ', from track ' + (index + 1) + (offset ? ' at ' + offset.toFixed(1) + ' s' : ''));
      paused = false;
      player.play(a.tracks, index, offset, actual === 'stock');
      report('state', { state: 'playing', mode: actual, auto: mode === 'auto', fallback: fellBack });
    });
  }

  // cmd: { cmd: 'play', mode, index, offset } | { cmd: 'mode', mode } | { cmd: 'pause' | 'resume' | 'stop' }
  // mode: 'stock' | 'plain' | 'sample-accurate'
  function handle(cmd, el) {
    if (!player) player = new QueuePlayer(el, function (type, data) { report(type, data); });
    if (cmd.mode && !MODES[cmd.mode]) return report('error', 'unknown mode ' + cmd.mode);
    var p = Promise.resolve();
    if (cmd.cmd === 'stop') { startGen++; player.stop(); report('state', { state: 'stopped' }); }
    else if (cmd.cmd === 'pause') { player.pause(); paused = true; report('state', { state: 'paused' }); }
    else if (cmd.cmd === 'resume') { player.resume(); paused = false; report('state', { state: 'playing' }); }
    else if (cmd.cmd === 'play') { mode = cmd.mode || mode; p = start(cmd.index || 0, cmd.offset || 0); }
    else if (cmd.cmd === 'mode') {
      // Switch while listening: restart the same spot in the new mode.
      if (cmd.mode === mode) return;
      mode = cmd.mode;
      var at = player.position();
      if (at && !paused) p = start(at.index, at.position);
      else report('log', 'mode set to ' + MODES[mode] + ' (applies on the next play)');
    }
    p.catch(function (e) { report('error', e.message); });
  }

  // Start 4 s before the join between track i and i+1 (i counted from 0).
  function joinCommand(i, mode) {
    if (!album) return null;                     // album not loaded yet
    var t = album.tracks[i];
    return { cmd: 'play', mode: mode, index: i, offset: Math.max(0, t.duration - 4) };
  }

  SampleAccurateSB.onLog = function (m) { report('log', '[sample-accurate] ' + m); };
  if (global.OpusBridgeSB) OpusBridgeSB.onLog = function (m) { report('log', '[opus-bridge] ' + m); };
  global.Demo = {
    loadAlbum: loadAlbum, handle: handle, joinCommand: joinCommand, autoMode: autoMode, MODES: MODES,
    onReport: function (fn) { report = fn; }
  };
})(window);
