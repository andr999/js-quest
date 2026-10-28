import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "404 — Сторінку не знайдено",
  description: "Запитану сторінку не знайдено на сервері JS Quest.",
};

export default function NotFound() {
  return (
    <main className="min-h-[calc(100vh-64px)] bg-slate-900 text-white flex items-center justify-center p-4">
      <div className="bg-slate-800/80 border border-slate-700 p-8 md:p-12 rounded-3xl shadow-2xl max-w-lg w-full text-center">
        <div className="text-6xl md:text-8xl font-extrabold text-blue-500 mb-4 font-mono">
          404
        </div>
        <h1 className="text-2xl md:text-3xl font-bold mb-3">
          Сторінку не знайдено 🤖
        </h1>
        <p className="text-slate-300 text-sm md:text-base mb-8">
          Схоже, робот заблукав або такої адреси не існує в системі JS Quest.
        </p>
        <Link
          href="/"
          className="inline-block px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl transition shadow-lg shadow-blue-500/20"
        >
          🏠 Повернутися на головну
        </Link>
      </div>
    </main>
  );
}
