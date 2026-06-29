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
  const newCols = [
    `ALTER TABLE members ADD COLUMN IF NOT EXISTS manifestation_posts INTEGER DEFAULT 0`,
    `ALTER TABLE members ADD COLUMN IF NOT EXISTS paranormal_posts INTEGER DEFAULT 0`,
    `ALTER TABLE members ADD COLUMN IF NOT EXISTS soul_harbor_interactions INTEGER DEFAULT 0`,
    `ALTER TABLE members ADD COLUMN IF NOT EXISTS welcome_coupon TEXT DEFAULT NULL`,
  ];
  for (const sql of newCols) await db.query(sql).catch(() => {});
  // Ensure referrals table has unique constraint on invitee_id (prevents silent duplicate inserts)
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'referrals_invitee_unique'
      ) THEN
        ALTER TABLE referrals ADD CONSTRAINT referrals_invitee_unique UNIQUE (invitee_id);
      END IF;
    END $$;
  `).catch(() => {});
  console.log('✅ Phase 2 database ready');
}

const XP_VALUES = {
  chat:                    2,
  soul_harbor_tarot:      15,
  soul_harbor_ask:        10,
  soul_harbor_horoscope:   8,
  soul_harbor_ghost:       8,
  altar_pic:              50,
  manifestation_pic:      50,
  spell_post:             60,
  paranormal_story:       75,
  trivia_win:             75,
  class_attend:           40,
  referral:              100,
};

const LEVELS = [
  { level: 1,  name: 'Seeker',       xp: 0,      reward: null },
  { level: 5,  name: 'Initiate',     xp: 800,    reward: { type: 'discount', pct: 10 } },
  { level: 10, name: 'Neophyte',     xp: 2500,   reward: { type: 'discount', pct: 15 } },
  { level: 15, name: 'Practitioner', xp: 5000,   reward: { type: 'discount', pct: 18 } },
  { level: 20, name: 'Mystic',       xp: 9000,   reward: { type: 'discount', pct: 20 } },
  { level: 30, name: 'Magus',        xp: 18000,  reward: { type: 'discount', pct: 25 } },
  { level: 40, name: 'Elder',        xp: 32000,  reward: { type: 'giftcard',  value: 15 } },
  { level: 50, name: 'Grandmaster',  xp: 50000,  reward: { type: 'giftcard',  value: 25 } },
];

const BADGES_DEF = {
  lightning_reflexes:  { emoji: '⚡', name: 'Lightning Reflexes',   desc: 'Answer trivia in under 60 seconds' },
  the_seer:            { emoji: '🔮', name: 'The Seer',              desc: 'Complete 25 tarot readings' },
  trivia_master:       { emoji: '🏆', name: 'Trivia Master',         desc: 'Win 25 trivia contests' },
  verified_patron:     { emoji: '✅', name: 'Verified Patron',       desc: 'Verified purchase or review' },
  greeter:             { emoji: '👋', name: 'Greeter',               desc: 'Refer 3 friends to The Pagan Shop Online Discord' },
  coven_builder:       { emoji: '🌙', name: 'Coven Builder',         desc: 'Refer 10 friends to The Pagan Shop Online Discord' },
  high_priest:         { emoji: '👑', name: 'High Priest/ess',       desc: 'Refer 25+ members to The Pagan Shop Online Discord' },
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

// Per Billy (June 2026): mods CAN earn XP/levels now. Only the server owner is excluded.
async function isExcludedFromXP(member) {
  if (!member) return false;
  if (member.guild.ownerId === member.id) return true;
  if (CONFIG.OWNER_ID && member.id === CONFIG.OWNER_ID) return true;
  return false;
}

// Staff = exempt from auto-moderation (owner, admins, mod-type roles)
function isStaffMember(message) {
  if (!message.guild || !message.member) return false;
  if (message.author.id === message.guild.ownerId) return true;
  if (CONFIG.OWNER_ID && message.author.id === CONFIG.OWNER_ID) return true;
  if (message.member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (message.member.permissions?.has(PermissionFlagsBits.ManageMessages)) return true;
  const modRoles = ['mod', 'moderator', 'admin', 'staff', 'developer'];
  return message.member.roles.cache.some(r => modRoles.includes(r.name.toLowerCase()));
}

// Owner check — Discord guild owner, env OWNER_ID, OR server Administrator
function isOwner(message) {
  if (!message.guild) return false;
  if (message.author.id === message.guild.ownerId) return true;
  if (CONFIG.OWNER_ID && message.author.id === CONFIG.OWNER_ID) return true;
  // Also allow server Administrators to run owner commands
  if (message.member && message.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return false;
}

async function generateGiftVoucher(value) {
  try {
    const code = "GV-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).substr(2,4).toUpperCase();
    const res = await fetch(`${process.env.SHOP_URL}/create_coupon.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Coupon-Secret": process.env.BOT_COUPON_SECRET },
      body: JSON.stringify({ code, percent: 0, fixed: value, days: 365, type: "gift" })
    });
    const data = await res.json();
    if (data.success) { console.log(`Gift voucher created: ${code}`); return code; }
    return null;
  } catch(e) { console.error("Gift voucher error:", e.message); return null; }
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
  try {
    const member = await guild.members.fetch(userId);
    if (await isExcludedFromXP(member)) return;
  } catch(_) {}
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

const LEVEL_ROLE_COLORS = {
  'Seeker':       0x888888,
  'Initiate':     0x8B4513,
  'Neophyte':     0x228B22,
  'Practitioner': 0x1E90FF,
  'Mystic':       0x7B2FBE,
  'Magus':        0xFF8C00,
  'Elder':        0xFF0000,
  'Grandmaster':  0xFFD700,
};

async function ensureLevelRoles(guild) {
  for (const tier of LEVELS) {
    const existing = guild.roles.cache.find(r => r.name === tier.name);
    if (!existing) {
      try {
        await guild.roles.create({
          name: tier.name,
          color: LEVEL_ROLE_COLORS[tier.name] || 0x888888,
          reason: 'Soul Harbor XP level role',
          hoist: true,
          permissions: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions', 'AttachFiles', 'UseExternalEmojis', 'EmbedLinks'],
        });
        console.log(`✅ Created role: ${tier.name}`);
        await new Promise(r => setTimeout(r, 500));
      } catch(e) { console.error(`Failed to create role ${tier.name}:`, e.message); }
    } else {
      // Fix existing roles that were created without permissions
      const requiredPerms = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions', 'AttachFiles', 'UseExternalEmojis', 'EmbedLinks'];
      const hasView = existing.permissions.has('ViewChannel');
      if (!hasView) {
        try {
          await existing.setPermissions(requiredPerms, 'Soul Harbor: adding missing channel view permissions');
          console.log(`🔧 Fixed permissions for existing role: ${tier.name}`);
        } catch(e) { console.error(`Could not fix permissions for ${tier.name}:`, e.message); }
      }
    }
  }
}

async function handleLevelUp(userId, username, tier, guild) {
  try {
    const member = await guild.members.fetch(userId);
    if (await isExcludedFromXP(member)) { console.log(`Skipping level up rewards for excluded user: ${username}`); return; }

    // Keep old level roles (stacking per Billy) — new role's higher position makes it the display color
    // Only remove roles ABOVE the new tier (in case of a reset/demotion scenario)
    const newTierIdx = LEVELS.findIndex(l => l.level === tier.level);
    const higherRoles = LEVELS.slice(newTierIdx + 1).map(l => guild.roles.cache.find(r => r.name === l.name)).filter(Boolean);
    if (higherRoles.length) await member.roles.remove(higherRoles).catch(() => {});

    let newRole = guild.roles.cache.find(r => r.name === tier.name);
    if (!newRole) {
      newRole = await guild.roles.create({
        name: tier.name,
        color: LEVEL_ROLE_COLORS[tier.name] || 0x888888,
        reason: 'Soul Harbor XP level role',
          hoist: true,
          permissions: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions', 'AttachFiles', 'UseExternalEmojis', 'EmbedLinks'],
      }).catch(() => null);
    }
    if (newRole) await member.roles.add(newRole).catch(() => {});

    const generalChannel = getChannel(guild, CONFIG.CHANNELS.GENERAL);
    if (generalChannel) {
      const announceEmbed = new EmbedBuilder()
        .setColor(LEVEL_ROLE_COLORS[tier.name] || 0x7B2FBE)
        .setTitle(`🌟 Level Up!`)
        .setDescription(`🎉 Congratulations ${member}! You are now a **${tier.name}**!\n\nKeep earning XP to unlock more rewards! Type '!profile' to see your stats.`)
        .setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: '🔮 Soul Harbor • The Pagan Shop Online' })
        .setTimestamp();
      generalChannel.send({ embeds: [announceEmbed] }).catch(() => {});
    }

    const embed = new EmbedBuilder()
      .setColor(LEVEL_ROLE_COLORS[tier.name] || 0x7B2FBE)
      .setTitle(`🌟 Level Up! You are now a ${tier.name}`)
      .setDescription(`Congratulations **${username}**! You've reached **Level ${tier.level}** in Soul Harbor.\n\nYour role color has been updated — other members can now see your rank! 🎖️`)
      .setFooter({ text: '🔮 Soul Harbor • The Pagan Shop Online' })
      .setTimestamp();

    if (tier.reward?.type === 'discount') {
      const code = genCode('SOUL');
      await saveCouponToShop(code, tier.reward.pct);
      embed.addFields({ name: '🎁 Reward Unlocked!', value: `Here is your **${tier.reward.pct}% off** coupon for The Pagan Shop Online!\n\`${code}\`\n[Shop Now](https://www.thepaganshoponline.com)` });
      await member.send({ embeds: [embed] }).catch(() => {});
    } else if (tier.reward?.type === 'giftcard') {
      const gvCode = await generateGiftVoucher(tier.reward.value);
      if (gvCode) {
        embed.addFields({ name: '🎁 Gift Voucher Unlocked!', value: `You've earned a **$${tier.reward.value} Gift Voucher**!\n\nYour code: \`${gvCode}\`\n\nUse it at checkout on [thepaganshoponline.com](https://www.thepaganshoponline.com) — valid for 1 year! 🛍️` });
        await member.send({ embeds: [embed] }).catch(() => {});
        const billy = await guild.client.users.fetch(CONFIG.OWNER_ID).catch(() => null);
        if (billy) await billy.send(`🏆 **Auto Gift Voucher Issued!**\n**Member:** ${username}\n**Level:** ${tier.level} (${tier.name})\n**Voucher:** \`${gvCode}\` ($${tier.reward.value})\n\nThis was sent to them automatically — no action needed!`).catch(() => {});
      } else {
        embed.addFields({ name: '🎁 Grand Milestone Reward!', value: `You've earned a **$${tier.reward.value} Gift Card**! Billy will contact you within 48 hours.` });
        await member.send({ embeds: [embed] }).catch(() => {});
        const billy = await guild.client.users.fetch(CONFIG.OWNER_ID).catch(() => null);
        if (billy) await billy.send(`🏆 **Grand Milestone!** ${username} reached Level ${tier.level} (${tier.name}) — $${tier.reward.value} gift card owed! Auto-voucher failed, please contact them manually.`).catch(() => {});
      }
    } else {
      await member.send({ embeds: [embed] }).catch(() => {});
    }
  } catch(e) { console.error('LevelUp error:', e.message); }
}

// Badge role colors — each badge gets a distinct colored role
const BADGE_ROLE_COLORS = {
  verified_patron:    0x00B0FF,  // Light blue
  trivia_master:      0xFFD700,  // Gold
  the_seer:           0x9B59B6,  // Purple
  lightning_reflexes: 0xF1C40F,  // Yellow
  greeter:            0x2ECC71,  // Green
  coven_builder:      0x1ABC9C,  // Teal
  high_priest:        0xE74C3C,  // Red
  altar_keeper:       0xE67E22,  // Orange
  spell_weaver:       0x8E44AD,  // Dark purple
  class_scholar:      0x3498DB,  // Blue
  paranormal_witness: 0x95A5A6,  // Grey
  manifestor:         0xF39C12,  // Amber
  spirit_conversant:  0x1E8BC3,  // Steel blue
};

async function awardBadge(userId, username, key, guild) {
  if (!db) return;
  const m = await dbGet(userId);
  if (!m || m.badges.includes(key)) return;
  await db.query('UPDATE members SET badges = array_append(badges,$1) WHERE user_id=$2', [key, userId]);
  const b = BADGES_DEF[key];
  if (!b) return;
  try {
    const member = await guild.members.fetch(userId);

    // ── 1. DM the member ──
    const dmEmbed = new EmbedBuilder().setColor(BADGE_ROLE_COLORS[key] || 0xFFD700)
      .setTitle(`${b.emoji} Badge Unlocked: ${b.name}`)
      .setDescription(`*${b.desc}*\n\nYour badge is now displayed on your profile! Use \`!profile\` to show it off. 🔮`)
      .setFooter({ text: '🔮 Soul Harbor • The Pagan Shop Online' }).setTimestamp();
    await member.send({ embeds: [dmEmbed] }).catch(() => {});

    // ── 2. Assign badge role so it shows next to their name ──
    const roleName = `${b.emoji} ${b.name}`;
    let badgeRole = guild.roles.cache.find(r => r.name === roleName);
    if (!badgeRole) {
      badgeRole = await guild.roles.create({
        name: roleName,
        color: BADGE_ROLE_COLORS[key] || 0xFFD700,
        reason: `Soul Harbor badge: ${b.name}`,
        hoist: false,  // shows in member list under their level role
      }).catch(() => null);
    }
    if (badgeRole) await member.roles.add(badgeRole).catch(() => {});

    // ── 3. Public announcement in general channel ──
    const generalChannel = getChannel(guild, CONFIG.CHANNELS.GENERAL);
    if (generalChannel) {
      const announceEmbed = new EmbedBuilder()
        .setColor(BADGE_ROLE_COLORS[key] || 0xFFD700)
        .setTitle(`${b.emoji} Badge Earned!`)
        .setDescription(
          `🎉 Congratulations **${member}**!\n\n` +
          `You just earned the **${b.emoji} ${b.name}** badge!\n` +
          `*${b.desc}*\n\n` +
          `Keep it up — more badges and rewards await! Type \`!allbadges\` to see what you can earn. 🔮`
        )
        .setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: '🔮 Soul Harbor • The Pagan Shop Online' })
        .setTimestamp();
      generalChannel.send({ embeds: [announceEmbed] }).catch(() => {});
    }

  } catch(_) {}
}

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

  if (sub === 'upload') {
    const spiritName = args[1];
    if (!spiritName) return message.reply('Usage: `!keep upload <spirit name>` then attach a .txt file');
    const attachment = message.attachments.first();
    if (!attachment) return message.reply('Please attach a .txt or document file with your journal entry.');
    try {
      const response = await fetch(attachment.url);
      const text = await response.text();
      if (text.length > 4000) return message.reply('File too large — please keep entries under 4000 characters.');
      await db.query('INSERT INTO spirit_keep (user_id, spirit_name, content) VALUES ($1,$2,$3)', [userId, spiritName, text.substring(0, 4000)]);
      const embed = new EmbedBuilder().setColor(0x4A0E8F)
        .setTitle(`📖 Document Saved to Keep — ${spiritName}`)
        .setDescription(`${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`)
        .setFooter({ text: 'Your Keep is private. Only you can see it.' }).setTimestamp();
      return message.author.send({ embeds: [embed] }).catch(() => message.reply('✅ Document saved to your Spirit Keep!'));
    } catch(e) {
      return message.reply('❌ Could not read the file. Please send a plain text (.txt) file.');
    }
  }

  return message.reply('Commands: `!keep add <spirit> <note>` · `!keep upload <spirit>` (attach file) · `!keep view [spirit]` · `!keep list`');
}

async function handleVoiceMemo(message) {
  if (!db) return;
  const attachment = message.attachments.first();
  if (!attachment) return;
  const isAudio = attachment.contentType?.startsWith('audio/') || attachment.name?.match(/\.(mp3|ogg|wav|m4a|webm)$/i);
  if (!isAudio) return;
  await message.reply('🎙️ *Transcribing your voice memo...*');
  try {
    const audioResponse = await fetch(attachment.url);
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    const tempFile = `/tmp/voice_${message.author.id}_${Date.now()}.ogg`;
    require('fs').writeFileSync(tempFile, audioBuffer);
    const transcription = await getOpenAI().audio.transcriptions.create({
      file: require('fs').createReadStream(tempFile),
      model: 'whisper-1',
    });
    require('fs').unlinkSync(tempFile);
    if (!transcription.text) return message.reply('❌ Could not transcribe audio. Please try again.');
    await message.reply(`✅ Transcribed: *"${transcription.text.substring(0, 200)}${transcription.text.length > 200 ? '...' : ''}"*\n\nReply with: \`!keep add <spirit name> ${transcription.text.substring(0, 100)}\` to save this to your Keep, or type the spirit name to auto-save:`);
    await db.query('INSERT INTO spirit_keep (user_id, spirit_name, content) VALUES ($1,$2,$3)', [message.author.id, 'Voice Notes', transcription.text]);
    const embed = new EmbedBuilder().setColor(0x4A0E8F)
      .setTitle('🎙️ Voice Memo Saved to Keep')
      .setDescription(transcription.text.substring(0, 500))
      .setFooter({ text: 'Saved under "Voice Notes" — use !keep view "Voice Notes" to read' })
      .setTimestamp();
    message.author.send({ embeds: [embed] }).catch(() => {});
  } catch(e) {
    console.error('Voice transcription error:', e.message);
    message.reply('❌ Voice transcription failed. Please try typing your note with `!keep add <spirit> <note>`');
  }
}

async function handleInvite(message) {
  if (!db) return message.reply('🔮 Invite tracking requires a database.');
  const userId = message.author.id;
  const username = message.author.username;
  await dbEnsure(userId, username);
  try {
    const channel = message.channel;
    const invite = await message.guild.invites.create(channel, { maxAge: 0, maxUses: 0, unique: true, reason: `Referral invite for ${username}` });
    await db.query(`CREATE TABLE IF NOT EXISTS invite_links (code TEXT PRIMARY KEY, inviter_id TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
    await db.query('INSERT INTO invite_links (code, inviter_id) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING', [invite.code, userId]);
    const embed = new EmbedBuilder().setColor(0x7B2FBE)
      .setTitle('🔗 Your Personal Invite Link')
      .setDescription(`Share this link to invite friends to **The Pagan Shop Online Discord**!\n\n**Your invite link:**\nhttps://discord.gg/${invite.code}\n\nWhen someone joins using your link you'll earn **100 XP**! After they stay for 48 hours it's confirmed.\n\n👋 Refer 3 friends → **Greeter** badge\n🌙 Refer 10 friends → **Coven Builder** badge\n👑 Refer 25 friends → **High Priest/ess** badge`)
      .setFooter({ text: '🔮 Soul Harbor • The Pagan Shop Online' }).setTimestamp();
    message.author.send({ embeds: [embed] }).catch(() => message.reply(`Your invite link: https://discord.gg/${invite.code}`));
    message.reply('✅ Your personal invite link has been sent to your DMs! 🔗');
  } catch(e) {
    console.error('Invite creation error:', e.message);
    message.reply('❌ Could not create invite link. Make sure I have permission to create invites.');
  }
}

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

async function runWeeklyClass(guild) {
  // Resolve the configured class channel first (CHANNEL_CLASS env var / 'spirit-keeping-classes').
  // Only fall back to fuzzy matching if it doesn't exist — the old fuzzy-only logic matched
  // BOTH #billys-education and #spirit-keeping-classes and posted to whichever came first in cache.
  let channel = getChannel(guild, CONFIG.CHANNELS.CLASS);
  if (!channel) {
    channel = guild.channels.cache.find(c => {
      const n = c.name.toLowerCase();
      return c.type === 0 && (n.includes('class') || n.includes('study') || n.includes('education') || n.includes('learn'));
    });
  }
  if (!channel) {
    console.log(`❌ No class channel found. Looking for: "${CONFIG.CHANNELS.CLASS}"`);
    console.log('Available channels:', guild.channels.cache.filter(c=>c.type===0||c.type===5).map(c=>c.name).join(', '));
    return;
  }
  console.log(`✅ Class posting to #${channel.name}`);
  const topicIdx = Math.floor(Date.now() / (7*24*60*60*1000)) % CLASS_TOPICS.length;
  const topic = CLASS_TOPICS[topicIdx];
  const announceEmbed = new EmbedBuilder().setColor(0x7B2FBE)
    .setTitle(`📚 Soul Harbor Spirit Keeping Classes: ${topic}`)
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
      .setFooter({ text: `Soul Harbor Spirit Keeping Classes • ${attendees.length} students attending` }).setTimestamp();
    const lessonMsg = await channel.send({ embeds: [lessonEmbed] });
    // Pin so the lesson stays visible — Billy wants class content to persist (needs Manage Messages perm)
    await lessonMsg.pin().catch(() => {});
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

async function handleAsk(message, question) {
  if (!question) return message.reply('Usage: `!ask <your question>`');
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

let openai;
function getOpenAI() {
  if (!openai) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not set in environment variables');
    openai = new OpenAI({ apiKey: key });
  }
  return openai;
}

const CONFIG = {
  GUILD_ID: (process.env.GUILD_ID || '').trim(),
  OWNER_ID: (process.env.OWNER_ID || '').trim(),
  TIMEZONE: (process.env.BOT_TIMEZONE || 'America/New_York').trim(),
  CHANNELS: {
    GHOST_STORY:   process.env.CHANNEL_GHOST_STORY   || 'soul-harbor-ghost-stories',
    TAROT:         process.env.CHANNEL_TAROT          || 'tarot-readings',
    TRIVIA:        process.env.CHANNEL_TRIVIA         || 'contests',
    GENERAL:       process.env.CHANNEL_GENERAL        || 'soulharbor-chat',
    WELCOME:       process.env.CHANNEL_WELCOME        || 'introductions',
    ANNOUNCEMENTS: process.env.CHANNEL_ANNOUNCEMENTS  || 'announcements',
    CLASS:         process.env.CHANNEL_CLASS           || 'spirit-keeping-classes',
    SERVER_GUIDE:  process.env.CHANNEL_SERVER_GUIDE    || 'server-guide',
    NEWSLETTERS:   process.env.CHANNEL_NEWSLETTERS     || 'pagan-shop-newsletters',
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

const BAD_WORDS = ['fuck','shit','bitch','cunt','bastard','cock','dick','nigger','nigga'];
function containsBadWord(text) {
  const lower = text.toLowerCase();
  return BAD_WORDS.some(word => {
    const regex = new RegExp('\\b' + word + '\\b', 'i');
    return regex.test(lower);
  });
}

const warnCount = new Map();
const triviaActive = new Map();
let recentTriviaQuestions = [];

async function loadTriviaHistory() {
  if (!db) return;
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS trivia_history (id SERIAL PRIMARY KEY, question TEXT NOT NULL, asked_at TIMESTAMPTZ DEFAULT NOW())`);
    const rows = (await db.query('SELECT question FROM trivia_history ORDER BY asked_at DESC LIMIT 50')).rows;
    recentTriviaQuestions = rows.map(r => r.question).reverse();
    console.log(`✅ Loaded ${recentTriviaQuestions.length} trivia questions from DB`);
  } catch(e) { console.error('Trivia history load error:', e.message); }
}

async function saveTriviaHistory(question) {
  if (!db) return;
  try {
    await db.query('INSERT INTO trivia_history (question) VALUES ($1)', [question]);
    await db.query('DELETE FROM trivia_history WHERE id NOT IN (SELECT id FROM trivia_history ORDER BY asked_at DESC LIMIT 100)');
  } catch(e) { console.error('Trivia history save error:', e.message); }
}

const inviteTracker = new Map();

const SPIRIT_SYSTEM_PROMPT = `You are Soul Harbor, a mystical spirit guide and companion for The Pagan Shop Online's Discord community (thepaganshoponline.com). 

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
      headers: { 'Content-Type': 'application/json', 'X-Coupon-Secret': process.env.BOT_COUPON_SECRET },
      body: JSON.stringify({ code, percent, days })
    });
    const data = await res.json();
    if (data.success) { console.log(`✅ Coupon saved to Zen Cart: ${code}`); return true; }
    else { console.error('❌ Coupon save failed:', data.error); return false; }
  } catch (e) { console.error('❌ Coupon endpoint error:', e.message); return false; }
}

// ── AUTO-CLEANUP: purge expired bot-generated coupons from Zen Cart ──
async function cleanupExpiredCoupons() {
  try {
    const res = await fetch(`${process.env.SHOP_URL}/cleanup_coupons.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Coupon-Secret': process.env.BOT_COUPON_SECRET },
      body: JSON.stringify({ prefix: 'SOUL-', max_age_days: 7 })
    });
    const data = await res.json();
    if (data.success) console.log(`🧹 Coupon cleanup: removed ${data.deleted} expired coupon(s)`);
    else console.error('❌ Coupon cleanup failed:', data.error);
  } catch (e) { console.error('❌ Coupon cleanup endpoint error:', e.message); }
}

function getChannel(guild, name) {
  const cleanName = name.replace(/[^a-z0-9-]/gi, '').toLowerCase();
  // Type 0 = text, Type 5 = announcement — both can receive bot posts
  return guild.channels.cache.find(c => {
    if (c.type !== 0 && c.type !== 5) return false;
    const cn = c.name.toLowerCase();
    const cnClean = cn.replace(/[^a-z0-9-]/gi, '');
    return cn === name || cnClean === cleanName || cn.includes(name.toLowerCase()) || cnClean.includes(cleanName);
  });
}

async function askGPT(messages, max_tokens = 400) {
  try {
    const res = await getOpenAI().chat.completions.create({ model: 'gpt-3.5-turbo', messages, max_tokens, temperature: 0.85 });
    return res.choices[0].message.content.trim();
  } catch (e) { console.error('OpenAI error:', e.message); return null; }
}

function makeEmbed(title, description, color = 0x6B2D8B) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color)
    .setFooter({ text: '🔮 Soul Harbor • The Pagan Shop Online' }).setTimestamp();
}

const requiredEnv = ['DISCORD_TOKEN', 'OPENAI_API_KEY', 'GUILD_ID', 'OWNER_ID'];
const missing = requiredEnv.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('❌ Missing environment variables:', missing.join(', '));
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL not set — XP, profile, keep, leaderboard features will be disabled.');
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
  client.user.setActivity('🔮 Watching over the spirits...', { type: 3 });
  await initDB();
  await loadTriviaHistory();
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (guild) {
    await ensureLevelRoles(guild);
    await ensureAdminChannel(guild);  // ← creates private admin channel
    await ensureServerGuide(guild);   // ← creates public read-only server guide channel
  }
  await scheduleDailyTasks();
});

// ─── NEW: Create private admin-only channel for Billy ────
async function ensureAdminChannel(guild) {
  // Check if it already exists
  const existing = guild.channels.cache.find(c =>
    c.name.toLowerCase().includes('soul-harbor-admin') ||
    c.name.toLowerCase().includes('bot-admin')
  );
  if (existing) return existing;

  try {
    // Fetch owner member so Discord.js recognizes them for permission overwrites
    const ownerMember = await guild.members.fetch(CONFIG.OWNER_ID).catch(() => null);
    if (!ownerMember) { console.log('Could not fetch owner for admin channel'); return null; }

    const adminChannel = await guild.channels.create({
      name: '🤖・soul-harbor-admin',
      type: 0,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        { id: ownerMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ],
      reason: 'Soul Harbor private admin reference channel',
    });

    const embed = new EmbedBuilder()
      .setColor(0x4A0E8F)
      .setTitle('🤖 Soul Harbor — Admin Command Reference')
      .setDescription(
        '**This channel is only visible to you, Billy.**\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**🎖️ Award Badges (type the command OR just say it naturally)**\n\n' +
        '`!award verified_patron @user` — Verified buyer/reviewer (also auto-assigns VIP Keeper role)\n' +
        '`!award trivia_master @user` — Won 25+ trivia contests\n' +
        '`!award the_seer @user` — 25+ tarot readings\n' +
        '`!award greeter @user` — Referred 3 friends\n' +
        '`!award coven_builder @user` — Referred 10 friends\n' +
        '`!award high_priest @user` — Referred 25+ friends\n' +
        '`!award paranormal_witness @user` — Shared 5+ paranormal stories\n' +
        '`!award altar_keeper @user` — Posted 10+ altar pics\n' +
        '`!award spell_weaver @user` — Posted 10+ spells/rituals\n' +
        '`!award manifestor @user` — Posted 10+ manifestation pics\n' +
        '`!award spirit_conversant @user` — 50+ Soul Harbor interactions\n' +
        '`!award class_scholar @user` — Attended 5+ classes\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**🗣️ Natural Language (just say these in any channel)**\n\n' +
        '"give verified patron to @user"\n' +
        '"award trivia master to @user"\n' +
        '"give coven builder badge to @user"\n' +
        '"sync all roles" or "sync roles"\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**🔄 Role Sync**\n\n' +
        '`!syncrolesall` — Assign Seeker to all members without a level role + remove Member role from everyone\n' +
        '`!cleanmemberrole` — One-shot: remove the Member role from every member (run once to clean up)\n' +
        '*(New members now start as Seeker only — Member role is no longer auto-assigned)*\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**🗑️ Message Moderation (Owner & Mods)**\n\n' +
        '`!purge 5` — Delete the last 5 messages in this channel (1–100)\n' +
        '`!deletemsg [messageID]` — Delete one specific message by its ID\n' +
        '*(To get a message ID: right-click message → Copy Message ID. Requires Developer Mode in Discord settings)*\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**📊 View Stats**\n\n' +
        '`!leaderboard` — Top 10 members by XP\n' +
        '`!profile @user` — View any member\'s full profile\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**⚙️ Server Setup**\n\n' +
        '`!setup` — Re-run channel emoji organization\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**📬 Newsletters**\n\n' +
        '`!newsletter Your promo text here` — Post a formatted announcement to #pagan-shop-newsletters\n' +
        '*(Use **bold** and \\\\n for line breaks. Great for sharing email promos with the Discord community.)*\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**⚠️ IMPORTANT: If `!syncrolesall` says "only server owner can do this"**\n' +
        'Go to **Server Settings → Roles** and drag the **Soul Harbor** bot role to the very top of the list (above all other roles). The bot can only assign roles that are below its own role in the hierarchy.'
      )
      .setFooter({ text: '🔒 Only you can see this channel • Soul Harbor Admin' })
      .setTimestamp();

    await adminChannel.send({ embeds: [embed] });
    console.log('✅ Admin channel created');
    return adminChannel;
  } catch(e) {
    console.error('Could not create admin channel:', e.message);
    return null;
  }
}

// ─── PUBLIC READ-ONLY SERVER GUIDE CHANNEL ───────────────
async function ensureServerGuide(guild) {
  // Check if it already exists (by name, ignoring emoji prefix)
  const existing = guild.channels.cache.find(c =>
    c.name.toLowerCase().replace(/[^a-z0-9-]/g, '').includes('serverguide') ||
    c.name.toLowerCase().replace(/[^a-z0-9-]/g, '').includes('server-guide') ||
    c.name.toLowerCase().includes('server-guide')
  );
  if (existing) return existing;

  try {
    const guideChannel = await guild.channels.create({
      name: '📖・server-guide',
      type: 0,
      permissionOverwrites: [
        // Everyone can READ but NOT write — read-only pinboard
        { id: guild.roles.everyone, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        // Bot can write (to post the guide)
        { id: guild.client.user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] },
      ],
      reason: 'Soul Harbor public read-only server guide',
    });

    const embed = new EmbedBuilder()
      .setColor(0x7B2FBE)
      .setTitle('🔮 Soul Harbor — Commands & Guide')
      .setDescription(
        'Welcome to **Soul Harbor**, the spirit of The Pagan Shop Online! 👋\n\n' +
        '*This channel is read-only. Use the commands below anywhere Soul Harbor can hear you!*\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**🎮 Core Commands**\n\n' +
        '`!tarot` — Get a personal tarot reading (+15 XP)\n' +
        '`!ghost` — Hear a haunting ghost story (+8 XP)\n' +
        '`!trivia` — Start a trivia contest, win discount codes! (+75 XP)\n' +
        '`!horoscope [sign]` — Get your daily horoscope (+8 XP)\n' +
        '`!spirit [name]` — Learn about any spirit or entity\n' +
        '`!ask [question]` — Ask Soul Harbor anything (+10 XP)\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**⭐ XP, Levels & Badges**\n\n' +
        '`!xp` — Check your XP and current level\n' +
        '`!profile` — View your full profile card\n' +
        '`!badges` — See your roles and achievement badges\n' +
        '`!allbadges` — Browse all available badges\n' +
        '`!leaderboard` — Top 10 members by XP\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**🏆 XP Level Ranks**\n\n' +
        '🔮 Seeker → 🌿 Initiate (800 XP) → 🌑 Neophyte (2,500 XP)\n' +
        '🌙 Practitioner (5,000 XP) → ✨ Mystic (9,000 XP)\n' +
        '🔥 Magus (18,000 XP) → 🌟 Elder (32,000 XP) → 👑 Grandmaster (50,000 XP)\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**🎖️ Earnable Badges**\n\n' +
        '⚡ Lightning Reflexes — Answer trivia in under 60 seconds\n' +
        '🏆 Trivia Master — Win 25 trivia contests\n' +
        '🔮 The Seer — Complete 25 tarot readings\n' +
        '👋 Greeter — Refer 3 friends\n' +
        '🌙 Coven Builder — Refer 10 friends\n' +
        '👑 High Priest/ess — Refer 25+ friends\n' +
        '🕯️ Altar Keeper — Post 10 altar pictures\n' +
        '✨ Spell Weaver — Post 10 spells or rituals\n' +
        '🌟 The Manifestor — Post 10 manifestation pics\n' +
        '👁️ Paranormal Witness — Share 5 paranormal stories\n' +
        '📚 Scholar of the Veil — Attend 5 spirit keeping classes\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**💬 Natural Language**\n\n' +
        'You can also talk to Soul Harbor naturally!\n' +
        '*"Soul Harbor, what are my badges?"*\n' +
        '*"Hey Soul Harbor, check my level"*\n' +
        '*"Soul Harbor, tell me about my XP"*\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**📖 Soul Harbor Spirit Keeping Classes**\n\n' +
        '`!class` — See the next scheduled class topic\n' +
        '`!lastclass` — View the most recent class recap\n' +
        'Every Wednesday at 6 PM EST 🕯️\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '**🛍️ Shop & Referrals**\n\n' +
        '`!invite` — Get your personal referral link\n' +
        'Refer friends → earn XP → unlock badges!\n' +
        'Visit us at **thepaganshoponline.com** 🔮'
      )
      .setFooter({ text: '🔮 Soul Harbor • The Pagan Shop Online • Read-only channel' })
      .setTimestamp();

    const guideMsg = await guideChannel.send({ embeds: [embed] });
    await guideMsg.pin().catch(() => {});
    console.log('✅ Server guide channel created and pinned');
    return guideChannel;
  } catch(e) {
    console.error('Could not create server guide channel:', e.message);
    return null;
  }
}


// ─── WELCOME NEW MEMBERS ─────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  const guild = member.guild;

  // Member role auto-assign removed — Seeker is the base role for all new members

  // Auto-assign Seeker role (Level 1) — NEW MEMBERS ARE HANDLED AUTOMATICALLY
  let seekerRole = guild.roles.cache.find(r => r.name === 'Seeker');
  if (!seekerRole) {
    seekerRole = await guild.roles.create({
      name: 'Seeker',
      color: LEVEL_ROLE_COLORS['Seeker'] || 0x888888,
      reason: 'Soul Harbor default level role',
      hoist: true,
      permissions: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions', 'AttachFiles', 'UseExternalEmojis', 'EmbedLinks'],
    }).catch(() => null);
  }
  if (seekerRole) member.roles.add(seekerRole).catch(() => {});

  if (db) await dbEnsure(member.id, member.user.username);

  // Find welcome channel — handles emoji-prefixed names like 👋・introductions
  const welcomeChannel = (process.env.CHANNEL_WELCOME ? getChannel(guild, process.env.CHANNEL_WELCOME) : null) ||
                         getChannel(guild, 'introductions') ||
                         getChannel(guild, 'welcome') ||
                         getChannel(guild, 'general') ||
                         guild.channels.cache.find(c => c.type === 0 && (
                           c.name.toLowerCase().includes('intro') ||
                           c.name.toLowerCase().includes('welcome')
                         ));
  if (!welcomeChannel) { console.log('Welcome channel not found — tried introductions, welcome, general'); return; }
  console.log(`✅ Sending welcome to ${member.user.username} in #${welcomeChannel.name}`);

  const embed = makeEmbed(
    `🔮 Welcome, ${member.displayName}!`,
    `The spirits have been expecting you... Welcome to **The Pagan Shop Online** Discord. \n\n` +
    `This is the gathering place for spirit keepers, practitioners, and seekers of the mystical arts.\n\n` +
    `**I am Soul Harbor, your mystical spirit guide for this community.** Here is how to work with me:\n\n` +
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

  // ── WELCOME COUPON: DM new member a unique 10% off coupon ──
  if (db && process.env.SHOP_URL && process.env.BOT_COUPON_SECRET) {
    try {
      const existingMember = await dbGet(member.id);
      // Only send if they haven't received a welcome coupon before (one per customer)
      if (!existingMember || !existingMember.welcome_coupon) {
        const couponCode = generateCouponCode();
        const saved = await saveCouponToShop(couponCode, 10, 7); // 10% off, 7 days
        if (saved) {
          // Save to DB so they can't get another one if they rejoin
          await db.query('UPDATE members SET welcome_coupon=$1 WHERE user_id=$2', [couponCode, member.id]);
          
          const couponEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🎁 Welcome Gift — 10% Off Coupon!')
            .setDescription(
              `Thank you for joining **The Pagan Shop Online** Discord!\n\n` +
              `Here's your exclusive **10% off** coupon as a welcome gift:\n\n` +
              `### 🏷️ \`${couponCode}\`\n\n` +
              `Use it at **thepaganshoponline.com** at checkout.\n\n` +
              `⏰ This coupon is valid for **7 days** and is for one-time use only.\n\n` +
              `Welcome to the community! 🔮`
            )
            .setFooter({ text: 'The Pagan Shop Online • Soul Harbor' })
            .setTimestamp();
          
          await member.send({ embeds: [couponEmbed] }).catch(() => {
            console.log(`⚠️ Could not DM welcome coupon to ${member.user.username} (DMs may be closed)`);
          });
          console.log(`🎁 Welcome coupon ${couponCode} sent to ${member.user.username}`);
        }
      } else {
        console.log(`ℹ️ ${member.user.username} already received welcome coupon: ${existingMember.welcome_coupon}`);
      }
    } catch (e) {
      console.error('Welcome coupon error:', e.message);
    }
  }

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

  try {
    const newInvites = await guild.invites.fetch();
    const oldSnapshot = inviteTracker.get('snapshot');
    if (oldSnapshot) {
      for (const [code, invite] of newInvites) {
        const oldInvite = oldSnapshot.get(code);
        const oldUses = oldInvite ? oldInvite.uses : 0;
        if (invite.uses > oldUses) {
          if (db) {
            try {
              const res = await db.query('SELECT inviter_id FROM invite_links WHERE code=$1', [code]);
              if (res.rows.length > 0) {
                const inviterId = res.rows[0].inviter_id;
                // Check not already tracked to avoid silent duplicates
                const existing = await db.query('SELECT id FROM referrals WHERE invitee_id=$1', [member.id]);
                if (existing.rows.length === 0) {
                  await db.query('INSERT INTO referrals (inviter_id, invitee_id) VALUES ($1,$2)', [inviterId, member.id]);
                  console.log(`✅ Referral tracked: ${inviterId} invited ${member.id}`);
                } else {
                  console.log(`⚠️ Referral already exists for invitee ${member.id}, skipping`);
                }
              }
            } catch(dbErr) {
              console.error('Referral DB error:', dbErr.message);
            }
          }
        }
      }
    }
    // Store just uses count — not full object reference — so comparisons stay correct across awaits
    inviteTracker.set('snapshot', new Map([...newInvites.values()].map(inv => [inv.code, { uses: inv.uses }])));
  } catch(e) { console.log('Invite tracking error:', e.message); }
});

// ─── MESSAGE HANDLER ─────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ── DM attachments ──
  if (!message.guild && message.attachments.size > 0) {
    const attachment = message.attachments.first();
    const isAudio = attachment.contentType?.startsWith('audio/') || attachment.name?.match(/\.(mp3|ogg|wav|m4a|webm)$/i);
    const isText  = attachment.contentType?.startsWith('text/') || attachment.name?.match(/\.(txt|md|doc)$/i);
    if (isAudio) { await handleVoiceMemo(message); return; }
    if (isText) { await message.reply('📄 I can save this to your Spirit Keep! Reply with:\n`!keep upload <spirit name>` and attach the file again.'); return; }
  }

  if (!message.guild) {
    const content = message.content.trim();
    const lower = content.toLowerCase();
    if (lower.startsWith('!keep upload') && message.attachments.size > 0) {
      const args = content.slice(5).trim().split(/\s+/);
      await handleKeep(message, args);
      return;
    }
  }

  if (!message.guild) return;

  const content = message.content.trim();
  const lower = content.toLowerCase();
  const userId = message.author.id;
  const username = message.author.username;

  // ── XP earning ──
  if (db) {
    await dbEnsure(userId, username);
    const now = Date.now();
    const mData = await dbGet(userId);
    const cn = message.channel.name.toLowerCase();

    if (mData && now - Number(mData.last_chat_xp) > 60_000) {
      await addXP(userId, username, XP_VALUES.chat, message.guild);
      await db.query('UPDATE members SET last_chat_xp=$1 WHERE user_id=$2', [now, userId]);
    }

    if (message.attachments.size > 0 && (cn.includes('altar') || cn.includes('spirit-altar'))) {
      await addXP(userId, username, XP_VALUES.altar_pic, message.guild);
      await db.query('UPDATE members SET altar_posts = altar_posts + 1 WHERE user_id=$1', [userId]);
      const m2 = await dbGet(userId);
      if (m2 && m2.altar_posts >= 10) await awardBadge(userId, username, 'altar_keeper', message.guild);
      await message.react('🕯️').catch(() => {});
    } else if (message.attachments.size > 0 && cn.includes('manifest')) {
      await addXP(userId, username, XP_VALUES.manifestation_pic, message.guild);
      await db.query('UPDATE members SET manifestation_posts = manifestation_posts + 1 WHERE user_id=$1', [userId]);
      const m2 = await dbGet(userId);
      if (m2 && m2.manifestation_posts >= 10) await awardBadge(userId, username, 'manifestor', message.guild);
      await message.react('✨').catch(() => {});
    } else if ((cn.includes('spell') || cn.includes('magical') || cn.includes('concoction') || cn.includes('ritual')) &&
               (message.attachments.size > 0 || content.length > 80)) {
      await addXP(userId, username, XP_VALUES.spell_post, message.guild);
      await db.query('UPDATE members SET spell_posts = spell_posts + 1 WHERE user_id=$1', [userId]);
      const m2 = await dbGet(userId);
      if (m2 && m2.spell_posts >= 10) await awardBadge(userId, username, 'spell_weaver', message.guild);
      await message.react('🌙').catch(() => {});
    } else if ((cn.includes('paranormal') || cn.includes('experience') || cn.includes('spirit-experience')) &&
               content.length > 100 && !content.startsWith('!')) {
      await addXP(userId, username, XP_VALUES.paranormal_story, message.guild);
      await db.query('UPDATE members SET paranormal_posts = paranormal_posts + 1 WHERE user_id=$1', [userId]);
      const m2 = await dbGet(userId);
      if (m2 && m2.paranormal_posts >= 5) await awardBadge(userId, username, 'paranormal_witness', message.guild);
      await message.react('👁️').catch(() => {});
    }
  }

  // ── TRIVIA ANSWER CHECK ──
  if (triviaActive.has(message.channel.id)) {
    const trivia = triviaActive.get(message.channel.id);
    const answerLower = trivia.answer.toLowerCase().trim();
    // Strip common filler so "the answer is amethyst" → "amethyst"
    const cleanedMsg = lower
      .replace(/^(the answer is|i think|i believe|is it|my answer is|answer:|it's|its|i say|i guess)\s*/i, '')
      .replace(/[^a-z0-9\s]/g, '') // strip punctuation
      .trim();
    const answerClean = answerLower.replace(/[^a-z0-9\s]/g, '').trim();
    // Match: exact, starts with, ends with, or answer words all appear in message
    const answerWords = answerClean.split(/\s+/);
    const cleanedWords = cleanedMsg.split(/\s+/);
    const allWordsPresent = answerWords.every(w => cleanedMsg.includes(w));
    // Prevent false positives: if the user's message is much longer than the answer,
    // don't count allWordsPresent alone (avoids matching casual chat that happens to contain the answer word)
    const tightAllWords = allWordsPresent && cleanedWords.length <= answerWords.length * 3;
    const isCorrect = cleanedMsg === answerClean ||
                      cleanedMsg.startsWith(answerClean) ||
                      lower === answerLower ||
                      lower.endsWith(' ' + answerLower) ||
                      lower.startsWith(answerLower) ||
                      tightAllWords;
    console.log(`[TRIVIA] Expected: "${answerClean}" | Got: "${cleanedMsg}" (${cleanedWords.length} words) | AllWords: ${allWordsPresent} | TightMatch: ${tightAllWords} | Correct: ${isCorrect}`);

    // ── WRONG ANSWER FEEDBACK ──
    // Only respond if: trivia is still open, no winner yet, message isn't a command,
    // and it's short enough to be an actual answer attempt (not casual chat)
    if (!trivia.winnerId && !isCorrect && !content.startsWith('!') && content.length <= 80 && cleanedMsg.length > 0) {
      await message.reply('❌ Sorry, that\'s not quite right! Give it another try 🔮').catch(() => {});
      return;
    }

    if (!trivia.winnerId && isCorrect) {
      trivia.winnerId = userId;
      console.log(`[TRIVIA] ✅ Winner: ${message.author.username} (${userId}) — answer: "${trivia.answer}"`);
      const code = generateCouponCode();
      const couponSaved = await saveCouponToShop(code);
      console.log(`[TRIVIA] Coupon ${code} saved to shop: ${couponSaved}`);
      if (db) {
        try {
          const tStart = triviaActive.get(message.channel.id)?.startTime || Date.now();
          const elapsed = (Date.now() - tStart) / 1000;
          await addXP(userId, message.author.username, XP_VALUES.trivia_win, message.guild);
          await db.query('UPDATE members SET trivia_wins = trivia_wins + 1 WHERE user_id=$1', [userId]);
          const mTrivia = await dbGet(userId);
          console.log(`[TRIVIA] ${message.author.username} now has ${mTrivia?.trivia_wins || 0} trivia wins, answered in ${elapsed.toFixed(1)}s`);
          if (mTrivia && mTrivia.trivia_wins >= 25) await awardBadge(userId, message.author.username, 'trivia_master', message.guild);
          if (elapsed <= 60) await awardBadge(userId, message.author.username, 'lightning_reflexes', message.guild);
        } catch (dbErr) {
          console.error(`[TRIVIA] DB error during win processing:`, dbErr.message);
        }
      }
      // ── DELIVER COUPON — DM first, fall back to channel if DMs are off ──
      let dmSuccess = false;
      try {
        await message.author.send(
          `🏆 **Congratulations! You won the Soul Harbor Trivia Contest!**\n\nYour exclusive **${CONFIG.COUPONS.DISCOUNT_PERCENT}% discount code** is:\n# \`${code}\`\n\nUse it at **thepaganshoponline.com** at checkout.\nValid for 7 days. Keep this code private! 🛍️🔮`
        );
        dmSuccess = true;
        console.log(`[TRIVIA] ✅ Coupon DM sent successfully to ${message.author.username}: ${code}`);
      } catch(e) {
        console.log(`[TRIVIA] ⚠️ DM FAILED for ${message.author.username} (${e.code || e.message}) — falling back to channel post`);
      }

      if (dmSuccess) {
        // Normal winner announcement — code was sent privately
        const embed = makeEmbed('🏆 We Have a Winner!',
          `🎉 Congratulations ${message.author}! You answered correctly!\n\nYour discount code has been sent to your **DMs** — check your private messages! 🔮\n\nThanks everyone for playing! Next contest coming soon. 🏆`, 0xFFD700);
        message.channel.send({ embeds: [embed] });
      } else {
        // DM failed — post code in channel as a reply, auto-delete after 90s
        const embed = makeEmbed('🏆 We Have a Winner!',
          `🎉 Congratulations ${message.author}! You answered correctly!\n\n📬 *I couldn\'t send you a DM (your DMs may be off).* Your code is below — **screenshot it quickly**, this message deletes in 90 seconds! 🔮\n\nThanks everyone for playing! Next contest coming soon. 🏆`, 0xFFD700);
        const winMsg = await message.channel.send({ embeds: [embed] });

        // Send code as a separate message so it's easy to screenshot
        const codeMsg = await message.channel.send(
          `${message.author} 🎁 Your **${CONFIG.COUPONS.DISCOUNT_PERCENT}% discount code**: \`${code}\`\n*(Valid 7 days at thepaganshoponline.com — this message will disappear soon!)*`
        );
        console.log(`[TRIVIA] 📬 Coupon posted in channel for ${message.author.username} (DM fallback): ${code}`);

        // Alert Billy that DM failed so he can follow up manually if needed
        try {
          const billy = await message.client.users.fetch(CONFIG.OWNER_ID);
          if (billy) billy.send(`⚠️ **Trivia Winner DM Failed**\n**Winner:** ${message.author.tag}\n**Code:** \`${code}\`\n\nTheir DMs are off — the code was posted in the channel and will auto-delete. You may want to follow up with them directly.`).catch(() => {});
        } catch(_) {}

        // Auto-delete code message after 90 seconds
        setTimeout(() => {
          codeMsg.delete().catch(() => {});
          winMsg.delete().catch(() => {});
          console.log(`[TRIVIA] 🗑️ Auto-deleted fallback coupon message for ${message.author.username}`);
        }, 90_000);
      }
      triviaActive.delete(message.channel.id);
      // Auto-create Contest Champion role if it does not exist yet, then assign
      let champRole = message.guild.roles.cache.find(r => r.name === CONFIG.ROLES.CONTEST_CHAMPION);
      if (!champRole) {
        try {
          champRole = await message.guild.roles.create({
            name: CONFIG.ROLES.CONTEST_CHAMPION,
            color: 0xFFD700,
            reason: 'Soul Harbor: first trivia winner — auto-created Contest Champion role',
            hoist: false,
          });
          console.log(`[TRIVIA] ✅ Created "${CONFIG.ROLES.CONTEST_CHAMPION}" role automatically`);
        } catch(e) { console.error(`[TRIVIA] ❌ Could not create Contest Champion role:`, e.message); }
      }
      if (champRole) {
        try {
          await message.member.roles.add(champRole);
          console.log(`[TRIVIA] ✅ Contest Champion role assigned to ${message.author.username}`);
        } catch(e) {
          console.error(`[TRIVIA] ❌ Could not assign Contest Champion role to ${message.author.username}: ${e.message}`);
          console.error(`[TRIVIA] 💡 Tip: Make sure the Soul Harbor bot role is ABOVE "Contest Champion" in Server Settings → Roles`);
        }
      }
      return;
    }
  }

  // ── MODERATION ──
  // Owner, admins, and mods are exempt — the bot must never warn/delete Billy or staff
  if (containsBadWord(content) && !isStaffMember(message)) {
    const count = (warnCount.get(userId) || 0) + 1;
    warnCount.set(userId, count);
    await message.delete().catch(() => {});
    if (count === 1) {
      message.channel.send(`⚠️ ${message.author}, please keep our community respectful. **Warning 1/3**`);
    } else if (count === 2) {
      message.channel.send(`⚠️ ${message.author}, this is your **final warning (2/3)**. Next violation will be reported.`);
    } else if (count >= 3) {
      message.channel.send(`🚫 ${message.author} has received 3 warnings for inappropriate language.`);
      const alertMsg = `🚨 **Moderation Alert** — **${message.guild.name}**\nUser **${message.author.tag}** has received 3 warnings for inappropriate language.\nLast message: "${message.content}"\n\nDo you want to kick or ban this user?`;
      try {
        const guild = message.guild;
        await guild.members.fetch();
        const ownerMember = guild.members.cache.get(CONFIG.OWNER_ID);
        if (ownerMember) {
          await ownerMember.send(alertMsg);
        } else {
          const ownerUser = await client.users.fetch(CONFIG.OWNER_ID);
          await ownerUser.send(alertMsg);
        }
      } catch(e) {
        const adminChannel = message.guild.channels.cache.find(c => c.name.includes('admin') && c.type === 0);
        if (adminChannel) adminChannel.send(`🚨 <@${CONFIG.OWNER_ID}> **Moderation Alert:** ${message.author.tag} received 3 warnings. Last message: "${message.content}"`);
      }
      const modRole = message.guild.roles.cache.find(r => ['mod', 'moderator'].includes(r.name.toLowerCase()));
      if (modRole) {
        modRole.members.forEach(async (member) => {
          if (member.id !== CONFIG.OWNER_ID) member.send(alertMsg).catch(() => {});
        });
      }
      warnCount.set(userId, 0);
    }
    return;
  }

  // ── ! COMMANDS ──
  if (content.startsWith('!')) {
    if (lower === '!setup') { await handleSetup(message); return; }
    if (lower === '!help' || lower === '!commands') { await handleHelp(message); return; }
    if (lower.startsWith('!tarot') || lower.startsWith('!reading')) { await handleTarot(message); return; }
    if (lower.startsWith('!ghost') || lower.startsWith('!story')) { await handleGhostStory(message); return; }
    if (lower.startsWith('!trivia') || lower.startsWith('!contest')) { await handleTrivia(message); return; }
    if (lower.startsWith('!horoscope')) { await handleHoroscope(message); return; }
    if (lower.startsWith('!spirit ')) { await handleSpiritInfo(message, content.slice(8)); return; }
    if (lower.startsWith('!badge')) { await handleBadges(message); return; }
    if (lower === '!xp' || lower === '!level') { await handleXP(message); return; }
    if (lower.startsWith('!profile')) { await handleProfile(message); return; }
    if (lower === '!leaderboard' || lower === '!lb') { await handleLeaderboard(message); return; }
    if (lower.startsWith('!keep')) { const args = content.slice(5).trim().split(/\s+/); await handleKeep(message, args); return; }
    if (lower.startsWith('!ask ')) { await handleAsk(message, content.slice(5).trim()); return; }
    if (lower === '!invite' || lower === '!referral') { await handleInvite(message); return; }
    if (lower.startsWith('!award')) { await handleAward(message, content.slice(6).trim()); return; }
    // ── FIX: accept all variations of sync command ──
    if (lower === '!syncrolesall' || lower === '!sync roles all' || lower === '!syncroles' || lower === '!sync') {
      await handleSyncRoles(message); return;
    }
    if (lower === '!cleanmemberrole' || lower === '!clearmemberrole' || lower === '!removemember') {
      await handleCleanMemberRole(message); return;
    }
    if (lower === '!lastclass') {
      if (!db) { message.reply('🔮 The class archive requires a database.'); return; }
      const r = await db.query(`SELECT topic, transcript, scheduled_at, attendees FROM classes WHERE transcript IS NOT NULL AND transcript != '' ORDER BY scheduled_at DESC LIMIT 1`);
      if (!r.rows.length) { message.reply('📚 No archived classes yet — the first one will be saved automatically.'); return; }
      const cls = r.rows[0];
      const when = new Date(cls.scheduled_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const embed = new EmbedBuilder().setColor(0x7B2FBE)
        .setTitle(`📚 ${cls.topic}`)
        .setDescription(cls.transcript.substring(0, 4000))
        .setFooter({ text: `Soul Harbor Spirit Keeping Classes • Class of ${when} • ${(cls.attendees || []).length} students attended` })
        .setTimestamp();
      message.channel.send({ embeds: [embed] });
      return;
    }
    if (lower === '!class' || lower === '!classes') {
      const topicIdx = Math.floor(Date.now() / (7*24*60*60*1000)) % CLASS_TOPICS.length;
      const embed = makeEmbed('📚 Soul Harbor Spirit Keeping Classes',
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
    if (lower === '!adminhelp' && isOwner(message)) {
      await ensureAdminChannel(message.guild);
      message.reply('✅ Check your private 🤖・soul-harbor-admin channel for the full command reference!');
      return;
    }

    // ── !purge [1-100] — delete last N messages (owner + mods only) ──
    if (lower.startsWith('!purge') && (isOwner(message) || isStaff(message))) {
      const args = content.slice(6).trim();
      const count = parseInt(args) || 1;
      if (count < 1 || count > 100) {
        message.reply('❌ Please specify a number between 1 and 100. Example: `!purge 5`');
        return;
      }
      try {
        // Delete the command message itself first
        await message.delete().catch(() => {});
        const fetched = await message.channel.messages.fetch({ limit: count });
        await message.channel.bulkDelete(fetched, true); // true = skip messages older than 14 days
        const confirm = await message.channel.send(`🗑️ Deleted ${fetched.size} message(s).`);
        setTimeout(() => confirm.delete().catch(() => {}), 4000); // auto-delete confirmation after 4s
      } catch (err) {
        console.error('Purge error:', err);
        message.channel.send('❌ Could not delete some messages (they may be older than 14 days — delete those manually).').then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
      }
      return;
    }

    // ── !deletemsg [messageID] — delete a specific message by ID (owner + mods only) ──
    if (lower.startsWith('!deletemsg') && (isOwner(message) || isStaff(message))) {
      const msgId = content.slice(10).trim();
      if (!msgId) {
        message.reply('❌ Please provide a message ID. Example: `!deletemsg 1234567890123456789`\n💡 To get a message ID: right-click the message → Copy Message ID (Developer Mode must be on).');
        return;
      }
      try {
        const targetMsg = await message.channel.messages.fetch(msgId);
        await targetMsg.delete();
        await message.delete().catch(() => {});
        const confirm = await message.channel.send('🗑️ Message deleted.');
        setTimeout(() => confirm.delete().catch(() => {}), 4000);
      } catch (err) {
        console.error('Delete msg error:', err);
        message.reply('❌ Could not find or delete that message. Make sure the ID is correct and the message is in this channel.');
      }
      return;
    }

    // ── !newsletter <message> — post a formatted newsletter/promo to the newsletters channel (owner only) ──
    if (lower.startsWith('!newsletter') && isOwner(message)) {
      const body = content.slice(11).trim();
      if (!body) {
        message.reply('❌ Usage: `!newsletter Your newsletter text here`\n💡 Tip: Use `**bold**` and `\\n` for formatting. Include coupon codes, promo links, etc.');
        return;
      }
      const nlChannel = getChannel(message.guild, CONFIG.CHANNELS.NEWSLETTERS);
      if (!nlChannel) {
        message.reply(`❌ Newsletter channel not found. Looking for: **${CONFIG.CHANNELS.NEWSLETTERS}**\nCreate a channel with that name, or set \`CHANNEL_NEWSLETTERS\` on Railway.`);
        return;
      }
      const embed = makeEmbed('📬 The Pagan Shop Online — Newsletter', body.replace(/\\n/g, '\n'), 0x7B2FBE);
      await nlChannel.send({ embeds: [embed] });
      message.reply(`✅ Newsletter posted to ${nlChannel}!`);
      return;
    }

    return;
  }

  // ── OWNER COMMANDS — run in ANY channel (except announcements), no @mention needed ──
  // Check this BEFORE shouldRespond so Billy doesn't need to @mention the bot
  const inAnnouncements = message.channel.type === 5 || (message.channel.name || '').toLowerCase().includes('announc');
  if (isOwner(message) && !content.startsWith('!') && !inAnnouncements) {
    const origLower = content.toLowerCase();
    const targetMember = message.mentions.members?.find(m => m.id !== client.user.id) || null;

    if (targetMember) {
      const badgeMatch = origLower.match(/(?:give|award|grant|add)\s+([a-z][a-z\s_]+?)\s*(?:badge\s+)?(?:to\s+)?<@/);
      const badgeMatchAlt = origLower.match(/(?:give|award|grant|add)\s+<@[^>]+>\s+(?:the\s+)?([a-z][a-z\s_]+?)\s*(?:badge)?$/);
      const badgeInputRaw = badgeMatch ? badgeMatch[1] : (badgeMatchAlt ? badgeMatchAlt[1] : null);

      if (badgeInputRaw) {
        const badgeKey = badgeInputRaw.trim().replace(/\s+/g, '_');
        if (BADGES_DEF[badgeKey]) {
          await awardBadge(targetMember.id, targetMember.user.username, badgeKey, message.guild);
          const b = BADGES_DEF[badgeKey];
          message.reply(`✅ Awarded **${b.emoji} ${b.name}** to ${targetMember}!`);
          return;
        }
        const partialKey = Object.keys(BADGES_DEF).find(k =>
          k === badgeKey || k.includes(badgeKey) || badgeKey.includes(k) ||
          k.replace(/_/g, ' ') === badgeInputRaw.trim()
        );
        if (partialKey) {
          await awardBadge(targetMember.id, targetMember.user.username, partialKey, message.guild);
          const b = BADGES_DEF[partialKey];
          message.reply(`✅ Awarded **${b.emoji} ${b.name}** to ${targetMember}!`);
          return;
        }
      }

      // Shorthand — just badge name + @user, no verb needed
      const shorthandKey = Object.keys(BADGES_DEF).find(k => origLower.includes(k.replace(/_/g, ' ')));
      if (shorthandKey) {
        await awardBadge(targetMember.id, targetMember.user.username, shorthandKey, message.guild);
        const b = BADGES_DEF[shorthandKey];
        message.reply(`✅ Awarded **${b.emoji} ${b.name}** to ${targetMember}!`);
        return;
      }
    }

    // Sync command natural language
    if (origLower.match(/\bsync\b.*(all|roles|everyone|members)/)) {
      await handleSyncRoles(message);
      return;
    }
  }

  // ── NATURAL LANGUAGE INTENT DETECTION ──
  // ignoreEveryone: an @everyone announcement must NOT count as mentioning the bot
  // (this was why Soul Harbor replied to Billy's announcements and started trivia on them)
  const isMentioned = message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true });
  const isDM = !message.guild;
  const isAnnouncementChannel = message.channel.type === 5 ||
    (message.channel.name || '').toLowerCase().includes('announc');
  const rawChannelName = message.channel.name ? message.channel.name.replace(/[^a-z0-9-]/gi, '').toLowerCase() : '';
  const isGeneralChat = rawChannelName === 'soulharborchat' || rawChannelName.includes('soulharborchat') || rawChannelName === 'paganshopchat' || rawChannelName.includes('paganshopchat');
  const isCommand = content.startsWith('!');
  // Never react conversationally inside announcement channels
  const shouldRespond = !isAnnouncementChannel && (isDM || isMentioned || (isGeneralChat && isCommand));

  if (!isDM && !isMentioned && content.length < 3) return;
  if (!shouldRespond) return;
  if (!isMentioned && !isDM && !isCommand) return;

  if (shouldRespond) {
    const cleanContent = content.replace(/<@!?\d+>/g, '').trim();
    const cleanLower = cleanContent.toLowerCase();

    // ── OWNER NATURAL LANGUAGE ADMIN COMMANDS ────────────────
    // Use ORIGINAL content — we need @mentions intact for matching
    if (isOwner(message)) {
      const origLower = content.toLowerCase();
      // Target = any mentioned member who is NOT the bot
      const targetMember = message.mentions.members?.find(m => m.id !== client.user.id) || null;

      if (targetMember) {
        // Match badge name: "@Soul Harbor give verified patron badge to @Nate44"
        const badgeMatch = origLower.match(/(?:give|award|grant|add)\s+([a-z][a-z\s_]+?)\s*(?:badge\s+)?(?:to\s+)?<@/);
        const badgeMatchAlt = origLower.match(/(?:give|award|grant|add)\s+<@[^>]+>\s+(?:the\s+)?([a-z][a-z\s_]+?)\s*(?:badge)?$/);
        const badgeInputRaw = badgeMatch ? badgeMatch[1] : (badgeMatchAlt ? badgeMatchAlt[1] : null);

        if (badgeInputRaw) {
          const badgeKey = badgeInputRaw.trim().replace(/\s+/g, '_');
          if (BADGES_DEF[badgeKey]) {
            await awardBadge(targetMember.id, targetMember.user.username, badgeKey, message.guild);
            const b = BADGES_DEF[badgeKey];
            message.reply(`✅ Awarded **${b.emoji} ${b.name}** to ${targetMember}!`);
            return;
          }
          const partialKey = Object.keys(BADGES_DEF).find(k =>
            k === badgeKey || k.includes(badgeKey) || badgeKey.includes(k) ||
            k.replace(/_/g, ' ') === badgeInputRaw.trim()
          );
          if (partialKey) {
            await awardBadge(targetMember.id, targetMember.user.username, partialKey, message.guild);
            const b = BADGES_DEF[partialKey];
            message.reply(`✅ Awarded **${b.emoji} ${b.name}** to ${targetMember}!`);
            return;
          }
        }

        // Shorthand — just badge name + @user, no verb needed
        const shorthandKey = Object.keys(BADGES_DEF).find(k => origLower.includes(k.replace(/_/g, ' ')));
        if (shorthandKey) {
          await awardBadge(targetMember.id, targetMember.user.username, shorthandKey, message.guild);
          const b = BADGES_DEF[shorthandKey];
          message.reply(`✅ Awarded **${b.emoji} ${b.name}** to ${targetMember}!`);
          return;
        }
      }

      // "sync roles" / "sync all" / "sync everyone"
      if (origLower.match(/\bsync\b.*(all|roles|everyone|members)/)) {
        await handleSyncRoles(message);
        return;
      }
    }
    // ── END OWNER NLP COMMANDS ──

    if (cleanLower.match(/tarot|card reading|card spread|pull.*card|draw.*card|\d+.card|one.card|two.card|three.card|four.card|five.card|six.card|seven.card|eight.card|nine.card|ten.card|reading/)) { await handleTarot(message); return; }
    if (cleanLower.match(/ghost story|ghost stories|paranormal story|horror story|scary story|tell.*story|give.*story/)) { await handleGhostStory(message); return; }
    if (cleanLower.match(/trivia|contest|quiz|question|game|win|discount/)) { await handleTrivia(message); return; }
    if (cleanLower.match(/horoscope|zodiac|astrology|sign|aries|taurus|gemini|cancer|leo|virgo|libra|scorpio|sagittarius|capricorn|aquarius|pisces/)) { await handleHoroscope(message); return; }

    const spiritMatch = cleanLower.match(/tell me about (.+)|who is (.+)|what is (.+)|info on (.+)|information about (.+)/);
    if (spiritMatch) {
      const spiritName = (spiritMatch[1] || spiritMatch[2] || spiritMatch[3] || spiritMatch[4] || spiritMatch[5]).trim();
      await handleSpiritInfo(message, spiritName);
      return;
    }

    // ── USER NATURAL LANGUAGE COMMANDS ──
    // Triggered when Soul Harbor is @mentioned or spoken to naturally
    // XP / level / rank
    if (cleanLower.match(/\bmy (xp|level|rank|points|progress|tier)\b|check my (xp|level|rank|progress)|how much xp|what.?s my (level|rank|xp|tier)|show.*my (level|rank|xp)/)) {
      await handleXP(message); return;
    }
    // Profile
    if (cleanLower.match(/\bmy profile\b|show.*profile|view.*profile|profile card|see my (stats|profile)/)) {
      await handleProfile(message); return;
    }
    // Badges / achievements / roles
    if (cleanLower.match(/\b(my )?(badges|achievements|roles|rank|title)\b|what badges|show.*badge|earned.*badge|do i have (any )?(badge|role|achievement)|what.?s my (rank|title)/)) {
      await handleBadges(message); return;
    }
    // Leaderboard
    if (cleanLower.match(/leaderboard|top (members|players|10)|who.?s (winning|on top|leading)|rankings/)) {
      await handleLeaderboard(message); return;
    }
    // Referral / invite
    if (cleanLower.match(/\b(my )?(invite|referral|refer|link)\b|invite (link|people|friends)|how (do i|can i) (refer|invite)/)) {
      await handleInvite(message); return;
    }
    // All badges list
    if (cleanLower.match(/all badges|what badges (are there|can i earn|exist)|list.*badge|available badges/)) {
      const embed = new EmbedBuilder().setColor(0x7B2FBE).setTitle('🎖️ Soul Harbor Badges');
      const earned = db ? ((await dbGet(userId))?.badges || []) : [];
      for (const [key, b] of Object.entries(BADGES_DEF)) {
        embed.addFields({ name: `${b.emoji} ${b.name} ${earned.includes(key)?'✅':'🔒'}`, value: b.desc, inline: true });
      }
      embed.setFooter({ text: '🔮 Soul Harbor • The Pagan Shop Online' }).setTimestamp();
      message.channel.send({ embeds: [embed] }); return;
    }
    // Help / commands
    if (cleanLower.match(/^(help|commands|what can you do|what do you do|how do i use you|how to use you|how do you work|what are your commands)$/)) { await handleHelp(message); return; }

    await handleChat(message, cleanContent);
  }
});

// ─── TAROT READING ───────────────────────────────────────
const TAROT_DECK = [
  { name: 'The Fool',           emoji: '🌟', keywords: 'new beginnings, spontaneity, innocence',           reversed: 'recklessness, naivety, holding back' },
  { name: 'The Magician',       emoji: '✨', keywords: 'willpower, resourcefulness, skill',                reversed: 'manipulation, poor planning, untapped talent' },
  { name: 'The High Priestess', emoji: '🌙', keywords: 'intuition, mystery, inner knowing',               reversed: 'repressed feelings, secrets, disconnection' },
  { name: 'The Empress',        emoji: '🌿', keywords: 'fertility, abundance, nurturing',                  reversed: 'insecurity, smothering, creative block' },
  { name: 'The Emperor',        emoji: '👑', keywords: 'authority, structure, stability',                   reversed: 'domination, rigidity, lack of discipline' },
  { name: 'The Hierophant',     emoji: '🕯️', keywords: 'tradition, guidance, spiritual wisdom',            reversed: 'rebellion, subversion, new approaches' },
  { name: 'The Lovers',         emoji: '💜', keywords: 'love, harmony, alignment',                         reversed: 'disharmony, imbalance, misalignment of values' },
  { name: 'The Chariot',        emoji: '⚡', keywords: 'victory, determination, willpower',                reversed: 'self-doubt, lack of direction, scattered energy' },
  { name: 'Strength',           emoji: '🦁', keywords: 'courage, patience, inner strength',                reversed: 'self-doubt, weakness, insecurity' },
  { name: 'The Hermit',         emoji: '🔦', keywords: 'solitude, introspection, guidance',                reversed: 'isolation, loneliness, withdrawal' },
  { name: 'Wheel of Fortune',   emoji: '🎡', keywords: 'cycles, fate, turning points',                    reversed: 'bad luck, resistance to change, breaking cycles' },
  { name: 'Justice',            emoji: '⚖️', keywords: 'fairness, truth, cause and effect',               reversed: 'unfairness, dishonesty, unaccountability' },
  { name: 'The Hanged Man',     emoji: '🌀', keywords: 'surrender, new perspective, pause',                reversed: 'stalling, needless sacrifice, fear of change' },
  { name: 'Death',              emoji: '🌑', keywords: 'transformation, endings, transition',              reversed: 'resistance to change, stagnation, fear of endings' },
  { name: 'Temperance',         emoji: '🌊', keywords: 'balance, patience, moderation',                    reversed: 'imbalance, excess, lack of long-term vision' },
  { name: 'The Devil',          emoji: '🔗', keywords: 'shadow self, addiction, materialism',              reversed: 'releasing bonds, overcoming addiction, freedom' },
  { name: 'The Tower',          emoji: '💥', keywords: 'upheaval, chaos, revelation',                      reversed: 'fear of change, averting disaster, personal transformation' },
  { name: 'The Star',           emoji: '⭐', keywords: 'hope, renewal, serenity',                          reversed: 'despair, disconnection, lack of faith' },
  { name: 'The Moon',           emoji: '🌕', keywords: 'illusion, fear, the subconscious',                 reversed: 'release of fear, repressed emotion, inner confusion' },
  { name: 'The Sun',            emoji: '☀️', keywords: 'joy, success, vitality',                           reversed: 'inner child blocked, temporary depression, lack of clarity' },
  { name: 'Judgement',          emoji: '🔔', keywords: 'reflection, reckoning, awakening',                 reversed: 'self-doubt, refusal of self-examination, harsh self-judgment' },
  { name: 'The World',          emoji: '🌍', keywords: 'completion, integration, accomplishment',          reversed: 'incompletion, shortcuts, delayed success' },
  { name: 'Ace of Wands',       emoji: '🔥', keywords: 'inspiration, new energy, potential',               reversed: 'delays, lack of motivation, creative block' },
  { name: 'Two of Cups',        emoji: '💞', keywords: 'partnership, attraction, connection',              reversed: 'breakup, imbalance in relationship, tension' },
  { name: 'Three of Pentacles', emoji: '🏗️', keywords: 'teamwork, learning, implementation',              reversed: 'disharmony, misalignment, working alone' },
  { name: 'Four of Swords',     emoji: '😴', keywords: 'rest, recovery, contemplation',                    reversed: 'restlessness, burnout, need to slow down' },
  { name: 'Five of Cups',       emoji: '😢', keywords: 'loss, regret, grief',                              reversed: 'acceptance, moving on, finding peace' },
  { name: 'Six of Wands',       emoji: '🏆', keywords: 'victory, recognition, progress',                  reversed: 'ego, fall from grace, lack of recognition' },
  { name: 'Seven of Pentacles', emoji: '🌱', keywords: 'patience, investment, long-term vision',           reversed: 'impatience, poor returns, wasted effort' },
  { name: 'Eight of Cups',      emoji: '🚶', keywords: 'walking away, seeking truth, transition',          reversed: 'fear of change, stagnation, clinging to the past' },
  { name: 'Nine of Swords',     emoji: '😰', keywords: 'anxiety, worry, fear',                             reversed: 'release of anxiety, hope, overcoming dread' },
  { name: 'Ten of Pentacles',   emoji: '🏡', keywords: 'legacy, family, long-term security',              reversed: 'financial loss, family disputes, fleeting success' },
  { name: 'King of Cups',       emoji: '🧘', keywords: 'emotional balance, compassion, wisdom',            reversed: 'emotional manipulation, moodiness, volatility' },
  { name: 'Queen of Wands',     emoji: '🦋', keywords: 'confidence, independence, passion',                reversed: 'jealousy, selfishness, demanding nature' },
  { name: 'Knight of Swords',   emoji: '⚔️', keywords: 'ambition, action, speed',                         reversed: 'recklessness, impatience, scattered focus' },
  { name: 'Page of Pentacles',  emoji: '📚', keywords: 'ambition, desire, diligence',                     reversed: 'procrastination, lack of progress, laziness' },
  { name: 'Ace of Cups',        emoji: '💧', keywords: 'new love, compassion, creativity',                reversed: 'emptiness, emotional loss, blocked creativity' },
  { name: 'Three of Swords',    emoji: '💔', keywords: 'heartbreak, sorrow, grief',                       reversed: 'recovery, forgiveness, releasing pain' },
  { name: 'Ten of Cups',        emoji: '🌈', keywords: 'happiness, harmony, fulfillment',                 reversed: 'broken family, misalignment, domestic struggles' },
  { name: 'Ace of Swords',      emoji: '🗡️', keywords: 'clarity, truth, breakthrough',                    reversed: 'confusion, miscommunication, chaos of thought' },
];

const SPREAD_POSITIONS = {
  1:  ['Answer'],
  2:  ['Yes/For', 'No/Against'],
  3:  ['Past', 'Present', 'Future'],
  4:  ['Mind', 'Body', 'Spirit', 'Outcome'],
  5:  ['Past', 'Present', 'Future', 'Hopes', 'Fears'],
  6:  ['Past', 'Present', 'Future', 'Foundation', 'Challenge', 'Outcome'],
  7:  ['Past', 'Present', 'Future', 'Foundation', 'Challenge', 'Advice', 'Outcome'],
  8:  ['Past', 'Present', 'Future', 'Foundation', 'Challenge', 'Hidden Influence', 'Advice', 'Outcome'],
  9:  ['Past', 'Present', 'Future', 'Foundation', 'Challenge', 'Hidden Influence', 'Advice', 'Hopes', 'Outcome'],
  10: ['Present Situation','Immediate Challenge','Distant Past','Recent Past','Best Outcome','Immediate Future','Your Influence','External Influence','Hopes & Fears','Final Outcome'],
  11: ['Present Situation','Immediate Challenge','Distant Past','Recent Past','Best Outcome','Immediate Future','Your Influence','External Influence','Inner Strength','Hopes & Fears','Final Outcome'],
  12: ['Past','Present','Future','Foundation','Challenge','Hidden Influence','Advice','External Energy','Inner Strength','Hopes','Fears','Final Outcome'],
  13: ['Distant Past','Recent Past','Present','Near Future','Far Future','Foundation','Challenge','Hidden Influence','Your Influence','External Influence','Advice','Hopes & Fears','Final Outcome'],
  14: ['Distant Past','Recent Past','Present','Near Future','Far Future','Foundation','Challenge','Hidden Influence','Your Influence','External Influence','Advice','Inner Strength','Hopes & Fears','Final Outcome'],
  15: ['Distant Past','Recent Past','Present','Near Future','Far Future','Foundation','Challenge','Hidden Influence','Your Influence','External Influence','Advice','Inner Strength','Hopes','Fears','Final Outcome'],
};

function shuffleDeck(count) {
  const drawn = [...TAROT_DECK].sort(() => Math.random() - 0.5).slice(0, count);
  // ~30% chance each card is reversed (standard tarot practice)
  return drawn.map(card => ({
    ...card,
    isReversed: Math.random() < 0.30,
  }));
}

async function handleTarot(message) {
  if (db && message.guild) {
    await dbEnsure(message.author.id, message.author.username);
    await addXP(message.author.id, message.author.username, XP_VALUES.soul_harbor_tarot, message.guild);
    await db.query('UPDATE members SET soul_harbor_interactions = soul_harbor_interactions + 1 WHERE user_id=$1', [message.author.id]);
    const mCheck = await dbGet(message.author.id);
    if (mCheck && mCheck.soul_harbor_interactions >= 50) await awardBadge(message.author.id, message.author.username, 'spirit_conversant', message.guild);
  }
  const content = message.content;
  const wordNums = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15 };
  const digitMatch = content.match(/(\d+)[\s-]*card/i);
  const wordMatch = content.match(/(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)[- ]*card/i);
  const yesNoMatch = content.match(/\byes\s*(or|\/)\s*no\b/i);
  let cardCount = 3;
  if (digitMatch) cardCount = parseInt(digitMatch[1]);
  else if (wordMatch) cardCount = wordNums[wordMatch[1].toLowerCase()] || 3;
  else if (yesNoMatch) cardCount = 1;
  if (cardCount < 1) cardCount = 1;
  if (cardCount > 15) cardCount = 15;

  const positions = SPREAD_POSITIONS[cardCount];
  const drawn = shuffleDeck(cardCount);
  const typing = await message.channel.send('🔮 *The spirits are laying out your cards...*');
  const cardList = drawn.map((c, i) => `${positions[i]}: ${c.name}${c.isReversed ? ' (REVERSED)' : ''} (${c.isReversed ? c.reversed : c.keywords})`).join('\n');
  let prompt;
  if (cardCount === 1) {
    const isYesNo = yesNoMatch || content.match(/\byes\b.*\bno\b/i);
    prompt = isYesNo
      ? `Do a mystical 1-card yes/no tarot reading for ${message.author.username}.\nCard drawn:\n${cardList}\n\nBased on the card drawn (and whether it is upright or reversed), give a clear YES or NO answer first, then a brief mystical explanation of why the card points that way. If reversed, weave that into your reasoning. Keep it concise, warm, and mystical. Under 150 words.`
      : `Do a mystical 1-card tarot reading for ${message.author.username}.\nCard drawn:\n${cardList}\n\nGive a focused, insightful reading based on this single card. If reversed, weave the reversal meaning naturally. Be mystical, warm, and specific. Under 150 words.`;
  } else {
    prompt = `Do a mystical ${cardCount}-card tarot reading for ${message.author.username}.\nCards drawn:\n${cardList}\n\nSome cards may be REVERSED — reversed cards carry opposite, blocked, or shadow meanings compared to their upright position. Weave the reversal into the reading naturally (e.g., "but this card appeared reversed, suggesting..."). Give a personal, flowing, insightful reading that connects ALL the cards together as a narrative. Reference each card's position by name. Be mystical, warm, and specific. Under 400 words.`;
  }
  const reading = await askGPT([{ role: 'system', content: SPIRIT_SYSTEM_PROMPT }, { role: 'user', content: prompt }], cardCount <= 2 ? 300 : 600);
  await typing.delete().catch(() => {});
  if (!reading) { message.channel.send('🔮 The spirits are clouded right now. Try again later.'); return; }
  const headerEmbed = makeEmbed(`🃏 ${cardCount}-Card Tarot Reading for ${message.author.displayName}`,
    drawn.map((c, i) => `${c.emoji} **${positions[i]}** — ${c.name}${c.isReversed ? ' 🔄 *(Reversed)*' : ''}\n*${c.isReversed ? c.reversed : c.keywords}*`).join('\n\n'));
  message.channel.send({ embeds: [headerEmbed] });
  const readingEmbed = makeEmbed('🔮 Your Reading', reading, 0x2d1b69);
  message.channel.send({ embeds: [readingEmbed] });
  if (db) {
    await dbEnsure(message.author.id, message.author.username);
    await db.query('UPDATE members SET tarot_count = tarot_count + 1 WHERE user_id=$1', [message.author.id]);
    const mTarot = await dbGet(message.author.id);
    if (mTarot && mTarot.tarot_count >= 25) await awardBadge(message.author.id, message.author.username, 'the_seer', message.guild);
  }
}

async function handleGhostStory(message) {
  if (db && message.guild) {
    await dbEnsure(message.author.id, message.author.username);
    await addXP(message.author.id, message.author.username, XP_VALUES.soul_harbor_ghost, message.guild);
    await db.query('UPDATE members SET soul_harbor_interactions = soul_harbor_interactions + 1 WHERE user_id=$1', [message.author.id]);
    const mCheck = await dbGet(message.author.id);
    if (mCheck && mCheck.soul_harbor_interactions >= 50) await awardBadge(message.author.id, message.author.username, 'spirit_conversant', message.guild);
  }
  const typing = await message.channel.send('👻 *Reaching into the shadow realm...*');
  const story = await askGPT([{ role: 'system', content: SPIRIT_SYSTEM_PROMPT }, { role: 'user', content: 'Write a short, creepy, atmospheric ghost story (150-200 words). Make it original, eerie, and leave the ending unsettling. Set it in a real-feeling location.' }], 350);
  await typing.delete().catch(() => {});
  if (!story) { message.channel.send('👻 The spirits have gone quiet. Try again later.'); return; }
  message.channel.send({ embeds: [makeEmbed('👻 A Tale From The Shadow Realm', story, 0x1a0a2e)] });
}

async function handleTrivia(message) {
  if (triviaActive.has(message.channel.id)) {
    const existing = triviaActive.get(message.channel.id);
    // If old trivia has a winner but wasn't cleaned up, force-clear it
    if (existing.winnerId) {
      console.log(`[TRIVIA] ⚠️ Force-clearing stale trivia in ${message.channel.name} (had winner ${existing.winnerId})`);
      triviaActive.delete(message.channel.id);
    } else {
      message.channel.send('🎯 A contest is already active! Answer the current question first.');
      return;
    }
  }
  const typing = await message.channel.send('🎯 *Consulting the spirits for a question...*');
  const result = await askGPT([{ role: 'system', content: SPIRIT_SYSTEM_PROMPT },
    { role: 'user', content: `Generate a trivia question about spirits, the paranormal, metaphysical topics, or spirit keeping. IMPORTANT RULES:\n1. The question and answer must be FACTUALLY ACCURATE based on widely accepted paranormal lore and mythology. Do not make up traits or attributes (e.g., poltergeists are NOT friendly — they are disruptive/mischievous).\n2. The answer must be clearly and unambiguously correct.\n3. Do NOT ask any of these already-used questions (pick something completely different): ${recentTriviaQuestions.length > 0 ? recentTriviaQuestions.slice(-50).join(' | ') : 'none'}.\n4. Be creative and vary the topic.\nFormat EXACTLY as:\nQUESTION: [question here]\nANSWER: [one word or short phrase answer]` }], 150);
  await typing.delete().catch(() => {});
  if (!result) { message.channel.send('🎯 Could not generate a question. Try again!'); return; }
  const qMatch = result.match(/QUESTION:\s*(.+)/i);
  const aMatch = result.match(/ANSWER:\s*(.+)/i);
  if (!qMatch || !aMatch) { message.channel.send('🎯 Could not generate a question. Try again!'); return; }
  const question = qMatch[1].trim();
  const answer = aMatch[1].trim();
  const sessionToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  triviaActive.set(message.channel.id, { answer, winnerId: null, startTime: Date.now(), token: sessionToken });
  recentTriviaQuestions.push(question);
  if (recentTriviaQuestions.length > 50) recentTriviaQuestions.shift();
  await saveTriviaHistory(question);
  message.channel.send({ embeds: [makeEmbed('🏆 Spirit Trivia Contest!', `**${question}**\n\nFirst correct answer wins a **${CONFIG.COUPONS.DISCOUNT_PERCENT}% discount code**! 🎁\n\n⏱️ You have 5 minutes!`, 0xFFD700)] });
  setTimeout(() => {
    const currentSession = triviaActive.get(message.channel.id);
    if (currentSession && currentSession.token === sessionToken && !currentSession.winnerId) {
      triviaActive.delete(message.channel.id);
      message.channel.send({ embeds: [makeEmbed('⏱️ Time\'s Up!', `Nobody answered in time! The answer was: **${answer}**\n\nBetter luck next time! 🔮`)] });
    }
  }, 300000);
}

async function handleHoroscope(message) {
  if (db && message.guild) {
    await dbEnsure(message.author.id, message.author.username);
    await addXP(message.author.id, message.author.username, XP_VALUES.soul_harbor_horoscope, message.guild);
    await db.query('UPDATE members SET soul_harbor_interactions = soul_harbor_interactions + 1 WHERE user_id=$1', [message.author.id]);
    const mCheck = await dbGet(message.author.id);
    if (mCheck && mCheck.soul_harbor_interactions >= 50) await awardBadge(message.author.id, message.author.username, 'spirit_conversant', message.guild);
  }
  const signs = ['aries','taurus','gemini','cancer','leo','virgo','libra','scorpio','sagittarius','capricorn','aquarius','pisces'];
  const sign = signs.find(s => message.content.toLowerCase().includes(s)) || 'general';
  const horoscope = await askGPT([{ role: 'system', content: SPIRIT_SYSTEM_PROMPT },
    { role: 'user', content: `Give a mystical, spirit-themed daily horoscope for ${sign}. Connect it to spirit energy and metaphysical themes. 100 words max.` }], 200);
  if (!horoscope) return;
  message.channel.send({ embeds: [makeEmbed(`🌙 Daily Horoscope${sign !== 'general' ? ` — ${sign}` : ''}`, horoscope, 0x2d1b69)] });
}

async function handleSpiritInfo(message, spiritName) {
  const typing = await message.channel.send(`🔮 *Consulting the encyclopedia on ${spiritName}...*`);
  const info = await askGPT([{ role: 'system', content: SPIRIT_SYSTEM_PROMPT },
    { role: 'user', content: `Give a brief overview of the spirit/entity "${spiritName}" — what they are, their energy (White Arts/Dark Arts/Black Arts), realm of origin, and what they help with as a spirit companion. Keep it under 200 words. End with: "Learn more at thepaganshoponline.com 🔮"` }], 300);
  await typing.delete().catch(() => {});
  if (!info) return;
  message.channel.send({ embeds: [makeEmbed(`🔮 ${spiritName}`, info)] });
}

async function handleChat(message, userInput) {
  const reply = await askGPT([{ role: 'system', content: SPIRIT_SYSTEM_PROMPT }, { role: 'user', content: userInput }], 350);
  if (reply) message.reply(reply);
}

async function handleCoupon(message) {
  // Accept either VIP Keeper role, Verified Patron badge-role, or verified_patron in database
  const hasVIP = message.member.roles.cache.find(r =>
    r.name === CONFIG.ROLES.VIP_KEEPER || r.name === '✅ Verified Patron'
  );
  let hasDbBadge = false;
  if (!hasVIP && db) {
    const m = await dbGet(message.author.id);
    hasDbBadge = m?.badges?.includes('verified_patron');
  }
  if (!hasVIP && !hasDbBadge) {
    message.reply('🔮 Discount codes are earned through contests and Verified Patron status. Join a trivia contest to win one, or make a purchase from the shop!');
    return;
  }
  const code = generateCouponCode();
  await saveCouponToShop(code);
  message.author.send(`🎁 Your exclusive discount code: \`${code}\`\nUse at thepaganshoponline.com — valid 7 days!`).catch(() => {
    message.reply(`🎁 Your discount code: \`${code}\` *(I couldn't DM you — save this quickly!)*`);
  });
  message.reply('✅ Your discount code has been sent to your DMs! 🎁');
}

async function handleBadges(message) {
  // Include both special CONFIG.ROLES names AND XP level role names (Seeker, Initiate, etc.)
  const levelRoleNames = LEVELS.map(l => l.name);
  const allKnownRoles = [...Object.values(CONFIG.ROLES), ...levelRoleNames];

  const memberRoles = message.member.roles.cache.filter(r => allKnownRoles.includes(r.name));

  // Separate level roles from special roles for cleaner display
  const levelRole = memberRoles.find(r => levelRoleNames.includes(r.name));
  const specialRoles = memberRoles.filter(r => Object.values(CONFIG.ROLES).includes(r.name));

  // If no Discord level role found, fall back to the database tier (prevents "nothing" display)
  let rankDisplay = '';
  if (levelRole) {
    rankDisplay = `✨ **Rank:** ${levelRole.name}\n`;
  } else if (db) {
    await dbEnsure(message.author.id, message.author.username);
    const mRank = await dbGet(message.author.id);
    const tier = getTierForXP(mRank?.xp || 0);
    rankDisplay = `✨ **Rank:** ${tier.name}\n`;
  } else {
    rankDisplay = `✨ **Rank:** Seeker\n`;
  }

  let rolesDisplay = rankDisplay;
  if (specialRoles.size) rolesDisplay += specialRoles.map(r => `✅ ${r.name}`).join('\n');

  let phase2 = '';
  if (db) {
    const m = await dbGet(message.author.id);
    const earned = (m?.badges || []);
    phase2 = earned.length
      ? '\n\n**🎖️ Achievement Badges:**\n' + earned.map(k => BADGES_DEF[k] ? `${BADGES_DEF[k].emoji} ${BADGES_DEF[k].name}` : '').filter(Boolean).join(' · ')
      : '\n\n*No achievement badges yet — post altar pics, win trivia, attend classes!*';
  }

  message.channel.send({ embeds: [makeEmbed(`🏅 Badges for ${message.author.displayName}`,
    rolesDisplay.trim() + phase2 +
    '\n\n*Use `!allbadges` to see all achievement badges*')] });
}

async function handleHelp(message) {
  message.channel.send({ embeds: [makeEmbed('🔮 Soul Harbor Commands',
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
    '`!keep upload <spirit>` — Upload a text file as journal entry\n' +
    '`!keep view [spirit]` — Read your journal (DM\'d to you)\n' +
    '`!keep list` — See all your spirits\n' +
    '🎙️ Send a **voice memo** in DMs to auto-save to Keep!\n\n' +
    '**🔗 Referrals:**\n' +
    '`!invite` — Get your personal invite link (+100 XP per referral)\n\n' +
    '**🎖️ Badges:**\n' +
    '`!badges` — See your earned badges\n' +
    '`!allbadges` — See all available achievement badges\n' +
    '`!class` — View next class schedule\n' +
    '`!lastclass` — Repost the most recent class lesson\n\n' +
    '**⭐ How to Earn XP:**\n' +
    '💬 Chat — 2 XP/min · 🔮 Tarot — 15 XP · 🌙 Horoscope/Ghost — 8 XP\n' +
    '❓ Ask — 10 XP · 🕯️ Altar pic — 50 XP · ✨ Manifestation — 50 XP\n' +
    '🌙 Spell/ritual — 60 XP · 👁️ Paranormal story — 75 XP\n' +
    '🏆 Win trivia — 75 XP · 📚 Attend class — 40 XP · 👋 Refer friend — 100 XP\n\n' +
    '**🌟 Level Titles:**\n' +
    'L1 Seeker → L5 Initiate → L10 Neophyte → L15 Practitioner\n' +
    'L20 Mystic → L30 Magus → L40 Elder → L50 Grandmaster\n\n' +
    '🛍️ Shop: **thepaganshoponline.com**'
  )] });
}

// Wrap every scheduled job so Railway logs always show: fired / done / failed
function scheduledJob(name, fn) {
  return async () => {
    console.log(`[cron] ${name} starting (${new Date().toISOString()})`);
    try {
      await fn();
      console.log(`[cron] ${name} done`);
    } catch (err) {
      console.error(`[cron] ${name} FAILED:`, err);
    }
  };
}

async function scheduleDailyTasks() {
  let guild = client.guilds.cache.get(CONFIG.GUILD_ID);
  if (!guild) {
    try { guild = await client.guilds.fetch(CONFIG.GUILD_ID); } catch(e) { console.log('Could not fetch guild:', e.message); }
  }
  if (!guild) { console.log('❌ Could not find guild for scheduled tasks'); return; }

  const TZ = { timezone: CONFIG.TIMEZONE };

  // 👻 Ghost story — 10:00 PM local time, every night (DST-proof: no UTC math)
  cron.schedule('0 22 * * *', scheduledJob('ghost-story', async () => {
    const channel = getChannel(guild, CONFIG.CHANNELS.GHOST_STORY);
    if (!channel) {
      console.log(`❌ Ghost story channel not found. Looking for: "${CONFIG.CHANNELS.GHOST_STORY}"`);
      console.log('Available channels:', guild.channels.cache.filter(c=>c.type===0||c.type===5).map(c=>c.name).join(', '));
      return;
    }
    console.log(`✅ Ghost story posting to #${channel.name}`);
    const story = await askGPT([{ role: 'system', content: SPIRIT_SYSTEM_PROMPT }, { role: 'user', content: 'Write a short, original, creepy ghost story (150-200 words). Make it atmospheric and leave the ending unsettling.' }], 350);
    if (story) await channel.send({ embeds: [makeEmbed('👻 Tonight\'s Tale From The Shadow Realm', story, 0x1a0a2e)] });
  }), TZ);

  // 🃏 Card of the day — 10:00 AM local time
  cron.schedule('0 10 * * *', scheduledJob('card-of-the-day', async () => {
    const channel = getChannel(guild, CONFIG.CHANNELS.TAROT);
    if (!channel) { console.log(`❌ Tarot channel not found: "${CONFIG.CHANNELS.TAROT}"`); return; }
    const cards = ['The Moon','The Star','The Sun','The World','The Fool','The Magician','The High Priestess','Strength','The Hermit','Wheel of Fortune','The Tower','Judgement'];
    const card = cards[Math.floor(Math.random() * cards.length)];
    const reading = await askGPT([{ role: 'system', content: SPIRIT_SYSTEM_PROMPT }, { role: 'user', content: `Today's card of the day is "${card}". Give a brief daily message and guidance based on this card's energy. 100 words max. Make it feel mystical and personal.` }], 200);
    if (reading) await channel.send({ embeds: [makeEmbed('🃏 Card of the Day', `**${card}**\n\n${reading}`, 0x6B2D8B)] });
  }), TZ);

  // 🏆 Daily trivia — 6:00 PM local time (matches the welcome message)
  cron.schedule('0 18 * * *', scheduledJob('daily-trivia', async () => {
    const channel = getChannel(guild, CONFIG.CHANNELS.TRIVIA);
    if (!channel) {
      console.log(`❌ Trivia channel not found. Looking for: "${CONFIG.CHANNELS.TRIVIA}"`);
      console.log('Available channels:', guild.channels.cache.filter(c=>c.type===0||c.type===5).map(c=>c.name).join(', '));
      return;
    }
    console.log(`✅ Trivia posting to #${channel.name}`);
    // Force-clear any stale trivia state before starting daily
    if (triviaActive.has(channel.id)) {
      console.log(`[TRIVIA] ⚠️ Force-clearing stale trivia in #${channel.name} before daily trivia`);
      triviaActive.delete(channel.id);
    }
    const result = await askGPT([{ role: 'system', content: SPIRIT_SYSTEM_PROMPT },
      { role: 'user', content: `Generate a trivia question about spirits, paranormal, or metaphysical topics. IMPORTANT RULES:\n1. The question and answer must be FACTUALLY ACCURATE based on widely accepted paranormal lore and mythology. Do not invent traits or attributes for well-known entities.\n2. The answer must be clearly and unambiguously correct.\n3. Do NOT ask any of these already-used questions: ${recentTriviaQuestions.length > 0 ? recentTriviaQuestions.slice(-50).join(' | ') : 'none'}.\nFormat EXACTLY as:\nQUESTION: [question]\nANSWER: [short answer]` }], 150);
    if (!result) return;
    const qMatch = result.match(/QUESTION:\s*(.+)/i);
    const aMatch = result.match(/ANSWER:\s*(.+)/i);
    if (!qMatch || !aMatch) { console.log('❌ Trivia generation returned bad format:', result.substring(0, 120)); return; }
    const question = qMatch[1].trim();
    const answer = aMatch[1].trim();
    const dailyToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    triviaActive.set(channel.id, { answer, winnerId: null, startTime: Date.now(), token: dailyToken });
    recentTriviaQuestions.push(question);
    if (recentTriviaQuestions.length > 50) recentTriviaQuestions.shift();
    await saveTriviaHistory(question);
    await channel.send({ embeds: [makeEmbed('🏆 Daily Spirit Trivia!', `**${question}**\n\nFirst correct answer wins a **${CONFIG.COUPONS.DISCOUNT_PERCENT}% discount code**! 🎁\n\n⏱️ You have 5 minutes!`, 0xFFD700)] });
    setTimeout(() => {
      const currentDaily = triviaActive.get(channel.id);
      if (currentDaily && currentDaily.token === dailyToken && !currentDaily.winnerId) {
        triviaActive.delete(channel.id);
        channel.send({ embeds: [makeEmbed('⏱️ Time\'s Up!', `Nobody answered! The answer was: **${answer}**\n\nNew contest tomorrow! 🔮`)] });
      }
    }, 300000);
  }), TZ);

  // 📚 Weekly class — Wednesday 6:00 PM local time
  cron.schedule('0 18 * * 3', scheduledJob('weekly-class', async () => { await runWeeklyClass(guild); }), TZ);

  // 📝 Blog → Discord — checks the shop blog feed every 30 minutes, posts new articles
  if (process.env.BLOG_FEED_URL) {
    cron.schedule('*/30 * * * *', scheduledJob('blog-to-discord', async () => { await postNewBlogArticles(guild); }), TZ);
    console.log(`✅ Blog poller scheduled (${process.env.BLOG_FEED_URL})`);
  } else {
    console.log('⚠️  BLOG_FEED_URL not set — blog-to-Discord posting disabled. Set it to the blog RSS/feed URL on Railway.');
  }

  // 🧹 Coupon cleanup — 3:00 AM daily, removes expired bot-generated SOUL- coupons from Zen Cart
  cron.schedule('0 3 * * *', scheduledJob('coupon-cleanup', async () => { await cleanupExpiredCoupons(); }), TZ);

  console.log(`✅ Daily tasks scheduled in timezone ${CONFIG.TIMEZONE}: ghost 10PM · trivia 6PM · card 10AM · class Wed 6PM · coupon-cleanup 3AM`);
}

// ─── BLOG → DISCORD POLLER ───────────────────────────────
async function postNewBlogArticles(guild) {
  const feedUrl = process.env.BLOG_FEED_URL;
  if (!feedUrl) return;
  const channel = getChannel(guild, process.env.CHANNEL_BLOG || CONFIG.CHANNELS.ANNOUNCEMENTS);
  if (!channel) { console.log('❌ Blog channel not found'); return; }

  const res = await fetch(feedUrl, { headers: { 'User-Agent': 'SoulHarborBot/2.0' } });
  if (!res.ok) { console.log(`❌ Blog feed fetch failed: HTTP ${res.status}`); return; }
  const xml = await res.text();

  // Lightweight RSS/Atom item parsing (no extra dependency)
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of itemBlocks.slice(0, 10)) {
    const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1]?.trim();
    let link = (block.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i) || [])[1]?.trim();
    if (!link) link = (block.match(/<link[^>]*href="([^"]+)"/i) || [])[1]?.trim(); // Atom style
    if (title && link) items.push({ title, link });
  }
  if (!items.length) { console.log('⚠️ Blog feed parsed but no items found'); return; }

  if (db) {
    await db.query(`CREATE TABLE IF NOT EXISTS blog_posted (link TEXT PRIMARY KEY, posted_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
    // First run: mark existing items as seen WITHOUT posting (avoids flooding the channel with old articles)
    const seenCount = parseInt((await db.query('SELECT COUNT(*) FROM blog_posted')).rows[0].count);
    if (seenCount === 0) {
      for (const it of items) await db.query('INSERT INTO blog_posted (link) VALUES ($1) ON CONFLICT DO NOTHING', [it.link]);
      console.log(`✅ Blog poller initialized — marked ${items.length} existing articles as seen`);
      return;
    }
    for (const it of items.reverse()) { // oldest first so they post in order
      const exists = await db.query('SELECT 1 FROM blog_posted WHERE link=$1', [it.link]);
      if (exists.rows.length > 0) continue;
      await db.query('INSERT INTO blog_posted (link) VALUES ($1) ON CONFLICT DO NOTHING', [it.link]);
      const embed = makeEmbed('📝 New on The Pagan Shop Online Blog', `**${it.title}**\n\n🔗 [Read the full article](${it.link})`, 0x7B2FBE);
      await channel.send({ embeds: [embed] });
      console.log(`✅ Posted blog article to Discord: ${it.title}`);
    }
  }
}

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
    [/admin|mod.rules|staff.rules/, '🛡️'], [/mod.chat|staff.chat|admin.chat/, '💬'],
    [/bot.command|commands/, '🤖'], [/intro|welcome/, '👋'], [/rules/, '📜'],
    [/announc/, '📣'], [/soulharbor|soul.harbor.chat|harbor.chat/, '🔮'],
    [/ghost/, '👻'], [/tarot/, '🃏'], [/trivia|contest/, '🏆'],
    [/horoscope|astro/, '🌙'], [/shop.link|store.link/, '🛍️'],
    [/new.custom|pre.conjure|new.listing/, '🌟'], [/review/, '⭐'],
    [/event|sale|discount/, '📅'], [/about.billy|about.us/, '🧿'],
    [/spiritboard/, '🌐'], [/general|chat|lounge/, '🗣️'],
    [/gallery|photo|image/, '🖼️'], [/music/, '🎵'], [/movie|film|watch/, '🎬'],
    [/link|video|media/, '🔗'], [/gratitude|excite|celebrat/, '🙏'],
    [/vent|rant/, '💭'], [/nsfw|adult/, '🔞'],
    [/education|learn|class|lesson/, '📖'], [/blog|post|article/, '📝'],
    [/experience|story|stories|testimonial/, '✨'], [/auction/, '🔨'],
    [/angel/, '👼'], [/asia|asian|eastern/, '🌏'],
    [/creature|beast|monster/, '🐉'], [/demon|dark.arts/, '👿'],
    [/djinn|genie|jinn/, '🧞'], [/dragon/, '🐲'], [/elf|elven/, '🧝'],
    [/fae|fairy|faerie/, '🧚'], [/human|warlock|witch/, '👤'],
    [/hybrid|mix/, '🔀'], [/immortal|eternal/, '♾️'],
    [/sexual|romance|love/, '🔥'], [/vampire|vamp/, '🧛'],
    [/xp|level|rank|badge|achievement/, '🏅'], [/leaderboard|top/, '🏆'],
    [/reward|point|earn/, '💎'], [/quest|mission|challenge/, '⚔️'],
    [/market|store|buy|sell/, '🛒'], [/conjure|custom/, '✨'],
    [/affiliat|partner|collab/, '🤝'], [/feedback|suggest/, '💡'],
    [/help|support|ticket/, '🆘'], [/voice|vc|audio/, '🎙️'],
    [/game|gaming/, '🎮'], [/art|creative|design/, '🎨'],
    [/spiritual|sacred|ritual/, '🕯️'], [/moon|lunar/, '🌕'],
    [/crystal|gem|stone/, '💎'], [/spell|magic|magick/, '✨'],
    [/divination|oracle/, '🔮'], [/healing|wellness/, '💚'],
    [/protection|shield/, '🛡️'], [/abundance|prosperity|wealth/, '💰'],
    [/spirit.companion|companion/, '💜'],
  ];
  for (const [pattern, emoji] of rules) { if (pattern.test(n)) return emoji; }
  return '✨';
}

const CHANNEL_RENAMES = {};

async function handleSetup(message) {
  const allowedIds = [CONFIG.OWNER_ID, '1511088381013262560'];
  if (!allowedIds.includes(message.author.id)) { message.reply('❌ Only admins can run this command.'); return; }
  const msg = await message.reply('⏳ Starting channel organization... this will take 2-3 minutes.');
  const guild = message.guild;
  await guild.channels.fetch();
  await ensureAdminChannel(guild);
  await ensureServerGuide(guild);
  let renamed = 0, errors = 0;

  const existingCats = guild.channels.cache.filter(c => c.type === 4);
  const hasSoulHarborCat = existingCats.some(c => c.name.toLowerCase().includes('soul harbor'));
  if (!hasSoulHarborCat) {
    const soulHarborCat = await guild.channels.create({ name: '🔮・SOUL HARBOR', type: 4 }).catch(() => null);
    if (soulHarborCat) {
      for (const chName of ['soulharbor-chat', 'soul-harbor-ghost-stories']) {
        const ch = guild.channels.cache.find(c => c.name === chName);
        if (ch) await ch.setParent(soulHarborCat.id).catch(() => {});
      }
    }
  }

  for (const channel of guild.channels.cache.values()) {
    if (channel.type === 4) {
      const key = channel.name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      const newName = CATEGORY_RENAMES[key];
      if (newName && channel.name !== newName) {
        try { await channel.setName(newName); renamed++; await new Promise(r => setTimeout(r, 1200)); } catch(e) { errors++; }
      }
    }
  }

  for (const channel of guild.channels.cache.values()) {
    if (channel.type === 0 || channel.type === 2) {
      const firstCode = channel.name.codePointAt(0);
      if (firstCode > 127) continue;
      const emoji = getSmartEmoji(channel.name);
      const newName = emoji + '・' + channel.name;
      try { await channel.setName(newName); renamed++; await new Promise(r => setTimeout(r, 1500)); } catch(e) { errors++; }
    }
  }

  msg.edit(`✅ Done! Renamed **${renamed}** channels and categories. Errors: ${errors}\n\nThe server is now organized! 🔮`);
}

client.on('channelCreate', async (channel) => {
  if (channel.type !== 0 && channel.type !== 2) return;
  const firstCode = channel.name.codePointAt(0);
  if (firstCode > 127) return;
  try {
    const emoji = getSmartEmoji(channel.name);
    await channel.setName(emoji + '・' + channel.name);
  } catch(e) { console.log('Could not auto-emoji channel:', e.message); }
});

client.on('raw', async (packet) => {
  if (packet.t !== 'MESSAGE_CREATE') return;
  if (packet.d.guild_id) return;
  if (packet.d.author?.bot) return;
  console.log('📨 Raw DM packet received from:', packet.d.author?.username, '| Content:', packet.d.content);
  try {
    const channel = await client.channels.fetch(packet.d.channel_id).catch(() => null);
    if (!channel) return;
    const dmContent = packet.d.content?.trim();
    if (!dmContent) return;
    const fakeMsg = {
      author: { id: packet.d.author.id, tag: packet.d.author.username, bot: false, displayAvatarURL: () => '', username: packet.d.author.username, displayName: packet.d.author.username },
      content: dmContent, guild: null, channel,
      reply: (text) => channel.send(typeof text === 'string' ? text : text),
      mentions: { has: () => false }, partial: false,
      displayName: packet.d.author.username,
    };
    const dmLower = dmContent.toLowerCase();
    if (dmLower.match(/tarot|card reading|\d+.card|card spread/)) { await handleTarot(fakeMsg); return; }
    if (dmLower.match(/ghost story|paranormal story|scary story/)) { await handleGhostStory(fakeMsg); return; }
    if (dmLower.match(/horoscope|zodiac/)) { await handleHoroscope(fakeMsg); return; }
    if (dmLower.match(/help|commands/)) { await handleHelp(fakeMsg); return; }
    await handleChat(fakeMsg, dmContent);
  } catch(e) { console.log('❌ Raw DM handler error:', e.message); }
});

client.login(process.env.DISCORD_TOKEN);

async function handleAward(message, args) {
  if (!db) return message.reply('Database required.');
  if (!isOwner(message)) return message.reply('❌ Only the server owner can award badges.');
  const parts = args.split(/\s+/);
  const badgeKey = parts[0];
  const mention = message.mentions.members?.first();
  if (!badgeKey || !mention) return message.reply('Usage: `!award <badge_key> @user`\n\nBadge keys: ' + Object.keys(BADGES_DEF).join(', '));
  if (!BADGES_DEF[badgeKey]) return message.reply(`❌ Unknown badge: \`${badgeKey}\`\n\nValid keys: ${Object.keys(BADGES_DEF).join(', ')}`);
  await awardBadge(mention.id, mention.user.username, badgeKey, message.guild);
  const b = BADGES_DEF[badgeKey];

  // ── AUTO-LINK: verified_patron badge → also assign VIP Keeper role ──
  // Billy only needs one command; both get applied automatically
  if (badgeKey === 'verified_patron') {
    let vipRole = message.guild.roles.cache.find(r => r.name === CONFIG.ROLES.VIP_KEEPER);
    if (!vipRole) {
      try {
        vipRole = await message.guild.roles.create({
          name: CONFIG.ROLES.VIP_KEEPER,
          color: 0x00B0FF,
          reason: 'Soul Harbor: auto-created VIP Keeper role via verified_patron award',
          hoist: false,
        });
      } catch(e) { console.error('Could not create VIP Keeper role:', e.message); }
    }
    if (vipRole) await mention.roles.add(vipRole).catch(() => {});
  }

  message.reply(`✅ Awarded **${b.emoji} ${b.name}** to ${mention}!${badgeKey === 'verified_patron' ? ' (VIP Keeper role also assigned 💎)' : ''}`);
}

async function handleSyncRoles(message) {
  if (!isOwner(message)) return message.reply('❌ Only the server owner can run this.');
  const msg = await message.reply('⏳ Syncing roles — assigning Seeker to all members without a level role, and removing Member role from everyone...');
  const guild = message.guild;
  await guild.members.fetch();
  const seekerRole = guild.roles.cache.find(r => r.name === 'Seeker');
  if (!seekerRole) return msg.edit('❌ Seeker role not found. Restart the bot first to create it.');
  const memberRole = guild.roles.cache.find(r => (r.name.toLowerCase() === 'member' || r.name.toLowerCase() === 'members'));
  const levelRoleNames = LEVELS.map(l => l.name);
  let synced = 0, cleaned = 0, skipped = 0;
  for (const [, member] of guild.members.cache) {
    if (member.user.bot) continue;
    if (await isExcludedFromXP(member)) { skipped++; continue; }
    // Remove Member role if they have it
    if (memberRole && member.roles.cache.has(memberRole.id)) {
      await member.roles.remove(memberRole).catch(() => {});
      cleaned++;
    }
    // Add Seeker if they have no level role yet
    const hasLevelRole = member.roles.cache.some(r => levelRoleNames.includes(r.name));
    if (!hasLevelRole) {
      await member.roles.add(seekerRole).catch(() => {});
      if (db) await dbEnsure(member.id, member.user.username);
      synced++;
    } else { skipped++; }
    await new Promise(r => setTimeout(r, 300));
  }
  msg.edit(`✅ Done!\n\n🔮 **Seeker assigned:** ${synced} members\n🗑️ **Member role removed:** ${cleaned} members\n⏭️ **Skipped (already have level role):** ${skipped}`);
}

// ── !cleanmemberrole — one-shot remove Member role from everyone (owner only) ──
async function handleCleanMemberRole(message) {
  if (!isOwner(message)) return message.reply('❌ Only the server owner can run this.');
  const guild = message.guild;
  await guild.members.fetch();
  const memberRole = guild.roles.cache.find(r => (r.name.toLowerCase() === 'member' || r.name.toLowerCase() === 'members'));
  if (!memberRole) return message.reply('ℹ️ No "Member" role found in this server — nothing to clean up!');
  const msg = await message.reply(`⏳ Removing "Member" role from all ${guild.memberCount} members... this may take a moment.`);
  let removed = 0, skipped = 0;
  for (const [, member] of guild.members.cache) {
    if (member.user.bot) continue;
    if (member.roles.cache.has(memberRole.id)) {
      await member.roles.remove(memberRole).catch(() => {});
      removed++;
      await new Promise(r => setTimeout(r, 300)); // rate limit safety
    } else { skipped++; }
  }
  msg.edit(`✅ Done! Removed "Member" role from **${removed}** members. **${skipped}** didn't have it.`);
}
