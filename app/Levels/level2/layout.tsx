import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Рівень 2",
};

export default function Level2Layout({ children }: { children: React.ReactNode }) {
  return children;
}
