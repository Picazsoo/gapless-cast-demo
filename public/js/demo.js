/*
 * Glue shared by index.html (play in this browser) and receiver.html (play on
 * a Cast device): loads the album, runs QueuePlayer in plain or
 * sample-accurate mode, and reports what happens.
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

  // cmd: { cmd: 'play', mode: 'plain' | 'sample-accurate', index, offset } | { cmd: 'pause' | 'resume' | 'stop' }
  function handle(cmd, el) {
    if (!player) player = new QueuePlayer(el, function (type, data) { report(type, data); });
    if (cmd.cmd === 'stop') { player.stop(); report('state', { state: 'stopped' }); return; }
    if (cmd.cmd === 'pause') { player.pause(); report('state', { state: 'paused' }); return; }
    if (cmd.cmd === 'resume') { player.resume(); report('state', { state: 'playing' }); return; }
    if (cmd.cmd !== 'play') return;
    loadAlbum().then(function (a) {
      SampleAccurateSB.enabled = cmd.mode === 'sample-accurate';
      report('log', 'mode: ' + (SampleAccurateSB.enabled ? 'sample-accurate SourceBuffer' : 'plain MSE') + ', from track ' + ((cmd.index || 0) + 1) +
        (cmd.offset ? ' at ' + cmd.offset.toFixed(1) + ' s' : ''));
      player.play(a.tracks, cmd.index || 0, cmd.offset || 0);
      report('state', { state: 'playing', mode: cmd.mode });
    }).catch(function (e) { report('error', e.message); });
  }

  // Start 4 s before the join between track i and i+1 (i counted from 0).
  function joinCommand(i, mode) {
    var t = album.tracks[i];
    return { cmd: 'play', mode: mode, index: i, offset: Math.max(0, t.duration - 4) };
  }

  SampleAccurateSB.onLog = function (m) { report('log', '[sample-accurate] ' + m); };
  global.Demo = {
    loadAlbum: loadAlbum, handle: handle, joinCommand: joinCommand,
    onReport: function (fn) { report = fn; }
  };
})(window);
