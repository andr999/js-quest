"use client";
import React from 'react';
import { useGame } from '@/app/context/GameContext';

export default function StorageAlert() {
  const { storageError, storageNotice } = useGame();

  if (storageError) {
    return (
      <div
        role="alert"
        className="bg-amber-500 text-slate-950 font-semibold px-4 py-2.5 text-center text-sm shadow-md flex items-center justify-center gap-2 border-b border-amber-600"
      >
        <span aria-hidden="true" className="text-lg">⚠️</span>
        <span>
          <strong>Помилка збереження:</strong> Локальне сховище недоступне ({storageError}). Прогрес не збережеться після перезавантаження сторінки.
        </span>
      </div>
    );
  }

  if (storageNotice) {
    return (
      <div
        role="status"
        className="bg-sky-100 text-slate-900 px-4 py-2.5 text-center text-sm shadow-sm flex items-center justify-center gap-2 border-b border-sky-300"
      >
        <span aria-hidden="true" className="text-lg">ℹ️</span>
        <span>
          <strong>Збережений прогрес було виправлено:</strong> у ньому були некоректні дані ({storageNotice}). Подальший прогрес зберігається як зазвичай.
        </span>
      </div>
    );
  }

  return null;
}
