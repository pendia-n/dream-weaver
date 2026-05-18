// TYPES
interface User { username: string; credits: number; totpEnabled: boolean; isAdmin: boolean; }
interface Dream { id: number; title: string; summary: string; created_at: string; }
interface DreamMessage { id: number; role: string; content: string; type: string; image_urls: string; created_at: string; }
interface BoardPost { id: number; user_id: number; dream_id: number; username: string; title: string; content: string; comments_count: number; created_at: string; }
interface BoardComment { id: number; username: string; content: string; created_at: string; }

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
    console.error('Non-JSON response from', path, ':', text.substring(0, 200));
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
let dreamInstances: { dream: Dream; messages: DreamMessage[] }[] = [];

const app = document.getElementById('app')!;

function render() {
  if (!token) return renderAuth();
  if (!currentUser) return renderLoading();
  switch (_currentView) {
    case 'home': return renderHome();
    case 'new-dream': return renderNewDream();
    case 'dream': return renderDream();
    case 'history': return renderHistory();
    case 'board': return renderBoard();
    case 'credits': return renderCredits();
    case 'settings': return renderSettings();
    case 'admin': return renderAdmin();
    case 'main': return renderMain();
    default: return renderHome();
  }
}

function renderLoading() {
  app.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
}

// ═══════════════════════════════════
// AUTH
// ═══════════════════════════════════
function renderAuth() {
  app.innerHTML = '<div class="auth-container"><div class="auth-box"><h1>Dreamweaver</h1><p class="tagline">Interpret your dreams with AI</p><div class="auth-tabs"><button class="auth-tab active" id="tab-login">Login</button><button class="auth-tab" id="tab-register">Register</button></div><div id="auth-form"></div><div id="auth-links" style="margin-top:12px"></div></div></div>';
  document.getElementById('tab-login').onclick = () => { authMode = 'login'; totpRequired = false; renderAuthForm(); };
  document.getElementById('tab-register').onclick = () => { authMode = 'register'; totpRequired = false; renderAuthForm(); };
  renderAuthForm();
}

let authMode = 'login';
let totpRequired = false;
let usernameCheckTimer: any = null;

function checkUsername(username: string) {
  if (username.length < 3) { updateUsernameStatus(false, 'min 3 chars'); return; }
  fetch('/api/auth/check-username?username=' + encodeURIComponent(username))
    .then(r => r.json())
    .then(d => { updateUsernameStatus(d.available, d.error); })
    .catch(() => { updateUsernameStatus(false, 'check failed'); });
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

  form.innerHTML = '<input type="text" id="auth-user" placeholder="Username" autocomplete="username" />' +
    '<span id="username-status" style="font-size:0.8em;display:block;margin:-8px 0 8px 4px;min-height:1.2em"></span>' +
    '<input type="password" id="auth-pass" placeholder="Password" autocomplete="current-password" />' +
    totpInput +
    '<button class="btn-primary" id="auth-btn">' + btnText + '</button>' +
    '<p id="auth-error" class="error"></p>';

  if (authMode === 'register') {
    document.getElementById('auth-user')!.addEventListener('input', function(this: HTMLInputElement) {
      const val = this.value.trim();
      if (usernameCheckTimer) clearTimeout(usernameCheckTimer);
      const statusEl = document.getElementById('username-status')!;
      if (val.length < 3) { statusEl.textContent = ''; return; }
      statusEl.textContent = 'Checking...';
      statusEl.style.color = '#f39c12';
      usernameCheckTimer = setTimeout(() => checkUsername(val), 300);
    });
  }

  document.getElementById('auth-btn')!.onclick = handleAuth;

  const links = document.getElementById('auth-links');
  if (links) {
    if (authMode === 'login') {
      links.innerHTML = '<a href="#" id="forgot-pw-link" style="color:var(--text-dim);font-size:0.85em">Forgot password?</a>';
      document.getElementById('forgot-pw-link')!.onclick = (e) => { e.preventDefault(); renderForgotPassword(); };
    } else {
      links.innerHTML = '';
    }
  }
}

function renderForgotPassword() {
  app.innerHTML = '<div class="auth-container"><div class="auth-box"><h1>Dreamweaver</h1><p class="tagline">Reset Password</p><p style="color:var(--text-dim);font-size:0.85em;margin-bottom:16px">Enter your username and TOTP code. TOTP must be enabled.</p><div id="auth-form"></div><div id="auth-links" style="margin-top:12px"><a href="#" id="back-login" style="color:var(--text-dim);font-size:0.85em">← Back to Login</a></div></div></div>';
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
  app.innerHTML = '<div class="auth-container"><div class="auth-box"><h1>Dreamweaver</h1><p class="tagline">Set New Password</p><p style="color:#27ae60;font-size:0.85em;margin-bottom:16px">✓ Identity verified.</p><div id="auth-form"></div><div id="auth-links" style="margin-top:12px"><a href="#" id="back-login" style="color:var(--text-dim);font-size:0.85em">← Back to Login</a></div></div></div>';
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
    try {
      await api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ resetToken, newPassword: pass }) });
      alert('Password reset successful! Login with new password.');
      authMode = 'login'; renderAuth();
    } catch (e: any) { err.textContent = e.message; }
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
  // Generate QR code using a free QR API
  const qrUri = uri || `otpauth://totp/Dreamweaver:${currentUser?.username}?secret=${secret}&issuer=Dreamweaver`;
  const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUri)}`;
  app.innerHTML = '<div class="auth-container"><div class="auth-box"><h2>Setup 2FA</h2><p>Scan this QR code with your authenticator app:</p><div class="qr-code"><img src="' + qrImgUrl + '" alt="TOTP QR Code" /></div><p class="small">Or enter manually: <code>' + secret + '</code></p><input type="text" id="totp-verify" placeholder="Enter 6-digit code" maxlength="6" /><button class="btn-primary" onclick="verifyTOTP()">Verify</button><button class="btn-secondary" onclick="currentView=\'home\';render()">Skip</button></div></div>';
}

async function verifyTOTP() {
  const code = (document.getElementById('totp-verify') as HTMLInputElement).value;
  try {
    await api('/user/totp/enable', { method: 'POST', body: JSON.stringify({ code }) });
    if (currentUser) currentUser.totpEnabled = true;
    _currentView = 'home'; render();
  } catch (e: any) { alert(e.message); }
}

// ═══════════════════════════════════
// SHARED NAVBAR
// ═══════════════════════════════════
function navHtml(extra: string = '') {
  const isAdmin = currentUser && currentUser.isAdmin;
  return '<div class="navbar"><div class="nav-brand">Dreamweaver</div><div class="nav-links">' +
    '<button onclick="currentView=\'home\';render()">Home</button>' +
    '<button onclick="currentView=\'new-dream\';render()">New Dream</button>' +
    '<button onclick="currentView=\'history\';render()">History</button>' +
    '<button onclick="currentView=\'dream\';render()">Dream</button>' +
    '<button onclick="currentView=\'board\';render()">Board</button>' +
    '<button onclick="currentView=\'main\';render()">Main</button>' +
    (isAdmin ? '<button onclick="currentView=\'admin\';render()">Admin</button>' : '') +
    '<button onclick="currentView=\'credits\';render()">Credits</button>' +
    '<button onclick="currentView=\'settings\';render()">Settings</button>' +
    extra +
    '<button onclick="logout()">Logout</button></div>' +
    '<div class="nav-credits">Credits: ' + (currentUser ? currentUser.credits : 0) + '</div></div>';
}

// ═══════════════════════════════════
// HOME
// ═══════════════════════════════════
function renderHome() {
  app.innerHTML = navHtml() + '<div class="main-content"><div class="home-hero"><h1>Welcome, ' + (currentUser ? currentUser.username : '') + '</h1><p>Your dreams hold meaning. Let AI help you understand them.</p><button class="btn-primary btn-large" onclick="currentView=\'new-dream\';render()">New Dream Session</button></div><div class="home-actions"><div class="action-card" onclick="currentView=\'history\';render()"><h3>History</h3><p>Review past dream interpretations</p></div><div class="action-card" onclick="currentView=\'board\';render()"><h3>Community Board</h3><p>Share dreams and discuss</p></div><div class="action-card" onclick="currentView=\'main\';render()"><h3>Main Orchestrator</h3><p>Chat with AI across all your dreams</p></div><div class="action-card" onclick="currentView=\'credits\';render()"><h3>Buy Credits</h3><p>Get more credits for interpretations</p></div></div></div>';
}

function logout() {
  token = ''; currentUser = null; localStorage.removeItem('dw_token'); _currentView = 'home'; render();
}

// ═══════════════════════════════════
// NEW DREAM
// ═══════════════════════════════════
function renderNewDream() {
  app.innerHTML = navHtml() + '<div class="main-content"><div class="dream-container"><h2>Describe Your Dream</h2><p class="hint">Write or speak your dream. You can edit voice transcriptions before submitting.</p><div class="input-area"><textarea id="dream-input" placeholder="I was flying over a city made of glass..." rows="6"></textarea><div class="input-actions"><button class="btn-voice" id="voice-btn" onclick="toggleVoice()">Voice Input</button><span id="voice-status"></span></div></div><div class="mode-selector"><p>Choose interpretation mode:</p><div class="mode-options"><label class="mode-option"><input type="radio" name="dream-mode" value="text_only" checked /><div class="mode-info"><strong>Text Only</strong><span>2 credits - AI interpretation text</span></div></label><label class="mode-option"><input type="radio" name="dream-mode" value="text_and_images" /><div class="mode-info"><strong>Text + 2 Images</strong><span>3 credits - Interpretation + 2 dream images</span></div></label></div></div><button class="btn-primary btn-large" id="submit-dream" onclick="submitDream()">Interpret Dream</button><p id="dream-error" class="error"></p></div></div>';
}

let isRecording = false;
let recognition: any = null;

function toggleVoice() {
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SpeechRecognition) { alert('Speech recognition not supported. Please type your dream.'); return; }
  if (isRecording) { recognition.stop(); isRecording = false; document.getElementById('voice-btn')!.textContent = 'Voice Input'; document.getElementById('voice-status')!.textContent = ''; return; }
  recognition = new SpeechRecognition();
  recognition.continuous = true; recognition.interimResults = true;
  recognition.onresult = function(event: any) { let t = ''; for (let i = 0; i < event.results.length; i++) t += event.results[i][0].transcript; (document.getElementById('dream-input') as HTMLTextAreaElement).value = t; document.getElementById('voice-status')!.textContent = 'Recording... (click to stop)'; };
  recognition.onerror = function() { isRecording = false; document.getElementById('voice-btn')!.textContent = 'Voice Input'; document.getElementById('voice-status')!.textContent = 'Error - try again'; };
  recognition.onend = function() { isRecording = false; document.getElementById('voice-btn')!.textContent = 'Voice Input'; document.getElementById('voice-status')!.textContent = 'Done - edit text above, then submit'; };
  recognition.start(); isRecording = true; document.getElementById('voice-btn')!.textContent = 'Stop Recording'; document.getElementById('voice-status')!.textContent = 'Listening...';
}

async function submitDream() {
  const text = (document.getElementById('dream-input') as HTMLTextAreaElement).value.trim();
  if (!text) { alert('Please describe your dream'); return; }
  const modeEl = document.querySelector('input[name="dream-mode"]:checked') as HTMLInputElement;
  const mode = modeEl ? modeEl.value : 'text_only';
  const cost = mode === 'text_and_images' ? 3 : 2;
  if (currentUser && currentUser.credits < cost) { alert('Not enough credits. Need ' + cost + ', have ' + currentUser.credits); return; }
  const btn = document.getElementById('submit-dream') as HTMLButtonElement;
  btn.disabled = true; btn.textContent = 'Interpreting...';
  try {
    const data = await api('/dreams', { method: 'POST', body: JSON.stringify({ text, mode }) });
    currentUser!.credits = data.creditsLeft;
    currentDream = { id: data.dreamId, title: text.substring(0, 60), summary: '', created_at: new Date().toISOString() };
    currentMessages = [
      { id: 0, role: 'user', content: text, type: '', image_urls: '', created_at: '' },
      { id: 1, role: 'assistant', content: data.interpretation, type: 'interpretation', image_urls: data.image_urls ? JSON.stringify(data.image_urls) : '', created_at: '' },
    ];
    _currentView = 'dream'; selectedImage = null; render();
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
      // FIX: Don't show image URL in user messages
      let displayContent = msg.content;
      if (displayContent.startsWith('[Selected image:')) {
        const idx = displayContent.indexOf(']');
        if (idx !== -1) displayContent = displayContent.substring(idx + 1).trim();
      }
      messagesHtml += '<div class="msg msg-user"><div class="msg-content">' + displayContent + '</div></div>';
    } else {
      let imagesHtml = '';
      if (msg.image_urls) {
        try {
          const imgs = JSON.parse(msg.image_urls);
          if (Array.isArray(imgs)) {
            imagesHtml = '<div class="msg-images">';
            for (const url of imgs) {
              const isSelected = selectedImage === url;
              const isUnselected = selectedImage !== null && !isSelected;
              const cls = isSelected ? 'dream-img selected' : isUnselected ? 'dream-img faded' : 'dream-img';
              imagesHtml += '<img src="' + url + '" class="' + cls + '" onclick="selectImage(\'' + url + '\')" />';
            }
            imagesHtml += '</div>';
          }
        } catch {}
      }
      messagesHtml += '<div class="msg msg-ai"><div class="msg-content">' + msg.content + '</div>' + imagesHtml + '</div>';
    }
  }
  const hasImages = selectedImage ? 'block' : 'none';
  const selImg = selectedImage || '';

  // Determine which modes are available based on whether an image is selected
  const hasSelectedImg = !!selectedImage;

  app.innerHTML = navHtml('<button onclick="currentView=\'new-dream\';render()">New Dream</button>') +
    '<div class="main-content"><div class="dream-chat"><div class="dream-chat-header"><h3>' + currentDream.title + '</h3>' +
    '<div class="dream-actions"><button class="btn-small" onclick="publishDream()">Publish (free)</button></div></div>' +
    '<div class="messages" id="messages">' + messagesHtml + '</div>' +
    '<div class="selected-image-bar" id="selected-bar" style="display:' + hasImages + '">' +
    '<span>Selected: <img src="' + selImg + '" class="thumb" /></span><button onclick="selectedImage=null;render()">Clear</button></div>' +
    '<div class="chat-input-area"><textarea id="chat-input" placeholder="Ask about your dream..." rows="3"></textarea>' +
    '<div class="chat-options">' +
    '<label><input type="radio" name="chat-mode" value="text_only" checked /> Text reply (1cr)</label>' +
    '<label class="' + (hasSelectedImg ? '' : 'disabled') + '"><input type="radio" name="chat-mode" value="text_with_image_ref" ' + (hasSelectedImg ? '' : 'disabled') + ' /> Image ref → text (2cr)</label>' +
    '<label><input type="radio" name="chat-mode" value="text_with_new_image" /> Text → images (3cr)</label>' +
    '<label class="' + (hasSelectedImg ? '' : 'disabled') + '"><input type="radio" name="chat-mode" value="text_image_and_gen" ' + (hasSelectedImg ? '' : 'disabled') + ' /> Image ref → images (4cr)</label>' +
    '</div>' +
    '<button class="btn-primary" onclick="sendChat()">Send</button></div>' +
    '<p id="chat-error" class="error"></p></div></div>';
}

function selectImage(url: string) {
  selectedImage = selectedImage === url ? null : url;
  render();
}

async function sendChat() {
  const text = (document.getElementById('chat-input') as HTMLTextAreaElement).value.trim();
  if (!text) return;
  const modeEl = document.querySelector('input[name="chat-mode"]:checked') as HTMLInputElement;
  const mode = modeEl ? modeEl.value : 'text_only';
  let cost = 1;
  if (mode === 'text_with_image_ref') cost = 2;
  else if (mode === 'text_with_new_image') cost = 3;
  else if (mode === 'text_image_and_gen') cost = 4;
  if (currentUser && currentUser.credits < cost) { alert('Not enough credits'); return; }

  // Show loading indicator
  const msgsEl = document.getElementById('messages')!;
  const loadingId = 'loading-' + Date.now();
  msgsEl.innerHTML += '<div class="msg msg-ai" id="' + loadingId + '"><div class="msg-content"><div class="loading-indicator"><div class="spinner"></div><span>Interpreting...</span></div></div></div>';
  msgsEl.scrollTop = msgsEl.scrollHeight;

  // Disable input while loading
  const sendBtn = document.querySelector('.chat-input-area .btn-primary') as HTMLButtonElement;
  const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending...'; }
  if (chatInput) chatInput.disabled = true;

  try {
    const body: any = { text, selectedImage, mode };
    const data = await api('/dreams/' + currentDream!.id + '/messages', { method: 'POST', body: JSON.stringify(body) });
    currentUser!.credits = data.creditsLeft;
    currentMessages.push({ id: 0, role: 'user', content: text, type: '', image_urls: '', created_at: '' });
    // If new images were generated, remove old image messages to avoid duplicates
    if (data.image_urls && data.image_urls.length > 0) {
      currentMessages = currentMessages.filter(m => m.type !== 'image_generation');
    }
    currentMessages.push({ id: 0, role: 'assistant', content: data.response, type: 'chat', image_urls: data.image_urls ? JSON.stringify(data.image_urls) : '', created_at: '' });
    selectedImage = null;
    // Remove loading and re-render
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();
    render();
  } catch (e: any) {
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();
    document.getElementById('chat-error')!.textContent = e.message;
  } finally {
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
    if (chatInput) chatInput.disabled = false;
  }
}

function publishDream() {
  if (!currentDream) return;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = '<div class="modal-box"><h3>Publish Dream</h3><p>Share to community board (text only):</p><div class="modal-options"><button class="btn-primary" onclick="confirmPublish(\'summary\')">AI Summary (free)</button><button class="btn-secondary" onclick="confirmPublish(\'full\')">Full Conversation (free)</button></div><button class="btn-text" onclick="this.closest(\'.modal-overlay\').remove()">Cancel</button></div>';
  document.body.appendChild(modal);
}

function confirmPublish(mode: string) {
  document.querySelector('.modal-overlay')?.remove();
  const btn = document.querySelector('.dream-actions .btn-small') as HTMLButtonElement;
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing...'; }
  api('/board', { method: 'POST', body: JSON.stringify({ dreamId: currentDream!.id, publishMode: mode }) })
    .then(() => alert('Published to board!'))
    .catch((e: any) => { alert('Publish failed: ' + e.message); })
    .finally(() => { if (btn) { btn.disabled = false; btn.textContent = 'Publish (free)'; } });
}

// ═══════════════════════════════════
// HISTORY
// ═══════════════════════════════════
async function renderHistory() {
  app.innerHTML = navHtml() + '<div class="main-content"><h2>Dream History</h2><div class="loading">Loading...</div></div>';
  try {
    const data = await api('/dreams');
    let html = '';
    if (data.dreams && data.dreams.length > 0) {
      html = '<div class="dream-list">';
      for (const d of data.dreams) {
        html += '<div class="dream-card" onclick="openDream(' + d.id + ')"><h4>' + d.title + '</h4><p>' + (d.summary || '') + '</p><small>' + new Date(d.created_at).toLocaleDateString() + '</small></div>';
      }
      html += '</div>';
    } else { html = '<p>No dreams yet. <a href="#" onclick="currentView=\'new-dream\';render();return false;">Create your first dream</a></p>'; }
    app.innerHTML = navHtml() + '<div class="main-content"><h2>Dream History</h2>' + html + '</div>';
  } catch (e: any) { app.innerHTML += '<p class="error">' + e.message + '</p>'; }
}

async function openDream(id: number) {
  try {
    const data = await api('/dreams/' + id);
    currentDream = data.dream; currentMessages = data.messages || []; selectedImage = null; _currentView = 'dream'; render();
  } catch (e: any) { alert(e.message); }
}

// ═══════════════════════════════════
// BOARD
// ═══════════════════════════════════
async function renderBoard() {
  app.innerHTML = navHtml() + '<div class="main-content"><h2>Community Board</h2><div class="loading">Loading...</div></div>';
  try {
    const data = await api('/board');
    let html = '';
    if (data.posts && data.posts.length > 0) {
      html = '<div class="board-list">';
      for (const p of data.posts) {
        html += '<div class="board-post"><div class="board-post-header"><strong>' + (p.username || 'unknown') + '</strong> <small>' + new Date(p.created_at).toLocaleDateString() + '</small></div><h4>' + p.title + '</h4><p>' + p.content.substring(0, 200) + (p.content.length > 200 ? '...' : '') + '</p><div class="board-post-footer"><span>' + (p.comments_count || 0) + ' comments</span><button class="btn-small" onclick="viewBoardPost(' + p.id + ')">Read More</button></div></div>';
      }
      html += '</div>';
    } else { html = '<p>No posts yet. Be the first to share a dream!</p>'; }
    app.innerHTML = navHtml() + '<div class="main-content"><h2>Community Board</h2>' + html + '</div>';
  } catch (e: any) { app.innerHTML += '<p class="error">' + e.message + '</p>'; }
}

// View full board post with dream conversation + comments
async function viewBoardPost(postId: number) {
  try {
    const data = await api('/board/' + postId + '/detail');
    const post = data.post;
    const messages = data.messages || [];
    const comments = data.comments || [];

    // Build conversation HTML
    let convHtml = '<div class="board-conversation">';
    for (const msg of messages) {
      const cls = msg.role === 'user' ? 'msg-user' : 'msg-ai';
      convHtml += '<div class="msg ' + cls + '"><div class="msg-content">' + msg.content + '</div></div>';
    }
    convHtml += '</div>';

    // Build comments HTML
    let commentsHtml = '<div class="comments-list">';
    if (comments.length > 0) {
      for (const c of comments) {
        commentsHtml += '<div class="comment"><strong>' + (c.username || 'unknown') + '</strong> <small>' + new Date(c.created_at).toLocaleDateString() + '</small><p>' + c.content + '</p></div>';
      }
    } else {
      commentsHtml += '<p class="small" style="color:var(--text-dim)">No comments yet.</p>';
    }
    commentsHtml += '</div>';

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = '<div class="comments-box" style="max-width:700px">' +
      '<h3>' + post.title + '</h3>' +
      '<p style="color:var(--text-dim);font-size:0.85em">by ' + (post.username || 'unknown') + ' · ' + new Date(post.created_at).toLocaleDateString() + '</p>' +
      convHtml +
      '<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">' +
      '<h4>Comments (' + comments.length + ')</h4>' +
      commentsHtml +
      '<div style="margin-top:12px"><textarea id="comment-input" placeholder="Add a comment..." rows="2"></textarea>' +
      '<button class="btn-primary" onclick="addComment(' + postId + ')">Post Comment</button></div>' +
      '</div>' +
      '<button class="btn-secondary" onclick="this.closest(\'.modal-overlay\').remove()">Close</button></div>';
    document.body.appendChild(modal);
  } catch (e: any) { alert(e.message); }
}

async function addComment(postId: number) {
  const text = (document.getElementById('comment-input') as HTMLTextAreaElement).value.trim();
  if (!text) return;
  try {
    await api('/board/' + postId + '/comments', { method: 'POST', body: JSON.stringify({ content: text }) });
    document.querySelector('.modal-overlay')?.remove();
    viewBoardPost(postId); // refresh
  } catch (e: any) { alert(e.message); }
}

// ═══════════════════════════════════
// MAIN ORCHESTRATOR
// ═══════════════════════════════════
async function renderMain() {
  app.innerHTML = navHtml() + '<div class="main-content"><div class="dream-chat"><div class="dream-chat-header"><h3>🌙 Main Orchestrator</h3><p style="color:var(--text-dim);font-size:0.85em">Chat with AI across all your dream history · 0.5cr per message</p></div><div class="messages" id="main-messages"><div class="msg msg-ai"><div class="msg-content">Hello! I have access to all your dream interpretations. Ask me about patterns, themes, recurring symbols, or anything across your dreams.</div></div></div><div class="chat-input-area"><textarea id="main-input" placeholder="Ask about your dreams..." rows="3"></textarea><button class="btn-primary" onclick="sendMainChat()">Send (0.5cr)</button></div><p id="main-error" class="error"></p></div></div>';
}

async function sendMainChat() {
  const text = (document.getElementById('main-input') as HTMLTextAreaElement).value.trim();
  if (!text) return;
  if (currentUser && currentUser.credits < 0.5) { alert('Need 0.5 credits'); return; }
  const msgsEl = document.getElementById('main-messages')!;
  msgsEl.innerHTML += '<div class="msg msg-user"><div class="msg-content">' + text + '</div></div>';
  (document.getElementById('main-input') as HTMLTextAreaElement).value = '';
  try {
    const data = await api('/main/chat', { method: 'POST', body: JSON.stringify({ text }) });
    currentUser!.credits = data.creditsLeft;
    msgsEl.innerHTML += '<div class="msg msg-ai"><div class="msg-content">' + data.response + '</div></div>';
    msgsEl.scrollTop = msgsEl.scrollHeight;
  } catch (e: any) { document.getElementById('main-error')!.textContent = e.message; }
}

// ═══════════════════════════════════
// CREDITS
// ═══════════════════════════════════
function renderCredits() {
  app.innerHTML = navHtml() + '<div class="main-content"><h2>Credits</h2><div class="settings-section"><h3>Balance</h3><p style="font-size:2em;font-weight:700;color:var(--warning)">' + (currentUser ? currentUser.credits : 0) + ' credits</p></div><div class="settings-section"><h3>Usage</h3><p style="color:var(--text-dim);font-size:0.85em">New dream text-only: 2cr · New dream text+images: 3cr · Chat text→text: 1cr · Chat image ref→text: 2cr · Chat text→images: 3cr · Chat image ref→images: 4cr · Main chat: 0.5cr · Publish/Comments: free</p></div><div class="settings-section"><h3>Buy Credits</h3><div class="credit-packs"><div class="credit-pack"><h4>30 Credits</h4><p>$4.99</p><button onclick="startCheckout(\'CREDIT_30\')">Buy</button></div><div class="credit-pack"><h4>100 Credits</h4><p>$9.99</p><button onclick="startCheckout(\'CREDIT_100\')">Buy</button></div><div class="credit-pack"><h4>300 Credits</h4><p>$19.99</p><button onclick="startCheckout(\'CREDIT_300\')">Buy</button></div></div></div></div>';
}

async function startCheckout(priceId: string) {
  try { const data = await api('/stripe/checkout', { method: 'POST', body: JSON.stringify({ priceId }) }); if (data.url) window.location.href = data.url; } catch (e: any) { alert(e.message); }
}

// ═══════════════════════════════════
// SETTINGS
// ═══════════════════════════════════
function renderSettings() {
  const totpStatus = currentUser && currentUser.totpEnabled
    ? '<p>2FA is enabled <button class="btn-small" onclick="disableTOTP()">Disable</button></p>'
    : '<button class="btn-primary" onclick="setupTOTP()">Setup 2FA</button>';
  app.innerHTML = navHtml() + '<div class="main-content"><h2>Settings</h2><div class="settings-section"><h3>Account</h3><p>Username: ' + (currentUser ? currentUser.username : '') + '</p><p>Credits: ' + (currentUser ? currentUser.credits : 0) + '</p></div><div class="settings-section"><h3>Two-Factor Authentication</h3>' + totpStatus + '</div></div>';
}

async function setupTOTP() {
  try {
    const data = await api('/user/totp/setup', { method: 'GET' });
    showTOTPSecret(data.secret, data.uri);
  } catch (e: any) { alert(e.message); }
}

async function disableTOTP() {
  const code = prompt('Enter your current TOTP code to disable 2FA:');
  if (!code) return;
  try {
    await api('/user/totp/disable', { method: 'POST', body: JSON.stringify({ code }) });
    if (currentUser) currentUser.totpEnabled = false;
    alert('2FA disabled.');
    render();
  } catch (e: any) { alert(e.message); }
}

// ═══════════════════════════════════
// ADMIN
// ═══════════════════════════════════
async function renderAdmin() {
  if (!currentUser || !currentUser.isAdmin) return renderHome();
  app.innerHTML = navHtml() + '<div class="main-content"><h2>Admin Dashboard</h2><button class="btn-primary" onclick="loadReport()">Generate Monthly Report</button><div id="admin-report"></div></div>';
}

async function loadReport() {
  try {
    const data = await api('/admin/report');
    let html = '<div class="report"><h3>Report: ' + data.period.start + ' to ' + data.period.end + '</h3>';
    if (data.byRegion && data.byRegion.length > 0) { html += '<h4>Dreams by Region</h4><ul>'; for (const r of data.byRegion) html += '<li>' + (r.country || 'Unknown') + ': ' + r.dream_count + ' dreams</li>'; html += '</ul>'; }
    if (data.emotionAnalysis) html += '<h4>AI Analysis</h4><div class="analysis">' + data.emotionAnalysis + '</div>';
    if (data.topUsers && data.topUsers.length > 0) { html += '<h4>Top Dreamers</h4><ol>'; for (const u of data.topUsers) html += '<li>' + u.username + ': ' + u.dream_count + '</li>'; html += '</ol>'; }
    if (data.publishStats) html += '<h4>Community</h4><p>Posts: ' + (data.publishStats.total_posts || 0) + ', Comments: ' + (data.publishStats.total_comments || 0) + '</p>';
    html += '</div>';
    document.getElementById('admin-report')!.innerHTML = html;
  } catch (e: any) { document.getElementById('admin-report')!.innerHTML = '<p class="error">' + e.message + '</p>'; }
}

// ═══════════════════════════════════
// INIT
// ═══════════════════════════════════
(window as any).render = render;
(window as any).logout = logout;
Object.defineProperty(window, 'authMode', { get: () => authMode, set: (v) => { authMode = v; } });
Object.defineProperty(window, 'currentView', { get: () => _currentView, set: (v) => { _currentView = v; } });
Object.defineProperty(window, 'selectedImage', { get: () => selectedImage, set: (v) => { selectedImage = v; } });
(window as any).verifyTOTP = verifyTOTP;
(window as any).toggleVoice = toggleVoice;
(window as any).submitDream = submitDream;
(window as any).sendChat = sendChat;
(window as any).publishDream = publishDream;
(window as any).selectImage = selectImage;
(window as any).confirmPublish = confirmPublish;
(window as any).openDream = openDream;
(window as any).viewBoardPost = viewBoardPost;
(window as any).addComment = addComment;
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

async function init() {
  if (token) {
    try { const data = await api('/user/profile'); currentUser = { username: data.username, credits: data.credits, totpEnabled: false, isAdmin: data.isAdmin }; } catch { token = ''; localStorage.removeItem('dw_token'); }
  }
  render();
}
init();
