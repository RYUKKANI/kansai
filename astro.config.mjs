import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://ryukkani.github.io',
  base: '/kansai/',
  trailingSlash: 'always',
  output: 'static',
  vite: { plugins: [tailwindcss()] },
});
