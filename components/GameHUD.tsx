"use client";
import { useGame, DEFAULT_LIVES } from '@/app/context/GameContext';

interface GameHUDProps {
    levelNumber: number;
    attempts?: number;
}

export default function GameHUD({ levelNumber, attempts }: GameHUDProps) {
    const { lives, score } = useGame();

    return (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-gradient-to-r from-slate-800 to-slate-700 text-white px-3 sm:px-4 py-2 rounded-xl mb-4 shadow-lg">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                <span className="text-sm font-bold bg-blue-600 px-3 py-1 rounded-lg">
                    Рівень {levelNumber}
                </span>
                {typeof attempts === 'number' && (
                    <span className="text-xs text-slate-300">
                        Спроба #{Math.max(1, attempts)}
                    </span>
                )}
            </div>

            <div className="ml-auto flex items-center gap-2 sm:gap-4">
                {/* Lives */}
                <div className="flex items-center gap-1" role="status" aria-live="polite" aria-atomic="true">
                    <span className="sr-only">Життя: {lives} з {DEFAULT_LIVES}</span>
                    <div className="flex items-center gap-1" aria-hidden="true">
                        {Array.from({ length: DEFAULT_LIVES }).map((_, i) => (
                            <span
                                key={i}
                                className={`text-xl transition-all duration-300 ${i < lives ? 'scale-100 opacity-100' : 'scale-75 opacity-30 grayscale'}`}
                            >
                                ❤️
                            </span>
                        ))}
                    </div>
                </div>

                {/* Score */}
                <div className="flex items-center gap-1 bg-yellow-600/30 px-3 py-1 rounded-lg border border-yellow-500/40" role="status" aria-live="polite" aria-atomic="true">
                    <span className="sr-only">Рахунок: {score}</span>
                    <span className="text-lg" aria-hidden="true">⭐</span>
                    <span className="font-bold text-yellow-300" aria-hidden="true">{score}</span>
                </div>
            </div>
        </div>
    );
}
