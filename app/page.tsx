"use client";
import Link from "next/link";
import { useState } from 'react';
import { SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import { useGame, DEFAULT_LIVES } from "@/app/context/GameContext";
import MiniDemo from "@/components/MiniDemo";
import LevelMap from "@/components/LevelMap";
import ConfirmModal from "@/components/ConfirmModal";
import { TOTAL_LEVELS } from "@/utils/levelsConfig";

export default function Home() {
  const { lives, score, resetGame, completedLevels, isLevelUnlocked, isGameOver } = useGame();
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const nextLevel = Math.min(
    TOTAL_LEVELS,
    Array.from({ length: TOTAL_LEVELS }, (_, i) => i + 1).find(lvl => !completedLevels.includes(lvl)) ?? 1
  );
  const allCompleted = TOTAL_LEVELS > 0 && Array.from({ length: TOTAL_LEVELS }, (_, i) => i + 1).every(lvl => completedLevels.includes(lvl));

  const playButtonHref = lives === 0
    ? '/Levels/level1'
    : allCompleted
      ? '/finish'
      : `/Levels/level${nextLevel}`;

  const playButtonText = lives === 0
    ? 'Почати заново'
    : allCompleted
      ? 'Переглянути нагороду 🏆'
      : completedLevels.length > 0
        ? `Продовжити (Рівень ${nextLevel})`
        : 'Почати гру';

  return (
    <main className="min-h-screen bg-gray-100 p-3 md:p-6 font-sans">
      <div className="max-w-3xl mx-auto text-center">
        <h1 className="text-2xl md:text-4xl font-bold mb-2">JS Quest</h1>
        <p className="text-sm md:text-lg text-gray-700 mb-4">Прокачай JavaScript, проходячи рівні та вирішуючи завдання!</p>

        {/* Game Status Bar */}
        <div className="flex flex-wrap items-center justify-center gap-3 md:gap-6 mb-6 bg-white rounded-xl shadow p-2 md:p-3">
          <div className="flex items-center gap-1" role="status" aria-live="polite" aria-atomic="true">
            <span className="sr-only">Життя: {lives} з {DEFAULT_LIVES}</span>
            <div className="flex items-center gap-1" aria-hidden="true">
              {Array.from({ length: DEFAULT_LIVES }).map((_, i) => (
                <span key={i} className={`text-2xl transition-all ${i < lives ? '' : 'opacity-20 grayscale'}`}>
                  ❤️
                </span>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1 bg-yellow-50 px-3 py-1 rounded-lg border border-yellow-300" role="status" aria-live="polite" aria-atomic="true">
            <span className="sr-only">Рахунок: {score}</span>
            <span className="text-xl" aria-hidden="true">⭐</span>
            <span className="font-bold text-yellow-700 text-lg" aria-hidden="true">{score}</span>
          </div>
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            className="text-sm text-gray-500 hover:text-red-500 transition"
            title="Скинути прогрес"
          >
            🔄 Скинути
          </button>
          {showResetConfirm && (
            <ConfirmModal
              title="Скинути прогрес?"
              message="Це назавжди видалить усі пройдені рівні та рахунок. Ви впевнені?"
              confirmText="Скинути"
              cancelText="Скасувати"
              onConfirm={() => {
                resetGame();
                setShowResetConfirm(false);
              }}
              onCancel={() => setShowResetConfirm(false)}
            />
          )}
        </div>

        <div className="flex flex-wrap justify-center gap-3 md:gap-4 mb-6 md:mb-10">
          <Link
            href={playButtonHref}
            onClick={() => {
              if (lives === 0) {
                resetGame();
              }
            }}
            className="bg-blue-600 text-white px-6 py-3 rounded-2xl shadow hover:bg-blue-700 transition font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
          >
            {playButtonText}
          </Link>
          <SignedIn>
            <Link
              href="/profile"
              className="bg-gray-200 text-gray-800 px-6 py-3 rounded-2xl hover:bg-gray-300 transition font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-700"
            >
              Профіль
            </Link>
          </SignedIn>
          <SignedOut>
            <SignInButton mode="modal">
              <button
                type="button"
                className="bg-gray-200 text-gray-800 px-6 py-3 rounded-2xl hover:bg-gray-300 transition font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-700"
              >
                Профіль
              </button>
            </SignInButton>
          </SignedOut>
        </div>

        <section className="bg-white rounded-2xl shadow p-4 md:p-6 mb-6 md:mb-10">
          <h2 className="text-xl md:text-2xl font-semibold mb-4">Карта рівнів</h2>
          <LevelMap completedLevels={completedLevels} isLevelUnlocked={isLevelUnlocked} isGameOver={isGameOver} onRestart={resetGame} />
        </section>

        <MiniDemo />

      </div>
    </main>
  );
}
