
import React from 'react';
import { Track } from '../types';
import { Trash2 } from 'lucide-react';
import Knob from './Knob';
import { trackHeaderMeterStore } from '../services/trackHeaderMeterStore';

interface TrackHeaderProps {
    track: Track;
    height: number;
    isSelected: boolean;
    onSelect: () => void;
    onUpdate: (updates: Partial<Track>) => void;
    onDelete: () => void;
}

const dbToMeterNormalized = (db: number): number => {
    if (db <= -72) return 0;
    if (db >= 6) return 1;

    // Piecewise standard DAW mapping for ultra-precise visualization:
    // +6 to -12 dB -> top 30% of the meter
    if (db >= -12) {
        return 0.7 + ((db + 12) / 18) * 0.3;
    }
    // -12 to -36 dB -> middle 40% of the meter
    if (db >= -36) {
        return 0.3 + ((db + 36) / 24) * 0.4;
    }
    // -36 to -72 dB -> bottom 30% of the meter
    return ((db + 72) / 36) * 0.3;
};

const TrackMeterStrip: React.FC<{ trackId: string; isMuted: boolean }> = React.memo(({ trackId, isMuted }) => {
    const isMutedRef = React.useRef(isMuted);
    isMutedRef.current = isMuted;

    const clipIndicatorRef = React.useRef<HTMLDivElement>(null);
    const peakBarRef = React.useRef<HTMLDivElement>(null);
    const rmsBarRef = React.useRef<HTMLDivElement>(null);
    const peakLineRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        const updateMeters = () => {
            const meterSnapshot = trackHeaderMeterStore.getSnapshot(trackId);
            const muted = isMutedRef.current;

            const peakMeterLevel = muted ? 0 : dbToMeterNormalized(meterSnapshot.peakDb);
            const rmsMeterLevel = muted ? 0 : Math.min(peakMeterLevel, dbToMeterNormalized(meterSnapshot.rmsDb));
            const clipped = !muted && meterSnapshot.clipped;

            const peakHeight = Math.min(100, peakMeterLevel * 100);
            const rmsHeight = Math.min(100, rmsMeterLevel * 100);
            const peakLineBottom = Math.max(0, Math.min(99, peakHeight));

            if (clipIndicatorRef.current) {
                if (clipped) {
                    clipIndicatorRef.current.className = "w-full h-px mb-[1px] transition-colors duration-100 bg-red-500 shadow-[0_0_5px_red]";
                } else {
                    clipIndicatorRef.current.className = "w-full h-px mb-[1px] transition-colors duration-100 bg-[#1a1a1a]";
                }
            }

            if (peakBarRef.current) {
                peakBarRef.current.style.transform = `scaleY(${peakHeight / 100})`;
            }

            if (rmsBarRef.current) {
                rmsBarRef.current.style.transform = `scaleY(${rmsHeight / 100})`;
            }

            if (peakLineRef.current) {
                peakLineRef.current.style.bottom = `${peakLineBottom}%`;
            }
        };

        // Initial update
        updateMeters();

        // Subscribe to store updates
        const unsubscribe = trackHeaderMeterStore.subscribe(trackId, updateMeters);
        return unsubscribe;
    }, [trackId]);

    return (
        <div className="w-2.5 h-full bg-[#0a0a0a] border-l border-[#333] flex flex-col relative shrink-0">
            <div ref={clipIndicatorRef} className="w-full h-px mb-[1px] transition-colors duration-100 bg-[#1a1a1a]"></div>
            <div className="flex-1 relative bg-[#050505] overflow-hidden">
                <div
                    ref={peakBarRef}
                    className="absolute inset-x-0 bottom-0 h-full bg-meter-gradient opacity-85 will-change-transform"
                    style={{ transform: `scaleY(0)`, transformOrigin: 'bottom', transition: 'transform 20ms ease-out' }}
                ></div>
                <div
                    ref={rmsBarRef}
                    className="absolute inset-x-0 bottom-0 h-full bg-white/18 will-change-transform"
                    style={{ transform: `scaleY(0)`, transformOrigin: 'bottom', transition: 'transform 20ms ease-out' }}
                ></div>
                <div
                    ref={peakLineRef}
                    className="absolute left-0 right-0 h-[1px] bg-white/90 shadow-[0_0_4px_rgba(255,255,255,0.5)]"
                    style={{ bottom: `0%`, transition: 'bottom 40ms ease-out' }}
                ></div>
            </div>
        </div>
    );
});

const arePunchRangesEqual = (left?: Track['punchRange'], right?: Track['punchRange']) => {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return left.enabled === right.enabled
        && left.inBar === right.inBar
        && left.outBar === right.outBar
        && left.preRollBars === right.preRollBars
        && left.countInBars === right.countInBars;
};

const areTrackHeaderPropsEqual = (previous: TrackHeaderProps, next: TrackHeaderProps) => {
    const prevTrack = previous.track;
    const nextTrack = next.track;

    return previous.height === next.height
        && previous.isSelected === next.isSelected
        && prevTrack.id === nextTrack.id
        && prevTrack.name === nextTrack.name
        && prevTrack.color === nextTrack.color
        && prevTrack.volume === nextTrack.volume
        && prevTrack.pan === nextTrack.pan
        && prevTrack.reverb === nextTrack.reverb
        && prevTrack.monitor === nextTrack.monitor
        && prevTrack.isMuted === nextTrack.isMuted
        && prevTrack.isSoloed === nextTrack.isSoloed
        && prevTrack.isArmed === nextTrack.isArmed
        && arePunchRangesEqual(prevTrack.punchRange, nextTrack.punchRange);
};

const TrackHeader: React.FC<TrackHeaderProps> = React.memo(({ track, height, isSelected, onSelect, onUpdate, onDelete }) => {
    const monitorModes: Track['monitor'][] = ['in', 'auto', 'off'];
    const monitorModeActiveClass: Record<Track['monitor'], string> = {
        in: 'bg-[#ff4fc3] text-[#190a13] border border-[#ff9be3] shadow-[0_0_8px_rgba(255,79,195,0.32)]',
        auto: 'bg-[#dc87ff] text-[#1b0a23] border border-[#f0bfff] shadow-[0_0_8px_rgba(220,135,255,0.3)]',
        off: 'bg-[#ff8ea9] text-[#200b14] border border-[#ffc6d5] shadow-[0_0_8px_rgba(255,142,169,0.28)]'
    };

    const showKnobs = height >= 74;
    const showMonitor = height >= 92;
    const isCompact = height < 116;
    const compactControls = height < 122;
    const knobSize = compactControls ? 20 : 26;
    const showKnobLabels = !compactControls;
    const punchRange = track.punchRange || {
        enabled: false,
        inBar: 1,
        outBar: 2,
        preRollBars: 1,
        countInBars: 0
    };
    const punchEnabled = Boolean(punchRange.enabled);

    return (
        <div
            className={`h-full w-full flex border-b border-daw-border relative group select-none overflow-hidden font-sans transition-colors
        ${isSelected ? 'bg-[#262626]' : 'bg-[#1e1e1e] hover:bg-[#222]'}
        ${isCompact ? 'p-1.5' : 'p-2.5'}
      `}
            onClick={(e) => { e.stopPropagation(); onSelect(); }}
        >
            <div
                className="w-2.5 h-full shrink-0 rounded-r-[1px]"
                style={{
                    backgroundColor: track.color,
                    boxShadow: `0 0 10px ${track.color}55`
                }}
            ></div>

            <div className="flex-1 flex flex-col min-w-0 relative h-full pl-2">
                <div className={`flex items-center justify-between shrink-0 h-5 ${showKnobs ? 'mb-1' : 'mb-0'}`}>
                    <div className="flex items-center gap-2 overflow-hidden min-w-0">
                        <span className={`font-black text-[11px] truncate uppercase tracking-wider ${isSelected ? 'text-white' : 'text-gray-400'}`}>
                            {track.name}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onDelete(); }}
                        aria-label={`Eliminar pista ${track.name}`}
                        title={`Eliminar pista ${track.name}`}
                        className="min-h-6 min-w-6 inline-flex items-center justify-center text-gray-400 hover:text-daw-ruby opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-daw-ruby/60 transition-opacity shrink-0"
                    >
                        <Trash2 size={16} />
                    </button>
                </div>

                {showKnobs && (
                    <div className="flex-1 flex items-center justify-between px-1.5 min-h-0 my-1">
                        <Knob label="VOL" showLabel={showKnobLabels} value={track.volume} min={-60} max={6} defaultValue={0} size={knobSize} color={track.color} onChange={(val) => onUpdate({ volume: val })} />
                        <Knob label="PAN" showLabel={showKnobLabels} value={track.pan} min={-50} max={50} defaultValue={0} size={knobSize} color="#00fff2" bipolar={true} onChange={(val) => onUpdate({ pan: Math.round(val) })} />
                        <Knob label="REV" showLabel={showKnobLabels} value={track.reverb} min={0} max={100} defaultValue={0} size={knobSize} color="#f43f5e" onChange={(val) => onUpdate({ reverb: val })} />
                    </div>
                )}

                {!showKnobs && <div className="flex-1"></div>}

                <div className="mt-auto flex flex-col gap-1 shrink-0">
                    {showMonitor && (
                        <div className={`flex items-center gap-1 bg-[#121212] px-1 py-0.5 rounded-sm border border-[#333] mb-0.5 ${compactControls ? 'h-[18px]' : 'h-[22px]'}`}>
                            {!compactControls && <span className="text-[7px] font-bold text-gray-600 uppercase pl-1">In</span>}
                            <div className="flex-1 flex gap-[1px]">
                                {monitorModes.map((mode) => (
                                    <button
                                        key={mode}
                                        onClick={(e) => { e.stopPropagation(); onUpdate({ monitor: mode }); }}
                                        className={`flex-1 py-[1px] text-[8px] leading-none font-bold uppercase rounded-[1px] transition-all ${track.monitor === mode
                                            ? monitorModeActiveClass[mode]
                                            : 'bg-[#1a1a1a] text-gray-500 border border-[#2a2a2a] hover:bg-[#222] hover:text-gray-300'}`}
                                    >
                                        {mode}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className={`grid grid-cols-4 gap-1 relative ${compactControls ? 'h-[18px]' : 'h-[22px]'}`}>
                        <button onClick={(e) => { e.stopPropagation(); onUpdate({ isMuted: !track.isMuted }) }} className={`rounded-[1px] flex items-center justify-center leading-none font-bold ${compactControls ? 'text-[9px]' : 'text-[10px]'} border transition-all ${track.isMuted ? 'bg-[#ff7ebf] text-[#240d1c] border-[#ffb2d9]' : 'bg-[#2a2a2a] text-[#ff7ebf] border-[#333]'}`}>M</button>
                        <button onClick={(e) => { e.stopPropagation(); onUpdate({ isSoloed: !track.isSoloed }) }} className={`rounded-[1px] flex items-center justify-center leading-none font-bold ${compactControls ? 'text-[9px]' : 'text-[10px]'} border transition-all ${track.isSoloed ? 'bg-[#d99cff] text-[#200f2c] border-[#f0c8ff]' : 'bg-[#2a2a2a] text-[#d99cff] border-[#333]'}`}>S</button>
                        <button
                            onClick={(e) => { e.stopPropagation(); onUpdate({ isArmed: !track.isArmed }) }}
                            className={`rounded-[1px] flex items-center justify-center leading-none font-bold ${compactControls ? 'text-[9px]' : 'text-[10px]'} border transition-all ${track.isArmed ? 'bg-[#ff4b88] text-[#240915] border-[#ff93b7] animate-pulse' : 'bg-[#2a2a2a] text-[#ff4b88] border-[#333]'}`}
                        >
                            O
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onUpdate({
                                    punchRange: {
                                        ...punchRange,
                                        enabled: !punchEnabled
                                    }
                                });
                            }}
                            title={`Punch ${punchEnabled ? 'ON' : 'OFF'} (${punchRange.inBar.toFixed(2)}-${punchRange.outBar.toFixed(2)})`}
                            className={`rounded-[1px] flex items-center justify-center leading-none font-bold ${compactControls ? 'text-[9px]' : 'text-[10px]'} border transition-all ${punchEnabled ? 'bg-[#be7cff] text-[#1e0f2a] border-[#e2bdff]' : 'bg-[#2a2a2a] text-[#be7cff] border-[#333]'}`}
                        >
                            P
                        </button>
                    </div>
                </div>
            </div>
            <TrackMeterStrip trackId={track.id} isMuted={track.isMuted} />
        </div>
    );
}, areTrackHeaderPropsEqual);

export default TrackHeader;
