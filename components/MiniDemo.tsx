'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/themes/prism.css';
import { useGame } from '@/app/context/GameContext';
import ErrorBoundary from '@/components/ErrorBoundary';
import { usePathPlayback } from '@/hooks/usePathPlayback';
import { useResponsiveCell } from '@/hooks/useResponsiveCell';
import { getRotation, type RobotPos, type Direction } from '@/utils/robotEngine';
import { checkRunnableCode, runCodeInSandbox, getSandboxPlaybackPath } from '@/utils/sandboxRunner';

// Mini 3x3 grid: robot starts at (0,0), goal at (2,2)
//  [R][ ][ ]
//  [ ][W][ ]
//  [ ][ ][G]
const demoGrid = [
  ['empty', 'empty', 'empty'],
  ['empty', 'wall',  'empty'],
  ['empty', 'empty', 'goal'],
];

const DIRECTION_LABELS: Record<Direction, string> = {
  up: 'вгору',
  right: 'праворуч',
  down: 'вниз',
  left: 'ліворуч',
};

const INITIAL_CODE = `// Допоможи роботу дістатися до 🟩
// Команди: move(), turnRight(), turnLeft()

move();
move();
turnRight();
move();
move();`;

const EDITOR_STYLE = {
  fontFamily: '"Fira Code", "Cascadia Code", monospace',
  fontSize: 13,
  backgroundColor: '#fafafa',
  minHeight: '160px',
  lineHeight: '1.5',
};

export default function MiniDemo() {
  const [code, setCode] = useState(INITIAL_CODE);
  const [position, setPosition] = useState<RobotPos>({ x: 0, y: 0, dir: 'right' as Direction });
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const runTokenRef = useRef(0);
  const shakeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { isGameOver, resetGame } = useGame();
  // The highlighting editor is client-only, like the level editors: before it mounts (and if it
  // ever fails) a plain textarea with the same code is shown instead.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const triggerShake = useCallback(() => {
    if (shakeTimeoutRef.current) clearTimeout(shakeTimeoutRef.current);
    setShake(true);
    shakeTimeoutRef.current = setTimeout(() => {
      setShake(false);
      shakeTimeoutRef.current = null;
    }, 500);
  }, []);

  useEffect(() => {
    return () => {
      if (shakeTimeoutRef.current) clearTimeout(shakeTimeoutRef.current);
    };
  }, []);
  
  const { cellSize: CELL, gap: GAP } = useResponsiveCell(52, 40);
  const { path: animPath, index: animIndex, isAnimating, play, stop } = usePathPlayback(180);

  const animStep = animIndex >= 0 && animIndex < animPath.length ? animPath[animIndex] : null;
  const dp = animStep || position;
  const rotation = getRotation(dp.dir);
  const dirLabel = DIRECTION_LABELS[dp.dir] ?? dp.dir;

  const runCode = async () => {
    if (isAnimating || isExecuting) return;
    // The same check as on the levels: a syntax error, empty code or a typical beginner mistake is
    // explained in Ukrainian instead of running.
    const preflightError = checkRunnableCode(code);
    if (preflightError) {
      setPosition({ x: 0, y: 0, dir: 'right' });
      setIsSuccess(false);
      setError(preflightError);
      triggerShake();
      return;
    }
    const runToken = ++runTokenRef.current;
    setIsExecuting(true);
    setPosition({ x: 0, y: 0, dir: 'right' });
    setError(null);
    setIsSuccess(false);
    setShake(false);

    const result = await runCodeInSandbox({
      code,
      gridMap: demoGrid,
      initialPos: { x: 0, y: 0, dir: 'right' },
      mode: 'basic',
      throwOnOutOfBounds: true,
      maxSteps: 500,
    });
    if (runToken !== runTokenRef.current) return;
    setIsExecuting(false);

    if (!result.ok) {
      const replayPath = getSandboxPlaybackPath(result);
      if (replayPath.length > 0) {
        play(replayPath, () => {
          if (runToken !== runTokenRef.current) return;
          setPosition(result.finalPos);
          setError(result.error ?? 'Не вдалося виконати код.');
          triggerShake();
        });
      } else {
        setPosition(result.finalPos);
        setError(result.error ?? 'Не вдалося виконати код.');
        triggerShake();
      }
      return;
    }

    const playbackPath = getSandboxPlaybackPath(result);
    play(playbackPath, () => {
      if (runToken !== runTokenRef.current) return;
      setPosition(result.finalPos);
      if (
        result.finalPos.x === 2 &&
        result.finalPos.y === 2 &&
        !result.finalPos.outOfBounds &&
        !result.finalPos.blocked
      ) {
        setIsSuccess(true);
      } else {
        const hitWall = result.events.some(e => e.type === 'robot' && e.action === 'blocked');
        setError(hitWall
          ? 'Робот врізався в стіну 🧱 і не дістався до цілі. Перед стіною треба повернути: turnRight() або turnLeft().'
          : 'Робот не дістався до цілі 😕 Спробуй ще!');
        triggerShake();
      }
    });
  };

  const reset = () => {
    runTokenRef.current += 1;
    if (shakeTimeoutRef.current) {
      clearTimeout(shakeTimeoutRef.current);
      shakeTimeoutRef.current = null;
    }
    setShake(false);
    setIsExecuting(false);
    stop();
    setPosition({ x: 0, y: 0, dir: 'right' });
    setIsSuccess(false);
    setError(null);
    setCode(INITIAL_CODE);
  };

  const plainEditor = (
    <textarea
      id="mini-demo-editor"
      value={code}
      onChange={e => setCode(e.target.value)}
      disabled={isExecuting || isAnimating}
      spellCheck={false}
      className="block w-full resize-y outline-none"
      style={{ ...EDITOR_STYLE, padding: 14, border: 'none' }}
    />
  );

  return (
    <section className="bg-white rounded-2xl shadow p-4 md:p-6 mb-6 md:mb-10">
      <h2 className="text-xl md:text-2xl font-semibold mb-1">🎮 Спробуй зараз!</h2>
      <p className="text-gray-500 text-sm mb-4">Напиши код, щоб робот 🤖 дістався до 🟩 цілі. Без реєстрації, без втрати життів.</p>

      {/* Screen reader live status for robot position */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Позиція робота: рядок {dp.y + 1}, стовпець {dp.x + 1}, напрямок: {dirLabel}.
      </div>

      <div className="flex flex-col md:flex-row gap-4 items-start">
        {/* Code editor side */}
        <div className="flex-1 w-full min-w-0">
          <div className="rounded-xl overflow-hidden border border-gray-200">
            <div className="bg-gray-800 text-gray-300 text-xs px-3 py-1.5 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400 inline-block" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-400 inline-block" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-400 inline-block" />
              <span className="ml-2 font-mono">demo.js</span>
            </div>
            <label htmlFor="mini-demo-editor" className="sr-only">Код для демо-рівня</label>
            {mounted ? (
              <ErrorBoundary fallback={plainEditor}>
                <Editor
                  textareaId="mini-demo-editor"
                  value={code}
                  onValueChange={setCode}
                  highlight={c => Prism.highlight(c, Prism.languages.js, 'javascript')}
                  padding={14}
                  ignoreTabKey
                  disabled={isExecuting || isAnimating}
                  style={EDITOR_STYLE}
                />
              </ErrorBoundary>
            ) : plainEditor}
          </div>

          {error && (
            <div role="alert" className={`mt-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 ${shake ? 'animate-shake' : ''}`}>
              ❌ {error}
            </div>
          )}

          <div className="flex gap-2 mt-3">
            <button
              onClick={runCode}
              disabled={isAnimating || isExecuting}
              className="px-5 py-2 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              {isAnimating || isExecuting ? '⏳ Виконується...' : '▶ Запустити'}
            </button>
            <button
              onClick={reset}
              className="px-4 py-2 bg-gray-100 text-gray-600 rounded-xl font-medium hover:bg-gray-200 transition text-sm"
            >
              ↺ Скинути
            </button>
          </div>
        </div>

        {/* Grid side */}
        <div className="flex flex-col items-center gap-3">
          <div className="relative" style={{ width: `${3 * CELL + 2 * GAP}px`, height: `${3 * CELL + 2 * GAP}px` }}>
            <div
              role="grid"
              aria-label="Демонстраційне ігрове поле 3 на 3"
              aria-rowcount={3}
              aria-colcount={3}
              className="flex flex-col"
              style={{ gap: `${GAP}px` }}
            >
              {demoGrid.map((row, y) => (
                <div
                  key={`row-${y}`}
                  role="row"
                  className="grid grid-cols-3"
                  style={{ gap: `${GAP}px` }}
                >
                  {row.map((cell, x) => {
                    const hasRobot = dp.x === x && dp.y === y;
                    const cellContentLabel = cell === 'wall' ? 'стіна' : cell === 'goal' ? 'ціль' : 'порожня клітинка';
                    const cellLabel = `Рядок ${y + 1}, стовпець ${x + 1}: ${cellContentLabel}${hasRobot ? `, тут робот (${dirLabel})` : ''}`;

                    return (
                      <div
                        key={`${x}-${y}`}
                        role="gridcell"
                        aria-label={cellLabel}
                        className={`flex items-center justify-center rounded-lg border transition-colors
                          ${cell === 'wall' ? 'bg-gray-700 border-gray-600' : cell === 'goal' ? 'bg-green-400 border-green-500' : 'bg-gray-50 border-gray-200'}`}
                        style={{ width: `${CELL}px`, height: `${CELL}px` }}
                      >
                        {cell === 'wall' && <span className="text-lg" aria-hidden="true">🧱</span>}
                        {cell === 'goal' && <span className="text-lg" aria-hidden="true">🟩</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {/* Robot */}
            <div
              className="absolute flex items-center justify-center z-10 pointer-events-none"
              aria-hidden="true"
              style={{
                left: `${dp.x * (CELL + GAP)}px`,
                top: `${dp.y * (CELL + GAP)}px`,
                width: `${CELL}px`,
                height: `${CELL}px`,
                transition: 'left 0.16s ease-out, top 0.16s ease-out',
              }}
            >
              <span
                className="text-2xl drop-shadow-md"
                style={{ transform: `rotate(${rotation}deg)`, transition: 'transform 0.12s' }}
              >
                🤖
              </span>
            </div>
          </div>

          {/* Legend */}
          <div className="text-xs text-gray-500 flex gap-3" aria-hidden="true">
            <span>🤖 Робот</span>
            <span>🧱 Стіна</span>
            <span>🟩 Ціль</span>
          </div>

          {/* Success state */}
          {isSuccess && (
            <div className="text-center animate-fade-in" role="status">
              <p className="text-green-600 font-bold text-lg mb-2">🎉 Чудово!</p>
              <Link
                href="/Levels/level1"
                onClick={() => {
                  // With no lives left level 1 would open straight into the game-over window.
                  if (isGameOver) resetGame();
                }}
                className="inline-block px-5 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl font-medium hover:from-blue-700 hover:to-indigo-700 transition shadow-lg shadow-blue-200 text-sm"
              >
                Почати гру →
              </Link>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
