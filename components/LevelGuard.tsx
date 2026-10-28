"use client";
import { useGame } from "@/app/context/GameContext";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface LevelGuardProps {
    level: number;
    children: React.ReactNode;
}

export default function LevelGuard({ level, children }: LevelGuardProps) {
    const { isLevelUnlocked, isHydrated } = useGame();
    const router = useRouter();
    const [checked, setChecked] = useState(false);

    useEffect(() => {
        if (!isHydrated) return;
        const unlocked = isLevelUnlocked(level);
        if (!unlocked) {
            setChecked(false);
            router.replace("/");
        } else {
            setChecked(true);
        }
    }, [isHydrated, isLevelUnlocked, level, router]);

    if (!checked) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center gap-4">
                <div className="animate-spin text-4xl">⏳</div>
                <p className="text-gray-500">Перевірка доступу...</p>
            </div>
        );
    }

    return <>{children}</>;
}
