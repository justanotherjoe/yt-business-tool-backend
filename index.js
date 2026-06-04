require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const Anthropic  = require('@anthropic-ai/sdk');
const { YoutubeTranscript } = require('youtube-transcript');

const app  = express();
const port = process.env.PORT || 3001;

const YT_KEY        = process.env.YOUTUBE_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!YT_KEY || !ANTHROPIC_KEY) {
  console.error('ERROR: Missing YOUTUBE_API_KEY or ANTHROPIC_API_KEY in environment.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
}));

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'YT Business Tool backend running' });
});

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query param q' });
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=10&q=${encodeURIComponent(q)}&key=${YT_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
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
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=8&order=date&type=video&key=${YT_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
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
  try {
    const chunks = await YoutubeTranscript.fetchTranscript(videoId);
    const text = chunks.map(c => c.text).join(' ');
    res.json({ transcript: text, wordCount: text.split(' ').length });
  } catch (err) {
    res.status(404).json({
      error: 'Transcript not available for this video.',
      manual: true,
    });
  }
});

app.post('/api/analyze', async (req, res) => {
  const { transcript, mode, customPrompt } = req.body;
  if (!transcript || !transcript.trim()) {
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
    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: `Transcript:\n\n${truncated}` }],
    });
    const raw     = message.content.find(b => b.type === 'text')?.text || '{}';
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed  = JSON.parse(cleaned);
    res.json({ result: parsed });
  } catch (err) {
    res.status(500).json({ error: 'Claude analysis failed: ' + err.message });
  }
});

app.listen(port, () => {
  console.log(`Backend running on port ${port}`);
});
