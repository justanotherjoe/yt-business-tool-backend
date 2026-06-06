require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { YoutubeTranscript } = require('youtube-transcript');
const { Pool }   = require('pg');
const { ClerkExpressRequireAuth, ClerkExpressWithAuth } = require('@clerk/clerk-sdk-node');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app  = express();
const port = process.env.PORT || 3001;

// ── Environment variables ──────────────────────────────────────────
const YT_KEY                = process.env.YOUTUBE_API_KEY;
const GEMINI_KEY            = process.env.GEMINI_API_KEY;
const CLERK_SECRET_KEY      = process.env.CLERK_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const GROWTH_PRICE_ID       = process.env.STRIPE_GROWTH_PRICE_ID;
const PRO_PRICE_ID          = process.env.STRIPE_PRO_PRICE_ID;
const FRONTEND_URL          = process.env.FRONTEND_URL || 'http://localhost:5173';
const DATABASE_URL          = process.env.DATABASE_URL;

// ── Startup checks ─────────────────────────────────────────────────
const required = {
  YOUTUBE_API_KEY:  YT_KEY,
  GEMINI_API_KEY:   GEMINI_KEY,
  CLERK_SECRET_KEY: CLERK_SECRET_KEY,
  DATABASE_URL:     DATABASE_URL,
};
const missing = Object.entries(required).filter(([,v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('ERROR: Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

// ── Clients ────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── CORS ───────────────────────────────────────────────────────────
app.use(cors());

// ── Stripe webhook needs raw body ──────────────────────────────────
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session      = event.data.object;
      const clerkUserId  = session.metadata?.clerk_user_id;
      const priceId      = session.metadata?.price_id;
      if (clerkUserId && priceId) {
        const tier = priceId === PRO_PRICE_ID ? 'pro' : 'growth';
        await pool.query(
          `UPDATE users SET tier = $1, stripe_customer_id = $2, updated_at = NOW()
           WHERE clerk_user_id = $3`,
          [tier, session.customer, clerkUserId]
        );
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await pool.query(
        `UPDATE users SET tier = 'free', updated_at = NOW()
         WHERE stripe_customer_id = $1`,
        [sub.customer]
      );
    }

    if (event.type === 'customer.subscription.updated') {
      const sub     = event.data.object;
      const priceId = sub.items.data[0]?.price?.id;
      const tier    = priceId === PRO_PRICE_ID ? 'pro'
                    : priceId === GROWTH_PRICE_ID ? 'growth'
                    : 'free';
      await pool.query(
        `UPDATE users SET tier = $1, updated_at = NOW()
         WHERE stripe_customer_id = $2`,
        [tier, sub.customer]
      );
    }

    res.json({ received: true });
  }
);

// ── JSON body parser ───────────────────────────────────────────────
app.use(express.json());

// ── Database setup ─────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                  SERIAL PRIMARY KEY,
      clerk_user_id       TEXT UNIQUE NOT NULL,
      email               TEXT,
      tier                TEXT DEFAULT 'free',
      analyses_this_month INT DEFAULT 0,
      analyses_reset_at   TIMESTAMPTZ DEFAULT NOW(),
      stripe_customer_id  TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS library (
      id            SERIAL PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      video_title   TEXT,
      video_url     TEXT,
      video_id      TEXT,
      text          TEXT NOT NULL,
      type          TEXT DEFAULT 'insight',
      category      TEXT DEFAULT 'Uncategorized',
      full_data     JSONB,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS categories (
      id            SERIAL PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      name          TEXT NOT NULL,
      icon          TEXT DEFAULT '📁',
      color         TEXT DEFAULT '#D1E0FF',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(clerk_user_id, name)
    );
  `);
  console.log('Database tables ready');
}

// ── Helpers ────────────────────────────────────────────────────────
async function getOrCreateUser(clerkUserId, email) {
  const existing = await pool.query(
    'SELECT * FROM users WHERE clerk_user_id = $1',
    [clerkUserId]
  );
  if (existing.rows.length) return existing.rows[0];
  const created = await pool.query(
    `INSERT INTO users (clerk_user_id, email) VALUES ($1, $2) RETURNING *`,
    [clerkUserId, email || null]
  );
  return created.rows[0];
}

async function checkAnalysisLimit(req, res, next) {
  const clerkUserId = req.auth?.userId;
  if (!clerkUserId) return res.status(401).json({ error: 'Not authenticated' });

  const user = await getOrCreateUser(clerkUserId, req.auth?.sessionClaims?.email);

  const resetAt = new Date(user.analyses_reset_at);
  const now     = new Date();
  if (now.getMonth() !== resetAt.getMonth() || now.getFullYear() !== resetAt.getFullYear()) {
    await pool.query(
      `UPDATE users SET analyses_this_month = 0, analyses_reset_at = NOW()
       WHERE clerk_user_id = $1`,
      [clerkUserId]
    );
    user.analyses_this_month = 0;
  }

  const limits = { free: 5, growth: Infinity, pro: Infinity };
  const limit  = limits[user.tier] ?? 5;

  if (user.analyses_this_month >= limit) {
    return res.status(403).json({
      error:   'Monthly analysis limit reached',
      limit,
      tier:    user.tier,
      upgrade: true,
    });
  }

  req.dbUser = user;
  next();
}

async function requirePaidTier(req, res, next) {
  const clerkUserId = req.auth?.userId;
  if (!clerkUserId) return res.status(401).json({ error: 'Not authenticated' });

  const user = await getOrCreateUser(clerkUserId);
  if (user.tier === 'free') {
    return res.status(403).json({
      error:   'Library access requires a paid plan',
      tier:    user.tier,
      upgrade: true,
    });
  }

  req.dbUser = user;
  next();
}

// ── ROUTES ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Unpacked backend running' });
});

app.get('/api/me',
  ClerkExpressWithAuth(),
  async (req, res) => {
    const clerkUserId = req.auth?.userId;
    if (!clerkUserId) return res.json({ authenticated: false });
    const user = await getOrCreateUser(clerkUserId, req.auth?.sessionClaims?.email);
    res.json({
      authenticated:     true,
      tier:              user.tier,
      analysesThisMonth: user.analyses_this_month,
    });
  }
);

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query param q' });
  try {
    const url      = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=10&q=${encodeURIComponent(q)}&key=${YT_KEY}`;
    const response = await fetch(url);
    const data     = await response.json();
    if (data.error) return res.status(502).json({ error: data.error.message });
    const channels = (data.items || []).map(item => ({
      name:        item.snippet.title,
      channelId:   item.snippet.channelId,
      description: item.snippet.description,
      thumbnail:   item.snippet.thumbnails?.default?.url || '',
    }));
    res.json({ channels });
  } catch (err) {
    res.status(500).json({ error: 'Failed to search YouTube channels' });
  }
});

app.get('/api/videos', async (req, res) => {
  const { channelId } = req.query;
  if (!channelId) return res.status(400).json({ error: 'Missing channelId' });
  try {
    const url      = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=8&order=date&type=video&key=${YT_KEY}`;
    const response = await fetch(url);
    const data     = await response.json();
    if (data.error) return res.status(502).json({ error: data.error.message });
    const videos = (data.items || []).map(item => ({
      title:       item.snippet.title,
      videoId:     item.id.videoId,
      thumbnail:   item.snippet.thumbnails?.medium?.url || '',
      publishedAt: item.snippet.publishedAt,
      description: item.snippet.description,
    }));
    res.json({ videos });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
});

app.get('/api/transcript', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

  // Method 1 — youtube-transcript package
  try {
    const chunks = await YoutubeTranscript.fetchTranscript(videoId);
    if (chunks && chunks.length) {
      const text = chunks.map(c => c.text).join(' ');
      return res.json({ transcript: text, wordCount: text.split(' ').length });
    }
  } catch (e) {
    console.log('Method 1 failed:', e.message);
  }

// Method 2 — Supadata API
  try {
    const r2 = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&lang=en`,
      { signal: AbortSignal.timeout(8000) }
    );
    console.log('Method 2 status:', r2.status);
    if (r2.ok) {
      const data2 = await r2.json();
      console.log('Method 2 data keys:', Object.keys(data2));
      const chunks2 = Array.isArray(data2) ? data2 : (data2.transcript || data2.content || data2.chunks || []);
      console.log('Method 2 chunks length:', chunks2.length);
      if (chunks2.length) {
        const text = chunks2.map(c => c.text || c).join(' ');
        return res.json({ transcript: text, wordCount: text.split(' ').length });
      }
    } else {
      const errText = await r2.text();
      console.log('Method 2 error response:', errText.slice(0, 200));
    }
  } catch (e) {
    console.log('Method 2 failed:', e.message);
  }

  // Method 3 — yt-transcript-api vercel
  try {
    const r3 = await fetch(
      `https://yt-transcript-api.vercel.app/api/transcript?videoId=${videoId}`,
      { signal: AbortSignal.timeout(8000) }
    );
    console.log('Method 3 status:', r3.status);
    if (r3.ok) {
      const data3 = await r3.json();
      console.log('Method 3 data keys:', Object.keys(data3));
      const chunks3 = Array.isArray(data3) ? data3 : (data3.transcript || []);
      console.log('Method 3 chunks length:', chunks3.length);
      if (chunks3.length) {
        const text = chunks3.map(c => c.text || c).join(' ');
        return res.json({ transcript: text, wordCount: text.split(' ').length });
      }
    } else {
      const errText = await r3.text();
      console.log('Method 3 error response:', errText.slice(0, 200));
    }
  } catch (e) {
    console.log('Method 3 failed:', e.message);
  }

  // All methods failed
  res.status(404).json({
    error:  'Transcript not available for this video. Please paste it manually.',
    manual: true,
  });
});

app.post('/api/analyze',
  ClerkExpressRequireAuth(),
  checkAnalysisLimit,
  async (req, res) => {
    const { transcript, mode, customPrompt } = req.body;
    if (!transcript?.trim()) {
      return res.status(400).json({ error: 'No transcript provided' });
    }

    const MODE_PROMPTS = {
      summary: `You are a business content analyst. Analyze this YouTube transcript and return ONLY valid JSON with no markdown fences:
{"title":"short topic","channel_type":"creator type","word_count":0,"core_message":"1-2 sentence core message","key_topics":["t1","t2","t3","t4"],"key_insights":["i1","i2","i3","i4"],"target_audience":"who this is for","business_stage":"startup/early/growth/established/general","suggested_categories":["cat1","cat2"]}`,
      actionable: `You are a business coach. Analyze this transcript and return ONLY valid JSON with no markdown fences:
{"title":"short topic","word_count":0,"immediate_actions":["a1","a2","a3"],"this_week":["t1","t2"],"longer_term":["l1","l2"],"tools_mentioned":["tool1"],"key_quote":"most impactful line","suggested_categories":["cat1","cat2"]}`,
      frameworks: `You are a business strategist. Analyze this transcript and return ONLY valid JSON with no markdown fences:
{"title":"short topic","word_count":0,"frameworks_mentioned":["f1"],"mental_models":["m1","m2"],"step_by_step_process":["s1","s2","s3"],"common_mistakes_warned":["e1"],"success_principles":["p1","p2"],"suggested_categories":["cat1","cat2"]}`,
    };

    const systemPrompt = (mode === 'custom' && customPrompt?.trim())
      ? customPrompt.trim()
      : (MODE_PROMPTS[mode] || MODE_PROMPTS.summary);

    const truncated = transcript.length > 12000
      ? transcript.slice(0, 12000) + '...'
      : transcript;

    try {
      const model    = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result   = await model.generateContent(
        `${systemPrompt}\n\nTranscript:\n\n${truncated}`
      );
      const raw      = result.response.text();
      const cleaned  = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed   = JSON.parse(cleaned);

      await pool.query(
        `UPDATE users SET analyses_this_month = analyses_this_month + 1
         WHERE clerk_user_id = $1`,
        [req.auth.userId]
      );

      res.json({
        result:            parsed,
        analysesThisMonth: req.dbUser.analyses_this_month + 1,
        tier:              req.dbUser.tier,
      });
    } catch (err) {
      console.error('Gemini error:', err.message);
      res.status(500).json({ error: 'Analysis failed: ' + err.message });
    }
  }
);

app.post('/api/library',
  ClerkExpressRequireAuth(),
  requirePaidTier,
  async (req, res) => {
    const { videoTitle, videoUrl, videoId, text, type, category, fullData } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text' });

    if (req.dbUser.tier === 'growth') {
      const count = await pool.query(
        'SELECT COUNT(*) FROM library WHERE clerk_user_id = $1',
        [req.auth.userId]
      );
      if (parseInt(count.rows[0].count) >= 300) {
        return res.status(403).json({
          error:   'Library limit reached for Growth plan',
          upgrade: true,
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO library
         (clerk_user_id, video_title, video_url, video_id, text, type, category, full_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        req.auth.userId,
        videoTitle || null,
        videoUrl   || null,
        videoId    || null,
        text,
        type       || 'insight',
        category   || 'Uncategorized',
        fullData   ? JSON.stringify(fullData) : null,
      ]
    );
    res.json({ item: result.rows[0] });
  }
);

app.get('/api/library',
  ClerkExpressRequireAuth(),
  requirePaidTier,
  async (req, res) => {
    const { category, search } = req.query;
    let query    = 'SELECT * FROM library WHERE clerk_user_id = $1';
    const params = [req.auth.userId];

    if (category && category !== 'All') {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (text ILIKE $${params.length} OR video_title ILIKE $${params.length})`;
    }
    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json({ items: result.rows });
  }
);

app.delete('/api/library/:id',
  ClerkExpressRequireAuth(),
  async (req, res) => {
    await pool.query(
      'DELETE FROM library WHERE id = $1 AND clerk_user_id = $2',
      [req.params.id, req.auth.userId]
    );
    res.json({ deleted: true });
  }
);

app.get('/api/categories',
  ClerkExpressRequireAuth(),
  requirePaidTier,
  async (req, res) => {
    const result = await pool.query(
      'SELECT * FROM categories WHERE clerk_user_id = $1 ORDER BY name ASC',
      [req.auth.userId]
    );
    res.json({ categories: result.rows });
  }
);

app.post('/api/categories',
  ClerkExpressRequireAuth(),
  requirePaidTier,
  async (req, res) => {
    const { name, icon, color } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing name' });
    try {
      const result = await pool.query(
        `INSERT INTO categories (clerk_user_id, name, icon, color)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (clerk_user_id, name) DO NOTHING
         RETURNING *`,
        [req.auth.userId, name, icon || '📁', color || '#D1E0FF']
      );
      res.json({ category: result.rows[0] || null });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create category' });
    }
  }
);

app.delete('/api/categories/:id',
  ClerkExpressRequireAuth(),
  async (req, res) => {
    const cat = await pool.query(
      'SELECT name FROM categories WHERE id = $1 AND clerk_user_id = $2',
      [req.params.id, req.auth.userId]
    );
    if (cat.rows.length) {
      await pool.query(
        `UPDATE library SET category = 'Uncategorized'
         WHERE clerk_user_id = $1 AND category = $2`,
        [req.auth.userId, cat.rows[0].name]
      );
    }
    await pool.query(
      'DELETE FROM categories WHERE id = $1 AND clerk_user_id = $2',
      [req.params.id, req.auth.userId]
    );
    res.json({ deleted: true });
  }
);

app.post('/api/billing/checkout',
  ClerkExpressRequireAuth(),
  async (req, res) => {
    const { priceId } = req.body;
    const validPrices = [GROWTH_PRICE_ID, PRO_PRICE_ID].filter(Boolean);
    if (!validPrices.includes(priceId)) {
      return res.status(400).json({ error: 'Invalid price ID' });
    }
    const user    = await getOrCreateUser(req.auth.userId);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:                 'subscription',
      line_items:           [{ price: priceId, quantity: 1 }],
      success_url:          `${FRONTEND_URL}?upgraded=true`,
      cancel_url:           `${FRONTEND_URL}?cancelled=true`,
      metadata: {
        clerk_user_id: req.auth.userId,
        price_id:      priceId,
      },
      ...(user.stripe_customer_id
        ? { customer: user.stripe_customer_id }
        : {}),
    });
    res.json({ url: session.url });
  }
);

app.post('/api/billing/portal',
  ClerkExpressRequireAuth(),
  async (req, res) => {
    const user = await getOrCreateUser(req.auth.userId);
    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripe_customer_id,
      return_url: FRONTEND_URL,
    });
    res.json({ url: session.url });
  }
);

// ── Start ──────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(port, () => {
    console.log(`Unpacked backend running on port ${port}`);
  });
}).catch(err => {
  console.error('Database init failed:', err);
  process.exit(1);
});
