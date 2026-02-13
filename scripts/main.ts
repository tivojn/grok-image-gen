#!/usr/bin/env bun
/**
 * Grok Image Generator - Generate images using Grok AI on x.com
 * Uses Chrome CDP to automate the Grok interface.
 * Pattern based on baoyu-post-to-x/scripts/x-browser.ts
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { mkdir } from 'node:fs/promises';

import {
  CdpConnection,
  findChromeExecutable,
  getDefaultProfileDir,
  getExistingDebugPort,
  getFreePort,
  waitForChromeDebugPort,
  sleep,
  downloadImage,
} from './grok-utils.js';

const GROK_URL = 'https://x.com/i/grok';

type CliArgs = {
  prompt: string | null;
  output: string;
  all: boolean;
  timeout: number;
  profile: string | null;
  json: boolean;
  help: boolean;
  reference: string[];
};

function printUsage(): void {
  console.log(`Grok Image Generator - Generate images using Grok AI on x.com

Usage:
  npx -y bun main.ts "A futuristic cityscape"
  npx -y bun main.ts --prompt "A cute robot" --output robot.png
  npx -y bun main.ts "Abstract art" --output art.png --all

Options:
  <text>              Image generation prompt (positional)
  -p, --prompt <text> Prompt text
  -r, --reference <path> Reference image for Grok (repeatable for multiple)
  -o, --output <path> Output image path (default: grok-image.png)
  --all               Save all generated images (numbered)
  --timeout <secs>    Max wait time in seconds (default: 120)
  --profile <dir>     Custom Chrome profile directory
  --json              Output JSON with image URLs and paths
  -h, --help          Show help`);
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    prompt: null,
    output: 'grok-image.png',
    all: false,
    timeout: 120,
    profile: null,
    json: false,
    help: false,
    reference: [],
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;

    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--all') { out.all = true; continue; }

    if (a === '--prompt' || a === '-p') {
      const v = argv[++i];
      if (!v) throw new Error(`Missing value for ${a}`);
      out.prompt = v;
      continue;
    }

    if (a === '--output' || a === '-o') {
      const v = argv[++i];
      if (!v) throw new Error(`Missing value for ${a}`);
      out.output = v;
      continue;
    }

    if (a === '--timeout') {
      const v = argv[++i];
      if (!v) throw new Error('Missing value for --timeout');
      out.timeout = parseInt(v, 10);
      continue;
    }

    if (a === '--profile') {
      const v = argv[++i];
      if (!v) throw new Error('Missing value for --profile');
      out.profile = v;
      continue;
    }

    if (a === '--reference' || a === '-r') {
      const v = argv[++i];
      if (!v) throw new Error(`Missing value for ${a}`);
      out.reference.push(v);
      continue;
    }

    if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    positional.push(a);
  }

  if (!out.prompt && positional.length > 0) {
    out.prompt = positional.join(' ');
  }

  return out;
}

/** Evaluate JS in the page via CDP session */
async function evaluate<T = unknown>(cdp: CdpConnection, sessionId: string, expression: string): Promise<T> {
  const result = await cdp.send<{
    result: { type: string; value?: unknown; description?: string };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, { sessionId });

  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(`JS error: ${detail}`);
  }

  return result.result.value as T;
}

/** Evaluate JS and return remote object ID (for DOM elements that can't be serialized by value) */
async function evaluateHandle(cdp: CdpConnection, sessionId: string, expression: string): Promise<string | null> {
  const result = await cdp.send<{
    result: { type: string; subtype?: string; objectId?: string };
    exceptionDetails?: { text: string };
  }>('Runtime.evaluate', {
    expression,
    awaitPromise: false,
    returnByValue: false,
  }, { sessionId });

  if (result.exceptionDetails) return null;
  if (result.result.subtype === 'null' || result.result.type === 'undefined') return null;
  return result.result.objectId || null;
}

/** Upload reference images to Grok's chat input by directly setting files on the hidden input */
async function uploadReferenceImages(
  cdp: CdpConnection,
  sessionId: string,
  imagePaths: string[],
  _foundSelector: string,
): Promise<void> {
  const absPaths = imagePaths.map((p) => {
    // Expand ~ to home directory (shell doesn't expand when path is quoted)
    const expanded = p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
    return path.resolve(expanded);
  });
  for (const p of absPaths) {
    if (!fs.existsSync(p)) throw new Error(`Reference image not found: ${p}`);
  }

  console.error(`[grok] Uploading ${absPaths.length} reference image(s)...`);

  // Enable file chooser interception to suppress any native OS dialogs that may be triggered
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, { sessionId });

  // Catch-all handler: if a file chooser dialog is triggered by React in response
  // to our DOM.setFileInputFiles call, cancel it immediately
  cdp.on('Page.fileChooserOpened', async (params: unknown) => {
    try {
      const p = params as { backendNodeId?: number };
      if (p.backendNodeId) {
        // Cancel the dialog by sending an empty file list
        await cdp.send('DOM.setFileInputFiles', {
          files: [],
          backendNodeId: p.backendNodeId,
        }, { sessionId });
      }
    } catch {}
  });

  // Find the hidden file input element directly and set files on it.
  // Grok's UI has hidden <input type="file"> elements - we target the image-accepting one.
  const fileInputObjId = await evaluateHandle(cdp, sessionId, `
    (() => {
      // Find all file inputs
      const inputs = document.querySelectorAll('input[type="file"]');
      // Prefer the one that accepts images
      for (const inp of inputs) {
        const accept = (inp.getAttribute('accept') || '').toLowerCase();
        if (accept.includes('image')) return inp;
      }
      // Fallback: return first file input
      return inputs.length > 0 ? inputs[0] : null;
    })()
  `);

  if (!fileInputObjId) {
    try { await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }, { sessionId }); } catch {}
    throw new Error(
      'Could not find file input element in Grok UI. ' +
      'The Grok interface may have changed or image upload may not be available.'
    );
  }

  console.error('[grok] Found file input, setting files directly...');

  // CRITICAL: Before setting files, neuter the file input's click() method.
  // When DOM.setFileInputFiles fires a change event, React's handler calls input.click()
  // which opens a native OS file dialog. By replacing click() with a no-op, we prevent that.
  await evaluate(cdp, sessionId, `
    (() => {
      const inputs = document.querySelectorAll('input[type="file"]');
      for (const inp of inputs) {
        inp._origClick = inp.click;
        inp.click = function() {};
      }
    })()
  `);

  // Use DOM.setFileInputFiles to set files directly on the input element.
  await cdp.send('DOM.setFileInputFiles', {
    files: absPaths,
    objectId: fileInputObjId,
  }, { sessionId });

  console.error('[grok] Files set on input element');

  // Wait for React to process the change event and show thumbnails
  await sleep(3000);

  // Restore the original click() method on all file inputs
  await evaluate(cdp, sessionId, `
    (() => {
      const inputs = document.querySelectorAll('input[type="file"]');
      for (const inp of inputs) {
        if (inp._origClick) {
          inp.click = inp._origClick;
          delete inp._origClick;
        }
      }
    })()
  `);

  // Disable file chooser interception
  try { await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }, { sessionId }); } catch {}

  console.error('[grok] Reference image(s) attached successfully');
  await sleep(1000);
}

/** Wait for element matching selector */
async function waitForSelector(cdp: CdpConnection, sessionId: string, selector: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await evaluate<boolean>(cdp, sessionId, `!!document.querySelector(${JSON.stringify(selector)})`);
    if (found) return true;
    await sleep(500);
  }
  return false;
}

/** Extract generated image URLs from Grok's response */
async function extractImageUrls(cdp: CdpConnection, sessionId: string): Promise<string[]> {
  return evaluate<string[]>(cdp, sessionId, `
    (() => {
      const urls = [];
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.src || '';
        if (!src || src.startsWith('data:')) continue;
        // Filter for Grok-generated images (typically from pbs.twimg.com or similar CDN)
        const isLarge = (img.naturalWidth >= 200 || img.width >= 200 || img.height >= 200 || img.naturalHeight >= 200);
        if (!isLarge && img.complete) continue;
        // Skip known non-generated images
        if (src.includes('profile_images') ||
            src.includes('emoji') ||
            src.includes('icon') ||
            src.includes('logo') ||
            src.includes('avatar') ||
            src.includes('hashflag') ||
            src.includes('amplify_video_thumb') ||
            src.includes('/ext_tw_video_thumb/')) continue;
        // Keep images that look generated (CDN hosted, large)
        if (src.includes('pbs.twimg.com') ||
            src.includes('ton.twitter.com') ||
            src.includes('blob:') ||
            isLarge) {
          urls.push(src);
        }
      }
      return [...new Set(urls)];
    })()
  `);
}

/** Score images using canvas pixel analysis to auto-pick the best one */
async function scoreImages(cdp: CdpConnection, sessionId: string, urls: string[]): Promise<{ url: string; score: number; reason: string }[]> {
  return evaluate<{ url: string; score: number; reason: string }[]>(cdp, sessionId, `
    (async () => {
      const urls = ${JSON.stringify(urls)};
      const results = [];

      for (const url of urls) {
        try {
          const score = await new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
              const canvas = document.createElement('canvas');
              const ctx = canvas.getContext('2d');
              const w = Math.min(img.naturalWidth || img.width, 320);
              const h = Math.min(img.naturalHeight || img.height, 320);
              canvas.width = w;
              canvas.height = h;
              ctx.drawImage(img, 0, 0, w, h);

              let data;
              try { data = ctx.getImageData(0, 0, w, h).data; }
              catch { resolve({ resolution: 0, colorVariance: 0, detail: 0, uniqueColors: 0, score: 0, reason: 'canvas tainted' }); return; }

              const n = data.length / 4;

              // 1. Resolution
              const res = (img.naturalWidth || img.width) * (img.naturalHeight || img.height);

              // 2. Color variance (std dev of RGB channels)
              let sR = 0, sG = 0, sB = 0, sR2 = 0, sG2 = 0, sB2 = 0;
              for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i+1], b = data[i+2];
                sR += r; sG += g; sB += b;
                sR2 += r*r; sG2 += g*g; sB2 += b*b;
              }
              const varR = sR2/n - (sR/n)**2;
              const varG = sG2/n - (sG/n)**2;
              const varB = sB2/n - (sB/n)**2;
              const colorVar = Math.sqrt(Math.max(0,varR) + Math.max(0,varG) + Math.max(0,varB));

              // 3. Detail score (avg adjacent pixel diff — edge/texture density)
              let detailSum = 0, dc = 0;
              for (let y = 0; y < h; y++) {
                for (let x = 0; x < w - 1; x++) {
                  const i = (y * w + x) * 4;
                  const j = i + 4;
                  detailSum += Math.abs(data[i]-data[j]) + Math.abs(data[i+1]-data[j+1]) + Math.abs(data[i+2]-data[j+2]);
                  dc++;
                }
              }
              const detail = detailSum / (dc || 1);

              // 4. Unique color buckets (quantized to 4-bit per channel)
              const colorSet = new Set();
              for (let i = 0; i < data.length; i += 16) {
                colorSet.add((data[i]>>4) + ',' + (data[i+1]>>4) + ',' + (data[i+2]>>4));
              }
              const uniq = colorSet.size;

              // 5. Saturation score (prefer vibrant over washed-out)
              let satSum = 0;
              for (let i = 0; i < data.length; i += 16) {
                const r = data[i]/255, g = data[i+1]/255, b = data[i+2]/255;
                const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
                satSum += mx > 0 ? (mx-mn)/mx : 0;
              }
              const avgSat = satSum / (data.length / 16);

              // Composite: weighted sum
              const composite = (colorVar * 2) + (detail * 3) + (uniq * 0.5) + (res / 10000) + (avgSat * 100);

              const reasons = [];
              if (colorVar > 60) reasons.push('rich colors');
              if (detail > 20) reasons.push('high detail');
              if (uniq > 500) reasons.push('diverse palette');
              if (avgSat > 0.3) reasons.push('vibrant');
              if (res > 1000000) reasons.push('high-res');

              resolve({ resolution: res, colorVariance: colorVar, detail, uniqueColors: uniq, saturation: avgSat, score: composite, reason: reasons.join(', ') || 'baseline' });
            };
            img.onerror = () => resolve({ resolution: 0, colorVariance: 0, detail: 0, uniqueColors: 0, saturation: 0, score: 0, reason: 'load failed' });
            img.src = url;
          });
          results.push({ url, ...score });
        } catch {
          results.push({ url, score: 0, reason: 'error' });
        }
      }
      return results;
    })()
  `);
}

/** Check if Grok is still generating */
async function isGenerating(cdp: CdpConnection, sessionId: string): Promise<boolean> {
  return evaluate<boolean>(cdp, sessionId, `
    (() => {
      // Check for any loading/progress indicators
      if (document.querySelector('[role="progressbar"]')) return true;
      if (document.querySelector('.animate-spin')) return true;

      // Check for streaming/thinking indicators by checking if there are any animated elements
      const animations = document.getAnimations();
      for (const a of animations) {
        const target = a.effect?.target;
        if (target && target.closest && target.closest('[class*="message"], [class*="response"], [class*="chat"]')) {
          return true;
        }
      }

      return false;
    })()
  `);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (!args.prompt) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const profileDir = args.profile || getDefaultProfileDir();
  await mkdir(profileDir, { recursive: true });

  // Try to reuse existing Chrome instance (same pattern as x-article.ts)
  let port: number;
  let ownedChrome = false;
  let chrome: ReturnType<typeof spawn> | null = null;

  const existingPort = await getExistingDebugPort(profileDir);
  if (existingPort) {
    console.error(`[grok] Reusing existing Chrome (port: ${existingPort})`);
    port = existingPort;
  } else {
    const chromePath = findChromeExecutable();
    if (!chromePath) throw new Error('Chrome not found. Set GROK_CHROME_PATH env var.');

    port = await getFreePort();
    console.error(`[grok] Launching Chrome (profile: ${profileDir})`);

    chrome = spawn(chromePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      GROK_URL,
    ], { stdio: 'ignore' });

    chrome.unref();
    ownedChrome = true;
  }

  let cdp: CdpConnection | null = null;
  let grokTargetId: string | null = null;

  try {
    const wsUrl = await waitForChromeDebugPort(port, 30_000);
    cdp = await CdpConnection.connect(wsUrl, 30_000, { defaultTimeoutMs: 30_000 });

    // Close any leftover Grok tabs from previous runs
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets', {});
      const staleGrokTabs = targetInfos.filter((t) => t.type === 'page' && t.url.includes('/i/grok'));
      if (staleGrokTabs.length > 0) {
        console.error(`[grok] Closing ${staleGrokTabs.length} stale Grok tab(s)...`);
        for (const tab of staleGrokTabs) {
          try { await cdp.send('Target.closeTarget', { targetId: tab.targetId }); } catch {}
        }
      }
    } catch {}

    // Create a fresh tab for Grok
    console.error('[grok] Opening new Grok tab...');
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: GROK_URL });
    grokTargetId = targetId;

    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });

    await cdp.send('Page.enable', {}, { sessionId });
    await cdp.send('Runtime.enable', {}, { sessionId });
    await cdp.send('DOM.enable', {}, { sessionId });

    console.error('[grok] Waiting for Grok to load...');
    await sleep(5000);

    // Look for Grok's chat input
    const inputSelectors = [
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="ask"]',
      'textarea[placeholder*="Grok"]',
      'textarea[placeholder*="grok"]',
      'textarea[placeholder*="anything"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea',
    ];

    let foundSelector: string | null = null;
    console.error('[grok] Looking for chat input...');

    for (const sel of inputSelectors) {
      const found = await waitForSelector(cdp, sessionId, sel, 8_000);
      if (found) {
        foundSelector = sel;
        break;
      }
    }

    if (!foundSelector) {
      // Check if we're on a login page
      const onLogin = await evaluate<boolean>(cdp, sessionId, `
        window.location.href.includes('/login') || window.location.href.includes('/flow/login')
      `);

      if (onLogin) {
        console.error('[grok] Not logged in. Please log in to X in the browser window.');
        console.error('[grok] Waiting for login (up to 120s)...');

        // Wait for redirect back to Grok after login
        const loginDeadline = Date.now() + 120_000;
        while (Date.now() < loginDeadline) {
          const url = await evaluate<string>(cdp, sessionId, 'window.location.href');
          if (url.includes('/i/grok')) break;
          await sleep(2000);
        }

        await sleep(3000);
        // Try finding input again
        for (const sel of inputSelectors) {
          const found = await waitForSelector(cdp, sessionId, sel, 5_000);
          if (found) {
            foundSelector = sel;
            break;
          }
        }
      }

      // Last resort: find any textarea or contenteditable
      if (!foundSelector) {
        foundSelector = await evaluate<string | null>(cdp, sessionId, `
          (() => {
            const ta = document.querySelector('textarea');
            if (ta) return 'textarea';
            const ce = document.querySelector('[contenteditable="true"]');
            if (ce) return '[contenteditable="true"]';
            return null;
          })()
        `);
      }

      if (!foundSelector) {
        throw new Error(
          'Could not find Grok chat input. Make sure you are logged in to x.com.'
        );
      }
    }

    console.error(`[grok] Found input: ${foundSelector}`);

    // Focus the textarea and click it
    await evaluate(cdp, sessionId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(foundSelector)});
        if (el) { el.focus(); el.click(); }
      })()
    `);
    await sleep(500);

    // Upload reference images if provided (before typing the prompt)
    if (args.reference.length > 0) {
      await uploadReferenceImages(cdp, sessionId, args.reference, foundSelector);
      // Re-focus the text input after upload (focus may have shifted)
      await evaluate(cdp, sessionId, `
        (() => {
          const el = document.querySelector(${JSON.stringify(foundSelector)});
          if (el) { el.focus(); el.click(); }
        })()
      `);
      await sleep(500);
    }

    // Count existing images AFTER upload (so reference thumbnails are excluded from "new" detection)
    const beforeImageUrls = await extractImageUrls(cdp, sessionId);
    const beforeCount = beforeImageUrls.length;

    // Auto-prefix for image generation if prompt doesn't mention images
    // Skip auto-prefix when reference images are attached (user intent is already clear)
    const lowerPrompt = args.prompt.toLowerCase();
    const hasReference = args.reference.length > 0;
    const isImagePrompt = hasReference || ['image', 'picture', 'draw', 'create', 'generate', 'paint', 'illustration', 'photo', 'make'].some(
      (kw) => lowerPrompt.includes(kw)
    );
    const finalPrompt = isImagePrompt ? args.prompt : `Generate an image of: ${args.prompt}`;

    // Use CDP Input.insertText - this properly triggers React's onChange handlers
    console.error('[grok] Typing prompt...');
    await cdp.send('Input.insertText', { text: finalPrompt }, { sessionId });
    await sleep(1000);

    console.error('[grok] Clicking send button...');

    // Click the send button by dispatching a real mouse click on it
    // First, get the send button's position
    // The send button has aria-label containing "Grok" (e.g. "Grok something")
    // The attachment button has NO aria-label - so we must skip it
    const sendBtnInfo = await evaluate<{ x: number; y: number; found: boolean; method: string }>(cdp, sessionId, `
      (() => {
        const textarea = document.querySelector(${JSON.stringify(foundSelector)});
        if (!textarea) return { x: 0, y: 0, found: false, method: 'no textarea' };

        // Walk up to find the container with buttons
        let container = textarea.parentElement;
        for (let i = 0; i < 6 && container; i++) {
          const btns = container.querySelectorAll('button');
          for (const b of btns) {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            // The send button has aria-label containing "grok"
            if (aria.includes('grok')) {
              const rect = b.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, found: true, method: 'aria-grok' };
              }
            }
          }
          container = container.parentElement;
        }

        // Fallback: find the LAST SVG button near textarea (send is typically after attachment)
        container = textarea.parentElement;
        for (let i = 0; i < 6 && container; i++) {
          const btns = Array.from(container.querySelectorAll('button'));
          let lastSvgBtn = null;
          for (const b of btns) {
            if (b.querySelector('svg') || b.querySelector('path')) {
              const rect = b.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) lastSvgBtn = b;
            }
          }
          if (lastSvgBtn) {
            const rect = lastSvgBtn.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, found: true, method: 'last-svg' };
          }
          container = container.parentElement;
        }

        return { x: 0, y: 0, found: false, method: 'not found' };
      })()
    `);

    if (sendBtnInfo.found) {
      // Dispatch real mouse events at the button coordinates
      for (const type of ['mousePressed', 'mouseReleased'] as const) {
        await cdp.send('Input.dispatchMouseEvent', {
          type,
          x: sendBtnInfo.x,
          y: sendBtnInfo.y,
          button: 'left',
          clickCount: 1,
        }, { sessionId });
        await sleep(50);
      }
      console.error('[grok] Send button clicked via mouse event');
    } else {
      console.error('[grok] Send button not found, trying Enter...');
      // Fallback: press Enter
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      }, { sessionId });
      await sleep(50);
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      }, { sessionId });
    }

    await sleep(3000);

    // Wait for images to appear
    console.error('[grok] Waiting for Grok to generate images...');
    const deadline = Date.now() + args.timeout * 1000;
    let imageUrls: string[] = [];
    let lastNewCount = 0;
    let stableChecks = 0;

    while (Date.now() < deadline) {
      const generating = await isGenerating(cdp, sessionId);
      const currentUrls = await extractImageUrls(cdp, sessionId);

      // Only count NEW images (ones not present before we sent the prompt)
      const newUrls = currentUrls.filter((u) => !beforeImageUrls.includes(u));

      if (newUrls.length > lastNewCount) {
        lastNewCount = newUrls.length;
        stableChecks = 0;
        console.error(`[grok] Found ${newUrls.length} new image(s)...`);
      } else if (newUrls.length > 0 && !generating) {
        stableChecks++;
        if (stableChecks >= 3) {
          imageUrls = newUrls;
          break;
        }
      }

      if (newUrls.length > 0) {
        imageUrls = newUrls;
      }

      await sleep(2000);
    }

    if (imageUrls.length === 0) {
      // Final broad attempt
      imageUrls = await evaluate<string[]>(cdp, sessionId, `
        (() => {
          const urls = [];
          for (const img of document.querySelectorAll('img')) {
            const src = img.src || '';
            if (src.startsWith('https://') && (img.naturalWidth >= 256 || img.width >= 256)) {
              if (!src.includes('profile_images') && !src.includes('emoji') &&
                  !src.includes('icon') && !src.includes('logo') && !src.includes('avatar')) {
                urls.push(src);
              }
            }
          }
          return [...new Set(urls)];
        })()
      `);
      // Filter out pre-existing
      imageUrls = imageUrls.filter((u) => !beforeImageUrls.includes(u));
    }

    if (imageUrls.length === 0) {
      // Check if Grok responded with text instead of images
      const responseText = await evaluate<string>(cdp, sessionId, `
        (() => {
          const msgs = document.querySelectorAll('[data-testid*="message"], [class*="message"]');
          if (msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            return (last.textContent || '').slice(0, 200);
          }
          return '';
        })()
      `);
      throw new Error(
        `No images generated. Grok may have responded with text instead.\n` +
        (responseText ? `Response preview: "${responseText}"` : 'No response detected.')
      );
    }

    console.error(`\n[grok] Found ${imageUrls.length} image(s).`);

    // Download images via the browser context (they need auth cookies)
    async function downloadViaPage(url: string, filePath: string): Promise<void> {
      const base64 = await evaluate<string | null>(cdp!, sessionId, `
        (async () => {
          try {
            const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const blob = await res.blob();
            const buf = await blob.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return btoa(binary);
          } catch (e) {
            return null;
          }
        })()
      `);
      if (!base64) throw new Error(`Failed to download ${url} via browser`);
      const buffer = Buffer.from(base64, 'base64');
      await fs.promises.writeFile(filePath, buffer);
    }

    // Auto-pick best image when multiple are available and --all is not set
    let selectedUrls = imageUrls;
    if (!args.all && imageUrls.length > 1) {
      console.error(`[grok] Scoring ${imageUrls.length} images to auto-pick best...`);
      try {
        const scores = await scoreImages(cdp, sessionId, imageUrls);
        scores.sort((a, b) => b.score - a.score);
        for (let i = 0; i < scores.length; i++) {
          const s = scores[i]!;
          const tag = i === 0 ? ' <-- BEST' : '';
          console.error(`[grok]   #${i + 1}: score=${s.score.toFixed(1)} (${s.reason})${tag}`);
        }
        selectedUrls = [scores[0]!.url];
      } catch (err) {
        console.error(`[grok] Scoring failed, using first image: ${err instanceof Error ? err.message : err}`);
        selectedUrls = [imageUrls[0]!];
      }
    }

    const outputPath = path.resolve(args.output);
    const outputDir = path.dirname(outputPath);
    const ext = path.extname(outputPath) || '.png';
    const baseName = path.basename(outputPath, ext);
    await mkdir(outputDir, { recursive: true });

    const savedPaths: string[] = [];

    if (args.all) {
      console.error('[grok] Downloading all images...');
      for (let i = 0; i < imageUrls.length; i++) {
        const imgPath = imageUrls.length === 1
          ? outputPath
          : path.join(outputDir, `${baseName}-${i + 1}${ext}`);
        try {
          await downloadViaPage(imageUrls[i]!, imgPath);
          savedPaths.push(imgPath);
          console.error(`[grok] Saved: ${imgPath}`);
        } catch (err) {
          console.error(`[grok] Failed to download image ${i + 1}: ${err instanceof Error ? err.message : err}`);
        }
      }
    } else {
      console.error('[grok] Downloading best image...');
      await downloadViaPage(selectedUrls[0]!, outputPath);
      savedPaths.push(outputPath);
      console.error(`[grok] Saved: ${outputPath}`);
    }

    if (args.json) {
      console.log(JSON.stringify({
        prompt: args.prompt,
        finalPrompt,
        imageUrls,
        savedPaths,
        count: imageUrls.length,
      }, null, 2));
    } else {
      for (const p of savedPaths) {
        console.log(p);
      }
    }

    // Brief pause so user can see result
    await sleep(2000);
  } finally {
    if (cdp) {
      // Close the Grok tab we opened (prevents tab buildup)
      if (grokTargetId) {
        try { await cdp.send('Target.closeTarget', { targetId: grokTargetId }, { timeoutMs: 5_000 }); } catch {}
      }
      if (ownedChrome) {
        // Only close browser if we launched it
        try { await cdp.send('Browser.close', {}, { timeoutMs: 5_000 }); } catch {}
      }
      cdp.close();
    }
    if (chrome && ownedChrome) {
      setTimeout(() => {
        if (!chrome!.killed) try { chrome!.kill('SIGKILL'); } catch {}
      }, 2_000).unref?.();
      try { chrome.kill('SIGTERM'); } catch {}
    }
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
