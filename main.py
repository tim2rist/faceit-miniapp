
import logging
import requests
from aiogram import Bot, Dispatcher, types
from aiogram.utils.keyboard import InlineKeyboardBuilder

# --- ВСТАВЬ СВОИ ДАННЫЕ ТУТ ---
BOT_TOKEN = "8623943648:AAFhY9PCeKQ30tugj9_G9bnf6MjJuiolrRg"
FACEIT_API_KEY = "a83d1a7f-f3cf-4df2-949e-ad5d650a7d45"
MINI_APP_URL = "https://tim2rist.github.io/faceit-miniapp/"
# ------------------------------

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

def get_flag_emoji(country_code):
    if not country_code: return "🌐"
    return "".join(chr(127397 + ord(c.upper())) for c in country_code)

def get_full_stats(nickname):
    headers = {"Authorization": f"Bearer {FACEIT_API_KEY}"}
    player_url = f"https://open.faceit.com/data/v4/players?nickname={nickname}"
    res_player = requests.get(player_url, headers=headers)
    
    if res_player.status_code != 200: return None

    player_data = res_player.json()
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

@dp.message()
async def show_stats(message: types.Message):
    if message.text.startswith('/'): return 
    
    nickname = message.text.strip()
    data = get_full_stats(nickname)

    if data:
        text = (f"{data['flag']} **Игрок: {data['nickname']}**\n"
                f"📊 Elo: {data['elo']} (Lvl {data['lvl']})")
        
        builder = InlineKeyboardBuilder()
        # Передаем ID игрока в Mini App через параметр ?id=
        builder.row(types.InlineKeyboardButton(
            text="🚀 Открыть AI Аналитику", 
            web_app=types.WebAppInfo(url=f"{MINI_APP_URL}?id={data['id']}"))
        )

        if data['avatar']:
            await message.answer_photo(data['avatar'], caption=text, parse_mode="Markdown", reply_markup=builder.as_markup())
        else:
            await message.answer(text, parse_mode="Markdown", reply_markup=builder.as_markup())
    else:
        await message.answer("❌ Игрок не найден.")

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    dp.run_polling(bot)