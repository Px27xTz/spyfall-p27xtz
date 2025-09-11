'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { nanoid } from 'nanoid'
import DiscordWidget from 'components/DiscordWidget'
import { SiDiscord } from 'react-icons/si';

// ======================= Types =======================
type Player = { id: string; name: string }
type RolesMap = Record<string, string>

type Phase = 'lobby' | 'playing' | 'voting' | 'tie-guess' | 'revealed' | 'postgame'

type RoomState = {
  phase: Phase
  hostId: string | null
  gameMode: 'classic' | 'double'
  createdAt: number | null

  // round
  roundNumber: number
  roundStartAt: number | null
  timerEnd: number | null

  // voting/tie windows
  voteWindowEndsAt: number | null
  tieGuessEndsAt: number | null

  // per-round idempotency guards (shared via Yjs)
  voteAnnouncedRound: number | null
  voteWindowSetRound: number | null

  // info
  location: string | null
  spyId: string | null
  spyIds: string[] | null
  roles: RolesMap
  selectedLocations: string[] | null
  spyChoices: Record<string, string | null> | null

  // result
  winner: 'civ' | 'spy' | null
  winReason: string | null

  // room lifecycle
  closedAt: number | null
}

const DEFAULT_STATE: RoomState = {
  phase: 'lobby',
  hostId: null,
  gameMode: 'classic',
  createdAt: null,

  roundNumber: 0,
  roundStartAt: null,
  timerEnd: null,

  voteWindowEndsAt: null,
  tieGuessEndsAt: null,

  voteAnnouncedRound: null,
  voteWindowSetRound: null,

  location: null,
  spyId: null,
  spyIds: null,
  roles: {},
  selectedLocations: null,
  spyChoices: {},

  winner: null,
  winReason: null,

  closedAt: null,
}

const INACTIVITY_MS = 5 * 60 * 1000

// ======================= Tiny UI bits =======================
type Toast = { id: string; text: string; type?: 'info' | 'success' | 'warn' | 'error' }
function Toasts({ items, remove }: { items: Toast[]; remove: (id: string) => void }) {
  return (
    <div className="fixed z-[60] right-3 top-3 space-y-2 max-w-sm">
      {items.map(t => (
        <div
          key={t.id}
          className={
            'rounded-xl shadow-lg px-4 py-3 text-sm text-white flex items-start gap-2 ' +
            (t.type === 'success'
              ? 'bg-emerald-600'
              : t.type === 'warn'
                ? 'bg-amber-600'
                : t.type === 'error'
                  ? 'bg-rose-600'
                  : 'bg-slate-900')
          }
        >
          <span>{t.text}</span>
          <button className="ml-auto opacity-80 hover:opacity-100" onClick={() => remove(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

function ConfirmDialog({
  open,
  title,
  desc,
  onYes,
  onNo,
}: {
  open: boolean
  title: string
  desc?: string
  onYes: () => void
  onNo: () => void
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 shadow-xl p-5">
        <div className="text-lg font-semibold mb-2">{title}</div>
        {desc && <p className="text-sm opacity-80 mb-4">{desc}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-outline" onClick={onNo}>
            ยกเลิก
          </button>
          <button className="btn-primary" onClick={onYes}>
            ตกลง
          </button>
        </div>
      </div>
    </div>
  )
}

// Simple local theme toggle
function ThemeToggle() {
  const [mounted, setMounted] = useState(false)
  const [dark, setDark] = useState(false)
  useEffect(() => {
    setMounted(true)
    try {
      const saved = localStorage.getItem('theme')
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      const isDark = saved ? saved === 'dark' : prefersDark
      setDark(isDark)
      document.documentElement.classList.toggle('dark', isDark)
    } catch { }
  }, [])
  const toggle = () => {
    const next = !dark
    setDark(next)
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light')
    } catch { }
    document.documentElement.classList.toggle('dark', next)
  }
  return (
    <button className="btn-outline text-xs" onClick={toggle} suppressHydrationWarning>
      {mounted ? (dark ? '🌙 Dark' : '☀️ Light') : '🌓'}
    </button>
  )
}

function useClickSfx() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const acRef = useRef<AudioContext | null>(null)
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    audioRef.current = new Audio('/tick.mp3')
    audioRef.current.preload = 'auto'
    audioRef.current.volume = 0.4

    // prime ให้เล่นได้บน iOS/มือถือ: เรียกจาก gesture ครั้งแรก
    const prime = () => {
      audioRef.current?.play().then(() => {
        audioRef.current?.pause()
        if (audioRef.current) audioRef.current.currentTime = 0
      }).catch(() => { })
      if (!acRef.current) {
        const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
        if (Ctx) {
          acRef.current = new Ctx()
          // ไม่ต้องต่อ oscillator ตอนนี้ ยังไม่เล่น
        }
      }
      window.removeEventListener('pointerdown', prime)
    }
    window.addEventListener('pointerdown', prime, { once: true })
    return () => window.removeEventListener('pointerdown', prime)
  }, [])

  const play = () => {
    if (!enabled) return
    const a = audioRef.current
    if (!a) return
    try { a.currentTime = 0 } catch { }
    a.play().catch(() => {
      // fallback beep ถ้าเล่นไฟล์ไม่ได้
      const ctx = acRef.current
      if (!ctx) return
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'triangle'
      o.frequency.value = 800
      g.gain.value = 0.04
      o.connect(g); g.connect(ctx.destination)
      o.start()
      setTimeout(() => { o.stop(); o.disconnect(); g.disconnect() }, 60)
    })
  }

  return { play, enabled, setEnabled }
}


// ======================= helpers =======================
const nameKey = (n: string) => normalizeName(n).toLowerCase()
const baseName = (n: string) => normalizeName(n).replace(/\s+\(\d+\)$/, '')

function clearAllClientData() {
  try { localStorage.clear() } catch { }
  try { sessionStorage.clear() } catch { }
  try {
    if ('caches' in window) {
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).catch(() => { })
    }
  } catch { }
}
function hardResetClient() {
  try { clearAllClientData() } catch { }
  try {
    const url = new URL(window.location.href)
    url.searchParams.delete('room')
    url.searchParams.delete('name')
    window.history.replaceState({}, '', url.toString())
  } catch { }
}
function normalizeRoom(input: string) {
  return (input || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)
}
function normalizeName(input: string) {
  return (input || '').trim().replace(/\s+/g, ' ')
}
function msLeft(end: number | null, nowMs: number) {
  if (!end) return 0
  return Math.max(0, end - nowMs)
}

// ======================= yjs per room =======================
function useYRoom(roomId: string) {
  const [doc, setDoc] = useState<Y.Doc>(() => new Y.Doc())
  const [ready, setReady] = useState(false)
  const [connected, setConnected] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const providerRef = useRef<any>(null)

  useEffect(() => {
    const rid = normalizeRoom(roomId)
    setReady(false)
    setConnected(false)
    setLastError(null)

    try { providerRef.current?.destroy() } catch { }
    try { doc.destroy() } catch { }

    if (!rid) return

    const newDoc = new Y.Doc()
    setDoc(newDoc)

    const topic = encodeURIComponent(`spyfall-v3-${rid}`)
    const baseCandidates = ['wss://demos.yjs.dev', 'wss://yjs.dev', 'ws://localhost:1234']
    const normalizeBase = (s: string) => s.replace(/\/+$/, '')
    const endpoints = baseCandidates.flatMap(b => {
      const nb = normalizeBase(b)
      return [nb, `${nb}/yjs`, `${nb}/ws`]
    })

    let mounted = true
    let success = false
    const tried: string[] = []

    const tryConnect = async () => {
      for (const base of endpoints) {
        if (!mounted) return
        tried.push(base)
        const prov = new WebsocketProvider(base, topic, newDoc, { connect: true })
        providerRef.current = prov

        const onStatus = (e: any) => { try { setConnected(e.status === 'connected') } catch { } }
        prov.on('status', onStatus)
        prov.awareness.setLocalStateField('user', { id: 'local' })

        const ok = await new Promise<boolean>(resolve => {
          const to = setTimeout(() => resolve(false), 1200)
          const h = (e: any) => {
            if (e.status === 'connected') {
              clearTimeout(to)
              try { prov.off('status', h) } catch { }
              resolve(true)
            }
          }
          try { prov.on('status', h) } catch { }
        }).catch(() => false)

        if (ok) { success = true; setConnected(true); break }
        else {
          try { prov.off('status', onStatus) } catch { }
          try { prov.destroy() } catch { }
          providerRef.current = null
          setConnected(false)
        }
      }

      if (mounted) {
        setReady(true)
        if (!success) {
          setLastError(`Unable to connect to y-websocket. Tried: ${tried.join(', ')}. Try running a local server: "npx y-websocket --port 1234"`)
        } else setLastError(null)
      }
    }

    tryConnect()

    return () => {
      mounted = false
      try { providerRef.current?.destroy() } catch { }
      try { newDoc.destroy() } catch { }
    }
  }, [roomId])

  const waitUntilConnected = async (timeout = 3000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (providerRef.current && connected) return
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error('y-websocket connection timeout')
  }

  return { doc, ready, connected, waitUntilConnected, lastError }
}

// ======================= reactive maps =======================
function useRoom(doc: Y.Doc) {
  const playersY = useMemo(() => doc.getMap<Player>('players'), [doc])
  const stateY = useMemo(() => doc.getMap<any>('state'), [doc])
  const votesY = useMemo(() => doc.getMap<any>('votes'), [doc])
  const joinAtY = useMemo(() => doc.getMap<number>('joinAt'), [doc])
  const lastSeenY = useMemo(() => doc.getMap<number>('lastSeen'), [doc])
  const chatY = useMemo(() => doc.getArray<{ id: string; name: string; text: string; ts: number }>('chat'), [doc])
  const activityY = useMemo(() => doc.getMap<number>('activityAt'), [doc])
  const openVoteReqY = useMemo(() => doc.getMap<0 | 1>('openVoteReq'), [doc])
  const nameClaimsY = useMemo(() => doc.getMap<string>('nameClaims'), [doc])

  const [players, setPlayers] = useState<Player[]>([])
  const [state, setState] = useState<RoomState>(DEFAULT_STATE)
  const [votes, setVotes] = useState<Record<string, { target: string; confirmed?: boolean }>>({})
  const [joinAt, setJoinAt] = useState<Record<string, number>>({})
  const [lastSeen, setLastSeen] = useState<Record<string, number>>({})
  const [chat, setChat] = useState<{ id: string; name: string; text: string; ts: number }[]>([])
  const [activity, setActivity] = useState<Record<string, number>>({})
  const [openVoteReq, setOpenVoteReq] = useState<Record<string, 0 | 1>>({})

  useEffect(() => {
    const sync = () => {
      setPlayers(Array.from(playersY.values()))

      const s: any = {}
      for (const [k, v] of stateY) s[k] = v
      setState({ ...DEFAULT_STATE, ...s })

      const v: Record<string, { target: string; confirmed?: boolean }> = {}
      for (const [k, val] of votesY) {
        if (typeof val === 'string') v[k] = { target: val, confirmed: false }
        else v[k] = val
      }
      setVotes(v)

      const j: Record<string, number> = {}
      for (const [k, val] of joinAtY) j[k] = val as number
      setJoinAt(j)

      const ls: Record<string, number> = {}
      for (const [k, val] of lastSeenY) ls[k] = val as number
      setLastSeen(ls)

      const a: Record<string, number> = {}
      for (const [k, val] of activityY) a[k] = val as number
      setActivity(a)

      const ovr: Record<string, 0 | 1> = {}
      for (const [k, val] of openVoteReqY) ovr[k] = (val as any) as 0 | 1
      setOpenVoteReq(ovr)

      setChat(chatY.toArray())
    }
    sync()
    const obs = () => sync()
    playersY.observe(obs); stateY.observe(obs); votesY.observe(obs); chatY.observe(obs)
    joinAtY.observe(obs); lastSeenY.observe(obs); activityY.observe(obs); openVoteReqY.observe(obs); nameClaimsY.observe(obs)
    return () => {
      playersY.unobserve(obs); stateY.unobserve(obs); votesY.unobserve(obs); chatY.unobserve(obs)
      joinAtY.unobserve(obs); lastSeenY.unobserve(obs); activityY.unobserve(obs); openVoteReqY.unobserve(obs); nameClaimsY.unobserve(obs)
    }
  }, [playersY, stateY, votesY, chatY, joinAtY, lastSeenY, activityY, openVoteReqY, nameClaimsY])

  const api = {
    addPlayer(p: Player) { playersY.set(p.id, p) },

    removePlayer(id: string) {
      try {
        const cur = playersY.get(id)
        if (cur) {
          const k = nameKey(cur.name)
          if (nameClaimsY.get(k) === id) nameClaimsY.delete(k)
        }
      } catch { }
      playersY.delete(id); joinAtY.delete(id); lastSeenY.delete(id); votesY.delete(id); activityY.delete(id); openVoteReqY.delete(id)
      if (stateY.get('hostId') === id) stateY.set('hostId', null)

      queueMicrotask(() => {
        if (playersY.size === 0) {
          try {
            stateY.set('closedAt', Date.now())
            for (const k of Array.from(votesY.keys())) votesY.delete(k)
            for (const k of Array.from(joinAtY.keys())) joinAtY.delete(k)
            for (const k of Array.from(lastSeenY.keys())) lastSeenY.delete(k)
            for (const k of Array.from(activityY.keys())) activityY.delete(k)
            for (const k of Array.from(openVoteReqY.keys())) openVoteReqY.delete(k)
            for (const k of Array.from(nameClaimsY.keys())) nameClaimsY.delete(k)
            const resetPairs: Array<[string, any]> = Object.entries(DEFAULT_STATE)
            for (const [k, v] of resetPairs) stateY.set(k, v)
          } catch { }
        }
      })
    },

    setState(partial: Partial<RoomState>) { for (const [k, v] of Object.entries(partial)) stateY.set(k, v as any) },
    setSelectedLocations(list: string[]) { stateY.set('selectedLocations', list as any) },
    resetVotes() { for (const key of Array.from(votesY.keys())) votesY.delete(key) },

    vote(voterId: string, targetId: string) {
      const existing = votesY.get(voterId)
      const existingTarget = typeof existing === 'string' ? existing : (existing as any)?.target
      const existingConfirmed = typeof existing === 'object' ? !!(existing as any)?.confirmed : false
      if (existingConfirmed) return
      if (existingTarget === targetId) { votesY.delete(voterId); return }
      votesY.set(voterId, { target: targetId, confirmed: false })
    },

    confirmVote(voterId: string) {
      const existing = votesY.get(voterId); if (!existing) return
      if (typeof existing === 'string') votesY.set(voterId, { target: existing, confirmed: true })
      else votesY.set(voterId, { ...((existing as any) || {}), confirmed: true })
    },

    sendChat(msg: { id: string; name: string; text: string; ts: number }) { chatY.push([msg]) },
    setJoinAt(id: string, at: number) { joinAtY.set(id, at) },
    setLastSeen(id: string, at: number) { lastSeenY.set(id, at) },
    setActivity(id: string, at: number) { activityY.set(id, at) },

    requestOpenVote(id: string, on: boolean) { openVoteReqY.set(id, on ? 1 : 0) },
    resetOpenVoteRequests() { for (const key of Array.from(openVoteReqY.keys())) openVoteReqY.delete(key) },
  }

  return { players, state, votes, chat, joinAt, lastSeen, activity, openVoteReq, api }
}

// ======================= locations (fallback) =======================
const FALLBACK_TH = [
  { name: 'โรงพยาบาล', roles: ['แพทย์', 'พยาบาล', 'เภสัชกร', 'เจ้าหน้าที่เวรเปล', 'ญาติผู้ป่วย'] },
  { name: 'ชายหาด', roles: ['ไลฟ์การ์ด', 'นักท่องเที่ยว', 'พ่อค้าไอศกรีม', 'คนเล่นเซิร์ฟ'] },
  { name: 'สนามบิน', roles: ['นักบิน', 'แอร์โฮสเตส', 'จนท.เช็คอิน', 'ผู้โดยสาร', 'จนท.รักษาความปลอดภัย'] },
]
const FALLBACK_EN = [
  { name: 'Hospital', roles: ['Doctor', 'Nurse', 'Pharmacist', 'Orderly', 'Family'] },
  { name: 'Beach', roles: ['Lifeguard', 'Tourist', 'Ice-cream vendor', 'Surfer'] },
  { name: 'Airport', roles: ['Pilot', 'Flight attendant', 'Check-in agent', 'Passenger', 'Security'] },
]

function useLocations(lang: 'th' | 'en') {
  const [data, setData] = useState<{ name: string; roles: string[] }[]>([])
  useEffect(() => {
    let mounted = true
    const url = `/locations.${lang}.json`
    fetch(url)
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(d => { if (mounted) setData(d) })
      .catch(() => setData(lang === 'th' ? FALLBACK_TH : FALLBACK_EN))
    return () => { mounted = false }
  }, [lang])
  return data
}

// =========================================================
export default function Page() {
  // ---------- Language ----------
  const [lang, setLang] = useState<'th' | 'en'>('th')
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
    try {
      const saved = localStorage.getItem('spyfall.lang') as 'th' | 'en' | null
      if (saved) setLang(saved)
    } catch { }
  }, [])
  const dict = {
    title: { th: 'Spyfall', en: 'Spyfall' },
    free: { th: 'v 3.6', en: 'v 3.6' },
    createJoin: { th: 'สร้าง / เข้าร่วมห้อง', en: 'Create / Join Room' },
    yourName: { th: 'ชื่อของคุณ', en: 'Your name' },
    roomCode: { th: 'รหัสห้อง (เช่น my-friends)', en: 'Room code (e.g. my-friends)' },
    join: { th: 'เข้าห้อง', en: 'Join' },
    howTo: { th: 'วิธีเล่น', en: 'How to play' },
    rule1: { th: 'เข้าห้องด้วยรหัสเดียวกัน และรอให้โฮสต์เริ่มเกม', en: 'Join with the same room code and wait for the host to start.' },
    rule2: { th: 'ระหว่างเวลาเดิน ผู้เล่นถาม-ตอบแบบกว้าง หลีกเลี่ยงการเฉลย', en: 'While the timer runs, ask broad questions without revealing too much.' },
    rule3: { th: 'หมดเวลาแล้ว “เปิดโหวต” อัตโนมัติ หรือกดขอเปิดโหวตแบบเสียงข้างมาก', en: 'When time is up, voting opens automatically; or players can call a majority vote earlier.' },
    rule4: { th: 'หากโหวตผิด สายลับชนะ; หากเสมอ ให้สปายเดาสถานที่ — เดาถูกชนะ', en: 'If the vote is wrong the spy wins; if it ties, the spy guesses the location — correct guess wins.' },
    rule5: { th: 'โหมดสปาย 2 คนใช้ได้เมื่อผู้เล่น ≥ 8', en: 'Double Spy mode requires ≥ 8 players.' },
    synced: { th: 'ขอให้โชคดี', en: 'Good luck' },
    room: { th: 'ห้อง', en: 'Room' },
    leave: { th: 'ออก', en: 'Leave' },
    start: { th: 'เริ่มเกม', en: 'Start' },
    startNewPrep: { th: 'เริ่มเกมใหม่', en: 'Prepare new game' },
    reveal: { th: 'เฉลย', en: 'Reveal' },
    newRound: { th: 'เริ่มรอบใหม่', en: 'New round' },
    players: { th: 'ผู้เล่น', en: 'Players' },
    vote: { th: 'โหวต', en: 'Vote' },
    clearVote: { th: 'ล้างโหวต', en: 'Clear vote' },
    info: { th: 'ข้อมูลของคุณ', en: 'Your info' },
    timer: { th: 'ตัวจับเวลา', en: 'Timer' },
    minutes: { th: 'นาที', en: 'min' },
    mode: { th: 'โหมด', en: 'Mode' },
    classic: { th: 'คลาสสิก', en: 'Classic' },
    doubleSpy: { th: 'ดับเบิลสายลับ', en: 'Double Spy' },
    name: { th: 'ชื่อ', en: 'Name' },
    waitHost: { th: 'รอให้โฮสต์เริ่มเกม…', en: 'Waiting for host to start…' },
    role: { th: 'บทบาท', en: 'Role' },
    spy: { th: 'สายลับ', en: 'Spy' },
    location: { th: 'สถานที่', en: 'Location' },
    chat: { th: 'แชท', en: 'Chat' },
    typeMessage: { th: 'พิมพ์ข้อความ', en: 'Type a message' },
    send: { th: 'ส่ง', en: 'Send' },
    allLocations: { th: 'สถานที่ทั้งหมด', en: 'All locations' },
    shuffle: { th: 'สุ่มเอง', en: 'Shuffle' },
    clear: { th: 'ล้าง', en: 'Clear' },
    pickUpTo10: { th: 'เลือกสถานที่ได้สูงสุด 16 สถานที่สำหรับรอบนี้', en: 'Pick up to 16 locations' },
    revealedHeader: { th: 'ผลรอบนี้', en: 'Round Result' },
    spiesAre: { th: 'สายลับคือ', en: 'Spies' },
    footer: { th: 'Spyfall • Px27xTz', en: 'Spyfall • Px27xTz' },
    cantVote: { th: 'คุณเข้าระหว่างรอบนี้ ไม่สามารถโหวตได้ ต้องรอรอบถัดไป', en: 'You joined mid-round; you can’t vote until next round' },
    host: { th: '🏠 โฮสต์', en: '🏠 Host' },
    timeUp: { th: 'หมดเวลา', en: 'Time up' },
    bottom: { th: 'ลงล่าง', en: 'Bottom' },
    wait: { th: 'กรุณารอสักครู่…', en: 'Please wait…' },
    antiSpam: { th: 'กำลังกันสแปม', en: 'Anti-spam cooldown' },
    need1Loc: { th: 'กรุณาเลือกสถานที่อย่างน้อย 1 แห่ง', en: 'Please pick at least 1 location' },
    need3p: { th: 'ต้องมีผู้เล่นอย่างน้อย 3 คน', en: 'Need at least 3 players' },
    leaveConfirm: { th: 'คุณต้องการออกจากห้องจริงหรือไม่?', en: 'Leave the room?' },
    kickConfirm: { th: 'ต้องการเตะผู้เล่นคนนี้ออกจากห้องหรือไม่?', en: 'Kick this player from the room?' },
    cantKickDuringGame: { th: 'กำลังเล่นอยู่ — ไม่สามารถเตะผู้เล่นได้', en: 'Game in progress — cannot kick players.' },
    randomRoom: { th: 'สุ่มเลขห้อง', en: 'Random room #' },
    voteBtn: { th: 'โหวต', en: 'Vote' },
    confirmVoteBtn: { th: 'ยืนยัน', en: 'Confirm' },
    callVote: { th: 'เปิดโหวตจับสายลับ', en: 'Call vote' },
    calledVote: { th: 'ขอเปิดโหวตแล้ว', en: 'Vote requested' },
    spyAcceptPick: { th: 'ยอมรับและเลือกสถานที่', en: 'Accept & pick location' },
    pickShownRoles: { th: 'ดูบทบาท (แสดง/ซ่อน)', en: 'Toggle roles' },
    waitingNext: { th: 'กำลังรอรอบถัดไป', en: 'Waiting next round' },
    resultWinner: { th: 'ผู้ชนะ', en: 'Winner' },
    resultReason: { th: 'เหตุผล', en: 'Reason' },
    resultLocation: { th: 'สถานที่', en: 'Location' },
    resultSpies: { th: 'สายลับคือ', en: 'Spies' },
    reconnecting: { th: 'กำลังเชื่อมต่อใหม่…', en: 'Reconnecting…' },
  } as const
  const t = (k: keyof typeof dict) => dict[k][lang]
  const toggleLang = () => {
    const next = lang === 'th' ? 'en' : 'th'
    setLang(next)
    try { localStorage.setItem('spyfall.lang', next) } catch { }
  }
  const randomizeRoom = () => {
    const rnd = Math.floor(100000 + Math.random() * 900000).toString()
    setRoomInput(normalizeRoom(rnd))
  }

  // เสียงคลิกสำหรับทุกปุ่ม
  const { play: sfxClick, enabled: sfxOn, setEnabled: setSfxOn } = useClickSfx()

  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      // เล่นเมื่อกดปุ่ม หรือ element ที่ทำตัวเป็นปุ่ม
      const target = ev.target as HTMLElement
      const btn = target.closest('button, [role="button"]') as HTMLButtonElement | HTMLElement | null
      if (!btn) return
      if ((btn as HTMLButtonElement).disabled) return
      sfxClick()
    }
    document.addEventListener('click', onClick, true) // capture ให้ติดได้ครอบจักรวาล
    return () => document.removeEventListener('click', onClick, true)
  }, [sfxClick])


  // ---------- Params & states ----------
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
  const nameParam = params?.get('name') || ''
  const defaultRoom = normalizeRoom(params?.get('room') || '')
  const [roomId, setRoomId] = useState(defaultRoom)
  const [connectedUI, setConnectedUI] = useState(false)
  const [me, setMe] = useState<{ id: string; name: string }>({ id: '', name: '' })
  const [nameInput, setNameInput] = useState(nameParam)
  const [roomInput, setRoomInput] = useState(defaultRoom)
  const [duration, setDuration] = useState(8)
  const [chatInput, setChatInput] = useState('')
  const [chatTimes, setChatTimes] = useState<number[]>([])
  const [lastChatText, setLastChatText] = useState('')
  const [chatCooldownUntil, setChatCooldownUntil] = useState<number>(0)
  const [pickError, setPickError] = useState('')
  const [locQuery, setLocQuery] = useState('')
  const [showRoles, setShowRoles] = useState(false)

  // toasts & confirm
  const [toasts, setToasts] = useState<Toast[]>([])
  const toast = (text: string, type?: Toast['type']) => {
    const id = nanoid(6)
    setToasts(prev => [...prev, { id, text, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500)
  }
  const [confirmOpen, setConfirmOpen] = useState<null | { title: string; desc?: string; onYes: () => void }>(null)

  const chatBoxRef = useRef<HTMLDivElement | null>(null)
  const [showScrollDown, setShowScrollDown] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const iv = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(iv) }, [])

  const { doc, ready, connected: wsConnected, waitUntilConnected } = useYRoom(roomId || '')
  const { players, state, votes, chat, joinAt, lastSeen, activity, openVoteReq, api } = useRoom(doc)
  const docRef = useRef<Y.Doc>(doc)
  useEffect(() => { docRef.current = doc }, [doc])

  useEffect(() => {
    const el = chatBoxRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (nearBottom) { el.scrollTop = el.scrollHeight; setShowScrollDown(false) }
    else { setShowScrollDown(true) }
  }, [chat])

  // แจ้งเมื่อรอบเริ่ม
  const gameStartAlertedRef = useRef<number | null>(null)
  useEffect(() => {
    if (state.phase !== 'playing') return
    const key = state.roundStartAt || 0
    if (!key || gameStartAlertedRef.current === key) return
    const myJoinAt = joinAt[me.id] ?? 0
    if (myJoinAt && myJoinAt <= key + 2000) toast(lang === 'th' ? '🎮 เกมเริ่มแล้ว!' : '🎮 Game started!', 'success')
    gameStartAlertedRef.current = key
  }, [state.phase, state.roundStartAt, joinAt, me.id, lang])

  const locations = useLocations(lang)
  const filteredLocations = useMemo(() => locations.filter(l => l.name.toLowerCase().includes(locQuery.toLowerCase())), [locations, locQuery])
  const displayedLocations = useMemo(() => {
    if (state.phase === 'lobby') return filteredLocations
    const pool = state.selectedLocations && state.selectedLocations.length > 0 ? locations.filter(l => state.selectedLocations!.includes(l.name)) : filteredLocations
    return pool.slice(0, Math.min(16, pool.length))
  }, [state.phase, state.selectedLocations, filteredLocations, locations])

  // Auto-rejoin
  const [pendingJoin, setPendingJoin] = useState<{ id: string; name: string; rid: string } | null>(null)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('spyfall.me')
      const urlRoom = normalizeRoom(new URLSearchParams(window.location.search).get('room') || '')
      const savedRoom = normalizeRoom(localStorage.getItem('spyfall.room') || '')
      const rid = urlRoom || savedRoom
      if (saved && rid && !connectedUI) {
        const parsed = JSON.parse(saved)
        if (parsed?.id && parsed?.name) {
          setNameInput(parsed.name); setRoomInput(rid); setPendingJoin({ id: parsed.id, name: parsed.name, rid })
        }
      }
    } catch { }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Heartbeat & activity
  useEffect(() => {
    if (!me.id) return
    const iv = setInterval(() => api.setLastSeen(me.id, Date.now()), 5000)
    return () => clearInterval(iv)
  }, [me.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!connectedUI || !me.id) return
    const bump = () => api.setActivity(me.id, Date.now())
    const handler = (e: Event) => { if (e.type !== 'visibilitychange' || document.visibilityState === 'visible') bump() }
    bump()
    window.addEventListener('pointerdown', handler as any, { passive: true } as any)
    window.addEventListener('keydown', handler as any)
    window.addEventListener('visibilitychange', handler as any)
    return () => {
      window.removeEventListener('pointerdown', handler as any); window.removeEventListener('keydown', handler as any); window.removeEventListener('visibilitychange', handler as any)
    }
  }, [connectedUI, me.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Host election
  const [electionReady, setElectionReady] = useState(false)
  useEffect(() => { if (!connectedUI) { setElectionReady(false); return } const t = setTimeout(() => setElectionReady(true), 2000); return () => clearTimeout(t) }, [connectedUI])
  const isHost = state.hostId === me.id
  useEffect(() => {
    if (state.hostId) return
    if (!electionReady) return
    if (players.length === 0) return
    const allHaveJoin = players.every(p => typeof joinAt[p.id] === 'number'); if (!allHaveJoin) return
    const earliest = players.reduce((min, p) => ((joinAt[p.id] ?? 0) < (joinAt[min.id] ?? 0) ? p : min), players[0])
    if (earliest && me.id === earliest.id) { api.setState({ hostId: me.id, createdAt: state.createdAt || Date.now() }) }
  }, [players, joinAt, state.hostId, state.createdAt, me.id, electionReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // Derived
  const myRole = state.roles?.[me.id]
  const spies = (state.spyIds && state.spyIds.length ? state.spyIds : state.spyId ? [state.spyId] : []) || []
  const isSpy = spies.includes(me.id)
  const timeLeftMs = msLeft(state.timerEnd, now)
  const timeLeft = `${Math.floor(timeLeftMs / 60000)}:${String(Math.floor((timeLeftMs % 60000) / 1000)).padStart(2, '0')}`

  const roundStartAt = state.roundStartAt ?? 0
  const myJoin = joinAt[me.id] ?? 0
  const isLateJoiner = state.phase !== 'lobby' && myJoin > roundStartAt

  const eligiblePlayers = players.filter(p => (joinAt[p.id] ?? 0) <= roundStartAt)
  const iAmEligible = (joinAt[me.id] ?? 0) <= roundStartAt
  const confirmedCount = eligiblePlayers.length > 0 ? Object.keys(votes).filter(uid => eligiblePlayers.find(p => p.id === uid) && !!votes[uid]?.confirmed).length : 0
  const everyoneConfirmed = eligiblePlayers.length > 0 && confirmedCount === eligiblePlayers.length

  // ---------- Voting entry (auto & majority) ----------
  useEffect(() => {
    if (!isHost) return
    if (state.phase !== 'playing') return
    if (timeLeftMs > 0) return
    api.setState({ phase: 'voting' })
  }, [timeLeftMs, isHost, state.phase]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isHost) return
    if (state.phase !== 'playing') return
    const eligibleIds = new Set(eligiblePlayers.map(p => p.id))
    const reqCount = Object.entries(openVoteReq).filter(([uid, on]) => on === 1 && eligibleIds.has(uid)).length
    if (reqCount > eligiblePlayers.length / 2) {
      api.setState({ phase: 'voting' })
    }
  }, [openVoteReq, eligiblePlayers, isHost, state.phase]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- When in voting: announcements & window setup (HOST ONLY) ----------
  useEffect(() => {
    if (state.phase !== 'voting') return
    if (!isHost) return
    const key = state.roundStartAt || 0

    if (state.voteAnnouncedRound !== key) {
      api.sendChat({ id: 'system', name: lang === 'th' ? 'ระบบ' : 'System', text: lang === 'th' ? '📣 เปิดโหวตจับสายลับแล้ว' : '📣 Voting is now open', ts: Date.now() })
      api.setState({ voteAnnouncedRound: key })
    }
    if (state.voteWindowSetRound !== key) {
      const endsAt = Date.now() + 30_000
      api.setState({ voteWindowEndsAt: endsAt, timerEnd: endsAt, voteWindowSetRound: key })
      api.sendChat({ id: 'system', name: lang === 'th' ? 'ระบบ' : 'System', text: lang === 'th' ? '⏱️ เปิดโหวต: เริ่มนับถอยหลัง 30 วินาที' : '⏱️ Voting window: 30s', ts: Date.now() })
    }
  }, [state.phase, state.roundStartAt, state.voteAnnouncedRound, state.voteWindowSetRound, isHost, lang]) // eslint-disable-line react-hooks/exhaustive-deps

  // ====== helpers for vote summary ======
  function postVoteSummaryChat(targetIds: string[], isTie: boolean, winner: 'civ' | 'spy' | null) {
    const lines: string[] = []
    for (const voter of eligiblePlayers) {
      const entry = votes[voter.id]
      const confirmed = !!entry?.confirmed
      const targetId = entry?.target
      const targetName = targetId ? players.find(p => p.id === targetId)?.name || '—' : '—'
      lines.push(`${voter.name} → ${confirmed ? targetName : '—'}`)
    }
    const header = lang === 'th' ? 'สรุปโหวต: ' : 'Vote summary: '
    api.sendChat({ id: 'system', name: lang === 'th' ? 'ระบบ' : 'System', text: header + lines.join(' | '), ts: Date.now() })

    if (isTie) {
      api.sendChat({ id: 'system', name: lang === 'th' ? 'ระบบ' : 'System', text: lang === 'th' ? 'ผลโหวตเสมอ ให้สปายเดา 1 ครั้ง (20 วิ)' : 'Tie: spy gets one guess (20s).', ts: Date.now() })
    } else if (winner) {
      const msg = winner === 'civ' ? (lang === 'th' ? '✅ โหวตถูกตัวสายลับ — ผู้เล่นทั่วไปชนะ' : '✅ Voted the spy — Civilians win') : (lang === 'th' ? '❌ โหวตผิด — สายลับชนะ' : '❌ Wrong vote — Spy wins')
      api.sendChat({ id: 'system', name: lang === 'th' ? 'ระบบ' : 'System', text: msg, ts: Date.now() })
    }
  }

  // ====== Refs สำหรับการ guard ต่อรอบ ======
  const processedVotesForRoundRef = useRef<number | null>(null)
  const tieNoGuessResolvedRoundRef = useRef<number | null>(null)
  const forceEndRef = useRef<number | null>(null)

  // ====== ทุกคนยืนยันครบ → สรุปทันที (HOST ONLY) ======
  useEffect(() => {
    if (!isHost) return
    if (state.phase !== 'voting') return
    if (!everyoneConfirmed) return

    const key = state.roundStartAt || 0
    if (processedVotesForRoundRef.current === key) return
    processedVotesForRoundRef.current = key

    const eligibleIds = new Set(eligiblePlayers.map(p => p.id))
    const counts: Record<string, number> = {}
    for (const [voterId, entry] of Object.entries(votes)) {
      if (!eligibleIds.has(voterId)) continue
      const targetId = typeof entry === 'string' ? entry : entry?.target
      const confirmed = typeof entry === 'object' ? !!entry?.confirmed : false
      if (!targetId || !confirmed) continue
      counts[targetId] = (counts[targetId] || 0) + 1
    }
    const values = Object.values(counts)
    const max = values.length ? Math.max(...values) : 0
    const topTargets = Object.entries(counts).filter(([, c]) => c === max).map(([tid]) => tid)
    const isTie = topTargets.length >= 2 && max > 0

    if (isTie) {
      api.setState({ phase: 'tie-guess', voteWindowEndsAt: null, tieGuessEndsAt: Date.now() + 20_000, timerEnd: Date.now() + 20_000 })
      postVoteSummaryChat(topTargets, true, null)
      return
    }

    const guessedId = topTargets[0] || null
    const isSpyHit = guessedId ? spies.includes(guessedId) : false
    const winner: 'civ' | 'spy' = isSpyHit ? 'civ' : 'spy'
    const reason = isSpyHit ? (lang === 'th' ? 'โหวตถูกตัวสายลับ' : 'Voted the spy correctly') : (lang === 'th' ? 'โหวตผิดตัว' : 'Voted the wrong person')

    api.setState({ phase: 'revealed', winner, winReason: reason })
    postVoteSummaryChat(topTargets, false, winner)
  }, [everyoneConfirmed, isHost, state.phase, lang, votes, eligiblePlayers, players, spies, state.roundStartAt]) // eslint-disable-line react-hooks/exhaustive-deps

  // ====== ครบ 30 วิโหวต → สรุป (HOST ONLY) ======
  useEffect(() => {
    if (!isHost) return
    if (state.phase !== 'voting') return
    if (!state.voteWindowEndsAt) return
    if (Date.now() < state.voteWindowEndsAt) return

    const eligibleIds = new Set(eligiblePlayers.map(p => p.id))
    const counts: Record<string, number> = {}
    for (const [voterId, entry] of Object.entries(votes)) {
      if (!eligibleIds.has(voterId)) continue
      const targetId = typeof entry === 'string' ? entry : entry?.target
      const confirmed = typeof entry === 'object' ? !!entry?.confirmed : false
      if (!targetId || !confirmed || !eligibleIds.has(targetId)) continue
      counts[targetId] = (counts[targetId] || 0) + 1
    }

    const values = Object.values(counts)
    const max = values.length ? Math.max(...values) : 0
    const topTargets = Object.entries(counts).filter(([, c]) => c === max).map(([tid]) => tid)
    const isTie = topTargets.length >= 2 && max > 0

    if (isTie) {
      api.setState({ phase: 'tie-guess', voteWindowEndsAt: null, tieGuessEndsAt: Date.now() + 20_000, timerEnd: Date.now() + 20_000 })
      postVoteSummaryChat(topTargets, true, null)
      return
    }

    const guessedId = topTargets[0] || null
    const isSpyHit = guessedId ? spies.includes(guessedId) : false
    const winner: 'civ' | 'spy' = isSpyHit ? 'civ' : 'spy'
    const reason = isSpyHit ? (lang === 'th' ? 'โหวตถูกตัวสายลับ' : 'Voted the spy correctly') : (lang === 'th' ? 'โหวตผิดตัว' : 'Voted the wrong person')

    api.setState({ phase: 'revealed', winner, winReason: reason })

    const details = Object.entries(votes).map(([voter, v]) => {
      if (!eligibleIds.has(voter)) return null
      const voterName = players.find(p => p.id === voter)?.name || '??'
      const targetName = players.find(p => p.id === (typeof v === 'string' ? v : v?.target))?.name || '—'
      const confirmed = typeof v === 'object' ? !!v?.confirmed : false
      return `${voterName} → ${confirmed ? targetName : '—'}`
    }).filter(Boolean).join(' | ')
    api.sendChat({ id: 'system', name: lang === 'th' ? 'ระบบ' : 'System', text: (lang === 'th' ? 'สรุปโหวต: ' : 'Vote summary: ') + details, ts: Date.now() })

    const msg = winner === 'civ' ? (lang === 'th' ? '✅ โหวตถูกตัวสายลับ — ผู้เล่นทั่วไปชนะ' : '✅ Civilians win') : (lang === 'th' ? '❌ โหวตผิด — สายลับชนะ' : '❌ Spy wins')
    api.sendChat({ id: 'system', name: lang === 'th' ? 'ระบบ' : 'System', text: msg, ts: Date.now() })
  }, [now, isHost, state.phase, state.voteWindowEndsAt, votes, eligiblePlayers, players, spies, lang]) // eslint-disable-line react-hooks/exhaustive-deps

  // ====== สปายเดาเพื่อชี้ขาด ======
  const handleSpyPickWin = (pickName: string) => {
    if (!isSpy) return
    if (!(state.phase === 'voting' || state.phase === 'tie-guess')) return

    if (state.phase === 'tie-guess') {
      const correct = pickName === state.location
      const winner: 'spy' | 'civ' = correct ? 'spy' : 'civ'
      const reason = correct ? (lang === 'th' ? 'สายลับเดาถูกหลังผลเสมอ' : 'Spy guessed correctly after tie') : (lang === 'th' ? 'สายลับเดาผิดหลังผลเสมอ' : 'Spy guessed wrong after tie')
      api.setState({ phase: 'revealed', winner, winReason: reason })
      api.sendChat({ id: 'system', name: lang === 'th' ? 'ระบบ' : 'System', text: (lang === 'th' ? `ผลชี้ขาดโดยสายลับ: เดา "${pickName}" → ${correct ? 'ถูก ✅' : 'ผิด ❌'}` : `Spy tiebreak guess: "${pickName}" → ${correct ? 'correct ✅' : 'wrong ❌'}`), ts: Date.now() })
      return
    }

    if (state.phase === 'voting') {
      const correct = pickName === state.location
      api.setState({ phase: 'revealed', winner: correct ? 'spy' : 'civ', winReason: correct ? (lang === 'th' ? 'สายลับเดาสถานที่ถูก' : 'Spy guessed correctly') : (lang === 'th' ? 'สายลับเดาผิด' : 'Spy guessed wrong') })
      api.sendChat({ id: 'system', name: lang === 'th' ? 'ระบบ' : 'System', text: (lang === 'th' ? `สายลับกดยอมรับและเดา "${pickName}" → ${correct ? 'ถูก ✅' : 'ผิด ❌'}` : `Spy accepted & guessed "${pickName}" → ${correct ? 'correct ✅' : 'wrong ❌'}`), ts: Date.now() })
    }
  }

  // ====== Tie-guess หมดเวลา → ชนะโดยพลเมือง ======
  useEffect(() => {
    if (!isHost) return
    if (state.phase !== 'tie-guess') return
    if (!state.tieGuessEndsAt) return
    const key = state.roundStartAt || 0
    if (Date.now() < state.tieGuessEndsAt) return
    if (tieNoGuessResolvedRoundRef.current === key) return
    tieNoGuessResolvedRoundRef.current = key

    api.setState({ phase: 'revealed', winner: 'civ', winReason: lang === 'th' ? 'สายลับไม่ทาย' : 'Spy did not guess' })
    api.sendChat({ id: 'system', name: lang === 'th' ? 'ระบบ' : 'System', text: (lang === 'th' ? '⏰ หมดเวลา 20 วินาที — ผู้เล่นทั่วไปชนะ (สายลับไม่ทาย)' : '⏰ 20s up — Civilians win (spy did not guess)'), ts: Date.now() })
  }, [now, isHost, state.phase, state.tieGuessEndsAt, state.roundStartAt, lang]) // eslint-disable-line react-hooks/exhaustive-deps

  // ====== Auto close room when idle 5m ======
  useEffect(() => {
    if (!connectedUI) return
    const activityVals = Object.values(activity || {})
    const latestActivity = Math.max(0, ...(activityVals.length ? activityVals : [0]), state.roundStartAt || 0, state.createdAt || 0)
    if (latestActivity === 0) return
    if ((Date.now() - latestActivity) >= INACTIVITY_MS && !state.closedAt) {
      try {
        api.setState({ phase: 'lobby', closedAt: Date.now(), winner: null, winReason: null, selectedLocations: null, spyChoices: {}, voteAnnouncedRound: null, voteWindowSetRound: null })
        api.sendChat({ id: 'system', name: lang === 'th' ? 'ระบบ' : 'System', text: (lang === 'th' ? 'ไม่มีความเคลื่อนไหวนาน 5 นาที — ปิดห้องและลบเซสชัน' : 'Room idle for 5 minutes — closing and clearing session.'), ts: Date.now() })
        for (const p of Object.keys(activity)) { api.removePlayer(p) }
      } catch { }
    }
  }, [now, connectedUI, activity, state.roundStartAt, state.createdAt, state.closedAt, lang]) // eslint-disable-line react-hooks/exhaustive-deps

  // ====== จบรอบอัตโนมัติ: เหลือผู้เล่น 2 คน หรือสปายออกหมด (HOST ONLY) ======
  useEffect(() => {
    if (!isHost) return

    const inProgress = state.phase === 'playing' || state.phase === 'voting' || state.phase === 'tie-guess'
    if (!inProgress) return

    const key = state.roundStartAt || 0
    if (forceEndRef.current === key) return

    const playerCount = players.length
    const currentSpies = (state.spyIds && state.spyIds.length ? state.spyIds : state.spyId ? [state.spyId] : []) || []
    const spyStillPresent = currentSpies.some(spyId => players.some(p => p.id === spyId))

    if (playerCount <= 2) {
      forceEndRef.current = key
      api.setState({
        phase: 'revealed',
        winner: null,
        winReason: lang === 'th' ? 'ผู้เล่นเหลือ 2 คน — จบรอบทันที' : 'Only 2 players left — round ended',
        timerEnd: null,
        voteWindowEndsAt: null,
        tieGuessEndsAt: null,
      })
      api.sendChat({
        id: 'system',
        name: lang === 'th' ? 'ระบบ' : 'System',
        text: lang === 'th' ? '👥 ผู้เล่นเหลือ 2 คน — จบรอบทันที' : '👥 Only 2 players left — ending the round now.',
        ts: Date.now()
      })
      return
    }

    if (!spyStillPresent) {
      forceEndRef.current = key
      api.setState({
        phase: 'revealed',
        winner: 'civ',
        winReason: lang === 'th' ? 'สายลับออกจากเกมหมด' : 'All spies have left',
        timerEnd: null,
        voteWindowEndsAt: null,
        tieGuessEndsAt: null,
      })
      api.sendChat({
        id: 'system',
        name: lang === 'th' ? 'ระบบ' : 'System',
        text: lang === 'th' ? '🕵️ สปายออกจากเกมหมดแล้ว — จบรอบทันที' : '🕵️ All spies have left — ending the round now.',
        ts: Date.now()
      })
    }
  }, [players, state.phase, state.roundStartAt, state.spyIds, state.spyId, isHost, lang])

  // เห็น closedAt → รีเซ็ต UI
  useEffect(() => { if (state.closedAt) forceResetUI() }, [state.closedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  // ถูกเตะออก
  useEffect(() => {
    if (!connectedUI || !me.id) return
    const stillIn = players.some(p => p.id === me.id)
    if (!stillIn) { forceResetUI() }
  }, [players, connectedUI, me.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function forceResetUI() {
    setConnectedUI(false)
    setRoomId('')
    setMe({ id: '', name: '' })
    setNameInput('')
    setRoomInput('')
    hardResetClient()
  }

  // Connect & Join
  async function connect() {
    if (!roomInput || !nameInput) return
    const rid = normalizeRoom(roomInput)
    if (!rid) return
    const id = me.id || nanoid(10)
    const cleanName = normalizeName(nameInput)
    if (!cleanName) { toast(lang === 'th' ? 'กรุณากรอกชื่อ' : 'Please enter a name', 'warn'); return }
    setNameInput(cleanName); setRoomId(rid); setPendingJoin({ id, name: cleanName, rid })
  }

  // JOIN & กันชื่อซ้ำ
  async function joinNow(id: string, name: string, rid: string) {
    try { await waitUntilConnected(7000) } catch { setPendingJoin({ id, name, rid }); return }
    const d = docRef.current; if (!d) return
    const playersY = d.getMap<Player>('players')
    const joinAtY = d.getMap<number>('joinAt')
    const stateY = d.getMap<any>('state')
    const nameClaimsY = d.getMap<string>('nameClaims')

    const base = normalizeName(name) || 'Player'
    let finalName: string = base

    d.transact(() => {
      const self = playersY.get(id)
      if (self) {
        const selfKey = nameKey(self.name)
        if (nameClaimsY.get(selfKey) === id && nameKey(base) !== selfKey) { nameClaimsY.delete(selfKey) }
        let attempt = base; let i = 1
        while (true) {
          const owner = nameClaimsY.get(nameKey(attempt))
          if (!owner || owner === id) { finalName = attempt; nameClaimsY.set(nameKey(attempt), id); break }
          i += 1; attempt = `${base} (${i})`
        }
        if (self.name !== finalName) playersY.set(id, { id, name: finalName })
        if (!joinAtY.get(id)) joinAtY.set(id, Date.now())
        return
      }

      let attempt = base; let i = 1
      while (true) {
        const owner = nameClaimsY.get(nameKey(attempt))
        if (!owner) { finalName = attempt; nameClaimsY.set(nameKey(attempt), id); break }
        if (owner === id) { finalName = attempt; break }
        i += 1; attempt = `${base} (${i})`
      }
      playersY.set(id, { id, name: finalName })
      joinAtY.set(id, Date.now())
    })

    setMe({ id, name: finalName })
    setConnectedUI(true)
    try {
      const u = new URL(window.location.href)
      u.searchParams.set('room', rid); u.searchParams.set('name', finalName)
      window.history.replaceState({}, '', u.toString())
      localStorage.setItem('spyfall.me', JSON.stringify({ id, name: finalName }))
      localStorage.setItem('spyfall.room', rid)
    } catch { }
  }

  useEffect(() => {
    if (pendingJoin && wsConnected && ready) {
      (async () => {
        if (connectedUI) { setPendingJoin(null); return }
        try { await joinNow(pendingJoin.id, pendingJoin.name, pendingJoin.rid) } finally { setPendingJoin(null) }
      })()
    }
  }, [pendingJoin, wsConnected, ready, connectedUI]) // eslint-disable-line react-hooks/exhaustive-deps

  // DEDUPE ตัวเองหลังซิงก์
  useEffect(() => {
    if (!connectedUI || !me.id) return
    const d = docRef.current; if (!d) return
    const playersY = d.getMap<Player>('players')
    const nameClaimsY = d.getMap<string>('nameClaims')
    const self = playersY.get(me.id); if (!self) return
    const base = baseName(self.name)
    const group = players.filter(p => baseName(p.name).toLowerCase() === base.toLowerCase())
    if (group.length <= 1) return
    const sorted = [...group].sort((a, b) => (joinAt[a.id] ?? 0) - (joinAt[b.id] ?? 0) || a.id.localeCompare(b.id))
    const myIndex = sorted.findIndex(p => p.id === me.id); if (myIndex < 0) return
    const desired = myIndex === 0 ? base : `${base} (${myIndex + 1})`
    if (self.name === desired) return
    d.transact(() => {
      const oldKey = nameKey(self.name); if (nameClaimsY.get(oldKey) === me.id) nameClaimsY.delete(oldKey)
      const newKey = nameKey(desired); nameClaimsY.set(newKey, me.id)
      playersY.set(me.id, { id: me.id, name: desired })
    })
    setMe({ id: me.id, name: desired })
  }, [players, joinAt, connectedUI, me.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function startGame() {
    if (!isHost) return
    if (players.length < 3) { toast(t('need3p'), 'warn'); return }

    const base = state.selectedLocations && state.selectedLocations.length > 0 ? locations.filter(l => state.selectedLocations!.includes(l.name)) : locations
    const pool = base.length > 16 ? [...base].sort(() => Math.random() - 0.5).slice(0, 16) : base
    if (pool.length === 0) { toast(t('need1Loc'), 'warn'); return }

    const poolNames = pool.map(l => l.name); api.setSelectedLocations(poolNames)
    const loc = pool[Math.floor(Math.random() * pool.length)]

    const ids = players.map(p => p.id)
    let spyIds: string[] = []
    if (state.gameMode === 'double' && players.length >= 8) {
      const i1 = Math.floor(Math.random() * ids.length); let i2 = Math.floor(Math.random() * ids.length); if (i2 === i1) i2 = (i1 + 1) % ids.length
      spyIds = [ids[i1], ids[i2]]
    } else {
      const i = Math.floor(Math.random() * ids.length); spyIds = [ids[i]]
    }
    const spyId = spyIds[0]
    const roles: RolesMap = {}
    const shuffledRoles = [...loc.roles].sort(() => Math.random() - 0.5)
    let ri = 0; for (const p of players) { if (spyIds.includes(p.id)) continue; roles[p.id] = shuffledRoles[ri % shuffledRoles.length]; ri++ }
    const end = Date.now() + duration * 60 * 1000
    const nextRound = (state.roundNumber || 0) + 1
    api.setState({
      phase: 'playing',
      location: loc.name,
      spyId, spyIds,
      roles,
      timerEnd: end,
      roundStartAt: Date.now(),
      roundNumber: nextRound,
      spyChoices: {},
      voteWindowEndsAt: null, tieGuessEndsAt: null,
      voteAnnouncedRound: null, voteWindowSetRound: null,
      closedAt: null,
      winner: null, winReason: null,
    })
    processedVotesForRoundRef.current = null
    forceEndRef.current = null          // ✅ รีเซ็ต guard อัตโนมัติ
    api.resetVotes(); api.resetOpenVoteRequests()
    api.sendChat({ id: 'system', name: lang === 'th' ? 'ระบบ' : 'System', text: lang === 'th' ? `เกมที่ ${nextRound} เริ่มแล้ว` : `Game ${nextRound} started`, ts: Date.now() })
  }

  function revealNow() { if (!isHost) return; api.setState({ phase: 'revealed' }) }

  function newRound() {
    if (!isHost) return
    api.setState({
      ...DEFAULT_STATE,
      hostId: state.hostId,
      gameMode: state.gameMode,
      createdAt: state.createdAt,
      roundNumber: state.roundNumber, // ✅ คงเลขรอบเดิมไว้
    })
    processedVotesForRoundRef.current = null
    forceEndRef.current = null          // ✅ รีเซ็ต guard อัตโนมัติ
    api.resetVotes(); api.resetOpenVoteRequests()
  }

  // Kick & Leave
  function kick(id: string) {
    if (!isHost) return
    if (!(state.phase === 'lobby')) { toast(t('cantKickDuringGame'), 'warn'); return }
    setConfirmOpen({ title: t('kickConfirm'), onYes: () => { api.removePlayer(id); setConfirmOpen(null) } })
  }
  function leaveRoom() {
    if (!me.id) { forceResetUI(); return }
    setConfirmOpen({ title: t('leaveConfirm'), onYes: () => { try { api.removePlayer(me.id) } catch { } forceResetUI(); setConfirmOpen(null) } })
  }

  // unload cleanup
  useEffect(() => {
    const onUnload = () => { try { if (me.id) api.removePlayer(me.id) } catch { } try { clearAllClientData() } catch { } }
    window.addEventListener('pagehide', onUnload); window.addEventListener('beforeunload', onUnload)
    return () => { window.removeEventListener('pagehide', onUnload); window.removeEventListener('beforeunload', onUnload) }
  }, [me.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // เน็ตหลุด: แจ้งสถานะ
  const disconnectTimerRef = useRef<number | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  useEffect(() => {
    if (!connectedUI) return
    if (wsConnected) {
      if (reconnecting) toast(lang === 'th' ? '✅ เชื่อมต่อกลับแล้ว' : '✅ Reconnected', 'success')
      setReconnecting(false); if (disconnectTimerRef.current) { window.clearTimeout(disconnectTimerRef.current); disconnectTimerRef.current = null }
      return
    }
    if (!reconnecting) setReconnecting(true)
    if (!disconnectTimerRef.current) {
      disconnectTimerRef.current = window.setTimeout(() => { toast(lang === 'th' ? '⚠️ ขาดการเชื่อมต่อ กำลังพยายามเชื่อมต่อใหม่…' : '⚠️ Disconnected. Attempting to reconnect…', 'warn') }, 1500)
    }
    return () => { if (disconnectTimerRef.current) { window.clearTimeout(disconnectTimerRef.current); disconnectTimerRef.current = null } }
  }, [wsConnected, connectedUI, reconnecting, lang]) // eslint-disable-line react-hooks/exhaustive-deps

  function onChatScroll() {
    const el = chatBoxRef.current; if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 10
    setShowScrollDown(!atBottom)
  }
  function copyInvite() {
    const url = new URL(window.location.href)
    url.searchParams.set('room', roomId); url.searchParams.delete('name')
    navigator.clipboard.writeText(url.toString())
    toast(lang === 'th' ? '🔗 คัดลอกห้องแล้ว!' : '🔗 Room link copied!', 'success')
  }
  function submitChat() {
    const text = chatInput.trim(); const nowMs = Date.now()
    if (!text) return
    if (text.length > 200) { toast(lang === 'th' ? 'ข้อความยาวเกินไป (สูงสุด 200 ตัวอักษร)' : 'Message too long (max 200 chars)', 'warn'); return }
    if (nowMs < chatCooldownUntil) { return }
    const windowMs = 10_000; const limit = 5
    const recent = chatTimes.filter(ti => nowMs - ti < windowMs)
    if (recent.length >= limit) { setChatCooldownUntil(nowMs + 2000); return }
    if (text === lastChatText && recent.length >= 1) { setChatCooldownUntil(nowMs + 1500); return }
    api.sendChat({ id: me.id, name: me.name, text, ts: nowMs })
    setChatInput(''); setLastChatText(text); setChatTimes(recent.concat([nowMs])); setChatCooldownUntil(nowMs + 1500)
  }
  function togglePickLocation(name: string) {
    const current = state.selectedLocations || []
    const exists = current.includes(name)
    let next = exists ? current.filter(n => n !== name) : [...current, name]
    if (!exists && next.length > 16) { setPickError(lang === 'th' ? 'เลือกได้สูงสุด 16 สถานที่' : 'Pick up to 16 locations'); return }
    setPickError(''); api.setSelectedLocations(next)
  }
  function randomSelectLocations(list: string[]) {
    const shuffled = [...list].sort(() => Math.random() - 0.5)
    const limited = shuffled.slice(0, Math.min(16, shuffled.length))
    api.setSelectedLocations(limited); setPickError('')
  }
  function clearLocations() { api.setSelectedLocations([]); setPickError('') }

  const canVoteNow = state.phase === 'voting' || (state.phase === 'playing' && timeLeftMs <= 0)

  // ======================= UI =======================
  return (
    <main className="min-h-dvh max-w-6xl mx-auto p-3 sm:p-5">
      <Toasts items={toasts} remove={id => setToasts(prev => prev.filter(t => t.id !== id))} />
      <ConfirmDialog open={!!confirmOpen} title={confirmOpen?.title || ''} onYes={() => confirmOpen?.onYes()} onNo={() => setConfirmOpen(null)} />

      <header className="flex items-center justify-between gap-3 mb-4 sm:mb-6">
        <div className="text-xl font-semibold flex items-center"><img src="/spy.png" className="mr-2" alt="" width={28} height={28} />{t('title')}</div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="badge">{t('free')}</span>
          <button className="btn-outline text-xs" onClick={() => setSfxOn(v => !v)}>
            {sfxOn ? '🔊' : '🔈'}
          </button>

          {!isHost && (
            <>
              {reconnecting && <span className="badge bg-amber-500 text-white">{t('reconnecting')}</span>}
              <ThemeToggle />
              <button className="btn-outline text-xs" onClick={toggleLang} suppressHydrationWarning>
                {mounted ? (lang === 'th' ? '🌐 TH' : '🌐 EN') : '🌐'}
              </button>
            </>
          )}
        </div>
      </header>

      {
        !connectedUI ? (
          <div className="grid md:grid-cols-2 gap-5">
            <div className="card p-4 sm:p-5">
              <h2 className="flex justify-between text-lg font-semibold mb-3"> 🎮 {t('createJoin')} <a href="https://discord.gg/vN883BUGKU" target='_blank'><SiDiscord size={22} /></a></h2>
              <div className="space-y-3">
                <input className="input" placeholder={t('yourName')} value={nameInput} onChange={e => setNameInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && nameInput && roomInput) connect() }} />
                <input className="input" placeholder={t('roomCode')} value={roomInput} onChange={e => setRoomInput(normalizeRoom(e.target.value))} onKeyDown={e => { if (e.key === 'Enter' && nameInput && roomInput) connect() }} />
                <div className="flex gap-2">
                  <button className="btn-outline" onClick={randomizeRoom}>🎲 {t('randomRoom')}</button>
                  <button className={'btn-primary flex-1 disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed'} onClick={connect} disabled={!nameInput || !roomInput}>{t('join')}</button>
                </div>
                <p className="text-xs opacity-70">
                  {lang === 'th' ? 'แชร์ URL หลังเข้าห้องแล้ว คนที่เข้ารหัสเดียวกันจะซิงก์กันอัตโนมัติ' : 'Share the URL after joining. Anyone with the same room code will sync automatically.'}
                </p>
              </div>
            </div>
            <div className="card p-4 sm:p-5">
              <h2 className="text-lg font-semibold mb-3">❔ {t('howTo')}</h2>
              <ol className="list-decimal pl-5 space-y-1 text-sm">
                <li>{t('rule1')}</li>
                <li>{t('rule2')}</li>
                <li>{t('rule3')}</li>
                <li>{t('rule4')}</li>
                <li>{t('rule5')}</li>
              </ol>
              <p className="text-xs mt-3 opacity-70">{t('synced')}</p>
            </div>
          </div>
        ) : (
          <div className="flex gap-5 *:w-auto">
            <div className="card p-4 sm:p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="font-semibold">{t('room')}: <span className="badge">{roomId}</span></div>
                <div className="flex items-center gap-2 flex-wrap ">
                   <a href="https://discord.gg/vN883BUGKU" target='_blank'><SiDiscord size={22} /></a>
                  <button className="btn-outline" onClick={copyInvite}>🔗</button>
                  <button className="btn-outline" onClick={leaveRoom}>🚪 {t('leave')}</button>

                  {isHost && state.phase === 'lobby' && (<button className="btn-primary" onClick={startGame}>{t('start')}</button>)}
                  {isHost && state.phase === 'playing' && (<button className="btn-outline" onClick={revealNow}>{t('reveal')}</button>)}
                  {isHost && state.phase === 'revealed' && (<button className="btn-primary" onClick={newRound}>{t('newRound')}</button>)}
                  
                </div>
              </div>

              {state.phase === 'revealed' && (
                <div className={'mb-4 rounded-lg p-3 text-sm ' + (state.winner === 'spy' ? 'border border-rose-300/60 dark:border-rose-700/60 bg-rose-50 dark:bg-rose-950/30' : 'border border-emerald-300/60 dark:border-emerald-700/60 bg-emerald-50 dark:bg-emerald-950/30')}>
                  <div className="font-semibold">{t('revealedHeader')}</div>
                  <div className="mt-1"><b>{t('resultWinner')}:</b> {state.winner === 'spy' ? (lang === 'th' ? 'สายลับ' : 'Spy') : state.winner === 'civ' ? (lang === 'th' ? 'ผู้เล่นทั่วไป' : 'Civilians') : '—'}</div>
                  <div className="mt-1"><b>{t('resultReason')}:</b> {state.winReason || '—'}</div>
                  <div className="mt-1"><b>{t('resultLocation')}:</b> {state.location || '—'}</div>
                  <div className="mt-1"><b>{t('resultSpies')}:</b> {spies.map(id => players.find(p => p.id === id)?.name || '-').join(', ')}</div>
                </div>
              )}

              <div className="grid sm:grid-cols-2 gap-4 w-full">
                <div className="space-y-3">

                  <div className="card p-4 sm:p-5">
                    <div className="flex-col items-center justify-between">
                      <div className="font-semibold">{t('info')}</div>
                      {isHost && state.phase === 'lobby' && (
                        <div className="flex items-center gap-2 text-sm mt-2">
                          <label className="whitespace-nowrap">{t('timer')}</label>
                          <input type="number" min={3} max={20} className="input w-24" value={duration} onChange={e => setDuration(parseInt(e.target.value || '8'))} />
                          <span className="opacity-60">{t('minutes')}</span>
                        </div>
                      )}
                    </div>

                    {isHost && state.phase === 'lobby' && (
                      <div className="flex items-center gap-2 mt-2">
                        <div>{t('mode')}:</div>
                        <div className="inline-flex rounded-full border border-slate-300/60 dark:border-slate-700/60 bg-slate-100 dark:bg-slate-900 p-0.5">
                          <button className={'px-2 py-1 rounded-full flex items-center gap-1 ' + (state.gameMode === 'classic' ? 'bg-white dark:bg-slate-800 shadow' : 'opacity-70')} onClick={() => api.setState({ gameMode: 'classic' })} title={`Classic (${t('spy')} 1)`}><span>🕵️</span><span>1</span></button>
                          <button className={'px-2 py-1 rounded-full flex items-center gap-1 ' + (players.length < 8 ? 'opacity-30 cursor-not-allowed' : (state.gameMode === 'double' ? 'bg-white dark:bg-slate-800 shadow' : 'opacity-70'))} onClick={() => { if (players.length >= 8) api.setState({ gameMode: 'double' }) }} title={`Double Spy (8+ → ${t('spy')} 2)`}><span>🕵️</span><span>2</span></button>
                        </div>
                      </div>
                    )}
                    {isHost && state.phase === 'lobby' && players.length < 8 && (
                      <div className="text-xs opacity-70 mt-1">{lang === 'th' ? 'ผู้เล่นยังไม่ถึง 8 — โหมดสปาย 2 คนถูกปิด' : 'Fewer than 8 players — Double Spy disabled'}</div>
                    )}

                    <div className="mt-2 space-y-2">
                      <div><b>{t('name')}:</b> {me.name}</div>
                      {state.phase !== 'lobby' ? (
                        isLateJoiner ? (
                          <div className="opacity-70">{lang === 'th' ? 'คุณเข้าระหว่างรอบนี้ ข้อมูลจะถูกซ่อนจนกว่าจะเริ่มรอบถัดไป' : 'You joined mid-round. Info is hidden until next round.'}</div>
                        ) : (
                          <>
                            <div><b>{t('role')}:</b> {isSpy ? <>🕵️ {t('spy')}</> : (myRole || '—')}</div>
                            {!isSpy && myRole && <div><b>{t('location')}:</b> {state.location}</div>}
                            {isSpy && state.phase === 'voting' && (
                              <div className="text-sm opacity-70 flex items-center gap-2 flex-wrap">
                                <span>{lang === 'th' ? 'ตัวเลือกของคุณ:' : 'Your pick:'}</span>
                                <b>{state.spyChoices?.[me.id] || (lang === 'th' ? 'ยังไม่เลือก' : 'not picked')}</b>
                                <button className="btn-outline text-xs" onClick={() => toast(lang === 'th' ? 'แตะชื่อสถานที่ด้านขวาเพื่อเดา' : 'Tap a location on the right to guess', 'info')}>{t('spyAcceptPick')}</button>
                              </div>
                            )}
                            {isSpy && <div className="opacity-70 italic">{lang === 'th' ? 'พยายามเดาสถานที่ก่อนจะถูกโหวตออก' : 'Try to guess the location before being voted out'}</div>}
                          </>
                        )
                      ) : (
                        <div className="opacity-70">{t('waitHost')}</div>
                      )}
                    </div>
                  </div>


                  <div className="card p-4 sm:p-5">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">👤{t('players')} ({players.length})</div>
                      <div className="text-md opacity-70 border border-slate-300/60 dark:border-slate-700/60 rounded-full px-3 py-1 font-bold">
                        {(state.phase === 'playing' || state.phase === 'voting' || state.phase === 'tie-guess') && (timeLeftMs > 0 ? `⏳ ${timeLeft}` : t('timeUp'))}
                      </div>
                    </div>
                    <ul className="mt-2 divide-y divide-slate-200/60 dark:divide-slate-700/60 text-sm max-h-[300px] overflow-auto p-2 sm:p-3">
                      {players.map(p => {
                        const late = state.phase !== 'lobby' && (joinAt[p.id] ?? 0) > roundStartAt
                        return (
                          <li key={p.id} className="py-2 flex items-center justify-between">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="badge">👱‍♂️ {p.name}</span>
                              {state.hostId === p.id && <span className="text-xs opacity-60">{t('host')}</span>}
                              {late && <span className="text-xs opacity-70">— {t('waitingNext')}</span>}
                              {spies.includes(p.id) && state.phase === 'revealed' && <span className="text-xs text-red-500">{t('spy')}</span>}
                            </div>

                            <div className="flex items-center gap-2">
                              {canVoteNow && iAmEligible && !isLateJoiner && p.id !== me.id && (joinAt[p.id] ?? 0) <= roundStartAt && (
                                (() => {
                                  const myVote = votes[me.id]?.target
                                  const myConfirmed = !!votes[me.id]?.confirmed
                                  const isSelected = myVote === p.id
                                  const handleClick = () => { if (!isSelected) api.vote(me.id, p.id); else if (!myConfirmed) api.confirmVote(me.id) }
                                  return (
                                    <button
                                      className={'text-xs btn ' + (isSelected ? (myConfirmed ? 'btn-outline' : 'btn-primary') : 'btn-outline')}
                                      onClick={handleClick}
                                      disabled={myConfirmed || state.phase !== 'voting'}
                                      title={myConfirmed ? '🔒' : isSelected ? (lang === 'th' ? 'กดอีกครั้งเพื่อยืนยัน' : 'Click again to confirm') : t('voteBtn')}
                                    >
                                      {myConfirmed ? '🔒' : (isSelected ? t('confirmVoteBtn') : t('voteBtn'))}
                                    </button>
                                  )
                                })()
                              )}

                              {(state.phase === 'lobby') && isHost && p.id !== me.id && (
                                <button className="text-xs btn-outline" onClick={() => kick(p.id)} title="Kick">Kick</button>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <div className="text-xs opacity-70">{confirmedCount}/{eligiblePlayers.length} {lang === 'th' ? 'ยืนยันแล้ว' : 'confirmed'}</div>
                      {state.phase === 'playing' && timeLeftMs > 0 && iAmEligible && !isLateJoiner && (
                        <button className={'btn-outline text-xs ' + (openVoteReq[me.id] === 1 ? 'opacity-60' : '')} onClick={() => api.requestOpenVote(me.id, !(openVoteReq[me.id] === 1))}>
                          {openVoteReq[me.id] === 1 ? `✓ ${t('calledVote')}` : t('callVote')}
                        </button>
                      )}
                      {(state.phase === 'voting' || (state.phase === 'playing' && timeLeftMs <= 0)) && (
                        <span className="text-xs px-2 py-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-200">{t('vote')}</span>
                      )}
                    </div>
                  </div>



                  <div className="card p-4 sm:p-5">
                    <div className="font-semibold">{t('chat')}</div>
                    <div ref={chatBoxRef} onScroll={onChatScroll} className="relative mt-2 h-64 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 p-2 text-sm bg-slate-50 dark:bg-rose-950/0">
                      {chat.map((m, i) => (<div key={i} className="mb-1"><b>{m.name}:</b> {m.text}</div>))}
                      {showScrollDown && (
                        <button onClick={() => { const el = chatBoxRef.current; if (el) { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }) } setShowScrollDown(false) }} className="absolute right-3 bottom-3 rounded-full shadow px-3 py-1 bg-slate-900 text-white dark:bg-white dark:text-slate-900">↓ {t('bottom')}</button>
                      )}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <input className="input" placeholder={t('typeMessage')} value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submitChat() }} />
                      <button className="btn-primary disabled:opacity-60" disabled={Date.now() < chatCooldownUntil} onClick={submitChat}>{t('send')}</button>
                    </div>
                    {Date.now() < chatCooldownUntil && (<div className="text-xs opacity-60 mt-1">{t('wait')}</div>)}
                  </div>
                </div>

                {/* Locations */}
                <div className="space-y-3">
                  <div className="card p-4 sm:p-5">
                    <h3 className="font-semibold mb-2 flex items-center justify-between">
                      <span>{t('allLocations')}</span>
                      {state.phase !== 'lobby' && !isSpy && (
                        <button className="btn-outline text-xs" onClick={() => setShowRoles(s => !s)}>{t('pickShownRoles')}</button>
                      )}
                    </h3>
                    <div className="mb-2 flex items-center gap-2 flex-wrap">
                      {isHost && state.phase === 'lobby' && (
                        <>
                          <button className="btn-outline" onClick={() => randomSelectLocations(filteredLocations.map(l => l.name))}>🔀 {t('shuffle')}</button>
                          <button className="btn-outline" onClick={clearLocations}>🧹 {t('clear')}</button>
                        </>
                      )}
                    </div>
                    {isHost && state.selectedLocations && state.selectedLocations.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-2">{state.selectedLocations.map(n => (<span key={n} className="badge">{n}</span>))}</div>
                    )}
                    {isHost && state.phase === 'lobby' && (<p className="text-xs mb-2 opacity-70">{t('pickUpTo10')}</p>)}
                    {pickError && <div className="text-xs text-red-500 mb-2">{pickError}</div>}

                    <div className="grid grid-cols-2 gap-2 text-sm max-h-[600px] overflow-auto p-2 sm:p-3">
                      {displayedLocations.map(l => {
                        const picked = (state.selectedLocations || []).includes(l.name)
                        const isMySpyPick = isSpy && (state.spyChoices?.[me.id] || null) === l.name
                        const canHostPick = isHost && state.phase === 'lobby'
                        const canSpyPick = isSpy && (state.phase === 'voting' || state.phase === 'tie-guess')
                        const showRolesList = showRoles && !isSpy

                        return (
                          <div
                            key={l.name}
                            className={'p-2 rounded-lg border select-none transition ' + ((canHostPick || canSpyPick) ? 'cursor-pointer ' : 'cursor-default ') + (picked && canHostPick ? 'border-emerald-500 ring-emerald-500/40 border-2 ' : 'border-slate-200 dark:border-slate-800 ') + (isMySpyPick ? 'ring-1 ring-blue-500/40 ' : '') + ' active:border-emerald-500 active:ring-emerald-500/40 active:border-2'}
                            role={(canHostPick || canSpyPick) ? 'button' : undefined}
                            tabIndex={(canHostPick || canSpyPick) ? 0 : -1}
                            onClick={() => {
                              if (canHostPick) togglePickLocation(l.name)
                              else if (canSpyPick) {
                                const next = { ...(state.spyChoices || {}) }; next[me.id] = l.name; api.setState({ spyChoices: next }); handleSpyPickWin(l.name)
                              }
                            }}
                            onKeyDown={(e) => {
                              if (!(canHostPick || canSpyPick)) return
                              if (e.key === 'Enter' || e.key === ' ') {
                                if (canHostPick) togglePickLocation(l.name)
                                else if (canSpyPick) {
                                  const next = { ...(state.spyChoices || {}) }; next[me.id] = l.name; api.setState({ spyChoices: next }); handleSpyPickWin(l.name)
                                }
                              }
                            }}
                          >
                            <div className="flex items-start gap-2">
                              <div>
                                <div className="font-medium">{l.name}</div>
                                {(state.phase === 'lobby' || showRolesList) && (<div className="text-xs opacity-70 line-clamp-2 sm:line-clamp-none">{l.roles.join(', ')}</div>)}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )
      }

      {/* <DiscordWidget serverId="1369627876118237238" /> */}

      <footer className="flex gap-2 justify-center mt-6 text-center text-xs opacity-60">{t('footer')} <a href="https://discord.gg/vN883BUGKU" target='_blank'><SiDiscord size={18} /></a> </footer>
    </main >
  )
}
