import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://satellite.agentba.se"),
  title: "satellite.agentba.se",
  description: "Live orbital intelligence with predictive motion, SGP4 reconciliation, close-approach signals and local sky passes.",
  openGraph: {
    title: "satellite.agentba.se",
    description: "Live orbital intelligence with predictive motion, SGP4 reconciliation, close-approach signals and local sky passes.",
    type: "website",
    url: "/",
  },
  twitter: {
    card: "summary",
    title: "satellite.agentba.se",
    description: "Live orbital intelligence with predictive motion, SGP4 reconciliation, close-approach signals and local sky passes.",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
