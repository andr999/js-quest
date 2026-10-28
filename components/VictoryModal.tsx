import Link from 'next/link';
import React from 'react';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface VictoryModalProps {
  title?: string;
  subtitle: string;
  description?: string;
  nextLevelHref?: string;
  nextLevelText?: string;
  onReset: () => void;
  showHomeLink?: boolean;
  gradient?: string;
}

export default function VictoryModal({
  title = '🎉 Перемога!',
  subtitle,
  description,
  nextLevelHref,
  nextLevelText = 'Наступний рівень →',
  onReset,
  showHomeLink = false,
  gradient = 'from-emerald-900 via-teal-900 to-slate-900',
}: VictoryModalProps) {
  const modalRef = useFocusTrap<HTMLDivElement>();

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center backdrop-blur-sm p-3 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="victory-modal-title"
    >
      <div
        ref={modalRef}
        className={`bg-gradient-to-br ${gradient} border border-emerald-700/50 rounded-2xl p-5 sm:p-8 max-w-md w-full max-h-[calc(100vh-1.5rem)] sm:max-h-[90vh] overflow-y-auto my-auto shadow-2xl text-white text-center animate-fade-in`}
      >
        <h2 id="victory-modal-title" className="text-2xl sm:text-4xl font-bold mb-2 sm:mb-4">{title}</h2>
        <p className="text-base sm:text-xl mb-1 sm:mb-2 text-emerald-100">{subtitle}</p>
        {description && <p className="text-xs sm:text-sm mb-3 sm:mb-6 text-slate-200">{description}</p>}
        <div className="flex flex-col gap-2.5 sm:gap-3">
          {nextLevelHref && (
            <Link
              href={nextLevelHref}
              className="px-5 py-2.5 sm:px-6 sm:py-3 bg-white text-emerald-950 font-bold rounded-lg hover:bg-emerald-50 transition shadow text-sm sm:text-base"
            >
              {nextLevelText}
            </Link>
          )}
          <button
            onClick={onReset}
            className="px-5 py-2.5 sm:px-6 sm:py-3 bg-emerald-800 text-white font-semibold rounded-lg hover:bg-emerald-700 transition border border-emerald-600 text-sm sm:text-base"
          >
            Пройти знову
          </button>
          {showHomeLink && (
            <Link
              href="/"
              className="px-5 py-2.5 sm:px-6 sm:py-3 bg-transparent border-2 border-white text-white font-semibold rounded-lg hover:bg-white hover:text-emerald-950 transition text-sm sm:text-base"
            >
              На головну
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
