import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WebCog-Net",
  description:
    "Antarmuka web adaptif yang sadar beban kognitif dan instrumen penelitian HCI.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
