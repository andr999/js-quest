import React from 'react';
import Link from 'next/link';
import { LEVELS_CONFIG } from '@/utils/levelsConfig';

export const LEVEL_NAMES = Object.values(LEVELS_CONFIG).map(l => l.name);

interface LevelCardProps {
  levelNum: number;
  name: string;
  isUnlocked: boolean;
  isCompleted: boolean;
  isGameOver: boolean;
}

function LevelCard({ levelNum, name, isUnlocked, isCompleted, isGameOver }: LevelCardProps) {
  if (!isUnlocked) {
    return (
      <div
        className="bg-slate-100 text-slate-700 border border-slate-300 rounded-xl p-3 md:p-4 text-center text-sm md:text-base font-medium shadow-sm cursor-not-allowed select-none"
        aria-label={`Рівень ${levelNum}: ${name} (заблоковано)`}
      >
        🔒 Рівень {levelNum}: {name}
      </div>
    );
  }

  // With no lives left a level would open straight into the game-over window, so the cards stay
  // visible but are not links until the game is started again.
  if (isGameOver) {
    return (
      <div
        className={`rounded-xl p-3 md:p-4 text-center text-sm md:text-base font-medium shadow-sm cursor-not-allowed select-none border ${
          isCompleted ? 'bg-green-50 text-green-800 border-green-300' : 'bg-slate-100 text-slate-700 border-slate-300'
        }`}
        aria-label={`Рівень ${levelNum}: ${name} (недоступно: життя закінчилися)`}
      >
        {isCompleted ? '✅' : '💔'} Рівень {levelNum}: {name}
      </div>
    );
  }

  return (
    <Link
      href={`/Levels/level${levelNum}`}
      className={`rounded-xl p-3 md:p-4 text-center text-sm md:text-base font-medium shadow hover:scale-105 transition block ${
        isCompleted
          ? 'bg-green-100 text-green-800 border-2 border-green-300'
          : 'bg-blue-100 text-blue-800'
      }`}
    >
      {isCompleted ? '✅' : '▶️'} Рівень {levelNum}: {name}
    </Link>
  );
}

interface LevelMapProps {
  completedLevels: number[];
  isLevelUnlocked: (level: number) => boolean;
  /** No lives left: levels cannot be opened until the game is restarted. */
  isGameOver?: boolean;
  /** Starts the game again (shown while isGameOver). */
  onRestart?: () => void;
}

export default function LevelMap({ completedLevels, isLevelUnlocked, isGameOver = false, onRestart }: LevelMapProps) {
  return (
    <div>
      {isGameOver && (
        <div
          role="status"
          className="mb-4 flex flex-col sm:flex-row items-center justify-center gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm md:text-base text-red-800"
        >
          <span>💔 Життя закінчилися — рівні відкриються, коли почнеш гру заново.</span>
          {onRestart && (
            <Link
              href="/Levels/level1"
              onClick={onRestart}
              className="shrink-0 rounded-xl bg-red-600 px-4 py-2 font-medium text-white transition hover:bg-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
            >
              🔄 Почати заново
            </Link>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
        {LEVEL_NAMES.map((name, i) => {
          const levelNum = i + 1;
          return (
            <LevelCard
              key={levelNum}
              levelNum={levelNum}
              name={name}
              isUnlocked={isLevelUnlocked(levelNum)}
              isCompleted={completedLevels.includes(levelNum)}
              isGameOver={isGameOver}
            />
          );
        })}
      </div>
    </div>
  );
}
