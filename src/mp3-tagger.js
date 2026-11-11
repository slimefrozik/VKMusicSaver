(function (root) {
  'use strict';

  function encodeSyncsafe32(value) {
    return [
      (value >>> 21) & 0x7f,
      (value >>> 14) & 0x7f,
      (value >>> 7) & 0x7f,
      value & 0x7f,
    ];
  }

  function encodeUtf16LeWithBom(text) {
    const str = String(text);
    const out = new Uint8Array(1 + 2 + str.length * 2 + 2);
    out[0] = 0x01; // UTF-16 with BOM
    out[1] = 0xff;
    out[2] = 0xfe;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      out[3 + i * 2] = code & 0xff;
      out[3 + i * 2 + 1] = (code >>> 8) & 0xff;
    }
    // Null terminator (0x0000) is already zero-initialized
    return out;
  }

  function createTextFrame(frameId, text) {
    const payload = encodeUtf16LeWithBom(text);
    const frame = new Uint8Array(10 + payload.length);
    for (let i = 0; i < 4; i++) {
      frame[i] = frameId.charCodeAt(i);
    }
    const size = payload.length;
    frame[4] = (size >>> 24) & 0xff;
    frame[5] = (size >>> 16) & 0xff;
    frame[6] = (size >>> 8) & 0xff;
    frame[7] = size & 0xff;
    // Flags [8..9] = 0x00, 0x00
    frame.set(payload, 10);
    return frame;
  }

  function hasId3v2Header(bytes) {
    return (
      bytes.length >= 10 &&
      bytes[0] === 0x49 && // I
      bytes[1] === 0x44 && // D
      bytes[2] === 0x33    // 3
    );
  }

  /**
   * Prepends an ID3v2.3 tag with Title (TIT2) and Artist (TPE1) to raw MP3 bytes
   * if an ID3v2 header is not already present.
   */
  function prependId3v2Tag(mp3Bytes, { title = '', artist = '' } = {}) {
    if (!(mp3Bytes instanceof Uint8Array) || mp3Bytes.length === 0) {
      return mp3Bytes;
    }
    if (hasId3v2Header(mp3Bytes)) {
      return mp3Bytes;
    }

    const frames = [];
    if (title && title.trim()) {
      frames.push(createTextFrame('TIT2', title.trim()));
    }
    if (artist && artist.trim()) {
      frames.push(createTextFrame('TPE1', artist.trim()));
    }
    if (frames.length === 0) {
      return mp3Bytes;
    }

    const framesSize = frames.reduce((sum, f) => sum + f.length, 0);
    const out = new Uint8Array(10 + framesSize + mp3Bytes.length);

    out[0] = 0x49; // I
    out[1] = 0x44; // D
    out[2] = 0x33; // 3
    out[3] = 0x03; // ID3v2.3
    out[4] = 0x00;
    out[5] = 0x00;
    const syncsafe = encodeSyncsafe32(framesSize);
    out[6] = syncsafe[0];
    out[7] = syncsafe[1];
    out[8] = syncsafe[2];
    out[9] = syncsafe[3];

    let offset = 10;
    for (const frame of frames) {
      out.set(frame, offset);
      offset += frame.length;
    }
    out.set(mp3Bytes, offset);
    return out;
  }

  const api = { prependId3v2Tag, hasId3v2Header };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.VKMS = root.VKMS || {};
    root.VKMS.mp3Tagger = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
