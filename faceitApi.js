import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const FACEIT_API_KEY = process.env.FACEIT_API_KEY;
const BASE_URL = 'https://open.faceit.com/data/v4';

const faceitClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${FACEIT_API_KEY}`
  }
});

/**
 * Fetch player profile by nickname
 * @param {string} nickname 
 * @returns {Promise<Object>} Player details
 */
export async function getPlayerProfile(nickname) {
  try {
    const response = await faceitClient.get('/players', {
      params: { nickname }
    });
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch player profile for ${nickname}: ${error.message}`);
  }
}

/**
 * Fetch player profile by ID
 * @param {string} playerId 
 * @returns {Promise<Object>} Player details
 */
export async function getPlayerProfileById(playerId) {
  try {
    const response = await faceitClient.get(`/players/${playerId}`);
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch player profile for ID ${playerId}: ${error.message}`);
  }
}

/**
 * Fetch player match history
 * @param {string} playerId 
 * @param {number} limit 
 * @param {number} fromTimestamp (Unix seconds)
 * @returns {Promise<Array>} List of matches
 */
export async function getPlayerMatches(playerId, limit = 20, fromTimestamp = null) {
  try {
    const params = {
      game: 'cs2',
      limit
    };
    if (fromTimestamp) {
      params.from = fromTimestamp;
    }
    const response = await faceitClient.get(`/players/${playerId}/history`, { params });
    return response.data.items || [];
  } catch (error) {
    console.error(`Error fetching history for player ${playerId}:`, error.message);
    return [];
  }
}

/**
 * Fetch specific match stats
 * @param {string} matchId 
 * @returns {Promise<Object>} Match stats
 */
export async function getMatchStats(matchId) {
  try {
    const response = await faceitClient.get(`/matches/${matchId}/stats`);
    return response.data;
  } catch (error) {
    console.error(`Error fetching stats for match ${matchId}:`, error.message);
    return null;
  }
}

/**
 * Fetch specific match details (includes winProbability and rosters)
 * @param {string} matchId 
 * @returns {Promise<Object>} Match details
 */
export async function getMatchDetails(matchId) {
  try {
    const response = await faceitClient.get(`/matches/${matchId}`);
    return response.data;
  } catch (error) {
    console.error(`Error fetching details for match ${matchId}:`, error.message);
    return null;
  }
}

/**
 * Extract player performance from match stats
 * @param {Object} matchStats 
 * @param {string} playerId 
 * @returns {Object|null} { kills, kd, isWin }
 */
export function extractPlayerPerformance(matchStats, playerId) {
  if (!matchStats || !matchStats.rounds || matchStats.rounds.length === 0) {
    return null;
  }
  
  // CS2 is usually best-of-1, but can have multiple rounds. We'll aggregate or take the first.
  for (const round of matchStats.rounds) {
    if (!round.teams) continue;
    for (const team of round.teams) {
      if (!team.players) continue;
      const player = team.players.find(p => p.player_id === playerId);
      if (player && player.player_stats) {
        // Result: "1" usually means Win, "0" means Loss.
        // We'll also check if the team's team_stats.TeamWin is "1" or true.
        const isWin = player.player_stats.Result === '1' || 
                      player.player_stats.Win === '1' || 
                      (team.team_stats && team.team_stats.TeamWin === '1');
        
        return {
          kills: parseInt(player.player_stats.Kills, 10) || 0,
          kd: parseFloat(player.player_stats['K/D Ratio']) || 0,
          isWin: !!isWin
        };
      }
    }
  }
  
  return null;
}

/**
 * Helper to run async tasks in parallel with a concurrency limit
 */
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

/**
 * Fetch and aggregate statistics for a player's last 20 matches
 * @param {string} playerId 
 * @returns {Promise<Object>} Stats summary { elo, lvl, avgKd, avgKills, winrate, recentMatchesCount }
 */
export async function getPlayerLast20MatchesStats(playerId) {
  // 1. Get current profile to get current Elo and skill level
  const profile = await getPlayerProfileById(playerId);
  if (!profile) {
    throw new Error(`Player not found`);
  }

  const elo = profile.games?.cs2?.faceit_elo ?? 'N/A';
  const lvl = profile.games?.cs2?.skill_level ?? 'N/A';
  const avatar = profile.avatar || '';

  // 2. Fetch last 20 matches
  const matches = await getPlayerMatches(playerId, 20);
  if (matches.length === 0) {
    return {
      nickname: profile.nickname,
      elo,
      lvl,
      avatar,
      avgKd: 0,
      avgKills: 0,
      winrate: 0,
      recentMatchesCount: 0
    };
  }

  // 3. Fetch match details in parallel with concurrency limit
  const results = await pMap(matches, (match) => getMatchStats(match.match_id), 5);

  let totalKills = 0;
  let totalKd = 0;
  let wins = 0;
  let validMatchesCount = 0;

  for (let i = 0; i < results.length; i++) {
    const stats = results[i];
    if (!stats) continue;
    
    const performance = extractPlayerPerformance(stats, playerId);
    if (performance) {
      totalKills += performance.kills;
      totalKd += performance.kd;
      if (performance.isWin) {
        wins++;
      }
      validMatchesCount++;
    }
  }

  const avgKd = validMatchesCount > 0 ? (totalKd / validMatchesCount).toFixed(2) : '0.00';
  const avgKills = validMatchesCount > 0 ? (totalKills / validMatchesCount).toFixed(1) : '0.0';
  const winrate = validMatchesCount > 0 ? Math.round((wins / validMatchesCount) * 100) : 0;

  return {
    nickname: profile.nickname,
    elo,
    lvl,
    avatar,
    avgKd,
    avgKills,
    winrate,
    recentMatchesCount: validMatchesCount
  };
}
