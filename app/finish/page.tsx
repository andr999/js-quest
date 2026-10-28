"use client";
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import confetti from 'canvas-confetti';
import { useGame } from '@/app/context/GameContext';
import { TOTAL_LEVELS } from '@/utils/levelsConfig';

export default function FinishPage() {
    const { score, lives, resetGame, completedLevels, isHydrated } = useGame();
    const router = useRouter();
    const [mounted, setMounted] = useState(false);

    const hasFinished = Array.from({ length: TOTAL_LEVELS }, (_, i) => i + 1).every(lvl => completedLevels.includes(lvl));

    // Guard: the finish screen is only reachable after every level is completed and player is alive.
    useEffect(() => {
        if (isHydrated && (!hasFinished || lives === 0)) {
            router.replace('/');
        }
    }, [isHydrated, hasFinished, lives, router]);

    useEffect(() => {
        if (!isHydrated || !hasFinished || lives === 0) return;
        setMounted(true);
        document.title = "Вітаємо з перемогою! | JS Quest";
        // Trigger confetti
        const duration = 4 * 1000;
        const animationEnd = Date.now() + duration;
        const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 0 };

        const randomInRange = (min: number, max: number) => Math.random() * (max - min) + min;

        const interval: ReturnType<typeof setInterval> = setInterval(function() {
            const timeLeft = animationEnd - Date.now();

            if (timeLeft <= 0) {
                return clearInterval(interval);
            }

            const particleCount = 50 * (timeLeft / duration);
            confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 } }));
            confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 } }));
        }, 250);

        return () => clearInterval(interval);
    }, [isHydrated, hasFinished, lives]);

    if (!mounted) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gray-50">
                <div className="animate-spin text-4xl">⏳</div>
                <p className="text-gray-500">Перевірка доступу...</p>
            </div>
        );
    }

    return (
        <main className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-black flex items-center justify-center p-4">
            <div className="bg-white/10 backdrop-blur-lg border border-white/20 p-8 md:p-12 rounded-3xl shadow-2xl max-w-2xl w-full text-center text-white relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-pink-500 via-purple-500 to-indigo-500"></div>

                <h1 className="text-5xl md:text-7xl font-extrabold mb-4 bg-clip-text text-transparent bg-gradient-to-r from-yellow-400 to-pink-500 drop-shadow-sm">
                    Вітаємо! 🎉
                </h1>
                <p className="text-xl md:text-2xl text-purple-200 mb-8 font-light">
                    Ти успішно завершив усі рівні JS Quest і довів свою майстерність у JavaScript! 🚀
                </p>

                <div className="grid grid-cols-2 gap-4 md:gap-6 mb-10">
                    <div className="bg-black/30 rounded-2xl p-6 border border-white/10 transform transition hover:scale-105">
                        <div className="text-4xl mb-2">⭐</div>
                        <div className="text-sm text-gray-400 uppercase tracking-wider mb-1">Підсумковий Рахунок</div>
                        <div className="text-3xl md:text-5xl font-bold text-yellow-400">{score}</div>
                    </div>
                    <div className="bg-black/30 rounded-2xl p-6 border border-white/10 transform transition hover:scale-105">
                        <div className="text-4xl mb-2">❤️</div>
                        <div className="text-sm text-gray-400 uppercase tracking-wider mb-1">Збережені Життя</div>
                        <div className="text-3xl md:text-5xl font-bold text-red-400">{lives}</div>
                    </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                    <button
                        onClick={() => router.push('/')}
                        className="w-full sm:w-auto px-8 py-4 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl font-bold text-lg hover:from-blue-500 hover:to-indigo-500 transition shadow-lg shadow-blue-500/30"
                    >
                        На Головну Сторінку
                    </button>
                    <button
                        onClick={() => { resetGame(); router.push('/'); }}
                        className="w-full sm:w-auto px-8 py-4 bg-white/10 hover:bg-white/20 rounded-xl font-bold text-lg transition border border-white/20"
                    >
                        Скинути та Грати Знову
                    </button>
                </div>
            </div>
        </main>
    );
}
