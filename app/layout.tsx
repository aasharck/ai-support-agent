import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Support agent demo",
  description: "A RAG support agent that answers from a shop's own docs, cites every answer, and can look up orders and open tickets.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
