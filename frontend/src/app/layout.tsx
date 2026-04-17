import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import AuthGuard from "@/components/AuthGuard";
import Sidebar from "@/components/Sidebar";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Forex AI Platform",
  description: "AI-driven forex backtesting and live trading platform",
  icons: {
    icon: "/icon.png",
    shortcut: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="flex h-screen overflow-hidden">
        <AuthGuard>
          <Sidebar />
          <main className="flex-1 overflow-y-auto p-1">{children}</main>
        </AuthGuard>
      </body>
    </html>
  );
}
