import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // During `npm run dev`, forward API calls to a backend running locally on port 3000.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
