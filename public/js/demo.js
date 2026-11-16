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
    'sample-accurate': 'sample-accurate SourceBuffer (one SourceBuffer)'
  };
  var mode = 'sample-accurate', paused = false, startGen = 0;

  function start(index, offset) {
    var gen = ++startGen;                        // a Stop (or a newer Play) while the album loads cancels this one
    return loadAlbum().then(function (a) {
      if (gen !== startGen) return;
      var fellBack = false;
      if (mode === 'sample-accurate' && !SampleAccurateSB.supported()) {
        report('error', 'sample-accurate mode needs FLAC in MSE, which this browser lacks; using the plain gapless queue');
        mode = 'plain'; fellBack = true;
      }
      SampleAccurateSB.enabled = mode === 'sample-accurate';
      report('log', 'mode: ' + MODES[mode] + ', from track ' + (index + 1) + (offset ? ' at ' + offset.toFixed(1) + ' s' : ''));
      paused = false;
      player.play(a.tracks, index, offset, mode === 'stock');
      report('state', { state: 'playing', mode: mode, fallback: fellBack });
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
  global.Demo = {
    loadAlbum: loadAlbum, handle: handle, joinCommand: joinCommand,
    onReport: function (fn) { report = fn; }
  };
})(window);
