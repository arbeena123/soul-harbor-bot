# Soul Harbor Bot 🔮
Discord bot for The Pagan Shop Online

## Features
- 🃏 Tarot readings (!tarot)
- 👻 Ghost stories (!ghost)
- 🏆 Daily trivia contests with discount codes (!trivia)
- 🌙 Daily horoscopes (!horoscope)
- 🔮 Spirit encyclopedia (!spirit [name])
- 🏅 Badge/role system
- 🛡️ Auto-moderation with owner alerts
- 👋 Auto welcome messages
- ⏰ Scheduled daily posts (ghost story, card of day, trivia)

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Select the repo
4. Add these environment variables in Railway settings:
   - DISCORD_TOKEN
   - OPENAI_API_KEY
   - GUILD_ID
   - OWNER_ID
   - (optional channel name overrides)

## Discord Bot Setup
1. Go to discord.com/developers/applications
2. Select your app → Bot
3. Enable these Privileged Gateway Intents:
   - SERVER MEMBERS INTENT ✅
   - MESSAGE CONTENT INTENT ✅
4. Go to OAuth2 → URL Generator
5. Scopes: bot, applications.commands
6. Permissions: Administrator
7. Copy URL and invite bot to server

## Commands
| Command | Description |
|---------|-------------|
| !tarot | 3-card tarot reading |
| !ghost | Ghost story from shadow realm |
| !trivia | Start a contest (win discount code) |
| !horoscope [sign] | Daily horoscope |
| !spirit [name] | Info about any spirit/entity |
| !badges | View your earned badges |
| !help | Show all commands |
