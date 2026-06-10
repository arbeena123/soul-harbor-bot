# Soul Harbor Bot — June 2026 Bug-Fix Release

## What changed (all in index.js)

1. **Bot reacting to Billy's @everyone announcements (FIXED)**
   Root cause: discord.js counts "@everyone" as mentioning the bot. Billy's announcement
   contained "winner...discount" which matched the trivia regex, so the bot started a trivia.
   Fix: mentions check now ignores @everyone/@role pings, AND the bot never responds
   conversationally inside announcement channels at all.

2. **Cron times wrong / DST drift (FIXED)**
   All schedules now run in America/New_York (change via BOT_TIMEZONE env var):
   - Ghost story: 10:00 PM nightly
   - Trivia: 6:00 PM nightly (matches welcome message)
   - Card of the Day: 10:00 AM
   - Class: Wednesday 6:00 PM
   Every job now logs "starting / done / FAILED" so Railway logs show exactly what happened.

3. **Trivia/ghost channel "not found" (FIXED)**
   getChannel() ignored announcement-type channels. Now matches both text and announcement channels.

4. **Bot warned Billy with moderation warnings (FIXED)**
   Owner, admins, and mod-role members are now exempt from auto-moderation.
   Mod alerts on 3rd strike now also DM "Moderator" role (not just "mod").

5. **!syncrolesall said Billy isn't the owner (FIXED)**
   Owner checks now trust Discord's live guild.ownerId (not only the OWNER_ID env var),
   and OWNER_ID is trimmed of accidental whitespace.

6. **Mods can now earn XP and levels (CHANGED per Billy)**
   Only the server owner is excluded from XP. Mods level up like everyone else.

7. **Welcome message naming (FIXED)**
   Now says: server = The Pagan Shop Online Discord, Soul Harbor = the AI guide.

8. **Blog -> Discord posting (NEW FEATURE)**
   The bot polls the blog feed every 30 min and posts new articles to the announcements
   channel (or CHANNEL_BLOG if set). First run silently marks existing articles as seen
   so it won't flood the channel. Requires DATABASE_URL (already set).

## Railway env vars to add

- BLOG_FEED_URL = the RSS/feed URL of the shop blog (REQUIRED for blog posting;
  without it the feature stays off and logs a notice)
- CHANNEL_BLOG = channel name for blog posts (optional, defaults to announcements)
- BOT_TIMEZONE = IANA timezone (optional, defaults to America/New_York)

## Greeter checklist (if welcomes still don't appear)

The welcome code is correct. If new joins still get no greeting:
1. Discord Developer Portal -> your app -> Bot -> enable "SERVER MEMBERS INTENT" (this
   toggle being off silently kills guildMemberAdd - most common cause)
2. Check Railway logs on a test join: it logs either the channel it posted to or
   "Welcome channel not found" with the names it tried.

## Verify after deploy (Railway logs)

On boot you should see:
  "Daily tasks scheduled in timezone America/New_York: ghost 10PM, trivia 6PM, card 10AM, class Wed 6PM"
Then tonight at 6 PM and 10 PM Eastern, look for "[cron] daily-trivia starting" and
"[cron] ghost-story starting" lines. Any failure prints "[cron] <name> FAILED:" with the error.
