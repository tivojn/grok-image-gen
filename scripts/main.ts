#!/usr/bin/env bun
/**
 * Grok Image & Video Generator
 * Uses Chrome CDP to automate grok.com.
 *
 * Modes:
 *   t2i  — grok.com (chat) → text prompt → images
 *   i2i  — grok.com (chat) → reference image + prompt → images
 *   t2v  — grok.com/imagine → Video tab → text prompt → video
 *   i2v  — grok.com/imagine → Video tab → reference image + prompt → video
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
} from './grok-utils.js';

// ─── CLI ────────────────────────────────────────────────────────────────────

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
};

function printUsage(): void {
  console.log(`Grok Image & Video Generator — grok.com

Usage:
  bun main.ts "A futuristic cityscape"                       # t2i
  bun main.ts "Watercolor style" -r photo.jpg -o wc.png      # i2i
  bun main.ts "Cat walking" --video -o cat.mp4                # t2v
  bun main.ts "Animate this" --video -r photo.jpg -o a.mp4   # i2v

Options:
  <text>              Prompt (positional)
  -p, --prompt <text> Prompt text
  -r, --reference <path> Reference image (repeatable)
  -v, --video         Video mode (uses grok.com/imagine)
  -o, --output <path> Output path (default: grok-image.png / grok-video.mp4)
  --all               Save all generated outputs
  --timeout <secs>    Max wait (default: 120 image, 180 video)
  --profile <dir>     Chrome profile directory
  --json              JSON output
  -h, --help          Help`);
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    prompt: null, output: '', all: false, timeout: 0,
    profile: null, json: false, help: false, reference: [], video: false,
  };
  let explicitOutput = false, explicitTimeout = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--all') { out.all = true; continue; }
    if (a === '-v' || a === '--video') { out.video = true; continue; }
    if (a === '-p' || a === '--prompt') { out.prompt = argv[++i] || ''; continue; }
    if (a === '-o' || a === '--output') { out.output = argv[++i] || ''; explicitOutput = true; continue; }
    if (a === '--timeout') { out.timeout = parseInt(argv[++i] || '0', 10); explicitTimeout = true; continue; }
    if (a === '--profile') { out.profile = argv[++i] || ''; continue; }
    if (a === '-r' || a === '--reference') { out.reference.push(argv[++i] || ''); continue; }
    if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    positional.push(a);
  }
  if (!out.prompt && positional.length) out.prompt = positional.join(' ');
  if (!explicitOutput) out.output = out.video ? 'grok-video.mp4' : 'grok-image.png';
  if (!explicitTimeout) out.timeout = out.video ? 180 : 120;
  return out;
}

// ─── CDP helpers ────────────────────────────────────────────────────────────

async function evaluate<T = unknown>(cdp: CdpConnection, sid: string, expr: string): Promise<T> {
  const r = await cdp.send<{
    result: { value?: unknown; description?: string };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, { sessionId: sid });
  if (r.exceptionDetails) throw new Error(`JS: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value as T;
}

async function evaluateHandle(cdp: CdpConnection, sid: string, expr: string): Promise<string | null> {
  const r = await cdp.send<{
    result: { type: string; subtype?: string; objectId?: string };
    exceptionDetails?: unknown;
  }>('Runtime.evaluate', { expression: expr, awaitPromise: false, returnByValue: false }, { sessionId: sid });
  if (r.exceptionDetails) return null;
  if (r.result.subtype === 'null' || r.result.type === 'undefined') return null;
  return r.result.objectId || null;
}

async function waitFor(cdp: CdpConnection, sid: string, selector: string, ms: number): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await evaluate<boolean>(cdp, sid, `!!document.querySelector(${JSON.stringify(selector)})`)) return true;
    await sleep(500);
  }
  return false;
}

async function isGenerating(cdp: CdpConnection, sid: string): Promise<boolean> {
  return evaluate<boolean>(cdp, sid, `
    (() => {
      if (document.querySelector('[role="progressbar"]')) return true;
      if (document.querySelector('.animate-spin')) return true;
      const anims = document.getAnimations();
      for (const a of anims) {
        const t = a.effect?.target;
        if (t?.closest?.('[class*="message"],[class*="response"],[class*="chat"]')) return true;
      }
      return false;
    })()`);
}

// ─── Download helper ────────────────────────────────────────────────────────

async function downloadMedia(
  cdp: CdpConnection, sid: string, url: string, filePath: string,
): Promise<void> {
  // Try 1: fetch in browser context (works for same-origin / imagine pages)
  const r = await evaluate<{ b64: string | null; err: string | null }>(cdp, sid, `
    (async () => {
      try {
        const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
        if (!r.ok) return { b64: null, err: 'HTTP ' + r.status };
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return { b64: btoa(bin), err: null };
      } catch (e) { return { b64: null, err: String(e) }; }
    })()`);

  if (r.b64) {
    await fs.promises.writeFile(filePath, Buffer.from(r.b64, 'base64'));
    return;
  }

  // Try 2: Node.js fetch with cookies extracted from browser
  console.error(`[grok] Browser fetch failed (${r.err}), trying with cookies...`);
  const { cookies } = await cdp.send<{ cookies: { name: string; value: string; domain: string }[] }>(
    'Network.getAllCookies', {}, { sessionId: sid },
  );
  const host = new URL(url).hostname;
  const cookieStr = cookies
    .filter(c => host.endsWith(c.domain.replace(/^\./, '')))
    .map(c => `${c.name}=${c.value}`).join('; ');

  const res = await fetch(url, {
    headers: { Cookie: cookieStr, Referer: 'https://grok.com/', 'User-Agent': 'Mozilla/5.0 Chrome/131' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status} for ${url}`);
  await fs.promises.writeFile(filePath, Buffer.from(await res.arrayBuffer()));
}

// ─── File upload ────────────────────────────────────────────────────────────

async function uploadFiles(cdp: CdpConnection, sid: string, paths: string[]): Promise<void> {
  const absPaths = paths.map(p => {
    const expanded = p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
    return path.resolve(expanded);
  });
  for (const p of absPaths) if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);

  console.error(`[grok] Uploading ${absPaths.length} file(s)...`);
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, { sessionId: sid });

  cdp.on('Page.fileChooserOpened', async (params: unknown) => {
    try {
      const p = params as { backendNodeId?: number };
      if (p.backendNodeId) await cdp.send('DOM.setFileInputFiles', { files: [], backendNodeId: p.backendNodeId }, { sessionId: sid });
    } catch {}
  });

  const objId = await evaluateHandle(cdp, sid, `
    (() => {
      const named = document.querySelector('input[type="file"][name="files"]');
      if (named) return named;
      const inputs = document.querySelectorAll('input[type="file"]');
      return inputs.length > 0 ? inputs[0] : null;
    })()`);
  if (!objId) throw new Error('No file input found');

  // Neuter click() to prevent native file dialog
  await evaluate(cdp, sid, `
    document.querySelectorAll('input[type="file"]').forEach(i => { i._oc = i.click; i.click = () => {}; })`);

  await cdp.send('DOM.setFileInputFiles', { files: absPaths, objectId: objId }, { sessionId: sid });
  await sleep(3000);

  // Restore click()
  await evaluate(cdp, sid, `
    document.querySelectorAll('input[type="file"]').forEach(i => { if (i._oc) { i.click = i._oc; delete i._oc; } })`);
  try { await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }, { sessionId: sid }); } catch {}

  console.error('[grok] File(s) uploaded');
  await sleep(1000);
}

// ─── Login check ────────────────────────────────────────────────────────────

async function ensureLoggedIn(cdp: CdpConnection, sid: string): Promise<void> {
  const needsLogin = await evaluate<boolean>(cdp, sid, `
    (() => {
      const href = window.location.href;
      if (href.includes('/login') || href.includes('/flow/')) return true;
      const el = document.querySelector('a[href*="sign"], button');
      if (el && (el.textContent || '').toLowerCase().includes('sign in')) return true;
      // Check for sign-in / sign-up buttons (not logged in)
      const btns = document.querySelectorAll('button, a');
      for (const b of btns) {
        const t = (b.textContent || '').trim().toLowerCase();
        if (t === 'sign in' || t === 'sign up' || t === 'log in') return true;
      }
      return false;
    })()`);

  if (!needsLogin) return;

  console.error('[grok] Not logged in. Please sign in via the browser window.');
  console.error('[grok] (Click "Sign in with X" on grok.com)');
  console.error('[grok] Waiting up to 120s...');

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const hasInput = await evaluate<boolean>(cdp, sid,
      `!!document.querySelector('textarea') || !!document.querySelector('input[placeholder*="imagine"]')`);
    if (hasInput) { console.error('[grok] Login detected!'); return; }
    await sleep(2000);
  }
  throw new Error('Login timeout. Please log in to grok.com and try again.');
}

// ─── Extract URLs ───────────────────────────────────────────────────────────

async function extractImageUrls(cdp: CdpConnection, sid: string): Promise<string[]> {
  return evaluate<string[]>(cdp, sid, `
    (() => {
      const urls = [];
      for (const img of document.querySelectorAll('img')) {
        const src = img.src || '';
        if (!src || src.startsWith('data:')) continue;
        if (src.includes('profile') || src.includes('emoji') || src.includes('icon') ||
            src.includes('logo') || src.includes('avatar')) continue;
        const big = img.naturalWidth >= 200 || img.width >= 200;
        if (src.includes('assets.grok.com') || src.includes('imagine-public.x.ai') || big) urls.push(src);
      }
      return [...new Set(urls)];
    })()`);
}

async function extractVideoUrls(cdp: CdpConnection, sid: string): Promise<string[]> {
  return evaluate<string[]>(cdp, sid, `
    (() => {
      const urls = [];
      for (const v of document.querySelectorAll('video')) {
        if (v.src) urls.push(v.src);
        for (const s of v.querySelectorAll('source')) if (s.src) urls.push(s.src);
      }
      for (const a of document.querySelectorAll('a[href*=".mp4"], a[download]')) {
        if (a.href && (a.href.includes('.mp4') || a.href.includes('video'))) urls.push(a.href);
      }
      return [...new Set(urls)];
    })()`);
}

// ─── Click submit ───────────────────────────────────────────────────────────

async function clickSubmit(cdp: CdpConnection, sid: string): Promise<void> {
  await sleep(500); // wait for submit button to appear

  // Wait briefly for Submit to become enabled (it's disabled until text is entered)
  for (let i = 0; i < 10; i++) {
    const enabled = await evaluate<boolean>(cdp, sid, `
      (() => {
        const b = document.querySelector('button[aria-label="Submit"]');
        return b ? !b.disabled : false;
      })()`);
    if (enabled) break;
    await sleep(300);
  }

  const btn = await evaluate<{ x: number; y: number; found: boolean }>(cdp, sid, `
    (() => {
      // aria-label="Submit"
      let b = document.querySelector('button[aria-label="Submit"]');
      if (b && !b.disabled) { const r = b.getBoundingClientRect(); if (r.width > 0) return { x: r.x+r.width/2, y: r.y+r.height/2, found: true }; }
      // Fallback: look near any input area
      const input = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
      if (!input) return { x:0, y:0, found:false };
      let c = input.parentElement;
      for (let i = 0; i < 6 && c; i++) {
        for (const b of c.querySelectorAll('button')) {
          const a = (b.getAttribute('aria-label')||'').toLowerCase();
          if ((a.includes('submit') || a.includes('send')) && !b.disabled) {
            const r = b.getBoundingClientRect();
            if (r.width > 0) return { x: r.x+r.width/2, y: r.y+r.height/2, found: true };
          }
        }
        c = c.parentElement;
      }
      return { x:0, y:0, found:false };
    })()`);

  if (btn.found) {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: btn.x, y: btn.y, button: 'left', clickCount: 1,
      }, { sessionId: sid });
      await sleep(50);
    }
    console.error('[grok] Submit clicked');
  } else {
    console.error('[grok] Submit not found or disabled, pressing Enter...');
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    }, { sessionId: sid });
    await sleep(50);
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    }, { sessionId: sid });
  }
}

// ─── IMAGE MODE (t2i / i2i) — uses grok.com chat ───────────────────────────

async function runImageMode(
  cdp: CdpConnection, sid: string, args: CliArgs,
): Promise<{ urls: string[]; prompt: string }> {
  console.error('[grok] Waiting for chat to load...');
  await sleep(5000);
  await ensureLoggedIn(cdp, sid);

  // Find textarea
  const selectors = ['textarea[placeholder="Ask anything"]', 'textarea[placeholder*="Ask"]', 'textarea'];
  let sel: string | null = null;
  for (const s of selectors) {
    if (await waitFor(cdp, sid, s, 5_000)) { sel = s; break; }
  }
  if (!sel) throw new Error('Could not find chat input. Make sure you are logged in to grok.com.');
  console.error(`[grok] Found input: ${sel}`);

  // Focus
  await evaluate(cdp, sid, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if(e){e.focus();e.click();} })()`);
  await sleep(500);

  // Upload reference if provided
  if (args.reference.length > 0) {
    await uploadFiles(cdp, sid, args.reference);
    await evaluate(cdp, sid, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if(e){e.focus();e.click();} })()`);
    await sleep(500);
  }

  // Snapshot before sending
  const before = await extractImageUrls(cdp, sid);

  // Auto-prefix
  const lp = args.prompt!.toLowerCase();
  const hasRef = args.reference.length > 0;
  const isImg = hasRef || ['image','picture','draw','create','generate','paint','photo','make'].some(k => lp.includes(k));
  const finalPrompt = isImg ? args.prompt! : `Generate an image of: ${args.prompt!}`;

  // Type and send
  console.error('[grok] Sending prompt...');
  await cdp.send('Input.insertText', { text: finalPrompt }, { sessionId: sid });
  await sleep(1000);
  await clickSubmit(cdp, sid);
  await sleep(3000);

  // Wait for new images
  console.error('[grok] Waiting for images...');
  const deadline = Date.now() + args.timeout * 1000;
  let imageUrls: string[] = [];
  let lastCount = 0, stable = 0;

  while (Date.now() < deadline) {
    const gen = await isGenerating(cdp, sid);
    const curr = await extractImageUrls(cdp, sid);
    const newUrls = curr.filter(u => !before.includes(u));

    if (newUrls.length > lastCount) {
      lastCount = newUrls.length;
      stable = 0;
      console.error(`[grok] Found ${newUrls.length} new image(s)...`);
    } else if (newUrls.length > 0 && !gen) {
      if (++stable >= 3) { imageUrls = newUrls; break; }
    }
    if (newUrls.length > 0) imageUrls = newUrls;
    await sleep(2000);
  }

  if (imageUrls.length === 0) {
    // Broad fallback
    const all = await evaluate<string[]>(cdp, sid, `
      [...document.querySelectorAll('img')].filter(i => i.src.startsWith('https://') &&
        (i.naturalWidth>=256||i.width>=256) && !i.src.includes('profile') && !i.src.includes('emoji') &&
        !i.src.includes('icon') && !i.src.includes('logo')).map(i => i.src)`);
    imageUrls = [...new Set(all)].filter(u => !before.includes(u));
  }

  if (imageUrls.length === 0) throw new Error('No images generated.');
  console.error(`[grok] Got ${imageUrls.length} image(s)`);

  return { urls: imageUrls, prompt: finalPrompt };
}

// ─── VIDEO MODE (t2v / i2v) — uses grok.com/imagine ────────────────────────

async function runVideoMode(
  cdp: CdpConnection, sid: string, args: CliArgs,
): Promise<{ urls: string[]; prompt: string }> {
  console.error('[grok] Waiting for Imagine page to load...');
  await sleep(5000);
  await ensureLoggedIn(cdp, sid);

  const currentUrl = await evaluate<string>(cdp, sid, 'window.location.href');
  console.error(`[grok] Page URL: ${currentUrl}`);

  // Wait for TipTap ProseMirror input
  const inputSel = 'div.tiptap.ProseMirror[contenteditable="true"]';
  const fallbackSel = '[contenteditable="true"]';
  let sel: string | null = null;
  if (await waitFor(cdp, sid, inputSel, 5_000)) sel = inputSel;
  else if (await waitFor(cdp, sid, fallbackSel, 3_000)) sel = fallbackSel;
  else if (await waitFor(cdp, sid, 'textarea', 3_000)) sel = 'textarea';

  if (!sel) throw new Error('Could not find Imagine input. Make sure you are logged in to grok.com.');
  console.error(`[grok] Found input: ${sel}`);

  // Select Video mode via Settings menu (button[aria-label="Settings"] → menuitemradio "Video")
  console.error('[grok] Selecting Video mode...');

  // Use CDP mouse events to click the Settings button (React dropdowns don't respond to .click())
  const settingsPos = await evaluate<{ x: number; y: number; found: boolean }>(cdp, sid, `
    (() => {
      const btn = document.querySelector('button[aria-label="Settings"]');
      if (btn) { const r = btn.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2, found: true }; }
      for (const b of document.querySelectorAll('button[aria-haspopup="menu"]')) {
        const t = (b.textContent || '').trim().toLowerCase();
        if (t === 'image' || t === 'video') {
          const r = b.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2, found: true };
        }
      }
      return { x: 0, y: 0, found: false };
    })()`);

  if (settingsPos.found) {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: settingsPos.x, y: settingsPos.y, button: 'left', clickCount: 1,
      }, { sessionId: sid });
      await sleep(50);
    }
    console.error('[grok] Settings button clicked');
  } else {
    console.error('[grok] Warning: Settings button not found');
  }
  await sleep(1000);

  // Click "Video" menuitemradio using CDP mouse events
  let videoClicked = false;
  for (let attempt = 0; attempt < 3 && !videoClicked; attempt++) {
    const videoPos = await evaluate<{ x: number; y: number; found: boolean }>(cdp, sid, `
      (() => {
        for (const item of document.querySelectorAll('[role="menuitemradio"]')) {
          if ((item.textContent || '').trim().toLowerCase() === 'video') {
            const r = item.getBoundingClientRect();
            return { x: r.x+r.width/2, y: r.y+r.height/2, found: true };
          }
        }
        return { x: 0, y: 0, found: false };
      })()`);

    if (videoPos.found) {
      for (const type of ['mousePressed', 'mouseReleased'] as const) {
        await cdp.send('Input.dispatchMouseEvent', {
          type, x: videoPos.x, y: videoPos.y, button: 'left', clickCount: 1,
        }, { sessionId: sid });
        await sleep(50);
      }
      videoClicked = true;
    }
    if (!videoClicked) await sleep(1000);
  }

  if (videoClicked) {
    console.error('[grok] Video mode selected');
  } else {
    console.error('[grok] Warning: could not select Video mode');
  }
  // Dismiss menu by pressing Escape
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  }, { sessionId: sid });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  }, { sessionId: sid });
  await sleep(500);

  // Upload reference if provided
  if (args.reference.length > 0) {
    await uploadFiles(cdp, sid, args.reference);
    await sleep(500);
  }

  // Focus input and type prompt
  const finalPrompt = args.prompt!;
  console.error('[grok] Sending prompt...');
  // Click the contenteditable via CDP mouse events to ensure proper focus
  const inputPos = await evaluate<{ x: number; y: number; found: boolean }>(cdp, sid, `
    (() => {
      const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return { x: 0, y: 0, found: false };
      e.focus();
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2, found: true };
    })()`);
  if (inputPos.found) {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: inputPos.x, y: inputPos.y, button: 'left', clickCount: 1,
      }, { sessionId: sid });
      await sleep(50);
    }
  }
  await sleep(500);

  await cdp.send('Input.insertText', { text: finalPrompt }, { sessionId: sid });
  await sleep(500);

  // Verify text was entered
  const typed = await evaluate<boolean>(cdp, sid, `
    (() => {
      const e = document.querySelector(${JSON.stringify(sel)});
      return !!(e && (e.textContent || '').trim().length > 0);
    })()`);
  if (!typed) {
    console.error('[grok] insertText failed, using execCommand...');
    // execCommand('insertText') triggers proper beforeinput/input events for TipTap
    await evaluate(cdp, sid, `
      (() => {
        const e = document.querySelector(${JSON.stringify(sel)});
        if (e) { e.focus(); document.execCommand('insertText', false, ${JSON.stringify(finalPrompt)}); }
      })()`);
    await sleep(500);
  }
  console.error('[grok] Prompt entered');
  await clickSubmit(cdp, sid);
  await sleep(3000);

  // After submit, /imagine shows a grid of results. We must click one to go to /imagine/post/{id}.
  // In Video mode it may go directly to /imagine/post/{id}. Handle both cases.
  console.error('[grok] Waiting for results...');
  const deadline = Date.now() + args.timeout * 1000;

  // Phase 1: Wait for either result grid or direct navigation to post page
  let onPostPage = false;
  while (Date.now() < deadline) {
    const url = await evaluate<string>(cdp, sid, 'window.location.href');
    if (url.includes('/imagine/post/')) {
      console.error(`[grok] On post page: ${url}`);
      onPostPage = true;
      break;
    }

    // Check for result grid (generated images/videos as clickable items)
    const gridInfo = await evaluate<{ count: number; hasResults: boolean }>(cdp, sid, `
      (() => {
        // Result items are in a list with "Generated image" alt text or large images
        const items = document.querySelectorAll('img[alt="Generated image"], article img');
        if (items.length > 0) return { count: items.length, hasResults: true };
        // Also check for any new large images in main content area
        const bigImgs = [...document.querySelectorAll('img')].filter(i =>
          (i.naturalWidth >= 200 || i.width >= 200) &&
          i.src.includes('assets.grok.com'));
        if (bigImgs.length > 0) return { count: bigImgs.length, hasResults: true };
        return { count: 0, hasResults: false };
      })()`);

    if (gridInfo.hasResults) {
      console.error(`[grok] Found ${gridInfo.count} result(s) in grid, clicking first one...`);
      // Get position of first result image and click via CDP mouse events
      const imgPos = await evaluate<{ x: number; y: number; found: boolean }>(cdp, sid, `
        (() => {
          const img = document.querySelector('img[alt="Generated image"]');
          if (img) { const r = img.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2, found: true }; }
          const bigImgs = [...document.querySelectorAll('img')].filter(i =>
            (i.naturalWidth >= 200 || i.width >= 200) && i.src.includes('assets.grok.com'));
          if (bigImgs.length > 0) {
            const r = bigImgs[0].getBoundingClientRect();
            return { x: r.x+r.width/2, y: r.y+r.height/2, found: true };
          }
          return { x: 0, y: 0, found: false };
        })()`);

      if (imgPos.found) {
        for (const type of ['mousePressed', 'mouseReleased'] as const) {
          await cdp.send('Input.dispatchMouseEvent', {
            type, x: imgPos.x, y: imgPos.y, button: 'left', clickCount: 1,
          }, { sessionId: sid });
          await sleep(50);
        }
        console.error('[grok] Clicked result, waiting for post page...');
        await sleep(3000);
        const postUrl = await evaluate<string>(cdp, sid, 'window.location.href');
        if (postUrl.includes('/imagine/post/')) {
          console.error(`[grok] On post page: ${postUrl}`);
          onPostPage = true;
          break;
        }
      }
    }

    // Check for generation progress
    const progress = await evaluate<string>(cdp, sid, `
      (() => {
        const t = document.body.innerText || '';
        const m = t.match(/Generating\\s+(\\d+)%/i);
        return m ? m[0] : '';
      })()`);
    if (progress) console.error(`[grok] ${progress}`);

    await sleep(3000);
  }

  // Phase 2: On the post page, wait for <video> with a valid .mp4 src
  let videoUrls: string[] = [];

  if (onPostPage) {
    // Post page may show a generated image with a "Make video" button.
    // Before clicking it, type the prompt into the post page input for video context.
    await sleep(3000);

    // Check if "Make video" button exists
    const hasMakeVideo = await evaluate<boolean>(cdp, sid, `
      (() => {
        for (const b of document.querySelectorAll('button')) {
          if ((b.textContent || '').trim().toLowerCase().includes('make video')) return true;
        }
        return false;
      })()`);

    if (hasMakeVideo) {
      // Type prompt into the post page input ("Type to edit image..." field)
      const postInput = await evaluate<{ x: number; y: number; found: boolean; tag: string }>(cdp, sid, `
        (() => {
          // TipTap contenteditable
          const ce = document.querySelector('div.tiptap.ProseMirror[contenteditable="true"]');
          if (ce) { const r = ce.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2, found: true, tag: 'ce' }; }
          const ce2 = document.querySelector('[contenteditable="true"]');
          if (ce2) { const r = ce2.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2, found: true, tag: 'ce2' }; }
          const ta = document.querySelector('textarea');
          if (ta) { const r = ta.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2, found: true, tag: 'ta' }; }
          return { x: 0, y: 0, found: false, tag: '' };
        })()`);

      if (postInput.found) {
        // Click to focus
        for (const type of ['mousePressed', 'mouseReleased'] as const) {
          await cdp.send('Input.dispatchMouseEvent', {
            type, x: postInput.x, y: postInput.y, button: 'left', clickCount: 1,
          }, { sessionId: sid });
          await sleep(50);
        }
        await sleep(300);

        // Type the prompt
        await cdp.send('Input.insertText', { text: finalPrompt }, { sessionId: sid });
        await sleep(300);
        // Verify, fallback to execCommand
        const postTyped = await evaluate<boolean>(cdp, sid, `
          (() => {
            const e = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
            return !!(e && (e.textContent || e.value || '').trim().length > 0);
          })()`);
        if (!postTyped) {
          await evaluate(cdp, sid, `
            (() => {
              const e = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
              if (e) { e.focus(); document.execCommand('insertText', false, ${JSON.stringify(finalPrompt)}); }
            })()`);
        }
        console.error('[grok] Typed prompt on post page');
        await sleep(500);
      }

      // Now click "Make video"
      const makeVideoPos = await evaluate<{ x: number; y: number; found: boolean }>(cdp, sid, `
        (() => {
          for (const b of document.querySelectorAll('button')) {
            const t = (b.textContent || '').trim().toLowerCase();
            if (t.includes('make video')) {
              const r = b.getBoundingClientRect();
              if (r.width > 0) return { x: r.x+r.width/2, y: r.y+r.height/2, found: true };
            }
          }
          return { x: 0, y: 0, found: false };
        })()`);
      if (makeVideoPos.found) {
        for (const type of ['mousePressed', 'mouseReleased'] as const) {
          await cdp.send('Input.dispatchMouseEvent', {
            type, x: makeVideoPos.x, y: makeVideoPos.y, button: 'left', clickCount: 1,
          }, { sessionId: sid });
          await sleep(50);
        }
        console.error('[grok] Clicked "Make video"');
        await sleep(5000);
        const newUrl = await evaluate<string>(cdp, sid, 'window.location.href');
        console.error(`[grok] Page: ${newUrl}`);
      }
    }

    console.error('[grok] Waiting for video to load...');
    let lastPct = '';
    const videoWaitStart = Date.now();
    const minWaitMs = 30_000;

    while (Date.now() < deadline) {
      // Check generation progress
      const progress = await evaluate<string>(cdp, sid, `
        (() => {
          const t = document.body.innerText || '';
          const m = t.match(/Generating\\s+(\\d+)%/i);
          return m ? m[0] : '';
        })()`);
      if (progress && progress !== lastPct) {
        console.error(`[grok] ${progress}`);
        lastPct = progress;
      }

      // Check for any loading indicators
      const isLoading = await evaluate<boolean>(cdp, sid, `
        !!(document.querySelector('[role="progressbar"],.animate-spin,.animate-pulse') ||
           (document.body.innerText || '').match(/Generating/i))`);

      // Check for <video> with valid src (accept any http src on video elements)
      const urls = await evaluate<string[]>(cdp, sid, `
        (() => {
          const urls = [];
          for (const v of document.querySelectorAll('video')) {
            const src = v.src || v.currentSrc || '';
            if (src.startsWith('http') && (src.includes('.mp4') || src.includes('assets.grok.com') || src.includes('generated'))) {
              urls.push(src);
            }
            for (const s of v.querySelectorAll('source')) {
              if (s.src && s.src.startsWith('http')) urls.push(s.src);
            }
          }
          return [...new Set(urls)];
        })()`);

      if (urls.length > 0) {
        videoUrls = urls;
        console.error(`[grok] Video ready: ${urls.length} URL(s)`);
        break;
      }

      // Only fall back to images after minWaitMs AND no loading indicators AND no progress
      if (!isLoading && !progress && Date.now() - videoWaitStart > minWaitMs) {
        const imgUrls = await extractImageUrls(cdp, sid);
        const grokImgs = imgUrls.filter(u => u.includes('assets.grok.com') && u.includes('generated'));
        if (grokImgs.length > 0) {
          console.error(`[grok] No video found after ${Math.round((Date.now()-videoWaitStart)/1000)}s, using ${grokImgs.length} image(s)`);
          videoUrls = grokImgs;
          break;
        }
      }

      await sleep(3000);
    }
  }

  if (videoUrls.length === 0) {
    // Final fallback: extract anything useful from current page
    videoUrls = await extractVideoUrls(cdp, sid);
  }
  if (videoUrls.length === 0) {
    const debug = await evaluate<{ url: string; videos: number; imgs: number }>(cdp, sid, `({
      url: window.location.href,
      videos: document.querySelectorAll('video').length,
      imgs: document.querySelectorAll('img').length,
    })`);
    console.error(`[grok] Debug: ${JSON.stringify(debug)}`);
    throw new Error('Video generation timed out. Try increasing --timeout or check grok.com/imagine manually.');
  }

  console.error(`[grok] Got ${videoUrls.length} result(s)`);
  return { urls: videoUrls, prompt: finalPrompt };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); return; }
  if (!args.prompt) { printUsage(); process.exitCode = 1; return; }

  const profileDir = args.profile || getDefaultProfileDir();
  await mkdir(profileDir, { recursive: true });

  // Launch or reuse Chrome
  let port: number;
  let ownedChrome = false;
  let chrome: ReturnType<typeof spawn> | null = null;

  const existingPort = await getExistingDebugPort(profileDir);
  if (existingPort) {
    console.error(`[grok] Reusing Chrome (port ${existingPort})`);
    port = existingPort;
  } else {
    const chromePath = findChromeExecutable();
    if (!chromePath) throw new Error('Chrome not found. Set GROK_CHROME_PATH.');
    port = await getFreePort();
    console.error(`[grok] Launching Chrome (profile: ${profileDir})`);
    const tabUrl = args.video ? 'https://grok.com/imagine' : 'https://grok.com';
    chrome = spawn(chromePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      tabUrl,
    ], { stdio: 'ignore' });
    chrome.unref();
    ownedChrome = true;
  }

  let cdp: CdpConnection | null = null;
  let grokTargetId: string | null = null;

  try {
    const wsUrl = await waitForChromeDebugPort(port, 30_000);
    cdp = await CdpConnection.connect(wsUrl, 30_000, { defaultTimeoutMs: 30_000 });

    // Close stale Grok tabs
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets', {});
      const stale = targetInfos.filter(t => t.type === 'page' && t.url.includes('grok.com'));
      if (stale.length) {
        console.error(`[grok] Closing ${stale.length} stale tab(s)...`);
        for (const t of stale) try { await cdp.send('Target.closeTarget', { targetId: t.targetId }); } catch {}
      }
    } catch {}

    // Open fresh tab
    const tabUrl = args.video ? 'https://grok.com/imagine' : 'https://grok.com';
    console.error(`[grok] Opening ${args.video ? 'Imagine' : 'Chat'} tab...`);
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: tabUrl });
    grokTargetId = targetId;

    const { sessionId: sid } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, { sessionId: sid });
    await cdp.send('Runtime.enable', {}, { sessionId: sid });
    await cdp.send('DOM.enable', {}, { sessionId: sid });
    await cdp.send('Network.enable', {}, { sessionId: sid });

    // Run the appropriate mode
    const result = args.video
      ? await runVideoMode(cdp, sid, args)
      : await runImageMode(cdp, sid, args);

    const mediaUrls = result.urls;
    const mediaType = args.video ? 'video' : 'image';

    // Pick best (for images with multiple results)
    let selectedUrls = mediaUrls;
    if (!args.video && !args.all && mediaUrls.length > 1) {
      // Score by resolution from DOM
      const scores = await evaluate<{ url: string; res: number }[]>(cdp, sid, `
        (() => {
          const urls = ${JSON.stringify(mediaUrls)};
          return urls.map(url => {
            const img = [...document.querySelectorAll('img')].find(i => i.src === url);
            return { url, res: img ? (img.naturalWidth||img.width) * (img.naturalHeight||img.height) : 0 };
          });
        })()`);
      scores.sort((a, b) => b.res - a.res);
      selectedUrls = [scores[0]!.url];
      console.error(`[grok] Auto-picked best of ${mediaUrls.length} (${scores[0]!.res}px)`);
    }

    // Download
    const outputPath = path.resolve(args.output);
    const outputDir = path.dirname(outputPath);
    const defaultExt = args.video ? '.mp4' : '.png';
    const ext = path.extname(outputPath) || defaultExt;
    const baseName = path.basename(outputPath, ext);
    await mkdir(outputDir, { recursive: true });

    const savedPaths: string[] = [];
    const downloadUrls = args.all ? mediaUrls : selectedUrls;

    for (let i = 0; i < downloadUrls.length; i++) {
      const out = downloadUrls.length === 1
        ? outputPath
        : path.join(outputDir, `${baseName}-${i + 1}${ext}`);
      try {
        await downloadMedia(cdp, sid, downloadUrls[i]!, out);
        savedPaths.push(out);
        console.error(`[grok] Saved: ${out}`);
      } catch (err) {
        console.error(`[grok] Download failed for ${mediaType} ${i + 1}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (savedPaths.length === 0) throw new Error('All downloads failed.');

    // Output
    if (args.json) {
      const mode = args.video
        ? (args.reference.length > 0 ? 'i2v' : 't2v')
        : (args.reference.length > 0 ? 'i2i' : 't2i');
      console.log(JSON.stringify({
        prompt: args.prompt,
        finalPrompt: result.prompt,
        mode,
        [`${mediaType}Urls`]: mediaUrls,
        savedPaths,
        count: mediaUrls.length,
      }, null, 2));
    } else {
      for (const p of savedPaths) console.log(p);
    }

    await sleep(2000);
  } finally {
    if (cdp) {
      if (grokTargetId) try { await cdp.send('Target.closeTarget', { targetId: grokTargetId }, { timeoutMs: 5_000 }); } catch {}
      if (ownedChrome) try { await cdp.send('Browser.close', {}, { timeoutMs: 5_000 }); } catch {}
      cdp.close();
    }
    if (chrome && ownedChrome) {
      setTimeout(() => { if (!chrome!.killed) try { chrome!.kill('SIGKILL'); } catch {} }, 2_000).unref?.();
      try { chrome.kill('SIGTERM'); } catch {}
    }
  }
}

// Guard against bun double-execution
if (process.env.__GROK_RUNNING) process.exit(0);
process.env.__GROK_RUNNING = '1';

main().catch(err => { console.error(`Error: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
