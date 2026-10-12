import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Package the actual Astro build as self-contained pages for offline design review.
// Images and fonts retain their original bytes. Site interactions stay unchanged.
const project = process.cwd();
const dist = path.join(project, 'dist');
const preview = path.join(project, 'preview');
const resources = new Map();
const basePath = '/kansai/';
const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else files.push(file);
  }
  return files;
}

const allFiles = await walk(dist);
for (const file of allFiles) {
  const type = mime[path.extname(file)];
  if (!type) continue;
  const url = '/' + path.relative(dist, file).split(path.sep).join('/');
  resources.set(url, `data:${type};base64,${(await readFile(file)).toString('base64')}`);
}

function resource(url) {
  const normalized = url.startsWith(basePath) ? '/' + url.slice(basePath.length) : url;
  const content = resources.get(normalized);
  if (!content) throw new Error(`Missing build resource: ${url}`);
  return content;
}

for (const file of allFiles.filter(file => file.endsWith('.html'))) {
  const relative = path.relative(dist, file);
  const relativeDirectory = path.posix.dirname(relative.split(path.sep).join('/'));
  let html = await readFile(file, 'utf8');
  const styleTags = [...html.matchAll(/<link\b(?=[^>]*rel="stylesheet")[^>]*>/g)];
  for (const match of styleTags) {
    const href = match[0].match(/href="([^"]+)"/)?.[1];
    if (!href) continue;
    const stylePath = href.startsWith(basePath) ? href.slice(basePath.length) : href.replace(/^\//, '');
    let css = await readFile(path.join(dist, stylePath), 'utf8');
    css = css.replace(/url\((['"]?)(\/[^)'"\s]*assets\/[^)'"\s]+)\1\)/g, (_, quote, url) => `url("${resource(url)}")`);
    html = html.replace(match[0], `<style>${css}</style>`);
  }
  html = html.replace(/\b(src|href|data-image)="(\/[^"\s]*assets\/[^"]+)"/g, (_, attribute, url) => `${attribute}="${resource(url)}"`);
  html = html.replace(/href="(\/[^"#]*)(#[^"]*)?"/g, (_, url, fragment = '') => {
    if (url.startsWith(basePath)) url = '/' + url.slice(basePath.length);
    const target = url === '/' ? 'index.html' : url.replace(/^\//, '').replace(/\/$/, '') + '/index.html';
    const local = path.posix.relative(relativeDirectory, target) || 'index.html';
    return `href="${local}${fragment}"`;
  });
  if (/\b(?:src|data-image)="\//.test(html) || /<link\b[^>]*rel="stylesheet"/.test(html)) {
    throw new Error(`External build resource left in ${relative}`);
  }
  const target = path.join(preview, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, html);
  console.log(`Offline preview: ${relative}`);
}
