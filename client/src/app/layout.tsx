import type { Metadata } from "next";
import { Sora } from "next/font/google"; // Import Sora
import "./globals.css";

// Configure the font with the weights we need
const sora = Sora({
  subsets: ["latin"],
  weight: ["300", "400", "600"], // Light, Regular, Semi-bold
});

export const metadata: Metadata = {
  title: "MoodSync",
  description: "Craft your sonic space.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      {/* Apply the font's class name to the body */}
      <body className={sora.className}>{children}</body>
    </html>
  );
}