"use client";
import React from 'react';
import { getRotation } from '@/utils/robotEngine';
import type { Direction } from '@/utils/robotEngine';

export interface CellConfig {
    style: string;
    content: string;
}

interface GridRendererProps {
    gridMap: string[][];
    cols: number;
    cellSize: number;
    gap: number;
    robotPos: { x: number; y: number; dir: string };
    /** Return null/undefined to use the built-in default for that cell type. */
    getCell?: (cell: string, x: number, y: number) => CellConfig | null | undefined;
    extraContent?: React.ReactNode;
}

function builtinCell(cell: string): CellConfig {
    switch (cell) {
        case 'wall':   return { style: 'bg-gray-800 border-gray-900', content: '🧱' };
        case 'goal':   return { style: 'bg-green-400 border-green-500', content: '🎯' };
        case 'key':    return { style: 'bg-yellow-100 border-yellow-300', content: '🔑' };
        case 'enemy':  return { style: 'bg-red-100 border-red-300', content: '👾' };
        case 'door':   return { style: 'bg-orange-200 border-orange-400', content: '🚪' };
        // start/path cells – all look the same
        case 'robot':
        case 'path':
        case 'empty':  return { style: 'bg-blue-50 border-blue-100', content: '' };
        default:       return { style: 'bg-white border-gray-300', content: '' };
    }
}

const DIRECTION_LABELS: Record<string, string> = {
    up: 'вгору',
    right: 'праворуч',
    down: 'вниз',
    left: 'ліворуч',
};

function getCellLabel(cell: string, content: string): string {
    switch (cell) {
        case 'wall': return 'стіна';
        case 'goal': return 'фініш';
        case 'key': return content ? 'ключ' : 'прохід, ключ зібрано';
        case 'enemy': return 'ворог';
        case 'door': return 'двері';
        case 'robot': return 'старт';
        case 'path':
        case 'empty': return 'прохід';
        default: return 'порожня клітинка';
    }
}

export default function GridRenderer({
    gridMap, cols, cellSize: CELL, gap: GAP, robotPos: dp,
    getCell, extraContent,
}: GridRendererProps) {
    const rotation = getRotation(dp.dir as Direction);
    const directionLabel = DIRECTION_LABELS[dp.dir] ?? dp.dir;
    const gridWidth = cols * CELL + Math.max(0, cols - 1) * GAP;

    return (
        <div className="min-w-0 max-w-full">
            <div
                className="w-full max-w-full overflow-x-auto pb-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                style={{ overscrollBehaviorX: 'contain' }}
                role="region"
                aria-label="Ігрове поле, горизонтальна прокрутка"
                tabIndex={0}
            >
                <div
                    className="relative"
                    style={{ width: `${gridWidth}px` }}
                >
                    <div
                        role="grid"
                        aria-label="Ігрове поле"
                        aria-rowcount={gridMap.length}
                        aria-colcount={cols}
                        style={{ display: 'grid', gap: `${GAP}px` }}
                    >
                        {gridMap.map((row, y) => (
                            <div
                                key={`row-${y}`}
                                role="row"
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: `repeat(${cols}, ${CELL}px)`,
                                    gap: `${GAP}px`,
                                }}
                            >
                                {row.map((cell, x) => {
                                    const cfg = getCell?.(cell, x, y) ?? builtinCell(cell);
                                    const hasRobot = dp.x === x && dp.y === y;
                                    const contents = getCellLabel(cell, cfg.content);
                                    const label = `Рядок ${y + 1}, стовпець ${x + 1}: ${hasRobot ? `робот, напрямок ${directionLabel}; ` : ''}${contents}`;

                                    return (
                                        <div
                                            key={`${x}-${y}`}
                                            role="gridcell"
                                            aria-rowindex={y + 1}
                                            aria-colindex={x + 1}
                                            aria-label={label}
                                            className={`flex items-center justify-center border-2 rounded text-xs md:text-base ${cfg.style}`}
                                            style={{ width: `${CELL}px`, height: `${CELL}px` }}
                                        >
                                            <span aria-hidden="true">{cfg.content}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </div>

                    <div
                        className="absolute flex items-center justify-center z-10 pointer-events-none"
                        aria-hidden="true"
                        style={{
                            left: `${dp.x * (CELL + GAP)}px`,
                            top: `${dp.y * (CELL + GAP)}px`,
                            width: `${CELL}px`,
                            height: `${CELL}px`,
                            transition: 'left 0.15s ease-out, top 0.15s ease-out',
                        }}
                    >
                        <span
                            className="text-2xl drop-shadow-lg"
                            style={{ transform: `rotate(${rotation}deg)`, transition: 'transform 0.12s' }}
                        >
                            🤖
                        </span>
                    </div>
                </div>
            </div>
            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                Робот: рядок {dp.y + 1}, стовпець {dp.x + 1}, напрямок {directionLabel}.
            </p>
            {extraContent}
        </div>
    );
}
