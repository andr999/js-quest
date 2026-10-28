// Рівень 7: Робота з DOM
"use client";
import { useState, useEffect, useRef, useCallback } from 'react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/themes/prism.css';
import { useGame, type AttemptToken, type AttemptVerdict } from '@/app/context/GameContext';
import GameHUD from '@/components/GameHUD';
import GameOverModal from '@/components/GameOverModal';
import LevelGuard from '@/components/LevelGuard';
import RulesModal from '@/components/RulesModal';
import VictoryModal from '@/components/VictoryModal';
import DefeatModal from '@/components/DefeatModal';
import ErrorBoundary from '@/components/ErrorBoundary';
import { useResponsiveCell } from '@/hooks/useResponsiveCell';
import { useSteppedExecution, type RobotGenerator } from '@/hooks/useSteppedExecution';
import { getRotation, type Direction } from '@/utils/robotEngine';
import { LEVELS_CONFIG, computeLevelScore } from '@/utils/levelsConfig';
import {
    checkRunnableCode,
    createSandboxGenerator,
    getSandboxPlaybackEvents,
    isSafeCssColor,
    runCodeInSandbox,
    type SandboxDomState,
    type SandboxEvent,
    type SandboxResult,
} from '@/utils/sandboxRunner';

const initialCode = `// 🎮 Рівень 7: Хакерська Місія - Робота з DOM!
//
// Робот застряг у кімнаті з електронними замками!
// Використовуй DOM-методи, щоб відкрити шлях.
//
// 📚 Доступні методи:
// - dom.getElementById('id') - знайти елемент за ID
// - dom.querySelector('.class') - знайти за CSS селектором
// - element.textContent = 'текст' - змінити текст
// - element.style.backgroundColor = 'колір' - змінити стиль
// - element.classList.add('клас') - додати клас
// - element.classList.remove('клас') - видалити клас
// - element.click() - "натиснути" на елемент

// 🔓 ЗАВДАННЯ 1: Розблокуй термінал
// Знайди елемент з id="terminal" і зміни його textContent на "UNLOCKED"
// Приклад: dom.getElementById('terminal').textContent = 'UNLOCKED';


// 🚪 ЗАВДАННЯ 2: Відкрий двері
// Знайди кнопку з класом .door-button і натисни на неї
// Приклад: dom.querySelector('.door-button').click();


// 🎨 ЗАВДАННЯ 3: Активуй платформу
// Знайди елемент з id="platform" і додай йому клас "active"
// Приклад: dom.getElementById('platform').classList.add('active');


// 🤖 Тепер веди робота до фінішу!

`;

const LEVEL_NUMBER = 7;
const CONFIG = LEVELS_CONFIG[LEVEL_NUMBER];
// Карта 5x5: Інтерактивне поле
const gridMap = CONFIG.gridMap;

interface DomViewState {
    terminal: { textContent: string; unlocked: boolean };
    door: { open: boolean; classList: string[] };
    platform: { classList: string[]; active: boolean };
    button: { clicked: boolean };
    /** Background colours the code set through element.style, by element id. */
    colors: Record<string, string>;
}

function createInitialDomState(): DomViewState {
    return {
        terminal: { textContent: 'LOCKED', unlocked: false },
        door: { open: false, classList: ['closed'] },
        platform: { classList: [], active: false },
        button: { clicked: false },
        colors: {},
    };
}

function toDomViewState(state: SandboxDomState): DomViewState {
    return {
        terminal: {
            textContent: state.terminalUnlocked ? 'UNLOCKED' : 'LOCKED',
            unlocked: state.terminalUnlocked,
        },
        door: {
            open: state.doorOpen,
            classList: state.doorOpen ? ['open'] : ['closed'],
        },
        platform: {
            classList: state.platformActive ? ['active'] : [],
            active: state.platformActive,
        },
        button: { clicked: state.buttonClicked },
        colors: Object.fromEntries(
            Object.entries(state.colors ?? {}).filter(([id, color]) => DOM_ELEMENT_IDS.includes(id) && isSafeCssColor(color)),
        ),
    };
}

const DOM_ELEMENT_IDS = ['terminal', 'door', 'platform', 'button'];

function directionLabel(direction: Direction): string {
    const labels: Record<Direction, string> = {
        up: 'вгору',
        right: 'праворуч',
        down: 'вниз',
        left: 'ліворуч',
    };
    return labels[direction];
}

function logLineColor(line: string): string {
    const isError =
        line.includes('❌') || line.includes('Error') ||
        line.includes('ЗАБЛОКОВАНО') || line.includes('ВИХІД ЗА МЕЖІ');
    if (isError) return 'text-red-400';
    if (line.includes('✅')) return 'text-blue-400 font-bold';
    if (line.includes('🔘')) return 'text-purple-400 font-bold';
    return 'text-green-400';
}

export default function Level7() {
    const [mounted, setMounted] = useState(false);
    const [code, setCode] = useState(initialCode);
    const [position, setPosition] = useState<{ x: number; y: number; dir: Direction }>({ x: 0, y: 0, dir: 'right' });
    const [log, setLog] = useState<string[]>([]);
    const [showRules, setShowRules] = useState(true);
    const [isVictory, setIsVictory] = useState(false);
    const [isDefeat, setIsDefeat] = useState(false);
    const [defeatReason, setDefeatReason] = useState('');
    const [stepCount, setStepCount] = useState(0);

    const [domState, setDomState] = useState<DomViewState>(createInitialDomState);

    const { isGameOver, getAttempts, startAttempt, finishAttempt: finishAttemptTransaction, finishAttemptSync, resetAt, storageKey } = useGame();
    const { cellSize: CELL, gap: GAP } = useResponsiveCell(64, 48);

    const attempts = getAttempts(LEVEL_NUMBER);
    const dp = position;
    const rotation = getRotation(dp.dir);

    useEffect(() => {
        setMounted(true);
        document.title = "Рівень 7: Хакерська Місія | JS Quest";
    }, []);

    const sandboxResultRef = useRef<SandboxResult | null>(null);
    const attemptTokenRef = useRef<AttemptToken | null>(null);
    const pendingVerdictRef = useRef<AttemptVerdict | null>(null);
    const attemptInProgressRef = useRef(false);

    const applySandboxEvent = (event: SandboxEvent) => {
        if (event.type === 'robot') {
            setPosition({ x: event.pos.x, y: event.pos.y, dir: event.pos.dir });
            setStepCount(event.step);

            const suffix = event.action === 'blocked'
                ? ' [ЗАБЛОКОВАНО]'
                : event.action === 'out-of-bounds'
                    ? ' [ВИХІД ЗА МЕЖІ]'
                    : '';
            setLog(previous => [...previous, `(${event.pos.x}, ${event.pos.y}) ${event.pos.dir}${suffix}`]);
            return;
        }

        if (event.type === 'dom') {
            setDomState(toDomViewState(event.state));
            setLog(previous => [...previous, event.message]);
            return;
        }

        if (event.type === 'console') {
            setLog(previous => [...previous, `> ${event.message}`]);
        }
    };

    const setup = async (signal: AbortSignal): Promise<RobotGenerator | null> => {
        const preflightError = checkRunnableCode(code, [], { domElementIds: DOM_ELEMENT_IDS });
        if (preflightError) {
            setLog([`⚠️ ${preflightError}`]);
            return null;
        }
        const attemptToken = startAttempt(LEVEL_NUMBER);
        if (!attemptToken) return null;
        attemptTokenRef.current = attemptToken;
        attemptInProgressRef.current = true;
        const newAttempts = attempts + 1;

        setIsVictory(false);
        setIsDefeat(false);
        setDefeatReason('');
        setStepCount(0);
        setPosition({ ...CONFIG.initialPos });
        setDomState(createInitialDomState());
        setLog([]);

        const result = await runCodeInSandbox({
            code,
            gridMap,
            initialPos: CONFIG.initialPos,
            mode: 'dom',
            throwOnOutOfBounds: true,
        });

        if (signal.aborted || attemptTokenRef.current?.attemptId !== attemptToken.attemptId) return null;
        sandboxResultRef.current = result;
        // The door counts as open however it was opened: with the button or with its classList.
        const { terminalUnlocked, doorOpen, platformActive } = result.domState;
        const isWin = result.ok
            && gridMap[result.finalPos.y]?.[result.finalPos.x] === 'goal'
            && terminalUnlocked && doorOpen && platformActive;
        pendingVerdictRef.current = isWin
            ? { outcome: 'victory', points: computeLevelScore(CONFIG, result.steps, newAttempts), finalPos: result.finalPos }
            : { outcome: 'defeat' };
        return createSandboxGenerator(getSandboxPlaybackEvents(result), applySandboxEvent);
    };

    const execution = useSteppedExecution({
        setup,
        onComplete: () => {
            attemptInProgressRef.current = false;
            const result = sandboxResultRef.current;
            const attemptToken = attemptTokenRef.current;
            const verdict = pendingVerdictRef.current;
            attemptTokenRef.current = null;
            pendingVerdictRef.current = null;
            if (!result || !attemptToken) return;

            setPosition({ x: result.finalPos.x, y: result.finalPos.y, dir: result.finalPos.dir });
            setStepCount(result.steps);
            setDomState(toDomViewState(result.domState));

            if (verdict?.outcome === 'victory') {
                const success = finishAttemptTransaction({ token: attemptToken, outcome: 'victory', points: verdict.points });
                if (success) {
                    setIsVictory(true);
                    setIsDefeat(false);
                }
                return;
            }

            const reachedGoal = gridMap[result.finalPos.y]?.[result.finalPos.x] === 'goal';
            const { terminalUnlocked, doorOpen, platformActive } = result.domState;
            const allTasksComplete = terminalUnlocked && doorOpen && platformActive;

            if (!result.ok) {
                const reason = result.error ?? 'Помилка виконання.';
                setDefeatReason(reason);
                setLog(previous => [...previous, `❌ ${reason}`]);
            } else if (!allTasksComplete) {
                const missingTasks = [
                    !terminalUnlocked && 'розблокувати термінал',
                    !doorOpen && 'відкрити двері',
                    !platformActive && 'активувати платформу',
                ].filter(Boolean).join(', ');
                const reason = `Не виконано обов'язкові DOM-завдання: ${missingTasks}.`;
                setDefeatReason(reason);
                setLog(previous => [...previous, `⚠️ ${reason}`]);
            } else if (!reachedGoal) {
                setDefeatReason('Робот не дістався фінішу!');
                setLog(previous => [...previous, '⚠️ Робот не дістався фінішу!']);
            }

            setIsDefeat(true);
            finishAttemptTransaction({ token: attemptToken, outcome: 'defeat' });
        },
        onError: (error) => {
            attemptInProgressRef.current = false;
            const attemptToken = attemptTokenRef.current;
            attemptTokenRef.current = null;
            pendingVerdictRef.current = null;
            const reason = `Runtime Error: ${error.message}`;
            setDefeatReason(reason);
            setIsDefeat(true);
            setLog(previous => [...previous, `❌ ${reason}`]);
            if (attemptToken) {
                finishAttemptTransaction({ token: attemptToken, outcome: 'defeat' });
            }
        },
        speed: 200,
    });

    const executionResetRef = useRef(execution.reset);
    useEffect(() => {
        executionResetRef.current = execution.reset;
    }, [execution.reset]);

    const getExecutionStateRef = useRef(execution.getExecutionState);
    useEffect(() => {
        getExecutionStateRef.current = execution.getExecutionState;
    }, [execution.getExecutionState]);

    const isRunning = execution.executionState === 'running';
    const isRunningRef = useRef(isRunning);
    useEffect(() => {
        isRunningRef.current = isRunning;
    }, [isRunning]);

    const resetLevel = useCallback(() => {
        const wasActive = attemptInProgressRef.current || isRunningRef.current;
        const wasPaused = getExecutionStateRef.current() === 'paused';
        const activeToken = attemptTokenRef.current;
        const verdict: AttemptVerdict = pendingVerdictRef.current ?? { outcome: 'defeat' };
        attemptTokenRef.current = null;
        attemptInProgressRef.current = false;
        pendingVerdictRef.current = null;
        if (wasActive && activeToken && verdict.outcome === 'victory') {
            const result = sandboxResultRef.current;
            executionResetRef.current();
            const success = finishAttemptTransaction({ token: activeToken, outcome: 'victory', points: verdict.points });
            if (success) {
                if (result) {
                    setPosition({ x: result.finalPos.x, y: result.finalPos.y, dir: result.finalPos.dir });
                    setStepCount(result.steps);
                    setDomState(toDomViewState(result.domState));
                } else if (verdict.finalPos) {
                    setPosition({ x: verdict.finalPos.x, y: verdict.finalPos.y, dir: verdict.finalPos.dir });
                    setDomState(toDomViewState({
                        terminalUnlocked: true,
                        doorOpen: true,
                        platformActive: true,
                        buttonClicked: true,
                    }));
                }
                setIsVictory(true);
                setIsDefeat(false);
                setDefeatReason('');
                return;
            }
        }
        setPosition({ ...CONFIG.initialPos });
        setLog([]);
        setIsVictory(false);
        setIsDefeat(false);
        setDefeatReason('');
        setDomState(createInitialDomState());
        setStepCount(0);
        sandboxResultRef.current = null;
        executionResetRef.current();
        if (wasActive && activeToken && verdict.outcome !== 'victory') {
            finishAttemptTransaction({
                token: activeToken,
                outcome: wasPaused ? 'cancelled' : verdict.outcome,
                points: verdict.points,
            });
        }
    }, [finishAttemptTransaction]);

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
        <LevelGuard level={LEVEL_NUMBER}>
        <main className="relative flex max-w-full flex-col gap-3 p-2 md:flex-row md:gap-4 md:p-4">
            {isGameOver ? (
                <GameOverModal />
            ) : isVictory ? (
                <VictoryModal
                    title="🎉 Місія виконана!"
                    subtitle="Ти освоїв роботу з DOM!"
                    description="Справжній хакер веб-сторінок! 💻🔓"
                    nextLevelHref="/finish"
                    nextLevelText="Отримати нагороду 🏆"
                    onReset={resetLevel}
                    showHomeLink={true}
                    gradient="from-purple-900 via-indigo-900 to-slate-900"
                />
            ) : isDefeat ? (
                <DefeatModal title="💀 Упс!" subtitle={defeatReason || 'Робот вийшов за межі поля або заблокований!'} onReset={resetLevel} />
            ) : showRules ? (
                <RulesModal title="🎮 Правила рівня 7: Хакерська Місія" buttonText="Почати місію" onStart={() => setShowRules(false)}>
                    <ul className="list-disc pl-4 space-y-1">
                        <li>🎯 <strong>Мета:</strong> Виконати DOM-завдання і привести робота до фінішу.</li>
                        <li>💻 <strong>Термінал:</strong> Зміни <code>textContent</code> на &quot;UNLOCKED&quot;</li>
                        <li>🚪 <strong>Двері:</strong> Знайди кнопку і виклич <code>click()</code> (або додай дверям клас &quot;open&quot;)</li>
                        <li>⬜ <strong>Платформа:</strong> Додай клас &quot;active&quot; через <code>classList.add()</code></li>
                        <li>❤️ У тебе є 3 життя. Кожна невдала спроба забирає 1 життя!</li>
                        <li>📚 <strong>DOM методи:</strong>
                            <ul className="list-disc pl-4 text-xs mt-1">
                                <li><code>{`dom.getElementById('id')`}</code></li>
                                <li><code>{`dom.querySelector('.class')`}</code></li>
                                <li><code>{`element.textContent = 'текст'`}</code></li>
                                <li><code>{`element.classList.add('клас')`}</code></li>
                                <li><code>element.click()</code></li>
                            </ul>
                        </li>
                    </ul>
                </RulesModal>
            ) : null}

            <div className="w-full min-w-0 flex-1">
                <GameHUD levelNumber={LEVEL_NUMBER} attempts={attempts} />
                <h1 className="text-center text-3xl md:text-5xl mb-4">Рівень 7</h1>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="level-7-code-editor" className="text-xl font-bold">Твій код:</label>
                    <div className="flex flex-wrap gap-2" aria-label="Стан DOM-завдань">
                        <span className={`px-2 py-1 rounded text-xs font-bold ${domState.terminal.unlocked ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                            💻 {domState.terminal.unlocked ? 'OK' : 'LOCKED'}
                        </span>
                        <span className={`px-2 py-1 rounded text-xs font-bold ${domState.door.open ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                            🚪 {domState.door.open ? 'OPEN' : 'CLOSED'}
                        </span>
                        <span className={`px-2 py-1 rounded text-xs font-bold ${domState.platform.active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                            ⬜ {domState.platform.active ? 'ACTIVE' : 'INACTIVE'}
                        </span>
                        <span className={`px-2 py-1 rounded text-xs font-bold ${domState.button.clicked ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                            🔘 {domState.button.clicked ? 'CLICKED' : 'WAITING'}
                        </span>
                    </div>
                </div>

                <div className="relative">
                    {execution.currentLine != null && (
                        <div
                            className="absolute w-full bg-yellow-200/30 pointer-events-none"
                            style={{
                                top: `${(execution.currentLine - 1) * 19.5 + 10}px`,
                                height: '19.5px',
                                zIndex: 10,
                                transition: 'top 0.1s',
                            }}
                        />
                    )}
                    {mounted && (
                        <ErrorBoundary>
                            <Editor
                                textareaId="level-7-code-editor"
                                value={code}
                                onValueChange={(nextCode) => {
                                    if (getExecutionStateRef.current() === 'paused') resetLevel();
                                    setCode(nextCode);
                                }}
                                highlight={code => Prism.highlight(code, Prism.languages.js, 'javascript')}
                                padding={10}
                                ignoreTabKey
                                style={{ fontFamily: 'monospace', backgroundColor: '#1e1e2e', color: '#cdd6f4', minHeight: '350px', minWidth: '100%', fontSize: '13px', borderRadius: '8px', lineHeight: '19.5px' }}
                                disabled={execution.isPreparing || execution.executionState === 'running'}
                            />
                        </ErrorBoundary>
                    )}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                    {execution.executionState !== 'running' ? (
                        <button
                            onClick={execution.handleRun}
                            className="px-4 py-2 bg-purple-700 text-white rounded hover:bg-purple-800 transition font-medium disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={execution.isPreparing || isVictory || isDefeat || showRules}
                        >
                            {execution.isPreparing ? 'Підготовка…' : 'Запустити 🚀'}
                        </button>
                    ) : (
                        <button onClick={execution.pause} className="px-4 py-2 bg-amber-800 text-white rounded hover:bg-amber-900 transition font-medium disabled:cursor-not-allowed disabled:opacity-50" disabled={execution.isPreparing || isVictory || isDefeat || showRules}>Пауза ⏸️</button>
                    )}
                    <button onClick={execution.handleStep} className="px-4 py-2 bg-indigo-700 text-white rounded hover:bg-indigo-800 transition font-medium disabled:cursor-not-allowed disabled:opacity-50" disabled={execution.isPreparing || execution.executionState === 'running' || isVictory || isDefeat || showRules}>Крок 👣</button>
                    <button onClick={resetLevel} className="px-4 py-2 bg-slate-700 text-white rounded hover:bg-slate-800 transition font-medium disabled:cursor-not-allowed disabled:opacity-50" disabled={execution.isPreparing || showRules}>Скинути 🔄</button>
                    <button onClick={() => setShowRules(true)} disabled={execution.isPreparing || execution.executionState !== 'idle' || isVictory || isDefeat || showRules} className="px-4 py-2 bg-blue-700 text-white rounded hover:bg-blue-800 transition font-medium disabled:cursor-not-allowed disabled:opacity-50" >Правила 📜</button>
                </div>

                <div className="mt-4 bg-gray-900 p-3 rounded-lg font-mono text-sm max-h-48 overflow-y-auto">
                    <h3 id="level-7-log-title" className="font-semibold text-white mb-2">Консоль: {stepCount !== undefined && `(кроків: ${stepCount})`}</h3>
                    <div className="whitespace-pre-wrap" role="log" aria-live="polite" aria-labelledby="level-7-log-title">
                        {log.map((line, i) => (
                            <div key={i} className={logLineColor(line)}>
                                {line}
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div className="w-full min-w-0 md:w-[350px]">
                <h2 id="level-7-grid-title" className="mb-2 text-lg font-bold md:text-xl">Ігрове поле:</h2>
                <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                    Робот: рядок {dp.y + 1}, стовпець {dp.x + 1}, напрямок {directionLabel(dp.dir)}. Кроків: {stepCount}.
                </p>
                <div className="max-w-full overflow-x-auto pb-1">
                    <div className="relative w-max">
                        <div
                            className="grid w-max grid-cols-5"
                            style={{ gap: `${GAP}px` }}
                            role="grid"
                            aria-labelledby="level-7-grid-title"
                            aria-rowcount={gridMap.length}
                            aria-colcount={gridMap[0]?.length ?? 0}
                        >
                            {gridMap.map((row, y) => (
                                <div key={`row-${y}`} role="row" className="contents">
                                    {row.map((cell, x) => {
                                        let cellStyle = 'bg-gray-100 border-gray-300';
                                        let content = '';
                                        let extraInfo = '';
                                        let cellLabel = 'прохід';
                                        if (cell === 'wall') { cellStyle = 'bg-gray-800 border-gray-900'; content = '🧱'; cellLabel = 'стіна'; }
                                        else if (cell === 'goal') { cellStyle = 'bg-green-400 border-green-500'; content = '🎯'; cellLabel = 'фініш'; }
                                        else if (cell === 'path') { cellStyle = 'bg-blue-50 border-blue-100'; }
                                        else if (cell === 'terminal') { cellStyle = domState.terminal.unlocked ? 'bg-green-200 border-green-400' : 'bg-yellow-200 border-yellow-400'; content = '💻'; extraInfo = domState.terminal.unlocked ? '✓' : '🔒'; cellLabel = `термінал, ${domState.terminal.unlocked ? 'розблокований' : 'заблокований'}`; }
                                        else if (cell === 'door') { cellStyle = domState.door.open ? 'bg-green-200 border-green-400' : 'bg-red-200 border-red-400'; content = '🚪'; extraInfo = domState.door.open ? '✓' : '✕'; cellLabel = `двері, ${domState.door.open ? 'відкриті' : 'зачинені'}`; }
                                        else if (cell === 'button') { cellStyle = domState.button.clicked ? 'bg-green-200 border-green-400' : 'bg-purple-200 border-purple-400'; content = '🔘'; cellLabel = `кнопка, ${domState.button.clicked ? 'натиснута' : 'не натиснута'}`; }
                                        else if (cell === 'platform') { cellStyle = domState.platform.active ? 'bg-green-200 border-green-400' : 'bg-gray-300 border-gray-400'; content = domState.platform.active ? '🟩' : '⬜'; cellLabel = `платформа, ${domState.platform.active ? 'активна' : 'неактивна'}`; }
                                        else if (cell === 'robot') { cellStyle = 'bg-blue-100 border-blue-300'; cellLabel = 'старт'; }

                                        const robotIsHere = dp.x === x && dp.y === y;
                                        // element.style.backgroundColor set by the code paints that element's cell.
                                        const customColor = DOM_ELEMENT_IDS.includes(cell) ? domState.colors[cell] : undefined;
                                        return (
                                            <div
                                                key={`${x}-${y}`}
                                                role="gridcell"
                                                aria-current={robotIsHere ? 'location' : undefined}
                                                aria-label={`Рядок ${y + 1}, стовпець ${x + 1}: ${cellLabel}${robotIsHere ? `; робот дивиться ${directionLabel(dp.dir)}` : ''}`}
                                                className={`relative flex flex-col items-center justify-center rounded border-2 text-sm md:text-base ${cellStyle}`}
                                                style={{ width: `${CELL}px`, height: `${CELL}px`, ...(customColor ? { backgroundColor: customColor } : {}) }}
                                            >
                                                <span className="text-xl" aria-hidden="true">{content}</span>
                                                {extraInfo && <span aria-hidden="true" className="absolute bottom-0 right-0 rounded bg-black/50 px-1 text-xs text-white">{extraInfo}</span>}
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}
                        </div>
                        <div
                            className="pointer-events-none absolute z-10 flex items-center justify-center"
                            aria-hidden="true"
                            style={{
                                left: `${dp.x * (CELL + GAP)}px`,
                                top: `${dp.y * (CELL + GAP)}px`,
                                width: `${CELL}px`, height: `${CELL}px`,
                                transition: 'left 0.18s ease-out, top 0.18s ease-out',
                            }}
                        >
                            <span className="text-2xl drop-shadow-lg" style={{ transform: `rotate(${rotation}deg)`, transition: 'transform 0.12s' }}>🤖</span>
                        </div>
                    </div>
                </div>

                <div className="mt-4 rounded-lg bg-gray-100 p-3 text-sm">
                    <h3 className="mb-2 font-bold">Легенда:</h3>
                    <div className="grid grid-cols-1 gap-1 break-words text-xs sm:grid-cols-2">
                        <span>{`💻 Термінал (id="terminal")`}</span>
                        <span>{`🚪 Двері (id="door")`}</span>
                        <span>🔘 Кнопка (.door-button)</span>
                        <span>{`⬜ Платформа (id="platform")`}</span>
                    </div>
                </div>
            </div>
        </main>
        </LevelGuard>
    );
}
