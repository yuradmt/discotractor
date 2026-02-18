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
**ONLY use: grok-4.1-fast** (x.ai model via OpenRouter)

## Environment variables
Uses global vars from ~/.env plus project-specific:
- DISCORD_WEBHOOK_URL - where to post summaries
- DISCORD_WEBHOOK_URLS - alternative webhook
- GUILD_ID - Discord server ID

## Cron
Runs daily at 23:59 via crontab.
