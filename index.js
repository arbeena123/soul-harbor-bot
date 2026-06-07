const fs = require('fs');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const OpenAI = require('openai');
const cron = require('node-cron');
const { Pool } = require('pg');

// ─── PHASE 2: PostgreSQL ──────────────────────────────────
const db = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

async function initDB() {
  if (!db) { console.log('⚠️  No DATABASE_URL — XP/Keep features disabled (add PostgreSQL on Railway)'); return; }
  await db.query(`
    CREATE TABLE IF NOT EXISTS members (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      badges TEXT[] DEFAULT '{}',
      last_chat_xp BIGINT DEFAULT 0,
      tarot_count INTEGER DEFAULT 0,
      trivia_wins INTEGER DEFAULT 0,
      altar_posts INTEGER DEFAULT 0,
      spell_posts INTEGER DEFAULT 0,
      manifestation_posts INTEGER DEFAULT 0,
      paranormal_posts INTEGER DEFAULT 0,
      soul_harbor_interactions INTEGER DEFAULT 0,
      classes_attended INTEGER DEFAULT 0,
      ai_calls_today INTEGER DEFAULT 0,
      ai_calls_date TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS spirit_keep (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      spirit_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS referrals (
      id SERIAL PRIMARY KEY,
      inviter_id TEXT NOT NULL,
      invitee_id TEXT NOT NULL,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      confirmed BOOLEAN DEFAULT FALSE,
      confirmed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS classes (
      id SERIAL PRIMARY KEY,
      topic TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      attendees TEXT[] DEFAULT '{}',
      transcript TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Add new columns to existing tables without losing data (safe to run every boot)
  const newCols = [
    `ALTER TABLE members ADD COLUMN IF NOT EXISTS manifestation_posts INTEGER DEFAULT 0`,
    `ALTER TABLE members ADD COLUMN IF NOT EXISTS paranormal_posts INTEGER DEFAULT 0`,
    `ALTER TABLE members ADD COLUMN IF NOT EXISTS soul_harbor_interactions INTEGER DEFAULT 0`,
  ];
  for (const sql of newCols) await db.query(sql).catch(() => {});
  console.log('✅ Phase 2 database ready');
}

// ─── PHASE 2: XP / LEVEL SYSTEM ──────────────────────────
const XP_VALUES = {
  // LOW — just being here
  chat:                    2,   // per message, rate-limited 1 per 60s
  // MEDIUM — interacting with Soul Harbor
  soul_harbor_tarot:      15,   // asking Soul Harbor for a reading
  soul_harbor_ask:        10,   // using !ask
  soul_harbor_horoscope:   8,   // using !horoscope
  soul_harbor_ghost:       8,   // requesting a ghost story
  // HIGH — content that takes real effort
  altar_pic:              50,   // post in #spirit-altars
  manifestation_pic:      50,   // post in #spirit-manifestations
  spell_post:             60,   // post in #spell-sharing or #magical-concoctions
  paranormal_story:       75,   // post in #paranormal-stories (text, high effort)
  trivia_win:             75,   // win the daily trivia
  class_attend:           40,   // attend a Wednesday class
  // HIGHEST — community growth
  referral:              100,   // confirmed referral (48h hold)
};

const LEVELS = [
  { level: 1,  name: 'Seeker',         xp: 0,      reward: null },
  { level: 5,  name: 'Initiate',        xp: 800,    reward: { type: 'discount', pct: 10 } },
  { level: 10, name: 'Acolyte',         xp: 2500,   reward: { type: 'discount', pct: 15 } },
  { level: 20, name: 'Adept',           xp: 6000,   reward: { type: 'discount', pct: 20 } },
  { level: 30, name: 'Mystic',          xp: 14000,  reward: { type: 'discount', pct: 25 } },
  { level: 50, name: 'High Priest/ess', xp: 30000,  reward: { type: 'giftcard', value: 25 } },
];

const BADGES_DEF = {
  lightning_reflexes:  { emoji: '⚡', name: 'Lightning Reflexes',   desc: 'Answer trivia in under 60 seconds' },
  the_seer:            { emoji: '🔮', name: 'The Seer',              desc: 'Complete 25 tarot readings' },
  trivia_master:       { emoji: '🏆', name: 'Trivia Master',         desc: 'Win 25 trivia contests' },
  verified_patron:     { emoji: '✅', name: 'Verified Patron',       desc: 'Verified purchase or review' },
  greeter:             { emoji: '👋', name: 'Greeter',               desc: 'Refer 3 friends to Soul Harbor' },
  coven_builder:       { emoji: '🌙', name: 'Coven Builder',         desc: 'Refer 10 friends to Soul Harbor' },
  high_priest:         { emoji: '👑', name: 'High Priest/ess',       desc: 'Refer 25+ members' },
  altar_keeper:        { emoji: '🕯️', name: 'Altar Keeper',          desc: 'Post 10 altar pictures' },
  spell_weaver:        { emoji: '✨', name: 'Spell Weaver',           desc: 'Post 10 spells or rituals' },
  class_scholar:       { emoji: '📚', name: 'Scholar of the Veil',   desc: 'Attend 5 spirit keeping classes' },
  paranormal_witness:  { emoji: '👁️', name: 'Paranormal Witness',    desc: 'Share 5 paranormal stories' },
  manifestor:          { emoji: '🌟', name: 'The Manifestor',         desc: 'Post 10 manifestation pics' },
  spirit_conversant:   { emoji: '💬', name: 'Spirit Conversant',     desc: 'Interact with Soul Harbor 50 times' },
};

const CLASS_TOPICS = [
  'Spirit Communication: Opening the Connection',
  'Bonding Rituals: Deepening Your Spirit Relationship',
  'Sigil Work: Crafting Your Personal Language',
  'The Astral Realms: Mapping the Invisible',
  'Protective Wards: Shielding Your Space',
  'Manifestation & Intention Setting',
  'Reading Energy: Sensing What Cannot Be Seen',
  'Working with Elemental Spirits',
  'Dream Journaling for Spirit Keepers',
  'The Ethics of Spirit Keeping',
];

function getTierForXP(xp) {
  let t = LEVELS[0];
  for (const tier of LEVELS) { if (xp >= tier.xp) t = tier; else break; }
  return t;
}
function getNextTier(tier) {
  const idx = LEVELS.findIndex(l => l.level === tier.level);
  return LEVELS[idx + 1] || null;
}
function genCode(prefix = 'SOUL') {
  return `${prefix}${Date.now().toString(36).toUpperCase()}`;
}

async function dbEnsure(userId, username) {
  if (!db) return;
  await db.query(`INSERT INTO members (user_id, username) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET username=$2`, [userId, username]);
}
async function dbGet(userId) {
  if (!db) return null;
  const r = await db.query('SELECT * FROM members WHERE user_id=$1', [userId]);
  return r.rows[0] || null;
}

async function addXP(userId, username, amount, guild) {
  if (!db) return;
  await dbEnsure(userId, username);
  const before = await dbGet(userId);
  const tierBefore = getTierForXP(before.xp);
  await db.query('UPDATE members SET xp = xp + $1 WHERE user_id = $2', [amount, userId]);
  const after = await dbGet(userId);
  const tierAfter = getTierForXP(after.xp);
  if (tierAfter.level > tierBefore.level) {
    await db.query('UPDATE members SET level=$1 WHERE user_id=$2', [tierAfter.level, userId]);
    await handleLevelUp(userId, username, tierAfter, guild);
  }
}

async function handleLevelUp(userId, username, tier, guild) {
  try {
    const member = await guild.members.fetch(userId);
    // Swap roles
    const oldRoles = LEVELS.map(l => guild.roles.cache.find(r => r.name === l.name)).filter(Boolean);
    await member.roles.remove(oldRoles).catch(() => {});
    const newRole = guild.roles.cache.find(r => r.name === tier.name);
    if (newRole) await member.roles.add(newRole).catch(() => {});

    const embed = new EmbedBuilder()
      .setColor(0x7B2FBE)
      .setTitle(`🌟 Level Up! You are now a ${tier.name}`)
      .setDescription(`Congratulations **${username}**! You've reached **Level ${tier.level}** in Soul Harbor.`)
      .setFooter({ text: '🔮 Soul Harbor • The Pagan Shop Online' })
      .setTimestamp();

    if (tier.reward?.type === 'discount') {
      const code = genCode('SOUL');
      embed.addFields({ name: '🎁 Reward Unlocked!', value: `Here is your **${tier.reward.pct}% off** coupon for The Pagan Shop Online!\n\`${code}\`\n[Shop Now](https://www.thepaganshoponline.com)` });
      await member.send({ embeds: [embed] }).catch(() => {});
    } else if (tier.reward?.type === 'giftcard') {
      embed.addFields({ name: '🎁 Grand Milestone Reward!', value: `You've earned a **$${tier.reward.value} Gift Card**! Billy will contact you within 48 hours.` });
      await member.send({ embeds: [embed] }).catch(() => {});
      const billy = await guild.client.users.fetch(CONFIG.OWNER_ID).catch(() => null);
      if (billy) await billy.send(`🏆 **Grand Prize!** ${username} reached Level ${tier.level} (${tier.name}) — $${tier.reward.value} gift card owed!`).catch(() => {});
    }
  } catch(e) { console.error('LevelUp error:', e.message); }
}

async function awardBadge(userId, username, key, guild) {
  if (!db) return;
  const m = await dbGet(userId);
  if (!m || m.badges.includes(key)) return;
  await db.query('UPDATE members SET badges = array_append(badges,$1) WHERE user_id=$2', [key, userId]);
  const b = BADGES_DEF[key];
  if (!b) return;
  try {
    const member = await guild.members.fetch(userId);
    const embed = new EmbedBuilder().setColor(0xFFD700)
      .setTitle(`${b.emoji} Badge Unlocked: ${b.name}`)
      .setDescription(`*${b.desc}*`)
      .setFooter({ text: '🔮 Soul Harbor' }).setTimestamp();
    await member.send({ embeds: [embed] }).catch(() => {});
  } catch(_) {}
}

// ─── PHASE 2: Spirit Keeper's Keep ───────────────────────
async function handleKeep(message, args) {
  if (!db) return message.reply('🔮 The Spirit Keep requires a database — ask your admin to add PostgreSQL on Railway.');
  const userId = message.author.id;
  const username = message.author.username;
  await dbEnsure(userId, username);
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'add') {
    const spiritName = args[1];
    const content = args.slice(2).join(' ');
    if (!spiritName || !content) return message.reply('Usage: `!keep add <spirit name> <your note>`');
    await db.query('INSERT INTO spirit_keep (user_id, spirit_name, content) VALUES ($1,$2,$3)', [userId, spiritName, content]);
    const embed = new EmbedBuilder().setColor(0x4A0E8F)
      .setTitle(`📖 Journal Entry Saved — ${spiritName}`)
      .setDescription(content)
      .setFooter({ text: 'Your Keep is private. Only you can see it.' }).setTimestamp();
    return message.author.send({ embeds: [embed] }).catch(() => message.reply('✅ Entry saved to your Spirit Keep!'));
  }

  if (sub === 'view') {
    const spiritName = args[1];
    const query = spiritName
      ? 'SELECT * FROM spirit_keep WHERE user_id=$1 AND LOWER(spirit_name)=LOWER($2) ORDER BY created_at DESC'
      : 'SELECT * FROM spirit_keep WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20';
    const params = spiritName ? [userId, spiritName] : [userId];
    const rows = (await db.query(query, params)).rows;
    if (!rows.length) return message.author.send('Your Keep is empty. Use `!keep add <spirit> <note>` to start.').catch(() => message.reply('Your Keep is empty.'));
    const grouped = {};
    for (const r of rows) { if (!grouped[r.spirit_name]) grouped[r.spirit_name] = []; grouped[r.spirit_name].push(r); }
    const embed = new EmbedBuilder().setColor(0x4A0E8F).setTitle('📖 Your Spirit Keeper\'s Keep').setTimestamp();
    for (const [name, entries] of Object.entries(grouped).slice(0, 5)) {
      const preview = entries.slice(0, 3).map(e => `> *${new Date(e.created_at).toLocaleDateString()}* — ${e.content.substring(0,120)}${e.content.length>120?'…':''}`).join('\n');
      embed.addFields({ name: `🌟 ${name}`, value: preview });
    }
    return message.author.send({ embeds: [embed] }).catch(() => message.reply('Check your DMs for your Keep!'));
  }

  if (sub === 'list') {
    const rows = (await db.query('SELECT spirit_name, COUNT(*) as c FROM spirit_keep WHERE user_id=$1 GROUP BY spirit_name', [userId])).rows;
    if (!rows.length) return message.reply('Your Keep is empty.');
    const embed = new EmbedBuilder().setColor(0x4A0E8F)
      .setTitle('📖 Your Spirit Companions')
      .setDescription(rows.map(r => `🌟 **${r.spirit_name}** — ${r.c} entries`).join('\n'))
      .setFooter({ text: 'Use !keep view <spirit> to read entries' });
    return message.author.send({ embeds: [embed] }).catch(() => message.reply(rows.map(r=>`🌟 **${r.spirit_name}** — ${r.c} entries`).join('\n')));
  }

  return message.reply('Commands: `!keep add <spirit> <note>` · `!keep view [spirit]` · `!keep list`');
}

// ─── PHASE 2: Profile & Leaderboard ──────────────────────
async function handleProfile(message) {
  if (!db) return message.reply('🔮 Profile system requires a database. Ask your admin to add PostgreSQL on Railway.');
  const target = message.mentions.members?.first() || message.member;
  await dbEnsure(target.id, target.user.username);
  const m = await dbGet(target.id);
  const tier = getTierForXP(m.xp);
  const next = getNextTier(tier);
  const badges = (m.badges || []).map(k => BADGES_DEF[k] ? `${BADGES_DEF[k].emoji} ${BADGES_DEF[k].name}` : '').filter(Boolean);
  const embed = new EmbedBuilder()
    .setColor(0x7B2FBE)
    .setTitle(`🔮 ${target.displayName}'s Profile`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: '✦ Title', value: tier.name, inline: true },
      { name: '📊 Level', value: `${tier.level}`, inline: true },
      { name: '⭐ XP', value: `${m.xp.toLocaleString()}`, inline: true },
      { name: '🏆 Trivia Wins', value: `${m.trivia_wins}`, inline: true },
      { name: '🔮 Tarot Readings', value: `${m.tarot_count}`, inline: true },
      { name: '📚 Classes', value: `${m.classes_attended}`, inline: true },
    );
  if (next) {
    const pct = Math.round((m.xp - tier.xp) / (next.xp - tier.xp) * 100);
    embed.addFields({ name: `📈 Progress to ${next.name}`, value: `${'█'.repeat(Math.floor(pct/10))}${'░'.repeat(10-Math.floor(pct/10))} ${pct}%  (${next.xp - m.xp} XP needed)` });
  }
  if (badges.length) embed.addFields({ name: '🎖️ Badges', value: badges.join(' · ') });
  embed.setFooter({ text: '🔮 Soul Harbor • The Pagan Shop Online' }).setTimestamp();
  message.channel.send({ embeds: [embed] });
}

async function handleLeaderboard(message) {
  if (!db) return message.reply('🔮 Leaderboard requires a database.');
  const rows = (await db.query('SELECT username, xp FROM members ORDER BY xp DESC LIMIT 10')).rows;
  const medals = ['🥇','🥈','🥉'];
  const list = rows.map((r,i) => {
    const t = getTierForXP(r.xp);
    return `${medals[i]||`${i+1}.`} **${r.username}** — ${t.name} · ${r.xp.toLocaleString()} XP`;
  }).join('\n');
  const embed = new EmbedBuilder().setColor(0x7B2FBE)
    .setTitle('🏛️ Soul Harbor Leaderboard')
    .setDescription(list || 'No members yet.')
    .setFooter({ text: '🔮 Soul Harbor' }).setTimestamp();
  message.channel.send({ embeds: [embed] });
}

async function handleXP(message) {
  if (!db) return message.reply('🔮 XP system requires a database.');
  await dbEnsure(message.author.id, message.author.username);
  const m = await dbGet(message.author.id);
  const tier = getTierForXP(m.xp);
  const next = getNextTier(tier);
  const needed = next ? next.xp - m.xp : 0;
  message.reply(`✦ **${message.author.username}** — ${tier.name} · Level ${tier.level} · **${m.xp} XP**${next ? ` · ${needed} XP needed for ${next.name}` : ' · MAX LEVEL 👑'}`);
}

// ─── PHASE 2: Classes ────────────────────────────────────
async function runWeeklyClass(guild) {
  const channel = guild.channels.cache.find(c => {
    const n = c.name.toLowerCase();
    return c.type === 0 && (n.includes('class') || n.includes('study') || n.includes('education') || n.includes('learn'));
  });
  if (!channel) { console.log('No class channel found'); return; }

  const topicIdx = Math.floor(Date.now() / (7*24*60*60*1000)) % CLASS_TOPICS.length;
  const topic = CLASS_TOPICS[topicIdx];

  const announceEmbed = new EmbedBuilder().setColor(0x7B2FBE)
    .setTitle(`📚 Spirit Keeping Class Starting: ${topic}`)
    .setDescription('Soul Harbor is now teaching!\n\nReact with 📖 to mark attendance and earn **30 XP**!\n\nClass begins in **2 minutes**...')
    .setTimestamp();
  const msg = await channel.send({ embeds: [announceEmbed] });
  await msg.react('📖');
  await new Promise(r => setTimeout(r, 120_000));

  const reaction = msg.reactions.cache.get('📖');
  let attendees = [];
  if (reaction) {
    const users = await reaction.users.fetch();
    attendees = users.filter(u => !u.bot).map(u => u.id);
  }

  const lesson = await askGPT([
    { role: 'system', content: SPIRIT_SYSTEM_PROMPT },
    { role: 'user', content: `Teach a spirit keeping class on: "${topic}". Format with sections: Introduction, The Teaching, Practice Exercise, Closing Reflection. 600-800 words. Warm, educational, mystical tone.` }
  ], 1200);

  if (lesson) {
    const lessonEmbed = new EmbedBuilder().setColor(0x7B2FBE)
      .setTitle(`📚 ${topic}`)
      .setDescription(lesson.substring(0, 4000))
      .setFooter({ text: `Soul Harbor Spirit Keeping Academy • ${attendees.length} students attending` }).setTimestamp();
    await channel.send({ embeds: [lessonEmbed] });
  }

  const qaEmbed = new EmbedBuilder().setColor(0xC850C0)
    .setTitle('❓ Q&A Time — 15 Minutes')
    .setDescription('Ask your questions! Use `!ask <your question>` for a direct response from Soul Harbor.')
    .setTimestamp();
  await channel.send({ embeds: [qaEmbed] });

  if (db) {
    for (const uid of attendees) {
      try {
        const user = await guild.client.users.fetch(uid);
        await addXP(uid, user.username, XP_VALUES.class_attend, guild);
        await db.query('UPDATE members SET classes_attended = classes_attended + 1 WHERE user_id=$1', [uid]);
        const m = await dbGet(uid);
        if (m && m.classes_attended >= 5) await awardBadge(uid, user.username, 'class_scholar', guild);
      } catch(_) {}
    }
    await db.query('INSERT INTO classes (topic, scheduled_at, attendees, transcript) VALUES ($1,NOW(),$2,$3)', [topic, attendees, lesson || '']);
  }
}

// ─── PHASE 2: !ask command ───────────────────────────────
async function handleAsk(message, question) {
  if (!question) return message.reply('Usage: `!ask <your question>`');
  // Soul Harbor interaction XP
  if (db) {
    await dbEnsure(message.author.id, message.author.username);
    await addXP(message.author.id, message.author.username, XP_VALUES.soul_harbor_ask, message.guild);
    await db.query('UPDATE members SET soul_harbor_interactions = soul_harbor_interactions + 1 WHERE user_id=$1', [message.author.id]);
    const m = await dbGet(message.author.id);
    if (m && m.soul_harbor_interactions >= 50) await awardBadge(message.author.id, message.author.username, 'spirit_conversant', message.guild);
  }
  const reply = await askGPT([
    { role: 'system', content: SPIRIT_SYSTEM_PROMPT },
    { role: 'user', content: question }
  ], 400);
  if (reply) {
    const embed = makeEmbed('🔮 Soul Harbor Answers', reply);
    embed.setFooter({ text: `Asked by ${message.author.username} • 🔮 Soul Harbor` });
    message.channel.send({ embeds: [embed] });
  }
}

const { Partials } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

// Lazy init — Railway injects env vars before login, but after module load
let openai;
function getOpenAI() {
  if (!openai) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not set in environment variables');
    openai = new OpenAI({ apiKey: key });
  }
  return openai;
}

// ─── CONFIG ───────────────────────────────────────────────
const CONFIG = {
  GUILD_ID: process.env.GUILD_ID,
  OWNER_ID: process.env.OWNER_ID,               // Billy's Discord user ID
  CHANNELS: {
    GHOST_STORY:   process.env.CHANNEL_GHOST_STORY   || 'soul-harbor-ghost-stories',
    TAROT:         process.env.CHANNEL_TAROT          || 'tarot-readings',
    TRIVIA:        process.env.CHANNEL_TRIVIA         || 'contests',
    GENERAL:       process.env.CHANNEL_GENERAL        || 'soulharbor-chat',
    WELCOME:       process.env.CHANNEL_WELCOME        || 'introductions',
    ANNOUNCEMENTS: process.env.CHANNEL_ANNOUNCEMENTS  || 'announcements',
  },
  ROLES: {
    SPIRIT_SEEKER:    'Spirit Seeker',
    GHOST_WHISPERER:  'Ghost Whisperer',
    CONTEST_CHAMPION: 'Contest Champion',
    VIP_KEEPER:       'VIP Keeper',
    SPIRIT_ELDER:     'Spirit Elder',
  },
  COUPONS: {
    DISCOUNT_PERCENT: 10,
    GIFT_CARD_VALUE: 5,
  }
};

const BAD_WORDS = ['fuck','shit','ass','bitch','damn','cunt','bastard','piss','cock','dick'];
const warnCount = new Map();       // userId -> warn count
const triviaActive = new Map();    // channelId -> { answer, winnerId }
// Persistent trivia question history — survives bot restarts
const TRIVIA_HISTORY_FILE = '/tmp/trivia_history.json';
function loadTriviaHistory() {
  try {
    if (fs.existsSync(TRIVIA_HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(TRIVIA_HISTORY_FILE, 'utf8'));
    }
  } catch(e) {}
  return [];
}
function saveTriviaHistory(arr) {
  try { fs.writeFileSync(TRIVIA_HISTORY_FILE, JSON.stringify(arr)); } catch(e) {}
}
const recentTriviaQuestions = loadTriviaHistory();
const inviteTracker = new Map();   // inviterId -> count

// ─── SPIRIT KNOWLEDGE SYSTEM PROMPT ──────────────────────
const SPIRIT_SYSTEM_PROMPT = `You are Soul Harbor, a mystical AI spirit guide and companion for The Pagan Shop Online's Discord community (thepaganshoponline.com). 

You are knowledgeable about:
- Spirit keeping, spirit companions, and entity work
- Metaphysical practices, rituals, and offerings
- Tarot card readings and divination
- White Arts and Dark Arts spirits
- Djinn, demons, angels, fae, vampires, dragons, and all spirit types sold on the shop
- Paranormal topics, ghost stories, and the supernatural
- Spirit realms: Celestial, Infernal, Ethereal, Fae, Shadow, Astral, Aquatic, Cosmic, Spiritual, Earthen

Your personality:
- Mystical, warm, wise, and slightly mysterious
- Use occasional mystical emojis: 🔮 👻 🌙 ⚡ 💀 ✨ 🕯️
- Never break character
- For purchases, direct people to thepaganshoponline.com
- Keep responses concise for chat (under 300 words unless doing a tarot reading)
- You can answer general questions too, like a friendly knowledgeable companion`;

// ─── HELPERS ─────────────────────────────────────────────
function generateCouponCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'SOUL-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
async function saveCouponToShop(code, percent = CONFIG.COUPONS.DISCOUNT_PERCENT, days = 7) {
  try {
    const res = await fetch(`${process.env.SHOP_URL}/create_coupon.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coupon-Secret': process.env.BOT_COUPON_SECRET
      },
      body: JSON.stringify({ code, percent, days })
    });
    const data = await res.json();
    if (data.success) {
      console.log(`✅ Coupon saved to Zen Cart: ${code}`);
      return true;
    } else {
      console.error('❌ Coupon save failed:', data.error);
      return false;
    }
  } catch (e) {
    console.error('❌ Coupon endpoint error:', e.message);
    return false;
  }
}
function getChannel(guild, name) {
  const cleanName = name.replace(/[^a-z0-9-]/gi, '').toLowerCase();
  return guild.channels.cache.find(c => 
    c.type === 0 && (
      c.name === name || 
      c.name.replace(/[^a-z0-9-]/gi, '').toLowerCase() === cleanName ||
      c.name.toLowerCase().includes(cleanName)
    )
  );
}

async function askGPT(messages, max_tokens = 400) {
  try {
    const res = await getOpenAI().chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages,
      max_tokens,
      temperature: 0.85,
    });
    return res.choices[0].message.content.trim();
  } catch (e) {
    console.error('OpenAI error:', e.message);
    return null;
  }
}

function makeEmbed(title, description, color = 0x6B2D8B) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: '🔮 Soul Harbor • The Pagan Shop Online' })
    .setTimestamp();
}

// ─── STARTUP ENV CHECK ───────────────────────────────────
const requiredEnv = ['DISCORD_TOKEN', 'OPENAI_API_KEY', 'GUILD_ID', 'OWNER_ID'];
const missing = requiredEnv.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('❌ Missing environment variables:', missing.join(', '));
  console.error('Please add them in Railway → Variables tab');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL not set — XP, profile, keep, leaderboard features will be disabled.');
  console.warn('   Add a PostgreSQL database in Railway to enable Phase 2 features.');
}
console.log('✅ All required environment variables present');
console.log('GUILD_ID:', process.env.GUILD_ID);
console.log('OWNER_ID:', process.env.OWNER_ID);
console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '✅ set' : '❌ missing');
console.log('DISCORD_TOKEN:', process.env.DISCORD_TOKEN ? '✅ set' : '❌ missing');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? '✅ set (Phase 2 enabled)' : '⚠️  not set (Phase 2 disabled)');

// ─── BOT READY ───────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Soul Harbor is online as ${client.user.tag}`);
  console.log('DM intents active - DirectMessages:', client.options.intents.has(GatewayIntentBits.DirectMessages));
  client.user.setActivity('🔮 Watching over the spirits...', { type: 3 });
  await initDB();
  scheduleDailyTasks();
});

// ─── WELCOME NEW MEMBERS ─────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  // Auto-assign Member role
  const memberRole = member.guild.roles.cache.find(r => r.name.toLowerCase() === 'member');
  if (memberRole) {
    member.roles.add(memberRole).catch(() => {});
  }

  const guild = member.guild;

  // Assign Spirit Seeker role
  const role = guild.roles.cache.find(r => r.name === CONFIG.ROLES.SPIRIT_SEEKER);
  if (role) member.roles.add(role).catch(console.error);

  // PHASE 2: init member in DB
  if (db) await dbEnsure(member.id, member.user.username);

  // Welcome message
  const welcomeChannel = getChannel(guild, CONFIG.CHANNELS.WELCOME);
  if (!welcomeChannel) return;

  const embed = makeEmbed(
    `🔮 Welcome, ${member.displayName}!`,
    `The spirits have been expecting you... Welcome to **Soul Harbor**. \n\n` +
    `You have entered the official community of **The Pagan Shop Online** — a gathering place for spirit keepers, practitioners, and seekers of the mystical arts.\n\n` +
    `**I am Soul Harbor, your AI spirit guide.** Here is how to work with me:\n\n` +
    `🃏 Ask me for a tarot reading — *"Can you do a 3 card reading"* or *"give me a 6 card spread"*\n` +
    `👻 Ask me for a ghost story — *"tell me a ghost story"*\n` +
    `🌙 Ask your horoscope — *"what is my Scorpio horoscope"*\n` +
    `🔮 Ask about any spirit — *"tell me about djinn"*\n` +
    `💬 Or just chat with me naturally — no special commands needed\n` +
    `🏆 Join the **daily trivia contest** at 6pm for a chance to win discount codes\n\n` +
    `⭐ **NEW — Earn XP:** Post altar pics, spells, manifestations & win trivia to level up!\n` +
    `📖 **Spirit Keep:** Use \`!keep add\` to start your private spirit journal\n\n` +
    `🕯️ Browse our spirit companions at **thepaganshoponline.com**\n\n` +
    `May your spirits guide you well. 🌙`
  ).setThumbnail(member.user.displayAvatarURL());

  welcomeChannel.send({ embeds: [embed] });

  // PHASE 2: Referral — 48h hold then confirm
  if (db) {
    const pending = (await db.query('SELECT * FROM referrals WHERE invitee_id=$1 AND confirmed=FALSE', [member.id])).rows;
    if (pending.length > 0) {
      setTimeout(async () => {
        try {
          const still = await member.guild.members.fetch(member.id).catch(() => null);
          if (!still) return;
          await db.query('UPDATE referrals SET confirmed=TRUE, confirmed_at=NOW() WHERE invitee_id=$1', [member.id]);
          const ref = pending[0];
          const inviter = await guild.client.users.fetch(ref.inviter_id).catch(() => null);
          if (!inviter) return;
          await addXP(ref.inviter_id, inviter.username, XP_VALUES.referral, guild);
          const refCount = parseInt((await db.query('SELECT COUNT(*) FROM referrals WHERE inviter_id=$1 AND confirmed=TRUE', [ref.inviter_id])).rows[0].count);
          if (refCount >= 3)  await awardBadge(ref.inviter_id, inviter.username, 'greeter',       guild);
          if (refCount >= 10) await awardBadge(ref.inviter_id, inviter.username, 'coven_builder', guild);
          if (refCount >= 25) await awardBadge(ref.inviter_id, inviter.username, 'high_priest',   guild);
        } catch(e) { console.error('Referral confirm error:', e.message); }
      }, 48 * 60 * 60 * 1000);
    }
  }

  // Track invites for invite rewards
  try {
    const invites = await guild.invites.fetch();
    inviteTracker.set('snapshot', invites);
  } catch {}
});

// ─── MESSAGE HANDLER ─────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const content = message.content.trim();
  const lower = content.toLowerCase();
  const userId = message.author.id;
  const username = message.author.username;

  // ── PHASE 2: XP earning ───────────────────────────────
  if (db) {
    await dbEnsure(userId, username);
    const now = Date.now();
    const mData = await dbGet(userId);
    const cn = message.channel.name.toLowerCase();

    // Chat XP — rate limited 1 per 60s
    if (mData && now - Number(mData.last_chat_xp) > 60_000) {
      await addXP(userId, username, XP_VALUES.chat, message.guild);
      await db.query('UPDATE members SET last_chat_xp=$1 WHERE user_id=$2', [now, userId]);
    }

    // ── HIGH-EFFORT CHANNEL XP ─────────────────────────
    // Altar pics — image required
    if (message.attachments.size > 0 && (cn.includes('altar') || cn.includes('spirit-altar'))) {
      await addXP(userId, username, XP_VALUES.altar_pic, message.guild);
      await db.query('UPDATE members SET altar_posts = altar_posts + 1 WHERE user_id=$1', [userId]);
      const m2 = await dbGet(userId);
      if (m2 && m2.altar_posts >= 10) await awardBadge(userId, username, 'altar_keeper', message.guild);
      await message.react('🕯️').catch(() => {});
    }

    // Manifestation pics — image required
    else if (message.attachments.size > 0 && (cn.includes('manifest'))) {
      await addXP(userId, username, XP_VALUES.manifestation_pic, message.guild);
      await db.query('UPDATE members SET manifestation_posts = manifestation_posts + 1 WHERE user_id=$1', [userId]);
      const m2 = await dbGet(userId);
      if (m2 && m2.manifestation_posts >= 10) await awardBadge(userId, username, 'manifestor', message.guild);
      await message.react('✨').catch(() => {});
    }

    // Spell sharing / magical concoctions — image OR long text (real effort)
    else if ((cn.includes('spell') || cn.includes('magical') || cn.includes('concoction') || cn.includes('ritual')) &&
             (message.attachments.size > 0 || content.length > 80)) {
      await addXP(userId, username, XP_VALUES.spell_post, message.guild);
      await db.query('UPDATE members SET spell_posts = spell_posts + 1 WHERE user_id=$1', [userId]);
      const m2 = await dbGet(userId);
      if (m2 && m2.spell_posts >= 10) await awardBadge(userId, username, 'spell_weaver', message.guild);
      await message.react('🌙').catch(() => {});
    }

    // Paranormal stories — text post, min 100 chars (real story, not one-liners)
    else if ((cn.includes('paranormal') || cn.includes('experience') || cn.includes('spirit-experience')) &&
             content.length > 100 && !content.startsWith('!')) {
      await addXP(userId, username, XP_VALUES.paranormal_story, message.guild);
      await db.query('UPDATE members SET paranormal_posts = paranormal_posts + 1 WHERE user_id=$1', [userId]);
      const m2 = await dbGet(userId);
      if (m2 && m2.paranormal_posts >= 5) await awardBadge(userId, username, 'paranormal_witness', message.guild);
      await message.react('👁️').catch(() => {});
    }
  }

  // ── TRIVIA ANSWER CHECK — runs before shouldRespond so trivia channel works ──
  if (triviaActive.has(message.channel.id)) {
    const trivia = triviaActive.get(message.channel.id);
    console.log('[TRIVIA] Channel: ' + message.channel.id + ', Expected: ' + trivia.answer + ', Got: ' + lower);
    if (!trivia.winnerId && lower.includes(trivia.answer.toLowerCase())) {
      trivia.winnerId = userId;
      const code = generateCouponCode();
      // PHASE 2: Award XP + track trivia win
      if (db) {
        const tStart = triviaActive.get(message.channel.id).startTime || Date.now();
        const elapsed = (Date.now() - tStart) / 1000;
        await addXP(userId, message.author.username, XP_VALUES.trivia_win, message.guild);
        await db.query('UPDATE members SET trivia_wins = trivia_wins + 1 WHERE user_id=$1', [userId]);
        const mTrivia = await dbGet(userId);
        if (mTrivia && mTrivia.trivia_wins >= 25) await awardBadge(userId, message.author.username, 'trivia_master', message.guild);
        if (elapsed <= 60) await awardBadge(userId, message.author.username, 'lightning_reflexes', message.guild);
      }
      try {
        await message.author.send(
          `🏆 **Congratulations! You won the Soul Harbor Trivia Contest!**

` +
          `Your exclusive **${CONFIG.COUPONS.DISCOUNT_PERCENT}% discount code** is:
` +
          `# \`${code}\`

` +
          `Use it at **thepaganshoponline.com** at checkout.
` +
          `Valid for 7 days. Keep this code private! 🛍️🔮`
        );
      } catch(e) {
        console.log('Could not DM winner:', e.message);
      }
      const embed = makeEmbed(
        '🏆 We Have a Winner!',
        `🎉 Congratulations ${message.author}! You answered correctly!

` +
        `Your discount code has been sent to your **DMs** — check your private messages! 🔮

` +
        `Thanks everyone for playing! Next contest coming soon. 🏆`,
        0xFFD700
      );
      message.channel.send({ embeds: [embed] });
      triviaActive.delete(message.channel.id);
      const role = message.guild.roles.cache.find(r => r.name === CONFIG.ROLES.CONTEST_CHAMPION);
      if (role) message.member.roles.add(role).catch(console.error);
      return;
    }
  }

  // ── MODERATION ──
  const foundBadWord = BAD_WORDS.find(w => lower.includes(w));
  if (foundBadWord) {
    const count = (warnCount.get(userId) || 0) + 1;
    warnCount.set(userId, count);

    await message.delete().catch(() => {});

    if (count === 1) {
      message.channel.send(`⚠️ ${message.author}, please keep our community respectful. **Warning 1/3**`);
    } else if (count === 2) {
      message.channel.send(`⚠️ ${message.author}, this is your **final warning (2/3)**. Next violation will be reported.`);
    } else if (count >= 3) {
      message.channel.send(`🚫 ${message.author} has received 3 warnings for inappropriate language.`);
      // DM Billy (owner) + all Moderators
      const alertMsg = `🚨 **Moderation Alert** — **${message.guild.name}**\n` +
        `User **${message.author.tag}** has received 3 warnings for inappropriate language.\n` +
        `Last message: "${message.content}"\n\n` +
        `Do you want to kick or ban this user?`;

      console.log('Attempting to DM owner ID:', CONFIG.OWNER_ID);

      // Method 1: fetch from guild members
      try {
        const guild = message.guild;
        await guild.members.fetch();
        const ownerMember = guild.members.cache.get(CONFIG.OWNER_ID);
        if (ownerMember) {
          await ownerMember.send(alertMsg);
          console.log('✅ Moderation DM sent via guild member');
        } else {
          // Method 2: fetch user directly
          const ownerUser = await client.users.fetch(CONFIG.OWNER_ID);
          await ownerUser.send(alertMsg);
          console.log('✅ Moderation DM sent via user fetch');
        }
      } catch(e) {
        console.log('❌ Could not DM owner:', e.message);
        // Method 3: post in admin channel as fallback
        const adminChannel = message.guild.channels.cache.find(c => 
          c.name.includes('admin') && c.type === 0);
        if (adminChannel) {
          adminChannel.send(`🚨 <@${CONFIG.OWNER_ID}> **Moderation Alert:** ${message.author.tag} received 3 warnings. Last message: "${message.content}"`);
        }
      }

      // DM all mods too
      const modRoleForDM = message.guild.roles.cache.find(r => r.name.toLowerCase() === 'mod');
      if (modRoleForDM) {
        modRoleForDM.members.forEach(async (member) => {
          if (member.id !== CONFIG.OWNER_ID) {
            member.send(alertMsg).catch(() => {});
          }
        });
      }

      // DM all members with 'mod' role
      const modRole = message.guild.roles.cache.find(r => r.name.toLowerCase() === 'mod');
      if (modRole) {
        modRole.members.forEach(async (member) => {
          if (member.id !== CONFIG.OWNER_ID) { // avoid double DM to Billy if he has mod role
            member.send(alertMsg).catch(() => {});
          }
        });
      }
      warnCount.set(userId, 0);
    }
    return;
  }

  // ── ALL ! COMMANDS — checked before natural language, run from any channel ──
  if (content.startsWith('!')) {
    if (lower === '!setup') { await handleSetup(message); return; }
    if (lower === '!help' || lower === '!commands') { await handleHelp(message); return; }
    if (lower.startsWith('!tarot') || lower.startsWith('!reading')) { await handleTarot(message); return; }
    if (lower.startsWith('!ghost') || lower.startsWith('!story')) { await handleGhostStory(message); return; }
    if (lower.startsWith('!trivia') || lower.startsWith('!contest')) { await handleTrivia(message); return; }
    if (lower.startsWith('!horoscope')) { await handleHoroscope(message); return; }
    if (lower.startsWith('!spirit ')) { await handleSpiritInfo(message, content.slice(8)); return; }
    if (lower.startsWith('!badge')) { await handleBadges(message); return; }
    // Phase 2 commands
    if (lower === '!xp' || lower === '!level') { await handleXP(message); return; }
    if (lower.startsWith('!profile')) { await handleProfile(message); return; }
    if (lower === '!leaderboard' || lower === '!lb') { await handleLeaderboard(message); return; }
    if (lower.startsWith('!keep')) { const args = content.slice(5).trim().split(/\s+/); await handleKeep(message, args); return; }
    if (lower.startsWith('!ask ')) { await handleAsk(message, content.slice(5).trim()); return; }
    if (lower === '!class' || lower === '!classes') {
      const topicIdx = Math.floor(Date.now() / (7*24*60*60*1000)) % CLASS_TOPICS.length;
      const embed = makeEmbed('📚 Spirit Keeping Academy',
        `**Next Class:** ${CLASS_TOPICS[topicIdx]}\n🕖 Every Wednesday at 6PM EST\n\nReact with 📖 when class starts to earn **30 XP**!\n\nUse \`!ask <question>\` to ask Soul Harbor anything.`
      );
      message.channel.send({ embeds: [embed] }); return;
    }
    if (lower === '!allbadges') {
      const embed = new EmbedBuilder().setColor(0x7B2FBE).setTitle('🎖️ Soul Harbor Badges');
      const earned = db ? ((await dbGet(userId))?.badges || []) : [];
      for (const [key, b] of Object.entries(BADGES_DEF)) {
        embed.addFields({ name: `${b.emoji} ${b.name} ${earned.includes(key)?'✅':'🔒'}`, value: b.desc, inline: true });
      }
      embed.setFooter({ text: '🔮 Soul Harbor • The Pagan Shop Online' }).setTimestamp();
      message.channel.send({ embeds: [embed] }); return;
    }
    // Unknown ! command — don't fall through to AI chat
    return;
  }

  // ── NATURAL LANGUAGE INTENT DETECTION ──
  const isMentioned = message.mentions.has(client.user);
  const isDM = !message.guild;
  const rawChannelName = message.channel.name ? message.channel.name.replace(/[^a-z0-9-]/gi, '').toLowerCase() : '';
  const isGeneralChat = rawChannelName === 'soulharborchat' || rawChannelName === 'soulharbor-chat' || rawChannelName.includes('soulharborchat') || rawChannelName === 'paganshopchat' || rawChannelName === 'paganshop-chat' || rawChannelName.includes('paganshopchat');
  const isCommand = content.startsWith('!');

  // STRICT RESPONSE RULES:
  // - In paganshop-chat or soulharbor-chat: ONLY respond when @mentioned or using a ! command
  // - In other channels: ONLY respond when @mentioned
  // - In DMs: always respond
  // - NEVER respond to messages that @mention someone else but not the bot
  // - NEVER respond to empty messages, single emojis, or very short messages
  const shouldRespond = isDM || isMentioned || (isGeneralChat && isCommand);

  // Ignore very short messages (emojis, reactions, single words not directed at bot)
  if (!isDM && !isMentioned && content.length < 3) return;

  // If in general chat but not mentioned and not a command, ignore
  if (!shouldRespond) return;

  // If mentioned but the mention is for someone else (not the bot), ignore
  if (!isMentioned && !isDM && !isCommand) return;

  if (shouldRespond) {
    // Strip the @mention from content if present
    const cleanContent = content.replace(/<@!?\d+>/g, '').trim();
    const cleanLower = cleanContent.toLowerCase();

    // Tarot / card reading intent
    if (cleanLower.match(/tarot|card reading|card spread|pull.*card|draw.*card|\d+.card|one.card|two.card|three.card|four.card|five.card|six.card|seven.card|eight.card|nine.card|ten.card|reading/)) {
      await handleTarot(message);
      return;
    }

    // Ghost story / paranormal story intent
    if (cleanLower.match(/ghost story|ghost stories|paranormal story|horror story|scary story|tell.*story|give.*story/)) {
      await handleGhostStory(message);
      return;
    }

    // Trivia / contest intent
    if (cleanLower.match(/trivia|contest|quiz|question|game|win|discount/)) {
      await handleTrivia(message);
      return;
    }

    // Horoscope intent
    if (cleanLower.match(/horoscope|zodiac|astrology|sign|aries|taurus|gemini|cancer|leo|virgo|libra|scorpio|sagittarius|capricorn|aquarius|pisces/)) {
      await handleHoroscope(message);
      return;
    }

    // Spirit / entity info intent
    const spiritMatch = cleanLower.match(/tell me about (.+)|who is (.+)|what is (.+)|info on (.+)|information about (.+)/);
    if (spiritMatch) {
      const spiritName = (spiritMatch[1] || spiritMatch[2] || spiritMatch[3] || spiritMatch[4] || spiritMatch[5]).trim();
      await handleSpiritInfo(message, spiritName);
      return;
    }

    // Badges intent
    if (cleanLower.match(/badge|badges|my rank|my level|achievements/)) {
      await handleBadges(message);
      return;
    }

    // Help intent
    if (cleanLower.match(/help|commands|what can you do|what do you do/)) {
      await handleHelp(message);
      return;
    }

    // Everything else — natural AI conversation
    await handleChat(message, cleanContent);
    return;
  }

});

// ─── TAROT READING ───────────────────────────────────────
const TAROT_DECK = [
  { name: 'The Fool',           emoji: '🌟', keywords: 'new beginnings, spontaneity, innocence' },
  { name: 'The Magician',       emoji: '✨', keywords: 'willpower, resourcefulness, skill' },
  { name: 'The High Priestess', emoji: '🌙', keywords: 'intuition, mystery, inner knowing' },
  { name: 'The Empress',        emoji: '🌿', keywords: 'fertility, abundance, nurturing' },
  { name: 'The Emperor',        emoji: '👑', keywords: 'authority, structure, stability' },
  { name: 'The Hierophant',     emoji: '🕯️', keywords: 'tradition, guidance, spiritual wisdom' },
  { name: 'The Lovers',         emoji: '💜', keywords: 'love, harmony, alignment' },
  { name: 'The Chariot',        emoji: '⚡', keywords: 'victory, determination, willpower' },
  { name: 'Strength',           emoji: '🦁', keywords: 'courage, patience, inner strength' },
  { name: 'The Hermit',         emoji: '🔦', keywords: 'solitude, introspection, guidance' },
  { name: 'Wheel of Fortune',   emoji: '🎡', keywords: 'cycles, fate, turning points' },
  { name: 'Justice',            emoji: '⚖️', keywords: 'fairness, truth, cause and effect' },
  { name: 'The Hanged Man',     emoji: '🌀', keywords: 'surrender, new perspective, pause' },
  { name: 'Death',              emoji: '🌑', keywords: 'transformation, endings, transition' },
  { name: 'Temperance',         emoji: '🌊', keywords: 'balance, patience, moderation' },
  { name: 'The Devil',          emoji: '🔗', keywords: 'shadow self, addiction, materialism' },
  { name: 'The Tower',          emoji: '💥', keywords: 'upheaval, chaos, revelation' },
  { name: 'The Star',           emoji: '⭐', keywords: 'hope, renewal, serenity' },
  { name: 'The Moon',           emoji: '🌕', keywords: 'illusion, fear, the subconscious' },
  { name: 'The Sun',            emoji: '☀️', keywords: 'joy, success, vitality' },
  { name: 'Judgement',          emoji: '🔔', keywords: 'reflection, reckoning, awakening' },
  { name: 'The World',          emoji: '🌍', keywords: 'completion, integration, accomplishment' },
  { name: 'Ace of Wands',       emoji: '🔥', keywords: 'inspiration, new energy, potential' },
  { name: 'Two of Cups',        emoji: '💞', keywords: 'partnership, attraction, connection' },
  { name: 'Three of Pentacles', emoji: '🏗️', keywords: 'teamwork, learning, implementation' },
  { name: 'Four of Swords',     emoji: '😴', keywords: 'rest, recovery, contemplation' },
  { name: 'Five of Cups',       emoji: '😢', keywords: 'loss, regret, grief' },
  { name: 'Six of Wands',       emoji: '🏆', keywords: 'victory, recognition, progress' },
  { name: 'Seven of Pentacles', emoji: '🌱', keywords: 'patience, investment, long-term vision' },
  { name: 'Eight of Cups',      emoji: '🚶', keywords: 'walking away, seeking truth, transition' },
  { name: 'Nine of Swords',     emoji: '😰', keywords: 'anxiety, worry, fear' },
  { name: 'Ten of Pentacles',   emoji: '🏡', keywords: 'legacy, family, long-term security' },
  { name: 'King of Cups',       emoji: '🧘', keywords: 'emotional balance, compassion, wisdom' },
  { name: 'Queen of Wands',     emoji: '🦋', keywords: 'confidence, independence, passion' },
  { name: 'Knight of Swords',   emoji: '⚔️', keywords: 'ambition, action, speed' },
  { name: 'Page of Pentacles',  emoji: '📚', keywords: 'ambition, desire, diligence' },
  { name: 'Ace of Cups',        emoji: '💧', keywords: 'new love, compassion, creativity' },
  { name: 'Three of Swords',    emoji: '💔', keywords: 'heartbreak, sorrow, grief' },
  { name: 'Ten of Cups',        emoji: '🌈', keywords: 'happiness, harmony, fulfillment' },
  { name: 'Ace of Swords',      emoji: '🗡️', keywords: 'clarity, truth, breakthrough' },
];

const SPREAD_POSITIONS = {
  3:  ['Past', 'Present', 'Future'],
  4:  ['Mind', 'Body', 'Spirit', 'Outcome'],
  5:  ['Past', 'Present', 'Future', 'Hopes', 'Fears'],
  6:  ['Past', 'Present', 'Future', 'Foundation', 'Challenge', 'Outcome'],
  7:  ['Past', 'Present', 'Future', 'Foundation', 'Challenge', 'Advice', 'Outcome'],
  8:  ['Past', 'Present', 'Future', 'Foundation', 'Challenge', 'Hidden Influence', 'Advice', 'Outcome'],
  9:  ['Past', 'Present', 'Future', 'Foundation', 'Challenge', 'Hidden Influence', 'Advice', 'Hopes', 'Outcome'],
  10: ['Present Situation','Immediate Challenge','Distant Past','Recent Past','Best Outcome','Immediate Future','Your Influence','External Influence','Hopes & Fears','Final Outcome'],
  12: ['Past','Present','Future','Foundation','Challenge','Hidden Influence','Advice','External Energy','Inner Strength','Hopes','Fears','Final Outcome'],
  14: ['Distant Past','Recent Past','Present','Near Future','Far Future','Foundation','Challenge','Hidden Influence','Your Influence','External Influence','Advice','Inner Strength','Hopes & Fears','Final Outcome'],
};

function shuffleDeck(count) {
  const shuffled = [...TAROT_DECK].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

async function handleTarot(message) {
  // Soul Harbor interaction XP
  if (db && message.guild) {
    await dbEnsure(message.author.id, message.author.username);
    await addXP(message.author.id, message.author.username, XP_VALUES.soul_harbor_tarot, message.guild);
    await db.query('UPDATE members SET soul_harbor_interactions = soul_harbor_interactions + 1 WHERE user_id=$1', [message.author.id]);
    const mCheck = await dbGet(message.author.id);
    if (mCheck && mCheck.soul_harbor_interactions >= 50) await awardBadge(message.author.id, message.author.username, 'spirit_conversant', message.guild);
  }
  const content = message.content;
  // Detect card count from digits OR written words
  const wordNums = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, 'a':3 };
  const numMatch = content.match(/(\d+)[- ]*card/i);
  const wordMatch = content.match(/(one|two|three|four|five|six|seven|eight|nine|ten)[- ]*card/i);
  // Also check for digit immediately followed by card
  const digitMatch = content.match(/(\d+)[\s-]*card/i);
  let cardCount = 3;
  if (digitMatch) cardCount = parseInt(digitMatch[1]);
  else if (numMatch) cardCount = parseInt(numMatch[1]);
  else if (wordMatch) cardCount = wordNums[wordMatch[1].toLowerCase()] || 3;
  if (cardCount < 3) cardCount = 3;
  if (cardCount > 14) cardCount = 14;
  const validSpreads = [3, 4, 5, 6, 7, 10, 12, 14];
  cardCount = validSpreads.reduce((prev, curr) => Math.abs(curr - cardCount) < Math.abs(prev - cardCount) ? curr : prev);

  const positions = SPREAD_POSITIONS[cardCount];
  const drawn = shuffleDeck(cardCount);

  const typing = await message.channel.send('🔮 *The spirits are laying out your cards...*');

  const cardList = drawn.map((c, i) => `${positions[i]}: ${c.name} (${c.keywords})`).join('\n');
  const prompt = `Do a mystical ${cardCount}-card tarot reading for ${message.author.username}.\nCards drawn:\n${cardList}\n\nGive a personal, flowing, insightful reading that connects ALL the cards together as a narrative. Reference each card's position by name. Be mystical, warm, and specific. Under 400 words.`;

  const reading = await askGPT([
    { role: 'system', content: SPIRIT_SYSTEM_PROMPT },
    { role: 'user', content: prompt }
  ], 600);

  await typing.delete().catch(() => {});
  if (!reading) { message.channel.send('🔮 The spirits are clouded right now. Try again later.'); return; }

  const headerEmbed = makeEmbed(
    `🃏 ${cardCount}-Card Tarot Reading for ${message.author.displayName}`,
    drawn.map((c, i) => `${c.emoji} **${positions[i]}** — ${c.name}\n*${c.keywords}*`).join('\n\n')
  );
  message.channel.send({ embeds: [headerEmbed] });

  const readingEmbed = makeEmbed('🔮 Your Reading', reading, 0x2d1b69);
  message.channel.send({ embeds: [readingEmbed] });

  // PHASE 2: Track tarot count + badge
  if (db) {
    await dbEnsure(message.author.id, message.author.username);
    await db.query('UPDATE members SET tarot_count = tarot_count + 1 WHERE user_id=$1', [message.author.id]);
    const mTarot = await dbGet(message.author.id);
    if (mTarot && mTarot.tarot_count >= 25) await awardBadge(message.author.id, message.author.username, 'the_seer', message.guild);
  }
}


// ─── GHOST STORY ─────────────────────────────────────────
async function handleGhostStory(message) {
  // Soul Harbor interaction XP
  if (db && message.guild) {
    await dbEnsure(message.author.id, message.author.username);
    await addXP(message.author.id, message.author.username, XP_VALUES.soul_harbor_ghost, message.guild);
    await db.query('UPDATE members SET soul_harbor_interactions = soul_harbor_interactions + 1 WHERE user_id=$1', [message.author.id]);
    const mCheck = await dbGet(message.author.id);
    if (mCheck && mCheck.soul_harbor_interactions >= 50) await awardBadge(message.author.id, message.author.username, 'spirit_conversant', message.guild);
  }
  const typing = await message.channel.send('👻 *Reaching into the shadow realm...*');

  const story = await askGPT([
    { role: 'system', content: SPIRIT_SYSTEM_PROMPT },
    { role: 'user', content: 'Write a short, creepy, atmospheric ghost story (150-200 words). Make it original, eerie, and leave the ending unsettling. Set it in a real-feeling location.' }
  ], 350);

  await typing.delete().catch(() => {});

  if (!story) {
    message.channel.send('👻 The spirits have gone quiet. Try again later.');
    return;
  }

  const embed = makeEmbed('👻 A Tale From The Shadow Realm', story, 0x1a0a2e);
  message.channel.send({ embeds: [embed] });
}

// ─── TRIVIA CONTEST ──────────────────────────────────────
async function handleTrivia(message) {
  if (triviaActive.has(message.channel.id)) {
    message.channel.send('🎯 A contest is already active! Answer the current question first.');
    return;
  }

  const typing = await message.channel.send('🎯 *Consulting the spirits for a question...*');

  const result = await askGPT([
    { role: 'system', content: SPIRIT_SYSTEM_PROMPT },
    { role: 'user', content: `Generate a trivia question about spirits, the paranormal, metaphysical topics, or spirit keeping. IMPORTANT: Do NOT ask any of these already-used questions (pick something completely different): ${recentTriviaQuestions.length > 0 ? recentTriviaQuestions.slice(-50).join(' | ') : 'none'}. Be creative and vary the topic — cover different areas like spirit types, rituals, gemstones, mythology, divination tools, herbs, moon phases, etc. Format EXACTLY as:\nQUESTION: [question here]\nANSWER: [one word or short phrase answer]` }
  ], 150);

  await typing.delete().catch(() => {});

  if (!result) {
    message.channel.send('🎯 Could not generate a question. Try again!');
    return;
  }

  const qMatch = result.match(/QUESTION:\s*(.+)/i);
  const aMatch = result.match(/ANSWER:\s*(.+)/i);

  if (!qMatch || !aMatch) {
    message.channel.send('🎯 Could not generate a question. Try again!');
    return;
  }

  const question = qMatch[1].trim();
  const answer = aMatch[1].trim();

  triviaActive.set(message.channel.id, { answer, winnerId: null, startTime: Date.now() });
  recentTriviaQuestions.push(question);
  if (recentTriviaQuestions.length > 50) recentTriviaQuestions.shift();
  saveTriviaHistory(recentTriviaQuestions);

  const embed = makeEmbed(
    '🏆 Spirit Trivia Contest!',
    `**${question}**\n\n` +
    `First correct answer wins a **${CONFIG.COUPONS.DISCOUNT_PERCENT}% discount code**! 🎁\n\n` +
    `⏱️ You have 5 minutes!`,
    0xFFD700
  );

  message.channel.send({ embeds: [embed] });

  // Auto-expire after 2 minutes
  setTimeout(() => {
    if (triviaActive.has(message.channel.id) && !triviaActive.get(message.channel.id).winnerId) {
      triviaActive.delete(message.channel.id);
      const expireEmbed = makeEmbed('⏱️ Time\'s Up!', `Nobody answered in time! The answer was: **${answer}**\n\nBetter luck next time! 🔮`);
      message.channel.send({ embeds: [expireEmbed] });
    }
  }, 300000); // 5 minutes
}

// ─── HOROSCOPE ───────────────────────────────────────────
async function handleHoroscope(message) {
  // Soul Harbor interaction XP
  if (db && message.guild) {
    await dbEnsure(message.author.id, message.author.username);
    await addXP(message.author.id, message.author.username, XP_VALUES.soul_harbor_horoscope, message.guild);
    await db.query('UPDATE members SET soul_harbor_interactions = soul_harbor_interactions + 1 WHERE user_id=$1', [message.author.id]);
    const mCheck = await dbGet(message.author.id);
    if (mCheck && mCheck.soul_harbor_interactions >= 50) await awardBadge(message.author.id, message.author.username, 'spirit_conversant', message.guild);
  }
  const signs = ['aries','taurus','gemini','cancer','leo','virgo','libra','scorpio','sagittarius','capricorn','aquarius','pisces'];
  const lower = message.content.toLowerCase();
  const sign = signs.find(s => lower.includes(s)) || 'general';

  const horoscope = await askGPT([
    { role: 'system', content: SPIRIT_SYSTEM_PROMPT },
    { role: 'user', content: `Give a mystical, spirit-themed daily horoscope for ${sign}. Connect it to spirit energy and metaphysical themes. 100 words max.` }
  ], 200);

  if (!horoscope) return;

  const embed = makeEmbed(`🌙 Daily Horoscope${sign !== 'general' ? ` — ${sign}` : ''}`, horoscope, 0x2d1b69);
  message.channel.send({ embeds: [embed] });
}

// ─── SPIRIT INFO ─────────────────────────────────────────
async function handleSpiritInfo(message, spiritName) {
  const typing = await message.channel.send(`🔮 *Consulting the encyclopedia on ${spiritName}...*`);

  const info = await askGPT([
    { role: 'system', content: SPIRIT_SYSTEM_PROMPT },
    { role: 'user', content: `Give a brief overview of the spirit/entity "${spiritName}" — what they are, their energy (White Arts/Dark Arts/Black Arts), realm of origin, and what they help with as a spirit companion. Keep it under 200 words. End with: "Learn more at thepaganshoponline.com 🔮"` }
  ], 300);

  await typing.delete().catch(() => {});
  if (!info) return;

  const embed = makeEmbed(`🔮 ${spiritName}`, info);
  message.channel.send({ embeds: [embed] });
}

// ─── GENERAL CHAT ────────────────────────────────────────
async function handleChat(message, userInput) {
  const reply = await askGPT([
    { role: 'system', content: SPIRIT_SYSTEM_PROMPT },
    { role: 'user', content: userInput }
  ], 350);

  if (reply) message.reply(reply);
}

// ─── COUPON ──────────────────────────────────────────────
async function handleCoupon(message) {
  // Only for VIP Keeper role
  const hasVIP = message.member.roles.cache.find(r => r.name === CONFIG.ROLES.VIP_KEEPER);
  if (!hasVIP) {
    message.reply('🔮 Discount codes are earned through contests and VIP status. Join a trivia contest to win one!');
    return;
  }
  const code = generateCouponCode();
  message.author.send(`🎁 Your exclusive discount code: \`${code}\`\nUse at thepaganshoponline.com — valid 7 days!`);
  message.reply('✅ Your discount code has been sent to your DMs! 🎁');
}

// ─── BADGES ──────────────────────────────────────────────
async function handleBadges(message) {
  const roles = message.member.roles.cache
    .filter(r => Object.values(CONFIG.ROLES).includes(r.name))
    .map(r => `✅ ${r.name}`)
    .join('\n');

  let phase2 = '';
  if (db) {
    const m = await dbGet(message.author.id);
    const earned = (m?.badges || []);
    phase2 = earned.length
      ? '\n\n**🎖️ Achievement Badges:**\n' + earned.map(k => BADGES_DEF[k] ? `${BADGES_DEF[k].emoji} ${BADGES_DEF[k].name}` : '').filter(Boolean).join(' · ')
      : '\n\n*No achievement badges yet — post altar pics, win trivia, attend classes!*';
  }

  const embed = makeEmbed(
    `🏅 Badges for ${message.author.displayName}`,
    (roles || 'No server roles yet! Participate to earn badges! 🔮\n\n' +
    '**How to earn roles:**\n' +
    '🔮 Spirit Seeker — join the server\n' +
    '🏆 Contest Champion — win a trivia contest\n' +
    '💎 VIP Keeper — make a purchase from the shop\n' +
    '⭐ Spirit Elder — long time active member') + phase2 +
    '\n\n*Use `!allbadges` to see all achievement badges*'
  );
  message.channel.send({ embeds: [embed] });
}

// ─── HELP ────────────────────────────────────────────────
async function handleHelp(message) {
  const embed = makeEmbed(
    '🔮 Soul Harbor Commands',
    '**🎮 Core:**\n' +
    '`!tarot` — Get a tarot reading (+15 XP)\n' +
    '`!ghost` — Hear a ghost story (+8 XP)\n' +
    '`!trivia` — Start a contest, win discount codes (+75 XP)\n' +
    '`!horoscope [sign]` — Get your daily horoscope (+8 XP)\n' +
    '`!spirit [name]` — Learn about any spirit or entity\n' +
    '`!ask [question]` — Ask Soul Harbor anything (+10 XP)\n\n' +
    '**⭐ XP & Levels:**\n' +
    '`!xp` — Check your XP and level\n' +
    '`!profile [@user]` — View a full profile card\n' +
    '`!leaderboard` — Top 10 members by XP\n\n' +
    '**📖 Spirit Keep (Private Journal):**\n' +
    '`!keep add <spirit> <note>` — Add a journal entry\n' +
    '`!keep view [spirit]` — Read your journal (DM\'d to you)\n' +
    '`!keep list` — See all your spirits\n\n' +
    '**🎖️ Badges:**\n' +
    '`!badges` — See your earned badges\n' +
    '`!allbadges` — See all available achievement badges\n' +
    '`!class` — View next class schedule\n\n' +
    '**⭐ How to Earn XP:**\n' +
    '💬 Chat — 2 XP/min\n' +
    '🔮 Tarot reading — 15 XP\n' +
    '🌙 Horoscope / Ghost story — 8 XP\n' +
    '❓ Ask Soul Harbor — 10 XP\n' +
    '🕯️ Post altar pic — 50 XP\n' +
    '✨ Post manifestation pic — 50 XP\n' +
    '🌙 Post spell or ritual — 60 XP\n' +
    '👁️ Share paranormal story — 75 XP\n' +
    '🏆 Win trivia contest — 75 XP\n' +
    '📚 Attend a class — 40 XP\n' +
    '👋 Refer a friend — 100 XP\n\n' +
    '🛍️ Shop: **thepaganshoponline.com**'
  );
  message.channel.send({ embeds: [embed] });
}

// ─── SCHEDULED DAILY TASKS ───────────────────────────────
function scheduleDailyTasks() {
  const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
  if (!guild) return;

  // Daily ghost story — 8pm every day
  cron.schedule('0 0 * * *', async () => { // 8pm EDT (UTC-4)
    const channel = getChannel(guild, CONFIG.CHANNELS.GHOST_STORY);
    if (!channel) return;

    const story = await askGPT([
      { role: 'system', content: SPIRIT_SYSTEM_PROMPT },
      { role: 'user', content: 'Write a short, original, creepy ghost story (150-200 words). Make it atmospheric and leave the ending unsettling.' }
    ], 350);

    if (story) {
      const embed = makeEmbed('👻 Tonight\'s Tale From The Shadow Realm', story, 0x1a0a2e);
      channel.send({ embeds: [embed] });
    }
  });

  // Daily tarot card of the day — 9am every day
  cron.schedule('0 13 * * *', async () => { // 9am EDT (UTC-4)
    const channel = getChannel(guild, CONFIG.CHANNELS.TAROT);
    if (!channel) return;

    const cards = ['The Moon','The Star','The Sun','The World','The Fool','The Magician','The High Priestess','Strength','The Hermit','Wheel of Fortune','The Tower','Judgement'];
    const card = cards[Math.floor(Math.random() * cards.length)];

    const reading = await askGPT([
      { role: 'system', content: SPIRIT_SYSTEM_PROMPT },
      { role: 'user', content: `Today's card of the day is "${card}". Give a brief daily message and guidance based on this card's energy. 100 words max. Make it feel mystical and personal.` }
    ], 200);

    if (reading) {
      const embed = makeEmbed('🃏 Card of the Day', `**${card}**\n\n${reading}`, 0x6B2D8B);
      channel.send({ embeds: [embed] });
    }
  });

  // Daily trivia contest — 6pm every day
  cron.schedule('0 22 * * *', async () => { // 6pm EDT (UTC-4)
    const channel = getChannel(guild, CONFIG.CHANNELS.TRIVIA);
    if (!channel) return;

    const result = await askGPT([
      { role: 'system', content: SPIRIT_SYSTEM_PROMPT },
      { role: 'user', content: `Generate a trivia question about spirits, paranormal, or metaphysical topics. IMPORTANT: Do NOT ask any of these already-used questions (pick something completely different): ${recentTriviaQuestions.length > 0 ? recentTriviaQuestions.slice(-50).join(' | ') : 'none'}. Be creative and vary the topic — cover different areas like spirit types, rituals, gemstones, mythology, divination tools, herbs, moon phases, etc. Format EXACTLY as:\nQUESTION: [question]\nANSWER: [short answer]` }
    ], 150);

    if (!result) return;

    const qMatch = result.match(/QUESTION:\s*(.+)/i);
    const aMatch = result.match(/ANSWER:\s*(.+)/i);
    if (!qMatch || !aMatch) return;

    const question = qMatch[1].trim();
    const answer = aMatch[1].trim();

    triviaActive.set(channel.id, { answer, winnerId: null, startTime: Date.now() });
    recentTriviaQuestions.push(question);
    if (recentTriviaQuestions.length > 50) recentTriviaQuestions.shift();
    saveTriviaHistory(recentTriviaQuestions);

    const embed = makeEmbed(
      '🏆 Daily Spirit Trivia!',
      `**${question}**\n\n` +
      `First correct answer wins a **${CONFIG.COUPONS.DISCOUNT_PERCENT}% discount code**! 🎁\n\n` +
      `⏱️ You have 5 minutes!`,
      0xFFD700
    );
    channel.send({ embeds: [embed] });

    setTimeout(() => {
      if (triviaActive.has(channel.id) && !triviaActive.get(channel.id).winnerId) {
        triviaActive.delete(channel.id);
        const expEmbed = makeEmbed('⏱️ Time\'s Up!', `Nobody answered! The answer was: **${answer}**\n\nNew contest tomorrow! 🔮`);
        channel.send({ embeds: [expEmbed] });
      }
    }, 300000); // 5 minutes
  });

  console.log('✅ Daily tasks scheduled');

  // PHASE 2: Weekly class — Wednesday 6pm EST (11pm UTC)
  cron.schedule('0 23 * * 3', async () => {
    await runWeeklyClass(guild);
  });
  console.log('✅ Weekly class scheduled (Wednesdays 6pm EST)');
}

// ─── LOGIN ───────────────────────────────────────────────

// ─── ONE-TIME SETUP COMMAND ───────────────────────────────
const CATEGORY_RENAMES = {
  'private zone':          '🔒・PRIVATE ZONE',
  'important':             '📋・WELCOME & RULES',
  'main':                  '💬・COMMUNITY',
  'main channels':         '💬・MAIN CHANNELS',
  'the pagan shop online': '🏪・THE PAGAN SHOP',
  'the pagan shop':        '🏪・THE PAGAN SHOP',
  'conjures list':         '🧿・CONJURES LIST',
  'affiliates':            '🤝・AFFILIATES',
  'soul harbor':           '🔮・SOUL HARBOR',
  'education':             '📚・EDUCATION',
  'community':             '💬・COMMUNITY',
  'shop':                  '🏪・SHOP',
  'bot':                   '🤖・BOT',
  'staff':                 '🛡️・STAFF',
  'events':                '📅・EVENTS',
  'conjures':              '🧿・CONJURES',
};

function getSmartEmoji(channelName) {
  const n = channelName.toLowerCase();
  const rules = [
    [/admin|mod.rules|staff.rules/, '🛡️'],
    [/mod.chat|staff.chat|admin.chat/, '💬'],
    [/bot.command|commands/, '🤖'],
    [/intro|welcome/, '👋'],
    [/rules/, '📜'],
    [/announc/, '📣'],
    [/soulharbor|soul.harbor.chat|harbor.chat/, '🔮'],
    [/ghost/, '👻'],
    [/tarot/, '🃏'],
    [/trivia|contest/, '🏆'],
    [/horoscope|astro/, '🌙'],
    [/shop.link|store.link/, '🛍️'],
    [/new.custom|pre.conjure|new.listing/, '🌟'],
    [/review/, '⭐'],
    [/event|sale|discount/, '📅'],
    [/about.billy|about.us/, '🧿'],
    [/spiritboard/, '🌐'],
    [/general|chat|lounge/, '🗣️'],
    [/gallery|photo|image/, '🖼️'],
    [/music/, '🎵'],
    [/movie|film|watch/, '🎬'],
    [/link|video|media/, '🔗'],
    [/gratitude|excite|celebrat/, '🙏'],
    [/vent|rant/, '💭'],
    [/nsfw|adult/, '🔞'],
    [/education|learn|class|lesson/, '📖'],
    [/blog|post|article/, '📝'],
    [/experience|story|stories|testimonial/, '✨'],
    [/auction/, '🔨'],
    [/angel/, '👼'],
    [/asia|asian|eastern/, '🌏'],
    [/creature|beast|monster/, '🐉'],
    [/demon|dark.arts/, '👿'],
    [/djinn|genie|jinn/, '🧞'],
    [/dragon/, '🐲'],
    [/elf|elven/, '🧝'],
    [/fae|fairy|faerie/, '🧚'],
    [/human|warlock|witch/, '👤'],
    [/hybrid|mix/, '🔀'],
    [/immortal|eternal/, '♾️'],
    [/sexual|romance|love/, '🔥'],
    [/vampire|vamp/, '🧛'],
    [/xp|level|rank|badge|achievement/, '🏅'],
    [/leaderboard|top/, '🏆'],
    [/reward|point|earn/, '💎'],
    [/quest|mission|challenge/, '⚔️'],
    [/market|store|buy|sell/, '🛒'],
    [/conjure|custom/, '✨'],
    [/affiliat|partner|collab/, '🤝'],
    [/feedback|suggest/, '💡'],
    [/help|support|ticket/, '🆘'],
    [/voice|vc|audio/, '🎙️'],
    [/game|gaming/, '🎮'],
    [/art|creative|design/, '🎨'],
    [/spiritual|sacred|ritual/, '🕯️'],
    [/moon|lunar/, '🌕'],
    [/crystal|gem|stone/, '💎'],
    [/spell|magic|magick/, '✨'],
    [/divination|oracle/, '🔮'],
    [/healing|wellness/, '💚'],
    [/protection|shield/, '🛡️'],
    [/abundance|prosperity|wealth/, '💰'],
    [/spirit.companion|companion/, '💜'],
  ];
  for (const [pattern, emoji] of rules) {
    if (pattern.test(n)) return emoji;
  }
  return '✨';
}

const CHANNEL_RENAMES = {};



async function handleSetup(message) {
  const allowedIds = [CONFIG.OWNER_ID, '1511088381013262560']; // Billy + Arbeena
  if (!allowedIds.includes(message.author.id)) {
    message.reply('❌ Only admins can run this command.');
    return;
  }
  const msg = await message.reply('⏳ Starting channel organization... this will take 2-3 minutes.');
  const guild = message.guild;
  await guild.channels.fetch();
  let renamed = 0;
  let errors = 0;

  // Create Soul Harbor category if missing
  const existingCats = guild.channels.cache.filter(c => c.type === 4);
  const hasSoulHarborCat = existingCats.some(c => c.name.toLowerCase().includes('soul harbor'));
  if (!hasSoulHarborCat) {
    const soulHarborCat = await guild.channels.create({ name: '🔮・SOUL HARBOR', type: 4 }).catch(() => null);
    if (soulHarborCat) {
      const chats = ['soulharbor-chat', 'soul-harbor-ghost-stories'];
      for (const chName of chats) {
        const ch = guild.channels.cache.find(c => c.name === chName);
        if (ch) await ch.setParent(soulHarborCat.id).catch(() => {});
      }
    }
  }

  // Rename categories
  for (const channel of guild.channels.cache.values()) {
    if (channel.type === 4) {
      const key = channel.name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      const newName = CATEGORY_RENAMES[key];
      if (newName && channel.name !== newName) {
        try {
          await channel.setName(newName);
          renamed++;
          await new Promise(r => setTimeout(r, 1200));
        } catch(e) { errors++; }
      }
    }
  }

  // Smart emoji renaming for ALL channels without emojis
  for (const channel of guild.channels.cache.values()) {
    if (channel.type === 0 || channel.type === 2) {
      const firstCode = channel.name.codePointAt(0);
      if (firstCode > 127) continue; // already has emoji
      const emoji = getSmartEmoji(channel.name);
      const newName = emoji + '・' + channel.name;
      try {
        await channel.setName(newName);
        renamed++;
        await new Promise(r => setTimeout(r, 1500));
      } catch(e) { errors++; }
    }
  }

  msg.edit(`✅ Done! Renamed **${renamed}** channels and categories. Errors: ${errors}

The server is now organized! 🔮`);
}

// ── AUTO EMOJI ON NEW CHANNEL CREATION ──────────────────
client.on('channelCreate', async (channel) => {
  if (channel.type !== 0 && channel.type !== 2) return; // text or voice only
  const firstCode = channel.name.codePointAt(0);
  if (firstCode > 127) return; // already has emoji
  try {
    const emoji = getSmartEmoji(channel.name);
    const newName = emoji + '・' + channel.name;
    await channel.setName(newName);
    console.log(`Auto-emoji: ${channel.name} -> ${newName}`);
  } catch(e) {
    console.log('Could not auto-emoji channel:', e.message);
  }
});

// Raw event listener for DMs as fallback
client.on('raw', async (packet) => {
  if (packet.t !== 'MESSAGE_CREATE') return;
  if (packet.d.guild_id) return; // ignore server messages
  if (packet.d.author?.bot) return; // ignore bots
  
  console.log('📨 Raw DM packet received from:', packet.d.author?.username, '| Content:', packet.d.content);
  
  // Fetch the channel and create a proper message object
  try {
    const channel = await client.channels.fetch(packet.d.channel_id).catch(() => null);
    if (!channel) { console.log('Could not fetch DM channel'); return; }
    
    const dmContent = packet.d.content?.trim();
    if (!dmContent) return;
    
    // Create a minimal message-like object for our handlers
    const fakeMsg = {
      author: { id: packet.d.author.id, tag: packet.d.author.username, bot: false, displayAvatarURL: () => '' },
      content: dmContent,
      guild: null,
      channel: channel,
      reply: (text) => channel.send(typeof text === 'string' ? text : text),
      mentions: { has: () => false },
      partial: false,
      displayName: packet.d.author.username,
    };
    fakeMsg.author.displayName = packet.d.author.username;

    const dmLower = dmContent.toLowerCase();
    if (dmLower.match(/tarot|card reading|\d+.card|card spread/)) { await handleTarot(fakeMsg); return; }
    if (dmLower.match(/ghost story|paranormal story|scary story/)) { await handleGhostStory(fakeMsg); return; }
    if (dmLower.match(/horoscope|zodiac/)) { await handleHoroscope(fakeMsg); return; }
    if (dmLower.match(/help|commands/)) { await handleHelp(fakeMsg); return; }
    await handleChat(fakeMsg, dmContent);
  } catch(e) {
    console.log('❌ Raw DM handler error:', e.message);
  }
});

client.login(process.env.DISCORD_TOKEN);
