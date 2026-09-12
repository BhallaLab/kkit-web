import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Served under /kkit/ by nginx (a sibling location to jardesigner's own
  // /jardesigner/), so built asset paths need to match that subpath rather
  // than assuming the domain root.
  base: '/kkit/',
})
