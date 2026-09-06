# VEXA AI Companion

Backend VEXA V2 untuk chat AI pribadi Bang John.

## Endpoint

- `GET /health` — cek status backend
- `POST /api/chat` — kirim pesan ke VEXA

Contoh body:

```json
{
  "message": "Bantu saya susun rencana kerja hari ini",
  "history": []
}
```

## Environment Variables

Atur di Railway, jangan simpan API key di GitHub:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `ALLOWED_ORIGIN=https://rainbow-alfajores-f0f29a.netlify.app`

Railway otomatis menyediakan `PORT`.

## Jalankan lokal

```bash
npm install
npm start
```

## Arsitektur V2

Netlify PWA → Railway backend → AI model.

Tahap berikutnya: sambungkan frontend VEXA ke endpoint `/api/chat`, lalu tambahkan routing ke Tom, Maya, dan Karmila.
