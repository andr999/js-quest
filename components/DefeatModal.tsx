import React from 'react';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface DefeatModalProps {
  title?: string;
  subtitle?: string;
  onReset: () => void;
}

export default function DefeatModal({
  title = '💀 Поразка!',
  subtitle,
  onReset,
}: DefeatModalProps) {
  const modalRef = useFocusTrap<HTMLDivElement>();

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center backdrop-blur-sm p-3 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="defeat-modal-title"
    >
      <div
        ref={modalRef}
        className="bg-gradient-to-br from-rose-950 via-red-950 to-slate-900 border border-red-800/60 rounded-2xl p-5 sm:p-8 max-w-md w-full max-h-[calc(100vh-1.5rem)] sm:max-h-[90vh] overflow-y-auto my-auto shadow-2xl text-white text-center animate-fade-in"
      >
        <h2 id="defeat-modal-title" className="text-2xl sm:text-4xl font-bold mb-2 sm:mb-4 text-white drop-shadow-sm">{title}</h2>
        {subtitle && <p className="text-base sm:text-xl mb-3 sm:mb-6 text-rose-100 font-medium">{subtitle}</p>}
        <div className="flex flex-col gap-2.5 sm:gap-3">
          <button
            onClick={onReset}
            className="px-5 py-2.5 sm:px-6 sm:py-3 bg-red-800 text-white font-semibold rounded-lg hover:bg-red-700 transition border border-red-600 shadow focus:outline-none focus:ring-2 focus:ring-red-400 text-sm sm:text-base"
          >
            Спробувати ще раз
          </button>
        </div>
      </div>
    </div>
  );
}
