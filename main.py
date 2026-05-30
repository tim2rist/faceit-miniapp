import logging
import aiohttp
import os
from aiogram import Bot, Dispatcher, types
from aiogram.filters import Command, CommandObject
from aiogram.utils.keyboard import InlineKeyboardBuilder
 
# --- ВСТАВЬ СВОИ ДАННЫЕ ТУТ ---
BOT_TOKEN = os.getenv("TELEGRAM_TOKEN", "YOUR_TELEGRAM_TOKEN_HERE")
FACEIT_API_KEY = os.getenv("FACEIT_API_KEY", "YOUR_FACEIT_API_KEY_HERE")
MINI_APP_URL = "https://tim2rist.github.io/faceit-miniapp/"
# ------------------------------

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

def get_flag_emoji(country_code):
    if not country_code: return "🌐"
    return "".join(chr(127397 + ord(c.upper())) for c in country_code)

async def get_full_stats(nickname):
    headers = {"Authorization": f"Bearer {FACEIT_API_KEY}"}
    async with aiohttp.ClientSession() as session:
        player_url = f"https://open.faceit.com/data/v4/players?nickname={nickname}"
        async with session.get(player_url, headers=headers) as res_player:
            if res_player.status != 200:
                return None
            player_data = await res_player.json()
        
        player_id = player_data.get("player_id")
        stats_url = f"https://open.faceit.com/data/v4/players/{player_id}/stats/cs2"
        async with session.get(stats_url, headers=headers) as res_stats:
            stats_data = await res_stats.json() if res_stats.status == 200 else {}

    lifetime = stats_data.get("lifetime", {})
    recent_results = [("🟢 W" if r == "1" else "🔴 L") for r in lifetime.get("Recent Results", [])]
    
    return {
        "nickname": player_data.get("nickname"),
        "flag": get_flag_emoji(player_data.get("country")),
        "elo": player_data.get("games", {}).get("cs2", {}).get("faceit_elo", "N/A"),
        "lvl": player_data.get("games", {}).get("cs2", {}).get("skill_level", "N/A"),
        "avatar": player_data.get("avatar"),
        "id": player_id,
        "kd": lifetime.get("Average K/D Ratio", "N/A"),
        "wr": lifetime.get("Win Rate %", "N/A"),
        "hs": lifetime.get("Average Headshots %", "N/A"),
        "matches": lifetime.get("Matches", "N/A"),
        "recent": " | ".join(recent_results[:5])
    }

@dp.message(Command("start"))
async def start_cmd(message: types.Message):
    await message.answer(
        "👋 **Welcome, Champion!**\n\n"
        "Отправь команду `/stats <никнейм>` для получения подробной аналитики!",
        parse_mode="Markdown"
    )

@dp.message(Command("stats"))
async def show_stats(message: types.Message, command: CommandObject):
    if not command.args:
        await message.answer("❌ Укажите никнейм. Пример: `/stats s1mple`", parse_mode="Markdown")
        return

    nickname = command.args.strip()
    data = await get_full_stats(nickname)

    if data:
        text = (
            f"👤 **ИГРОК: {data['nickname']}** {data['flag']}\n"
            f"⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n"
            f"📊 **ОСНОВНОЕ**\n"
            f"┣ 🏆 Уровень: `{data['lvl']}`\n"
            f"┣ ⚡️ Elo: `{data['elo']}`\n"
            f"┗ 🎮 Матчей: `{data['matches']}`\n\n"
            f"📈 **CS2 STATS**\n"
            f"┣ K/D: `{data['kd']}`\n"
            f"┣ Winrate: `{data['wr']}%`\n"
            f"┗ Headshots: `{data['hs']}%`\n\n"
            f"🕒 **ПОСЛЕДНИЕ ИГРЫ**\n"
            f"`{data['recent'] if data['recent'] else 'Нет данных'}`\n"
            f"⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n"
            f"🤖 **AI ВЕРДИКТ:**\n"
            f"_Аналитика доступна в приложении по кнопке ниже._"
        )
        
        builder = InlineKeyboardBuilder()
        app_url = f"{MINI_APP_URL}?id={data['id']}"
        
        if message.chat.type == "private":
            builder.row(types.InlineKeyboardButton(text="🚀 AI АНАЛИТИКА", web_app=types.WebAppInfo(url=app_url)))
        else:
            builder.row(types.InlineKeyboardButton(text="🚀 AI АНАЛИТИКА", url=app_url))
            builder.row(types.InlineKeyboardButton(text="💬 НАПИСАТЬ В ЛС", url=f"https://t.me/{(await bot.get_me()).username}"))

        if data['avatar']:
            await message.answer_photo(data['avatar'], caption=text, parse_mode="Markdown", reply_markup=builder.as_markup())
        else:
            await message.answer(text, parse_mode="Markdown", reply_markup=builder.as_markup())
    else:
        await message.answer(f"❌ Игрок **{nickname}** не найден.", parse_mode="Markdown")

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    dp.run_polling(bot)