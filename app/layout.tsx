import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WebCog-Net",
  description:
    "An adaptive, cognitive-load-aware web interface and HCI research instrument.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
