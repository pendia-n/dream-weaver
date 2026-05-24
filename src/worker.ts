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

async function hashPassword(password: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(password));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

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

// ─── Model switching: check free models, cache in D1 ───
const FREE_MODEL_IDS = [
  'openrouter/owl-alpha',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'z-ai/glm-5.1',
  'minimax/minimax-m2.5:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'qwen/qwen3-coder:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'baidu/cobuddy:free',
  'deepseek/deepseek-v4-flash:free',
  'arcee-ai/trinity-large-thinking:free',
];

// Module-level cache
let cachedFreeModel: string | null = null;
let lastModelCheck = 0;
const MODEL_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function getFreeModel(apiKey: string): Promise<string | null> {
  const now = Date.now();
  if (cachedFreeModel && (now - lastModelCheck) < MODEL_CHECK_INTERVAL) {
    return cachedFreeModel;
  }
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!res.ok) { lastModelCheck = now; return null; }
    const data = await res.json() as any;
    const models = data.data || [];
    for (const id of FREE_MODEL_IDS) {
      const found = models.find((m: any) => m.id === id);
      if (found) {
        const p = found.pricing || {};
        // Check prompt is "0" (free) — also check for rate limits
        if (p.prompt === '0' && p.completion === '0') {
          // Check if model has per_request_limits (rate limiting)
          if (found.per_request_limits) {
            console.log(`Free model ${id} has rate limits, skipping`);
            continue;
          }
          cachedFreeModel = id;
          lastModelCheck = now;
          console.log(`Free model found: ${id}`);
          return id;
        }
      }
    }
  } catch (e) {
    console.error('Model check failed:', e);
  }
  lastModelCheck = now;
  cachedFreeModel = null;
  return null;
}

async function callOpenRouter(apiKey: string, model: string, messages: { role: string; content: string | any[] }[], timeoutMs = 60000): Promise<string> {
  const freeModel = await getFreeModel(apiKey);
  const useModel = freeModel || model;
  if (freeModel && freeModel !== model) {
    console.log(`Using free model ${freeModel} instead of ${model}`);
  }
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: useModel, messages, max_tokens: 2048 }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (freeModel && freeModel !== model) {
        console.error(`Free model ${useModel} failed (${res.status}), retrying with ${model}`);
        const res2 = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, max_tokens: 2048 }),
          signal: ctrl.signal,
        });
        if (!res2.ok) { console.error('OpenRouter retry error:', res2.status); return ''; }
        const data2 = await res2.json() as any;
        return data2.choices?.[0]?.message?.content || '';
      }
      console.error('OpenRouter error:', res.status); return '';
    }
    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content || '';
  } catch (e) {
    console.error('OpenRouter failed:', e);
    if (freeModel && freeModel !== model) {
      try {
        const res2 = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, max_tokens: 2048 }),
          signal: ctrl.signal,
        });
        if (res2.ok) {
          const data2 = await res2.json() as any;
          return data2.choices?.[0]?.message?.content || '';
        }
      } catch {}
    }
    return '';
  } finally { clearTimeout(tid); }
}

async function generateImage(env: Env, prompt: string, dreamId: number, index: number, timestamp: number): Promise<string> {
  try {
    if (index > 0) await new Promise(r => setTimeout(r, 500));
    console.log(`Generating image ${index} for dream ${dreamId}...`);
    const result = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
      prompt: `Dreamlike, surreal, symbolic image: ${prompt}`, num_steps: 8, guidance: 2.5,
    });
    console.log(`AI result type: ${typeof result}, is Uint8Array: ${result instanceof Uint8Array}`);
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
        console.error('Image gen: result object has no image field', JSON.stringify(result).substring(0, 200));
        return '';
      }
    } else {
      console.error('Image gen: unexpected result type', typeof result);
      return '';
    }
    if (!imageBytes || imageBytes.length === 0) {
      console.error('Image gen: empty image bytes');
      return '';
    }
    const key = `dreams/${dreamId}/image-${index}-${timestamp}.png`;
    await env.R2.put(key, imageBytes, { httpMetadata: { contentType: 'image/png' } });
    const url = `${env.APP_URL}/images/${key}`;
    console.log(`Image ${index} generated: ${url} (${imageBytes.length} bytes)`);
    return url;
  } catch (e) { console.error('Image gen failed:', e); return ''; }
}

function extractR2Key(url: string): string | null {
  const match = url.match(/\/images\/(.+)$/);
  return match ? match[1] : null;
}

async function deleteImageFromR2(env: Env, imageUrl: string): Promise<void> {
  const key = extractR2Key(imageUrl);
  if (key) { try { await env.R2.delete(key); } catch {} }
}

async function getDreamImageUrls(env: Env, dreamId: number): Promise<string[]> {
  const imgMsgs = await env.DB.prepare('SELECT image_urls FROM dream_messages WHERE dream_id = ? AND type = ? AND image_urls IS NOT NULL').bind(dreamId, 'image_generation').all();
  const urls: string[] = [];
  for (const msg of imgMsgs.results as any[]) {
    try { const parsed = JSON.parse(msg.image_urls); if (Array.isArray(parsed)) urls.push(...parsed); } catch {}
  }
  return urls;
}

// ─── Default model selection (from model-switch.md) ───
function getDefaultInitModel(credits: number): string {
  return credits < 200 ? 'openai/gpt-5-nano' : 'qwen/qwen3.5-flash-02-23';
}
function getDefaultDreamChatModel(credits: number, hasImageClicked: boolean): string {
  if (credits < 300) return hasImageClicked ? 'openai/gpt-5-nano' : 'amazon/nova-lite-v1';
  return hasImageClicked ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'deepseek/deepseek-v4-flash';
}
function getDefaultMainChatModel(credits: number): string {
  return credits < 400 ? 'qwen/qwen3.6-flash' : 'writer/palmyra-x5';
}

// ─── Lens system ───
const LENS_SYSTEM: Record<string, string> = {
  jung: "You are a Jungian dream analyst. Interpret through Jung's analytical psychology: archetypes, shadow, anima/animus, individuation, collective unconscious. Be warm, depth-oriented. 2-3 paragraphs.",
  laozi: "You are Laozi, author of the Dao De Jing. Interpret through Daoist philosophy: Dao, Wu Wei, Yin-Yang, Qi, Ziran. Use nature metaphors. Be poetic, paradoxical, gentle. 2-3 paragraphs.",
  paul: "You are the Apostle Paul. Interpret through Pauline theology: faith, grace, Body of Christ, spiritual gifts. Be passionate, pastoral, theologically deep. 2-3 paragraphs.",
  valentinus: "You are Valentinus, 2nd-century Gnostic teacher. Interpret through Gnostic cosmology: Pleroma, Aeons, Sophia's fall, divine spark, gnosis. Be mystical, cosmological, poetic. 2-3 paragraphs.",
  odin: "You are Odin, the Allfather of Norse mythology. Interpret through Norse wisdom: runes, fate (wyrd), sacrifice for wisdom, the nine worlds, Yggdrasil. Be stern but wise, cryptic, poetic. 2-3 paragraphs.",
  horus: "You are Horus, the Egyptian sky god. Interpret through Egyptian cosmology: Ma'at, the Eye of Horus, the journey of the sun, the weighing of the heart, the Duat. Be regal, protective, visionary. 2-3 paragraphs.",
  benjaminfranklin: "You are Benjamin Franklin. Interpret through virtue, pragmatism, self-improvement, Enlightenment reason. Reference Franklin's 13 virtues. Be witty, practical, moral. 2-3 paragraphs.",
  napoleon: "You are Napoleon Bonaparte. Interpret through ambition, strategy, willpower, destiny, the art of war. Be commanding, analytical, intense. 2-3 paragraphs.",
};

// ─── Router ───
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '*';
    const path = url.pathname.replace('/api', '');
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

    // ─── Ensure tables exist ───
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS dream_symbols (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, dream_id INTEGER NOT NULL, symbol TEXT NOT NULL, meaning TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)').run();
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS dream_moods (id INTEGER PRIMARY KEY AUTOINCREMENT, dream_id INTEGER NOT NULL, mood_before INTEGER DEFAULT 5, mood_after INTEGER DEFAULT 5, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)').run();
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS main_chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, hidden INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)').run();
    } catch {}

    // ─── Admin + password reset ───
    const adminCheck = await env.DB.prepare('SELECT id, password_hash FROM users WHERE username = ?').bind('admin').first<{ id: number; password_hash: string }>();
    if (adminCheck && adminCheck.password_hash === 'ADMIN_PLACEHOLDER') {
      await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword('heyouadmin', env.JWT_SECRET), adminCheck.id).run();
    }
    const allUsers = await env.DB.prepare('SELECT id, username, password_hash FROM users WHERE password_hash LIKE "%.%"').all<{ id: number; username: string; password_hash: string }>();
    for (const u of allUsers.results) {
      await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind('RESET_REQUIRED', u.id).run();
    }

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
      // ═══ PUBLIC ROUTES ═══
      if (path.startsWith('/images/') && req.method === 'GET') {
        const key = path.replace('/images/', '');
        const object = await env.R2.get(key);
        if (!object) return json({ error: 'Image not found' }, 404, origin);
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('Cache-Control', 'public, max-age=31536000');
        return new Response(object.body, { headers });
      }

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
        const result = await env.DB.prepare('INSERT INTO users (username, password_hash, totp_secret, credits) VALUES (?, ?, ?, 3)').bind(username, hash, totpSecret).run();
        const token = await signJWT({ userId: result.meta.last_row_id, username }, env.JWT_SECRET);
        return json({ token, username, credits: 3, totpSecret, totpEnabled: false }, 200, origin);
      }

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

      if (path === '/auth/check-username' && req.method === 'GET') {
        const username = url.searchParams.get('username') || '';
        if (username.length < 3) return json({ available: false, error: 'Username min 3 chars' }, 200, origin);
        const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
        return json({ available: !existing }, 200, origin);
      }

      if (path === '/auth/forgot-password' && req.method === 'POST') {
        const b = await req.json() as any;
        const { username, totpCode } = b;
        if (!username || !totpCode) return json({ error: 'Username and TOTP code required' }, 400, origin);
        const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<any>();
        if (!user) return json({ error: 'User not found' }, 404, origin);
        if (!user.totp_enabled || !user.totp_secret) return json({ error: 'TOTP not enabled' }, 400, origin);
        if (!await verifyTOTP(user.totp_secret, totpCode)) return json({ error: 'Invalid TOTP code' }, 401, origin);
        const resetToken = await signJWT({ userId: user.id, username: user.username, purpose: 'password_reset' }, env.JWT_SECRET);
        return json({ resetToken, message: 'TOTP verified.' }, 200, origin);
      }

      if (path === '/auth/reset-password' && req.method === 'POST') {
        const b = await req.json() as any;
        const { resetToken, newPassword } = b;
        if (!resetToken || !newPassword) return json({ error: 'Reset token and new password required' }, 400, origin);
        if (newPassword.length < 6) return json({ error: 'Password min 6 chars' }, 400, origin);
        const payload = await verifyJWT(resetToken, env.JWT_SECRET);
        if (!payload || payload.purpose !== 'password_reset') return json({ error: 'Invalid reset token' }, 401, origin);
        const hash = await hashPassword(newPassword, env.JWT_SECRET);
        await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, payload.userId).run();
        return json({ message: 'Password reset successful.' }, 200, origin);
      }

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
        } catch {}
        return json({ received: true }, 200, origin);
      }

      // ═══ PROTECTED ROUTES ═══
      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      const user = await auth();
      if (!user) return json({ error: 'Unauthorized' }, 401, origin);

      if (path === '/user/profile' && req.method === 'GET') {
        return json({ username: user.username, credits: user.credits, isAdmin: user.isAdmin }, 200, origin);
      }

      if (path === '/user/totp/setup' && (req.method === 'GET' || req.method === 'POST')) {
        try {
          const u = await env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(user.userId).first<any>();
          let secret = u?.totp_secret;
          if (!secret) { secret = generateTOTPSecret(); await env.DB.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').bind(secret, user.userId).run(); }
          const uri = `otpauth://totp/Dreamweaver:${user.username}?secret=${secret}&issuer=Dreamweaver`;
          return json({ secret, uri }, 200, origin);
        } catch (e) { return json({ error: 'TOTP setup failed' }, 500, origin); }
      }

      if (path === '/user/totp/enable' && req.method === 'POST') {
        const b = await req.json() as any;
        const u = await env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(user.userId).first<any>();
        if (!u) return json({ error: 'No TOTP secret' }, 400, origin);
        if (!await verifyTOTP(u.totp_secret, b.code)) return json({ error: 'Invalid code' }, 400, origin);
        await env.DB.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').bind(user.userId).run();
        return json({ success: true }, 200, origin);
      }

      if (path === '/user/totp/disable' && req.method === 'POST') {
        const b = await req.json() as any;
        const u = await env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(user.userId).first<any>();
        if (!u) return json({ error: 'No TOTP secret' }, 400, origin);
        if (!await verifyTOTP(u.totp_secret, b.code)) return json({ error: 'Invalid code' }, 400, origin);
        await env.DB.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').bind(user.userId).run();
        return json({ success: true }, 200, origin);
      }

      // ─── DREAMS ───

      if (path === '/dreams' && req.method === 'GET') {
        const dreams = await env.DB.prepare('SELECT id, title, summary, created_at FROM dreams WHERE user_id = ? ORDER BY created_at DESC').bind(user.userId).all();
        return json({ dreams: dreams.results }, 200, origin);
      }

      if (path.match(/^\/dreams\/\d+$/) && req.method === 'GET') {
        const dreamId = parseInt(path.split('/')[2]);
        const dream = await env.DB.prepare('SELECT * FROM dreams WHERE id = ? AND user_id = ?').bind(dreamId, user.userId).first();
        if (!dream) return json({ error: 'Not found' }, 404, origin);
        const messages = await env.DB.prepare('SELECT * FROM dream_messages WHERE dream_id = ? ORDER BY created_at ASC').bind(dreamId).all();
        return json({ dream, messages: messages.results }, 200, origin);
      }

      // NEW DREAM — text-only=-2cr, text+images=-3cr
      if (path === '/dreams' && req.method === 'POST') {
        const b = await req.json() as any;
        const { text, mode, lens, mood_before, mood_after } = b;
        const cost = mode === 'text_and_images' ? 3 : 2;
        if (user.credits < cost) return json({ error: 'Not enough credits', needed: cost, have: user.credits }, 402, origin);

        const dreamTitle = text.substring(0, 60) + (text.length > 60 ? '...' : '');
        const dreamResult = await env.DB.prepare('INSERT INTO dreams (user_id, title) VALUES (?, ?)').bind(user.userId, dreamTitle).run();
        const dreamId = dreamResult.meta.last_row_id;
        await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content) VALUES (?, ?, ?)').bind(dreamId, 'user', text).run();

        const model = getDefaultInitModel(user.credits);
        const systemPrompt = LENS_SYSTEM[lens] || LENS_SYSTEM['jung'];
        let interpretation = await callOpenRouter(env.OPENROUTER_API_KEY, model, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ]);

        if (!interpretation || interpretation.trim().length < 10) {
          interpretation = await callOpenRouter(env.OPENROUTER_API_KEY, 'qwen/qwen3.5-flash-02-23', [
            { role: 'system', content: 'You are a dream interpreter. Analyze the dream symbolically and psychologically. Be insightful but concise (200-400 words).' },
            { role: 'user', content: text },
          ]);
        }
        if (!interpretation || interpretation.trim().length < 10) {
          interpretation = 'The dream speaks to your inner journey. The symbols carry personal meaning that resonates with your current life situation.';
        }

        await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content, type) VALUES (?, ?, ?, ?)').bind(dreamId, 'assistant', interpretation, 'interpretation').run();

        // Store mood
        if (mood_before !== undefined) {
          try { await env.DB.prepare('INSERT INTO dream_moods (dream_id, mood_before, mood_after) VALUES (?, ?, ?)').bind(dreamId, mood_before || 5, mood_after || 5).run(); } catch {}
        }

        // Extract symbols from interpretation
        let extractedSymbols: { symbol: string; meaning: string }[] = [];
        try {
          const symbolPrompt = `Extract dream symbols from this interpretation. Return JSON array only: [{"symbol":"...","meaning":"..."}]. Max 5 symbols.\n\nInterpretation: ${interpretation.substring(0, 500)}`;
          const symbolResponse = await callOpenRouter(env.OPENROUTER_API_KEY, model, [
            { role: 'system', content: 'You extract dream symbols. Return JSON array only.' },
            { role: 'user', content: symbolPrompt },
          ]);
          if (symbolResponse) {
            const jsonMatch = symbolResponse.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              extractedSymbols = JSON.parse(jsonMatch[0]);
            }
          }
        } catch (e) { console.error('Symbol extraction failed:', e); }

        for (const sym of extractedSymbols) {
          if (sym.symbol) {
            try {
              await env.DB.prepare('INSERT INTO dream_symbols (user_id, dream_id, symbol, meaning) VALUES (?, ?, ?, ?)')
                .bind(user.userId, dreamId, sym.symbol, sym.meaning || '').run();
            } catch {}
          }
        }

        // Generate images if requested (2 images per generation)
        let imageUrls: string[] = [];
        if (mode === 'text_and_images') {
          const ts = Date.now();
          for (let i = 0; i < 2; i++) {
            let imgUrl = await generateImage(env, text.substring(0, 200), dreamId, i, ts);
            // Retry once if failed
            if (!imgUrl) {
              console.log(`Image ${i} failed, retrying...`);
              await new Promise(r => setTimeout(r, 1000));
              imgUrl = await generateImage(env, text.substring(0, 200), dreamId, i, ts + 1);
            }
            if (imgUrl) imageUrls.push(imgUrl);
          }
          if (imageUrls.length > 0) {
            await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content, type, image_urls) VALUES (?, ?, ?, ?, ?)')
              .bind(dreamId, 'assistant', 'I generated these images based on your dream:', 'image_generation', JSON.stringify(imageUrls)).run();
          }
        }

        await env.DB.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').bind(cost, user.userId).run();
        const summary = interpretation.substring(0, 100) + '...';
        await env.DB.prepare('UPDATE dreams SET summary = ? WHERE id = ?').bind(summary, dreamId).run();

        return json({ dreamId, interpretation, imageUrls, creditsLeft: user.credits - cost }, 200, origin);
      }

      // CONTINUE DREAM — text→text=-1, text→images=-3, image→text=-2, image→images=-4
      if (path.match(/^\/dreams\/\d+\/messages$/) && req.method === 'POST') {
        const dreamId = parseInt(path.split('/')[2]);
        const b = await req.json() as any;
        const { text, selectedImage, mode } = b;
        let cost = 1;
        if (mode === 'text_with_image_ref') cost = 2;
        else if (mode === 'text_with_new_image') cost = 3;
        else if (mode === 'text_image_and_gen') cost = 4;
        if (user.credits < cost) return json({ error: 'Not enough credits', needed: cost, have: user.credits }, 402, origin);

        const dream = await env.DB.prepare('SELECT id FROM dreams WHERE id = ? AND user_id = ?').bind(dreamId, user.userId).first();
        if (!dream) return json({ error: 'Not found' }, 404, origin);

        await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content) VALUES (?, ?, ?)').bind(dreamId, 'user', text).run();

        const history = await env.DB.prepare('SELECT role, content FROM dream_messages WHERE dream_id = ? ORDER BY created_at ASC LIMIT 20').bind(dreamId).all();
        const model = getDefaultDreamChatModel(user.credits, !!selectedImage);

        let interpretation = await callOpenRouter(env.OPENROUTER_API_KEY, model, [
          { role: 'system', content: 'You are a dream interpreter continuing a conversation about a dream. Reference previous context. Be insightful and concise (150-300 words).' },
          ...(history.results as any[]).map(m => ({ role: m.role, content: m.content })),
        ]);

        if (!interpretation || interpretation.trim().length < 10) {
          interpretation = await callOpenRouter(env.OPENROUTER_API_KEY, 'qwen/qwen3.5-flash-02-23', [
            { role: 'system', content: 'You are a dream interpreter. Provide symbolic and psychological interpretation. Be insightful and concise (150-300 words).' },
            { role: 'user', content: text },
          ]);
        }
        if (!interpretation || interpretation.trim().length < 10) {
          interpretation = 'I apologize, but I encountered an error processing your request. Please try again.';
        }

        await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content, type) VALUES (?, ?, ?, ?)').bind(dreamId, 'assistant', interpretation, 'chat').run();

        // Handle image generation for chat
        let imageUrls: string[] = [];
        if (mode === 'text_image_and_gen' || mode === 'text_with_new_image') {
          // Delete old images first
          const oldImageUrls = await getDreamImageUrls(env, dreamId);
          for (const oldUrl of oldImageUrls) {
            await deleteImageFromR2(env, oldUrl);
          }
          await env.DB.prepare('DELETE FROM dream_messages WHERE dream_id = ? AND type = ?').bind(dreamId, 'image_generation').run();
          // Generate new images
          const ts = Date.now();
          for (let i = 0; i < 2; i++) {
            let imgUrl = await generateImage(env, text.substring(0, 200), dreamId, i, ts);
            // Retry once if failed
            if (!imgUrl) {
              console.log(`Chat image ${i} failed, retrying...`);
              await new Promise(r => setTimeout(r, 1000));
              imgUrl = await generateImage(env, text.substring(0, 200), dreamId, i, ts + 1);
            }
            if (imgUrl) imageUrls.push(imgUrl);
          }
          if (imageUrls.length > 0) {
            await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content, type, image_urls) VALUES (?, ?, ?, ?, ?)')
              .bind(dreamId, 'assistant', 'New images generated:', 'image_generation', JSON.stringify(imageUrls)).run();
          }
        } else if (selectedImage) {
          // User selected an image — keep only selected, delete rest
          const allDreamImages = await getDreamImageUrls(env, dreamId);
          for (const imgUrl of allDreamImages) {
            if (imgUrl !== selectedImage) await deleteImageFromR2(env, imgUrl);
          }
          await env.DB.prepare('DELETE FROM dream_messages WHERE dream_id = ? AND type = ?').bind(dreamId, 'image_generation').run();
          await env.DB.prepare('INSERT INTO dream_messages (dream_id, role, content, type, image_urls) VALUES (?, ?, ?, ?, ?)')
            .bind(dreamId, 'assistant', 'Selected image:', 'image_generation', JSON.stringify([selectedImage])).run();
        }

        await env.DB.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').bind(cost, user.userId).run();
        return json({ response: interpretation, imageUrls, creditsLeft: user.credits - cost }, 200, origin);
      }

      // ─── MAIN ORCHESTRATOR — -0.5cr per input ───
      if (path === '/main/chat' && req.method === 'POST') {
        const b = await req.json() as any;
        const { text } = b;
        if (!text) return json({ error: 'Text required' }, 400, origin);
        const cost = 0.5;
        if (user.credits < cost) return json({ error: 'Not enough credits', needed: cost, have: user.credits }, 402, origin);

        const dreams = await env.DB.prepare('SELECT id, title FROM dreams WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').bind(user.userId).all();
        let contextParts: string[] = [];
        for (const d of dreams.results as any[]) {
          const msgs = await env.DB.prepare("SELECT role, content FROM dream_messages WHERE dream_id = ? AND type != 'image_generation' ORDER BY created_at ASC LIMIT 3").bind(d.id).all();
          const msgSummary = (msgs.results as any[]).map(m => `${m.role}: ${m.content.substring(0, 200)}`).join('\n');
          contextParts.push(`Dream "${d.title}":\n${msgSummary}`);
        }
        const fullContext = contextParts.join('\n\n');
        const model = getDefaultMainChatModel(user.credits);

        let response = await callOpenRouter(env.OPENROUTER_API_KEY, model, [
          { role: 'system', content: `You are a dream analyst with access to the user's recent dream history. Reference specific dreams when relevant. Be insightful, connecting themes across dreams. Keep responses concise (200-400 words).\n\nUser's dream history:\n${fullContext}` },
          { role: 'user', content: text },
        ]);
        if (!response || response.trim().length < 10) {
          response = await callOpenRouter(env.OPENROUTER_API_KEY, 'qwen/qwen3.5-flash-02-23', [
            { role: 'system', content: 'You are a dream analyst. Be insightful and concise (200-400 words).' },
            { role: 'user', content: text },
          ]);
        }
        if (!response || response.trim().length < 10) response = 'I apologize, but I encountered an error. Please try again.';

        // Save to D1 with hidden=0
        await env.DB.prepare('INSERT INTO main_chat_messages (user_id, role, content, hidden) VALUES (?, ?, ?, 0)').bind(user.userId, 'user', text).run();
        await env.DB.prepare('INSERT INTO main_chat_messages (user_id, role, content, hidden) VALUES (?, ?, ?, 0)').bind(user.userId, 'assistant', response).run();

        await env.DB.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').bind(cost, user.userId).run();
        return json({ response, creditsLeft: user.credits - cost }, 200, origin);
      }

      // ─── MAIN CHAT HISTORY ───
      if (path === '/main/history' && req.method === 'GET') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const messages = await env.DB.prepare(
          'SELECT id, role, content, hidden, created_at FROM main_chat_messages WHERE user_id = ? AND hidden = 0 ORDER BY created_at ASC LIMIT ? OFFSET ?'
        ).bind(user.userId, limit, offset).all();
        return json({ messages: messages.results }, 200, origin);
      }

      // ─── MAIN CHAT CLEAR ───
      if (path === '/main/clear' && req.method === 'POST') {
        await env.DB.prepare('UPDATE main_chat_messages SET hidden = 1 WHERE user_id = ? AND hidden = 0').bind(user.userId).run();
        return json({ success: true }, 200, origin);
      }

      // ─── SYMBOLS ───
      if (path === '/symbols' && req.method === 'GET') {
        const symbols = await env.DB.prepare(`
          SELECT symbol, meaning, COUNT(*) as count, MIN(created_at) as first_seen, MAX(created_at) as last_seen
          FROM dream_symbols WHERE user_id = ? GROUP BY symbol ORDER BY count DESC LIMIT 50
        `).bind(user.userId).all();
        return json({ symbols: symbols.results }, 200, origin);
      }

      // ─── FORECAST (Moods) — exact copy of Consort's /api/forecast ───
      if (path === '/forecast' && req.method === 'GET') {
        const days = Math.min(parseInt(url.searchParams.get('days') || '14'), 90);
        // Join dreams with dream_moods to get mood data
        const { results } = await env.DB.prepare(`
          SELECT d.created_at, d.interpretation, dm.mood_before, dm.mood_after
          FROM dreams d
          LEFT JOIN dream_moods dm ON dm.dream_id = d.id
          WHERE d.user_id = ? AND d.created_at >= datetime('now', ?)
          ORDER BY d.created_at ASC
        `).bind(user.userId, `-${days} days`).all();

        if (!results || results.length === 0) {
          return json({ message: 'No dreams recorded in this period. Keep dreaming!', data: null, period_days: days, total_dreams: 0, top_emotions: [], mood_trend: [], top_symbols: [] }, 200, origin);
        }

        // Calculate emotion trends from stored interpretations
        const emotionCounts: Record<string, number> = {};
        const dailyMoods: Record<string, { before: number[]; after: number[] }> = {};

        for (const row of results as any[]) {
          try {
            const interp = JSON.parse(row.interpretation || '{}');
            const tone = interp.emotional_tone || 'unknown';
            emotionCounts[tone] = (emotionCounts[tone] || 0) + 1;
          } catch {}
          const date = row.created_at.slice(0, 10);
          if (!dailyMoods[date]) dailyMoods[date] = { before: [], after: [] };
          if (row.mood_before) dailyMoods[date].before.push(row.mood_before);
          if (row.mood_after) dailyMoods[date].after.push(row.mood_after);
        }

        const totalDreams = (results as any[]).length;
        const topEmotions = Object.entries(emotionCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([tone, count]) => ({ tone, count, pct: Math.round((count / totalDreams) * 100) }));

        const moodTrend = Object.entries(dailyMoods)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([date, m]) => ({
            date,
            avg_before: m.before.length ? Math.round(m.before.reduce((a, b) => a + b, 0) / m.before.length * 10) / 10 : null,
            avg_after: m.after.length ? Math.round(m.after.reduce((a, b) => a + b, 0) / m.after.length * 10) / 10 : null,
          }));

        // Top symbols from dream_symbols table
        const { results: symbolRows } = await env.DB.prepare(`
          SELECT symbol, meaning, COUNT(*) as count, MIN(created_at) as first_seen, MAX(created_at) as last_seen
          FROM dream_symbols
          WHERE user_id = ?
          GROUP BY symbol
          ORDER BY count DESC
          LIMIT 10
        `).bind(user.userId).all();

        return json({
          period_days: days,
          total_dreams: totalDreams,
          top_emotions: topEmotions,
          mood_trend: moodTrend,
          top_symbols: symbolRows,
        }, 200, origin);
      }

      // ─── MOODS (raw data for backward compat) ───
      if (path === '/moods' && req.method === 'GET') {
        const moods = await env.DB.prepare(`
          SELECT dm.mood_before, dm.mood_after, dm.created_at, d.title
          FROM dream_moods dm JOIN dreams d ON dm.dream_id = d.id
          WHERE d.user_id = ? ORDER BY dm.created_at DESC LIMIT 30
        `).bind(user.userId).all();
        return json({ moods: moods.results }, 200, origin);
      }

      // ─── STRIPE ───
      if (path === '/stripe/checkout' && req.method === 'POST') {
        const b = await req.json() as any;
        const { priceId } = b;
        const sessionRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            'mode': 'payment', 'success_url': `${url.origin}/?success=true`, 'cancel_url': `${url.origin}/?canceled=true`,
            'line_items[0][price]': priceId, 'line_items[0][quantity]': '1',
            'metadata[userId]': user.userId.toString(),
            'metadata[credits]': priceId === env.CREDIT_30_PRICE_ID ? '30' : priceId === env.CREDIT_100_PRICE_ID ? '100' : '300',
          }).toString(),
        });
        const session = await sessionRes.json() as any;
        return json({ url: session.url }, 200, origin);
      }

      // ─── ADMIN ───
      if (path === '/admin/report' && req.method === 'GET') {
        if (!user.isAdmin) return json({ error: 'Forbidden' }, 403, origin);
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
        const startDate = startOfMonth.toISOString().split('T')[0];
        const endDate = endOfMonth.toISOString().split('T')[0];
        const byRegion = await env.DB.prepare(`SELECT u.country, COUNT(d.id) as dream_count FROM dreams d JOIN users u ON d.user_id = u.id WHERE d.created_at BETWEEN ? AND ? GROUP BY u.country ORDER BY dream_count DESC`).bind(startDate, endDate).all();
        const topUsers = await env.DB.prepare(`SELECT u.username, COUNT(d.id) as dream_count FROM dreams d JOIN users u ON d.user_id = u.id WHERE d.created_at BETWEEN ? AND ? GROUP BY u.id ORDER BY dream_count DESC LIMIT 10`).bind(startDate, endDate).all();
        return json({ period: { start: startDate, end: endDate }, byRegion: byRegion.results, topUsers: topUsers.results }, 200, origin);
      }

      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      return env.ASSETS.fetch(req);

    } catch (err: any) {
      return json({ error: err.message || 'Server error' }, 500, origin);
    }
  },
};
