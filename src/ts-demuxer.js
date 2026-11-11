(function (root) {
  'use strict';

  const TS_PACKET_SIZE = 188;
  const TS_SYNC_BYTE = 0x47;

  // MPEG-TS PMT stream types for audio
  const STREAM_TYPE_MP3_1 = 0x03; // MPEG-1 Audio
  const STREAM_TYPE_MP3_2 = 0x04; // MPEG-2 Audio
  const STREAM_TYPE_AAC_ADTS = 0x0f; // ISO/IEC 13818-7 AAC ADTS
  const STREAM_TYPE_AAC_LATM = 0x11; // ISO/IEC 14496-3 AAC LATM

  function isTransportStream(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < TS_PACKET_SIZE) {
      return false;
    }
    return findFirstSyncOffset(bytes) !== -1;
  }

  function findFirstSyncOffset(bytes) {
    const limit = Math.min(bytes.length - TS_PACKET_SIZE, 1024);
    for (let i = 0; i <= limit; i++) {
      if (bytes[i] === TS_SYNC_BYTE) {
        if (i + TS_PACKET_SIZE >= bytes.length || bytes[i + TS_PACKET_SIZE] === TS_SYNC_BYTE) {
          return i;
        }
      }
    }
    return -1;
  }

  /**
   * Stateful MPEG-TS audio demuxer. Feed sequential .ts segments via push(bytes),
   * then call finish() to retrieve the concatenated audio elementary stream and detected codec.
   */
  class TsAudioDemuxer {
    constructor() {
      this.pmtPid = -1;
      this.audioPid = -1;
      this.codec = null; // 'mp3' | 'aac' | null
      this.chunks = [];
      this.fallbackChunks = new Map(); // pid -> Uint8Array[] if PAT/PMT missing
      this.pesHeaderRemaining = 0;
      this.pesPayloadRemaining = -1; // -1 = unbounded until next PUSI
    }

    push(segmentBytes) {
      if (!(segmentBytes instanceof Uint8Array) || segmentBytes.length === 0) {
        return;
      }

      const start = findFirstSyncOffset(segmentBytes);
      if (start === -1) {
        return;
      }

      for (let offset = start; offset + TS_PACKET_SIZE <= segmentBytes.length; offset += TS_PACKET_SIZE) {
        if (segmentBytes[offset] !== TS_SYNC_BYTE) {
          continue;
        }

        const b1 = segmentBytes[offset + 1];
        const b2 = segmentBytes[offset + 2];
        const b3 = segmentBytes[offset + 3];

        const tei = (b1 >> 7) & 0x01;
        if (tei) continue;

        const pusi = (b1 >> 6) & 0x01;
        const pid = ((b1 & 0x1f) << 8) | b2;
        const afc = (b3 >> 4) & 0x03;

        // No payload when afc === 0 or afc === 2
        if (afc === 0 || afc === 2) continue;

        let payloadStart = offset + 4;
        if (afc === 3) {
          const afLen = segmentBytes[payloadStart];
          payloadStart += 1 + afLen;
        }

        const packetEnd = offset + TS_PACKET_SIZE;
        if (payloadStart >= packetEnd) continue;

        if (pid === 0x0000) {
          this._parsePat(segmentBytes, payloadStart, packetEnd, pusi);
        } else if (this.pmtPid !== -1 && pid === this.pmtPid) {
          this._parsePmt(segmentBytes, payloadStart, packetEnd, pusi);
        } else if (this.audioPid !== -1 && pid === this.audioPid) {
          this._extractAudioPayload(segmentBytes, payloadStart, packetEnd, pusi, this.chunks);
        } else if (this.audioPid === -1 && pid !== 0x1fff) {
          this._collectFallback(pid, segmentBytes, payloadStart, packetEnd, pusi);
        }
      }
    }

    _parsePat(buf, payloadStart, packetEnd, pusi) {
      let pos = payloadStart;
      if (pusi) {
        const pointer = buf[pos];
        pos += 1 + pointer;
      }
      if (pos + 8 > packetEnd || buf[pos] !== 0x00) return;

      const sectionLength = ((buf[pos + 1] & 0x0f) << 8) | buf[pos + 2];
      const sectionEnd = Math.min(packetEnd, pos + 3 + sectionLength - 4); // exclude CRC32

      for (let i = pos + 8; i + 4 <= sectionEnd; i += 4) {
        const programNumber = (buf[i] << 8) | buf[i + 1];
        const pid = ((buf[i + 2] & 0x1f) << 8) | buf[i + 3];
        if (programNumber !== 0) {
          this.pmtPid = pid;
          return;
        }
      }
    }

    _parsePmt(buf, payloadStart, packetEnd, pusi) {
      let pos = payloadStart;
      if (pusi) {
        const pointer = buf[pos];
        pos += 1 + pointer;
      }
      if (pos + 12 > packetEnd || buf[pos] !== 0x02) return;

      const sectionLength = ((buf[pos + 1] & 0x0f) << 8) | buf[pos + 2];
      const sectionEnd = Math.min(packetEnd, pos + 3 + sectionLength - 4);
      const programInfoLength = ((buf[pos + 10] & 0x0f) << 8) | buf[pos + 11];

      let i = pos + 12 + programInfoLength;
      while (i + 5 <= sectionEnd) {
        const streamType = buf[i];
        const elementaryPid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
        const esInfoLength = ((buf[i + 3] & 0x0f) << 8) | buf[i + 4];

        if (streamType === STREAM_TYPE_MP3_1 || streamType === STREAM_TYPE_MP3_2) {
          this.audioPid = elementaryPid;
          this.codec = 'mp3';
          this._promoteFallback(elementaryPid);
          return;
        }
        if (streamType === STREAM_TYPE_AAC_ADTS || streamType === STREAM_TYPE_AAC_LATM) {
          this.audioPid = elementaryPid;
          this.codec = 'aac';
          this._promoteFallback(elementaryPid);
          return;
        }

        i += 5 + esInfoLength;
      }
    }

    _promoteFallback(pid) {
      const buffered = this.fallbackChunks.get(pid);
      if (buffered && buffered.length > 0) {
        for (const chunk of buffered) {
          this.chunks.push(chunk);
        }
      }
      this.fallbackChunks.clear();
    }

    _collectFallback(pid, buf, payloadStart, packetEnd, pusi) {
      // Detect MPEG audio PES (stream_id 0xC0..0xDF) if PAT/PMT hasn't arrived yet
      let state = this.fallbackChunks.get(pid);
      if (!state) {
        if (!pusi || payloadStart + 9 > packetEnd) return;
        const isPes =
          buf[payloadStart] === 0x00 &&
          buf[payloadStart + 1] === 0x00 &&
          buf[payloadStart + 2] === 0x01;
        const streamId = buf[payloadStart + 3];
        if (!isPes || streamId < 0xc0 || streamId > 0xdf) return;
        state = [];
        this.fallbackChunks.set(pid, state);
      }
      this._extractAudioPayload(buf, payloadStart, packetEnd, pusi, state);
    }

    _extractAudioPayload(buf, payloadStart, packetEnd, pusi, targetChunks) {
      let dataStart = payloadStart;

      if (pusi) {
        this.pesHeaderRemaining = 0;
        this.pesPayloadRemaining = -1;
        if (
          dataStart + 9 <= packetEnd &&
          buf[dataStart] === 0x00 &&
          buf[dataStart + 1] === 0x00 &&
          buf[dataStart + 2] === 0x01
        ) {
          const pesPacketLength = (buf[dataStart + 4] << 8) | buf[dataStart + 5];
          const pesHeaderDataLen = buf[dataStart + 8];
          if (pesPacketLength > 0) {
            this.pesPayloadRemaining = Math.max(0, pesPacketLength - 3 - pesHeaderDataLen);
          }
          const totalPesHeader = 9 + pesHeaderDataLen;
          if (dataStart + totalPesHeader <= packetEnd) {
            dataStart += totalPesHeader;
          } else {
            this.pesHeaderRemaining = dataStart + totalPesHeader - packetEnd;
            return;
          }
        }
      } else if (this.pesHeaderRemaining > 0) {
        const available = packetEnd - dataStart;
        if (available <= this.pesHeaderRemaining) {
          this.pesHeaderRemaining -= available;
          return;
        }
        dataStart += this.pesHeaderRemaining;
        this.pesHeaderRemaining = 0;
      }

      if (dataStart < packetEnd) {
        let dataEnd = packetEnd;
        if (this.pesPayloadRemaining >= 0) {
          if (this.pesPayloadRemaining === 0) return;
          const take = Math.min(dataEnd - dataStart, this.pesPayloadRemaining);
          dataEnd = dataStart + take;
          this.pesPayloadRemaining -= take;
        }
        if (dataEnd > dataStart) {
          targetChunks.push(buf.slice(dataStart, dataEnd));
        }
      }
    }

    finish() {
      let chunks = this.chunks;
      let codec = this.codec;

      if (chunks.length === 0 && this.fallbackChunks.size > 0) {
        // Pick largest audio fallback stream
        let best = null;
        for (const list of this.fallbackChunks.values()) {
          if (!best || list.length > best.length) {
            best = list;
          }
        }
        if (best) {
          chunks = best;
        }
      }

      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const data = new Uint8Array(totalLength);
      let offset = 0;
      for (const c of chunks) {
        data.set(c, offset);
        offset += c.length;
      }

      if (!codec && data.length >= 2) {
        codec = detectElementaryAudioCodec(data);
      }

      return { data, codec: codec || 'mp3' };
    }
  }

  function detectElementaryAudioCodec(bytes) {
    for (let i = 0; i < Math.min(bytes.length - 4, 2048); i++) {
      if (bytes[i] === 0xff && (bytes[i + 1] & 0xf0) === 0xf0) {
        const layer = (bytes[i + 1] >> 1) & 0x03;
        // ADTS always has layer === 0; MP3 has layer === 1 (Layer III)
        if (layer === 0) return 'aac';
        if (layer === 1) return 'mp3';
      }
      if (
        bytes[i] === 0x49 &&
        bytes[i + 1] === 0x44 &&
        bytes[i + 2] === 0x33
      ) {
        return 'mp3';
      }
    }
    return 'mp3';
  }

  const api = { TsAudioDemuxer, isTransportStream, detectElementaryAudioCodec };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.VKMS = root.VKMS || {};
    root.VKMS.tsDemuxer = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
