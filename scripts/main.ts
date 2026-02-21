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
const GROK_IMAGINE_URL = 'https://grok.com/imagine';

type CliArgs = {
  prompt: string | null;
  output: string;
  all: boolean;
  timeout: number;
  profile: string | null;
  json: boolean;
  help: boolean;
  reference: string[];
  video: boolean;
  aspect: string | null;
};

function printUsage(): void {
  console.log(`Grok Image Generator - Generate images/videos using Grok AI

Usage:
  npx -y bun main.ts "A futuristic cityscape"
  npx -y bun main.ts --prompt "A cute robot" --output robot.png
  npx -y bun main.ts "Abstract art" --output art.png --all
  npx -y bun main.ts --video "A cat playing piano" --output cat.mp4
  npx -y bun main.ts --video --aspect 16:9 "Ocean waves" --output waves.mp4

Options:
  <text>              Generation prompt (positional)
  -p, --prompt <text> Prompt text
  -r, --reference <path> Reference image (repeatable for multiple)
  -o, --output <path> Output path (default: grok-image.png, or grok-video.mp4 with --video)
  --all               Save all generated images (numbered)
  --video             Generate video instead of image (uses grok.com/imagine)
  --aspect <ratio>    Aspect ratio: 2:3, 3:2, 1:1, 9:16, 16:9 (video/imagine mode)
  --timeout <secs>    Max wait time in seconds (default: 120, 300 for video)
  --profile <dir>     Custom Chrome profile directory
  --json              Output JSON with URLs and paths
  -h, --help          Show help`);
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    prompt: null,
    output: '',
    all: false,
    timeout: 0,
    profile: null,
    json: false,
    help: false,
    reference: [],
    video: false,
    aspect: null,
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

    if (a === '--video') { out.video = true; continue; }

    if (a === '--aspect') {
      const v = argv[++i];
      if (!v) throw new Error('Missing value for --aspect');
      const valid = ['2:3', '3:2', '1:1', '9:16', '16:9'];
      if (!valid.includes(v)) throw new Error(`Invalid aspect ratio: ${v}. Valid: ${valid.join(', ')}`);
      out.aspect = v;
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

  // Set defaults based on mode
  if (!out.output) out.output = out.video ? 'grok-video.mp4' : 'grok-image.png';
  if (!out.timeout) out.timeout = out.video ? 300 : 120;

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

  // Strategy: directly find <input type="file"> in the DOM and set files via CDP.
  // This bypasses the native OS file chooser entirely — no dialog, no interception needed.
  // We look for the file input, set files on it, then dispatch a 'change' event
  // so the page's JS picks up the selected files.

  // Step 1: Find the file input element
  console.error('[grok] Looking for file input element...');
  const fileInputFound = await evaluate<boolean>(cdp, sessionId, `
    (() => {
      const inputs = document.querySelectorAll('input[type="file"]');
      return inputs.length > 0;
    })()
  `);

  if (!fileInputFound) {
    // Some pages create the file input lazily when the attach button is clicked.
    // Click the attach button first to make it appear, but intercept the file chooser
    // so no native dialog opens.
    console.error('[grok] No file input found, clicking attach button to create one...');
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, { sessionId });

    // Drain any file chooser event (we don't need it, just preventing the dialog)
    const drainHandler = (params: unknown) => {
      cdp.off('Page.fileChooserOpened', drainHandler);
    };
    cdp.on('Page.fileChooserOpened', drainHandler);

    await evaluate<boolean>(cdp, sessionId, `
      (() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          const text = (btn.textContent || '').trim().toLowerCase();
          if (label.includes('attach') || label.includes('upload') || label.includes('add') ||
              text === '+' || text === 'attach') {
            btn.click();
            return true;
          }
        }
        const inputs = document.querySelectorAll('textarea, div[contenteditable="true"]');
        for (const inp of inputs) {
          let container = inp.parentElement;
          for (let i = 0; i < 5 && container; i++) {
            const btns = container.querySelectorAll('button');
            for (const b of btns) {
              if (b.querySelector('svg') && !b.textContent?.includes('Image') && !b.textContent?.includes('Video')) {
                const rect = b.getBoundingClientRect();
                if (rect.width > 0 && rect.width < 60) { b.click(); return true; }
              }
            }
            container = container.parentElement;
          }
        }
        return false;
      })()
    `);
    await sleep(2000);
    try { await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }, { sessionId }); } catch {}
    cdp.off('Page.fileChooserOpened', drainHandler);
  }

  // Step 2: Get the file input's backendNodeId and set files directly
  console.error('[grok] Setting files directly on input element (no file chooser)...');
  const inputNodeId = await evaluate<number>(cdp, sessionId, `
    (() => {
      const inputs = document.querySelectorAll('input[type="file"]');
      // Prefer image-accepting inputs
      for (const inp of inputs) {
        const accept = (inp.getAttribute('accept') || '').toLowerCase();
        if (accept.includes('image')) return true;
      }
      return inputs.length > 0;
    })()
  `);

  if (!inputNodeId) {
    throw new Error('Could not find any <input type="file"> in the Grok UI. Upload failed.');
  }

  // Use evaluateHandle to get objectId, then resolve to backendNodeId for setFileInputFiles
  const fileInputObjId = await evaluateHandle(cdp, sessionId, `
    (() => {
      const inputs = document.querySelectorAll('input[type="file"]');
      for (const inp of inputs) {
        const accept = (inp.getAttribute('accept') || '').toLowerCase();
        if (accept.includes('image')) return inp;
      }
      return inputs[0] || null;
    })()
  `);

  if (!fileInputObjId) {
    throw new Error('Could not get handle to file input element. Upload failed.');
  }

  await cdp.send('DOM.setFileInputFiles', {
    files: absPaths,
    objectId: fileInputObjId,
  }, { sessionId });

  console.error(`[grok] Files set on input: ${absPaths.map(p => path.basename(p)).join(', ')}`);

  // Step 3: Dispatch 'change' and 'input' events so the page JS reacts
  await evaluate<void>(cdp, sessionId, `
    (() => {
      const inputs = document.querySelectorAll('input[type="file"]');
      for (const inp of inputs) {
        if (inp.files && inp.files.length > 0) {
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          break;
        }
      }
    })()
  `);

  // Step 4: Wait and poll for upload confirmation with retries
  // The UI needs time to process the file. We poll multiple times rather than
  // a single sleep, to catch both fast and slow uploads.
  console.error('[grok] Waiting for upload confirmation in UI...');
  let uploadVerified = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(1000);
    uploadVerified = await evaluate<boolean>(cdp, sessionId, `
      (() => {
        // Check the file input itself — does it have files?
        const inputs = document.querySelectorAll('input[type="file"]');
        for (const inp of inputs) {
          if (inp.files && inp.files.length > 0) {
            // File input has files, but we need the UI to reflect it too
          }
        }
        // Look for image thumbnails/previews near the input area
        const imgs = document.querySelectorAll('img[src*="blob:"], img[src*="data:"], [class*="thumbnail"], [class*="preview"], [class*="attachment"]');
        if (imgs.length > 0) return true;
        // Check for chips, file badges, upload indicators
        const chips = document.querySelectorAll('[class*="chip"], [class*="file"], [class*="upload"], [class*="media"]');
        for (const c of chips) {
          // Only count visible elements with dimensions
          const rect = c.getBoundingClientRect();
          if (rect.width > 10 && rect.height > 10) return true;
        }
        return false;
      })()
    `);
    if (uploadVerified) break;
  }

  if (uploadVerified) {
    console.error('[grok] ✅ Reference image upload VERIFIED — preview visible in UI');
  } else {
    // HARD FAIL — do not proceed without confirmed upload
    throw new Error(
      'Reference image upload FAILED — no preview appeared in Grok UI after 10 seconds. ' +
      'The file input was set but Grok did not process it. ' +
      'This means Grok would generate images WITHOUT your reference, producing wrong results. Aborting.'
    );
  }

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

/** Generate video via grok.com/imagine */
async function generateVideo(cdp: CdpConnection, sessionId: string, args: CliArgs): Promise<void> {
  // Two-step flow on grok.com/imagine:
  // Step 1: Upload reference image + prompt → generates an IMAGE
  // Step 2: Click "Make video" on the generated image → type video prompt → generates VIDEO

  console.error('[grok-video] Step 1: Generate image on grok.com/imagine...');

  // Wait for the input on grok.com/imagine
  const imagineInputSelectors = [
    'textarea',
    'div[contenteditable="true"]',
    'input[type="text"]',
  ];

  let foundSelector: string | null = null;
  for (const sel of imagineInputSelectors) {
    const found = await waitForSelector(cdp, sessionId, sel, 15_000);
    if (found) { foundSelector = sel; break; }
  }

  if (!foundSelector) {
    const url = await evaluate<string>(cdp, sessionId, 'window.location.href');
    if (url.includes('login') || url.includes('accounts.google')) {
      throw new Error('Not logged in. Please log in to grok.com (via x.com account) in the browser first.');
    }
    throw new Error('Could not find input on grok.com/imagine. The UI may have changed.');
  }

  console.error(`[grok-video] Found input: ${foundSelector}`);

  // Upload reference images if provided
  if (args.reference.length > 0) {
    await uploadReferenceImages(cdp, sessionId, args.reference, foundSelector);
    await evaluate(cdp, sessionId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(foundSelector)});
        if (el) { el.focus(); el.click(); }
      })()
    `);
    await sleep(500);
  }

  // Focus input and type the image generation prompt
  await evaluate(cdp, sessionId, `
    (() => {
      const el = document.querySelector(${JSON.stringify(foundSelector)});
      if (el) { el.focus(); el.click(); }
    })()
  `);
  await sleep(300);

  // Use the user's prompt for the initial image generation
  const imagePrompt = args.prompt || 'Generate this image';
  console.error(`[grok-video] Typing image prompt: "${imagePrompt}"...`);
  await cdp.send('Input.insertText', { text: imagePrompt }, { sessionId });
  await sleep(1000);

  // Submit the image prompt
  console.error('[grok-video] Submitting image prompt...');
  const submitClicked = await evaluate<boolean>(cdp, sessionId, `
    (() => {
      const buttons = document.querySelectorAll('button[type="submit"], button[aria-label*="send" i], button[aria-label*="submit" i], button[aria-label*="generate" i]');
      if (buttons.length > 0) {
        buttons[buttons.length - 1].click();
        return true;
      }
      const textarea = document.querySelector(${JSON.stringify(foundSelector)});
      if (!textarea) return false;
      let container = textarea.parentElement;
      for (let i = 0; i < 6 && container; i++) {
        const btns = container.querySelectorAll('button');
        for (const b of btns) {
          if (b.querySelector('svg') && !b.textContent?.includes('Image') && !b.textContent?.includes('Video')) {
            const rect = b.getBoundingClientRect();
            if (rect.width > 0) { b.click(); return true; }
          }
        }
        container = container.parentElement;
      }
      return false;
    })()
  `);

  if (!submitClicked) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    }, { sessionId });
    await sleep(50);
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    }, { sessionId });
  }

  // Wait for the image to be generated (look for the post page with the generated image)
  console.error('[grok-video] Waiting for image generation...');
  await sleep(5000);

  const imageDeadline = Date.now() + 120_000; // 2 min for image
  while (Date.now() < imageDeadline) {
    const hasImage = await evaluate<boolean>(cdp, sessionId, `
      (() => {
        // Check if we landed on a post page with a generated image
        const url = window.location.href;
        if (url.includes('/imagine/post/')) return true;
        // Also check for generated images in the DOM
        const imgs = document.querySelectorAll('img[alt*="Generated"], img[src*="assets.grok.com"]');
        if (imgs.length > 0) return true;
        return false;
      })()
    `);
    if (hasImage) {
      console.error('[grok-video] Image generated successfully!');
      break;
    }
    await sleep(3000);
  }

  await sleep(2000);

  // Step 2: Click "Make video" button on the generated image
  // The button may appear as an overlay when hovering over the image
  console.error('[grok-video] Step 2: Looking for "Make video" button...');

  // First, try hovering over the generated image to reveal the overlay button
  await evaluate(cdp, sessionId, `
    (() => {
      // Find the main generated image on the post page
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        const src = (img.src || '');
        if ((src.includes('assets.grok.com') || src.includes('Generated') || img.naturalWidth > 300) &&
            !src.includes('profile') && !src.includes('avatar') && !src.includes('icon')) {
          // Trigger hover events on the image and its parent containers
          const events = ['mouseenter', 'mouseover', 'mousemove'];
          for (const evt of events) {
            img.dispatchEvent(new MouseEvent(evt, { bubbles: true }));
          }
          // Also hover parent containers (overlay may be on a wrapper)
          let parent = img.parentElement;
          for (let i = 0; i < 4 && parent; i++) {
            for (const evt of events) {
              parent.dispatchEvent(new MouseEvent(evt, { bubbles: true }));
            }
            parent = parent.parentElement;
          }
          return;
        }
      }
    })()
  `);
  await sleep(2000);

  // Now look for "Make video" button
  let makeVideoClicked = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    makeVideoClicked = await evaluate<boolean>(cdp, sessionId, `
      (() => {
        // Look for "Make video" button - could be a button, div, span, or overlay element
        const allElements = document.querySelectorAll('button, div[role="button"], a, span, div');
        for (const el of allElements) {
          const text = (el.textContent || '').trim().toLowerCase();
          if (text === 'make video' || text === 'make video') {
            el.click();
            return true;
          }
        }
        // Also check aria-labels
        const labeled = document.querySelectorAll('[aria-label*="video" i], [aria-label*="Video" i]');
        for (const el of labeled) {
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          if (label.includes('make video') || label.includes('create video') || label.includes('generate video')) {
            el.click();
            return true;
          }
        }
        return false;
      })()
    `);
    if (makeVideoClicked) break;
    
    // Re-hover and wait
    await evaluate(cdp, sessionId, `
      (() => {
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
          if (img.naturalWidth > 200 || img.width > 200) {
            const rect = img.getBoundingClientRect();
            const events = ['mouseenter', 'mouseover', 'mousemove'];
            for (const evt of events) {
              img.dispatchEvent(new MouseEvent(evt, { bubbles: true, clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2 }));
            }
            let parent = img.parentElement;
            for (let i = 0; i < 4 && parent; i++) {
              for (const evt of events) {
                parent.dispatchEvent(new MouseEvent(evt, { bubbles: true, clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2 }));
              }
              parent = parent.parentElement;
            }
            return;
          }
        }
      })()
    `);
    await sleep(2000);
  }

  if (!makeVideoClicked) {
    // Last resort: try using CDP Input.dispatchMouseEvent to physically move the mouse over the image
    console.error('[grok-video] Trying physical mouse hover over image...');
    const imgRect = await evaluate<{ x: number; y: number; w: number; h: number } | null>(cdp, sessionId, `
      (() => {
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
          if (img.naturalWidth > 200 || img.width > 200) {
            const r = img.getBoundingClientRect();
            if (r.width > 100) return { x: r.x, y: r.y, w: r.width, h: r.height };
          }
        }
        return null;
      })()
    `);

    if (imgRect) {
      const cx = imgRect.x + imgRect.w / 2;
      const cy = imgRect.y + imgRect.h / 2;
      // Move mouse over the image
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: cx, y: cy,
      }, { sessionId });
      await sleep(2000);

      // Now check again for "Make video"
      makeVideoClicked = await evaluate<boolean>(cdp, sessionId, `
        (() => {
          const allElements = document.querySelectorAll('button, div[role="button"], a, span, div');
          for (const el of allElements) {
            const text = (el.textContent || '').trim().toLowerCase();
            if (text === 'make video' || text.includes('make video')) {
              el.click();
              return true;
            }
          }
          return false;
        })()
      `);
    }
  }

  if (!makeVideoClicked) {
    throw new Error('Could not find "Make video" button. The image may not have generated, or the UI has changed.');
  }

  console.error('[grok-video] "Make video" clicked! Waiting for video prompt input...');
  await sleep(3000);

  // Now we need to type the video prompt and submit
  // After clicking "Make video", Grok shows a new input for video prompt
  let videoInputSelector: string | null = null;
  const videoInputSelectors = [
    'textarea',
    'div[contenteditable="true"]',
    'input[type="text"]',
  ];

  for (const sel of videoInputSelectors) {
    const found = await waitForSelector(cdp, sessionId, sel, 10_000);
    if (found) { videoInputSelector = sel; break; }
  }

  if (videoInputSelector) {
    // Focus and type the video prompt
    await evaluate(cdp, sessionId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(videoInputSelector)});
        if (el) { el.focus(); el.click(); }
      })()
    `);
    await sleep(300);

    const videoPrompt = args.prompt || 'Animate this scene';
    console.error(`[grok-video] Typing video prompt: "${videoPrompt}"...`);
    await cdp.send('Input.insertText', { text: videoPrompt }, { sessionId });
    await sleep(1000);

    // Click "Make Video" submit button or press Enter
    console.error('[grok-video] Submitting video prompt...');
    const videoSubmitted = await evaluate<boolean>(cdp, sessionId, `
      (() => {
        const buttons = document.querySelectorAll('button[type="submit"], button[aria-label*="send" i], button[aria-label*="submit" i], button[aria-label*="generate" i]');
        if (buttons.length > 0) {
          buttons[buttons.length - 1].click();
          return true;
        }
        // Look for any button with SVG near the input
        const textarea = document.querySelector(${JSON.stringify(videoInputSelector)});
        if (!textarea) return false;
        let container = textarea.parentElement;
        for (let i = 0; i < 6 && container; i++) {
          const btns = container.querySelectorAll('button');
          for (const b of btns) {
            if (b.querySelector('svg')) {
              const rect = b.getBoundingClientRect();
              if (rect.width > 0) { b.click(); return true; }
            }
          }
          container = container.parentElement;
        }
        return false;
      })()
    `);

    if (!videoSubmitted) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      }, { sessionId });
      await sleep(50);
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      }, { sessionId });
    }
  } else {
    console.error('[grok-video] No video prompt input found — video generation may have started automatically.');
  }

  // Wait for video to appear
  console.error('[grok-video] Waiting for video generation (this may take a few minutes)...');
  await sleep(5000);

  const deadline = Date.now() + args.timeout * 1000;
  let videoUrl: string | null = null;
  let lastStatus = '';

  while (Date.now() < deadline) {
    const result = await evaluate<{ url: string | null; status: string }>(cdp, sessionId, `
      (() => {
        // Check for video elements with actual URLs
        const videos = document.querySelectorAll('video');
        for (const v of videos) {
          const sources = v.querySelectorAll('source');
          for (const s of sources) {
            if (s.src && s.src.startsWith('http') && s.src.includes('.mp4')) return { url: s.src, status: 'found' };
          }
          if (v.src && v.src.startsWith('http') && v.src.includes('.mp4')) return { url: v.src, status: 'found' };
          // Also check for assets.grok.com video URLs
          for (const s of sources) {
            if (s.src && s.src.includes('assets.grok.com') && s.src.includes('video')) return { url: s.src, status: 'found' };
          }
          if (v.src && v.src.includes('assets.grok.com') && v.src.includes('video')) return { url: v.src, status: 'found' };
        }

        // Check for video download links
        const links = document.querySelectorAll('a[href*=".mp4"], a[href*="video"], a[download]');
        for (const a of links) {
          const href = a.href;
          if (href && href.startsWith('http') && href.includes('.mp4')) return { url: href, status: 'found' };
        }

        // Check for blob URLs in video elements
        for (const v of videos) {
          if (v.src && v.src.startsWith('blob:')) return { url: v.src, status: 'blob' };
        }

        // Check if still generating
        if (document.querySelector('[role="progressbar"]') ||
            document.querySelector('.animate-spin') ||
            document.querySelector('[class*="loading"]') ||
            document.querySelector('[class*="generating"]') ||
            document.querySelector('[class*="spinner"]')) {
          return { url: null, status: 'generating' };
        }

        const allText = document.body.innerText || '';
        if (allText.includes('Generating') || allText.includes('Creating') || allText.includes('Processing')) {
          return { url: null, status: 'generating' };
        }

        return { url: null, status: 'waiting' };
      })()
    `);

    if (result.url && result.status === 'found') {
      videoUrl = result.url;
      console.error(`[grok-video] Video found: ${videoUrl}`);
      break;
    }

    if (result.status === 'blob') {
      console.error('[grok-video] Found blob video URL, extracting...');
      const base64Video = await evaluate<string | null>(cdp, sessionId, `
        (async () => {
          const videos = document.querySelectorAll('video');
          for (const v of videos) {
            if (v.src && v.src.startsWith('blob:')) {
              try {
                const res = await fetch(v.src);
                const blob = await res.blob();
                const buf = await blob.arrayBuffer();
                const bytes = new Uint8Array(buf);
                let binary = '';
                for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                return btoa(binary);
              } catch { continue; }
            }
          }
          return null;
        })()
      `);

      if (base64Video) {
        const outputPath = path.resolve(args.output);
        await mkdir(path.dirname(outputPath), { recursive: true });
        const buffer = Buffer.from(base64Video, 'base64');
        await fs.promises.writeFile(outputPath, buffer);
        console.error(`[grok-video] Saved: ${outputPath}`);
        if (args.json) {
          console.log(JSON.stringify({ prompt: args.prompt, videoUrl: 'blob:', savedPath: outputPath }, null, 2));
        } else {
          console.log(outputPath);
        }
        return;
      }
    }

    if (result.status !== lastStatus) {
      lastStatus = result.status;
      console.error(`[grok-video] Status: ${result.status}...`);
    }

    await sleep(3000);
  }

  if (!videoUrl) {
    const errorText = await evaluate<string>(cdp, sessionId, `
      (() => {
        const text = document.body.innerText || '';
        const errorPatterns = ['error', 'failed', 'unable', 'sorry', 'cannot'];
        for (const p of errorPatterns) {
          const idx = text.toLowerCase().indexOf(p);
          if (idx >= 0) return text.slice(Math.max(0, idx - 50), idx + 100).trim();
        }
        return '';
      })()
    `);
    throw new Error(
      `No video generated within ${args.timeout}s timeout.\n` +
      (errorText ? `Page text: "${errorText}"` : 'No error message detected. The video may still be generating.')
    );
  }

  // Download the video
  const outputPath = path.resolve(args.output);
  await mkdir(path.dirname(outputPath), { recursive: true });

  console.error('[grok-video] Downloading video...');

  const base64 = await evaluate<string | null>(cdp, sessionId, `
    (async () => {
      try {
        const res = await fetch(${JSON.stringify(videoUrl)}, { credentials: 'include' });
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

  if (!base64) {
    console.error('[grok-video] Browser download failed, trying direct fetch...');
    await downloadImage(videoUrl, outputPath);
  } else {
    const buffer = Buffer.from(base64, 'base64');
    await fs.promises.writeFile(outputPath, buffer);
  }

  console.error(`[grok-video] Saved: ${outputPath}`);

  if (args.json) {
    console.log(JSON.stringify({ prompt: args.prompt, videoUrl, savedPath: outputPath }, null, 2));
  } else {
    console.log(outputPath);
  }
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

    const launchUrl = args.video ? GROK_IMAGINE_URL : GROK_URL;
    chrome = spawn(chromePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      launchUrl,
    ], { stdio: 'ignore' });

    chrome.unref();
    ownedChrome = true;
  }

  let cdp: CdpConnection | null = null;
  let grokTargetId: string | null = null;

  try {
    const wsUrl = await waitForChromeDebugPort(port, 30_000);
    cdp = await CdpConnection.connect(wsUrl, 30_000, { defaultTimeoutMs: 30_000 });

    const targetUrl = args.video ? GROK_IMAGINE_URL : GROK_URL;

    // Close any leftover Grok tabs from previous runs
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets', {});
      const staleGrokTabs = targetInfos.filter((t) => t.type === 'page' && (t.url.includes('/i/grok') || t.url.includes('grok.com/imagine')));
      if (staleGrokTabs.length > 0) {
        console.error(`[grok] Closing ${staleGrokTabs.length} stale Grok tab(s)...`);
        for (const tab of staleGrokTabs) {
          try { await cdp.send('Target.closeTarget', { targetId: tab.targetId }); } catch {}
        }
      }
    } catch {}

    // Create a fresh tab for Grok
    console.error(`[grok] Opening new ${args.video ? 'Grok Imagine' : 'Grok'} tab...`);
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: targetUrl });
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

    // ===== VIDEO MODE: grok.com/imagine =====
    if (args.video) {
      await generateVideo(cdp, sessionId, args);

      // Brief pause so user can see result
      await sleep(2000);
      return;
    }

    // ===== IMAGE MODE: x.com/i/grok =====
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

    // Build a set of reference image file sizes for duplicate detection.
    // If a downloaded image is exactly the same size as a reference, it's likely
    // the original image echoed back by Grok — skip it.
    const refSizes = new Set<number>();
    if (args.reference && args.reference.length > 0) {
      for (const refPath of args.reference) {
        try {
          const expanded = refPath.startsWith('~/') ? path.join(os.homedir(), refPath.slice(2)) : refPath;
          const stat = fs.statSync(path.resolve(expanded));
          refSizes.add(stat.size);
        } catch {}
      }
    }

    if (args.all) {
      console.error('[grok] Downloading all images...');
      let outputIndex = 1;
      for (let i = 0; i < imageUrls.length; i++) {
        const tmpPath = path.join(outputDir, `${baseName}-tmp-${i + 1}${ext}`);
        try {
          await downloadViaPage(imageUrls[i]!, tmpPath);
          // Check if this is a duplicate of a reference image
          const dlSize = fs.statSync(tmpPath).size;
          if (refSizes.has(dlSize)) {
            console.error(`[grok] Skipped image ${i + 1}: duplicate of reference image`);
            fs.unlinkSync(tmpPath);
            continue;
          }
          const finalPath = imageUrls.length === 1
            ? outputPath
            : path.join(outputDir, `${baseName}-${outputIndex}${ext}`);
          fs.renameSync(tmpPath, finalPath);
          savedPaths.push(finalPath);
          console.error(`[grok] Saved: ${finalPath}`);
          outputIndex++;
        } catch (err) {
          try { fs.unlinkSync(tmpPath); } catch {}
          console.error(`[grok] Failed to download image ${i + 1}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (savedPaths.length === 0) {
        console.error('[grok] WARNING: All images were duplicates of reference. No generated images saved.');
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
