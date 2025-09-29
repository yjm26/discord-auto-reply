# Discord Auto Reply Bot

Bot ini secara otomatis membalas pesan di channel Discord tertentu menggunakan AI Gemini (Google Generative Language API). Bot berjalan di Node.js dan dapat dikonfigurasi melalui file `.env`.

## Fitur

- Membalas pesan secara otomatis di channel Discord yang ditentukan
- Menggunakan AI Gemini (Google) untuk menghasilkan balasan natural
- Log aktivitas bot ke file
- Sistem antrian & rate limit agar tidak spam
- Filter kata terlarang (banned words)
- Mudah dikonfigurasi lewat file `.env`

## Cara Instalasi

1. **Clone repo ini & masuk ke foldernya**
    ```bash
    git clone (https://github.com/yjm26/discord-auto-reply)
    cd discord-auto-reply
    ```

2. **Install dependencies**
    ```bash
    npm install
    ```

3. **Buat file `.env` di root folder, isi seperti berikut:**
    ```
    DISCORD_TOKEN=isi_token_discord_kamu
    TARGET_CHANNEL_ID=isi_channel_id
    GOOGLE_API_KEY=isi_google_gemini_api_key
    ```

4. **Jalankan bot**
    ```bash
    node index.js
    ```

## Konfigurasi

- **DISCORD_TOKEN**: Token akun Discord (bukan bot token, gunakan user token).
- **TARGET_CHANNEL_ID**: ID channel Discord yang ingin diawasi & dibalas.
- **GOOGLE_API_KEY**: API key Gemini (Google Generative Language API).

> **Catatan:**  
> Jangan bagikan token dan API key ke orang lain!

## Log Aktivitas

Semua aktivitas bot akan dicatat di file `bot_activity.log` di folder ini.

## Kustomisasi

- **Banned Words:**  
  Edit array `bannedWords` di `index.js` untuk menambah kata yang ingin difilter.

- **Personality & Style:**  
  Ubah bagian `systemGuidance` dan `fewshot` di fungsi `generateReply()` untuk mengubah gaya balasan bot.

## Stop Bot

Tekan `Ctrl+C` di terminal untuk menghentikan bot dengan aman.

---

**Disclaimer:**  
Gunakan dengan bijak. Bot ini menggunakan user token, yang melanggar ToS Discord jika digunakan untuk spam atau aktivitas otomatisasi berlebihan.
