import { create } from 'zustand'

type Me = {
  id: string
  name: string
}

type Store = {
  me: Me
  setMe: (m: Me) => void
}

export const useStore = create<Store>((set) => ({
  me: { id: '', name: '' },
  setMe: (me) => set({ me }),
}))
