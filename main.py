import logging
import aiohttp 
from aiogram import Bot, Dispatcher, types
from aiogram.filters import Command, CommandObject 
from aiogram.utils.keyboard import InlineKeyboardBuilder
 
# --- ВСТАВЬ СВОИ ДАННЫЕ ТУТ ---
BOT_TOKEN = "8623943648:AAFhY9PCeKQ30tugj9_G9bnf6MjJuiolrRg"
FACEIT_API_KEY = "a83d1a7f-f3cf-4df2-949e-ad5d650a7d45"
MINI_APP_URL = "https://tim2rist.github.io/faceit-miniapp/"
# ------------------------------

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

@dp.message(Command("start"))
async def start_cmd(message: types.Message):
    await message.answer(
        "👋 **Welcome, Champion!**\n\n"
        "I'm here to help you analyze your FACEIT performance with AI.\n\n"
        "⌨️ **Отправь команду /stats <никнейм>** для получения статистики!",
        parse_mode="Markdown"
    )

def get_flag_emoji(country_code):
    if not country_code: return "🌐"
    return "".join(chr(127397 + ord(c.upper())) for c in country_code)

# Сделали функцию асинхронной
async def get_full_stats(nickname):
    headers = {"Authorization": f"Bearer {FACEIT_API_KEY}"}
    player_url = f"https://open.faceit.com/data/v4/players?nickname={nickname}"
    
    # Используем aiohttp для неблокирующих запросов
    async with aiohttp.ClientSession() as session:
        async with session.get(player_url, headers=headers) as res_player:
            if res_player.status != 200: 
                return None
            player_data = await res_player.json()

    player_id = player_data.get("player_id")
    elo = player_data.get("games", {}).get("cs2", {}).get("faceit_elo", "N/A")
    lvl = player_data.get("games", {}).get("cs2", {}).get("skill_level", "N/A")

    return {
        "nickname": player_data.get("nickname"),
        "flag": get_flag_emoji(player_data.get("country")),
        "elo": elo,
        "lvl": lvl,
        "avatar": player_data.get("avatar"),
        "id": player_id
    }

# Теперь реагируем ТОЛЬКО на команду /stats (и в личке, и в беседах)
@dp.message(Command("stats"))
async def show_stats(message: types.Message, command: CommandObject):
    # Если никнейм не передали (просто написали /stats)
    if not command.args:
        await message.answer("❌ Пожалуйста, укажите никнейм. Пример: `/stats s1mple`", parse_mode="Markdown")
        return

    nickname = command.args.strip()
    # Так как функция теперь асинхронная, используем await
    data = await get_full_stats(nickname)

    if data:
        text = (f"{data['flag']} **Игрок: {data['nickname']}**\n"
                f"📊 Elo: {data['elo']} (Lvl {data['lvl']})")
        
        builder = InlineKeyboardBuilder()
        builder.row(types.InlineKeyboardButton(
            text="🚀 Открыть AI Аналитику", 
            web_app=types.WebAppInfo(url=f"{MINI_APP_URL}?id={data['id']}"))
        )

        if data['avatar']:
            await message.answer_photo(data['avatar'], caption=text, parse_mode="Markdown", reply_markup=builder.as_markup())
        else:
            await message.answer(text, parse_mode="Markdown", reply_markup=builder.as_markup())
    else:
        await message.answer(f"❌ Игрок **{nickname}** не найден.", parse_mode="Markdown")

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    dp.run_polling(bot)