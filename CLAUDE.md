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

## Model
Local Claude Code: `claude -p --model claude-opus-5-5 --effort high` (Max sub,
no API key). Override with CLAUDE_MODEL / CLAUDE_EFFORT env vars.

History: OpenRouter (grok) until 2026-10 — the account ran out of credits
(402) and posts silently stopped for ~8 days, so it was replaced with claude -p.

## Message window
Each run summarizes only unsummarized messages from the last 24 hours. Older
unsummarized messages (e.g. a backlog after an outage) are skipped, not caught up.

## Environment variables
Uses global vars from ~/.env plus project-specific:
- DISCORD_WEBHOOK_URL - where to post summaries
- DISCORD_WEBHOOK_URLS - alternative webhook
- GUILD_ID - Discord server ID

## Cron
Runs daily at 23:59 via crontab.
