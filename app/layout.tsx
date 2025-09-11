import './globals.css'
import { ThemeProvider } from 'next-themes'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Spyfall Px27xTz',
  description: 'เล่น Spyfall ออนไลน์กับเพื่อน ฟรี ไม่ต้องล็อกอิน รองรับภาษาไทย',
  icons: {
    icon: '/spy.png', // ไฟล์ favicon (วางใน public/)
    shortcut: '/spy.png',
    apple: '/spy.png', // สำหรับ iOS
  },
  openGraph: {
    title: 'Spyfall Px27xTz',
    description: 'เล่น Spyfall ออนไลน์กับเพื่อน ฟรี ไม่ต้องล็อกอิน รองรับภาษาไทย',
    url: 'https://spyfall-px27xtz.vercel.app',
    siteName: 'Spyfall Px27xTz',
    images: [
      {
        url: 'https://spyfall-px27xtz.vercel.app/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Spyfall Px27xTz',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Spyfall Px27xTz',
    description: 'เล่น Spyfall ออนไลน์กับเพื่อน ฟรี ไม่ต้องล็อกอิน รองรับภาษาไทย',
    images: ['/logo.png'],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* favicon แบบ custom */}
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
