import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";

const outfit = Outfit({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700", "800"] });

export const metadata: Metadata = {
  title: "Grailcard",
  description: "Card grading that tells the truth about what it knows.",
};

// set the theme before first paint to avoid a flash of the wrong theme
const themeBoot = `try{var t=localStorage.getItem("gc-theme");if(t)document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body className={outfit.className}>{children}</body>
    </html>
  );
}
