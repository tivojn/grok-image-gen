---
name: grok-image-gen
description: Generate images and videos using Grok AI on grok.com via Chrome browser automation. Supports text-to-image (t2i), image-to-image (i2i), text-to-video (t2v), and image-to-video (i2v). Use when user says "generate image with Grok", "Grok image", "Grok video", "create video with Grok", or wants AI image/video generation through grok.com.
---

Base directory for this skill: /Users/zanearcher/.claude/skills/grok-image-gen

# Grok Image & Video Generator

Generate images and videos using Grok AI on grok.com via real Chrome browser automation (CDP).

## Script Directory

**Agent Execution Instructions**:
1. Determine this SKILL.md file's directory path as `SKILL_DIR`
2. Script path = `${SKILL_DIR}/scripts/<script-name>.ts`
3. Replace all `${SKILL_DIR}` in this document with the actual path

**Script Reference**:
| Script | Purpose |
|--------|---------|
| `scripts/main.ts` | CLI entry point for Grok image & video generation |
| `scripts/grok-utils.ts` | Chrome CDP utilities (based on baoyu-post-to-x patterns) |

## Prerequisites

- Google Chrome or Chromium
- `bun` runtime
- Logged in to grok.com (first run: sign in with X)

## Usage

```bash
# t2i: Text to image (default mode)
npx -y bun ${SKILL_DIR}/scripts/main.ts "A futuristic cityscape at sunset" --output city.png

# i2i: Image to image (reference image)
npx -y bun ${SKILL_DIR}/scripts/main.ts "Make this look like a watercolor painting" -r /path/to/photo.jpg --output watercolor.png

# t2v: Text to video
npx -y bun ${SKILL_DIR}/scripts/main.ts "Cat walking across a field" --video --output cat.mp4

# i2v: Image to video (animate a reference image)
npx -y bun ${SKILL_DIR}/scripts/main.ts "Animate this scene" --video -r /path/to/photo.jpg --output anim.mp4

# Save all generated images (Grok often returns 4)
npx -y bun ${SKILL_DIR}/scripts/main.ts "Abstract art" --output art.png --all

# Multiple reference images
npx -y bun ${SKILL_DIR}/scripts/main.ts "Combine these two styles" -r style1.png -r style2.png --output combined.png

# JSON output
npx -y bun ${SKILL_DIR}/scripts/main.ts "A cute robot" --output robot.png --json

# Use custom Chrome profile
npx -y bun ${SKILL_DIR}/scripts/main.ts "A dragon" --profile /path/to/profile
```

## Modes

| Mode | Flag | Input | Output |
|------|------|-------|--------|
| **t2i** (text→image) | default | prompt text | .png |
| **i2i** (image→image) | `-r image.jpg` | prompt + reference image | .png |
| **t2v** (text→video) | `--video` | prompt text | .mp4 |
| **i2v** (image→video) | `--video -r image.jpg` | prompt + reference image | .mp4 |

## Options

| Option | Description |
|--------|-------------|
| `<text>` | Generation prompt (positional) |
| `--prompt`, `-p` | Prompt text (alternative to positional) |
| `--reference`, `-r` | Reference image path for Grok to use as visual context (repeatable for multiple images) |
| `--video`, `-v` | Video generation mode (t2v, or i2v when combined with -r) |
| `--output`, `-o` | Output path (default: grok-image.png or grok-video.mp4) |
| `--all` | Save all generated outputs (numbered: name-1.png, name-2.png, etc.) |
| `--timeout` | Max wait time in seconds (default: 120 for images, 180 for video) |
| `--profile <dir>` | Custom Chrome profile directory |
| `--json` | Output JSON with URLs and paths |

## How It Works

1. Launches real Chrome with CDP (reuses login session via shared Chrome profile)
2. Navigates to `grok.com`
3. If reference images provided (`-r`), uploads them via the file input
4. Types the prompt into Grok's chat input
5. Waits for generation to complete (images or video depending on mode)
6. Extracts generated media URLs from the DOM
7. Downloads and saves locally

## Authentication

Uses the same Chrome profile as `baoyu-post-to-x`. First run: grok.com shows "Sign in with X" — click to log in with your X account. Session persists across runs.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GROK_CHROME_PATH` | Chrome executable path override |
| `GROK_PROFILE_DIR` | Chrome profile directory override |
