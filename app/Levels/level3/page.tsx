// Рівень 3: Збір ключа і досягнення мети
"use client";
import { useCallback, useRef, useState, useEffect } from 'react';
import { useGame, type AttemptToken, type AttemptVerdict } from '@/app/context/GameContext';
import LevelLayout from '@/components/LevelLayout';
import GridRenderer from '@/components/GridRenderer';
import { usePathPlayback } from '@/hooks/usePathPlayback';
import { useResponsiveCell } from '@/hooks/useResponsiveCell';
import { checkRunnableCode, getSandboxPlaybackPath, movesInLoop, runCodeInSandbox, type SandboxResult } from '@/utils/sandboxRunner';
import { LEVELS_CONFIG, computeLevelScore } from '@/utils/levelsConfig';

const initialCode = `// Напиши свій код тут!
// Спочатку потрібно зібрати 🔑 ключ, потім дістатися до 🎯 мети!

// Доступні команди: move(), turnLeft(), turnRight()
// Умовні функції: canMove(), isWallAhead(), isGoalReached(), hasKey()
// Використовуй цикли (for, while) та умови (if/else)!

// Приклад: цей цикл доведе робота до 🔑 ключа:
// while (!hasKey()) {
//   if (canMove()) {
//     move();
//   } else {
//     turnRight();
//   }
// }
//
// А далі таким самим циклом доведи робота до 🎯 мети —
// тільки з умовою while (!isGoalReached()).
// ⚠️ Запускай, коли напишеш обидві частини: без фінішу спроба не зарахується.

`;

const LEVEL_NUMBER = 3;
const CONFIG = LEVELS_CONFIG[LEVEL_NUMBER];
const gridMap = CONFIG.gridMap;
const INIT_POS = CONFIG.initialPos;

export default function Level3() {
    const [code, setCode] = useState(initialCode);
    const [position, setPosition] = useState(INIT_POS);
    const [log, setLog] = useState<string[]>([]);
    const [showRules, setShowRules] = useState(true);
    const [isVictory, setIsVictory] = useState(false);
    const [collectedKey, setCollectedKey] = useState(false);
    const [isDefeat, setIsDefeat] = useState(false);
    const [isExecuting, setIsExecuting] = useState(false);

    const [defeatReason, setDefeatReason] = useState('');
    const { getAttempts, startAttempt, finishAttempt: finishAttemptTransaction, finishAttemptSync, storageKey, resetAt } = useGame();
    const { play: playPath, current: animStep, isAnimating, stop: stopAnim, path: animPath, index: animIndex } = usePathPlayback(150);
    const { cellSize: CELL, gap: GAP } = useResponsiveCell(56, 40);
    const attemptInProgressRef = useRef(false);
    const executionTokenRef = useRef(0);
    const attemptTokenRef = useRef<AttemptToken | null>(null);
    const pendingVerdictRef = useRef<AttemptVerdict | null>(null);
    const attempts = getAttempts(LEVEL_NUMBER);

    const dp = animStep || position;

    // Once the animation ends, the sandbox result (not the possibly shortened replay) is the truth.
    const isKeyCollectedNow = isAnimating
        ? animPath.slice(0, animIndex + 1).some(p => p.keyPicked)
        : collectedKey;

    const finishAttempt = (result: SandboxResult, newAttempts: number, token: AttemptToken) => {
        const replayPath = getSandboxPlaybackPath(result);
        const path = replayPath.length > 0 ? replayPath : [{ ...INIT_POS }];
        const consoleLog = result.events
            .filter((e): e is Extract<typeof e, { type: 'console' }> => e.type === 'console')
            .map(e => `💬 ${e.message}`);
        const pathLog = path.map(p => {
            let message = `(${p.x}, ${p.y}) ${p.dir}`;
            if (p.outOfBounds) message += ' [OUT OF BOUNDS]';
            else if (p.blocked) message += ' [WALL]';
            else if (p.keyPicked) message += ' [🔑 КЛЮЧ ЗІБРАНО!]';
            return message;
        });
        const combinedLog = [...consoleLog, ...pathLog];
        setLog(result.ok || !result.error
            ? combinedLog
            : [...combinedLog, `❌ ${result.errorCode ?? 'ERROR'}: ${result.error}`]);

        const reachedGoal = result.ok && gridMap[result.finalPos.y]?.[result.finalPos.x] === 'goal';
        const hasAllKeys = result.hasKey;
        // Decided from the run: moves made inside a loop iteration, array iteration method or repeat.
        const hasValidLoop = (result.loopActions ?? 0) >= 1 && movesInLoop(result);
        const isWin = reachedGoal && hasAllKeys && hasValidLoop;
        const points = computeLevelScore(CONFIG, result.steps, newAttempts);
        pendingVerdictRef.current = isWin ? { outcome: 'victory', points, finalPos: result.finalPos } : { outcome: 'defeat' };

        playPath(path, () => {
            attemptInProgressRef.current = false;
            attemptTokenRef.current = null;
            pendingVerdictRef.current = null;
            setPosition(result.finalPos);
            setCollectedKey(result.hasKey);

            if (!result.ok) {
                const reason = result.error ?? 'Помилка виконання.';
                setDefeatReason(reason);
                setIsDefeat(true);
                finishAttemptTransaction({ token, outcome: 'defeat' });
                return;
            }

            if (isWin) {
                const success = finishAttemptTransaction({ token, outcome: 'victory', points });
                if (success) {
                    setIsVictory(true);
                    setIsDefeat(false);
                }
            } else {
                let reason: string;
                if (!hasAllKeys) {
                    reason = 'Спочатку потрібно зібрати ключ!';
                } else if (!reachedGoal) {
                    reason = 'Ключ зібрано, але робот не дійшов до фінішу! Додай після першого циклу другий — while (!isGoalReached()) { ... }.';
                } else if (!hasValidLoop) {
                    reason = 'Умова рівня: команди робота мають виконуватися в циклі (while, for або repeat)!';
                } else {
                    reason = 'Не вдалося виконати всі умови рівня.';
                }
                setDefeatReason(reason);
                setLog(prev => [...prev, `⚠️ ${reason}`]);
                setIsDefeat(true);
                finishAttemptTransaction({ token, outcome: 'defeat' });
            }
        });
    };

    const executeCode = async () => {
        if (attemptInProgressRef.current || isAnimating) return;
        const preflightError = checkRunnableCode(code);
        if (preflightError) {
            setLog([`⚠️ ${preflightError}`]);
            return;
        }
        const attemptToken = startAttempt(LEVEL_NUMBER);
        if (!attemptToken) return null;
        attemptTokenRef.current = attemptToken;
        attemptInProgressRef.current = true;
        const executionToken = ++executionTokenRef.current;
        const newAttempts = attempts + 1;
        setIsExecuting(true);
        setPosition(INIT_POS);
        setCollectedKey(false);
        setLog([]);
        setIsVictory(false);
        setIsDefeat(false);
        setDefeatReason('');

        try {
            const result = await runCodeInSandbox({
                code,
                gridMap,
                initialPos: INIT_POS,
                mode: 'single-key',
                throwOnOutOfBounds: true,
            });
            if (executionToken !== executionTokenRef.current) return;
            setIsExecuting(false);
            finishAttempt(result, newAttempts, attemptToken);
        } catch (error) {
            if (executionToken !== executionTokenRef.current) return;
            attemptInProgressRef.current = false;
            attemptTokenRef.current = null;
            setIsExecuting(false);
            const reason = `WORKER_ERROR: ${error instanceof Error ? error.message : String(error)}`;
            setDefeatReason(reason);
            setLog([`❌ ${reason}`]);
            setIsDefeat(true);
            finishAttemptTransaction({ token: attemptToken, outcome: 'defeat' });
        }
    };

    const resetLevel = useCallback(() => {
        executionTokenRef.current += 1;
        const wasActive = attemptInProgressRef.current;
        const activeToken = attemptTokenRef.current;
        const verdict: AttemptVerdict = pendingVerdictRef.current ?? { outcome: 'defeat' };
        attemptTokenRef.current = null;
        attemptInProgressRef.current = false;
        pendingVerdictRef.current = null;
        setIsExecuting(false);
        stopAnim();
        if (wasActive && activeToken && verdict.outcome === 'victory') {
            const success = finishAttemptTransaction({ token: activeToken, outcome: 'victory', points: verdict.points });
            if (success) {
                if (verdict.finalPos) setPosition(verdict.finalPos);
                setIsVictory(true);
                setIsDefeat(false);
                setDefeatReason('');
                setCollectedKey(true);
                return;
            }
        }
        setPosition(INIT_POS);
        setLog([]);
        setIsVictory(false);
        setIsDefeat(false);
        setDefeatReason('');
        setCollectedKey(false);
        if (wasActive && activeToken && verdict.outcome !== 'victory') {
            finishAttemptTransaction({ token: activeToken, outcome: verdict.outcome, points: verdict.points });
        }
    }, [finishAttemptTransaction, stopAnim]);

    const lastStorageKeyRef = useRef(storageKey);
    useEffect(() => {
        if (storageKey !== lastStorageKeyRef.current) {
            lastStorageKeyRef.current = storageKey;
            attemptTokenRef.current = null;
            attemptInProgressRef.current = false;
            resetLevel();
            setCode(initialCode);
        }
    }, [storageKey, resetLevel]);

    const lastResetAtRef = useRef(resetAt);
    useEffect(() => {
        if (resetAt !== lastResetAtRef.current) {
            const shouldReset = resetAt > 0 || lastResetAtRef.current > 0;
            lastResetAtRef.current = resetAt;
            if (shouldReset) {
                attemptTokenRef.current = null;
                attemptInProgressRef.current = false;
                resetLevel();
                setCode(initialCode);
            }
        }
    }, [resetAt, resetLevel]);

    useEffect(() => {
        const handlePageLeave = () => {
            const activeToken = attemptTokenRef.current;
            if (activeToken) {
                const verdict: AttemptVerdict = pendingVerdictRef.current ?? { outcome: 'defeat' };
                attemptTokenRef.current = null;
                attemptInProgressRef.current = false;
                pendingVerdictRef.current = null;
                finishAttemptSync({ token: activeToken, outcome: verdict.outcome, points: verdict.points });
            }
        };

        window.addEventListener('beforeunload', handlePageLeave);
        window.addEventListener('pagehide', handlePageLeave);

        return () => {
            window.removeEventListener('beforeunload', handlePageLeave);
            window.removeEventListener('pagehide', handlePageLeave);
            handlePageLeave();
        };
    }, [finishAttemptSync]);

    return (
        <LevelLayout
            level={LEVEL_NUMBER}
            attempts={attempts}
            code={code}
            onCodeChange={setCode}
            editorDisabled={isExecuting || isAnimating}
            onRun={executeCode}
            onReset={resetLevel}
            resetDisabled={isExecuting}
            runDisabled={isExecuting || isAnimating}
            showRules={showRules}
            onShowRules={() => setShowRules(true)}
            onHideRules={() => setShowRules(false)}
            rulesTitle="📜 Правила рівня 3: Цикли та ключ"
            rulesContent={
                <ul className="list-disc pl-4 space-y-1">
                    <li>🎯 <strong>Мета:</strong> зібрати 🔑 ключ, потім дістатися до 🎯 мети.</li>
                    <li>⌨️ Доступні команди: <code>move()</code>, <code>turnRight()</code>, <code>turnLeft()</code></li>
                    <li>🧠 Умовні функції: <code>canMove()</code>, <code>isWallAhead()</code>, <code>isGoalReached()</code>, <code>hasKey()</code></li>
                    <li>🔄 <strong>Обов&apos;язкова умова:</strong> команди мають виконуватися в циклі (<code>while</code>, <code>for</code> або <code>repeat</code>)!</li>
                    <li>❤️ У тебе є 3 життя. Кожна невдала спроба забирає 1 життя!</li>
                </ul>
            }
            isVictory={isVictory}
            victory={{
                subtitle: 'Ключ зібрано, мету досягнуто!',
                description: 'Ти освоїв цикли та умовні функції! 🔄✨',
                nextLevelHref: '/Levels/level4',
            }}
            isDefeat={isDefeat}
            defeatSubtitle={defeatReason || 'Робот не дістався до цілі або не зібрав ключ!'}
            log={log}
            gridClassName="w-full md:w-[400px]"
        >
            <GridRenderer
                gridMap={gridMap}
                cols={6}
                cellSize={CELL}
                gap={GAP}
                robotPos={dp}
                getCell={(cell, x, y) => {
                    if (cell === 'key') {
                        return { style: 'bg-yellow-100 border-yellow-300', content: isKeyCollectedNow ? '' : '🔑' };
                    }
                    return null;
                }}
            />
        </LevelLayout>
    );
}
