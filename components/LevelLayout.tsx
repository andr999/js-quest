"use client";
import React, { useState, useEffect, useRef } from 'react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/themes/prism.css';
import GameHUD from '@/components/GameHUD';
import GameOverModal from '@/components/GameOverModal';
import LevelGuard from '@/components/LevelGuard';
import RulesModal from '@/components/RulesModal';
import VictoryModal from '@/components/VictoryModal';
import DefeatModal from '@/components/DefeatModal';
import ErrorBoundary from '@/components/ErrorBoundary';
import { useGame } from '@/app/context/GameContext';

export interface VictoryConfig {
    subtitle: string;
    description?: string;
    nextLevelHref?: string;
    nextLevelText?: string;
    showHomeLink?: boolean;
}

export interface LevelLayoutProps {
    // Core
    level: number;
    attempts: number;

    // Editor
    code: string;
    onCodeChange: (code: string) => void;
    editorDisabled?: boolean;
    editorDark?: boolean;
    currentLine?: number | null;
    editorExtra?: React.ReactNode;

    // Buttons
    onRun: () => void;
    onReset: () => void;
    resetDisabled?: boolean;
    isRunning?: boolean;
    runDisabled?: boolean;
    onPause?: () => void;
    onStep?: () => void;
    stepDisabled?: boolean;

    // Rules modal
    showRules: boolean;
    onShowRules: () => void;
    onHideRules: () => void;
    rulesTitle: string;
    rulesContent: React.ReactNode;

    // Victory modal
    isVictory: boolean;
    victory: VictoryConfig;

    // Defeat modal
    isDefeat: boolean;
    defeatSubtitle?: string;

    // Log / console
    log: string[];
    stepCount?: number;
    logDark?: boolean;
    logColorFn?: (line: string) => string;

    // Grid panel
    gridClassName?: string;

    // Grid content
    children: React.ReactNode;
}

function logColor(line: string, dark: boolean): string {
    const isError =
        line.includes('Error') || line.includes('WALL') || line.includes('OUT') ||
        line.includes('DEAD') || line.includes('KILLED') || line.includes('ЗАЧИНЕНО') ||
        line.includes('ВИХІД') || line.includes('МЕЖІ') || line.includes('СТІНА') ||
        line.includes('ЗНИЩЕНО') || line.includes('❌');
    const isKey = line.includes('КЛЮЧ') || line.includes('🔑');
    const isDoor = line.includes('ДВЕРІ') || line.includes('🚪');

    if (dark) {
        if (isError) return 'text-red-400';
        if (isKey) return 'text-yellow-400 font-bold';
        if (isDoor) return 'text-blue-400 font-bold';
        return 'text-green-400';
    }
    if (isError) return 'text-red-600';
    if (isKey) return 'text-yellow-600 font-bold';
    if (isDoor) return 'text-blue-600 font-bold';
    return 'text-gray-800';
}

const LIGHT_EDITOR: React.CSSProperties = {
    fontFamily: 'monospace',
    backgroundColor: '#f5f5f5',
    minHeight: '250px',
    fontSize: '14px',
    lineHeight: '19.5px',
};

const DARK_EDITOR: React.CSSProperties = {
    fontFamily: 'monospace',
    backgroundColor: '#1e1e2e',
    color: '#cdd6f4',
    minHeight: '250px',
    fontSize: '13px',
    borderRadius: '8px',
    lineHeight: '19.5px',
};

export default function LevelLayout({
    level, attempts,
    code, onCodeChange, editorDisabled, editorDark, currentLine, editorExtra,
    onRun, onReset, resetDisabled, isRunning, runDisabled, onPause, onStep, stepDisabled,
    showRules, onShowRules, onHideRules, rulesTitle, rulesContent,
    isVictory, victory,
    isDefeat, defeatSubtitle,
    log, stepCount, logDark, logColorFn,
    gridClassName = 'w-full md:w-[400px]',
    children,
}: LevelLayoutProps) {
    const { isGameOver } = useGame();
    const [mounted, setMounted] = useState(false);
    useEffect(() => { setMounted(true); }, []);
    useEffect(() => {
        document.title = `Рівень ${level} | JS Quest`;
    }, [level]);

    const colorFn = logColorFn ?? ((line: string) => logColor(line, !!logDark));
    const editorId = `level-${level}-code-editor`;
    const logTitleId = `level-${level}-log-title`;

    return (
        <LevelGuard level={level}>
            <main className="relative flex flex-col md:flex-row gap-3 md:gap-4 p-2 md:p-4">
                {isGameOver ? (
                    <GameOverModal />
                ) : isVictory ? (
                    <VictoryModal
                        subtitle={victory.subtitle}
                        description={victory.description}
                        nextLevelHref={victory.nextLevelHref}
                        nextLevelText={victory.nextLevelText}
                        onReset={onReset}
                        showHomeLink={victory.showHomeLink}
                    />
                ) : isDefeat ? (
                    <DefeatModal subtitle={defeatSubtitle} onReset={onReset} />
                ) : showRules ? (
                    <RulesModal title={rulesTitle} onStart={onHideRules}>
                        {rulesContent}
                    </RulesModal>
                ) : null}

                {/* Editor panel */}
                <div className="min-w-0 flex-1">
                    <GameHUD levelNumber={level} attempts={attempts} />
                    <h1 className="text-center text-3xl md:text-5xl mb-4">Рівень {level}</h1>

                    {editorExtra ? (
                        <div className="flex justify-between items-center mb-2">
                            <label htmlFor={editorId} className="text-xl font-bold">Твій код:</label>
                            {editorExtra}
                        </div>
                    ) : (
                        <label htmlFor={editorId} className="block text-xl font-bold mb-2">Твій код:</label>
                    )}

                    <div className="relative">
                        {currentLine != null && (
                            <div
                                className="absolute w-full bg-yellow-200/30 pointer-events-none"
                                style={{
                                    top: `${(currentLine - 1) * 19.5 + 10}px`,
                                    height: '19.5px',
                                    zIndex: 10,
                                    transition: 'top 0.1s',
                                }}
                            />
                        )}
                        {mounted && (
                            <ErrorBoundary>
                                <Editor
                                    value={code}
                                    onValueChange={onCodeChange}
                                    highlight={c => Prism.highlight(c, Prism.languages.js, 'javascript')}
                                    padding={10}
                                    style={editorDark ? DARK_EDITOR : LIGHT_EDITOR}
                                    disabled={editorDisabled}
                                    textareaId={editorId}
                                    ignoreTabKey
                                />
                            </ErrorBoundary>
                        )}
                    </div>

                    <div className="flex gap-2 mt-4 flex-wrap">
                        {isRunning && onPause ? (
                            <button
                                onClick={onPause}
                                disabled={isVictory || isDefeat || showRules}
                                className="px-4 py-2 bg-amber-800 text-white rounded hover:bg-amber-900 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Пауза ⏸️
                            </button>
                        ) : (
                            <button
                                onClick={onRun}
                                disabled={runDisabled || isVictory || isDefeat || showRules}
                                className="px-4 py-2 bg-emerald-700 text-white rounded hover:bg-emerald-800 transition font-medium disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-emerald-700"
                            >
                                Запустити ▶️
                            </button>
                        )}
                        {onStep && (
                            <button
                                onClick={onStep}
                                disabled={stepDisabled || isVictory || isDefeat || showRules}
                                className="px-4 py-2 bg-blue-700 text-white rounded hover:bg-blue-800 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Крок 👣
                            </button>
                        )}
                        <button
                            onClick={onReset}
                            disabled={resetDisabled || showRules}
                            className="px-4 py-2 bg-slate-700 text-white rounded hover:bg-slate-800 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Скинути 🔄
                        </button>
                        <button
                            onClick={onShowRules}
                            disabled={isRunning || runDisabled || editorDisabled || isVictory || isDefeat || showRules}
                            className="px-4 py-2 bg-indigo-700 text-white rounded hover:bg-indigo-800 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Правила 📜
                        </button>
                    </div>

                    <section className={`mt-4 p-3 rounded-lg font-mono text-sm max-h-48 overflow-y-auto ${logDark ? 'bg-gray-900' : 'bg-gray-100'}`}>
                        <h3 id={logTitleId} className={`font-semibold mb-1 ${logDark ? 'text-white' : ''}`}>
                            {stepCount != null ? `Консоль: (кроків: ${stepCount})` : 'Журнал:'}
                        </h3>
                        <div
                            className="whitespace-pre-wrap"
                            role="log"
                            aria-live="polite"
                            aria-relevant="additions text"
                            aria-labelledby={logTitleId}
                        >
                            {log.map((line, i) => (
                                <div key={i} className={colorFn(line)}>{line}</div>
                            ))}
                        </div>
                    </section>
                </div>

                {/* Grid panel */}
                <div className={`min-w-0 max-w-full ${gridClassName}`}>
                    <h2 className="text-lg md:text-xl font-bold mb-2">Поле гри:</h2>
                    {children}
                </div>
            </main>
        </LevelGuard>
    );
}
