(function (root) {
  'use strict';

  const SAMPLE_RATES = [
    96000, 88200, 64000, 48000, 44100, 32000,
    24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ];

  const encoder = new TextEncoder();

  function u16(val) {
    return new Uint8Array([(val >>> 8) & 0xff, val & 0xff]);
  }

  function u32(val) {
    return new Uint8Array([
      (val >>> 24) & 0xff,
      (val >>> 16) & 0xff,
      (val >>> 8) & 0xff,
      val & 0xff,
    ]);
  }

  function ascii(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      out[i] = str.charCodeAt(i) & 0xff;
    }
    return out;
  }

  function concat(...arrays) {
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
      out.set(a, offset);
      offset += a.length;
    }
    return out;
  }

  function box(type, ...children) {
    const body = concat(...children);
    return concat(u32(8 + body.length), ascii(type), body);
  }

  function fullBox(type, version, flags, ...children) {
    const header = new Uint8Array([
      version & 0xff,
      (flags >>> 16) & 0xff,
      (flags >>> 8) & 0xff,
      flags & 0xff,
    ]);
    return box(type, header, ...children);
  }

  function descriptor(tag, payload) {
    // Simple 1-byte length when < 128 (all our descriptors are < 64 bytes)
    return concat(new Uint8Array([tag, payload.length & 0x7f]), payload);
  }

  /**
   * Parses raw ADTS AAC frames from an elementary stream buffer.
   */
  function parseAdtsFrames(bytes) {
    const frames = [];
    let sampleRate = 44100;
    let channelConfig = 2;
    let audioObjectType = 2;
    let sampleRateIndex = 4;

    let i = 0;
    while (i + 7 <= bytes.length) {
      if (bytes[i] !== 0xff || (bytes[i + 1] & 0xf6) !== 0xf0) {
        i++;
        continue;
      }

      const protectionAbsent = bytes[i + 1] & 0x01;
      const headerLen = protectionAbsent ? 7 : 9;
      if (i + headerLen > bytes.length) break;

      const profile = (bytes[i + 2] >>> 6) & 0x03;
      const srIdx = (bytes[i + 2] >>> 2) & 0x0f;
      const chCfg = ((bytes[i + 2] & 0x01) << 2) | ((bytes[i + 3] >>> 6) & 0x03);
      const frameLen =
        ((bytes[i + 3] & 0x03) << 11) |
        (bytes[i + 4] << 3) |
        ((bytes[i + 5] >>> 5) & 0x07);

      if (frameLen < headerLen || i + frameLen > bytes.length) {
        i++;
        continue;
      }

      if (frames.length === 0) {
        audioObjectType = profile + 1;
        sampleRateIndex = srIdx;
        sampleRate = SAMPLE_RATES[srIdx] || 44100;
        channelConfig = chCfg || 2;
      }

      frames.push(bytes.subarray(i + headerLen, i + frameLen));
      i += frameLen;
    }

    return { frames, sampleRate, sampleRateIndex, channelConfig, audioObjectType };
  }

  function buildMetaItunesAtom(atomName, text) {
    const dataPayload = concat(
      u32(1), // UTF-8 type indicator
      u32(0), // locale
      encoder.encode(text)
    );
    return box(atomName, box('data', dataPayload));
  }

  function buildUdtaBox(title, artist) {
    const items = [];
    if (title && title.trim()) {
      items.push(buildMetaItunesAtom('\xa9nam', title.trim()));
    }
    if (artist && artist.trim()) {
      items.push(buildMetaItunesAtom('\xa9ART', artist.trim()));
    }
    if (items.length === 0) return null;

    const hdlr = fullBox(
      'hdlr',
      0,
      0,
      u32(0),
      ascii('mdir'),
      ascii('appl'),
      u32(0),
      u32(0),
      new Uint8Array([0])
    );
    const meta = fullBox('meta', 0, 0, hdlr, box('ilst', ...items));
    return box('udta', meta);
  }

  /**
   * Remuxes raw ADTS AAC bytes into a fast-start ISO-BMFF (.m4a) container without re-encoding.
   * Returns null if no valid ADTS frames are found.
   */
  function muxAdtsToM4a(adtsBytes, { title = '', artist = '', embedMetadata = true } = {}) {
    const parsed = parseAdtsFrames(adtsBytes);
    if (parsed.frames.length === 0) {
      return null;
    }

    const { frames, sampleRate, sampleRateIndex, channelConfig, audioObjectType } = parsed;
    const totalSamples = frames.length * 1024;
    const totalPayloadBytes = frames.reduce((sum, f) => sum + f.length, 0);
    const durationSec = totalSamples / sampleRate || 1;
    const avgBitrate = Math.round((totalPayloadBytes * 8) / durationSec);

    const ftyp = box(
      'ftyp',
      ascii('M4A '),
      u32(0),
      ascii('M4A '),
      ascii('mp42'),
      ascii('isom'),
      u32(0)
    );

    const identityMatrix = concat(
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000)
    );

    const mvhd = fullBox(
      'mvhd',
      0,
      0,
      u32(0), // creation_time
      u32(0), // modification_time
      u32(sampleRate),
      u32(totalSamples),
      u32(0x00010000), // rate 1.0
      u16(0x0100),     // volume 1.0
      new Uint8Array(10),
      identityMatrix,
      new Uint8Array(24),
      u32(2) // next_track_ID
    );

    const tkhd = fullBox(
      'tkhd',
      0,
      7, // enabled | in_movie | in_preview
      u32(0),
      u32(0),
      u32(1), // track_ID
      u32(0),
      u32(totalSamples),
      new Uint8Array(8),
      u16(0),
      u16(0),
      u16(0x0100), // volume 1.0
      u16(0),
      identityMatrix,
      u32(0),
      u32(0)
    );

    const mdhd = fullBox(
      'mdhd',
      0,
      0,
      u32(0),
      u32(0),
      u32(sampleRate),
      u32(totalSamples),
      u16(0x55c4), // 'und'
      u16(0)
    );

    const hdlr = fullBox(
      'hdlr',
      0,
      0,
      u32(0),
      ascii('soun'),
      u32(0),
      u32(0),
      u32(0),
      ascii('SoundHandler\0')
    );

    const smhd = fullBox('smhd', 0, 0, u16(0), u16(0));
    const urlBox = fullBox('url ', 0, 1);
    const dref = fullBox('dref', 0, 0, u32(1), urlBox);
    const dinf = box('dinf', dref);

    // AudioSpecificConfig (2 bytes)
    const asc = new Uint8Array([
      ((audioObjectType & 0x1f) << 3) | ((sampleRateIndex & 0x0e) >>> 1),
      ((sampleRateIndex & 0x01) << 7) | ((channelConfig & 0x0f) << 3),
    ]);

    const decSpecificInfo = descriptor(0x05, asc);
    const decConfig = descriptor(
      0x04,
      concat(
        new Uint8Array([
          0x40, // MPEG-4 Audio
          0x15, // AudioStream
          0x00, 0x00, 0x00, // bufferSizeDB
        ]),
        u32(avgBitrate),
        u32(avgBitrate),
        decSpecificInfo
      )
    );
    const slConfig = descriptor(0x06, new Uint8Array([0x02]));
    const esDescr = descriptor(0x03, concat(u16(1), new Uint8Array([0x00]), decConfig, slConfig));
    const esds = fullBox('esds', 0, 0, esDescr);

    const mp4a = box(
      'mp4a',
      new Uint8Array(6),
      u16(1), // data_reference_index
      new Uint8Array(8),
      u16(channelConfig),
      u16(16), // sample_size
      u16(0),
      u16(0),
      u32((sampleRate & 0xffff) << 16),
      esds
    );

    const stsd = fullBox('stsd', 0, 0, u32(1), mp4a);
    const stts = fullBox('stts', 0, 0, u32(1), u32(frames.length), u32(1024));
    const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(frames.length), u32(1));

    const stszSizes = new Uint8Array(frames.length * 4);
    const stszView = new DataView(stszSizes.buffer);
    for (let idx = 0; idx < frames.length; idx++) {
      stszView.setUint32(idx * 4, frames[idx].length, false);
    }
    const stsz = fullBox('stsz', 0, 0, u32(0), u32(frames.length), stszSizes);

    // Placeholder stco (single chunk pointing to mdat payload)
    const stco = fullBox('stco', 0, 0, u32(1), u32(0));

    const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
    const minf = box('minf', smhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    const trak = box('trak', tkhd, mdia);

    const udta = embedMetadata ? buildUdtaBox(title, artist) : null;
    const moovChildren = udta ? [mvhd, trak, udta] : [mvhd, trak];
    const moov = box('moov', ...moovChildren);

    // Patch stco chunk offset inside moov:
    // stco is the last box inside stbl, and its 4-byte entry is the last 4 bytes of stbl;
    // since udta may follow trak, find exact offset of 'stco' signature inside moov.
    const mdatDataOffset = ftyp.length + moov.length + 8;
    const moovView = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
    let patched = false;
    for (let pos = 8; pos + 20 <= moov.length; pos++) {
      if (
        moov[pos] === 0x73 && // s
        moov[pos + 1] === 0x74 && // t
        moov[pos + 2] === 0x63 && // c
        moov[pos + 3] === 0x6f    // o
      ) {
        // fullBox('stco'): [4 size][4 'stco'][4 ver+flags][4 entry_count][4 offset]
        moovView.setUint32(pos + 12, mdatDataOffset, false);
        patched = true;
        break;
      }
    }
    if (!patched) return null;

    const mdatHeader = concat(u32(8 + totalPayloadBytes), ascii('mdat'));
    return concat(ftyp, moov, mdatHeader, ...frames);
  }

  const api = { parseAdtsFrames, muxAdtsToM4a };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.VKMS = root.VKMS || {};
    root.VKMS.m4aMuxer = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
