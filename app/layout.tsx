import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Concord · Your team, connected",
  description: "A shared space for conversations, projects, and people.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
