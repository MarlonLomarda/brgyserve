import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // loadEnv reads the .env files AND inlines any VITE_-prefixed variables
  // already in process.env — which is how Vercel supplies them — so this sees
  // exactly what the build would bake into the bundle.
  const env = loadEnv(mode, process.cwd(), 'VITE_')

  // A build with VITE_API_URL unset used to succeed and fall back to
  // http://localhost:5000/api (src/api/config.js). Nothing warned: the deploy
  // went green and every request failed in the browser, pointing at a machine
  // that is not there. Fail the build instead, where someone is looking.
  //
  // Keyed on `command`, not `mode`: any build produces a deployable artifact,
  // so any build must name its API explicitly. The dev server (command
  // 'serve') is untouched and keeps the localhost fallback.
  if (command === 'build' && !env.VITE_API_URL) {
    throw new Error(
      [
        'VITE_API_URL is not set, so this build would point at http://localhost:5000/api.',
        '',
        '  Vercel:  add VITE_API_URL to the project\'s Environment Variables —',
        '           the deployed API origin including the /api suffix,',
        '           e.g. https://brgyserve-api.onrender.com/api',
        '  Locally: create frontend/.env containing',
        '           VITE_API_URL=http://localhost:5000/api   (see .env.example)',
        '',
        'The localhost fallback exists only for `npm run dev`.',
      ].join('\n'),
    )
  }

  return {
    plugins: [react()],
  }
})
