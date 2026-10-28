import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Фініш гри",
};

export default function FinishLayout({ children }: { children: React.ReactNode }) {
  return children;
}
