import logging
import requests
from aiogram import Bot, Dispatcher, types
from aiogram.utils.keyboard import InlineKeyboardBuilder

# --- КОНФИГУРАЦИЯ ---
BOT_TOKEN = "8623943648:AAFhY9PCeKQ30tugj9_G9bnf6MjJuiolrRg"
FACEIT_API_KEY = "a83d1a7f-f3cf-4df2-949e-ad5d650a7d45"

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

# Функция для конвертации кода страны в эмодзи флага (например, 'ru' -> 🇷🇺)
def get_flag_emoji(country_code):
    if not country_code:
        return "🌐"
    return "".join(chr(127397 + ord(c.upper())) for c in country_code)

def get_full_stats(nickname):
    headers = {"Authorization": f"Bearer {FACEIT_API_KEY}"}
    
    # 1. Получаем общие данные игрока
    player_url = f"https://open.faceit.com/data/v4/players?nickname={nickname}"
    res_player = requests.get(player_url, headers=headers)
    
    if res_player.status_code != 200:
        return None

    player_data = res_player.json()
    player_id = player_data.get("player_id")
    
    # Данные из профиля
    country = player_data.get("country", "")
    flag = get_flag_emoji(country)
    avatar = player_data.get("avatar", "")
    elo = player_data.get("games", {}).get("cs2", {}).get("faceit_elo", "N/A")
    lvl = player_data.get("games", {}).get("cs2", {}).get("skill_level", "N/A")

    # 2. Получаем статистику именно по CS2
    stats_url = f"https://open.faceit.com/data/v4/players/{player_id}/stats/cs2"
    res_stats = requests.get(stats_url, headers=headers)
    
    kd, win_rate, matches = "N/A", "N/A", "N/A"
    
    if res_stats.status_code == 200:
        s_data = res_stats.json().get("lifetime", {})
        kd = s_data.get("Average K/D Ratio")
        win_rate = s_data.get("Win Rate %")
        matches = s_data.get("Matches")

    return {
        "nickname": player_data.get("nickname"),
        "flag": flag,
        "elo": elo,
        "lvl": lvl,
        "kd": kd,
        "win_rate": f"{win_rate}%",
        "matches": matches,
        "avatar": avatar,
        "id": player_id
    }

@dp.message()
async def show_stats(message: types.Message):
    nickname = message.text.strip()
    # Игнорируем команды типа /start
    if nickname.startswith('/'): return 

    data = get_full_stats(nickname)

    if data:
        text = (
            f"{data['flag']} **Профиль: {data['nickname']}**\n"
            f"━━━━━━━━━━━━\n"
            f"⭐ **Уровень:** {data['lvl']}\n"
            f"📈 **Elo:** {data['elo']}\n"
            f"🎮 **Матчей:** {data['matches']}\n"
            f"🔫 **Average K/D:** {data['kd']}\n"
            f"🏆 **Win Rate:** {data['win_rate']}\n"
        )
        
        builder = InlineKeyboardBuilder()
        # Ссылка на Mini App (пока просто кнопка)
        builder.row(types.InlineKeyboardButton(
            text="🚀 Открыть Mini App (Детально)", 
            web_app=types.WebAppInfo(url=f"https://your-app-url.vercel.app/?id={data['id']}"))
        )

        # Если есть аватарка, шлем фото, если нет — текст
        if data['avatar']:
            await message.answer_photo(data['avatar'], caption=text, parse_mode="Markdown", reply_markup=builder.as_markup())
        else:
            await message.answer(text, parse_mode="Markdown", reply_markup=builder.as_markup())
    else:
        await message.answer("⚠️ Игрок не найден. Убедись, что ник написан правильно (регистр важен).")

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    dp.run_polling(bot)