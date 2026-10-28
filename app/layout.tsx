import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { GameProvider } from "./context/GameContext";
import StorageAlert from "@/components/StorageAlert";
import {
  ClerkProvider,
  SignInButton,
  SignUpButton,
  SignedIn,
  SignedOut,
  UserButton,
} from "@clerk/nextjs";
import Link from "next/link";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://js-quest-robots.netlify.app";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "JS Quest — Robots",
    template: "%s | JS Quest",
  },
  description: "Прокачай JavaScript, проходячи рівні та вирішуючи завдання!",
  keywords: ["JavaScript", "навчання JS", "гра програмування", "JS Quest", "роботи", "інтерактивне навчання"],
  authors: [{ name: "JS Quest Team" }],
  openGraph: {
    title: "JS Quest — Robots",
    description: "Прокачай JavaScript, проходячи рівні та вирішуючи завдання!",
    url: siteUrl,
    siteName: "JS Quest",
    locale: "uk_UA",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "JS Quest — Robots",
    description: "Прокачай JavaScript, проходячи рівні та вирішуючи завдання!",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider afterSignOutUrl="/">
      <html lang="uk">
        <body className={`${geistSans.variable} ${geistMono.variable}`}>
          <header className="sticky top-0 z-40 flex items-center justify-between px-3 py-2 md:px-6 md:py-3 bg-gradient-to-r from-slate-900 to-slate-800 text-white shadow-lg">
            <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition">
              <span className="text-lg md:text-2xl">🤖</span>
              <span className="text-sm md:text-lg font-bold tracking-tight">JS Quest</span>
            </Link>

            <nav className="flex items-center gap-3">
              <SignedIn>
                <Link
                  href="/profile"
                  className="px-3 py-1.5 text-sm font-medium bg-white/10 hover:bg-white/20 rounded-lg transition"
                >
                  📊 Профіль
                </Link>
                <UserButton
                  appearance={{
                    elements: {
                      avatarBox: "w-9 h-9",
                    },
                  }}
                />
              </SignedIn>
              <SignedOut>
                <SignInButton mode="modal">
                  <button className="px-4 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 rounded-lg transition">
                    Увійти
                  </button>
                </SignInButton>
                <SignUpButton mode="modal">
                  <button className="px-4 py-1.5 text-sm font-medium bg-white/10 hover:bg-white/20 rounded-lg transition border border-white/20">
                    Реєстрація
                  </button>
                </SignUpButton>
              </SignedOut>
            </nav>
          </header>

          <GameProvider>
            <StorageAlert />
            {children}
          </GameProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
