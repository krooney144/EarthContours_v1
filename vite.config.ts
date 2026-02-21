import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite configuration for EarthContours
// Using the React plugin for JSX transform and Fast Refresh during development
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // Expose to network so it can be accessed from local IP too
    open: false,
  },
  build: {
    target: 'es2020',
    sourcemap: true, // Keep source maps for debugging
  },
  // Allow top-level await (needed for some async data loading patterns)
  esbuild: {
    target: 'es2020',
  },
})
