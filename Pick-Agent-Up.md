# DreamWeaver — Tech Stack & UX

## Tech Stack

- **Frontend:** Vanilla TypeScript + Vite (no framework, direct DOM manipulation)
- **Backend:** Cloudflare Workers (single `worker.ts`, all-in-one)
- **DB:** Cloudflare D1 (SQLite)
- **Storage:** Cloudflare R2 (dream images)
- **AI Chat:** OpenRouter (11 free models checked in priority order, fallback to hardcoded paid models per credit tier)
- **AI Image:** Cloudflare Workers AI (`@cf/black-forest-labs/flux-1-schnell`)
- **Auth:** Homemade JWT (HMAC-SHA256), HMAC-SHA256 password hashing with JWT_SECRET as salt, optional TOTP (RFC 6238)
- **Payments:** Stripe Checkout (30cr/$4.99, 100cr/$9.99, 300cr/$19.99)
- **Deploy:** `npm run build && wrangler deploy`

## UX

- **Auth:** Login/Register with username + password (min 6 chars), optional TOTP 2FA, forgot password via TOTP verification
- **Home:** Welcome screen with quick actions → New Dream, History, Main Orchestrator, Credits
- **New Dream:** Textarea to describe dream, 8 interpretation lenses (Jung, Laozi, Paul, Valentinus, Odin, Horus, Benjamin Franklin, Napoleon), mood sliders (before/after sleep), text-only (2cr) or text+2 images (3cr), voice input via Web Speech API
- **Dream Chat:** Message history, AI responses with optional images, click to select an image for reference, 4 chat modes (text-only 1cr, text+image ref 2cr, text+new images 3cr, image ref+new images 4cr)
- **History:** List of past dreams with summaries
- **Main Orchestrator:** Cross-dream chat with AI that has context of all dreams, extracted symbols view
- **Credits:** Balance display + Stripe purchase packs
- **Settings:** TOTP setup/disable
- **Admin:** Monthly report (dreams by region, top dreamers)

## Credit Economy

- 15cr on signup
- New dream: 2cr text-only / 3cr text+images
- Chat: 1-4cr depending on mode
- Main chat: 0.5cr per message

## Lenses

Jung, Laozi, Paul, Valentinus, Odin, Horus, Benjamin Franklin, Napoleon — each with a full system prompt defining the interpretation style.

## Model Switching

11 free OpenRouter models checked in priority order via `/models` API every 5 minutes. Skips models with rate limits or non-zero pricing. If a free model is found, it's used instead of the hardcoded default. If the free model fails at call time, retries with the original hardcoded model. Fallback chain: free model → hardcoded model per credit tier → static error message.

## API Endpoints

- `POST /auth/register` — signup (returns JWT + TOTP secret)
- `POST /auth/login` — login (optional TOTP)
- `GET /auth/check-username` — username availability
- `POST /auth/forgot-password` — TOTP-based password reset
- `POST /auth/reset-password` — set new password with reset token
- `GET /user/profile` — current user info
- `GET/POST /user/totp/setup` — TOTP setup
- `POST /user/totp/enable` — verify and enable TOTP
- `POST /user/totp/disable` — disable TOTP
- `GET /dreams` — list user's dreams
- `POST /dreams` — create new dream (init interpretation + optional images)
- `GET /dreams/:id` — get dream with messages
- `POST /dreams/:id/messages` — continue dream chat
- `POST /main/chat` — main orchestrator chat
- `GET /main/history` — main chat history
- `POST /main/clear` — clear main chat
- `GET /symbols` — extracted dream symbols
- `GET /forecast` — mood/emotion trends
- `GET /moods` — raw mood data
- `POST /stripe/checkout` — create Stripe checkout session
- `POST /stripe/webhook` — Stripe webhook handler
- `GET /admin/report` — admin monthly report
- `GET /images/:key` — serve R2 images

## Database Tables

- `users` — username, password_hash, totp_secret, totp_enabled, credits, is_admin, country, city
- `dreams` — user_id, title, summary
- `dream_messages` — dream_id, role, content, type, image_urls
- `dream_symbols` — user_id, dream_id, symbol, meaning
- `dream_moods` — dream_id, mood_before, mood_after
- `main_chat_messages` — user_id, role, content, hidden
- `credit_transactions` — user_id, amount, type, stripe_session_id
- `board_posts` — (dead code, no endpoints)
- `board_comments` — (dead code, no endpoints)

## Known Issues

- No input sanitization on `innerHTML` — AI responses injected directly, potential XSS if AI returns HTML/JS
- Credit deduction not atomic — read/check/deduct in separate queries, concurrent requests could double-spend
- No rate limiting on API endpoints
- Stripe webhook doesn't verify signatures — anyone can fake payment completion
- Admin report date range is wrong — gives "start of last month to end of current month" instead of "last month"
- Forecast endpoint parses `interpretation` as JSON but it's stored as plain text — `emotional_tone` always "unknown"
- Password reset JWT has no `exp` claim — reset token never expires
- Image generation retry is basic — once, 1s delay, no backoff
- Free model cache is per-Worker-instance, not shared
- `board_posts` and `board_comments` tables are dead code (no endpoints)
