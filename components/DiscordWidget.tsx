// DiscordWidget.tsx
import React from 'react'

type Props = {
  serverId: string
  theme?: 'dark' | 'light'
  width?: number
  height?: number
  className?: string
}

export default function DiscordWidget({
  serverId,
  theme = 'dark',
  width = 350,
  height = 400,
  className = '',
}: Props) {
  return (
    <iframe
      title="Discord Widget"
      src={`https://discord.com/widget?id=${serverId}&theme=${theme}`}
      width={width}
      height={height}
      // allowTransparency ไม่จำเป็นในเบราว์เซอร์สมัยใหม่และ TS จะฟ้อง จึงตัดออก
      frameBorder={0}
      loading="lazy"
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
      className={
        `flex w-auto items-center justify-center mt-10 text-center opacity-70 text-xs
         rounded-none sm:rounded-lg border border-slate-200 dark:border-slate-800
         bg-slate-50 dark:bg-rose-950/0 overflow-hidden ` + className
      }
    />
  )
}
