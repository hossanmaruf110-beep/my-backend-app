const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000; // 3000 থেকে 5000 করে দিলাম

// ─── MongoDB Connection ──────────────────────────────────────
const mongoURI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/adminDashboard';
mongoose.connect(mongoURI)
  .then(() => console.log('✅ MongoDB connected (app server)'))
  .catch(err => console.error('❌ MongoDB connection error:', err.message));

// ─── User Schema ─────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  plan: { type: String, default: 'Basic' },
  amount: { type: Number, default: 0 },
  sender: { type: String, default: '' },
  txn: { type: String, default: '' },
  active: { type: Boolean, default: false },
  credits: { type: Number, default: 2500 },
  used: { type: Number, default: 0 },
  deviceCount: { type: Number, default: 0 },
  customDeviceLimit: { type: Number, default: null },
  deviceResetTimestamp: { type: Date, default: null },
  activatedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
  isBlocked: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// ─── Settings Schema ──────────────────────────────────────────
const settingsSchema = new mongoose.Schema({
  basicPrice: { type: Number, default: 100 },
  popularPrice: { type: Number, default: 300 },
  yearlyPrice: { type: Number, default: 2000 },
  basicCredits: { type: Number, default: 2500 },
  popularCredits: { type: Number, default: 6000 },
  yearlyCredits: { type: Number, default: 50000 },
  bkash: { type: String, default: '01319140478' },
  nagad: { type: String, default: '01319140478' },
  geminiKey: { type: String, default: '' },
  maxDevices: { type: Number, default: 2 },
  basicDuration: { type: Number, default: 30 },
  popularDuration: { type: Number, default: 30 },
  yearlyDuration: { type: Number, default: 365 },
  updatedAt: { type: Date, default: Date.now }
});
const Settings = mongoose.model('Settings', settingsSchema);

// ─── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
const upload = multer({ storage: multer.memoryStorage() });

// ─── Locked Models ──────────────────────────────────────────
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const GROQ_MODEL = "openai/gpt-oss-20b";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// ─── Settings Cache ──────────────────────────────────────────
let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_TTL = 60 * 1000; // 1 minute

async function getSettings() {
  const now = Date.now();
  if (settingsCache && (now - settingsCacheTime) < CACHE_TTL) {
    return settingsCache;
  }
  let settings = await Settings.findOne();
  if (!settings) {
    settings = await Settings.create({});
  }
  settingsCache = settings;
  settingsCacheTime = now;
  return settings;
}

// ─── Helper: Get plan credits & duration ────────────────────
async function getPlanDetails(planName) {
  const settings = await getSettings();
  const map = {
    Basic: { credits: settings.basicCredits, duration: settings.basicDuration },
    Popular: { credits: settings.popularCredits, duration: settings.popularDuration },
    Yearly: { credits: settings.yearlyCredits, duration: settings.yearlyDuration }
  };
  const plan = map[planName] || map.Basic;
  return { credits: plan.credits || 2500, durationDays: plan.duration || 30 };
}

// ─── ADMIN EMAIL (hardcoded) ─────────────────────────────────
const ADMIN_EMAIL = 'hossanmaruf110@gmail.com';

// ─── ★ Check user status (with admin bypass) ★ ──────────────
async function checkUserStatus(email) {
  if (!email) return { ok: false, message: 'ইমেইল প্রদান করা হয়নি।' };

  // Admin bypass: unlimited access
  if (email.toLowerCase().trim() === ADMIN_EMAIL) {
    return { ok: true, user: { email, active: true, credits: 999999, isBlocked: false } };
  }

  const user = await User.findOne({ email });
  if (!user) return { ok: false, message: 'ইউজার খুঁজে পাওয়া যায়নি।' };

  if (user.isBlocked === true) {
    return { ok: false, message: '🚫 আপনার অ্যাকাউন্ট ব্লক করা হয়েছে। প্রশাসকের সাথে যোগাযোগ করুন।', blocked: true };
  }

  const now = new Date();
  const isExpired = user.expiresAt && new Date(user.expiresAt) < now;
  const hasZeroCredits = user.credits <= 0;
  const isLocked = isExpired || hasZeroCredits || !user.active;

  if (isLocked) {
    let msg = 'আপনার অ্যাকাউন্ট লক করা হয়েছে।';
    if (isExpired) msg = '⏰ আপনার প্ল্যানের মেয়াদ শেষ হয়েছে। নতুন প্ল্যান নিন।';
    else if (hasZeroCredits) msg = '💎 আপনার ক্রেডিট শেষ হয়ে গেছে। নতুন প্ল্যান নিন।';
    else if (!user.active) msg = '🔒 আপনার অ্যাকাউন্ট সক্রিয় নেই।';
    return { ok: false, message: msg };
  }
  return { ok: true, user };
}

// ─── Deduct credit (admin bypass) ────────────────────────────
async function deductCredit(user) {
  // Admin: no deduction
  if (user && user.email && user.email.toLowerCase().trim() === ADMIN_EMAIL) {
    return 999999;
  }
  user.credits -= 1;
  user.used = (user.used || 0) + 1;
  await user.save();
  return user.credits;
}

// ─── AI CALL FUNCTIONS ──────────────────────────────────────
async function callGemini(apiKey, messages, imageBuffer, mimeType) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const parts = [];
  const systemMsg = messages.find(m => m.role === "system");
  if (systemMsg) parts.push({ text: systemMsg.content });

  const userMsg = messages.find(m => m.role === "user");
  if (userMsg) {
    if (typeof userMsg.content === "string") {
      parts.push({ text: userMsg.content });
    } else if (Array.isArray(userMsg.content)) {
      for (const item of userMsg.content) {
        if (item.type === "text") parts.push({ text: item.text });
        else if (item.type === "image_url") {
          const match = item.image_url.url.match(/^data:(.*?);base64,(.*)$/);
          if (match) {
            parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
        }
      }
    }
  }

  if (imageBuffer) {
    parts.push({
      inlineData: {
        mimeType: mimeType || "image/jpeg",
        data: imageBuffer.toString('base64')
      }
    });
  }

  const result = await geminiModel.generateContent({
    contents: [{ role: "user", parts }],
    generationConfig: { maxOutputTokens: 8192 }
  });

  const response = result.response;
  const blockReason = response?.promptFeedback?.blockReason;
  const candidate = response?.candidates?.[0];
  const finishReason = candidate?.finishReason;

  if (blockReason) {
    const err = new Error(`BLOCKED_BY_SAFETY: prompt blocked (${blockReason})`);
    err.blocked = true;
    throw err;
  }
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
    const err = new Error(`BLOCKED_BY_SAFETY: response blocked (finishReason: ${finishReason})`);
    err.blocked = true;
    throw err;
  }

  let text;
  try {
    text = response.text();
  } catch (textErr) {
    const err = new Error(`BLOCKED_BY_SAFETY: ${textErr.message}`);
    err.blocked = true;
    throw err;
  }

  if (!text || !text.trim()) {
    const err = new Error('BLOCKED_BY_SAFETY: empty response text');
    err.blocked = true;
    throw err;
  }
  return text;
}

async function callGroq(apiKey, messages, imageBuffer, mimeType) {
  const systemMsg = messages.find(m => m.role === "system");
  const userMsg = messages.find(m => m.role === "user");

  const userContent = [];
  if (typeof userMsg?.content === "string") {
    userContent.push({ type: "text", text: userMsg.content });
  } else if (Array.isArray(userMsg?.content)) {
    for (const item of userMsg.content) {
      if (item.type === "text") userContent.push({ type: "text", text: item.text });
      else if (item.type === "image_url") userContent.push({ type: "image_url", image_url: { url: item.image_url.url } });
    }
  }
  if (imageBuffer) {
    const dataUrl = `data:${mimeType || "image/jpeg"};base64,${imageBuffer.toString('base64')}`;
    userContent.push({ type: "image_url", image_url: { url: dataUrl } });
  }

  const groqMessages = [];
  if (systemMsg) groqMessages.push({ role: "system", content: systemMsg.content });
  groqMessages.push({ role: "user", content: userContent });

  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: groqMessages,
      max_tokens: 8192
    })
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `Groq request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text || !text.trim()) {
    const err = new Error('BLOCKED_BY_SAFETY: empty response text');
    err.blocked = true;
    throw err;
  }
  return text;
}

function classifyError(err) {
  const raw = (err && err.message) ? err.message : 'Unknown error';
  const msg = raw.toLowerCase();
  const sdkStatus = err && (err.status || err.httpStatus);

  if (err && err.blocked) return { status: 503, message: raw };
  if (msg.includes('api key not valid') || msg.includes('api_key_invalid') ||
      msg.includes('permission_denied') || msg.includes('unauthorized') ||
      msg.includes('invalid api key') || sdkStatus === 401 || sdkStatus === 403) {
    return { status: 401, message: 'Invalid or unauthorized API key: ' + raw };
  }
  if (msg.includes('quota') || msg.includes('resource_exhausted') ||
      msg.includes('rate limit') || msg.includes('429') || sdkStatus === 429) {
    return { status: 429, message: raw };
  }
  if (msg.includes('unavailable') || msg.includes('overloaded') ||
      msg.includes('high demand') || msg.includes('503') || sdkStatus === 503) {
    return { status: 503, message: raw };
  }
  if (msg.includes('not found') || msg.includes('404') || sdkStatus === 404) {
    return { status: 503, message: raw };
  }
  if (msg.includes('safety') || msg.includes('blocked') || msg.includes('recitation')) {
    return { status: 503, message: raw };
  }
  return { status: 500, message: raw };
}

// ─── API ROUTES ──────────────────────────────────────────────

// ── 1. AI endpoint ──
app.post('/api/ai', upload.single('image'), async (req, res) => {
  try {
    const { prompt, apiKey, imageBase64, mimeType, provider, userEmail } = req.body;

    if (!userEmail) {
      return res.status(400).json({ error: 'userEmail required' });
    }

    const status = await checkUserStatus(userEmail);
    if (!status.ok) {
      return res.status(403).json({ error: status.message });
    }
    const user = status.user;

    if (!apiKey) return res.status(400).json({ error: 'API key required' });
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });

    const useProvider = provider === 'groq' ? 'groq' : 'gemini';

    let imageBuffer = null;
    let mime = mimeType || 'image/jpeg';

    if (req.file) {
      imageBuffer = req.file.buffer;
      mime = req.file.mimetype || 'image/jpeg';
    } else if (imageBase64) {
      const match = imageBase64.match(/^data:(.*?);base64,(.*)$/);
      if (match) {
        imageBuffer = Buffer.from(match[2], 'base64');
        mime = match[1];
      } else {
        imageBuffer = Buffer.from(imageBase64, 'base64');
      }
    }

    const messages = [
      { role: "system", content: prompt },
      { role: "user", content: "Analyze the image and generate the required output." }
    ];

    const usedModel = useProvider === 'groq' ? GROQ_MODEL : GEMINI_MODEL;
    console.log(`🔄 Calling provider: ${useProvider} (${usedModel}) for ${userEmail}`);

    const result = useProvider === 'groq'
      ? await callGroq(apiKey, messages, imageBuffer, mime)
      : await callGemini(apiKey, messages, imageBuffer, mime);

    const remainingCredits = await deductCredit(user);
    console.log(`✅ Success for ${userEmail}, remaining credits: ${remainingCredits}`);

    res.json({ result, usedProvider: useProvider, remainingCredits });
  } catch (error) {
    const { status, message } = classifyError(error);
    console.error(`❌ AI Error [http ${status}]:`, message);
    if (error && error.stack && status === 500) {
      console.error(error.stack);
    }
    res.status(status).json({ error: message });
  }
});

// ── 2. User Management Routes ──

// Get all users
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new user (payment submission)
app.post('/api/users', async (req, res) => {
  try {
    const { email, plan, amount, sender, txn, active } = req.body;
    const exists = await User.findOne({ email });
    if (exists) {
      await User.updateOne({ email }, {
        plan,
        amount,
        sender,
        txn,
        active: false,
        credits: 0
      });
      return res.status(200).json({ message: 'Payment recorded, pending admin approval.' });
    }
    
    const { credits } = await getPlanDetails(plan || 'Basic');
    const now = new Date();
    const { durationDays } = await getPlanDetails(plan || 'Basic');
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    const newUser = new User({ 
      email, plan, amount, sender, txn, active: false,
      credits: 0,
      activatedAt: null,
      expiresAt: null,
      isBlocked: false
    });
    await newUser.save();
    res.status(201).json(newUser);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── 3. Approve Plan (Admin) ──
app.post('/api/users/approve-plan', async (req, res) => {
  try {
    const { userId, plan } = req.body;
    if (!userId || !plan) {
      return res.status(400).json({ error: 'userId এবং plan প্রয়োজন।' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'ইউজার খুঁজে পাওয়া যায়নি।' });
    }

    if (user.isBlocked === true) {
      return res.status(403).json({ error: 'এই ইউজার ব্লক করা আছে। প্রথমে আনব্লক করুন।' });
    }

    const { credits: planCredits, durationDays } = await getPlanDetails(plan);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    user.plan = plan;
    user.active = true;
    user.credits = planCredits;
    user.activatedAt = now;
    user.expiresAt = expiresAt;
    user.used = 0;

    await user.save();

    res.status(200).json({
      success: true,
      message: `✅ ${plan} প্ল্যান সক্রিয় করা হয়েছে।`,
      user: {
        email: user.email,
        plan: user.plan,
        credits: user.credits,
        activatedAt: user.activatedAt,
        expiresAt: user.expiresAt,
        active: user.active,
        isBlocked: user.isBlocked
      }
    });
  } catch (error) {
    console.error('Approve plan error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── 4. Check expiry (with admin override) ──
app.get('/api/users/check-expiry/:email', async (req, res) => {
  try {
    const email = req.params.email;
    
    // Admin override: always active & unlimited
    if (email && email.toLowerCase().trim() === ADMIN_EMAIL) {
      return res.json({
        email: ADMIN_EMAIL,
        active: true,
        credits: 999999,
        activatedAt: new Date(),
        expiresAt: null,
        isExpired: false,
        hasZeroCredits: false,
        isBlocked: false,
        isLocked: false,
        plan: 'Admin',
        deviceCount: 0,
        customDeviceLimit: 999
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'ইউজার খুঁজে পাওয়া যায়নি' });
    }

    const now = new Date();
    const isExpired = user.expiresAt && new Date(user.expiresAt) < now;
    const hasZeroCredits = user.credits <= 0;
    const isBlocked = user.isBlocked === true;
    const isLocked = isExpired || hasZeroCredits || !user.active || isBlocked;

    res.json({
      email: user.email,
      active: user.active,
      credits: user.credits,
      activatedAt: user.activatedAt,
      expiresAt: user.expiresAt,
      isExpired: isExpired,
      hasZeroCredits: hasZeroCredits,
      isBlocked: isBlocked,
      isLocked: isLocked,
      plan: user.plan,
      deviceCount: user.deviceCount || 0,
      customDeviceLimit: user.customDeviceLimit
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── 5. BLOCK USER ──
app.put('/api/users/:id/block', async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isBlocked: true },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'ইউজার খুঁজে পাওয়া যায়নি' });
    res.json({ message: '✅ ইউজার ব্লক করা হয়েছে', user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── 6. UNBLOCK USER ──
app.put('/api/users/:id/unblock', async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isBlocked: false },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'ইউজার খুঁজে পাওয়া যায়নি' });
    res.json({ message: '✅ ইউজারের ব্লক সরানো হয়েছে', user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── 7. Settings ──
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const settings = await Settings.findOneAndUpdate({}, req.body, { new: true, upsert: true });
    settingsCache = null; // cache refresh
    res.json(settings);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── 8. Health check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 9. Root ──
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// ── Admin page ──────────────────────────────────────────────
app.get('/admin.html', (req, res) => {
  res.sendFile(__dirname + '/admin.html');
});

// ── Start Server ──
app.listen(PORT, () => {
  console.log(`🚀 App server running on http://localhost:${PORT}`);
  console.log(`📁 AI endpoint: http://localhost:${PORT}/api/ai`);
  console.log(`📁 Admin panel: http://localhost:${PORT}/admin.html`);
});