"use client";
import { useState, useEffect, useCallback, useRef } from 'react';
import type { RobotPos } from '@/utils/robotEngine';

export function usePathPlayback(speed = 150) {
    const [path, setPath] = useState<RobotPos[]>([]);
    const [index, setIndex] = useState(-1);
    const [isAnimating, setIsAnimating] = useState(false);
    const cbRef = useRef<(() => void) | null>(null);

    const play = useCallback((newPath: RobotPos[], onDone?: () => void) => {
        if (!newPath || newPath.length === 0) {
            onDone?.();
            return;
        }
        setPath(newPath);
        setIndex(0);
        setIsAnimating(true);
        cbRef.current = onDone ?? null;
    }, []);

    useEffect(() => {
        if (!isAnimating || index < 0) return;
        if (index >= path.length - 1) {
            setIsAnimating(false);
            setIndex(-1);
            cbRef.current?.();
            cbRef.current = null;
            return;
        }
        const t = setTimeout(() => setIndex(i => i + 1), speed);
        return () => clearTimeout(t);
    }, [isAnimating, index, path.length, speed]);

    const current = isAnimating && index >= 0 && index < path.length ? path[index] : null;

    const stop = useCallback(() => {
        setIsAnimating(false);
        setIndex(-1);
        setPath([]);
        cbRef.current = null;
    }, []);

    return { play, current, isAnimating, stop, path, index };
}
