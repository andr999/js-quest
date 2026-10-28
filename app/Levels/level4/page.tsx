// Рівень 4: Створення функцій
"use client";
import { useCallback, useState, useRef, useEffect } from 'react';
import { useGame, type AttemptToken, type AttemptVerdict } from '@/app/context/GameContext';
import LevelLayout from '@/components/LevelLayout';
import GridRenderer from '@/components/GridRenderer';
import { useResponsiveCell } from '@/hooks/useResponsiveCell';
import { useSteppedExecution, type RobotGenerator } from '@/hooks/useSteppedExecution';
import { LEVELS_CONFIG, computeLevelScore } from '@/utils/levelsConfig';
import type { CellConfig } from '@/components/GridRenderer';
import {
    checkRunnableCode,
    createSandboxGenerator,
    getSandboxPlaybackEvents,
    runCodeInSandbox,
    type SandboxEvent,
    type SandboxResult,
} from '@/utils/sandboxRunner';


const initialCode = `// Напиши свій код тут!
// ⭐ Рівень 4: Вчимося створювати ВЛАСНІ ФУНКЦІЇ!

// Доступні команди: move(), turnLeft(), turnRight()
// Умовні функції: canMove(), isWallAhead(), isGoalReached(), hasKey()

// 💡 ЯК СТВОРИТИ ФУНКЦІЮ:
// function назваФункції(параметр) {
//   // код функції тут
// }

// 🎯 ЗАВДАННЯ:
// 1. Обійди ворогів 👾
// 2. Знайди ключ 🔑
// 3. Відкрий двері 🚪
// 4. Дійди до фінішу 🎯
// 5. Обов'язково створи ВЛАСНУ функцію з командами робота і використай її!

// Приклад зручної функції з параметром (робить steps кроків вперед):
// function go(steps) {
//   for (let i = 0; i < steps; i++) {
//     move();
//   }
// }
// Тоді замість багатьох move() можна писати:
// go(2);
// turnRight();

// Твій код тут:
`;

const LEVEL_NUMBER = 4;
const CONFIG = LEVELS_CONFIG[LEVEL_NUMBER];
const gridMap = CONFIG.gridMap;
const INIT_POS = CONFIG.initialPos;

/** The level's rule: at least half of the robot's commands come from the learner's own functions. */
function usesOwnFunctionEnough(result: SandboxResult): boolean {
    const userFnActions = result.userFunctionRobotActions ?? 0;
    return userFnActions >= 1 && userFnActions * 2 >= result.steps;
}

export default function Level4() {
    const [code, setCode] = useState(initialCode);
    const [position, setPosition] = useState(INIT_POS);
    const [log, setLog] = useState<string[]>([]);
    const [showRules, setShowRules] = useState(true);
    const [isVictory, setIsVictory] = useState(false);
    const [isDefeat, setIsDefeat] = useState(false);
    const [stepCount, setStepCount] = useState(0);
    const [hasKeyState, setHasKeyState] = useState(false);
    const [doorOpenedState, setDoorOpenedState] = useState(false);

    const [defeatReason, setDefeatReason] = useState('');
    const { getAttempts, startAttempt, finishAttempt: finishAttemptTransaction, finishAttemptSync, storageKey, resetAt } = useGame();
    const { cellSize: CELL, gap: GAP } = useResponsiveCell(48, 36);

    const attempts = getAttempts(LEVEL_NUMBER);
    const resultRef = useRef<SandboxResult | null>(null);
    const attemptTokenRef = useRef<AttemptToken | null>(null);
    const pendingVerdictRef = useRef<AttemptVerdict | null>(null);
    const attemptInProgressRef = useRef(false);

    const applyEvent = (event: SandboxEvent) => {
        if (event.type === 'robot') {
            setPosition({ ...event.pos });
            setStepCount(event.step);
            if (event.action === 'key') setHasKeyState(true);
            if (event.action === 'door') setDoorOpenedState(true);
            const suffix = event.message ? ` [${event.message}]` : '';
            setLog(prev => [...prev, `(${event.pos.x}, ${event.pos.y}) ${event.pos.dir}${suffix}`]);
        } else if (event.type === 'console') {
            setLog(prev => [...prev, event.message]);
        }
    };

    const setup = async (signal: AbortSignal): Promise<RobotGenerator | null> => {
        const preflightError = checkRunnableCode(code);
        if (preflightError) {
            setLog([`⚠️ ${preflightError}`]);
            return null;
        }
        const attemptToken = startAttempt(LEVEL_NUMBER);
        if (!attemptToken) return null;
        attemptTokenRef.current = attemptToken;
        attemptInProgressRef.current = true;
        const newAttempts = attempts + 1;
        setHasKeyState(false);
        setDoorOpenedState(false);
        setIsVictory(false);
        setIsDefeat(false);
        setDefeatReason('');
        setLog([]);
        setStepCount(0);
        setPosition(INIT_POS);

        const result = await runCodeInSandbox({
            code,
            gridMap,
            initialPos: INIT_POS,
            mode: 'key-door',
            throwOnOutOfBounds: true,
        });
        if (signal.aborted || attemptTokenRef.current?.attemptId !== attemptToken.attemptId) return null;
        resultRef.current = result;
        const userFnActions = result.userFunctionRobotActions ?? 0;
        const isWin = result.ok
            && gridMap[result.finalPos.y]?.[result.finalPos.x] === 'goal'
            && result.hasKey && result.doorOpened
            // Decided from the run, by the rule shown to the player: at least half of the robot's
            // commands are made while a function written by the learner is executing.
            && usesOwnFunctionEnough(result);
        pendingVerdictRef.current = isWin
            ? { outcome: 'victory', points: computeLevelScore(CONFIG, result.steps, newAttempts), finalPos: result.finalPos }
            : { outcome: 'defeat' };
        return createSandboxGenerator(getSandboxPlaybackEvents(result), applyEvent);
    };

    const execution = useSteppedExecution({
        setup,
        onComplete: () => {
            attemptInProgressRef.current = false;
            const result = resultRef.current;
            const attemptToken = attemptTokenRef.current;
            const verdict = pendingVerdictRef.current;
            attemptTokenRef.current = null;
            pendingVerdictRef.current = null;
            if (!result || !attemptToken) return;
            setPosition({ ...result.finalPos });
            setStepCount(result.steps);
            setHasKeyState(result.hasKey);
            setDoorOpenedState(result.doorOpened);

            if (!result.ok) {
                const reason = result.error ?? 'Помилка виконання.';
                setDefeatReason(reason);
                setLog(prev => [...prev, `❌ ${reason}`]);
                setIsDefeat(true);
                finishAttemptTransaction({ token: attemptToken, outcome: 'defeat' });
                return;
            }

            if (verdict?.outcome === 'victory') {
                const success = finishAttemptTransaction({ token: attemptToken, outcome: 'victory', points: verdict.points });
                if (success) {
                    setIsVictory(true);
                    setIsDefeat(false);
                }
                return;
            }

            const reachedGoal = gridMap[result.finalPos.y]?.[result.finalPos.x] === 'goal';
            const hasKeyAndDoor = result.hasKey && result.doorOpened;
            const userFnActions = result.userFunctionRobotActions ?? 0;
            const reason = reachedGoal && hasKeyAndDoor
                ? `Умова рівня: щонайменше половину команд робота має виконати твоя власна функція (зараз ${userFnActions} з ${result.steps}). Наприклад, винеси кроки вперед у функцію з параметром.`
                : reachedGoal
                    ? 'Спочатку знайди ключ і пройди крізь двері.'
                    : 'Робот не дістався фінішу!';
            setDefeatReason(reason);
            setLog(prev => [...prev, `⚠️ ${reason}`]);
            setIsDefeat(true);
            finishAttemptTransaction({ token: attemptToken, outcome: 'defeat' });
        },
        onError: (err) => {
            attemptInProgressRef.current = false;
            const attemptToken = attemptTokenRef.current;
            attemptTokenRef.current = null;
            pendingVerdictRef.current = null;
            const reason = `Runtime Error: ${err.message}`;
            setDefeatReason(reason);
            setIsDefeat(true);
            setLog(prev => [...prev, `❌ ${reason}`]);
            if (attemptToken) {
                finishAttemptTransaction({ token: attemptToken, outcome: 'defeat' });
            }
        },
        speed: 200,
    });

    const resetExecution = execution.reset;
    const getExecutionState = execution.getExecutionState;

    const resetLevel = useCallback(() => {
        const wasActive = attemptInProgressRef.current;
        const wasPaused = getExecutionState() === 'paused';
        const activeToken = attemptTokenRef.current;
        const verdict: AttemptVerdict = pendingVerdictRef.current ?? { outcome: 'defeat' };
        attemptTokenRef.current = null;
        attemptInProgressRef.current = false;
        pendingVerdictRef.current = null;
        if (wasActive && activeToken && verdict.outcome === 'victory') {
            const result = resultRef.current;
            resetExecution();
            const success = finishAttemptTransaction({ token: activeToken, outcome: 'victory', points: verdict.points });
            if (success) {
                if (result) {
                    setPosition({ ...result.finalPos });
                    setStepCount(result.steps);
                    setHasKeyState(result.hasKey);
                    setDoorOpenedState(result.doorOpened);
                } else {
                    if (verdict.finalPos) setPosition({ ...verdict.finalPos });
                    setHasKeyState(true);
                    setDoorOpenedState(true);
                }
                setIsVictory(true);
                setIsDefeat(false);
                setDefeatReason('');
                return;
            }
        }
        setPosition(INIT_POS);
        setLog([]);
        setIsVictory(false);
        setIsDefeat(false);
        setDefeatReason('');
        setStepCount(0);
        setHasKeyState(false);
        setDoorOpenedState(false);
        resultRef.current = null;
        resetExecution();
        if (wasActive && activeToken && verdict.outcome !== 'victory') {
            finishAttemptTransaction({
                token: activeToken,
                outcome: wasPaused ? 'cancelled' : verdict.outcome,
                points: verdict.points,
            });
        }
    }, [finishAttemptTransaction, getExecutionState, resetExecution]);

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

    const getCellConfig = (cell: string): CellConfig | null => {
        if (cell === 'key') return { style: 'bg-yellow-100 border-yellow-300', content: hasKeyState ? '' : '🔑' };
        if (cell === 'door') return {
            style: doorOpenedState ? 'bg-green-200 border-green-400' : 'bg-orange-200 border-orange-400',
            content: '🚪',
        };
        return null;
    };

    return (
        <LevelLayout
            level={LEVEL_NUMBER}
            attempts={attempts}
            code={code}
            onCodeChange={(nextCode) => {
                if (getExecutionState() === 'paused') resetLevel();
                setCode(nextCode);
            }}
            editorDisabled={execution.isPreparing || execution.executionState === 'running'}
            editorDark
            currentLine={execution.currentLine}
            editorExtra={
                <span className={`px-3 py-1 rounded font-bold ${hasKeyState ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                    {hasKeyState ? '🔑 Ключ є!' : '🔒 Ключ не знайдено'}
                </span>
            }
            onRun={execution.handleRun}
            runDisabled={execution.isPreparing}
            onReset={resetLevel}
            resetDisabled={execution.isPreparing}
            isRunning={execution.executionState === 'running'}
            onPause={execution.pause}
            onStep={execution.handleStep}
            stepDisabled={execution.isPreparing || execution.executionState === 'running'}
            showRules={showRules}
            onShowRules={() => setShowRules(true)}
            onHideRules={() => setShowRules(false)}
            rulesTitle="📜 Правила рівня 4: Власні функції"
            rulesContent={
                <ul className="list-disc pl-4 space-y-1">
                    <li>🎯 <strong>Мета:</strong> обійди ворогів, знайди ключ, відкрий двері, дійди до фінішу.</li>
                    <li>⌨️ Команди: <code>move()</code>, <code>turnRight()</code>, <code>turnLeft()</code></li>
                    <li>🧠 Умовні: <code>canMove()</code>, <code>isWallAhead()</code>, <code>isGoalReached()</code>, <code>hasKey()</code></li>
                    <li>⚠️ <strong>Умова рівня:</strong> створи <strong>власну функцію</strong> з командами робота: щонайменше <strong>половину команд</strong> має виконати вона (наприклад, усі кроки вперед), інакше спроба не зарахується.</li>
                    <li>👾 <strong>Вороги</strong> вбивають при наступі!</li>
                    <li>🔑 Знайди <strong>ключ</strong> щоб відкрити 🚪 <strong>двері</strong>.</li>
                    <li>❤️ У тебе є 3 життя.</li>
                </ul>
            }
            isVictory={isVictory}
            victory={{
                subtitle: 'Ви пройшли рівень 4!',
                description: 'Функції створені, двері відкрито! 🔑🚪✨',
                nextLevelHref: '/Levels/level5',
                showHomeLink: true,
            }}
            isDefeat={isDefeat}
            defeatSubtitle={defeatReason}
            log={log}
            stepCount={stepCount}
            logDark
            gridClassName="w-full md:w-[500px]"
        >
            <GridRenderer
                gridMap={gridMap}
                cols={8}
                cellSize={CELL}
                gap={GAP}
                robotPos={position}
                getCell={getCellConfig}
            />
        </LevelLayout>
    );
}
