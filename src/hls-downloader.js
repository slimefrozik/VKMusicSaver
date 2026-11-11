(function (root) {
  'use strict';

  const getDeps = () => {
    if (typeof module !== 'undefined' && module.exports) {
      return {
        tsDemuxer: require('./ts-demuxer.js'),
        mp3Tagger: require('./mp3-tagger.js'),
        m4aMuxer: require('./m4a-muxer.js'),
        subtle: globalThis.crypto?.subtle || require('node:crypto').webcrypto.subtle,
      };
    }
    return {
      tsDemuxer: root.VKMS.tsDemuxer,
      mp3Tagger: root.VKMS.mp3Tagger,
      m4aMuxer: root.VKMS.m4aMuxer,
      subtle: globalThis.crypto.subtle,
    };
  };

  function parseAttributeList(attrStr) {
    const attrs = {};
    const regex = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi;
    let match;
    while ((match = regex.exec(attrStr)) !== null) {
      const key = match[1].toUpperCase();
      const val = match[3] !== undefined ? match[3] : match[2];
      attrs[key] = val.trim();
    }
    return attrs;
  }

  function resolveUrl(ref, baseUrl) {
    return new URL(ref, baseUrl).href;
  }

  /**
   * Parses an HLS master playlist and selects a variant URL matching requested quality:
   * 'best' (highest bandwidth), 'medium' (middle variant), or 'low' (lowest bandwidth).
   * Returns null if the playlist is a media playlist rather than a master playlist.
   */
  function pickVariantFromMaster(manifestText, baseUrl, quality = 'best') {
    const lines = manifestText.split(/\r?\n/);
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
        const bandwidth = parseInt(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || '0', 10) || 0;
        // Find next non-empty, non-comment line
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (next && !next.startsWith('#')) {
            variants.push({
              bandwidth,
              url: resolveUrl(next, baseUrl),
            });
            i = j;
            break;
          }
        }
      }
    }

    if (variants.length === 0) return null;
    variants.sort((a, b) => b.bandwidth - a.bandwidth);

    if (quality === 'low') {
      return variants[variants.length - 1];
    }
    if (quality === 'medium' && variants.length > 1) {
      return variants[Math.floor(variants.length / 2)];
    }
    return variants[0];
  }

  function pickBestVariantFromMaster(manifestText, baseUrl) {
    return pickVariantFromMaster(manifestText, baseUrl, 'best');
  }

  function hexToBytes(hexStr) {
    let clean = hexStr.trim();
    if (clean.startsWith('0x') || clean.startsWith('0X')) {
      clean = clean.slice(2);
    }
    if (clean.length % 2 !== 0) {
      clean = '0' + clean;
    }
    const out = new Uint8Array(16);
    const byteLen = Math.min(16, clean.length / 2);
    const startOffset = 16 - byteLen;
    for (let i = 0; i < byteLen; i++) {
      out[startOffset + i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function sequenceToIv(seq) {
    const iv = new Uint8Array(16);
    const view = new DataView(iv.buffer);
    // Big-endian 64-bit sequence in bytes 8..15
    const hi = Math.floor(seq / 0x100000000);
    const lo = seq >>> 0;
    view.setUint32(8, hi, false);
    view.setUint32(12, lo, false);
    return iv;
  }

  /**
   * Parses a media M3U8 playlist into ordered segment descriptors with key & IV metadata.
   */
  function parseMediaPlaylist(manifestText, baseUrl) {
    const lines = manifestText.split(/\r?\n/);
    let mediaSequence = 0;
    let currentKey = null; // { method, uri, ivBytes }
    let initMapUrl = null;
    const segments = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const attrs = parseAttributeList(line.slice('#EXT-X-KEY:'.length));
        const method = (attrs.METHOD || 'NONE').toUpperCase();
        if (method === 'NONE') {
          currentKey = null;
        } else if (method === 'AES-128' && attrs.URI) {
          currentKey = {
            method,
            uri: resolveUrl(attrs.URI, baseUrl),
            ivBytes: attrs.IV ? hexToBytes(attrs.IV) : null,
          };
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const attrs = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
        if (attrs.URI) {
          initMapUrl = resolveUrl(attrs.URI, baseUrl);
        }
      } else if (!line.startsWith('#')) {
        const seq = mediaSequence + segments.length;
        segments.push({
          url: resolveUrl(line, baseUrl),
          seq,
          key: currentKey
            ? {
                uri: currentKey.uri,
                iv: currentKey.ivBytes || sequenceToIv(seq),
              }
            : null,
        });
      }
    }

    return { segments, initMapUrl };
  }

  async function fetchBytesWithRetry(fetchFn, url, retries = 2) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchFn(url, { credentials: 'include' });
        if (!res.ok) {
          if (res.status === 403 || res.status === 401) {
            const fallback = await fetchFn(url, { credentials: 'omit' });
            if (fallback.ok) {
              return new Uint8Array(await fallback.arrayBuffer());
            }
          }
          throw new Error(`HTTP ${res.status} for ${url}`);
        }
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async function fetchTextWithRetry(fetchFn, url, retries = 2) {
    const bytes = await fetchBytesWithRetry(fetchFn, url, retries);
    return new TextDecoder('utf-8').decode(bytes);
  }

  async function decryptAes128Cbc(subtle, encryptedBytes, rawKeyBytes, ivBytes) {
    const cryptoKey = await subtle.importKey(
      'raw',
      rawKeyBytes,
      { name: 'AES-CBC' },
      false,
      ['decrypt']
    );
    const decrypted = await subtle.decrypt(
      { name: 'AES-CBC', iv: ivBytes },
      cryptoKey,
      encryptedBytes
    );
    return new Uint8Array(decrypted);
  }

  function concatUint8Arrays(arrays) {
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
      out.set(a, offset);
      offset += a.length;
    }
    return out;
  }

  /**
   * Downloads an HLS audio stream (master or media playlist), picks highest bitrate,
   * decrypts AES-128 segments, demuxes MPEG-TS, and returns clean MP3 or M4A bytes.
   */
  async function downloadHlsAudio(
    m3u8Url,
    {
      title = '',
      artist = '',
      quality = 'best',
      format = 'auto',
      embedMetadata = true,
      onProgress,
      fetchImpl,
    } = {}
  ) {
    const { tsDemuxer, mp3Tagger, m4aMuxer, subtle } = getDeps();
    const fetchFn = fetchImpl || globalThis.fetch.bind(globalThis);

    let playlistUrl = m3u8Url;
    let manifestText = await fetchTextWithRetry(fetchFn, playlistUrl);

    const chosenVariant = pickVariantFromMaster(manifestText, playlistUrl, quality);
    if (chosenVariant) {
      playlistUrl = chosenVariant.url;
      manifestText = await fetchTextWithRetry(fetchFn, playlistUrl);
    }

    const { segments, initMapUrl } = parseMediaPlaylist(manifestText, playlistUrl);
    if (segments.length === 0) {
      throw new Error('HLS playlist contains no audio segments');
    }

    // Pre-fetch unique AES-128 keys
    const keyCache = new Map();
    const uniqueKeyUris = [...new Set(segments.map((s) => s.key?.uri).filter(Boolean))];
    await Promise.all(
      uniqueKeyUris.map(async (uri) => {
        const keyBytes = await fetchBytesWithRetry(fetchFn, uri);
        keyCache.set(uri, keyBytes);
      })
    );

    const initBytes = initMapUrl ? await fetchBytesWithRetry(fetchFn, initMapUrl) : null;

    // Download and decrypt segments with bounded concurrency
    const results = new Array(segments.length);
    const concurrency = 4;
    let nextIdx = 0;
    let completed = 0;

    async function worker() {
      while (nextIdx < segments.length) {
        const idx = nextIdx++;
        const seg = segments[idx];
        let bytes = await fetchBytesWithRetry(fetchFn, seg.url);
        if (seg.key) {
          const rawKey = keyCache.get(seg.key.uri);
          bytes = await decryptAes128Cbc(subtle, bytes, rawKey, seg.key.iv);
        }
        results[idx] = bytes;
        completed++;
        if (typeof onProgress === 'function') {
          onProgress(Math.round((completed / segments.length) * 90));
        }
      }
    }

    const workers = [];
    for (let w = 0; w < Math.min(concurrency, segments.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    if (typeof onProgress === 'function') {
      onProgress(95);
    }

    // Check container format of segments
    const firstSeg = results[0];
    if (initBytes) {
      // fMP4 HLS segments
      const combined = concatUint8Arrays([initBytes, ...results]);
      return { data: combined, ext: 'm4a', mimeType: 'audio/mp4' };
    }

    if (tsDemuxer.isTransportStream(firstSeg)) {
      const demuxer = new tsDemuxer.TsAudioDemuxer();
      for (const segBytes of results) {
        demuxer.push(segBytes);
      }
      const { data, codec } = demuxer.finish();

      if (codec === 'aac') {
        if (format === 'aac') {
          return { data, ext: 'aac', mimeType: 'audio/aac' };
        }
        const m4aBytes = m4aMuxer.muxAdtsToM4a(data, { title, artist, embedMetadata });
        if (m4aBytes) {
          return { data: m4aBytes, ext: 'm4a', mimeType: 'audio/mp4' };
        }
        return { data, ext: 'aac', mimeType: 'audio/aac' };
      }

      const taggedMp3 = embedMetadata
        ? mp3Tagger.prependId3v2Tag(data, { title, artist })
        : data;
      return { data: taggedMp3, ext: 'mp3', mimeType: 'audio/mpeg' };
    }

    // Raw elementary audio chunks (non-TS)
    const rawCombined = concatUint8Arrays(results);
    const detected = tsDemuxer.detectElementaryAudioCodec(rawCombined);
    if (detected === 'aac') {
      if (format === 'aac') {
        return { data: rawCombined, ext: 'aac', mimeType: 'audio/aac' };
      }
      const m4aBytes = m4aMuxer.muxAdtsToM4a(rawCombined, { title, artist, embedMetadata });
      if (m4aBytes) {
        return { data: m4aBytes, ext: 'm4a', mimeType: 'audio/mp4' };
      }
      return { data: rawCombined, ext: 'aac', mimeType: 'audio/aac' };
    }

    const taggedMp3 = embedMetadata
      ? mp3Tagger.prependId3v2Tag(rawCombined, { title, artist })
      : rawCombined;
    return { data: taggedMp3, ext: 'mp3', mimeType: 'audio/mpeg' };
  }

  const api = {
    pickVariantFromMaster,
    pickBestVariantFromMaster,
    parseMediaPlaylist,
    sequenceToIv,
    hexToBytes,
    decryptAes128Cbc,
    downloadHlsAudio,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.VKMS = root.VKMS || {};
    root.VKMS.hlsDownloader = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
