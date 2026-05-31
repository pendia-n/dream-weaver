# Mattalk — Tech Stack & UX

## Tech Stack

- **Frontend:** React 19 + React Router 7 + Vite 8 (SPA, client-side rendered)
- **Backend:** Hono 4 on Cloudflare Workers (single worker, API + static file serving via ASSETS binding)
- **DB:** Cloudflare D1 (SQLite) via Drizzle ORM
- **Storage:** Cloudflare R2 (PDF, MP3, MP4 media files)
- **AI LLM:** OpenRouter (11 free models checked in priority order, fallback to paid models per credit tier)
- **AI Image:** Cloudflare Workers AI (flux/phoenix/lucid-origin models per credit tier)
- **TTS:** Cloudflare Workers AI (aura/melotts) or ElevenLabs (balance ≥ 550, ≥20k chars)
- **Auth:** HMAC-SHA256 JWT, HMAC-SHA256 password hashing, optional TOTP (pure Web Crypto, no otpauth library)
- **Payments:** Stripe Checkout (multi-pack cart: 50cr/$10.99, 150cr/$20.99, 500cr/$38.99, 800cr/$40.99)
- **Build:** `pnpm run build` (tsc + vite), Deploy: `npx wrangler deploy`

## UX

- **Auth:** Signup with username (live check) + password (min 7 chars, 1 digit), optional TOTP 2FA, forgot password via TOTP verification
- **Dashboard:** Story list with status badges, balance display (reserves credits for processing stories), empty state CTA
- **New Story Wizard (5 steps):**
  1. Raw input — textarea for story idea/prompt
  2. Duration — 10min or 15min
  3. Type — Script (prose) / Screenplay (dialogue) / Both
  4. Style — Script writers (Shakespeare, Austen, Dickens, etc.) or Play writers (Wilde, Ibsen, Chekhov, Stan Lee, etc.)
  5. Output — filtered by type: Script→PDF only, Play→MP3+MP4 only, Both→all three
- **Story Detail:** Tabs for Script text, Media viewer (PDF/audio/video), Chat room for follow-up
- **Credits:** Balance + cart-style multi-pack purchase (add multiple packs, one Stripe transaction)
- **Settings:** TOTP setup with QR code (scannable), enable/disable, shows username
- **Pipeline Logs:** Debug endpoint `GET /api/story/:id/logs` shows step-by-step pipeline progress from D1

## Credit Economy

- 21cr one-time on signup (non-renewable)
- Script gen: 3cr (10min) / 4cr (15min)
- Play gen: 4cr (10min) / 5cr (15min)
- Both: 4cr (10min) / 4.5cr (15min)
- PDF: 7cr / MP3: 12cr / MP4: 16cr
- Paraphrase: 0cr (free to user)
- Edit re-gen: images + media only (no text gen cost)
- Credits deducted AFTER successful R2 upload, not on enqueue

## Output Type Filtering

- **Script only** → PDF only (storybook with text + images)
- **Play only** → MP3 (audiobook) + MP4 (video slideshow)
- **Both** → PDF + MP3 + MP4

## Model Selection

### LLM (OpenRouter)
- Free models tried first (baidu/cobuddy:free, openrouter/owl-alpha, etc.) — cached 5 min
- Paid fallback per credit tier: <100cr → qwen3-30b/mistral-large, 100-499cr → step-3.5-flash/kimi-k2.5, ≥500cr → nemotron-super/gpt-5.4-nano

### Image (Workers AI)
- <250cr: flux-1-schnell (cover), flux-2-klein-4b (10min), flux-2-dev (15min)
- ≥250cr: phoenix-1.0 (cover), lucid-origin (10min), flux-2-klein-9b (15min)

### TTS
- <250cr: aura-1 / melotts
- 250-549cr: melotts / aura-2-en / ElevenLabs (15min, >10k chars)
- ≥550cr: aura-2-en / melotts / ElevenLabs (≥20k chars)
- melotts uses `{ prompt, lang }` input format; aura uses `{ text }`
- Full text chunked at 5000 chars, audio concatenated (not truncated)

## Pipeline (waitUntil background)

1. Paraphrase LLM: rawInput + writer style → styled prompt
2. Generate LLM: styled prompt → full text with ## Chapter markers
3. Section: parse chapters → chunk paragraphs (max 3 per chapter)
4. Images: Workers AI per chunk → PNG → R2
5. PDF: pdf-lib with text + embedded images → R2
6. TTS: Workers AI or ElevenLabs (chunked) → audio → ID3v2 cover → MP3 → R2
7. MP4: JSON metadata (slides + audio URL) → R2 (client-side MediaRecorder)
8. Deduct credits, update status

### Pipeline Logging
Each step writes to `pipeline_logs` D1 table. LLM output validated (throws if <10 chars).
Debug: `GET /api/story/:id/logs`

## API Endpoints

- `POST /api/auth/signup` — signup (+21cr, returns JWT)
- `POST /api/auth/login` — login (optional totpCode, returns JWT)
- `GET /api/auth/check?username=` — username availability
- `GET /api/auth/me` — current user (id, username, credit_balance, totp_enabled)
- `POST /api/auth/totp/setup` — generate TOTP secret + URI (stores in D1)
- `POST /api/auth/totp/enable` — verify code, enable TOTP
- `POST /api/auth/totp/disable` — verify code, disable TOTP
- `POST /api/auth/forgot-password` — TOTP-based password reset
- `POST /api/auth/reset-password` — set new password with reset token
- `GET /api/story` — list user's stories
- `POST /api/story/create` — create story (triggers pipeline)
- `POST /api/story/:id/regenerate` — edit text → re-gen images + media
- `POST /api/story/:id/upgrade` — new input → full pipeline
- `GET /api/story/:id` — story detail + versions + media
- `GET /api/story/:id/logs` — pipeline debug logs
- `GET /api/story/:id/chat` — get chat messages
- `POST /api/story/:id/chat` — post chat message
- `GET /api/credits/balance` — current balance
- `POST /api/credits/checkout` — Stripe checkout session
- `POST /api/stripe/webhook` — Stripe webhook
- `GET /media/*` — serve R2 files

## Database Tables (7)

- `users` — id, username, password_hash, totp_secret, totp_enabled, credit_balance, created_at
- `transactions` — id, user_id, stripe_session_id, credits_purchased, amount_paid, status, created_at
- `stories` — id, user_id, raw_input, selected_duration, selected_type, script_style, play_style, status, credits_charged, created_at
- `script_versions` — id, story_id, version, type, raw_text, sections, styled_prompt, created_at
- `media` — id, story_id, script_version_id, format, r2_key, file_size, created_at
- `chat_messages` — id, story_id, role, message, created_at
- `pipeline_logs` — id, story_id, step, message, created_at (debug logging)

## R2 Storage Layout

```
storytime-media/
└── stories/{story_id}/v{version}/
    ├── images/ch{chapter}_img{index}.png
    ├── story_v{version}.pdf
    ├── story_v{version}.mp3
    └── story_v{version}.mp4  (JSON metadata for client-side MediaRecorder)
```

## Known Issues

- `waitUntil` pipeline may be killed by Worker instance timeout for long-running stories (5+ min LLM calls)
- No rate limiting on API endpoints
- Stripe webhook doesn't verify signatures
- MP4 is client-side only (MediaRecorder WebM, no server-side ffmpeg)
- PDF images may fail to embed if Workers AI returns unexpected format
- No input sanitization on chat messages
- TOTP pending secrets now stored in D1 (not in-memory) — fixed from v1 initial deploy
- Balance display estimates reserved credits from processing stories (may not reflect exact output costs)
