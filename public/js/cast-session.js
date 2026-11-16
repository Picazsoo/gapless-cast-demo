/*
 * Receiver side of the demo as a real Cast media session, so Google Home (and
 * any other Cast controller) shows what is playing and can pause, seek and
 * skip tracks.
 *
 *   - Gapless modes: the whole album is ONE continuous MSE stream, loaded into
 *     the Cast framework as a single media item (its contentUrl is our
 *     MediaSource). The media status we report is rewritten per track: the
 *     current track's title, its duration and the position inside it, so
 *     controllers show "track 7, 1:23 / 4:10" although the stream underneath
 *     never stops. Seeks and skips restart the stream in place.
 *   - Per-track mode (stock): an ordinary Cast queue, one media item per
 *     track, handled entirely by the Cast framework, like a typical music app.
 *
 * MIT licence, see LICENSE.
 */
(function (global) {
  'use strict';
  var M = cast.framework.messages, E = cast.framework.events.EventType;
  var MODES = { 'stock': 'per-track (a Cast queue, one media item per track)',
                'plain': 'plain MSE gapless queue (one continuous stream)',
                'sample-accurate': 'sample-accurate SourceBuffer (one continuous stream)' };

  function CastSession(context, el, report) {
    var pm = context.getPlayerManager(), album = null;
    var player = new QueuePlayer(el, function (type, data) { onPlayerEvent(type, data); report(type, data); });
    var kind = null, mode = 'sample-accurate', pending = null, pendingTimer = null, lastQueueIndex = -1;
    function log(m) { report('log', m); }
    function attempt(what, f) { try { f(); } catch (e) { log('skipped ' + what + ': ' + (e && e.message || e)); } }
    function abs(u) { return new URL(u, location.href).href; }
    Demo.loadAlbum().then(function (a) { album = a; });

    function metadata(i) {
      var t = album.tracks[i], md = new M.MusicTrackMediaMetadata();
      md.title = t.title; md.albumName = album.title; md.artist = album.artist; md.trackNumber = i + 1;
      return md;
    }
    // Where we are in album terms: { index, position }.
    function where() {
      if (pending) return { index: pending.index, position: pending.offset };
      if (kind === 'stream') return player.position() || { index: 0, position: 0 };
      if (kind === 'queue') {
        var qm = pm.getQueueManager && pm.getQueueManager(), i = qm ? qm.getCurrentItemIndex() : 0;
        return { index: Math.max(0, i), position: pm.getCurrentTimeSec() || 0 };
      }
      return null;
    }

    // The Cast framework still has our stream loaded (not finished or stopped).
    function live() { return !!pm.getMediaInformation() && pm.getPlayerState() !== M.PlayerState.IDLE; }

    // ---------------------------------------------------------- loading
    function loadStream(m, index, offset) {
      var req = new M.LoadRequestData();
      req.media = new M.MediaInformation();
      req.media.contentId = 'gapless-demo:album';
      req.media.contentType = 'audio/mp4';
      req.customData = { gapless: { mode: m, index: index, offset: offset || 0 } };
      req.autoplay = true;
      return pm.load(req);
    }
    function loadQueue(index, offset) {
      var items = album.tracks.map(function (t, i) {
        var it = new M.QueueItem(), mi = new M.MediaInformation();
        mi.contentId = abs(t.url); mi.contentUrl = abs(t.url); mi.contentType = 'audio/webm';
        mi.streamType = M.StreamType.BUFFERED; mi.duration = t.duration; mi.metadata = metadata(i);
        it.media = mi; it.autoplay = true;
        if (i === index && offset) it.startTime = offset;
        return it;
      });
      var req = new M.LoadRequestData();
      req.queueData = new M.QueueData(); req.queueData.items = items; req.queueData.startIndex = index;
      req.media = items[index].media; req.currentTime = offset || 0; req.autoplay = true;
      req.customData = { gapless: { mode: 'stock', index: index, offset: offset || 0 } };
      return pm.load(req);
    }
    function start(m, index, offset) {
      if (!album) return Demo.loadAlbum().then(function (a) { album = a; return start(m, index, offset); });
      mode = m; index = index || 0; offset = offset || 0;
      if (m !== 'stock' && kind === 'stream' && player.ms && live() && SampleAccurateSB.enabled === (m === 'sample-accurate')) {
        restartAt(index, offset, 0);              // same kind of stream: continue it in place
        return Promise.resolve();
      }
      log('mode: ' + MODES[m] + ', from track ' + (index + 1) + (offset ? ' at ' + offset.toFixed(1) + ' s' : ''));
      var p = m === 'stock' ? loadQueue(index, offset) : loadStream(m, index, offset);
      return Promise.resolve(p).catch(function (e) { report('error', 'load failed: ' + (e && (e.message || e.type || e.reason || JSON.stringify(e)))); });
    }

    pm.setMessageInterceptor(M.MessageType.LOAD, function (req) {
      var g = req.customData && req.customData.gapless;
      if (!g) {
        var err = new M.ErrorData(M.ErrorType.LOAD_FAILED); err.reason = M.ErrorReason.INVALID_PARAMS;
        log('LOAD without demo data rejected'); return err;
      }
      clearTimeout(pendingTimer); pending = null;
      mode = g.mode;
      report('state', { state: 'playing', mode: mode });
      if (g.mode === 'stock') { player.stop(true); kind = 'queue'; lastQueueIndex = -1; return req; }
      kind = 'stream';
      SampleAccurateSB.enabled = g.mode === 'sample-accurate';
      player.play(album.tracks, g.index, g.offset, false, { external: true });
      req.media.contentUrl = player.url;          // our MediaSource: the Cast framework plays it on its media element
      req.media.contentType = 'audio/mp4';
      req.media.streamType = M.StreamType.BUFFERED;
      req.media.metadata = metadata(g.index);
      req.media.duration = album.tracks[g.index].duration;
      req.currentTime = 0;                        // the stream positions itself (offset is in customData)
      req.autoplay = true;
      return req;
    });

    // ---------------------------------------------- seeks and skips (stream)
    // Several presses in a row (dragging the seek bar sends dozens of SEEKs,
    // or next, next, next) collapse into one restart.
    function restartAt(index, offset, delay) {
      index = Math.max(0, Math.min(album.tracks.length - 1, index));
      offset = Math.max(0, Math.min(offset, album.tracks[index].duration - 1));
      pending = { index: index, offset: offset };
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(function () {
        var x = pending; pending = null;
        if (!live() || !player.reset(album.tracks, x.index, x.offset)) { loadStream(mode, x.index, x.offset); return; }
        var info = pm.getMediaInformation();
        if (info) { info.metadata = metadata(x.index); info.duration = album.tracks[x.index].duration; attempt('setMediaInformation', function () { pm.setMediaInformation(info, true); }); }
      }, delay == null ? 600 : delay);
      attempt('broadcastStatus', function () { pm.broadcastStatus(true); });
    }
    function skip(dir) {
      var w = where(), i = w.index;
      if (dir > 0) i++;
      else if (dir < 0 && w.position < 3) i--;    // previous within the first 3 s: go back a track, else restart this one
      if (i >= album.tracks.length) { log('next: already on the last track'); return; }
      log((dir > 0 ? 'next' : 'previous') + ': track ' + (Math.max(0, i) + 1));
      restartAt(i, 0);
    }

    pm.setMessageInterceptor(M.MessageType.SEEK, function (req) {
      if (kind !== 'stream') return req;
      var w = where(), t = req.currentTime;
      if (req.relativeTime != null) t = w.position + req.relativeTime;
      if (t == null) return req;
      log('seek to ' + t.toFixed(1) + ' s in track ' + (w.index + 1));
      restartAt(w.index, t);
      return null;
    });
    attempt('next/previous buttons', function () {
      pm.setMessageInterceptor(M.MessageType.QUEUE_UPDATE, function (req) {
        if (kind === 'stream' && req && req.jump) { skip(req.jump); return null; }
        return req;
      });
      if (M.Command.QUEUE_NEXT && M.Command.QUEUE_PREV) pm.addSupportedMediaCommands(M.Command.QUEUE_NEXT | M.Command.QUEUE_PREV, true);
    });

    // What controllers see: in a stream, the current track as the media item.
    pm.setMessageInterceptor(M.MessageType.MEDIA_STATUS, function (status) {
      if (kind !== 'stream' || !status || !album) return status;
      var w = where();
      if (!w) return status;
      status.currentTime = w.position;
      if (status.media) { status.media.duration = album.tracks[w.index].duration; status.media.metadata = metadata(w.index); }
      return status;
    });
    // Track changes inside the stream: tell controllers right away.
    var lastStreamIndex = -1;
    function onPlayerEvent(type, data) {
      if (type === 'track' && kind === 'stream' && data.index !== lastStreamIndex) {
        lastStreamIndex = data.index;
        attempt('broadcastStatus', function () { pm.broadcastStatus(true); });
      }
    }

    // Stream transfer to another device: start there at the track and time heard here.
    attempt('stream transfer', function () {
      pm.setMessageInterceptor(M.MessageType.SESSION_STATE, function (ss) {
        var w = where();
        if (ss && ss.loadRequestData && w && kind === 'stream') {
          ss.loadRequestData.customData = { gapless: { mode: mode, index: w.index, offset: Math.floor(w.position * 10) / 10 } };
          ss.loadRequestData.currentTime = 0;
        }
        return ss;
      });
    });

    function stopped() {
      clearTimeout(pendingTimer); pending = null;
      if (kind === 'stream') player.stop(true);
      if (kind) report('state', { state: 'stopped' });
      kind = null;
    }
    pm.setMessageInterceptor(M.MessageType.STOP, function (req) { stopped(); return req; });
    pm.addEventListener(E.PAUSE, function () { if (kind) report('state', { state: 'paused' }); });
    pm.addEventListener(E.PLAYING, function () { if (kind) report('state', { state: 'playing', mode: mode }); });
    pm.addEventListener(E.ERROR, function (e) { report('error', 'Cast player: ' + (e.detailedErrorCode || '') + ' ' + (e.reason || '') + ' ' + (e.error && e.error.message || '')); });

    // Per-track mode: report progress from the Cast queue.
    setInterval(function () {
      if (kind !== 'queue' || !album) return;
      var w = where(); if (!w) return;
      if (w.index !== lastQueueIndex) { lastQueueIndex = w.index; report('track', { index: w.index, title: album.tracks[w.index].title }); }
      report('time', { index: w.index, position: w.position, duration: album.tracks[w.index].duration });
    }, 250);

    // Commands from the demo page (same shape as Demo.handle).
    function handle(cmd) {
      if (cmd.mode && !MODES[cmd.mode]) return report('error', 'unknown mode ' + cmd.mode);
      if (cmd.cmd === 'play') start(cmd.mode || mode, cmd.index || 0, cmd.offset || 0);
      else if (cmd.cmd === 'pause') pm.pause();
      else if (cmd.cmd === 'resume') pm.play();
      else if (cmd.cmd === 'stop') { if (kind) { stopped(); pm.stop(); } }
      else if (cmd.cmd === 'mode') {
        if (cmd.mode === mode) return;
        var w = kind && where();
        if (w && pm.getPlayerState() !== M.PlayerState.PAUSED) start(cmd.mode, w.index, w.position);
        else { mode = cmd.mode; log('mode set to ' + MODES[mode] + ' (applies on the next play)'); }
      }
    }
    return { handle: handle, onPlayerEvent: onPlayerEvent };
  }
  global.CastSession = CastSession;
})(window);
