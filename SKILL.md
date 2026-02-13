---
name: grok-image-gen
description: Generate images using Grok AI on x.com via Chrome browser automation. Use when user says "generate image with Grok", "Grok image", "create image with Grok", or wants AI image generation through x.com's Grok.
---

Base directory for this skill: /Users/zanearcher/.claude/skills/grok-image-gen

# Grok Image Generator

Generate images using Grok AI on x.com via real Chrome browser automation (CDP).

## Script Directory

**Agent Execution Instructions**:
1. Determine this SKILL.md file's directory path as `SKILL_DIR`
2. Script path = `${SKILL_DIR}/scripts/<script-name>.ts`
3. Replace all `${SKILL_DIR}` in this document with the actual path

**Script Reference**:
| Script | Purpose |
|--------|---------|
| `scripts/main.ts` | CLI entry point for Grok image generation |
| `scripts/grok-utils.ts` | Chrome CDP utilities (based on baoyu-post-to-x patterns) |

## Prerequisites

- Google Chrome or Chromium
- `bun` runtime
- Logged in to x.com (session saved in Chrome profile)

## Usage

```bash
# Generate image (preview - keeps browser open)
npx -y bun ${SKILL_DIR}/scripts/main.ts "A futuristic cityscape at sunset"

# Generate and save to specific path
npx -y bun ${SKILL_DIR}/scripts/main.ts "A cute robot painting" --output robot.png

# Save all generated images (Grok often returns 4)
npx -y bun ${SKILL_DIR}/scripts/main.ts "Abstract art" --output art.png --all

# Use custom Chrome profile
npx -y bun ${SKILL_DIR}/scripts/main.ts "A dragon" --profile /path/to/profile
```

## Options

| Option | Description |
|--------|-------------|
| `<text>` | Image generation prompt (positional) |
| `--prompt`, `-p` | Prompt text (alternative to positional) |
| `--output`, `-o` | Output image path (default: grok-image.png) |
| `--all` | Save all generated images (numbered: name-1.png, name-2.png, etc.) |
| `--timeout` | Max wait time in seconds (default: 120) |
| `--profile <dir>` | Custom Chrome profile directory |
| `--json` | Output JSON with image URLs and paths |

## How It Works

1. Launches real Chrome with CDP (reuses x.com login session)
2. Navigates to `x.com/i/grok`
3. Types the prompt into Grok's chat input
4. Waits for image generation to complete
5. Extracts generated image URLs from the DOM
6. Downloads and saves images locally

## Authentication

Uses the same Chrome profile as `baoyu-post-to-x`. First run: log in to x.com manually. Session persists across runs.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GROK_CHROME_PATH` | Chrome executable path override |
| `GROK_PROFILE_DIR` | Chrome profile directory override |
