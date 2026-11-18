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
 *   - Per-track mode (stock): one Cast media item per track, each its own
 *     MediaSource; when a track ends, the next one is loaded, as a typical
 *     music app's receiver does. Seeks stay inside the track.
 *
 * MIT licence, see LICENSE.
 */
(function (global) {
  'use strict';
  var M = cast.framework.messages, E = cast.framework.events.EventType;
  var MODES = { 'stock': 'per-track (one Cast media item and MediaSource per track)',
                'plain': 'plain MSE gapless queue (one continuous stream)',
                'sample-accurate': 'sample-accurate SourceBuffer (one continuous stream)',
                'opus-bridge': 'Opus bridge (one continuous Opus stream, joins re-encoded) [prototype]',
                'auto': 'automatic (picks a gapless mode from what this device supports)' };

  function CastSession(context, el, report) {
    // album: the manifest of what plays now (album.id names it); it changes only when a LOAD starts the new stream.
    // gen: bumped by everything that takes over playback (a page command, a LOAD from anywhere except our own
    // auto-advance, a Cast STOP, seek or skip), so work still waiting for a manifest knows it is no longer wanted.
    var pm = context.getPlayerManager(), album = null, gen = 0;
    // (a seek or skip still waiting to restart belongs to the old owner too: it is dropped)
    function supersede() { clearTimeout(pendingTimer); pending = null; return ++gen; }
    var player = new QueuePlayer(el, function (type, data) {
      // Per-track: the next track is a new load, so the player can't tell a natural rollover; we can.
      if (type === 'track') { data.natural = !!data.natural || (data.index === rolledTo && !pending); rolledTo = -1; }   // (rolledTo: set by the LOAD that auto-advanced)
      if ((type === 'track' || type === 'time') && album) data.album = album.id;   // so a page on another album knows
      onPlayerEvent(type, data); report(type, data);
    });
    var rolledTo = -1;                            // per-track: the track loaded because the previous one ended
    // mode: what is playing now; requested: picked while paused or stopped, used by the next play.
    var kind = null, mode = 'sample-accurate', actual = mode, requested = null, pending = null, pendingTimer = null;
    function log(m) { report('log', m); }
    function attempt(what, f) { try { f(); } catch (e) { log('skipped ' + what + ': ' + (e && e.message || e)); } }
    function abs(u) { return new URL(u, location.href).href; }
    Demo.loadAlbum('').then(function (a) { if (!album && !gen) album = a; });   // (only if no LOAD came first)

    function metadata(i) {
      var t = album.tracks[i], md = new M.MusicTrackMediaMetadata();
      md.title = t.title; md.albumName = album.title; md.artist = album.artist; md.trackNumber = i + 1;
      return md;
    }
    // Where we are in album terms: { index, position }.
    function where() {
      if (pending) return { index: pending.index, position: pending.offset };
      if (kind === 'stream') return player.position() || { index: 0, position: 0 };
      return null;
    }

    // The Cast framework still has our stream loaded (not finished or stopped).
    function live() { return !!pm.getMediaInformation() && pm.getPlayerState() !== M.PlayerState.IDLE; }

    // ---------------------------------------------------------- loading
    function loadStream(m, index, offset, paused, rolled, albumId) {
      var req = new M.LoadRequestData();
      req.media = new M.MediaInformation();
      req.media.contentId = 'gapless-demo:album';
      req.media.contentType = 'audio/mp4';
      req.customData = { gapless: { mode: m, index: index, offset: offset || 0, paused: !!paused, rolled: !!rolled, album: albumId === undefined ? (album ? album.id : '') : albumId } };   // rolled: the previous track ended by itself
      req.autoplay = !paused;
      return pm.load(req);
    }
    // The album's manifest is fetched first; only then does anything change (mode, album, stream),
    // and only if no Stop or newer command came in meanwhile.
    function start(m, index, offset, albumId) {
      var my = supersede(); albumId = albumId || '';
      return Demo.loadAlbum(albumId).then(function () {
        if (my === gen) return begin(m, index, offset, albumId);
      }, function (e) { if (my === gen) report('error', 'could not load the album: ' + (e && e.message || e)); });
    }
    function begin(m, index, offset, albumId) {
      mode = m; requested = null; index = index || 0; offset = offset || 0;
      var want = m === 'auto' ? Demo.autoMode().mode : m;   // compare what would actually play, not the literal request
      // Continue in place only within the same album: another album is a new stream (the LOAD swaps the manifest).
      if (want && want !== 'stock' && kind === 'stream' && album && album.id === albumId && player.ms && live() && actual === want && SampleAccurateSB.enabled === (want === 'sample-accurate') && !!(global.OpusBridgeSB && OpusBridgeSB.enabled) === (want === 'opus-bridge')) {
        if (m === 'auto') log('automatic mode chose ' + MODES[want] + ': ' + Demo.autoMode().why + ' (already playing that way, continuing in place)');
        restartAt(index, offset, 0, true);        // same kind of stream: continue it in place (and play, if paused)
        return Promise.resolve();
      }
      log('mode: ' + MODES[m] + ', from track ' + (index + 1) + (offset ? ' at ' + offset.toFixed(1) + ' s' : ''));
      var p = loadStream(m, index, offset, false, false, albumId);
      return Promise.resolve(p).catch(function (e) { report('error', 'load failed: ' + (e && (e.message || e.type || e.reason || JSON.stringify(e)))); });
    }

    pm.setMessageInterceptor(M.MessageType.LOAD, function onLoad(req, loaded) {
      var g = req.customData && req.customData.gapless;
      if (!g) {
        var err = new M.ErrorData(M.ErrorType.LOAD_FAILED); err.reason = M.ErrorReason.INVALID_PARAMS;
        log('LOAD without demo data rejected'); return err;
      }
      // Another album (or none yet): fetch its manifest first. What plays now keeps its own
      // manifest until this LOAD actually replaces the stream; a newer LOAD meanwhile wins.
      // (Commands fetch the manifest before they load; a LOAD from elsewhere, e.g. a stream transfer, may still need it.)
      // (our own per-track auto-advance doesn't take over: a Play waiting for its manifest still wins)
      var want = g.album || '', my = g.rolled ? gen : supersede(), next = loaded || (album && album.id === want ? album : Demo.cachedAlbum(want));
      if (!next) {
        return Demo.loadAlbum(want).then(function (a) {
          if (my !== gen) { var c = new M.ErrorData(M.ErrorType.LOAD_CANCELLED || M.ErrorType.LOAD_FAILED); log('LOAD superseded by a newer command'); return c; }
          return onLoad(req, a);
        }, function (e) {
          report('error', 'could not load the album: ' + (e && e.message || e));
          var f = new M.ErrorData(M.ErrorType.LOAD_FAILED); f.reason = M.ErrorReason.INVALID_PARAMS; return f;
        });
      }
      clearTimeout(pendingTimer); pending = null;
      log('LOAD: ' + g.mode + ', track ' + (g.index + 1) + ' at ' + (+g.offset || 0).toFixed(1) + ' s' + (req.type ? ' (' + req.type + ')' : ''));
      mode = g.mode; actual = mode;
      if (mode === 'auto') {
        var pick = Demo.autoMode(); actual = pick.mode;
        if (!actual) {
          report('error', 'automatic mode: ' + pick.why);
          var e2 = new M.ErrorData(M.ErrorType.LOAD_FAILED); e2.reason = M.ErrorReason.NOT_SUPPORTED || M.ErrorReason.INVALID_PARAMS; return e2;
        }
        log('automatic mode chose ' + MODES[actual] + ': ' + pick.why);
      }
      if (actual === 'sample-accurate' && !SampleAccurateSB.supported()) {
        report('error', 'sample-accurate mode needs ' + SampleAccurateSB.missing() + ', which this device lacks; playing the plain gapless queue instead');
        actual = 'plain';
        if (mode === 'sample-accurate') mode = 'plain';
      }
      report('state', { state: g.paused ? 'paused' : 'playing', mode: actual, auto: g.mode === 'auto', fallback: g.mode !== 'auto' && actual !== g.mode });
      kind = 'stream';
      SampleAccurateSB.enabled = actual === 'sample-accurate';
      if (global.OpusBridgeSB) OpusBridgeSB.enabled = actual === 'opus-bridge';
      album = next;                               // from here on the new stream and its manifest go together
      rolledTo = g.rolled ? g.index : -1;         // only this load's own first track counts as a rollover; any other load clears it
      player.play(album.tracks, g.index, g.offset, actual === 'stock', { external: true });
      req.media.contentUrl = player.url;          // our MediaSource: the Cast framework plays it on its media element
      req.media.contentType = 'audio/mp4';
      req.media.streamType = M.StreamType.BUFFERED;
      req.media.metadata = metadata(g.index);
      req.media.duration = album.tracks[g.index].duration;
      // Start where the stream starts (its timeline begins at 0, so that is the offset).
      // The queue seeks there too; telling the Cast framework the same point stops it
      // from seeking back to 0 after loading, which left playback stuck at 0:00 with
      // no audio buffered there.
      req.currentTime = +g.offset || 0;
      req.autoplay = !g.paused;                   // a reload for a seek while paused stays paused
      return req;
    });

    // ---------------------------------------------- seeks and skips (stream)
    // Several presses in a row (dragging the seek bar sends dozens of SEEKs,
    // or next, next, next) collapse into one restart.
    // play: true = play afterwards (the page's Play / Go, or a seek asking to start),
    // false = pause afterwards (a seek asking to pause), undefined = keep the current state.
    function restartAt(index, offset, delay, play) {
      index = Math.max(0, Math.min(album.tracks.length - 1, index));
      var dur = album.tracks[index].duration;
      offset = Math.max(0, Math.min(offset, dur - Math.min(1, dur / 4)));   // not past the end (short tracks: a quarter of their length)
      pending = { index: index, offset: offset }; rolledTo = -1;
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(function () {
        var x = pending; pending = null;
        var wasPaused = pm.getPlayerState() === M.PlayerState.PAUSED;
        // (a reload keeps a paused stream paused unless the request asked to start)
        if (!live() || !player.reset(album.tracks, x.index, x.offset)) { loadStream(mode, x.index, x.offset, play === undefined ? wasPaused : play === false); return; }
        showTrack(x.index);
        if (play === true && wasPaused) attempt('play', function () { pm.play(); });
        else if (play === false && !wasPaused) attempt('pause', function () { pm.pause(); });
      }, delay == null ? 600 : delay);
      attempt('broadcastStatus', function () { pm.broadcastStatus(true); });
    }
    // Make the current track the media item controllers display. Setting the media
    // information (not just answering status requests) is what makes phone
    // notifications and other remotes refresh their title and progress bar.
    function showTrack(i) {
      var info = pm.getMediaInformation();
      if (!info || !album) return;
      info.metadata = metadata(i); info.duration = album.tracks[i].duration;
      attempt('setMediaInformation', function () { pm.setMediaInformation(info, true); });
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
      supersede();
      if (kind !== 'stream') return req;
      var w = where(), t = req.currentTime;
      if (req.relativeTime != null) t = w.position + req.relativeTime;
      if (t == null) return req;
      // What the controller wants afterwards: start, pause, or (unspecified) stay as it is.
      var after = req.resumeState === 'PLAYBACK_START' ? true : req.resumeState === 'PLAYBACK_PAUSE' ? false : undefined;
      if (mode === 'stock') {
        // Per-track: the item is the track, so seek natively, unless the target was
        // already evicted behind the playhead (the queue only fills forwards): then
        // reload the track from there.
        var r = player.element().buffered, ok = !r.length || t >= r.end(r.length - 1);
        for (var k = 0; k < r.length && !ok; k++) if (t >= r.start(k) && t <= r.end(k)) ok = true;
        if (ok) return req;
        log('seek back to ' + t.toFixed(1) + ' s: no longer buffered, reloading the track from there');
        loadStream('stock', w.index, t, after === undefined ? pm.getPlayerState() === M.PlayerState.PAUSED : !after);
        return null;
      }
      log('seek to ' + t.toFixed(1) + ' s in track ' + (w.index + 1));
      restartAt(w.index, t, undefined, after);
      return null;
    });
    attempt('next/previous buttons', function () {
      pm.setMessageInterceptor(M.MessageType.QUEUE_UPDATE, function (req) {
        if (kind === 'stream' && req && req.jump) { supersede(); skip(req.jump); return null; }
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
      if (type === 'ended' && data && kind === 'stream') {
        // Per-track: the track's own media item has finished; load the next one (this is where the gap comes from).
        if (data.perTrack && data.index + 1 < album.tracks.length) { log('track ended: loading the next track as a new media item (stock behaviour)'); loadStream('stock', data.index + 1, 0, false, true); }
        else { log('album finished'); stopped(); }
        return;
      }
      if (type === 'track' && kind === 'stream' && data.index !== lastStreamIndex) {
        lastStreamIndex = data.index;
        if (!pending) showTrack(data.index);
        attempt('broadcastStatus', function () { pm.broadcastStatus(true); });
      }
    }

    // Stream transfer to another device: start there at the track and time heard here.
    attempt('stream transfer', function () {
      pm.setMessageInterceptor(M.MessageType.SESSION_STATE, function (ss) {
        var w = where();
        log('SESSION_STATE requested (stream transfer / group change): ' + (w ? 'track ' + (w.index + 1) + ' at ' + w.position.toFixed(1) + ' s' : 'nothing playing'));
        if (ss && ss.loadRequestData && w && kind === 'stream') {
          ss.loadRequestData.customData = { gapless: { mode: mode, index: w.index, offset: Math.floor(w.position * 10) / 10, album: album ? album.id : '' } };
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
    pm.setMessageInterceptor(M.MessageType.STOP, function (req) { supersede(); stopped(); return req; });
    pm.addEventListener(E.PAUSE, function () { if (kind) report('state', { state: 'paused' }); });
    pm.addEventListener(E.PLAYING, function () { if (kind) report('state', { state: 'playing', mode: actual, auto: mode === 'auto' }); });
    pm.addEventListener(E.ERROR, function (e) { report('error', 'Cast player: ' + (e.detailedErrorCode || '') + ' ' + (e.reason || '') + ' ' + (e.error && e.error.message || '')); });

    // Commands from the demo page (same shape as Demo.handle).
    function handle(cmd) {
      if (cmd.mode && !MODES[cmd.mode]) return report('error', 'unknown mode ' + cmd.mode);
      if (cmd.cmd === 'play') {
        start(cmd.mode || requested || mode, cmd.index || 0, cmd.offset || 0, cmd.album || '');
      }
      else if (cmd.cmd === 'pause') pm.pause();
      else if (cmd.cmd === 'resume') pm.play();
      else if (cmd.cmd === 'stop') { supersede(); if (kind) { stopped(); pm.stop(); } }
      else if (cmd.cmd === 'mode') {
        var w = kind && where();
        if (w && pm.getPlayerState() !== M.PlayerState.PAUSED) { if (cmd.mode !== mode) start(cmd.mode, w.index, w.position, album ? album.id : ''); }
        else { requested = cmd.mode === mode ? null : cmd.mode; log('mode set to ' + MODES[cmd.mode] + ' (applies on the next play)'); }
      }
    }
    attempt('diagnostic events', function () {
      ['REQUEST_RESUME_SESSION', 'REQUEST_SESSION_STATE', 'REQUEST_STOP'].forEach(function (n) {
        if (E[n]) pm.addEventListener(E[n], function () { log('Cast event ' + n); });
      });
      var SE = cast.framework.system && cast.framework.system.EventType;
      if (SE) ['SENDER_CONNECTED', 'SENDER_DISCONNECTED'].forEach(function (n) {
        if (SE[n]) context.addEventListener(SE[n], function (e) { log('Cast ' + n.toLowerCase().replace('_', ' ') + (e && e.userAgent ? ': ' + String(e.userAgent).slice(0, 40) : '')); });
      });
    });
    return { handle: handle, onPlayerEvent: onPlayerEvent };
  }
  global.CastSession = CastSession;
})(window);
