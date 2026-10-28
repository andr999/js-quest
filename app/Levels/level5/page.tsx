// Рівень 5: Масиви
"use client";
import { useCallback, useRef, useState, useEffect } from 'react';
import { useGame, type AttemptToken, type AttemptVerdict } from '@/app/context/GameContext';
import LevelLayout from '@/components/LevelLayout';
import GridRenderer from '@/components/GridRenderer';
import { usePathPlayback } from '@/hooks/usePathPlayback';
import { useResponsiveCell } from '@/hooks/useResponsiveCell';
import { checkRunnableCode, followsLevelData, getSandboxPlaybackPath, movesInLoop, runCodeInSandbox, type SandboxResult } from '@/utils/sandboxRunner';
import { LEVELS_CONFIG, computeLevelScore } from '@/utils/levelsConfig';
import { routeDataVariant, type RobotCommand } from '@/utils/levelData';

const LEVEL_NUMBER = 5;
const CONFIG = LEVELS_CONFIG[LEVEL_NUMBER];
const realGridMap = CONFIG.gridMap;
const INIT_POS = CONFIG.initialPos;

const KEY_IDS = realGridMap.flatMap((row, y) => row.flatMap((cell, x) => (cell === 'key' ? [`${x},${y}`] : [])));
const TOTAL_KEYS = KEY_IDS.length;

const finalRoute: RobotCommand[] = [
    'move', 'move', 'move',
    'move', 'move', 'move',
    'turnRight',
    'move', 'move',
    'turnRight',
    'move',
    'turnLeft', 'turnLeft',
    'move',
    'turnRight',
    'move', 'move',
    'turnRight',
    'move', 'move', 'move', 'move', 'move', 'move',
    'turnLeft',
    'move', 'move',
    'turnLeft',
    'move',
    'move', 'move', 'move',
    'turnLeft',
    'move',
    'turnRight',
    'move', 'move',
    'turnRight',
    'move',
    'turnLeft',
    'move',
];

const formattedRoute: string[] = [];
for (let i = 0; i < finalRoute.length; i += 6) {
    formattedRoute.push(finalRoute.slice(i, i + 6).map(r => `'${r}'`).join(', '));
}
const routeString = formattedRoute.join(',\n//   ');

// The same code also runs with another route on a board made for it: only code that follows the
// data in route gets there too.
const ROUTE_VARIANTS = [routeDataVariant('route', finalRoute, TOTAL_KEYS)];

const initialCode = `// Напиши свій код тут!
// ⭐ Рівень 5: Масиви, Цикли та КЛЮЧІ! 🔑

// Маршрут тепер довший і збирає всі ключі.
// Він уже лежить у масиві route — рівень сам передає його твоєму коду:
// route = [
//   ${routeString}
// ];
// Не оголошуй route ще раз — просто використовуй його (спробуй console.log(route)).

// ТВОЄ ЗАВДАННЯ:
// Напиши цикл, який виконає всі команди з масиву route!

// Використовуй for...of:
// for (const cmd of route) {
//   if (cmd === 'move') move();
//   else if (cmd === 'turnRight') turnRight();
//   else if (cmd === 'turnLeft') turnLeft();
// }
`;


export default function Level5() {
    const [code, setCode] = useState(initialCode);
    const [position, setPosition] = useState(INIT_POS);
    const [collectedKeyIds, setCollectedKeyIds] = useState<string[]>([]);
    const [log, setLog] = useState<string[]>([]);
    const [showRules, setShowRules] = useState(true);
    const [isVictory, setIsVictory] = useState(false);
    const [isDefeat, setIsDefeat] = useState(false);
    const [isExecuting, setIsExecuting] = useState(false);

    const [defeatReason, setDefeatReason] = useState('');
    const { getAttempts, startAttempt, finishAttempt: finishAttemptTransaction, finishAttemptSync, storageKey, resetAt } = useGame();
    const { play: playPath, current: animStep, isAnimating, stop: stopAnim, path: animPath, index: animIndex } = usePathPlayback(150);
    const { cellSize: CELL, gap: GAP } = useResponsiveCell(56, 36);
    const attemptInProgressRef = useRef(false);
    const executionTokenRef = useRef(0);
    const attemptTokenRef = useRef<AttemptToken | null>(null);
    const pendingVerdictRef = useRef<AttemptVerdict | null>(null);
    const attempts = getAttempts(LEVEL_NUMBER);

    const dp = animStep || position;

    // Long runs are played back with the middle skipped, so once the animation ends the
    // sandbox result, not the replayed path, says which keys were collected.
    const collectedKeysNow = new Set<string>(isAnimating ? [] : collectedKeyIds);
    if (isAnimating) {
        animPath.slice(0, animIndex + 1).forEach(p => {
            if (p.keyPicked) collectedKeysNow.add(`${p.x},${p.y}`);
        });
    }

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
            else if (p.killed) message += ' [KILLED]';
            else if (p.keyPicked) message += ' [🔑 КЛЮЧ ЗІБРАНО!]';
            return message;
        });
        const combinedLog = [...consoleLog, ...pathLog];
        setLog(result.ok || !result.error
            ? combinedLog
            : [...combinedLog, `❌ ${result.errorCode ?? 'ERROR'}: ${result.error}`]);

        const reachedGoal = realGridMap[result.finalPos.y]?.[result.finalPos.x] === 'goal';
        const hasAllKeys = result.collectedKeys.length === TOTAL_KEYS;
        // The moves must be made in a loop, and the same code must follow another route too.
        const inLoop = movesInLoop(result);
        const followsRoute = followsLevelData(result, ROUTE_VARIANTS);
        const isWin = result.ok && reachedGoal && hasAllKeys && inLoop && followsRoute;
        const points = computeLevelScore(CONFIG, result.steps, newAttempts);
        pendingVerdictRef.current = isWin ? { outcome: 'victory', points, finalPos: result.finalPos } : { outcome: 'defeat' };

        playPath(path, () => {
            attemptInProgressRef.current = false;
            attemptTokenRef.current = null;
            pendingVerdictRef.current = null;
            setPosition(result.finalPos);
            setCollectedKeyIds(result.collectedKeys);

            if (!result.ok) {
                const reason = result.error ?? 'Помилка виконання.';
                setDefeatReason(reason);
                setIsVictory(false);
                setIsDefeat(true);
                finishAttemptTransaction({ token, outcome: 'defeat' });
                return;
            }

            if (reachedGoal) {
                if (hasAllKeys) {
                    if (!isWin) {
                        const reason = !inLoop
                            ? 'Умова рівня: команди з масиву route повинні виконуватися в циклі (наприклад, for...of по route або route.forEach)!'
                            : 'Умова рівня: робот має йти саме за командами з масиву route. Твій код перевірили ще й з іншим маршрутом у route — і там робот не дійшов до фінішу. Не переписуй маршрут вручну: читай команди з route.';
                        setDefeatReason(reason);
                        setLog(prev => [...prev, `⚠️ ${reason}`]);
                        setIsVictory(false);
                        setIsDefeat(true);
                        finishAttemptTransaction({ token, outcome: 'defeat' });
                        return;
                    }
                    const success = finishAttemptTransaction({ token, outcome: 'victory', points });
                    if (success) {
                        setIsVictory(true);
                        setIsDefeat(false);
                    }
                } else {
                    const reason = `Потрібно зібрати всі ключі! (${result.collectedKeys.length}/${TOTAL_KEYS})`;
                    setDefeatReason(reason);
                    setLog(prev => [...prev, `⚠️ ${reason}`]);
                    setIsDefeat(true);
                    finishAttemptTransaction({ token, outcome: 'defeat' });
                }
            } else {
                const reason = 'Робот не дістався фінішу!';
                setDefeatReason(reason);
                setLog(prev => [...prev, `⚠️ ${reason}`]);
                setIsDefeat(true);
                finishAttemptTransaction({ token, outcome: 'defeat' });
            }
        });
    };

    const executeCode = async () => {
        if (attemptInProgressRef.current || isAnimating) return;
        const preflightError = checkRunnableCode(code, ['route']);
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
        setCollectedKeyIds([]);
        setLog([]);
        setIsVictory(false);
        setIsDefeat(false);
        setDefeatReason('');

        try {
            const result = await runCodeInSandbox({
                code,
                gridMap: realGridMap,
                initialPos: INIT_POS,
                mode: 'multi-key',
                throwOnOutOfBounds: true,
                data: { route: finalRoute },
                variants: ROUTE_VARIANTS,
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
                setCollectedKeyIds(KEY_IDS);
                setIsVictory(true);
                setIsDefeat(false);
                setDefeatReason('');
                return;
            }
        }
        setPosition(INIT_POS);
        setCollectedKeyIds([]);
        setLog([]);
        setIsVictory(false);
        setIsDefeat(false);
        setDefeatReason('');
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
            editorExtra={
                <span className="bg-yellow-100 text-yellow-800 px-3 py-1 rounded font-bold">
                    Ключі: {collectedKeysNow.size}/{TOTAL_KEYS}
                </span>
            }
            showRules={showRules}
            onShowRules={() => setShowRules(true)}
            onHideRules={() => setShowRules(false)}
            rulesTitle="📜 Правила рівня 5: Масиви + Ключі"
            rulesContent={
                <ul className="list-disc pl-4 space-y-1">
                    <li>🎯 <strong>Мета:</strong> пройти маршрут, зібрати {TOTAL_KEYS} ключі 🔑 і дійти до фінішу 🎯.</li>
                    <li>⚠️ <strong>Увага:</strong> Масив <code>route</code> вже містить правильний шлях — рівень сам передає його твоєму коду.</li>
                    <li>🔍 <strong>Перевірка:</strong> код запускається ще й з іншим маршрутом у <code>route</code> — тож він має читати команди з масиву, а не повторювати їх вручну.</li>
                    <li>🤖 <strong>Завдання:</strong> Напиши цикл, який виконає команди з масиву.</li>
                    <li>👻 <strong>Вороги:</strong> Не наступай на них!</li>
                    <li>❤️ У тебе є 3 життя. Кожна невдала спроба забирає 1 життя!</li>
                </ul>
            }
            isVictory={isVictory}
            victory={{ subtitle: 'Всі ключі зібрані!', nextLevelHref: '/Levels/level6' }}
            isDefeat={isDefeat}
            defeatSubtitle={defeatReason}
            log={log}
            gridClassName="w-full md:w-[500px]"
        >
            <GridRenderer
                gridMap={realGridMap}
                cols={8}
                cellSize={CELL}
                gap={GAP}
                robotPos={dp}
                getCell={(cell, x, y) => {
                    if (cell === 'key') {
                        return { style: 'bg-yellow-100 border-yellow-300', content: collectedKeysNow.has(`${x},${y}`) ? '' : '🔑' };
                    }
                    return null;
                }}
            />
        </LevelLayout>
    );
}
