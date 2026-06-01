const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const OpenAI = require('openai');
const cron = require('node-cron');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ]
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
    WELCOME:       process.env.CHANNEL_WELCOME        || 'welcome',
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

function getChannel(guild, name) {
  return guild.channels.cache.find(c => c.name === name || c.name === name.toLowerCase().replace(/ /g,'-'));
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
console.log('✅ All environment variables present');
console.log('GUILD_ID:', process.env.GUILD_ID);
console.log('OWNER_ID:', process.env.OWNER_ID);
console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '✅ set' : '❌ missing');
console.log('DISCORD_TOKEN:', process.env.DISCORD_TOKEN ? '✅ set' : '❌ missing');

// ─── BOT READY ───────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Soul Harbor is online as ${client.user.tag}`);
  client.user.setActivity('🔮 Watching over the spirits...', { type: 3 });
  scheduleDailyTasks();
});

// ─── WELCOME NEW MEMBERS ─────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  const guild = member.guild;

  // Assign Spirit Seeker role
  const role = guild.roles.cache.find(r => r.name === CONFIG.ROLES.SPIRIT_SEEKER);
  if (role) member.roles.add(role).catch(console.error);

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
    `🕯️ Browse our spirit companions at **thepaganshoponline.com**\n\n` +
    `May your spirits guide you well. 🌙`
  ).setThumbnail(member.user.displayAvatarURL());

  welcomeChannel.send({ embeds: [embed] });

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
      // DM the owner
      const owner = await client.users.fetch(CONFIG.OWNER_ID).catch(() => null);
      if (owner) {
        owner.send(
          `🚨 **Moderation Alert**\n` +
          `User **${message.author.tag}** (${userId}) has received 3 warnings in **${message.guild.name}**.\n` +
          `Last message: "${content}"\n\n` +
          `Do you want to kick or ban them? Reply with their username to take action.`
        );
      }
      warnCount.set(userId, 0);
    }
    return;
  }

  // ── NATURAL LANGUAGE INTENT DETECTION ──
  // Responds to @mentions OR messages in the general chat channel
  const isMentioned = message.mentions.has(client.user);
  const isGeneralChat = message.channel.name === CONFIG.CHANNELS.GENERAL;
  const shouldRespond = isMentioned || isGeneralChat;

  if (shouldRespond) {
    // Strip the @mention from content if present
    const cleanContent = content.replace(/<@!?\d+>/g, '').trim();
    const cleanLower = cleanContent.toLowerCase();

    // Tarot / card reading intent
    if (cleanLower.match(/tarot|card reading|card spread|pull.*card|reading|draw.*card/)) {
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

  // Also allow old ! commands as fallback for power users
  if (lower.startsWith('!tarot') || lower.startsWith('!reading')) { await handleTarot(message); return; }
  if (lower.startsWith('!ghost') || lower.startsWith('!story')) { await handleGhostStory(message); return; }
  if (lower.startsWith('!trivia') || lower.startsWith('!contest')) { await handleTrivia(message); return; }
  if (lower.startsWith('!horoscope')) { await handleHoroscope(message); return; }
  if (lower.startsWith('!spirit ')) { await handleSpiritInfo(message, content.slice(8)); return; }
  if (lower.startsWith('!help') || lower === '!commands') { await handleHelp(message); return; }
  if (lower.startsWith('!badge') || lower.startsWith('!badges')) { await handleBadges(message); return; }

  // ── TRIVIA ANSWER CHECK ──
  if (triviaActive.has(message.channel.id)) {
    const trivia = triviaActive.get(message.channel.id);
    if (!trivia.winnerId && lower.includes(trivia.answer.toLowerCase())) {
      trivia.winnerId = userId;
      const code = generateCouponCode();
      const embed = makeEmbed(
        '🏆 We Have a Winner!',
        `🎉 Congratulations ${message.author}!\n\n` +
        `You answered correctly!\n\n` +
        `Your **${CONFIG.COUPONS.DISCOUNT_PERCENT}% discount code** is:\n` +
        `# \`${code}\`\n\n` +
        `Use it at **thepaganshoponline.com** at checkout!\n` +
        `Valid for 7 days. 🛍️`,
        0xFFD700
      );
      message.channel.send({ embeds: [embed] });
      triviaActive.delete(message.channel.id);

      // Assign Contest Champion role
      const role = message.guild.roles.cache.find(r => r.name === CONFIG.ROLES.CONTEST_CHAMPION);
      if (role) message.member.roles.add(role).catch(console.error);
    }
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
  10: ['Present Situation','Immediate Challenge','Distant Past','Recent Past','Best Outcome','Immediate Future','Your Influence','External Influence','Hopes & Fears','Final Outcome'],
};

function shuffleDeck(count) {
  const shuffled = [...TAROT_DECK].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

async function handleTarot(message) {
  const content = message.content;
  const numMatch = content.match(/(\d+)[- ]*card/i);
  let cardCount = numMatch ? parseInt(numMatch[1]) : 3;
  if (cardCount < 3) cardCount = 3;
  if (cardCount > 10) cardCount = 10;
  const validSpreads = [3, 4, 5, 6, 7, 10];
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
}


// ─── GHOST STORY ─────────────────────────────────────────
async function handleGhostStory(message) {
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
    { role: 'user', content: 'Generate a trivia question about spirits, the paranormal, metaphysical topics, or spirit keeping. Format EXACTLY as:\nQUESTION: [question here]\nANSWER: [one word or short phrase answer]' }
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

  triviaActive.set(message.channel.id, { answer, winnerId: null });

  const embed = makeEmbed(
    '🏆 Spirit Trivia Contest!',
    `**${question}**\n\n` +
    `First correct answer wins a **${CONFIG.COUPONS.DISCOUNT_PERCENT}% discount code**! 🎁\n\n` +
    `⏱️ You have 2 minutes!`,
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
  }, 120000);
}

// ─── HOROSCOPE ───────────────────────────────────────────
async function handleHoroscope(message) {
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
    {
      role: 'system',
      content: SPIRIT_SYSTEM_PROMPT + '\n\nIf the message contains obvious spelling mistakes, gently note the correct spelling at the very end of your response like: *(Just a note: it is spelled correctly as X)*. Only for clear typos, not slang. Keep it friendly and brief.'
    },
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

  const embed = makeEmbed(
    `🏅 Badges for ${message.author.displayName}`,
    roles || 'No badges yet! Participate to earn badges! 🔮\n\n' +
    '**How to earn:**\n' +
    '🔮 Spirit Seeker — join the server\n' +
    '🏆 Contest Champion — win a trivia contest\n' +
    '💎 VIP Keeper — make a purchase from the shop\n' +
    '⭐ Spirit Elder — long time active member'
  );
  message.channel.send({ embeds: [embed] });
}

// ─── HELP ────────────────────────────────────────────────
async function handleHelp(message) {
  const embed = makeEmbed(
    '🔮 Soul Harbor Commands',
    '`!tarot` — Get a 3-card tarot reading\n' +
    '`!ghost` — Hear a ghost story from the shadow realm\n' +
    '`!trivia` — Start a contest to win a discount code\n' +
    '`!horoscope [sign]` — Get your daily horoscope\n' +
    '`!spirit [name]` — Learn about any spirit or entity\n' +
    '`!badges` — See your earned badges\n' +
    '`!help` — Show this menu\n\n' +
    '💬 Or just chat with me directly in #soul-harbor-chat!\n\n' +
    '🛍️ Shop: **thepaganshoponline.com**'
  );
  message.channel.send({ embeds: [embed] });
}

// ─── SCHEDULED DAILY TASKS ───────────────────────────────
function scheduleDailyTasks() {
  const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
  if (!guild) return;

  // Daily ghost story — 8pm every day
  cron.schedule('0 20 * * *', async () => {
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
  cron.schedule('0 9 * * *', async () => {
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
  cron.schedule('0 18 * * *', async () => {
    const channel = getChannel(guild, CONFIG.CHANNELS.TRIVIA);
    if (!channel) return;

    const result = await askGPT([
      { role: 'system', content: SPIRIT_SYSTEM_PROMPT },
      { role: 'user', content: 'Generate a trivia question about spirits, paranormal, or metaphysical topics. Format EXACTLY as:\nQUESTION: [question]\nANSWER: [short answer]' }
    ], 150);

    if (!result) return;

    const qMatch = result.match(/QUESTION:\s*(.+)/i);
    const aMatch = result.match(/ANSWER:\s*(.+)/i);
    if (!qMatch || !aMatch) return;

    const question = qMatch[1].trim();
    const answer = aMatch[1].trim();

    triviaActive.set(channel.id, { answer, winnerId: null });

    const embed = makeEmbed(
      '🏆 Daily Spirit Trivia!',
      `**${question}**\n\n` +
      `First correct answer wins a **${CONFIG.COUPONS.DISCOUNT_PERCENT}% discount code**! 🎁\n\n` +
      `⏱️ You have 2 minutes!`,
      0xFFD700
    );
    channel.send({ embeds: [embed] });

    setTimeout(() => {
      if (triviaActive.has(channel.id) && !triviaActive.get(channel.id).winnerId) {
        triviaActive.delete(channel.id);
        const expEmbed = makeEmbed('⏱️ Time\'s Up!', `Nobody answered! The answer was: **${answer}**\n\nNew contest tomorrow! 🔮`);
        channel.send({ embeds: [expEmbed] });
      }
    }, 120000);
  });

  console.log('✅ Daily tasks scheduled');
}

// ─── LOGIN ───────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
