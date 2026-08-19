import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Grailcard",
  description: "Card grading that tells the truth about what it knows.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
