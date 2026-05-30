import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import {
  saveUser,
  getUserByTelegramId,
  saveChat,
  deleteChat,
  deleteUserByNickname
} from './database.js';
import {
  getPlayerProfile,
  getPlayerLast20MatchesStats
} from './faceitApi.js';
import { setupCron, getCurrentTop, getSessionSummary, triggerDailyBroadcast } from './cron.js';

dotenv.config();

const token = process.env.TELEGRAM_TOKEN;
if (!token || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.warn('WARNING: TELEGRAM_TOKEN is not set or has dummy value in .env');
}

const bot = new Telegraf(token);

// Register the daily leaderboard cron job
setupCron(bot);

// Helper to extract argument from message text
function getCommandArg(text) {
  const parts = text.split(/\s+/);
  return parts.slice(1).join(' ').trim();
}

// Helper to escape HTML characters (to prevent parse entity errors with underscores)
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Format stats message for display using HTML
function formatStatsMessage(stats) {
  const safeNickname = escapeHtml(stats.nickname);
  return `<b>${safeNickname}</b> | <code>${stats.elo} Elo</code> | <code>${stats.avgKills} Kills</code> | <code>${stats.avgKd} KD</code> | <code>${stats.winrate}% WR</code>`;
}

// /start and /help command
bot.start((ctx) => {
  const welcomeText = `👋 <b>Welcome to the Faceit CS2 Tracker Bot!</b>\n\n` +
    `Here are the available commands:\n` +
    `┣ <code>/link &lt;nickname&gt;</code> - Link your Telegram account to a Faceit account\n` +
    `┣ <code>/me</code> - Show CS2 stats for your linked Faceit account\n` +
    `┣ <code>/find &lt;nickname&gt;</code> - Find and display CS2 stats for any Faceit player\n` +
    `┣ <code>/top</code> - Show the overall Hall of Fame in this chat (ranked by current Elo)\n` +
    `┣ <code>/today</code> - Instantly request Today's Session Summary in this chat\n` +
    `┣ <code>/yesterday</code> - Instantly request Yesterday's Session Summary in this chat\n` +
    `┗ <code>/track</code> - Register this chat for the automatic <b>Daily Session Summary</b> (23:59 PM daily)\n\n` +
    `<i>Note:</i> Stats are computed across the last 20 matches.`;
  
  ctx.reply(welcomeText, { parse_mode: 'HTML' });
});

bot.help((ctx) => {
  const helpText = `🔧 <b>Commands List:</b>\n` +
    `┣ <code>/link &lt;nickname&gt;</code> - Connect your Telegram ID with your Faceit nickname\n` +
    `┣ <code>/me</code> - Show statistics of your linked account\n` +
    `┣ <code>/find &lt;nickname&gt;</code> - Look up stats for a specific player\n` +
    `┣ <code>/top</code> - Show overall Hall of Fame ranked by current Elo\n` +
    `┣ <code>/today</code> - Instantly generate Today's Session Summary\n` +
    `┣ <code>/yesterday</code> - Instantly generate Yesterday's Session Summary\n` +
    `┣ <code>/track</code> - Save this chat for automatic daily reports at 23:59 PM\n` +
    `┗ <code>/untrack</code> - Stop automatic daily reports in this chat`;
  ctx.reply(helpText, { parse_mode: 'HTML' });
});

// /link <nickname>
bot.command('link', async (ctx) => {
  const nickname = getCommandArg(ctx.message.text);
  
  if (!nickname) {
    return ctx.reply('❌ Please specify a Faceit nickname.\nExample: <code>/link s1mple</code>', { parse_mode: 'HTML' });
  }

  try {
    await ctx.sendChatAction('typing');
    const profile = await getPlayerProfile(nickname);
    
    if (!profile) {
      return ctx.reply(`❌ Player <b>${escapeHtml(nickname)}</b> not found on Faceit.`, { parse_mode: 'HTML' });
    }

    const playerId = profile.player_id;
    const resolvedNickname = profile.nickname; // ensure correct casing
    const currentElo = profile.games?.cs2?.faceit_elo || null;

    saveUser(ctx.from.id, resolvedNickname, playerId, currentElo);

    let replyMsg = `✅ Successfully linked your Telegram to Faceit account <b>${escapeHtml(resolvedNickname)}</b>!\n`;
    if (currentElo) {
      replyMsg += `🏆 Current Elo: <code>${currentElo}</code>`;
    }
    ctx.reply(replyMsg, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error in /link command:', error);
    ctx.reply('❌ An error occurred while linking your account. Please try again later.');
  }
});

// /find <nickname>
bot.command('find', async (ctx) => {
  const nickname = getCommandArg(ctx.message.text);
  
  if (!nickname) {
    return ctx.reply('❌ Please specify a Faceit nickname.\nExample: <code>/find s1mple</code>', { parse_mode: 'HTML' });
  }

  try {
    await ctx.sendChatAction('typing');
    const profile = await getPlayerProfile(nickname);
    
    if (!profile) {
      return ctx.reply(`❌ Player <b>${escapeHtml(nickname)}</b> not found on Faceit.`, { parse_mode: 'HTML' });
    }

    const stats = await getPlayerLast20MatchesStats(profile.player_id);
    const text = formatStatsMessage(stats);

    if (stats.avatar && ctx.chat.type === 'private') {
      await ctx.replyWithPhoto(stats.avatar, { caption: text, parse_mode: 'HTML' });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML' });
    }
  } catch (error) {
    console.error('Error in /find command:', error);
    ctx.reply('❌ An error occurred while fetching player statistics. Please try again.');
  }
});

// /me
bot.command('me', async (ctx) => {
  try {
    const user = getUserByTelegramId(ctx.from.id);
    
    if (!user) {
      return ctx.reply('❌ You have not linked your Faceit account.\nUse <code>/link &lt;nickname&gt;</code> first.', { parse_mode: 'HTML' });
    }

    await ctx.sendChatAction('typing');
    const stats = await getPlayerLast20MatchesStats(user.faceit_player_id);
    const text = formatStatsMessage(stats);

    if (stats.avatar && ctx.chat.type === 'private') {
      await ctx.replyWithPhoto(stats.avatar, { caption: text, parse_mode: 'HTML' });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML' });
    }
  } catch (error) {
    console.error('Error in /me command:', error);
    ctx.reply('❌ An error occurred while fetching your stats. Please try again.');
  }
});

// /track
bot.command('track', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('❌ This command can only be used inside group chats.');
  }
  
  try {
    const chatId = ctx.chat.id;
    saveChat(chatId);
    ctx.reply('✅ This chat is now registered for the <b>Daily Session Summary</b> reports!\nReports will be posted here every day at <b>23:59 PM</b>.', { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error in /track command:', error);
    ctx.reply('❌ Failed to register this chat for daily reports.');
  }
});

// /untrack
bot.command('untrack', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('❌ This command can only be used inside group chats.');
  }
  
  try {
    const chatId = ctx.chat.id;
    deleteChat(chatId);
    ctx.reply('❌ This chat has been unregistered from the <b>Daily Session Summary</b> reports.', { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error in /untrack command:', error);
    ctx.reply('❌ Failed to unregister this chat.');
  }
});

// /top
bot.command('top', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('❌ This command can only be used inside group chats.');
  }
  
  try {
    await ctx.sendChatAction('typing');
    // Generate Hall of Fame (ranked by current Elo, based on last 20 matches stats)
    const leaderboardMessage = await getCurrentTop(ctx.telegram, ctx.chat.id);
    await ctx.reply(leaderboardMessage, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error in /top command:', error);
    ctx.reply('❌ An error occurred while generating the Hall of Fame. Please try again.');
  }
});

// /today
bot.command('today', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('❌ This command can only be used inside group chats.');
  }
  
  try {
    await ctx.sendChatAction('typing');
    // Generate Today's Session Summary (dayOffset = 0)
    const leaderboardMessage = await getSessionSummary(ctx.telegram, ctx.chat.id, 0);
    await ctx.reply(leaderboardMessage, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error in /today command:', error);
    ctx.reply('❌ An error occurred while generating today\'s summary. Please try again.');
  }
});

// /yesterday
bot.command('yesterday', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('❌ This command can only be used inside group chats.');
  }
  
  try {
    await ctx.sendChatAction('typing');
    // Generate Yesterday's Session Summary (dayOffset = 1)
    const leaderboardMessage = await getSessionSummary(ctx.telegram, ctx.chat.id, 1);
    await ctx.reply(leaderboardMessage, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error in /yesterday command:', error);
    ctx.reply('❌ An error occurred while generating yesterday\'s summary. Please try again.');
  }
});

// Helper to verify if sender is an admin (user ID listed in process.env.ADMIN_IDS)
function isAdmin(ctx) {
  const adminIdsEnv = process.env.ADMIN_IDS || '';
  const adminIds = adminIdsEnv.split(',').map(id => id.trim()).filter(Boolean);
  const senderId = String(ctx.from?.id);
  return adminIds.includes(senderId);
}

// /admin_help (Admin Only)
bot.command('admin_help', async (ctx) => {
  if (!isAdmin(ctx)) return; // Silently ignore if not admin
  const helpText = `👑 <b>Admin Commands List:</b>\n` +
    `┣ <code>/admin_help</code> - Show this list of admin commands\n` +
    `┣ <code>/force_summary</code> - Manually trigger the daily 23:59 summary broadcast\n` +
    `┗ <code>/remove_player &lt;nickname&gt;</code> - Delete a player from the SQLite database`;
  ctx.reply(helpText, { parse_mode: 'HTML' });
});

// /force_summary (Admin Only)
bot.command('force_summary', async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    await ctx.reply('⏳ Starting manual force summary broadcast to all tracked chats...');
    const successfulChats = await triggerDailyBroadcast(ctx.telegram);
    
    if (successfulChats.length === 0) {
      await ctx.reply('✅ Force summary completed. Sent to 0 chats.');
      return;
    }

    let reportMsg = `✅ <b>Force summary completed.</b> Sent to ${successfulChats.length} chats:\n`;
    successfulChats.forEach(chat => {
      reportMsg += `• <b>${escapeHtml(chat.name)}</b> (ID: <code>${chat.id}</code>)\n`;
    });
    await ctx.reply(reportMsg, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Error in /force_summary:', err);
    await ctx.reply('❌ Failed to run force summary.');
  }
});

// /remove_player <nickname> (Admin Only)
bot.command('remove_player', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const nickname = getCommandArg(ctx.message.text);
  if (!nickname) {
    return ctx.reply('❌ Please specify a Faceit nickname.\nExample: <code>/remove_player s1mple</code>', { parse_mode: 'HTML' });
  }

  try {
    const deletedCount = deleteUserByNickname(nickname);
    if (deletedCount > 0) {
      ctx.reply(`✅ Player <b>${escapeHtml(nickname)}</b> successfully removed from the database.`, { parse_mode: 'HTML' });
    } else {
      ctx.reply(`❌ Player <b>${escapeHtml(nickname)}</b> not found in the database.`, { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('Error in /remove_player:', err);
    ctx.reply('❌ Failed to remove player from database.');
  }
});

// Start the bot (Telegraf handles this via Long Polling)
// Note: As per user instructions, we will not automatically invoke bot.launch() here to prevent the process from hanging when imported or unless run directly.
// But we'll export launch function and call it if run directly.

export function launchBot() {
  bot.launch()
    .then(() => console.log('🚀 Telegram Bot is running via Long Polling...'))
    .catch((err) => console.error('Failed to start Telegram Bot:', err));
}

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// If this file is run directly (or is the entrypoint), launch the bot
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bot.js')) {
  launchBot();
}

export default bot;
