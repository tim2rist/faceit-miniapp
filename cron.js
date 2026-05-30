import cron from 'node-cron';
import {
  getAllUsers,
  shiftDayStartElo,
  getAllChats,
  saveMatchElo,
  getMatchElo,
  getLatestMatchEloBefore,
  getLatestMatchEloBetween
} from './database.js';
import {
  getPlayerProfileById,
  getPlayerMatches,
  getMatchStats,
  getMatchDetails,
  extractPlayerPerformance,
  getPlayerLast20MatchesStats
} from './faceitApi.js';

// Helper to run async tasks in parallel with a concurrency limit
async function pMap(array, mapper, concurrency = 2) {
  const results = [];
  const copy = [...array];
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  async function worker() {
    while (copy.length > 0) {
      const index = array.length - copy.length;
      const item = copy.shift();
      results[index] = await mapper(item);
      await delay(100); // Pace requests to respect Faceit rate limits
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, array.length) }, worker);
  await Promise.all(workers);
  return results;
}

// Helper to escape HTML characters
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Check if a user is currently a member of the group chat
 */
async function isUserMemberOfChat(telegram, chatId, telegramId) {
  try {
    const member = await telegram.getChatMember(chatId, telegramId);
    return ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
  } catch (err) {
    return false;
  }
}

/**
 * Ranks players based on current Elo (Hall of Fame)
 */
function rankHallOfFame(players) {
  return [...players].sort((a, b) => {
    const eloA = a.elo === 'N/A' ? 0 : Number(a.elo);
    const eloB = b.elo === 'N/A' ? 0 : Number(b.elo);
    return eloB - eloA;
  });
}

/**
 * Ranks players based on:
 * 1. Elo gain (descending)
 * 2. Average K/D (descending)
 * 3. Average Kills (descending)
 */
function rankDailySession(players) {
  return [...players].sort((a, b) => {
    // 1. Prioritize active players (matchesCount > 0) over inactive ones (matchesCount === 0)
    const activeA = a.matchesCount > 0 ? 1 : 0;
    const activeB = b.matchesCount > 0 ? 1 : 0;
    if (activeA !== activeB) {
      return activeB - activeA; // Active players first
    }
    
    // 2. Sort active players by Elo Gain descending
    if (activeA === 1) {
      if (b.eloGain !== a.eloGain) {
        return b.eloGain - a.eloGain;
      }
      if (b.avgKdNum !== a.avgKdNum) {
        return b.avgKdNum - a.avgKdNum;
      }
      return b.avgKillsNum - a.avgKillsNum;
    }
    
    // 3. For inactive players (0 matches, 0 elo change), sort them by overall current Elo descending
    const eloA = a.currentElo === 'N/A' ? 0 : Number(a.currentElo);
    const eloB = b.currentElo === 'N/A' ? 0 : Number(b.currentElo);
    return eloB - eloA;
  });
}

/**
 * Formats the Hall of Fame (/top) message
 */
export function formatHallOfFame(rankedPlayers) {
  let message = `<b>FACEIT HALL OF FAME</b>\n<i>Overall Stats (Last 20 Games)</i>\n\n`;

  if (rankedPlayers.length === 0) {
    message += `No registered chat members found. Use <code>/link</code> to join!`;
    return message;
  }

  rankedPlayers.forEach((player, index) => {
    const rank = index + 1;
    let rankPrefix = `${rank}.`;
    if (rank === 1) rankPrefix = '🥇';
    else if (rank === 2) rankPrefix = '🥈';
    else if (rank === 3) rankPrefix = '🥉';

    const playerNick = escapeHtml(player.nickname);
    message += `${rankPrefix} <b>${playerNick}</b> — <code>${player.elo}</code> | <code>${player.avgKills} | ${player.avgKd}</code>\n`;
  });

  return message.trim();
}

/**
 * Formats the daily session summary leaderboard message
 */
export function formatDailySession(rankedPlayers, titlePrefix, dateStr) {
  let message = `<b>${titlePrefix} SESSION SUMMARY</b>\nSession Date: ${dateStr}\n\n`;

  const activePlayers = rankedPlayers.filter(p => p.matchesCount > 0);

  if (activePlayers.length === 0) {
    message += `No registered chat members played CS2 matches ${titlePrefix === "TODAY'S" ? "today" : "yesterday"}.`;
  } else {
    activePlayers.forEach((player, index) => {
      const eloSign = player.eloGain >= 0 ? '+' : '';
      const rank = index + 1;
      const playerNick = escapeHtml(player.nickname);
      const matchesText = player.matchesCount === 1 ? 'match' : 'matches';
      message += `${rank}. <b>${playerNick}</b> | <code>${player.currentElo}</code> | <code>${eloSign}${player.eloGain} Elo</code> | <code>${player.matchesCount} ${matchesText}</code>\n`;
    });
  }

  return message.trim();
}

/**
 * 1. Hall of Fame Leaderboard
 * Ranks registered users by current Elo, filtering for members of the specific chat.
 */
export async function getCurrentTop(telegram, chatId) {
  const users = getAllUsers();
  if (users.length === 0) {
    return `No registered users found in the database.`;
  }

  // 1. Check membership in parallel (concurrency 10)
  const memberCheckResults = await pMap(users, async (user) => {
    const isMember = await isUserMemberOfChat(telegram, chatId, user.telegram_id);
    return { user, isMember };
  }, 10);
  const activeMembers = memberCheckResults.filter(r => r.isMember).map(r => r.user);

  const playersData = [];
  
  // 2. Fetch last 20 matches stats in parallel (concurrency 1) to prevent 429
  await pMap(activeMembers, async (user) => {
    try {
      const stats = await getPlayerLast20MatchesStats(user.faceit_player_id);
      playersData.push(stats);
    } catch (error) {
      console.error(`Error fetching Hall of Fame stats for user ${user.faceit_nickname}:`, error.message);
    }
  }, 1);

  const rankedPlayers = rankHallOfFame(playersData);
  return formatHallOfFame(rankedPlayers);
}

/**
 * 2. Session Summary Leaderboard
 * Computes Elo change and compiles matches for a given target day (dayOffset = 0 for today, 1 for yesterday).
 */
export async function getSessionSummary(telegram, chatId, dayOffset = 1) {
  const users = getAllUsers();
  if (users.length === 0) {
    return `No registered users found in the database.`;
  }

  // Target date calculations in local time
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() - dayOffset);

  // 00:00:00 of target day
  const startOfTarget = new Date(targetDate);
  startOfTarget.setHours(0, 0, 0, 0);
  const startTimestamp = Math.floor(startOfTarget.getTime() / 1000);

  // 23:59:59 of target day
  const endOfTarget = new Date(targetDate);
  endOfTarget.setHours(23, 59, 59, 999);
  const endTimestamp = Math.floor(endOfTarget.getTime() / 1000);

  const dateStr = targetDate.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });

  const titlePrefix = dayOffset === 0 ? "TODAY'S" : "DAILY";

  // 1. Check membership in parallel (concurrency 10)
  const memberCheckResults = await pMap(users, async (user) => {
    const isMember = await isUserMemberOfChat(telegram, chatId, user.telegram_id);
    return { user, isMember };
  }, 10);
  const activeMembers = memberCheckResults.filter(r => r.isMember).map(r => r.user);

  const activePlayersData = [];

  // 2. Fetch profiles, matches, and details in parallel (concurrency 2)
  await pMap(activeMembers, async (user) => {
    try {
      // Fetch player's current profile from the official API to get their current Elo
      const profile = await getPlayerProfileById(user.faceit_player_id);
      if (!profile) return;
      
      const currentElo = profile.games?.cs2?.faceit_elo || user.day_start_elo || 0;

      // Fetch last 50 matches and filter for finished matches
      const allMatches = await getPlayerMatches(user.faceit_player_id, 50);
      const finishedMatches = allMatches.filter(m => m.status === 'finished');

      // Optimization: Check if player played today or yesterday
      const hasFutureMatches = finishedMatches.some(m => {
        const t = m.finished_at || m.started_at;
        return t && Number(t) > endTimestamp;
      });
      const hasTargetDayMatches = finishedMatches.some(m => {
        const t = m.finished_at || m.started_at;
        return t && t >= startTimestamp && t <= endTimestamp;
      });

      // If they didn't play on the target day or after it, short-circuit immediately!
      if (!hasFutureMatches && !hasTargetDayMatches) {
        activePlayersData.push({
          nickname: user.faceit_nickname,
          telegramId: user.telegram_id,
          eloGain: 0,
          currentElo,
          matchesCount: 0,
          avgKills: '0.0',
          avgKd: '0.00',
          avgKillsNum: 0,
          avgKdNum: 0
        });
        return;
      }

      let endingElo = currentElo;
      let eloGain = 0;
      let totalKills = 0;
      let totalKd = 0;
      let validMatches = 0;
      const targetDayMatches = [];

      if (finishedMatches.length > 0) {
        // Collect only the matches up to the preceding match (first match older than target day)
        const matchesToProcess = [];
        let precedingMatch = null;

        for (const match of finishedMatches) {
          const matchTime = match.finished_at || match.started_at;
          if (!matchTime) continue;

          matchesToProcess.push(match);

          if (matchTime >= startTimestamp && matchTime <= endTimestamp) {
            targetDayMatches.push(match);
          } else if (matchTime < startTimestamp) {
            precedingMatch = match;
            break; // Baseline match found, no need to go further back in history
          }
        }

        // Fetch details in parallel (concurrency 5) for matchesToProcess
        const matchDetailsList = {};
        const matchChanges = {};

        await pMap(matchesToProcess, async (match) => {
          const details = await getMatchDetails(match.match_id);
          if (details) {
            matchDetailsList[match.match_id] = details;
            
            const isFaction1 = details.teams?.faction1?.roster?.some(p => p.player_id === user.faceit_player_id);
            const playerFaction = isFaction1 ? 'faction1' : 'faction2';
            const isWin = details.results?.winner === playerFaction;
            const winProb = details.teams?.[playerFaction]?.stats?.winProbability ?? 0.5;
            
            const K = isWin ? 42 : 50;
            const actual = isWin ? 1 : 0;
            matchChanges[match.match_id] = Math.round(K * (actual - winProb));
          } else {
            // Fallback if match details fail to load
            const faction1Players = match.teams?.faction1?.players || [];
            const isFaction1 = faction1Players.some(p => p.player_id === user.faceit_player_id);
            const playerFaction = isFaction1 ? 'faction1' : 'faction2';
            const isWinFromHistory = match.results?.winner === playerFaction;
            matchChanges[match.match_id] = isWinFromHistory ? 25 : -25;
          }
        }, 5);

        // Reconstruct Elo rating after each match by walking backward from current Elo
        const matchElos = {};
        const newestMatchId = finishedMatches[0].match_id;
        matchElos[newestMatchId] = currentElo;
        
        // Save newest match Elo to database
        if (currentElo > 0) {
          const newestMatch = finishedMatches[0];
          const finishedAt = newestMatch.finished_at || newestMatch.started_at;
          saveMatchElo(user.faceit_player_id, newestMatchId, currentElo, finishedAt);
        }
        
        for (let i = 1; i < matchesToProcess.length; i++) {
          const currentMatch = matchesToProcess[i];
          const newerMatch = matchesToProcess[i - 1];
          
          const dbElo = getMatchElo(user.faceit_player_id, currentMatch.match_id);
          if (dbElo !== null) {
            matchElos[currentMatch.match_id] = dbElo;
          } else {
            const newerElo = matchElos[newerMatch.match_id];
            const newerChange = matchChanges[newerMatch.match_id] ?? 0;
            matchElos[currentMatch.match_id] = newerElo - newerChange;
          }
        }

        if (targetDayMatches.length > 0) {
          // Fetch stats for kills / KD in parallel (concurrency 5)
          await pMap(targetDayMatches, async (match) => {
            const stats = await getMatchStats(match.match_id);
            const performance = extractPlayerPerformance(stats, user.faceit_player_id);
            if (performance) {
              totalKills += performance.kills;
              totalKd += performance.kd;
              validMatches++;
            }
          }, 5);

          // Calculate estimated net change
          let targetDayNetChange = 0;
          for (const match of targetDayMatches) {
            targetDayNetChange += matchChanges[match.match_id] ?? 0;
          }

          // Ending Elo of target day
          const newestTargetMatchId = targetDayMatches[0].match_id;
          endingElo = matchElos[newestTargetMatchId] ?? currentElo;

          // Determine starting Elo and eloGain
          let startingElo = currentElo;
          if (dayOffset === 0) {
            startingElo = (user.day_start_elo && user.day_start_elo > 0) ? user.day_start_elo : null;
            if (!startingElo) {
              startingElo = precedingMatch ? (matchElos[precedingMatch.match_id] ?? (endingElo - targetDayNetChange)) : (endingElo - targetDayNetChange);
            }
          } else {
            startingElo = precedingMatch ? (matchElos[precedingMatch.match_id] ?? (endingElo - targetDayNetChange)) : (endingElo - targetDayNetChange);
          }
          eloGain = endingElo - startingElo;
        } else {
          // Did not play target day: Ending Elo is either preceding match Elo, or current adjusted for future matches
          if (precedingMatch) {
            endingElo = matchElos[precedingMatch.match_id] ?? getMatchElo(user.faceit_player_id, precedingMatch.match_id) ?? currentElo;
          } else {
            // Subtract future matches from current Elo
            let futureNetElo = 0;
            const futureMatches = finishedMatches.filter(match => {
              const matchTime = match.finished_at || match.started_at;
              return matchTime && Number(matchTime) > endTimestamp;
            });
            for (const match of futureMatches) {
              futureNetElo += matchChanges[match.match_id] ?? 0;
            }
            endingElo = currentElo - futureNetElo;
          }
          eloGain = 0;
        }
      } else {
        endingElo = currentElo;
        eloGain = 0;
      }

      const avgKillsVal = validMatches > 0 ? (totalKills / validMatches) : 0;
      const avgKdVal = validMatches > 0 ? (totalKd / validMatches) : 0;

      activePlayersData.push({
        nickname: user.faceit_nickname,
        telegramId: user.telegram_id,
        eloGain,
        currentElo: endingElo,
        matchesCount: targetDayMatches.length,
        avgKills: avgKillsVal.toFixed(1),
        avgKd: avgKdVal.toFixed(2),
        avgKillsNum: avgKillsVal,
        avgKdNum: avgKdVal
      });
    } catch (error) {
      console.error(`Error processing daily summary stats for user ${user.faceit_nickname}:`, error.message);
    }
  }, 2);

  const rankedPlayers = rankDailySession(activePlayersData);
  return formatDailySession(rankedPlayers, titlePrefix, dateStr);
}

export async function triggerDailyBroadcast(telegram) {
  console.log("⏰ Starting Daily Session Summary broadcast...");
  const chats = getAllChats();
  if (chats.length === 0) {
    console.log('No tracked chats found in the database. Broadcast skipped.');
    return 0;
  }

  let sentCount = 0;
  for (const chat of chats) {
    try {
      const leaderboardMessage = await getSessionSummary(telegram, chat.chat_id, 0);
      await telegram.sendMessage(chat.chat_id, leaderboardMessage, { parse_mode: 'HTML' });
      console.log(`Today's summary successfully sent to chat_id: ${chat.chat_id}`);
      sentCount++;
    } catch (chatError) {
      console.error(`Failed to send summary to chat_id ${chat.chat_id}:`, chatError.message);
    }
  }
  return sentCount;
}

export function setupCron(bot) {
  // 1. Midnight rollover: Runs daily at 00:00 to shift Elo baselines for the new day
  cron.schedule('0 0 * * *', async () => {
    console.log('⏰ Rollover: Setting start-of-day Elo baselines at 00:00...');
    try {
      const users = getAllUsers();
      for (const user of users) {
        try {
          const profile = await getPlayerProfileById(user.faceit_player_id);
          if (profile) {
            const currentElo = profile.games?.cs2?.faceit_elo || null;
            if (currentElo !== null) {
              shiftDayStartElo(user.telegram_id, currentElo);
            }
          }
          await new Promise(resolve => setTimeout(resolve, 150));
        } catch (err) {
          console.error(`Error during rollover for user ${user.faceit_nickname}:`, err.message);
        }
      }
      console.log('⏰ Midnight Elo rollover completed successfully.');
    } catch (error) {
      console.error('Fatal error during midnight Elo rollover:', error);
    }
  });

  // 2. Today's Summary: Runs daily at 23:59 PM (Reports current day's completed session)
  cron.schedule('59 23 * * *', async () => {
    try {
      await triggerDailyBroadcast(bot.telegram);
    } catch (cronError) {
      console.error('Fatal error in daily leaderboard cron job:', cronError);
    }
  });

  console.log("⏰ Today's Leaderboard Cron Job scheduled for 23:59 PM daily.");
  console.log('⏰ Midnight Rollover Cron Job scheduled for 00:00 daily.');
}
