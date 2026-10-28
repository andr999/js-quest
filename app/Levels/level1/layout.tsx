import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Рівень 1",
};

export default function Level1Layout({ children }: { children: React.ReactNode }) {
  return children;
}
