"use client";
import { useState, useEffect } from 'react';

export function useResponsiveCell(desktopSize: number, mobileSize: number, gap = 4) {
    const [cellSize, setCellSize] = useState(desktopSize);
    const [isHydrated, setIsHydrated] = useState(false);

    useEffect(() => {
        setIsHydrated(true);
        const update = () => setCellSize(window.innerWidth < 768 ? mobileSize : desktopSize);
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, [desktopSize, mobileSize]);

    return { cellSize, gap, isHydrated };
}
