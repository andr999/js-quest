"use client";
import { useGame } from '@/app/context/GameContext';
import { useRouter } from 'next/navigation';
import React from 'react';
import { useFocusTrap } from '@/hooks/useFocusTrap';

export default function GameOverModal() {
    const { isGameOver, score, resetGame } = useGame();
    const router = useRouter();
    const modalRef = useFocusTrap<HTMLDivElement>(isGameOver);

    if (!isGameOver) return null;

    return (
        <div
            className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center backdrop-blur-sm p-3 sm:p-4 overflow-y-auto"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gameover-modal-title"
        >
            <div
                ref={modalRef}
                className="bg-gradient-to-br from-red-600 to-red-900 rounded-2xl p-5 sm:p-8 max-w-md w-full max-h-[calc(100vh-1.5rem)] sm:max-h-[90vh] overflow-y-auto my-auto shadow-2xl text-white text-center animate-fade-in"
            >
                <h2 id="gameover-modal-title" className="text-3xl sm:text-5xl font-bold mb-2 sm:mb-4">💀 Game Over!</h2>
                <p className="text-base sm:text-xl mb-2">У тебе закінчилися всі життя</p>
                <div className="my-3 sm:my-6 bg-black/30 rounded-xl p-3 sm:p-4">
                    <p className="text-xs sm:text-sm text-red-200">Фінальний рахунок</p>
                    <p className="text-2xl sm:text-4xl font-bold text-yellow-300">⭐ {score}</p>
                </div>
                <div className="flex flex-col gap-2.5 sm:gap-3">
                    <button
                        onClick={() => { resetGame(); router.push('/Levels/level1'); }}
                        className="px-5 py-2.5 sm:px-6 sm:py-3 bg-white text-red-700 font-semibold rounded-lg hover:bg-gray-100 transition text-sm sm:text-base"
                    >
                        🔄 Почати заново
                    </button>
                    <button
                        // Only navigates: the home page keeps the final score visible and offers
                        // "Почати заново", which is where the progress is actually reset.
                        onClick={() => { router.push('/'); }}
                        className="px-5 py-2.5 sm:px-6 sm:py-3 bg-transparent border-2 border-white text-white font-semibold rounded-lg hover:bg-white hover:text-red-700 transition text-sm sm:text-base"
                    >
                        🏠 На головну
                    </button>
                </div>
            </div>
        </div>
    );
}
