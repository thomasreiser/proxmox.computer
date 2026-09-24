import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "proxmox.computer — a proper proxmox homelab, a few questions away",
  description:
    "A free, community-built setup guide for proxmox ve. answer a few questions about your hardware, get the exact install, network, storage and backup steps back. no company, no account.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${jetbrainsMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-surface-100 text-ink">
        {children}
        <Script src="/proxmox-computer.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
