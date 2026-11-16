# Vendored: libopus compiled to asm.js

`opusscript_native_nasm.js` is copied unchanged from [opusscript](https://www.npmjs.com/package/opusscript) 0.1.1 (MIT, see `LICENSE.opusscript`). It is libopus (BSD, see `COPYING.libopus`) compiled to plain JavaScript.

The sample-accurate wrapper loads it only on devices with no Web Audio decoder, such as Cast audio-only devices that run the lightweight runtime. Everywhere else the browser's own `decodeAudioData` is used.

Note: opusscript's `_decode` writes each 16-bit sample as two 16-bit cells (low byte, then high byte); `decodeJs` in `sample-accurate-sb.js` reassembles them.
