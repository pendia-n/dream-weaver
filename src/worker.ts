export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  CREDIT_30_PRICE_ID: string;
  CREDIT_100_PRICE_ID: string;
  CREDIT_300_PRICE_ID: string;
  OPENROUTER_API_KEY: string;
  ASSETS: Fetcher;
  R2: R2Bucket;
  AI: Ai;
  APP_URL: string;
}

// ─── CORS ───
function corsHeaders(origin: string) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function json(data: unknown, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ─── PASSWORD HASH (deterministic HMAC) ───
async function hashPassword(password: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(password));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ─── JWT (HMAC-SHA256 via Web Crypto) ───
async function signJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) }));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${body}`)))));
  return `${header}.${body}.${sig}`;
}

async function verifyJWT(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    const [h, b, s] = token.split('.');
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(s), c => c.charCodeAt(0)), enc.encode(`${h}.${b}`));
    if (!valid) return null;
    return JSON.parse(atob(b));
  } catch { return null; }
}

// ─── TOTP (simplified 6-digit) ───
function generateTOTPSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let s = '';
  const buf = new Uint8Array(20);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 20; i++) s += chars[buf[i] % 32];
  return s;
}

async function verifyTOTP(secret: string, code: string): Promise<boolean> {
  const epoch = Math.floor(Date.now() / 30000);
  for (let i = -1; i <= 1; i++) {
    const buf = new Uint8Array(8);
    const view = new DataView(buf.buffer);
    view.setBigUint64(0, BigInt(epoch + i));
    const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
    const offset = hmac[19] & 0xf;
    const token = ((hmac[offset] & 0x7f) << 24 | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]) % 1000000;
    if (token.toString().padStart(6, '0') === code) return true;
  }
  return false;
}

function base32Decode(s: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = s.toUpperCase().split('').map(c => chars.indexOf(c)).filter(n => n >= 0).map(n => n.toString(2).padStart(5, '0')).join('');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substring(i, i + 8), 2));
  return new Uint8Array(bytes);
}

// ─── OpenRouter helpers ───
async function callOpenRouter(apiKey: string, model: string, messages: { role: string; content: string | any[] }[], timeoutMs = 60000): Promise<string> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: 2048 }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error('OpenRouter error:', res.status, await res.text().catch(() => ''));
      return '';
    }
    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content || '';
  } catch (e) {
    console.error('OpenRouter call failed:', e);
    return '';
  } finally { clearTimeout(tid); }
}

async function generateImage(env: Env, prompt: string, dreamId: number, index: number, timestamp: number): Promise<string> {
  try {
    // Small delay between images to avoid rate limiting
    if (index > 0) await new Promise(r => setTimeout(r, 500));
    const result = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
      prompt: `Dreamlike, surreal, symbolic image: ${prompt}`,
      num_steps: 8,
      guidance: 2.5,
    });
    let imageBytes: Uint8Array;
    if (result instanceof Uint8Array) {
      imageBytes = result;
    } else if (result && typeof result === 'object') {
      const b64 = (result as any).image;
      if (b64 && typeof b64 === 'string') {
        const binary = atob(b64);
        imageBytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) imageBytes[i] = binary.charCodeAt(i);
      } else {
        console.error('Unexpected AI result format:', Object.keys(result));
        return '';
      }
    } else {
      console.error('Unexpected AI result type:', typeof result);
      return '';
    }
    const key = `dreams/${dreamId}/image-${index}-${timestamp}.png`;
    await env.R2.put(key, imageBytes, { httpMetadata: { contentType: 'image/png' } });
    return `${env.APP_URL}/images/${key}`;
  } catch (e) {
    console.error('Image generation failed:', e);
    return '';
  }
}

async function fetchImageAsBase64(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
    const contentType = res.headers.get('content-type') || 'image/png';
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return `data:${contentType};base64,${btoa(binary)}`;
  } catch (e) {
    console.error('fetchImageAsBase64 failed:', e);
    return '';
  }
}

function extractR2Key(url: string): string | null {
  const match = url.match(/\/images\/(.+)$/);
  return match ? match[1] : null;
}

async function deleteImageFromR2(env: Env, imageUrl: string): Promise<void> {
  const key = extractR2Key(imageUrl);
  if (key) {
    try { await env.R2.delete(key); } catch (e) { console.error('Failed to delete image from R2:', key, e); }
  }
}

async function getDreamImageUrls(env: Env, dreamId: number): Promise<string[]> {
  const imgMsgs = await env.DB.prepare(
    'SELECT image_urls FROM dream_messages WHERE dream_id = ? AND type = ? AND image_urls IS NOT NULL'
  ).bind(dreamId, 'image_generation').all();
  const urls: string[] = [];
  for (const msg of imgMsgs.results as any[]) {
    try { const parsed = JSON.parse(msg.image_urls); if (Array.isArray(parsed)) urls.push(...parsed); } catch {}
  }
  return urls;
}

// ─── Model selection (from model-switch.md) ───

function getInitModel(credits: number): string {
  return credits < 200 ? 'openai/gpt-5-nano' : 'qwen/qwen3.5-flash-02-23';
}

function getDreamChatModel(credits: number, hasImageClicked: boolean): string {
  if (credits < 300) {
    return hasImageClicked ? 'openai/gpt-5-nano' : 'amazon/nova-lite-v1';
  } else {
    return hasImageClicked ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'deepseek/deepseek-v4-flash';
  }
}

function getMainChatModel(credits: number): string {
  return credits < 400 ? 'qwen/qwen3.6-flash' : 'writer/palmyra-x5';
}

function getPublishSummaryModel(credits: number): string {
  return credits < 500 ? 'nvidia/nemotron-3-super-120b-a12b:free' : 'minimax/minimax-m1';
}

// ─── Lens system ───
// Each lens has: system prompt for interpretation, then a second call extracts symbols
const LENS_SYSTEM: Record<string, string> = {
  jung: "You are a Jungian dream analyst. Interpret the dream through Carl Jung's analytical psychology: archetypes, shadow, anima/animus, individuation, collective unconscious. Be warm, depth-oriented, insightful. Connect dream symbols to universal human patterns. Write 2-3 paragraphs.",
  laozi: "You are Laozi (老子), author of the Dao De Jing. Interpret the dream through Daoist philosophy: Dao, Wu Wei, Yin-Yang, Qi, Ziran. Use nature metaphors (water, valley, uncarved block). Be poetic, paradoxical, gentle. Write 2-3 paragraphs.",
  paul: "You are the Apostle Paul. Interpret the dream through Pauline theology: faith, grace, Body of Christ, spiritual gifts, suffering and glory. Be passionate, pastoral, theologically deep. Write 2-3 paragraphs.",
  valentinus: "You are Valentinus, 2nd-century Gnostic teacher. Interpret the dream through Gnostic cosmology: Pleroma, Aeons, Sophia's fall, divine spark, gnosis, archons. Be mystical, cosmological, poetic. Write 2-3 paragraphs.",
  odin: "You are Odin, the Allfather of Norse mythology. Interpret the dream through Norse wisdom: runes, fate (wyrd), sacrifice for wisdom, the nine worlds, ravens, wolves, Yggdrasil. Be stern but wise, cryptic, poetic. Write 2-3 paragraphs.",
  horus: "You are Horus, the Egyptian sky god. Interpret the dream through ancient Egyptian cosmology: Ma'at, the Eye of Horus, the journey of the sun, the weighing of the heart, the Duat. Be regal, protective, visionary. Write 2-3 paragraphs.",
  benjaminfranklin: "You are Benjamin Franklin. Interpret the dream through virtue, pragmatism, self-improvement, and Enlightenment reason. Reference Franklin's 13 virtues. Be witty, practical, moral but not preachy. Write 2-3 paragraphs.",
  napoleon: "You are Napoleon Bonaparte. Interpret the dream through ambition, strategy, willpower, destiny, and the art of war. Be commanding, analytical, intense. Write 2-3 paragraphs.",
};

// Second pass: extract symbols from the interpretation
function extractSymbolsPrompt(lens: string): string {
  const lensName = lens.charAt(0).toUpperCase() + lens.slice(1);
  return `Given the dream interpretation above, extract 3-5 key symbols as JSON array: [{"symbol":"name","meaning":"brief meaning"}]. Return ONLY valid JSON array, nothing else.`;
}

// ─── Router ───
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '*';
    const path = url.pathname.replace('/api', '');

    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

    // ─── Ensure tables exist (symbols, moods) ───
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS dream_symbols (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, dream_id INTEGER NOT NULL, symbol TEXT NOT NULL, meaning TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (dream_id) REFERENCES dreams(id))').run();
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS dream_moods (id INTEGER PRIMARY KEY AUTOINCREMENT, dream_id INTEGER NOT NULL, mood_before INTEGER DEFAULT 5, mood_after INTEGER DEFAULT 5, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (dream_id) REFERENCES dreams(id))').run();
      /* extra_data not needed */
    } catch (e) { /* ignore if column already exists */ }

    // ─── Ensure admin account exists ───
    const adminCheck = await env.DB.prepare('SELECT id, password_hash FROM users WHERE username = ?').bind('admin').first<{ id: number; password_hash: string }>();
    if (adminCheck && adminCheck.password_hash === 'ADMIN_PLACEHOLDER') {
      const adminHash = await hashPassword('heyouadmin', env.JWT_SECRET);
      await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(adminHash, adminCheck.id).run();
    }
    const allUsers = await env.DB.prepare('SELECT id, username, password_hash FROM users WHERE password_hash LIKE "%.%"').all<{ id: number; username: string; password_hash: string }>();
    for (const u of allUsers.results) {
      await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind('RESET_REQUIRED', u.id).run();
    }

    // ─── Auth middleware helper ───
    async function auth(): Promise<{ userId: number; username: string; credits: number; isAdmin: boolean } | null> {
      const token = req.headers.get('Authorization')?.replace('Bearer ', '');
      if (!token) return null;
      const p = await verifyJWT(token, env.JWT_SECRET);
      if (!p?.userId) return null;
      const user = await env.DB.prepare('SELECT id, username, credits, is_admin FROM users WHERE id = ?').bind(p.userId).first<{ id: number; username: string; credits: number; is_admin: number }>();
      if (!user) return null;
      return { userId: user.id, username: user.username, credits: user.credits, isAdmin: !!user.is_admin };
    }

    try {
      // ══════════════════════════════════════
      // PUBLIC ROUTES (no auth required)
      // ══════════════════════════════════════

      // PUBLIC IMAGE SERVING FROM R2 (must be before auth)
      if (path.startsWith('/images/') && req.method === 'GET') {
        const key = path.replace('/images/', '');
        const object = await env.R2.get(key);
        if (!object) return json({ error: 'Image not found' }, 404, origin);
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('Cache-Control', 'public, max-age=31536000');
        return new Response(object.body, { headers });
      }

      // Register
      if (path === '/auth/register' && req.method === 'POST') {
        const b = await req.json() as any;
        const { username, password } = b;
        if (!username || !password) return json({ error: 'Username and password required' }, 400, origin);
        if (username.length < 3) return json({ error: 'Username min 3 chars' }, 400, origin);
        if (password.length < 6) return json({ error: 'Password min 6 chars' }, 400, origin);
        const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
        if (existing) return json({ error: 'Username taken' }, 409, origin);
        const hash = await hashPassword(password, env.JWT_SECRET);
        const totpSecret = generateTOTPSecret();
        const result = await env.DB.prepare('INSERT INTO users (username, password_hash, totp_secret, credits) VALUES (?, ?, ?, 15)').bind(username, hash, totpSecret).run();
        const token = await signJWT({ userId: result.meta.last_row_id, username }, env.JWT_SECRET);
        return json({ token, username, credits: 15, totpSecret, totpEnabled: false }, 200, origin);
      }

      // Login
      if (path === '/auth/login' && req.method === 'POST') {
        const b = await req.json() as any;
        const { username, password, totpCode } = b;
        const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<any>();
        if (!user) return json({ error: 'Invalid credentials' }, 401, origin);
        const hash = await hashPassword(password, env.JWT_SECRET);
        if (hash !== user.password_hash) return json({ error: 'Invalid credentials' }, 401, origin);
        if (user.totp_enabled && user.totp_secret) {
          if (!totpCode) return json({ error: 'TOTP code required', totpRequired: true }, 401, origin);
          if (!await verifyTOTP(user.totp_secret, totpCode)) return json({ error: 'Invalid TOTP' }, 401, origin);
        }
        const token = await signJWT({ userId: user.id, username: user.username }, env.JWT_SECRET);
        return json({ token, username: user.username, credits: user.credits, totpEnabled: !!user.totp_enabled, isAdmin: !!user.is_admin }, 200, origin);
      }

      // Check username availability
      if (path === '/auth/check-username' && req.method === 'GET') {
        const username = url.searchParams.get('username') || '';
        if (username.length < 3) return json({ available: false, error: 'Username min 3 chars' }, 200, origin);
        const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
        return json({ available: !existing }, 200, origin);
      }

      // Forgot password — Step 1
      if (path === '/auth/forgot-password' && req.method === 'POST') {
        const b = await req.json() as any;
        const { username, totpCode } = b;
        if (!username || !totpCode) return json({ error: 'Username and TOTP code required' }, 400, origin);
        const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<any>();
        if (!user) return json({ error: 'User not found' }, 404, origin);
        if (!user.totp_enabled || !user.totp_secret) return json({ error: 'TOTP not enabled for this account. Contact support.' }, 400, origin);
        if (!await verifyTOTP(user.totp_secret, totpCode)) return json({ error: 'Invalid TOTP code' }, 401, origin);
        const resetToken = await signJWT({ userId: user.id, username: user.username, purpose: 'password_reset' }, env.JWT_SECRET);
        return json({ resetToken, message: 'TOTP verified. Use resetToken to set new password.' }, 200, origin);
      }

      // Forgot password — Step 2
      if (path === '/auth/reset-password' && req.method === 'POST') {
        const b = await req.json() as any;
        const { resetToken, newPassword } = b;
        if (!resetToken || !newPassword) return json({ error: 'Reset token and new password required' }, 400, origin);
        if (newPassword.length < 6) return json({ error: 'Password min 6 chars' }, 400, origin);
        const payload = await verifyJWT(resetToken, env.JWT_SECRET);
        if (!payload || payload.purpose !== 'password_reset') return json({ error: 'Invalid or expired reset token' }, 401, origin);
        const hash = await hashPassword(newPassword, env.JWT_SECRET);
        await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, payload.userId).run();
        return json({ message: 'Password reset successful. Login with new password.' }, 200, origin);
      }

      // Stripe webhook
      if (path === '/stripe/webhook' && req.method === 'POST') {
        const body = await req.text();
        try {
          const event = JSON.parse(body);
          if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const userId = session.metadata?.userId;
            const credits = parseInt(session.metadata?.credits || '0');
            if (userId && credits > 0) {
              await env.DB.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').bind(credits, userId).run();
            }
          }
        } catch { /* ignore parse errors */ }
        return json({ received: true }, 200, origin);
      }




      // ══════════════════════════════════════
      // PROTECTED ROUTES
      // ══════════════════════════════════════
      // Favicon — must be before auth
      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      const user = await auth();
      if (!user) return json({ error: 'Unauthorized' }, 401, origin);

      // Get profile
      if (path === '/user/profile' && req.method === 'GET') {
        return json({ username: user.username, credits: user.credits, isAdmin: user.isAdmin }, 200, origin);
      }

      // Setup TOTP — returns secret + QR code URI (GET to avoid body issues)
      if (path === '/user/totp/setup' && (req.method === 'GET' || req.method === 'POST')) {
        try {
          const u = await env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(user.userId).first<any>();
          let secret = u?.totp_secret;
          if (!secret) {
            secret = generateTOTPSecret();
            await env.DB.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').bind(secret, user.userId).run();
          }
          const uri = `otpauth://totp/Dreamweaver:${user.username}?secret=${secret}&issuer=Dreamweaver`;
          return json({ secret, uri }, 200, origin);
        } catch (e) {
          console.error('TOTP setup error:', e);
          return json({ error: 'TOTP setup failed' }, 500, origin);
        }
      }

      // Enable TOTP
      if (path === '/user/totp/enable' && req.method === 'POST') {
        const b = await req.json() as any;
        const u = await env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(user.userId).first<any>();
        if (!u) return json({ error: 'No TOTP secret' }, 400, origin);
        if (!await verifyTOTP(u.totp_secret, b.code)) return json({ error: 'Invalid code' }, 400, origin);
        await env.DB.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').bind(user.userId).run();
        return json({ success: true }, 200, origin);
      }

      // Disable TOTP
      if (path === '/user/totp/disable' && req.method === 'POST') {
        const b = await req.json() as any;
        const u = await env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(user.userId).first<any>();
        if (!u) return json({ error: 'No TOTP secret' }, 400, origin);
        if (!await verifyTOTP(u.totp_secret, b.code)) return json({ error: 'Invalid code' }, 400, origin);
        await env.DB.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').bind(user.userId).run();
        return json({ success: true }, 200, origin);
      }

      // ─── DREAMS ───

      // List dreams
      if (path === '/dreams' && req.method === 'GET') {
        const dreams = await env.DB.prepare('SELECT id, title, summary, created_at FROM dreams WHERE user_id = ? ORDER BY created_at DESC').bind(user.userId).all();
        return json({ dreams: dreams.results }, 200, origin);
      }

      // Get single dream with messages
      if (path.match(/^\/dreams\/\d+$/) && req.method === 'GET') {
        const dreamId = parseInt(path.split('/')[2]);
        const dream = await env.DB.prepare('SELECT * FROM dreams WHERE id = ? AND user_id = ?').bind(dreamId, user.userId).first();
        if (!dream) return json({ error: 'Not found' }, 404, origin);
        const messages = await env.DB.prepare('SELECT * FROM dream_messages WHERE dream_id = ? ORDER BY created_at ASC').bind(dreamId).all();
        return json({ dream, messages: messages.results }, 200, origin);
      }

      // New dream - first message
      if (path === '/dreams' && req.method === 'POST') {
        const b = await req.json() as any;
        const { text, mode, lens, mood_before, mood_after } = b; // mode: 'text_only' | 'text_and_images'
        const cost = mode === 'text_and_images' ? 3 : 2;

        if (user.credits < cost) return json({ error: 'Not enough credits', needed: cost, have: user.credits }, 402, origin);

        const dreamTitle = text.substring(0, 60) + (text.length > 60 ? '...' : '');
        const dreamResult = await env.DB.prepare('INSERT INTO dreams (user_id, title) VALUES (?, ?)').bind(user.userId, dreamTitle).run();
        const dreamId = dreamResult.meta.last_row_id;

        await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content) VALUES (?, ?, ?)').bind(dreamId, 'user', text).run();

        const model = getInitModel(user.credits);
        const systemPrompt = LENS_SYSTEM[lens] || LENS_SYSTEM['jung'];

        // Step 1: Get the interpretation (plain text)
        let interpretationText = await callOpenRouter(env.OPENROUTER_API_KEY, model, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ]);

        // If empty, retry with a simpler fallback
        if (!interpretationText || interpretationText.trim().length < 10) {
          interpretationText = await callOpenRouter(env.OPENROUTER_API_KEY, 'qwen/qwen3.5-flash-02-23', [
            { role: 'system', content: 'You are a dream interpreter. Analyze the dream symbolically and psychologically. Be insightful but concise (200-400 words).' },
            { role: 'user', content: text },
          ]);
        }

        // If still empty, use a default
        if (!interpretationText || interpretationText.trim().length < 10) {
          interpretationText = 'The dream speaks to your inner journey. The symbols you experienced carry personal meaning that resonates with your current life situation. Consider what emotions arose and what aspects of yourself the dream figures might represent.';
        }

        // Step 2: Extract symbols in a separate call
        let symbols: any[] = [];
        try {
          const symbolResponse = await callOpenRouter(env.OPENROUTER_API_KEY, 'qwen/qwen3.5-flash-02-23', [
            { role: 'system', content: 'Extract 3-5 key dream symbols from this interpretation. Return ONLY a JSON array: [{"symbol":"name","meaning":"brief meaning"}]. Nothing else.' },
            { role: 'user', content: interpretationText },
          ]);
          const parsed = JSON.parse(symbolResponse);
          if (Array.isArray(parsed)) symbols = parsed;
        } catch {
          // Symbol extraction failed, continue without symbols
        }

        // Store the interpretation
        await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content, type) VALUES (?, ?, ?, ?)')
          .bind(dreamId, 'assistant', interpretationText, 'interpretation').run();

        // Store symbols in DB
        for (const sym of symbols) {
          try {
            await env.DB.prepare('INSERT INTO dream_symbols (user_id, dream_id, symbol, meaning) VALUES (?, ?, ?, ?)')
              .bind(user.userId, dreamId, sym.symbol, sym.meaning).run();
          } catch {}
        }

        // Store mood
        if (mood_before !== undefined || mood_after !== undefined) {
          try {
            await env.DB.prepare('INSERT INTO dream_moods (dream_id, mood_before, mood_after) VALUES (?, ?, ?)')
              .bind(dreamId, mood_before || 5, mood_after || 5).run();
          } catch {}
        }

        let imageUrls: string[] = [];

        if (mode === 'text_and_images') {
          const ts = Date.now();
          for (let i = 0; i < 2; i++) {
            const imgPrompt = `Dreamlike symbolic image for: ${text.substring(0, 200)}. Style: surreal, ethereal, symbolic.`;
            const imgUrl = await generateImage(env, imgPrompt, dreamId, i, ts);
            if (imgUrl) imageUrls.push(imgUrl);
          }
          if (imageUrls.length > 0) {
            await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content, type, image_urls) VALUES (?, ?, ?, ?, ?)')
              .bind(dreamId, 'assistant', 'I generated these images based on your dream:', 'image_generation', JSON.stringify(imageUrls)).run();
          }
        }

        await env.DB.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').bind(cost, user.userId).run();
        const summary = interpretResponse.substring(0, 100) + '...';
        await env.DB.prepare('UPDATE dreams SET summary = ? WHERE id = ?').bind(summary, dreamId).run();

        return json({ dreamId, interpretation: interpretationText, imageUrls, creditsLeft: user.credits - cost }, 200, origin);
      }

      // Continue dream conversation
      if (path.match(/^\/dreams\/\d+\/messages$/) && req.method === 'POST') {
        const dreamId = parseInt(path.split('/')[2]);
        const b = await req.json() as any;
        const { text, selectedImage, mode } = b;
        // mode: 'text_only' | 'text_with_image_ref' | 'text_with_new_image' | 'text_image_and_gen'
        let cost = 1;
        if (mode === 'text_with_image_ref') cost = 2;
        else if (mode === 'text_with_new_image') cost = 3;
        else if (mode === 'text_image_and_gen') cost = 4;

        if (user.credits < cost) return json({ error: 'Not enough credits', needed: cost, have: user.credits }, 402, origin);

        const dream = await env.DB.prepare('SELECT id FROM dreams WHERE id = ? AND user_id = ?').bind(dreamId, user.userId).first();
        if (!dream) return json({ error: 'Not found' }, 404, origin);

        // FIX: Do NOT store image URL in user message — just store text
        await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content) VALUES (?, ?, ?)').bind(dreamId, 'user', text).run();

        // Build messages for AI
        const history = await env.DB.prepare('SELECT role, content FROM dream_messages WHERE dream_id = ? ORDER BY created_at ASC LIMIT 20').bind(dreamId).all();

        let model: string;
        let messages: { role: string; content: string | any[] }[];

        if (selectedImage) {
          // Image+text mode: use vision model
          model = getDreamChatModel(user.credits, true);
          let imageBase64 = '';
          try { imageBase64 = await fetchImageAsBase64(selectedImage); } catch (e) { console.error('Image fetch failed:', e); }
          
          if (imageBase64) {
            messages = [
              { role: 'system', content: 'You are a dream interpreter. Analyze the dream image and the user text together. Provide symbolic and psychological interpretation. Be insightful and concise (150-300 words).' },
              ...(history.results as any[]).map(m => ({ role: m.role, content: m.content })),
              {
                role: 'user',
                content: [
                  { type: 'text', text: text },
                  { type: 'image_url', image_url: { url: imageBase64 } },
                ],
              },
            ];
          } else {
            // Fallback: no image, text only
            model = getDreamChatModel(user.credits, true);
            messages = [
              { role: 'system', content: 'You are a dream interpreter. The user referenced a dream image. Provide symbolic and psychological interpretation based on their text description. Be insightful and concise (150-300 words).' },
              ...(history.results as any[]).map(m => ({ role: m.role, content: m.content })),
              { role: 'user', content: `[User referenced a selected dream image] ${text}` },
            ];
          }
        } else {
          // Text-only mode
          model = getDreamChatModel(user.credits, false);
          messages = [
            { role: 'system', content: 'You are a dream interpreter continuing a conversation about a dream. Reference previous context. Be insightful and concise (150-300 words).' },
            ...(history.results as any[]).map(m => ({ role: m.role, content: m.content })),
          ];
        }

        let response = '';
        try {
          response = await callOpenRouter(env.OPENROUTER_API_KEY, model, messages);
        } catch (e) {
          console.error('OpenRouter call failed:', e);
        }
        
        // Fallback if response is empty
        if (!response || response.trim().length === 0) {
          try {
            const fallbackModel = 'qwen/qwen3.5-flash-02-23';
            const fallbackMessages = [
              { role: 'system', content: 'You are a dream interpreter. Provide symbolic and psychological interpretation. Be insightful and concise (150-300 words).' },
              ...(history.results as any[]).slice(-6).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.substring(0, 500) : '' })),
              { role: 'user', content: text },
            ];
            response = await callOpenRouter(env.OPENROUTER_API_KEY, fallbackModel, fallbackMessages);
          } catch (e) {
            console.error('Fallback also failed:', e);
            response = 'I apologize, but I encountered an error processing your request. Please try again.';
          }
        }

        await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content, type) VALUES (?, ?, ?, ?)').bind(dreamId, 'assistant', response, 'chat').run();

        let imageUrls: string[] = [];

        if (mode === 'text_image_and_gen' || mode === 'text_with_new_image') {
          // Delete ALL old images from R2 before generating new ones
          const oldImageUrls = await getDreamImageUrls(env, dreamId);
          for (const oldUrl of oldImageUrls) {
            await deleteImageFromR2(env, oldUrl);
          }
          await env.DB.prepare('DELETE FROM dream_messages WHERE dream_id = ? AND type = ?').bind(dreamId, 'image_generation').run();

          // Generate 2 new images
          const ts = Date.now();
          for (let i = 0; i < 2; i++) {
            const imgPrompt = `Dreamlike symbolic image continuing the dream: ${text.substring(0, 200)}. Style: surreal, ethereal.`;
            const imgUrl = await generateImage(env, imgPrompt, dreamId, i, ts);
            if (imgUrl) imageUrls.push(imgUrl);
          }
          if (imageUrls.length > 0) {
            await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content, type, image_urls) VALUES (?, ?, ?, ?, ?)')
              .bind(dreamId, 'assistant', 'New images generated:', 'image_generation', JSON.stringify(imageUrls)).run();
          }
        } else if (selectedImage) {
          // User picked an image — delete the unselected ones from R2
          const allDreamImages = await getDreamImageUrls(env, dreamId);
          for (const imgUrl of allDreamImages) {
            if (imgUrl !== selectedImage) {
              await deleteImageFromR2(env, imgUrl);
            }
          }
          await env.DB.prepare('DELETE FROM dream_messages WHERE dream_id = ? AND type = ?').bind(dreamId, 'image_generation').run();
          await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content, type, image_urls) VALUES (?, ?, ?, ?, ?)')
            .bind(dreamId, 'assistant', 'Selected image:', 'image_generation', JSON.stringify([selectedImage])).run();
        }

        await env.DB.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').bind(cost, user.userId).run();

        return json({ response, imageUrls, creditsLeft: user.credits - cost }, 200, origin);
      }

      // ─── SYMBOLS ───
      if (path === '/symbols' && req.method === 'GET') {
        const symbols = await env.DB.prepare(`
          SELECT symbol, meaning, COUNT(*) as count, MIN(created_at) as first_seen, MAX(created_at) as last_seen
          FROM dream_symbols WHERE user_id = ?
          GROUP BY symbol ORDER BY count DESC LIMIT 50
        `).bind(user.userId).all();
        return json({ symbols: symbols.results }, 200, origin);
      }

      // ─── MOOD DATA ───
      if (path === '/moods' && req.method === 'GET') {
        const moods = await env.DB.prepare(`
          SELECT dm.mood_before, dm.mood_after, dm.created_at, d.title
          FROM dream_moods dm JOIN dreams d ON dm.dream_id = d.id
          WHERE d.user_id = ? ORDER BY dm.created_at DESC LIMIT 30
        `).bind(user.userId).all();
        return json({ moods: moods.results }, 200, origin);
      }

      // ─── MAIN ORCHESTRATOR ───
      // Chat with AI across all dream history
      if (path === '/main/chat' && req.method === 'POST') {
        const b = await req.json() as any;
        const { text } = b;
        if (!text) return json({ error: 'Text required' }, 400, origin);

        // Cost: 0.5 credits per input
        const cost = 0.5;
        if (user.credits < cost) return json({ error: 'Not enough credits', needed: cost, have: user.credits }, 402, origin);

        // Get user's dreams (limited to recent 10, with limited messages each)
        const dreams = await env.DB.prepare('SELECT id, title, summary, created_at FROM dreams WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').bind(user.userId).all();

        // Build compact context from dreams
        let contextParts: string[] = [];
        for (const d of dreams.results as any[]) {
          // Only get first user message (the dream) + first AI response per dream
          const msgs = await env.DB.prepare("SELECT role, content FROM dream_messages WHERE dream_id = ? AND type != 'image_generation' ORDER BY created_at ASC LIMIT 3").bind(d.id).all();
          const msgSummary = (msgs.results as any[]).map(m => `${m.role}: ${m.content.substring(0, 200)}`).join('\n');
          contextParts.push(`Dream "${d.title}":\n${msgSummary}`);
        }

        const fullContext = contextParts.join('\n\n');
        const model = getMainChatModel(user.credits);

        let response = '';
        try {
          response = await callOpenRouter(env.OPENROUTER_API_KEY, model, [
            {
              role: 'system',
              content: `You are a dream analyst with access to the user's recent dream history. Reference specific dreams when relevant. Be insightful, connecting themes across dreams. Keep responses concise (200-400 words).\n\nUser's dream history:\n${fullContext}`,
            },
            { role: 'user', content: text },
          ]);
        } catch (e) {
          console.error('Main chat OpenRouter error:', e);
        }

        if (!response || response.trim().length === 0) {
          response = 'I apologize, but I encountered an error processing your request. Please try again.';
        }

        await env.DB.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').bind(cost, user.userId).run();

        return json({ response, creditsLeft: user.credits - cost }, 200, origin);
      }

      // ─── BOARD ───



      // ─── STRIPE ───

      // Create checkout session
      if (path === '/stripe/checkout' && req.method === 'POST') {
        const b = await req.json() as any;
        const { priceId } = b;

        const sessionRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            'mode': 'payment',
            'success_url': `${url.origin}/?success=true`,
            'cancel_url': `${url.origin}/?canceled=true`,
            'line_items[0][price]': priceId,
            'line_items[0][quantity]': '1',
            'metadata[userId]': user.userId.toString(),
            'metadata[credits]': priceId === env.CREDIT_30_PRICE_ID ? '30' : priceId === env.CREDIT_100_PRICE_ID ? '100' : '300',
          }).toString(),
        });
        const session = await sessionRes.json() as any;
        return json({ url: session.url }, 200, origin);
      }

      // ─── ADMIN ───

      // Admin report (monthly)
      if (path === '/admin/report' && req.method === 'GET') {
        if (!user.isAdmin) return json({ error: 'Forbidden' }, 403, origin);

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
        const startDate = startOfMonth.toISOString().split('T')[0];
        const endDate = endOfMonth.toISOString().split('T')[0];

        const byRegion = await env.DB.prepare(`
          SELECT u.country, COUNT(d.id) as dream_count, GROUP_CONCAT(d.title) as titles
          FROM dreams d JOIN users u ON d.user_id = u.id
          WHERE d.created_at BETWEEN ? AND ?
          GROUP BY u.country ORDER BY dream_count DESC
        `).bind(startDate, endDate).all();

        const dreams = await env.DB.prepare(`
          SELECT dm.content, d.title FROM dream_messages dm
          JOIN dreams d ON dm.dream_id = d.id
          WHERE dm.role = 'user' AND d.created_at BETWEEN ? AND ?
          LIMIT 100
        `).bind(startDate, endDate).all();

        const dreamTexts = (dreams.results as any[]).slice(0, 20).map(d => d.content).join('\\n---\\n');
        const emotionAnalysis = await callOpenRouter(env.OPENROUTER_API_KEY, 'qwen/qwen3.5-flash-02-23', [
          { role: 'system', content: `Analyze these dreams and report:
1. Top 5 emotions detected (with percentages)
2. Top 5 recurring symbols
3. Most common dream type (flying, falling, chase, etc.)
4. Average dream complexity score (1-10)
5. Notable patterns or trends
6. Geographic distribution insights
Format as JSON.` },
          { role: 'user', content: dreamTexts },
        ]);

        const topUsers = await env.DB.prepare(`
          SELECT u.username, COUNT(d.id) as dream_count
          FROM dreams d JOIN users u ON d.user_id = u.id
          WHERE d.created_at BETWEEN ? AND ?
          GROUP BY u.id ORDER BY dream_count DESC LIMIT 10
        `).bind(startDate, endDate).all();

        const publishStats = await env.DB.prepare(`
          SELECT COUNT(*) as total_posts, SUM(comments_count) as total_comments
          FROM board_posts WHERE created_at BETWEEN ? AND ?
        `).bind(startDate, endDate).first();

        const creditStats = await env.DB.prepare(`
          SELECT SUM(credits) as total_credits_purchased FROM credit_transactions
          WHERE created_at BETWEEN ? AND ? AND type = 'purchase'
        `).bind(startDate, endDate).first();

        return json({
          period: { start: startDate, end: endDate },
          byRegion: byRegion.results,
          emotionAnalysis,
          topUsers: topUsers.results,
          publishStats,
          creditStats,
        }, 200, origin);
      }

      // ══════════════════════════════════════
      // SPA FALLBACK
      // ══════════════════════════════════════
      return env.ASSETS.fetch(req);

    } catch (err: any) {
      return json({ error: err.message || 'Server error' }, 500, origin);
    }
  },
};
