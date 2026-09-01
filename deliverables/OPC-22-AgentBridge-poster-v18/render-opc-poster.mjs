import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bundledModules = 'C:/Users/_/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const sharp = require(path.join(bundledModules, 'sharp'));
const { chromium } = require(path.join(bundledModules, 'playwright'));

sharp.cache(false);

const source = path.resolve(process.argv[2] ?? 'OPC-22-AgentBridge-1200x2000-v13.svg');
const outputDir = path.resolve(process.argv[3] ?? path.dirname(source));
const basename = 'OPC-22-AgentBridge-1200x2000-v18';
const previewPath = path.join(outputDir, `${basename}-preview-1800x3000.png`);
const pdfPath = path.join(outputDir, `${basename}.pdf`);

fs.mkdirSync(outputDir, { recursive: true });

await sharp(source, { density: 38.1, limitInputPixels: false })
  .resize(1800, 3000, { fit: 'fill' })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .withMetadata({ density: 38 })
  .toFile(previewPath);

const edgeCandidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const executablePath = edgeCandidates.find((candidate) => fs.existsSync(candidate));
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 2000 }, deviceScaleFactor: 1 });
  const svgMarkup = fs.readFileSync(source, 'utf8').replace(/^<\?xml[^>]*>\s*/u, '');
  await page.setContent(`<!doctype html>
    <html><head><meta charset="utf-8"><style>
      @page { size: 1200mm 2000mm; margin: 0; }
      html, body { width: 1200mm; height: 2000mm; margin: 0; padding: 0; background: #EDF5F9; }
      svg { display: block; width: 1200mm; height: 2000mm; }
    </style></head><body>${svgMarkup}</body></html>`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: pdfPath,
    width: '1200mm',
    height: '2000mm',
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    printBackground: true,
    preferCSSPageSize: true,
  });
} finally {
  await browser.close();
}

console.log(JSON.stringify({ source, previewPath, pdfPath }, null, 2));
