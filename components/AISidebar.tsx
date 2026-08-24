
import React, { useState } from 'react';
import { Sparkles, X, Music2, Loader2, Mic2, BarChart3, Bot } from 'lucide-react';
import {
    analyzeMix,
    generatePattern,
    getAiGatewayStatus,
    isAiGatewayError
} from '../services/aiGatewayService';
import { Note, Track } from '../types';

interface AISidebarProps {
    isOpen: boolean;
    onClose: () => void;
    onPatternGenerated: (notes: Note[], name: string) => void;
    bpm: number;
    tracks: Track[]; // Need access to tracks for mix analysis
}

import { FluidPanel } from './FluidPanel';

// ... existing imports

const AISidebar: React.FC<AISidebarProps> = ({ isOpen, onClose, onPatternGenerated, bpm, tracks }) => {
    // ... existing state ...
    const [activeTab, setActiveTab] = useState<'generate' | 'mix'>('generate');
    const [prompt, setPrompt] = useState('');
    const [loading, setLoading] = useState(false);
    const [mixAdvice, setMixAdvice] = useState<string | null>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const aiGatewayStatus = getAiGatewayStatus();

    const describeAiError = (error: unknown) => (
        isAiGatewayError(error)
            ? error.message
            : 'El asistente IA no pudo completar la operacion. Intenta nuevamente mas tarde.'
    );

    const handleGenerate = async () => {
        if (!prompt.trim()) return;
        setLoading(true);
        setErrorMessage(null);

        try {
            const result = await generatePattern(prompt, bpm);

            if (result && result.notes) {
                onPatternGenerated(result.notes, result.name || "Patrón AI");
                return;
            }

            setErrorMessage('No se pudo generar un patron valido. Ajusta el prompt e intenta nuevamente.');
        } catch (error) {
            setErrorMessage(describeAiError(error));
        } finally {
            setLoading(false);
        }
    };

    const handleAnalyzeMix = async () => {
        setLoading(true);
        setErrorMessage(null);
        try {
            const advice = await analyzeMix(tracks);
            setMixAdvice(advice || null);
            if (!advice) {
                setErrorMessage('No se pudo generar analisis de mezcla en este intento.');
            }
        } catch (error) {
            setErrorMessage(describeAiError(error));
        } finally {
            setLoading(false);
        }
    };

    return (
        <FluidPanel
            isOpen={isOpen}
            direction="left"
            className="absolute right-0 top-[50px] bottom-[280px] w-80 bg-[#0c0c0e] border-l border-white/5 shadow-2xl z-40 flex flex-col"
        >
            {/* Header */}
            <div className="flex justify-between items-center p-4 border-b border-white/5 bg-[#121215]">
                <div className="flex items-center gap-2 text-daw-accent">
                    <Bot size={18} />
                    <h2 className="font-bold tracking-wider text-sm">ASISTENTE DE ESTUDIO AI</h2>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Cerrar asistente AI"
                    className="min-h-11 min-w-11 inline-flex items-center justify-center hover:text-white text-gray-400 transition-colors"
                >
                    <X size={16} />
                </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-white/5">
                <button
                    onClick={() => setActiveTab('generate')}
                    className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2
                ${activeTab === 'generate' ? 'bg-[#222] text-white border-b-2 border-daw-accent' : 'text-gray-500 hover:text-white'}
            `}
                >
                    <Music2 size={12} />
                    Generador
                </button>
                <button
                    onClick={() => setActiveTab('mix')}
                    className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2
                ${activeTab === 'mix' ? 'bg-[#222] text-white border-b-2 border-daw-ruby' : 'text-gray-500 hover:text-white'}
            `}
                >
                    <BarChart3 size={12} />
                    Ingeniero de Mezcla
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">

                {!aiGatewayStatus.available && (
                    <div
                        className="mb-4 text-[10px] text-amber-200 bg-amber-500/10 border border-amber-500/25 rounded-sm px-3 py-2"
                        role="status"
                    >
                        {aiGatewayStatus.message} El proyecto local y el motor de audio siguen disponibles.
                    </div>
                )}

                {activeTab === 'generate' ? (
                    <div className="space-y-4">
                        <div className="bg-[#18181b] p-3 rounded-sm border border-white/5">
                            <label className="text-[10px] font-bold text-gray-500 uppercase mb-2 block">Descripción (Prompt)</label>
                            <div className="text-[10px] text-gray-500 mb-2">Tempo de referencia: {Math.round(bpm)} BPM</div>
                            <textarea
                                className="w-full h-24 bg-[#050505] border border-white/10 rounded-sm p-3 text-sm text-gray-200 focus:outline-none focus:border-daw-accent resize-none placeholder-gray-700"
                                placeholder="Describe el bucle (ej. 'Línea de bajo Acid Techno en La Menor')"
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                            />
                        </div>

                        {errorMessage && (
                            <div className="text-[10px] text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-sm px-3 py-2">
                                {errorMessage}
                            </div>
                        )}

                        <button
                            disabled={loading || !aiGatewayStatus.available}
                            onClick={handleGenerate}
                            className="w-full bg-daw-accent hover:bg-daw-cyan hover:text-black text-black font-bold py-3 rounded-sm flex items-center justify-center gap-2 transition-all disabled:opacity-50 shadow-[0_0_15px_rgba(59,249,246,0.2)]"
                        >
                            {loading ? <Loader2 className="animate-spin" size={16} /> : <Sparkles size={16} />}
                            GENERAR MIDI
                        </button>

                        <div className="mt-8">
                            <h3 className="text-[10px] font-bold text-gray-500 uppercase mb-3 px-1">Tendencias</h3>
                            <div className="flex flex-wrap gap-2">
                                {["Batería Liquid DnB", "Acordes Deep House", "Arpegio minimal", "Hi-Hats Trap"].map(p => (
                                    <button
                                        key={p}
                                        onClick={() => setPrompt(p)}
                                        className="text-[10px] px-3 py-1.5 bg-[#18181b] border border-white/5 rounded-full hover:border-daw-accent hover:text-daw-accent transition-all text-gray-400"
                                    >
                                        {p}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-4 h-full flex flex-col">
                        <div className="bg-daw-ruby/5 border border-daw-ruby/20 p-4 rounded-sm">
                            <h3 className="text-daw-ruby font-bold text-xs mb-1">ANÁLISIS DE MEZCLA AI</h3>
                            <p className="text-[10px] text-gray-400 leading-relaxed">
                                Analizaré los volúmenes, el paneo y el arreglo de tus pistas para sugerir mejoras de mezcla profesionales.
                            </p>
                        </div>

                        {mixAdvice ? (
                            <div className="flex-1 bg-[#18181b] p-4 rounded-sm border border-white/10 overflow-y-auto">
                                <h4 className="text-white font-bold text-xs mb-3 flex items-center gap-2">
                                    <Bot size={14} className="text-daw-ruby" />
                                    Reporte de Análisis:
                                </h4>
                                <div className="prose prose-invert prose-sm">
                                    <pre className="whitespace-pre-wrap font-sans text-xs text-gray-300 leading-relaxed">
                                        {mixAdvice}
                                    </pre>
                                </div>
                                <button
                                    onClick={() => setMixAdvice(null)}
                                    className="mt-4 w-full py-2 text-[10px] uppercase font-bold text-gray-500 hover:text-white border border-transparent hover:border-white/20 rounded-sm"
                                >
                                    Limpiar Reporte
                                </button>
                            </div>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center text-center opacity-50 gap-4">
                                <BarChart3 size={48} className="text-gray-700" />
                                <p className="text-xs text-gray-500 max-w-[200px]">
                                    Asegúrate de que tus pistas tengan nombres correctos para obtener los mejores resultados.
                                </p>
                            </div>
                        )}

                        {errorMessage && (
                            <div className="text-[10px] text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-sm px-3 py-2">
                                {errorMessage}
                            </div>
                        )}

                        {!mixAdvice && (
                            <button
                                disabled={loading || !aiGatewayStatus.available}
                                onClick={handleAnalyzeMix}
                                className="w-full bg-daw-ruby hover:bg-red-500 text-white font-bold py-3 rounded-sm flex items-center justify-center gap-2 transition-all disabled:opacity-50 shadow-[0_0_15px_rgba(244,63,94,0.2)] mt-auto"
                            >
                                {loading ? <Loader2 className="animate-spin" size={16} /> : <Mic2 size={16} />}
                                ANALIZAR PROYECTO
                            </button>
                        )}
                    </div>
                )}

            </div>
        </FluidPanel>
    );
};

export default React.memo(AISidebar);
