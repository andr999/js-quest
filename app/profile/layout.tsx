import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Профіль гравця",
};

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
