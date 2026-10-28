import React from 'react';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface RulesModalProps {
  title: string;
  children: React.ReactNode;
  buttonText?: string;
  onStart: () => void;
}

export default function RulesModal({ title, children, buttonText = 'Почати гру', onStart }: RulesModalProps) {
  const modalRef = useFocusTrap<HTMLDivElement>();

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rules-modal-title"
    >
      <div
        ref={modalRef}
        className="bg-white rounded-xl p-6 max-w-2xl shadow-xl text-sm md:text-base max-h-[90vh] overflow-y-auto"
      >
        <h2 id="rules-modal-title" className="text-lg font-bold mb-2">{title}</h2>
        {children}
        <button
          onClick={onStart}
          className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition font-medium"
        >
          {buttonText}
        </button>
      </div>
    </div>
  );
}
