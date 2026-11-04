import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VibeFlow Inspector AI",
  description: "Source-grounded architecture and findings review (synthetic preview).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
