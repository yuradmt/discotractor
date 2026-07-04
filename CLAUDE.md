# Discotractor - Discord Summarizer

## What it does
- Exports messages from ALL available channels on a Discord server
- Summarizes each channel SEPARATELY (e.g., summary of "general", summary of "trading", etc.)
- Posts summaries to a Discord webhook

## Ignored channels
- intro-votes
- introduce-yourself
- lobby

## Summarization prompt focus
Find and extract:
- Usable trading or farming ideas
- Important project updates or news
- Airdrop notifications

**Always keep the poster's name when quoting a message.**

## OpenRouter model
**Primary: x-ai/grok-4.3** (x.ai model via OpenRouter)
**Fallback: minimax/minimax-m2** — used ONLY when the primary returns a 404 with
a "deprecated" message. Any other error (rate limit, auth, network) is NOT a
fallback trigger — those should fail loudly so cron retries the next night.

History: was grok-4.1-fast, xAI deprecated it 2026-05 → OpenRouter started
returning 404. The fallback exists so the next model retirement doesn't silently
break the daily summary again.

## Environment variables
Uses global vars from ~/.env plus project-specific:
- DISCORD_WEBHOOK_URL - where to post summaries
- DISCORD_WEBHOOK_URLS - alternative webhook
- GUILD_ID - Discord server ID

## Cron
Runs daily at 23:59 via crontab.
