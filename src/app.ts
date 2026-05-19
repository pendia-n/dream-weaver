// TYPES
interface User { username: string; credits: number; totpEnabled: boolean; isAdmin: boolean; }
interface Dream { id: number; title: string; summary: string; created_at: string; }
interface DreamMessage { id: number; role: string; content: string; type: string; image_urls: string; created_at: string; }

const API = '';
let token = localStorage.getItem('dw_token') || '';

async function api(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...opts.headers },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    console.error('Non-JSON from', path, ':', text.substring(0, 200));
    throw new Error('Server returned invalid response (status ' + res.status + ')');
  }
  if (!res.ok) throw new Error(data.error || 'Error');
  return data;
}

let currentUser: User | null = null;
let currentDream: Dream | null = null;
let currentMessages: DreamMessage[] = [];
let selectedImage: string | null = null;
let _currentView = 'home';
let _mainTab = 'chat';
let _mainChatHistory: { role: string; content: string }[] = [];
let _mainChatOffset = 0;

const app = document.getElementById('app')!;

const LENSES = [
  { id: 'jung', name: 'Jung', emoji: '🔮', desc: 'Archetypes, shadow, individuation' },
  { id: 'laozi', name: 'Laozi', emoji: '☯️', desc: 'Dao, Wu Wei, natural flow' },
  { id: 'paul', name: 'Paul', emoji: '✝️', desc: 'Faith, grace, spiritual journey' },
  { id: 'valentinus', name: 'Valentinus', emoji: '✨', desc: 'Gnosis, divine spark, awakening' },
  { id: 'odin', name: 'Odin', emoji: '🐺', desc: 'Wisdom, sacrifice, runes, fate' },
  { id: 'horus', name: 'Horus', emoji: '🦅', desc: 'Sky, kingship, protection, vision' },
  { id: 'benjaminfranklin', name: 'Benjamin Franklin', emoji: '⚡', desc: 'Virtue, pragmatism, self-improvement' },
  { id: 'napoleon', name: 'Napoleon', emoji: '👑', desc: 'Ambition, strategy, willpower, destiny' },
];

function render() {
  if (!token) return renderAuth();
  if (!currentUser) return renderLoading();
  switch (_currentView) {
    case 'home': return renderHome();
    case 'new-dream': return renderNewDream();
    case 'dream': return renderDream();
    case 'history': return renderHistory();
    case 'credits': return renderCredits();
    case 'settings': return renderSettings();
    case 'admin': return renderAdmin();
    case 'main': return renderMain();
    default: return renderHome();
  }
}

function renderLoading() { app.innerHTML = '<div class="loading"><div class="spinner"></div></div>'; }

// ═══════════════════════════════════
// AUTH
// ═══════════════════════════════════
function renderAuth() {
  app.innerHTML = '<div class="auth-container"><div class="auth-box"><div class="auth-logo">🌙</div><h1>Dreamweaver</h1><p class="tagline">Interpret your dreams with AI through the lenses of history\'s great minds</p><div class="auth-tabs"><button class="auth-tab active" id="tab-login">Login</button><button class="auth-tab" id="tab-register">Register</button></div><div id="auth-form"></div><div id="auth-links" style="margin-top:12px"></div></div></div>';
  document.getElementById('tab-login')!.onclick = () => { authMode = 'login'; totpRequired = false; renderAuthForm(); };
  document.getElementById('tab-register')!.onclick = () => { authMode = 'register'; totpRequired = false; renderAuthForm(); };
  renderAuthForm();
}

let authMode = 'login';
let totpRequired = false;
let usernameCheckTimer: any = null;

function checkUsername(username: string) {
  if (username.length < 3) { updateUsernameStatus(false, 'min 3 chars'); return; }
  fetch('/api/auth/check-username?username=' + encodeURIComponent(username)).then(r => r.json()).then(d => { updateUsernameStatus(d.available, d.error); }).catch(() => { updateUsernameStatus(false, 'check failed'); });
}

function updateUsernameStatus(available: boolean, error?: string) {
  const el = document.getElementById('username-status');
  if (!el) return;
  if (error && !available) { el.textContent = '✗ ' + error; el.style.color = '#e74c3c'; }
  else if (available) { el.textContent = '✓ Available'; el.style.color = '#27ae60'; }
  else { el.textContent = '✗ Taken'; el.style.color = '#e74c3c'; }
}

function renderAuthForm() {
  const form = document.getElementById('auth-form');
  if (!form) return;
  const totpInput = totpRequired ? '<input type="text" id="auth-totp" placeholder="TOTP Code" maxlength="6" />' : '';
  const btnText = authMode === 'login' ? 'Login' : 'Register';
  form.innerHTML = '<input type="text" id="auth-user" placeholder="Username" autocomplete="username" /><span id="username-status" style="font-size:0.8em;display:block;margin:-8px 0 8px 4px;min-height:1.2em"></span><input type="password" id="auth-pass" placeholder="Password" autocomplete="current-password" />' + totpInput + '<button class="btn-primary" id="auth-btn">' + btnText + '</button><p id="auth-error" class="error"></p>';
  if (authMode === 'register') {
    document.getElementById('auth-user')!.addEventListener('input', function(this: HTMLInputElement) {
      const val = this.value.trim();
      if (usernameCheckTimer) clearTimeout(usernameCheckTimer);
      const el = document.getElementById('username-status')!;
      if (val.length < 3) { el.textContent = ''; return; }
      el.textContent = 'Checking...'; el.style.color = '#f39c12';
      usernameCheckTimer = setTimeout(() => checkUsername(val), 300);
    });
  }
  document.getElementById('auth-btn')!.onclick = handleAuth;
  const links = document.getElementById('auth-links');
  if (links) {
    links.innerHTML = authMode === 'login' ? '<a href="#" id="forgot-pw-link" style="color:var(--text-dim);font-size:0.85em">Forgot password?</a>' : '';
    const fpLink = document.getElementById('forgot-pw-link');
    if (fpLink) fpLink.onclick = (e) => { e.preventDefault(); renderForgotPassword(); };
  }
}

function renderForgotPassword() {
  app.innerHTML = '<div class="auth-container"><div class="auth-box"><h1>🌙 Dreamweaver</h1><p class="tagline">Reset Password</p><p style="color:var(--text-dim);font-size:0.85em;margin-bottom:16px">Enter your username and TOTP code.</p><div id="auth-form"></div><div id="auth-links" style="margin-top:12px"><a href="#" id="back-login" style="color:var(--text-dim);font-size:0.85em">← Back to Login</a></div></div></div>';
  document.getElementById('back-login')!.onclick = (e) => { e.preventDefault(); authMode = 'login'; renderAuth(); };
  const form = document.getElementById('auth-form')!;
  form.innerHTML = '<input type="text" id="forgot-user" placeholder="Username" /><input type="text" id="forgot-totp" placeholder="TOTP Code" maxlength="6" /><button class="btn-primary" id="forgot-btn">Verify Identity</button><p id="forgot-error" class="error"></p><p id="forgot-success" style="color:#27ae60"></p>';
  document.getElementById('forgot-btn')!.onclick = handleForgotPassword;
}

async function handleForgotPassword() {
  const username = (document.getElementById('forgot-user') as HTMLInputElement).value.trim();
  const totpCode = (document.getElementById('forgot-totp') as HTMLInputElement).value.trim();
  const err = document.getElementById('forgot-error')!;
  const success = document.getElementById('forgot-success')!;
  err.textContent = ''; success.textContent = '';
  if (!username || !totpCode) { err.textContent = 'Username and TOTP code required'; return; }
  try {
    const data = await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ username, totpCode }) });
    renderResetPassword(data.resetToken);
  } catch (e: any) { err.textContent = e.message; }
}

function renderResetPassword(resetToken: string) {
  app.innerHTML = '<div class="auth-container"><div class="auth-box"><h1>🌙 Dreamweaver</h1><p class="tagline">Set New Password</p><p style="color:#27ae60;font-size:0.85em;margin-bottom:16px">✓ Identity verified.</p><div id="auth-form"></div><div id="auth-links" style="margin-top:12px"><a href="#" id="back-login" style="color:var(--text-dim);font-size:0.85em">← Back to Login</a></div></div></div>';
  document.getElementById('back-login')!.onclick = (e) => { e.preventDefault(); authMode = 'login'; renderAuth(); };
  const form = document.getElementById('auth-form')!;
  form.innerHTML = '<input type="password" id="reset-pass" placeholder="New Password (min 6 chars)" /><input type="password" id="reset-pass-confirm" placeholder="Confirm New Password" /><button class="btn-primary" id="reset-btn">Reset Password</button><p id="reset-error" class="error"></p>';
  document.getElementById('reset-btn')!.onclick = async function() {
    const pass = (document.getElementById('reset-pass') as HTMLInputElement).value;
    const pass2 = (document.getElementById('reset-pass-confirm') as HTMLInputElement).value;
    const err = document.getElementById('reset-error')!;
    err.textContent = '';
    if (pass.length < 6) { err.textContent = 'Password min 6 chars'; return; }
    if (pass !== pass2) { err.textContent = 'Passwords do not match'; return; }
    try { await api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ resetToken, newPassword: pass }) }); alert('Password reset successful!'); authMode = 'login'; renderAuth(); } catch (e: any) { err.textContent = e.message; }
  };
}

async function handleAuth() {
  const username = (document.getElementById('auth-user') as HTMLInputElement).value;
  const password = (document.getElementById('auth-pass') as HTMLInputElement).value;
  const totpEl = document.getElementById('auth-totp') as HTMLInputElement;
  const totpCode = totpEl ? totpEl.value : '';
  const err = document.getElementById('auth-error');
  if (err) err.textContent = '';
  try {
    if (authMode === 'register') {
      const data = await api('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) });
      token = data.token; localStorage.setItem('dw_token', token);
      currentUser = { username: data.username, credits: data.credits, totpEnabled: false, isAdmin: false };
      if (data.totpSecret) showTOTPSecret(data.totpSecret, null);
      else { _currentView = 'home'; render(); }
    } else {
      const body: any = { username, password };
      if (totpRequired && totpCode) body.totpCode = totpCode;
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify(body) });
      if (data.totpRequired && !totpCode) { totpRequired = true; renderAuthForm(); return; }
      token = data.token; localStorage.setItem('dw_token', token);
      currentUser = { username: data.username, credits: data.credits, totpEnabled: data.totpEnabled, isAdmin: data.isAdmin };
      totpRequired = false; _currentView = 'home'; render();
    }
  } catch (e: any) {
    if (e.message.includes('TOTP')) { totpRequired = true; renderAuthForm(); }
    if (err) err.textContent = e.message;
  }
}

function showTOTPSecret(secret: string, uri: string | null) {
  const qrUri = uri || 'otpauth://totp/Dreamweaver:' + (currentUser?.username || '') + '?secret=' + secret + '&issuer=Dreamweaver';
  const qrImgUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(qrUri);
  app.innerHTML = '<div class="auth-container"><div class="auth-box"><h2>Setup 2FA</h2><p>Scan this QR code with your authenticator app:</p><div class="qr-code"><img src="' + qrImgUrl + '" alt="TOTP QR Code" /></div><p class="small">Or enter manually: <code>' + secret + '</code></p><input type="text" id="totp-verify" placeholder="Enter 6-digit code" maxlength="6" /><button class="btn-primary" onclick="verifyTOTP()">Verify</button><button class="btn-secondary" onclick="currentView=\'home\';render()">Skip</button></div></div>';
}

async function verifyTOTP() {
  const code = (document.getElementById('totp-verify') as HTMLInputElement).value;
  try { await api('/user/totp/enable', { method: 'POST', body: JSON.stringify({ code }) }); if (currentUser) currentUser.totpEnabled = true; _currentView = 'home'; render(); } catch (e: any) { alert(e.message); }
}

// ═══════════════════════════════════
// NAVBAR
// ═══════════════════════════════════
function navHtml(extra: string = '') {
  const isAdmin = currentUser && currentUser.isAdmin;
  return '<div class="navbar"><div class="nav-brand" onclick="currentView=\'home\';render()">🌙 Dreamweaver</div><div class="nav-links"><button onclick="currentView=\'home\';render()" class="' + (_currentView === 'home' ? 'active' : '') + '">Home</button><button onclick="currentView=\'new-dream\';render()" class="' + (_currentView === 'new-dream' ? 'active' : '') + '">New</button><button onclick="currentView=\'history\';render()" class="' + (_currentView === 'history' ? 'active' : '') + '">History</button><button onclick="currentView=\'main\';render()" class="' + (_currentView === 'main' ? 'active' : '') + '">Main</button><button onclick="currentView=\'credits\';render()" class="' + (_currentView === 'credits' ? 'active' : '') + '">Credits</button><button onclick="currentView=\'settings\';render()" class="' + (_currentView === 'settings' ? 'active' : '') + '">Settings</button>' + (isAdmin ? '<button onclick="currentView=\'admin\';render()">Admin</button>' : '') + extra + '<button onclick="logout()" class="btn-logout">Logout</button></div><div class="nav-credits">💰 ' + (currentUser ? currentUser.credits : 0) + '</div></div>';
}

// ═══════════════════════════════════
// HOME
// ═══════════════════════════════════
function renderHome() {
  app.innerHTML = navHtml() + '<div class="main-content"><div class="home-hero"><div class="hero-emoji">🌙</div><h1>Welcome, ' + (currentUser ? currentUser.username : '') + '</h1><p>Your dreams hold meaning. Let AI help you understand them through the lenses of history\'s great minds.</p><button class="btn-primary btn-large" onclick="currentView=\'new-dream\';render()">✨ New Dream Session</button></div><div class="home-actions"><div class="action-card" onclick="currentView=\'history\';render()"><div class="action-emoji">📜</div><h3>History</h3><p>Review past dream interpretations</p></div><div class="action-card" onclick="currentView=\'main\';render()"><div class="action-emoji">🔮</div><h3>Main Orchestrator</h3><p>Chat with AI across all your dreams</p></div><div class="action-card" onclick="currentView=\'credits\';render()"><div class="action-emoji">💰</div><h3>Buy Credits</h3><p>Get more credits for interpretations</p></div></div></div>';
}

function logout() { token = ''; currentUser = null; localStorage.removeItem('dw_token'); _currentView = 'home'; _mainChatHistory = []; _mainChatOffset = 0; render(); }

// ═══════════════════════════════════
// NEW DREAM
// ═══════════════════════════════════
function renderNewDream() {
  const lensOptions = LENSES.map(l => '<label class="lens-option"><input type="radio" name="lens" value="' + l.id + '" ' + (l.id === 'jung' ? 'checked' : '') + ' /><span class="lens-emoji">' + l.emoji + '</span><span class="lens-info"><strong>' + l.name + '</strong><span>' + l.desc + '</span></span></label>').join('');
  app.innerHTML = navHtml() + '<div class="main-content"><div class="dream-container"><div class="section-header"><h2>✨ Describe Your Dream</h2><p class="hint">Write or speak your dream. Choose an interpretation lens and mood.</p></div><div class="input-area"><textarea id="dream-input" placeholder="I was walking through a forest..." rows="6"></textarea><div class="input-actions"><button class="btn-voice" id="voice-btn" onclick="toggleVoice()">🎤 Voice Input</button><span id="voice-status"></span></div></div><div class="mood-row"><div class="mood-group"><label>Mood Before Sleep</label><input type="range" id="mood-before" min="1" max="10" value="5" oninput="document.getElementById(\'mood-before-val\').textContent=this.value" /><span id="mood-before-val">5</span>/10</div><div class="mood-group"><label>Mood After Waking</label><input type="range" id="mood-after" min="1" max="10" value="5" oninput="document.getElementById(\'mood-after-val\').textContent=this.value" /><span id="mood-after-val">5</span>/10</div></div><div class="lens-selector"><label>Interpretation Lens</label><div class="lens-grid">' + lensOptions + '</div></div><div class="mode-selector"><p>Response mode:</p><div class="mode-options"><label class="mode-option"><input type="radio" name="dream-mode" value="text_only" checked /><div class="mode-info"><strong>Text Only</strong><span>2 credits</span></div></label><label class="mode-option"><input type="radio" name="dream-mode" value="text_and_images" /><div class="mode-info"><strong>Text + 2 Images</strong><span>3 credits</span></div></label></div></div><button class="btn-primary btn-large" id="submit-dream" onclick="submitDream()">Interpret Dream</button><p id="dream-error" class="error"></p></div></div>';
}

let isRecording = false;
let recognition: any = null;

function toggleVoice() {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) { alert('Speech recognition not supported.'); return; }
  if (isRecording) { recognition.stop(); isRecording = false; document.getElementById('voice-btn')!.textContent = '🎤 Voice Input'; document.getElementById('voice-status')!.textContent = ''; return; }
  recognition = new SR(); recognition.continuous = true; recognition.interimResults = true;
  recognition.onresult = function(e: any) { let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; (document.getElementById('dream-input') as HTMLTextAreaElement).value = t; document.getElementById('voice-status')!.textContent = '🔴 Recording...'; };
  recognition.onerror = function() { isRecording = false; document.getElementById('voice-btn')!.textContent = '🎤 Voice Input'; document.getElementById('voice-status')!.textContent = 'Error'; };
  recognition.onend = function() { isRecording = false; document.getElementById('voice-btn')!.textContent = '🎤 Voice Input'; document.getElementById('voice-status')!.textContent = 'Done'; };
  recognition.start(); isRecording = true; document.getElementById('voice-btn')!.textContent = '⏹ Stop'; document.getElementById('voice-status')!.textContent = '🎤 Listening...';
}

async function submitDream() {
  const text = (document.getElementById('dream-input') as HTMLTextAreaElement).value.trim();
  if (!text) { alert('Please describe your dream'); return; }
  const lensEl = document.querySelector('input[name="lens"]:checked') as HTMLInputElement;
  const lens = lensEl ? lensEl.value : 'jung';
  const moodBefore = parseInt((document.getElementById('mood-before') as HTMLInputElement).value);
  const moodAfter = parseInt((document.getElementById('mood-after') as HTMLInputElement).value);
  const modeEl = document.querySelector('input[name="dream-mode"]:checked') as HTMLInputElement;
  const mode = modeEl ? modeEl.value : 'text_only';
  const cost = mode === 'text_and_images' ? 3 : 2;
  if (currentUser && currentUser.credits < cost) { alert('Not enough credits. Need ' + cost + ', have ' + currentUser.credits + '. Buy more credits first.'); return; }
  const btn = document.getElementById('submit-dream') as HTMLButtonElement;
  btn.disabled = true; btn.textContent = 'Interpreting...';
  try {
    const data = await api('/dreams', { method: 'POST', body: JSON.stringify({ text, mode, lens, mood_before: moodBefore, mood_after: moodAfter }) });
    currentUser!.credits = data.creditsLeft;
    currentDream = { id: data.dreamId, title: text.substring(0, 60), summary: '', created_at: new Date().toISOString() };
    currentMessages = [
      { id: 0, role: 'user', content: text, type: '', image_urls: '', created_at: '' },
      { id: 1, role: 'assistant', content: data.interpretation, type: 'interpretation', image_urls: data.imageUrls ? JSON.stringify(data.imageUrls) : '', created_at: '' },
    ];
    selectedImage = null;
    _currentView = 'dream'; render();
  } catch (e: any) { document.getElementById('dream-error')!.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = 'Interpret Dream'; }
}

// ═══════════════════════════════════
// DREAM CHAT
// ═══════════════════════════════════
function renderDream() {
  if (!currentDream) return renderHome();
  let messagesHtml = '';
  for (const msg of currentMessages) {
    if (msg.role === 'user') {
      let dc = msg.content;
      if (dc.startsWith('[Selected image:')) { const i = dc.indexOf(']'); if (i !== -1) dc = dc.substring(i + 1).trim(); }
      messagesHtml += '<div class="msg msg-user"><div class="msg-content">' + dc + '</div></div>';
    } else {
      let imagesHtml = '';
      if (msg.image_urls) {
        try {
          const imgs = JSON.parse(msg.image_urls);
          if (Array.isArray(imgs)) {
            imagesHtml = '<div class="msg-images">';
            for (const url of imgs) {
              const sel = selectedImage === url;
              const unsel = selectedImage !== null && !sel;
              imagesHtml += '<img src="' + url + '" class="dream-img' + (sel ? ' selected' : '') + (unsel ? ' faded' : '') + '" onclick="selectImage(\'' + url + '\')" />';
            }
            imagesHtml += '</div>';
          }
        } catch {}
      }
      let contentHtml = msg.content || '<em style="color:var(--text-dim)">No response</em>';
      messagesHtml += '<div class="msg msg-ai"><div class="msg-content">' + contentHtml + '</div>' + imagesHtml + '</div>';
    }
  }
  const hasImg = !!selectedImage;
  const selImg = selectedImage || '';
  app.innerHTML = navHtml('<button onclick="currentView=\'new-dream\';render()">+ New</button>') +
    '<div class="main-content"><div class="dream-chat"><div class="dream-chat-header"><h3>' + currentDream.title + '</h3></div>' +
    '<div class="messages" id="messages">' + messagesHtml + '</div>' +
    (hasImg ? '<div class="selected-image-bar"><span>📌 Selected: <img src="' + selImg + '" class="thumb" /></span><button onclick="clearSelectedImage()">Clear</button></div>' : '') +
    '<div class="chat-input-area"><textarea id="chat-input" placeholder="Ask about your dream..." rows="3"></textarea>' +
    '<div class="chat-options">' +
    '<label><input type="radio" name="chat-mode" value="text_only" checked /> 💬 Text (1cr)</label>' +
    '<label class="' + (hasImg ? '' : 'disabled') + '"><input type="radio" name="chat-mode" value="text_with_image_ref" ' + (hasImg ? '' : 'disabled') + ' /> 📌+💬 Ref (2cr)</label>' +
    '<label><input type="radio" name="chat-mode" value="text_with_new_image" /> 💬+🖼️ Images (3cr)</label>' +
    '<label class="' + (hasImg ? '' : 'disabled') + '"><input type="radio" name="chat-mode" value="text_image_and_gen" ' + (hasImg ? '' : 'disabled') + ' /> 📌+🖼️ Ref+Img (4cr)</label>' +
    '</div><button class="btn-primary" onclick="sendChat()">Send</button></div>' +
    '<p id="chat-error" class="error"></p></div></div>';
  setTimeout(() => { const m = document.getElementById('messages'); if (m) m.scrollTop = m.scrollHeight; }, 50);
}

function selectImage(url: string) {
  selectedImage = selectedImage === url ? null : url;
  const msgsEl = document.getElementById('messages');
  const scrollPos = msgsEl ? msgsEl.scrollHeight - msgsEl.scrollTop : 0;
  renderDream();
  setTimeout(() => {
    const m = document.getElementById('messages');
    if (m) m.scrollTop = m.scrollHeight - scrollPos;
  }, 50);
}

function clearSelectedImage() { selectedImage = null; renderDream(); }

function appendMessage(msg: { role: string; content: string; type: string; image_urls: string }) {
  const msgsEl = document.getElementById('messages');
  if (!msgsEl) return;
  if (msg.role === 'user') {
    let dc = msg.content;
    if (dc.startsWith('[Selected image:')) { const i = dc.indexOf(']'); if (i !== -1) dc = dc.substring(i + 1).trim(); }
    msgsEl.innerHTML += '<div class="msg msg-user"><div class="msg-content">' + dc + '</div></div>';
  } else {
    let imagesHtml = '';
    if (msg.image_urls) {
      try {
        const imgs = JSON.parse(msg.image_urls);
        if (Array.isArray(imgs) && imgs.length > 0) {
          imagesHtml = '<div class="msg-images">';
          for (const url of imgs) {
            imagesHtml += '<img src="' + url + '" class="dream-img" onclick="selectImage(\'' + url + '\')" onerror="this.style.opacity=0.3;this.title=\'Image failed to load\'" />';
          }
          imagesHtml += '</div>';
        }
      } catch {}
    }
    let contentHtml = msg.content || '<em style="color:var(--text-dim)">No response</em>';
    msgsEl.innerHTML += '<div class="msg msg-ai"><div class="msg-content">' + contentHtml + '</div>' + imagesHtml + '</div>';
  }
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

async function sendChat() {
  const text = (document.getElementById('chat-input') as HTMLTextAreaElement).value.trim();
  if (!text) return;
  const mode = (document.querySelector('input[name="chat-mode"]:checked') as HTMLInputElement)?.value || 'text_only';
  let cost = 1; if (mode === 'text_with_image_ref') cost = 2; else if (mode === 'text_with_new_image') cost = 3; else if (mode === 'text_image_and_gen') cost = 4;
  if (currentUser && currentUser.credits < cost) { alert('Not enough credits. Need ' + cost + ', have ' + currentUser.credits + '. Buy more credits first.'); return; }
  // Additional guard: image ref modes require a selected image
  if ((mode === 'text_with_image_ref' || mode === 'text_image_and_gen') && !selectedImage) { alert('Please select an image first by clicking on it.'); return; }
  const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
  chatInput.value = '';
  const sendBtn = document.querySelector('.chat-input-area .btn-primary') as HTMLButtonElement;
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending...'; }
  chatInput.disabled = true;
  const userMsg = { id: 0, role: 'user', content: text, type: '', image_urls: '', created_at: '' };
  currentMessages.push(userMsg);
  appendMessage(userMsg);
  const msgsEl = document.getElementById('messages')!;
  const lid = 'loading-' + Date.now();
  msgsEl.innerHTML += '<div class="msg msg-ai" id="' + lid + '"><div class="msg-content"><div class="loading-indicator"><div class="spinner"></div><span>Interpreting...</span></div></div></div>';
  msgsEl.scrollTop = msgsEl.scrollHeight;
  try {
    const data = await api('/dreams/' + currentDream!.id + '/messages', { method: 'POST', body: JSON.stringify({ text, selectedImage, mode }) });
    currentUser!.credits = data.creditsLeft;
    if (data.imageUrls && data.imageUrls.length > 0) {
      currentMessages = currentMessages.filter(m => m.type !== 'image_generation');
    }
    const aiMsg = { id: 0, role: 'assistant', content: data.response, type: 'chat', image_urls: data.imageUrls ? JSON.stringify(data.imageUrls) : '', created_at: '' };
    currentMessages.push(aiMsg);
    selectedImage = null;
    const loadingEl = document.getElementById(lid);
    if (loadingEl) loadingEl.remove();
    appendMessage(aiMsg);
    const navCredits = document.querySelector('.nav-credits');
    if (navCredits) navCredits.textContent = '💰 ' + currentUser!.credits;
    const textOnlyRadio = document.querySelector('input[name="chat-mode"][value="text_only"]') as HTMLInputElement;
    if (textOnlyRadio) textOnlyRadio.checked = true;
  } catch (e: any) {
    const loadingEl = document.getElementById(lid);
    if (loadingEl) loadingEl.remove();
    document.getElementById('chat-error')!.textContent = e.message;
  } finally {
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
    chatInput.disabled = false;
    chatInput.focus();
  }
}

// ═══════════════════════════════════
// HISTORY
// ═══════════════════════════════════
async function renderHistory() {
  app.innerHTML = navHtml() + '<div class="main-content"><h2>📜 Dream History</h2><div class="loading">Loading...</div></div>';
  try {
    const data = await api('/dreams');
    let html = '';
    if (data.dreams && data.dreams.length > 0) {
      html = '<div class="dream-list">';
      for (const d of data.dreams) {
        html += '<div class="dream-card" onclick="openDream(' + d.id + ')"><h4>' + d.title + '</h4><p>' + (d.summary || '') + '</p><small>' + new Date(d.created_at).toLocaleDateString() + '</small></div>';
      }
      html += '</div>';
    } else { html = '<p>No dreams yet.</p>'; }
    app.innerHTML = navHtml() + '<div class="main-content"><h2>📜 Dream History</h2>' + html + '</div>';
  } catch (e: any) { app.innerHTML += '<p class="error">' + e.message + '</p>'; }
}

async function openDream(id: number) {
  try {
    const data = await api('/dreams/' + id);
    currentDream = data.dream; currentMessages = data.messages || []; selectedImage = null; _currentView = 'dream'; render();
  } catch (e: any) { alert(e.message); }
}

// ═══════════════════════════════════
// MAIN ORCHESTRATOR
// ═══════════════════════════════════
async function renderMain() {
  // Load chat history from D1
  try {
    const historyData = await api('/main/history?limit=50');
    if (historyData.messages && historyData.messages.length > 0) {
      _mainChatHistory = historyData.messages.map((m: any) => ({ role: m.role, content: m.content }));
    } else {
      _mainChatHistory = [];
    }
  } catch { _mainChatHistory = []; }
  _mainChatOffset = 0;

  app.innerHTML = navHtml() + '<div class="main-content"><div class="dream-chat"><div class="dream-chat-header"><h3>🔮 Main Orchestrator</h3><p style="color:var(--text-dim);font-size:0.85em">Chat across all dreams · Symbols</p></div><div class="tab-bar"><button id="tab-chat" class="' + (_mainTab === 'chat' ? 'active' : '') + '" onclick="doSwitchTab(\'chat\')">💬 Chat</button><button id="tab-symbols" class="' + (_mainTab === 'symbols' ? 'active' : '') + '" onclick="doSwitchTab(\'symbols\')">🔑 Symbols</button></div><div id="main-content-area"></div></div></div>';
  if (_mainTab === 'chat') renderMainChat();
  else if (_mainTab === 'symbols') loadSymbols();
}

function doSwitchTab(tab: string) {
  _mainTab = tab;
  var btns = document.querySelectorAll('.tab-bar button');
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
  var activeBtn = document.getElementById('tab-' + tab);
  if (activeBtn) activeBtn.classList.add('active');
  if (tab === 'chat') renderMainChat();
  else if (tab === 'symbols') loadSymbols();
}

function renderMainChat() {
  var area = document.getElementById('main-content-area');
  if (!area) return;
  var chatHtml = '';
  var startIdx = Math.max(0, _mainChatHistory.length - 8 - _mainChatOffset);
  var endIdx = _mainChatHistory.length - _mainChatOffset;
  var visibleMessages = _mainChatHistory.slice(startIdx, endIdx);
  for (const msg of visibleMessages) {
    if (msg.role === 'user') chatHtml += '<div class="msg msg-user"><div class="msg-content">' + msg.content + '</div></div>';
    else chatHtml += '<div class="msg msg-ai"><div class="msg-content">' + (msg.content || '<em>No response</em>') + '</div></div>';
  }
  if (visibleMessages.length === 0) chatHtml = '<div class="msg msg-ai"><div class="msg-content">Hello! I have access to all your dream interpretations. Ask me about patterns, themes, recurring symbols, or anything across your dreams.</div></div>';

  var visibleCount = _mainChatHistory.length - _mainChatOffset;
  var clearBtn = visibleCount > 0 ? '<button class="btn-small" onclick="clearMainChat()">Clear older (' + visibleCount + ' shown)</button>' : '';

  area.innerHTML = '<div class="messages" id="main-messages">' + chatHtml + '</div>' +
    '<div class="chat-input-area"><textarea id="main-input" placeholder="Ask about your dreams..." rows="3"></textarea>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">' +
    '<button class="btn-primary" onclick="sendMainChat()">Send (0.5cr)</button>' + clearBtn + '</div>' +
    '</div><p id="main-error" class="error"></p>';
  setTimeout(function() { var m = document.getElementById('main-messages'); if (m) m.scrollTop = m.scrollHeight; }, 50);
}

function clearMainChat() {
  try { api('/main/clear', { method: 'POST', body: JSON.stringify({}) }); } catch {}
  _mainChatOffset = _mainChatHistory.length;
  renderMainChat();
}

async function sendMainChat() {
  var text = (document.getElementById('main-input') as HTMLTextAreaElement).value.trim();
  if (!text) return;
  if (currentUser && currentUser.credits < 0.5) { alert('Need 0.5 credits. Buy more credits first.'); return; }
  _mainChatHistory.push({ role: 'user', content: text });
  (document.getElementById('main-input') as HTMLTextAreaElement).value = '';
  renderMainChat();
  try {
    var data = await api('/main/chat', { method: 'POST', body: JSON.stringify({ text }) });
    currentUser!.credits = data.creditsLeft;
    _mainChatHistory.push({ role: 'assistant', content: data.response });
    renderMainChat();
  } catch (e: any) {
    _mainChatHistory.push({ role: 'assistant', content: 'Error: ' + e.message });
    document.getElementById('main-error')!.textContent = e.message;
    renderMainChat();
  }
}

async function loadSymbols() {
  var area = document.getElementById('main-content-area');
  if (!area) { renderMain(); return; }
  area.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    var data = await api('/symbols');
    if (data.symbols && data.symbols.length > 0) {
      var html = '';
      for (var i = 0; i < data.symbols.length; i++) {
        var s = data.symbols[i];
        html += '<div style="background:var(--bg-input);border-radius:8px;padding:1rem;border:1px solid var(--border);margin-bottom:0.5rem">' +
          '<div style="display:flex;justify-content:space-between;align-items:center"><strong style="font-size:1.1rem;color:var(--primary)">' + s.symbol + '</strong>' +
          '<span style="font-size:0.8rem;color:var(--text-dim)">×' + s.count + ' · First: ' + new Date(s.first_seen).toLocaleDateString() + ' · Last: ' + new Date(s.last_seen).toLocaleDateString() + '</span></div>' +
          '<p style="color:var(--text-dim);font-size:0.9rem;margin-top:0.3rem">' + (s.meaning || '') + '</p></div>';
      }
      area.innerHTML = html;
    } else { area.innerHTML = '<p style="color:var(--text-dim)">No symbols yet. Interpret some dreams first!</p>'; }
  } catch (e: any) { area.innerHTML = '<p class="error">' + e.message + '</p>'; }
}

// ═══════════════════════════════════
// CREDITS
// ═══════════════════════════════════
function renderCredits() {
  app.innerHTML = navHtml() + '<div class="main-content"><h2>💰 Credits</h2><div class="settings-section"><h3>Balance</h3><p style="font-size:2em;font-weight:700;color:var(--warning)">' + (currentUser ? currentUser.credits : 0) + ' credits</p></div><div class="settings-section"><h3>Usage</h3><p style="color:var(--text-dim);font-size:0.85em">New dream text-only: 2cr · New dream text+images: 3cr · Chat text→text: 1cr · Chat+images: 3cr · Main chat: 0.5cr</p></div><div class="settings-section"><h3>Buy Credits</h3><div class="credit-packs"><div class="credit-pack"><h4>30 Credits</h4><p>$4.99</p><button onclick="startCheckout(\'CREDIT_30\')">Buy</button></div><div class="credit-pack"><h4>100 Credits</h4><p>$9.99</p><button onclick="startCheckout(\'CREDIT_100\')">Buy</button></div><div class="credit-pack"><h4>300 Credits</h4><p>$19.99</p><button onclick="startCheckout(\'CREDIT_300\')">Buy</button></div></div></div></div>';
}

async function startCheckout(priceId: string) {
  try { var data = await api('/stripe/checkout', { method: 'POST', body: JSON.stringify({ priceId }) }); if (data.url) window.location.href = data.url; } catch (e: any) { alert(e.message); }
}

// ═══════════════════════════════════
// SETTINGS
// ═══════════════════════════════════
function renderSettings() {
  var totpStatus = currentUser?.totpEnabled ? '<p>✅ 2FA enabled <button class="btn-small" onclick="disableTOTP()">Disable</button></p>' : '<button class="btn-primary" onclick="setupTOTP()">Setup 2FA</button>';
  app.innerHTML = navHtml() + '<div class="main-content"><h2>⚙️ Settings</h2><div class="settings-section"><h3>Account</h3><p>Username: ' + (currentUser?.username || '') + '</p><p>Credits: ' + (currentUser?.credits || 0) + '</p></div><div class="settings-section"><h3>Two-Factor Authentication</h3>' + totpStatus + '</div></div>';
}

async function setupTOTP() {
  try { var data = await api('/user/totp/setup', { method: 'GET' }); showTOTPSecret(data.secret, data.uri); } catch (e: any) { alert(e.message); }
}

async function disableTOTP() {
  var code = prompt('Enter your current TOTP code to disable 2FA:');
  if (!code) return;
  try { await api('/user/totp/disable', { method: 'POST', body: JSON.stringify({ code }) }); if (currentUser) currentUser.totpEnabled = false; alert('2FA disabled.'); render(); } catch (e: any) { alert(e.message); }
}

// ═══════════════════════════════════
// ADMIN
// ═══════════════════════════════════
async function renderAdmin() {
  if (!currentUser?.isAdmin) return renderHome();
  app.innerHTML = navHtml() + '<div class="main-content"><h2>🛡️ Admin Dashboard</h2><button class="btn-primary" onclick="loadReport()">Generate Monthly Report</button><div id="admin-report"></div></div>';
}

async function loadReport() {
  try {
    var data = await api('/admin/report');
    var html = '<div class="report"><h3>Report: ' + data.period.start + ' to ' + data.period.end + '</h3>';
    if (data.byRegion?.length) { html += '<h4>Dreams by Region</h4><ul>'; for (var r of data.byRegion) html += '<li>' + (r.country || 'Unknown') + ': ' + r.dream_count + '</li>'; html += '</ul>'; }
    if (data.topUsers?.length) { html += '<h4>Top Dreamers</h4><ol>'; for (var u of data.topUsers) html += '<li>' + u.username + ': ' + u.dream_count + '</li>'; html += '</ol>'; }
    html += '</div>';
    document.getElementById('admin-report')!.innerHTML = html;
  } catch (e: any) { document.getElementById('admin-report')!.innerHTML = '<p class="error">' + e.message + '</p>'; }
}

// ═══════════════════════════════════
// INIT
// ═══════════════════════════════════
(window as any).render = render;
(window as any).logout = logout;
Object.defineProperty(window, 'authMode', { get: function() { return authMode; }, set: function(v) { authMode = v; } });
Object.defineProperty(window, 'currentView', { get: function() { return _currentView; }, set: function(v) { _currentView = v; } });
Object.defineProperty(window, 'selectedImage', { get: function() { return selectedImage; }, set: function(v) { selectedImage = v; } });
(window as any).verifyTOTP = verifyTOTP;
(window as any).toggleVoice = toggleVoice;
(window as any).submitDream = submitDream;
(window as any).sendChat = sendChat;
(window as any).selectImage = selectImage;
(window as any).clearSelectedImage = clearSelectedImage;
(window as any).openDream = openDream;
(window as any).startCheckout = startCheckout;
(window as any).setupTOTP = setupTOTP;
(window as any).disableTOTP = disableTOTP;
(window as any).renderAdmin = renderAdmin;
(window as any).loadReport = loadReport;
(window as any).checkUsername = checkUsername;
(window as any).renderForgotPassword = renderForgotPassword;
(window as any).handleForgotPassword = handleForgotPassword;
(window as any).renderResetPassword = renderResetPassword;
(window as any).handleAuth = handleAuth;
(window as any).sendMainChat = sendMainChat;
(window as any).doSwitchTab = doSwitchTab;
(window as any).loadSymbols = loadSymbols;
(window as any).clearMainChat = clearMainChat;

async function init() {
  if (token) {
    try { var data = await api('/user/profile'); currentUser = { username: data.username, credits: data.credits, totpEnabled: false, isAdmin: data.isAdmin }; } catch { token = ''; localStorage.removeItem('dw_token'); }
  }
  render();
}
init();
