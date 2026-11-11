'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

const { prependId3v2Tag, hasId3v2Header } = require('../src/mp3-tagger.js');
const { TsAudioDemuxer, isTransportStream } = require('../src/ts-demuxer.js');
const { parseAdtsFrames, muxAdtsToM4a } = require('../src/m4a-muxer.js');
const {
  pickBestVariantFromMaster,
  parseMediaPlaylist,
  downloadHlsAudio,
} = require('../src/hls-downloader.js');
const { sanitizeFilename, buildFilename } = require('../src/background.js');

function buildTsPacket({ pid, pusi = false, afc = 1, cc = 0, payload = new Uint8Array(0) }) {
  const pkt = new Uint8Array(188);
  pkt.fill(0xff);
  pkt[0] = 0x47;
  pkt[1] = ((pusi ? 1 : 0) << 6) | ((pid >> 8) & 0x1f);
  pkt[2] = pid & 0xff;
  pkt[3] = (afc << 4) | (cc & 0x0f);

  let offset = 4;
  if (afc === 3) {
    // Minimal 2-byte adaptation field (1 byte length = 1, 1 byte flags = 0)
    pkt[4] = 1;
    pkt[5] = 0;
    offset = 6;
  }
  pkt.set(payload.subarray(0, 188 - offset), offset);
  return pkt;
}

function buildPatPacket(pmtPid) {
  // pointer_field (0) + PAT section
  const sec = new Uint8Array([
    0x00, // pointer_field
    0x00, // table_id = 0x00
    0xb0, 0x0d, // section_length = 13
    0x00, 0x01, // transport_stream_id
    0xc1, 0x00, 0x00,
    0x00, 0x01, // program_number = 1
    0xe0 | ((pmtPid >> 8) & 0x1f), pmtPid & 0xff,
    0x00, 0x00, 0x00, 0x00, // CRC32 placeholder
  ]);
  return buildTsPacket({ pid: 0x0000, pusi: true, payload: sec });
}

function buildPmtPacket(pmtPid, audioPid, streamType) {
  const sec = new Uint8Array([
    0x00, // pointer_field
    0x02, // table_id = 0x02
    0xb0, 0x12, // section_length = 18
    0x00, 0x01, // program_number = 1
    0xc1, 0x00, 0x00,
    0xe0 | ((audioPid >> 8) & 0x1f), audioPid & 0xff, // PCR PID
    0xf0, 0x00, // program_info_length = 0
    streamType,
    0xe0 | ((audioPid >> 8) & 0x1f), audioPid & 0xff,
    0xf0, 0x00, // ES_info_length = 0
    0x00, 0x00, 0x00, 0x00, // CRC32 placeholder
  ]);
  return buildTsPacket({ pid: pmtPid, pusi: true, payload: sec });
}

function buildAudioPesPackets(audioPid, elementaryBytes) {
  const pesHeaderDataLen = 2;
  const pesPacketLen = 3 + pesHeaderDataLen + elementaryBytes.length;
  const pesHeader = new Uint8Array([
    0x00, 0x00, 0x01, 0xc0, // Audio stream 0xC0
    (pesPacketLen >> 8) & 0xff, pesPacketLen & 0xff,
    0x80, 0x00, // flags
    pesHeaderDataLen,
    0xff, 0xff, // dummy optional header bytes
  ]);

  const packets = [];
  let offset = 0;
  let first = true;
  let cc = 0;

  while (offset < elementaryBytes.length) {
    if (first) {
      const cap = 184 - pesHeader.length;
      const chunk = elementaryBytes.subarray(offset, offset + cap);
      const payload = new Uint8Array(pesHeader.length + chunk.length);
      payload.set(pesHeader, 0);
      payload.set(chunk, pesHeader.length);
      packets.push(buildTsPacket({ pid: audioPid, pusi: true, afc: 1, cc: cc++, payload }));
      offset += chunk.length;
      first = false;
    } else {
      // Test adaptation field (afc = 3) on continuation packets
      const cap = 182;
      const chunk = elementaryBytes.subarray(offset, offset + cap);
      packets.push(buildTsPacket({ pid: audioPid, pusi: false, afc: 3, cc: cc++, payload: chunk }));
      offset += chunk.length;
    }
  }
  return packets;
}

function concatArrays(list) {
  const total = list.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of list) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

function buildDummyAdtsFrame(payloadByteCount = 32) {
  const totalLen = 7 + payloadByteCount;
  const frame = new Uint8Array(totalLen);
  // Syncword 0xFFF, ID=0 (MPEG-4), layer=00, protection_absent=1
  frame[0] = 0xff;
  frame[1] = 0xf1;
  // profile=1 (AAC LC -> bits 01), sr_idx=4 (44100 -> 0100), private=0, ch_cfg_hi=0 (2ch -> 010)
  frame[2] = (1 << 6) | (4 << 2) | 0;
  frame[3] = (2 << 6) | ((totalLen >> 11) & 0x03);
  frame[4] = (totalLen >> 3) & 0xff;
  frame[5] = ((totalLen & 0x07) << 5) | 0x1f;
  frame[6] = 0xfc;
  for (let i = 7; i < totalLen; i++) {
    frame[i] = (i * 13) & 0xff;
  }
  return frame;
}

test('manifest.json is valid Firefox MV2 manifest with required permissions', () => {
  const manifestPath = path.join(__dirname, '..', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.manifest_version, 2);
  assert.ok(manifest.browser_specific_settings?.gecko?.id);
  assert.deepEqual(manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required, ['none']);
  assert.ok(manifest.permissions.includes('downloads'));
  assert.ok(manifest.permissions.includes('webRequest'));
  assert.ok(manifest.permissions.includes('https://*/*'));
  assert.ok(manifest.background?.scripts?.length >= 4);
  assert.equal(manifest.content_scripts.length, 2);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
});

test('mp3-tagger prepends valid ID3v2.3 UTF-16LE tags and skips if already tagged', () => {
  const rawMp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x11, 0x22, 0x33]);
  const tagged = prependId3v2Tag(rawMp3, {
    artist: 'Кино',
    title: 'Группа крови',
  });

  assert.equal(hasId3v2Header(tagged), true);
  assert.equal(String.fromCharCode(...tagged.subarray(0, 3)), 'ID3');
  assert.equal(tagged[3], 0x03); // ID3v2.3

  // Verify raw MP3 bytes appear intact at the end
  assert.deepEqual(tagged.subarray(tagged.length - rawMp3.length), rawMp3);

  // Calling again does not duplicate ID3 header
  const doubleTagged = prependId3v2Tag(tagged, { artist: 'Other', title: 'Other' });
  assert.equal(doubleTagged.length, tagged.length);
});

test('ts-demuxer extracts MP3 elementary stream across packets and adaptation fields', () => {
  const rawMp3 = new Uint8Array(300);
  rawMp3[0] = 0xff;
  rawMp3[1] = 0xfb;
  for (let i = 2; i < rawMp3.length; i++) rawMp3[i] = i & 0xff;

  const tsBytes = concatArrays([
    buildPatPacket(0x1000),
    buildPmtPacket(0x1000, 0x0101, 0x03),
    ...buildAudioPesPackets(0x0101, rawMp3),
  ]);

  assert.equal(isTransportStream(tsBytes), true);

  const demuxer = new TsAudioDemuxer();
  demuxer.push(tsBytes);
  const res = demuxer.finish();

  assert.equal(res.codec, 'mp3');
  assert.deepEqual(res.data.subarray(0, rawMp3.length), rawMp3);
});

test('m4a-muxer converts ADTS frames to valid ISO-BMFF M4A with accurate stco offset', () => {
  const adts = concatArrays([
    buildDummyAdtsFrame(24),
    buildDummyAdtsFrame(28),
    buildDummyAdtsFrame(20),
  ]);

  const parsed = parseAdtsFrames(adts);
  assert.equal(parsed.frames.length, 3);
  assert.equal(parsed.sampleRate, 44100);
  assert.equal(parsed.channelConfig, 2);

  const m4a = muxAdtsToM4a(adts, { title: 'Test Song', artist: 'Test Artist' });
  assert.ok(m4a instanceof Uint8Array);
  assert.equal(String.fromCharCode(...m4a.subarray(4, 8)), 'ftyp');
  assert.equal(String.fromCharCode(...m4a.subarray(8, 12)), 'M4A ');

  // Verify stco points directly to the start of mdat payload
  const view = new DataView(m4a.buffer, m4a.byteOffset, m4a.byteLength);
  let stcoOffset = -1;
  let mdatOffset = -1;
  for (let i = 0; i + 4 <= m4a.length; i++) {
    const tag = String.fromCharCode(m4a[i], m4a[i + 1], m4a[i + 2], m4a[i + 3]);
    if (tag === 'stco') stcoOffset = view.getUint32(i + 12, false);
    if (tag === 'mdat') mdatOffset = i + 4; // payload begins after 'mdat'
  }
  assert.ok(stcoOffset > 0);
  assert.equal(stcoOffset, mdatOffset);
});

test('hls-downloader picks highest bandwidth variant and parses AES-128 playlist', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=128000',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=320000',
    'high/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=192000',
    'mid/index.m3u8',
  ].join('\n');

  const best = pickBestVariantFromMaster(master, 'https://cdn.vkuseraudio.net/track/master.m3u8');
  assert.equal(best.bandwidth, 320000);
  assert.equal(best.url, 'https://cdn.vkuseraudio.net/track/high/index.m3u8');

  const media = [
    '#EXTM3U',
    '#EXT-X-MEDIA-SEQUENCE:10',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXTINF:5.0,',
    'seg0.ts',
    '#EXTINF:5.0,',
    'seg1.ts',
  ].join('\n');

  const parsed = parseMediaPlaylist(media, best.url);
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[0].url, 'https://cdn.vkuseraudio.net/track/high/seg0.ts');
  assert.equal(parsed.segments[0].key.uri, 'https://cdn.vkuseraudio.net/track/high/key.bin');
  assert.equal(parsed.segments[0].key.iv[15], 10);
  assert.equal(parsed.segments[1].key.iv[15], 11);
});

test('hls-downloader end-to-end: master -> highest bitrate -> AES-128 decrypt -> TS demux -> ID3 MP3', async () => {
  const keyBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) keyBytes[i] = i + 1;

  const mp3Part1 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6]);
  const mp3Part2 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 7, 8, 9, 10, 11, 12]);

  const tsSeg0 = concatArrays([
    buildPatPacket(0x1000),
    buildPmtPacket(0x1000, 0x0101, 0x03),
    ...buildAudioPesPackets(0x0101, mp3Part1),
  ]);
  const tsSeg1 = concatArrays(buildAudioPesPackets(0x0101, mp3Part2));

  const iv0 = new Uint8Array(16);
  const iv1 = new Uint8Array(16);
  iv1[15] = 1;

  const cryptoKey = await webcrypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  const encSeg0 = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv: iv0 }, cryptoKey, tsSeg0));
  const encSeg1 = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv: iv1 }, cryptoKey, tsSeg1));

  const mockResponses = new Map([
    [
      'https://cdn.vk.test/master.m3u8',
      new TextEncoder().encode(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=320000\nhigh.m3u8\n'
      ),
    ],
    [
      'https://cdn.vk.test/high.m3u8',
      new TextEncoder().encode(
        '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:5,\nseg0.ts\n#EXTINF:5,\nseg1.ts\n'
      ),
    ],
    ['https://cdn.vk.test/key.bin', keyBytes],
    ['https://cdn.vk.test/seg0.ts', encSeg0],
    ['https://cdn.vk.test/seg1.ts', encSeg1],
  ]);

  const fetchMock = async (url) => {
    const data = mockResponses.get(url);
    if (!data) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    };
  };

  const result = await downloadHlsAudio('https://cdn.vk.test/master.m3u8', {
    artist: 'Artist',
    title: 'Best Bitrate Track',
    fetchImpl: fetchMock,
  });

  assert.equal(result.ext, 'mp3');
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(hasId3v2Header(result.data), true);
  // Check raw MP3 frames appear inside output
  const expectedBody = concatArrays([mp3Part1, mp3Part2]);
  const actualTail = result.data.subarray(result.data.length - expectedBody.length);
  assert.deepEqual(actualTail, expectedBody);
});

test('hls-downloader end-to-end AAC ADTS inside TS -> M4A container', async () => {
  const adtsFrame1 = buildDummyAdtsFrame(24);
  const adtsFrame2 = buildDummyAdtsFrame(28);
  const tsSeg = concatArrays([
    buildPatPacket(0x1000),
    buildPmtPacket(0x1000, 0x0102, 0x0f), // 0x0F = AAC ADTS
    ...buildAudioPesPackets(0x0102, concatArrays([adtsFrame1, adtsFrame2])),
  ]);

  const fetchMock = async (url) => {
    if (url === 'https://cdn.vk.test/aac.m3u8') {
      const text = '#EXTM3U\n#EXTINF:5,\nseg0.ts\n';
      const bytes = new TextEncoder().encode(text);
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
    }
    if (url === 'https://cdn.vk.test/seg0.ts') {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => tsSeg.buffer.slice(tsSeg.byteOffset, tsSeg.byteOffset + tsSeg.byteLength),
      };
    }
    return { ok: false, status: 404 };
  };

  const result = await downloadHlsAudio('https://cdn.vk.test/aac.m3u8', {
    artist: 'Artist',
    title: 'AAC Track',
    fetchImpl: fetchMock,
  });

  assert.equal(result.ext, 'm4a');
  assert.equal(result.mimeType, 'audio/mp4');
  assert.equal(String.fromCharCode(...result.data.subarray(4, 8)), 'ftyp');
  assert.equal(String.fromCharCode(...result.data.subarray(8, 12)), 'M4A ');
});

test('sanitizeFilename and buildFilename produce safe Windows/Linux filenames', () => {
  assert.equal(sanitizeFilename('  Track: "Test" <1>?*. '), 'Track Test 1');
  assert.equal(sanitizeFilename('Track\u200B\u200E\u202E Name\uFEFF'), 'Track Name');
  assert.equal(buildFilename('Daft Punk', 'Get Lucky / Remix', 'mp3'), 'Daft Punk - Get Lucky Remix.mp3');
  assert.equal(buildFilename('', 'Untitled', 'm4a'), 'Untitled.m4a');
});
