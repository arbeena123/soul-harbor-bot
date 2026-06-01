/**
 * One-time channel rename script
 * Run once with: node rename-channels.js
 * Then delete this file
 */

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const CATEGORY_RENAMES = {
  'private zone':        '🔒・PRIVATE ZONE',
  'important':           '📋・WELCOME & RULES',
  'main':                '💬・COMMUNITY',
  'the pagan shop online': '🏪・THE PAGAN SHOP',
  'conjures list':       '🧿・CONJURES LIST',
  'affiliates':          '🤝・AFFILIATES',
};

const CHANNEL_RENAMES = {
  'admin-and-mod-rules':           '🛡️・admin-and-mod-rules',
  'admin-and-mod-chat':            '💬・admin-and-mod-chat',
  'bot-commands':                  '🤖・bot-commands',
  'introductions':                 '👋・introductions',
  'server-rules':                  '📜・server-rules',
  'server-announcements':          '📣・server-announcements',
  'soulharbor-chat':               '🔮・soulharbor-chat',
  'soul-harbor-ghost-stories':     '👻・soul-harbor-ghost-stories',
  'shop-links':                    '🛍️・shop-links',
  'new-custom-and-pre-conjures':   '🌟・new-custom-and-pre-conjures',
  'shop-reviews':                  '⭐・shop-reviews',
  'events-and-sales':              '📅・events-and-sales',
  'about-billy':                   '🧿・about-billy',
  'paganshop-chat':                '🗣️・paganshop-chat',
  'the-gallery':                   '🖼️・the-gallery',
  'music-zone':                    '🎵・music-zone',
  'spirit-companion-movie-night':  '🎬・spirit-companion-movie-night',
  'links-and-videos':              '🔗・links-and-videos',
  'excitement-and-gratitude':      '🙏・excitement-and-gratitude',
  'vent-area':                     '💭・vent-area',
  'nsfw-section':                  '🔞・nsfw-section',
  'billys-education':              '📖・billys-education',
  'meta-blog':                     '📝・meta-blog',
  'spiritboard-shop':              '🌐・spiritboard-shop',
  'spiritboard-shop-reviews':      '⭐・spiritboard-shop-reviews',
  'spirit-experiences-and-stories':'✨・spirit-experiences-and-stories',
  'just-chat-paganshop':           '💬・just-chat-paganshop',
  'angel-conjures':                '👼・angel-conjures',
  'asia-conjures':                 '🌏・asia-conjures',
  'creature-conjures':             '🐉・creature-conjures',
  'demon-conjures':                '👿・demon-conjures',
  'djinn-conjures':                '🧞・djinn-conjures',
  'dragon-conjures':               '🐲・dragon-conjures',
  'elf-conjures':                  '🧝・elf-conjures',
  'fae-conjures':                  '🧚・fae-conjures',
  'human-conjures':                '👤・human-conjures',
  'hybrid-conjures':               '🔀・hybrid-conjures',
  'immortal-conjures':             '♾️・immortal-conjures',
  'sexual-conjures':               '🔥・sexual-conjures',
  'vampire-conjures':              '🧛・vampire-conjures',
  'other-conjures':                '✨・other-conjures',
  'morningstars-metamysticals':    '⭐・morningstars-metamysticals',
  'dark-kingdom-magickals':        '🌑・dark-kingdom-magickals',
  'mystic-den':                    '🔮・mystic-den',
  'affiliates-review':             '📝・affiliates-review',
};

// Also create Soul Harbor category if missing
const SOUL_HARBOR_CHANNELS = ['soulharbor-chat', 'soul-harbor-ghost-stories'];

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  await guild.channels.fetch();

  let renamed = 0;
  let errors = 0;

  // Check if Soul Harbor category exists, create if not
  const existingCats = guild.channels.cache.filter(c => c.type === 4);
  const hasSoulHarborCat = existingCats.some(c => c.name.toLowerCase().includes('soul harbor'));
  
  let soulHarborCategory = hasSoulHarborCat 
    ? existingCats.find(c => c.name.toLowerCase().includes('soul harbor'))
    : await guild.channels.create({ name: '🔮・SOUL HARBOR', type: 4 });
  
  if (!hasSoulHarborCat) {
    console.log('✅ Created Soul Harbor category');
    // Move soul harbor channels into it
    for (const chName of SOUL_HARBOR_CHANNELS) {
      const ch = guild.channels.cache.find(c => c.name === chName);
      if (ch) await ch.setParent(soulHarborCategory.id).catch(() => {});
    }
  }

  // Rename categories
  for (const channel of guild.channels.cache.values()) {
    if (channel.type === 4) { // Category
      const key = channel.name.toLowerCase().replace(/[🔒📋💬🏪🧿🤝🔮・]/g, '').trim();
      const newName = CATEGORY_RENAMES[key];
      if (newName && channel.name !== newName) {
        try {
          await channel.setName(newName);
          console.log(`✅ Category: ${channel.name} → ${newName}`);
          renamed++;
          await new Promise(r => setTimeout(r, 1000)); // rate limit delay
        } catch(e) {
          console.log(`❌ Failed: ${channel.name} — ${e.message}`);
          errors++;
        }
      }
    }
  }

  // Rename channels
  for (const channel of guild.channels.cache.values()) {
    if (channel.type === 0 || channel.type === 2) { // Text or Voice
      const cleanName = channel.name.replace(/[🔮👻🛡️💬🤖👋📜📣🛍️🌟⭐📅🧿🗣️🖼️🎵🎬🔗🙏💭🔞📖📝🌐✨👼🌏🐉👿🧞🐲🧝🧚👤🔀♾️🔥🧛⭐🌑🔮📝・]/g, '').trim();
      const newName = CHANNEL_RENAMES[cleanName];
      if (newName && channel.name !== newName) {
        try {
          await channel.setName(newName);
          console.log(`✅ Channel: #${channel.name} → ${newName}`);
          renamed++;
          await new Promise(r => setTimeout(r, 1500)); // rate limit delay
        } catch(e) {
          console.log(`❌ Failed: #${channel.name} — ${e.message}`);
          errors++;
        }
      }
    }
  }

  console.log(`\n✅ Done! Renamed ${renamed} channels/categories. Errors: ${errors}`);
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
