"use client";

import { useUser, RedirectToSignIn } from "@clerk/nextjs";
import { useGame, DEFAULT_LIVES } from "@/app/context/GameContext";
import Link from "next/link";
import Image from "next/image";
import { useState, useEffect } from "react";
import LevelMap from "@/components/LevelMap";
import ConfirmModal from "@/components/ConfirmModal";
import { TOTAL_LEVELS } from "@/utils/levelsConfig";

export default function ProfilePage() {
  const { user, isLoaded, isSignedIn } = useUser();
  const { score, lives, completedLevels, resetGame, isLevelUnlocked, isGameOver } = useGame();
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  useEffect(() => {
    document.title = "Профіль гравця | JS Quest";
  }, []);

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin text-4xl">⏳</div>
      </div>
    );
  }

  if (!isSignedIn) {
    return <RedirectToSignIn />;
  }

  const totalLevels = TOTAL_LEVELS;
  const progressPercent = Math.round((completedLevels.length / totalLevels) * 100);

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-2xl mx-auto">
        {/* User Card */}
        <div className="bg-gradient-to-br from-slate-800 to-slate-900 text-white rounded-2xl p-6 shadow-xl mb-6">
          <div className="flex items-center gap-4">
            {user.imageUrl && (
              <Image
                src={user.imageUrl}
                alt="Avatar"
                width={64}
                height={64}
                unoptimized
                className="rounded-full border-2 border-white/30"
              />
            )}
            <div>
              <h1 className="text-2xl font-bold">
                {user.fullName || user.username || "Гравець"}
              </h1>
              <p className="text-base text-slate-100">
                {user.primaryEmailAddress?.emailAddress}
              </p>
            </div>
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-3 gap-4 mt-6">
            <div className="bg-white/10 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-yellow-300">⭐ {score}</div>
              <div className="text-sm font-medium text-slate-100 mt-1">Рахунок</div>
            </div>
            <div className="bg-white/10 rounded-xl p-3 text-center" role="status" aria-live="polite" aria-atomic="true">
              <span className="sr-only">Життя: {lives} з {DEFAULT_LIVES}</span>
              <div className="text-2xl font-bold" aria-hidden="true">
                {Array.from({ length: DEFAULT_LIVES }).map((_, i) => (
                  <span key={i} className={i < lives ? "" : "opacity-30"}>❤️</span>
                ))}
              </div>
              <div className="text-sm font-medium text-slate-100 mt-1" aria-hidden="true">Життя</div>
            </div>
            <div className="bg-white/10 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-green-300">
                {completedLevels.length}/{totalLevels}
              </div>
              <div className="text-sm font-medium text-slate-100 mt-1">Рівнів пройдено</div>
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="bg-white rounded-xl p-4 shadow mb-6">
          <div className="flex items-center justify-between mb-2">
            <span id="profile-progress-label" className="text-sm font-semibold text-gray-700">Загальний прогрес</span>
            <span className="text-sm font-bold text-blue-600">{progressPercent}%</span>
          </div>
          <div
            className="w-full bg-gray-200 rounded-full h-3 overflow-hidden"
            role="progressbar"
            aria-labelledby="profile-progress-label"
            aria-valuenow={progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${completedLevels.length} з ${totalLevels} рівнів пройдено (${progressPercent}%)`}
          >
            <div
              className="bg-gradient-to-r from-blue-500 to-purple-500 h-3 rounded-full transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* Level Map */}
        <div className="bg-white rounded-xl p-4 shadow mb-6">
          <h2 className="text-lg font-bold mb-3">🗺️ Карта рівнів</h2>
          <LevelMap completedLevels={completedLevels} isLevelUnlocked={isLevelUnlocked} isGameOver={isGameOver} onRestart={resetGame} />
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Link
            href="/"
            className="flex-1 text-center px-4 py-3 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 transition"
          >
            🏠 На головну
          </Link>
          <button
            onClick={() => setShowResetConfirm(true)}
            className="px-4 py-3 bg-red-100 text-red-700 font-semibold rounded-xl hover:bg-red-200 transition"
          >
            🔄 Скинути прогрес
          </button>
        </div>
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
    </main>
  );
}
