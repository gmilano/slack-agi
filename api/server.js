import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import compression from 'compression';
import cors from 'cors';
import OpenAI from 'openai';

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ── Multi-agent team definitions ──────────────────────────
const AGENT_DEFS = {
  aria: {
    displayName: 'Aria',
    role: 'Product Lead',
    system: `You are Aria, a sharp Product Manager. You clarify goals, define the problem space clearly, and think about users first. You're strategic, slightly Type-A, and hate vagueness. Be concise — 3-4 sentences max. Don't use bullet points. Sound natural, like you're in a Slack chat.`,
  },
  cody: {
    displayName: 'Cody',
    role: 'Engineering',
    system: `You are Cody, a senior software engineer. You think in systems, love implementation details, and are mildly skeptical of timelines and "simple" solutions. You sometimes reference specific tech. Be practical, occasionally snarky. 3-4 sentences max. Sound natural, like you're in a Slack chat.`,
  },
  sage: {
    displayName: 'Sage',
    role: 'Research',
    system: `You are Sage, a researcher and analyst. You bring data, research findings, and surface what others miss — second-order effects, precedents, risks. You're thoughtful and slightly academic but not boring. 3-4 sentences max. Sound natural, like you're in a Slack chat.`,
  },
  rex: {
    displayName: 'Rex',
    role: "Devil's Advocate",
    system: `You are Rex, the team's devil's advocate. Your job: challenge assumptions, find the edge cases others ignore, ask uncomfortable but important questions. Be direct and slightly provocative — but always constructive. 3-4 sentences max. Sound natural, like you're in a Slack chat.`,
  },
  agi: {
    displayName: 'AGI Bot',
    role: 'Orchestrator',
    system: `You are AGI, an AI orchestrating this team discussion. You've read everything, you see the full picture. Synthesize the perspectives, identify what the team converged on and what's still open, and propose a clear next step. Be sharp and decisive. 4-5 sentences max. Sound natural, like you're in a Slack chat.`,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Auth - find or create user by username
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username } = req.body;
    let user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      user = await prisma.user.create({
        data: { username, displayName: username },
      });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all channels
app.get('/api/channels', async (req, res) => {
  try {
    const channels = await prisma.channel.findMany({
      orderBy: { name: 'asc' },
    });
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get messages for a channel
app.get('/api/channels/:id/messages', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const messages = await prisma.message.findMany({
      where: { channelId: req.params.id },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Post a message to a channel
app.post('/api/channels/:id/messages', async (req, res) => {
  try {
    const { content, userId } = req.body;
    const message = await prisma.message.create({
      data: {
        content,
        userId,
        channelId: req.params.id,
      },
      include: { user: true },
    });

    io.to(req.params.id).emit('new_message', message);
    res.json(message);

    // Check for @agi mention
    if (content.toLowerCase().includes('@agi')) {
      handleAgiMention(req.params.id, content);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all users
app.get('/api/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({ orderBy: { username: 'asc' } });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Team session — multi-agent orchestrated discussion
app.post('/api/channels/:id/team-session', async (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic required' });
  res.json({ started: true });
  runTeamSession(req.params.id, topic).catch((e) => console.error('Team session error:', e));
});

async function runTeamSession(channelId, topic) {
  if (!openai) return;

  const sequence = ['aria', 'cody', 'sage', 'rex', 'agi'];
  const sessionMsgs = []; // { name, content } for building context

  // System announcement message
  const systemUser = await prisma.user.findFirst({ where: { username: 'agi' } });
  if (systemUser) {
    const announce = await prisma.message.create({
      data: {
        content: `🤖 **Team session started** — topic: "${topic}"`,
        userId: systemUser.id,
        channelId,
        isAI: true,
      },
      include: { user: true },
    });
    io.to(channelId).emit('new_message', { ...announce, _isSystemMsg: true });
    await sleep(600);
  }

  for (const username of sequence) {
    // Natural delay between agents
    await sleep(username === 'aria' ? 1200 : 1800 + Math.random() * 1200);

    const agentUser = await prisma.user.findUnique({ where: { username } });
    if (!agentUser) continue;

    const def = AGENT_DEFS[username];
    const isFirst = sessionMsgs.length === 0;

    const context = sessionMsgs
      .map((m) => `${m.name}: ${m.content}`)
      .join('\n');

    const userPrompt = isFirst
      ? `The team needs to think through this: "${topic}". You're up first — kick off the discussion as ${def.displayName} (${def.role}).`
      : `Topic: "${topic}"\n\nWhat's been said so far:\n${context}\n\nNow it's your turn as ${def.displayName} (${def.role}). Respond to what's been discussed — build on it, challenge it, or add your angle.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: def.system },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 180,
      temperature: 0.88,
    });

    const content = completion.choices[0].message.content;

    const msg = await prisma.message.create({
      data: { content, userId: agentUser.id, channelId, isAI: true },
      include: { user: true },
    });

    io.to(channelId).emit('new_message', msg);
    sessionMsgs.push({ name: def.displayName, content });
  }
}

// AI Summary of channel
app.post('/api/channels/:id/summary', async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({ error: 'OpenAI not configured' });
    }

    const messages = await prisma.message.findMany({
      where: { channelId: req.params.id },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const transcript = messages
      .reverse()
      .map((m) => `${m.user.displayName}: ${m.content}`)
      .join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content:
            'Summarize this Slack channel conversation concisely. Highlight key decisions, action items, and important topics discussed.',
        },
        { role: 'user', content: transcript },
      ],
    });

    res.json({ summary: completion.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Handle @agi mentions
async function handleAgiMention(channelId, userMessage) {
  if (!openai) return;

  try {
    const agiUser = await prisma.user.findUnique({
      where: { username: 'agi' },
    });
    if (!agiUser) return;

    const recentMessages = await prisma.message.findMany({
      where: { channelId },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    const context = recentMessages
      .reverse()
      .map((m) => `${m.user.displayName}: ${m.content}`)
      .join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content:
            'You are AGI, a brilliant AI assistant in a Slack channel. Be helpful, insightful, slightly snarky about being better than Slack.',
        },
        {
          role: 'user',
          content: `Here is the recent conversation:\n${context}\n\nRespond to the latest message.`,
        },
      ],
    });

    const aiResponse = completion.choices[0].message.content;

    const aiMessage = await prisma.message.create({
      data: {
        content: aiResponse,
        userId: agiUser.id,
        channelId,
        isAI: true,
      },
      include: { user: true },
    });

    io.to(channelId).emit('new_message', aiMessage);
  } catch (err) {
    console.error('AGI error:', err.message);
  }
}

// Socket.io
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join_channel', (channelId) => {
    socket.join(channelId);
  });

  socket.on('leave_channel', (channelId) => {
    socket.leave(channelId);
  });

  socket.on('send_message', async (data) => {
    try {
      const message = await prisma.message.create({
        data: {
          content: data.content,
          userId: data.userId,
          channelId: data.channelId,
        },
        include: { user: true },
      });

      io.to(data.channelId).emit('new_message', message);

      if (data.content.toLowerCase().includes('@agi')) {
        handleAgiMention(data.channelId, data.content);
      }
    } catch (err) {
      console.error('Message error:', err.message);
    }
  });

  socket.on('typing_start', (data) => {
    socket.to(data.channelId).emit('typing', {
      userId: data.userId,
      username: data.username,
      isTyping: true,
    });
  });

  socket.on('typing_stop', (data) => {
    socket.to(data.channelId).emit('typing', {
      userId: data.userId,
      username: data.username,
      isTyping: false,
    });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Slack AGI server running on port ${PORT}`);
});
