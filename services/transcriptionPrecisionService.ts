export interface SpectralPeak {
    bin: number;
    magnitude: number;
}

const clamp = (value: number, min: number, max: number): number => {
    return Math.min(max, Math.max(min, value));
};

interface NarrowBandKernel {
    real: Float32Array;
    imaginary: Float32Array;
}

const NARROW_BAND_KERNEL_CACHE_LIMIT = 192;
const narrowBandKernelCache = new Map<string, NarrowBandKernel>();

const getNarrowBandKernel = (
    sampleRate: number,
    targetFrequency: number,
    windowSamples: number
): NarrowBandKernel => {
    const cacheKey = `${sampleRate}:${targetFrequency.toFixed(6)}:${windowSamples}`;
    const cached = narrowBandKernelCache.get(cacheKey);
    if (cached) return cached;

    const real = new Float32Array(windowSamples);
    const imaginary = new Float32Array(windowSamples);
    const phaseStep = (2 * Math.PI * targetFrequency) / sampleRate;

    for (let offset = 0; offset < windowSamples; offset++) {
        const hann = 0.5 * (1 - Math.cos((2 * Math.PI * offset) / Math.max(1, windowSamples - 1)));
        const phase = phaseStep * offset;
        real[offset] = hann * Math.cos(phase);
        imaginary[offset] = -hann * Math.sin(phase);
    }

    if (narrowBandKernelCache.size >= NARROW_BAND_KERNEL_CACHE_LIMIT) {
        const oldestKey = narrowBandKernelCache.keys().next().value;
        if (oldestKey !== undefined) narrowBandKernelCache.delete(oldestKey);
    }
    const kernel = { real, imaginary };
    narrowBandKernelCache.set(cacheKey, kernel);
    return kernel;
};

const channelRms = (channel: Float32Array): number => {
    if (channel.length === 0) return 0;
    let energy = 0;
    for (let index = 0; index < channel.length; index++) {
        energy += channel[index] * channel[index];
    }
    return Math.sqrt(energy / channel.length);
};

/**
 * Downmixes decoded audio without losing anti-phase material. A plain L+R average
 * can turn a valid stereo file into silence; strongly inverted channels are aligned
 * to the loudest reference channel before averaging. Uncorrelated stereo content is
 * left untouched so the downmix does not invent phase relationships.
 */
export const buildPolaritySafeMono = (channels: readonly Float32Array[]): Float32Array => {
    if (channels.length === 0) return new Float32Array(0);
    if (channels.length === 1) return new Float32Array(channels[0]);

    const length = Math.min(...channels.map((channel) => channel.length));
    if (length <= 0) return new Float32Array(0);

    const rmsValues = channels.map(channelRms);
    let referenceIndex = 0;
    for (let index = 1; index < rmsValues.length; index++) {
        if (rmsValues[index] > rmsValues[referenceIndex]) referenceIndex = index;
    }

    const reference = channels[referenceIndex];
    const polarity = channels.map((channel, channelIndex) => {
        if (channelIndex === referenceIndex) return 1;

        let dot = 0;
        let referenceEnergy = 0;
        let channelEnergy = 0;
        for (let index = 0; index < length; index++) {
            const left = reference[index];
            const right = channel[index];
            dot += left * right;
            referenceEnergy += left * left;
            channelEnergy += right * right;
        }

        const correlation = dot / Math.max(1e-12, Math.sqrt(referenceEnergy * channelEnergy));
        return correlation <= -0.35 ? -1 : 1;
    });

    const mono = new Float32Array(length);
    let peak = 0;
    for (let index = 0; index < length; index++) {
        let sum = 0;
        for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
            sum += channels[channelIndex][index] * polarity[channelIndex];
        }
        mono[index] = sum / channels.length;
        peak = Math.max(peak, Math.abs(mono[index]));
    }

    if (peak > 1) {
        const scale = 1 / peak;
        for (let index = 0; index < mono.length; index++) mono[index] *= scale;
    }

    return mono;
};

/** Returns a sub-bin spectral peak using quadratic interpolation. */
export const findInterpolatedPeak = (
    spectrum: Float32Array,
    centerBin: number,
    radius: number
): SpectralPeak => {
    const start = Math.max(1, Math.floor(centerBin - radius));
    const end = Math.min(spectrum.length - 2, Math.ceil(centerBin + radius));
    let peakIndex = start;

    for (let index = start + 1; index <= end; index++) {
        if (spectrum[index] > spectrum[peakIndex]) peakIndex = index;
    }

    const left = spectrum[peakIndex - 1];
    const middle = spectrum[peakIndex];
    const right = spectrum[peakIndex + 1];
    const denominator = left - (2 * middle) + right;
    const offset = Math.abs(denominator) > 1e-18
        ? clamp(0.5 * (left - right) / denominator, -0.5, 0.5)
        : 0;

    return {
        bin: peakIndex + offset,
        magnitude: middle
    };
};

export const frequencyToMidi = (frequency: number): number => {
    if (!Number.isFinite(frequency) || frequency <= 0) return 0;
    return 69 + (12 * Math.log2(frequency / 440));
};

export const centsFromMidi = (frequency: number, midi: number): number => {
    return (frequencyToMidi(frequency) - midi) * 100;
};

/**
 * Spectral frames describe a centred Hann window. Converting their raw frame start
 * directly to a MIDI onset makes notes land roughly half a window early.
 */
export const calibrateWindowedBounds = (
    startFrame: number,
    lastSeenFrame: number,
    hopSize: number,
    frameSize: number,
    sampleRate: number
): { startSec: number; endSec: number } => {
    const safeRate = Math.max(1, sampleRate);
    const windowCentreSamples = frameSize * 0.5;
    const startSec = Math.max(0, ((startFrame * hopSize) + windowCentreSamples) / safeRate);
    const endSec = Math.max(
        startSec + (hopSize / safeRate),
        ((lastSeenFrame * hopSize) + windowCentreSamples) / safeRate
    );
    return { startSec, endSec };
};

/**
 * Refines coarse FFT-window bounds against a short-time energy envelope. This is
 * intentionally conservative: if the local dynamic range is too small (legato or
 * dense mix), it keeps the spectral bounds instead of snapping to arbitrary noise.
 */
export const refineEnvelopeBounds = (
    signal: Float32Array,
    sampleRate: number,
    roughStartSec: number,
    roughEndSec: number,
    searchRadiusSec: number,
    targetFrequency?: number
): { startSec: number; endSec: number } => {
    if (signal.length === 0 || sampleRate <= 0) {
        return { startSec: roughStartSec, endSec: roughEndSec };
    }

    const hopSamples = Math.max(1, Math.round(sampleRate * 0.003));
    const targetWindowSeconds = targetFrequency && targetFrequency > 0
        ? clamp(6 / targetFrequency, 0.012, 0.045)
        : 0.012;
    const windowSamples = Math.max(hopSamples, Math.round(sampleRate * targetWindowSeconds));
    const narrowBandKernel = targetFrequency && targetFrequency > 0
        ? getNarrowBandKernel(sampleRate, targetFrequency, windowSamples)
        : null;
    const buildLocalEnvelope = (centreSec: number): Array<{ sample: number; rms: number }> => {
        const searchStart = Math.max(0, Math.floor((centreSec - searchRadiusSec) * sampleRate));
        const searchEnd = Math.min(signal.length, Math.ceil((centreSec + searchRadiusSec) * sampleRate));
        const frames: Array<{ sample: number; rms: number }> = [];

        for (let sample = searchStart; sample + windowSamples <= searchEnd; sample += hopSamples) {
            let energy = 0;
            if (narrowBandKernel) {
                let real = 0;
                let imaginary = 0;
                for (let offset = 0; offset < windowSamples; offset++) {
                    const value = signal[sample + offset];
                    real += value * narrowBandKernel.real[offset];
                    imaginary += value * narrowBandKernel.imaginary[offset];
                }
                energy = Math.sqrt((real * real) + (imaginary * imaginary)) / windowSamples;
            } else {
                for (let offset = 0; offset < windowSamples; offset++) {
                    const value = signal[sample + offset];
                    energy += value * value;
                }
                energy = Math.sqrt(energy / windowSamples);
            }
            frames.push({ sample: sample + Math.floor(windowSamples * 0.5), rms: energy });
        }

        return frames;
    };

    // Bound the work to the attack and release neighbourhoods. Long sustained
    // notes therefore cost the same to refine as short notes.
    const onsetEnvelope = buildLocalEnvelope(roughStartSec);
    const offsetEnvelope = buildLocalEnvelope(roughEndSec);
    const envelope = [...onsetEnvelope, ...offsetEnvelope];

    if (envelope.length < 4) return { startSec: roughStartSec, endSec: roughEndSec };

    const sortedEnergy = envelope.map((frame) => frame.rms).sort((left, right) => left - right);
    const floor = sortedEnergy[Math.floor((sortedEnergy.length - 1) * 0.2)] || 0;
    const peak = sortedEnergy[sortedEnergy.length - 1] || 0;
    const dynamicRange = peak - floor;
    if (dynamicRange < Math.max(0.0003, peak * 0.06)) {
        return { startSec: roughStartSec, endSec: roughEndSec };
    }

    const attackThreshold = floor + (dynamicRange * 0.12);
    const releaseThreshold = floor + (dynamicRange * 0.09);
    const roughStartSample = roughStartSec * sampleRate;
    const roughEndSample = roughEndSec * sampleRate;

    const onsetSearchLimit = roughStartSample + (searchRadiusSec * sampleRate);
    const attackCandidates: number[] = [];
    for (let index = 1; index < onsetEnvelope.length - 1; index++) {
        const frame = onsetEnvelope[index];
        if (frame.sample > onsetSearchLimit) break;
        const previousMean = index >= 2
            ? (onsetEnvelope[index - 1].rms + onsetEnvelope[index - 2].rms) * 0.5
            : onsetEnvelope[index - 1].rms;
        const rise = frame.rms - previousMean;
        const crossedThreshold = onsetEnvelope[index - 1].rms < attackThreshold
            && frame.rms >= attackThreshold
            && onsetEnvelope[index + 1].rms >= attackThreshold;
        const clearRise = rise >= dynamicRange * 0.045
            && frame.rms >= floor + (dynamicRange * 0.07);
        if (crossedThreshold || clearRise) {
            attackCandidates.push(frame.sample);
        }
    }

    // A coarse FFT onset can land on either side of the real attack. Prefer the
    // latest attack that is already at the coarse boundary; only when there is no
    // such attack choose the first future one. This prevents a louder retrigger in
    // the same search window from stealing the preceding note.
    const onsetGraceSamples = hopSamples * 2;
    const attacksAtOrBeforeBoundary = attackCandidates
        .filter((sample) => sample <= roughStartSample + onsetGraceSamples);
    const onsetSample = attacksAtOrBeforeBoundary.length > 0
        ? attacksAtOrBeforeBoundary[attacksAtOrBeforeBoundary.length - 1]
        : (attackCandidates[0] ?? null);

    const offsetSearchStart = roughEndSample - (searchRadiusSec * sampleRate);
    const releaseCandidates: number[] = [];
    for (let index = 1; index < offsetEnvelope.length; index++) {
        const frame = offsetEnvelope[index];
        if (frame.sample < offsetSearchStart) continue;
        if (offsetEnvelope[index - 1].rms >= releaseThreshold && frame.rms < releaseThreshold) {
            releaseCandidates.push(offsetEnvelope[index - 1].sample);
        }
    }

    // Mirror the onset policy: retain the last release already reached by the
    // coarse boundary, otherwise take the first future release. Scanning backwards
    // from the right edge would incorrectly extend a note into its next retrigger.
    const offsetGraceSamples = hopSamples * 2;
    const releasesAtOrBeforeBoundary = releaseCandidates
        .filter((sample) => sample <= roughEndSample + offsetGraceSamples);
    const offsetSample = releasesAtOrBeforeBoundary.length > 0
        ? releasesAtOrBeforeBoundary[releasesAtOrBeforeBoundary.length - 1]
        : (releaseCandidates[0] ?? null);

    const startSec = onsetSample === null ? roughStartSec : onsetSample / sampleRate;
    const endSec = offsetSample === null ? roughEndSec : offsetSample / sampleRate;
    if (endSec <= startSec + 0.012) return { startSec: roughStartSec, endSec: roughEndSec };
    return { startSec, endSec };
};
