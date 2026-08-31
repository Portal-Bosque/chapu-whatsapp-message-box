export type AudioQualityReason = "ok" | "too_short" | "inaudible" | "no_voice" | "unsupported_format";

export type AudioQualityMetrics = {
  durationMs: number;
  rmsDbfs: number;
  peakDbfs: number;
  noiseFloorDbfs: number;
  activeThresholdDbfs: number;
  activeMs: number;
  activeRatio: number;
  maxActiveStreakMs: number;
};

export type AudioQualityResult = {
  supported: boolean;
  discard: boolean;
  reason: AudioQualityReason;
  metrics: AudioQualityMetrics | null;
};

type PcmWave = {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataStart: number;
  dataBytes: number;
};

// Intentionally conservative: if a recording is borderline, keep it.
const FRAME_MS = 20;
const MIN_DURATION_MS = 300;
const MIN_PEAK_DBFS = -45;
const MIN_ACTIVE_MS = 160;
const QUIET_RMS_DBFS = -48;
const QUIET_MIN_ACTIVE_MS = 300;
const QUIET_MIN_ACTIVE_RATIO = 0.03;
const ABSOLUTE_ACTIVE_DBFS = -50;
const MAX_ACTIVE_THRESHOLD_DBFS = -35;
const ABOVE_NOISE_DB = 12;

function parsePcmWave(buffer: Buffer): PcmWave | null {
  if (buffer.length < 44
    || buffer.toString("ascii", 0, 4) !== "RIFF"
    || buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let format: Omit<PcmWave, "dataStart" | "dataBytes"> | null = null;
  let data: { dataStart: number; dataBytes: number } | null = null;

  while (offset + 8 <= buffer.length) {
    const name = buffer.toString("ascii", offset, offset + 4);
    const declaredSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const availableSize = Math.min(declaredSize, Math.max(0, buffer.length - chunkStart));

    if (name === "fmt " && availableSize >= 16) {
      const audioFormat = buffer.readUInt16LE(chunkStart);
      const channels = buffer.readUInt16LE(chunkStart + 2);
      const sampleRate = buffer.readUInt32LE(chunkStart + 4);
      const bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
      if (audioFormat === 1 && channels > 0 && sampleRate > 0 && bitsPerSample === 16) {
        format = { channels, sampleRate, bitsPerSample };
      }
    } else if (name === "data") {
      data = { dataStart: chunkStart, dataBytes: availableSize };
    }

    if (format && data) return { ...format, ...data };
    if (declaredSize > buffer.length - chunkStart) break;
    offset = chunkStart + declaredSize + (declaredSize % 2);
  }

  return null;
}

function dbfs(amplitude: number) {
  if (!Number.isFinite(amplitude) || amplitude <= 0) return -120;
  return Math.max(-120, 20 * Math.log10(amplitude));
}

function rounded(value: number, digits = 1) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return -120;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export function analyzeAudioQuality(buffer: Buffer): AudioQualityResult {
  const wave = parsePcmWave(buffer);
  if (!wave) {
    return { supported: false, discard: false, reason: "unsupported_format", metrics: null };
  }

  const bytesPerSample = wave.bitsPerSample / 8;
  const frameBytes = wave.channels * bytesPerSample;
  const sampleFrames = Math.floor(wave.dataBytes / frameBytes);
  const durationMs = (sampleFrames / wave.sampleRate) * 1000;
  if (sampleFrames === 0) {
    return {
      supported: true,
      discard: true,
      reason: "too_short",
      metrics: {
        durationMs: 0,
        rmsDbfs: -120,
        peakDbfs: -120,
        noiseFloorDbfs: -120,
        activeThresholdDbfs: ABSOLUTE_ACTIVE_DBFS,
        activeMs: 0,
        activeRatio: 0,
        maxActiveStreakMs: 0,
      },
    };
  }

  const channelMeans = new Array<number>(wave.channels).fill(0);
  for (let frame = 0; frame < sampleFrames; frame += 1) {
    const base = wave.dataStart + frame * frameBytes;
    for (let channel = 0; channel < wave.channels; channel += 1) {
      channelMeans[channel] += buffer.readInt16LE(base + channel * bytesPerSample) / 32768;
    }
  }
  for (let channel = 0; channel < wave.channels; channel += 1) channelMeans[channel] /= sampleFrames;

  const samplesPerWindow = Math.max(1, Math.round((wave.sampleRate * FRAME_MS) / 1000));
  const frameDbfs: number[] = [];
  let totalSquares = 0;
  let peak = 0;

  for (let windowStart = 0; windowStart < sampleFrames; windowStart += samplesPerWindow) {
    const windowEnd = Math.min(sampleFrames, windowStart + samplesPerWindow);
    let windowSquares = 0;
    let values = 0;
    for (let frame = windowStart; frame < windowEnd; frame += 1) {
      const base = wave.dataStart + frame * frameBytes;
      for (let channel = 0; channel < wave.channels; channel += 1) {
        const sample = (buffer.readInt16LE(base + channel * bytesPerSample) / 32768) - channelMeans[channel];
        const absolute = Math.abs(sample);
        if (absolute > peak) peak = absolute;
        windowSquares += sample * sample;
        totalSquares += sample * sample;
        values += 1;
      }
    }
    frameDbfs.push(dbfs(Math.sqrt(windowSquares / Math.max(1, values))));
  }

  const rms = Math.sqrt(totalSquares / (sampleFrames * wave.channels));
  const noiseFloorDbfs = percentile(frameDbfs, 0.2);
  // Cap the adaptive threshold so a short recording containing continuous
  // speech is not mistaken for its own background noise.
  const activeThresholdDbfs = Math.min(
    MAX_ACTIVE_THRESHOLD_DBFS,
    Math.max(ABSOLUTE_ACTIVE_DBFS, noiseFloorDbfs + ABOVE_NOISE_DB),
  );
  let activeWindows = 0;
  let currentStreak = 0;
  let maxStreak = 0;
  for (const frameLevel of frameDbfs) {
    if (frameLevel >= activeThresholdDbfs) {
      activeWindows += 1;
      currentStreak += 1;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  const activeMs = Math.min(durationMs, activeWindows * FRAME_MS);
  const metrics: AudioQualityMetrics = {
    durationMs: Math.round(durationMs),
    rmsDbfs: rounded(dbfs(rms)),
    peakDbfs: rounded(dbfs(peak)),
    noiseFloorDbfs: rounded(noiseFloorDbfs),
    activeThresholdDbfs: rounded(activeThresholdDbfs),
    activeMs: Math.round(activeMs),
    activeRatio: rounded(activeMs / durationMs, 3),
    maxActiveStreakMs: Math.round(Math.min(durationMs, maxStreak * FRAME_MS)),
  };

  if (durationMs < MIN_DURATION_MS) {
    return { supported: true, discard: true, reason: "too_short", metrics };
  }
  if (metrics.peakDbfs < MIN_PEAK_DBFS) {
    return { supported: true, discard: true, reason: "inaudible", metrics };
  }
  if (metrics.activeMs < MIN_ACTIVE_MS
    || (metrics.rmsDbfs < QUIET_RMS_DBFS
      && (metrics.activeMs < QUIET_MIN_ACTIVE_MS || metrics.activeRatio < QUIET_MIN_ACTIVE_RATIO))) {
    return { supported: true, discard: true, reason: "no_voice", metrics };
  }

  return { supported: true, discard: false, reason: "ok", metrics };
}
