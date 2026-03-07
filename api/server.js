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

// ── Agent execution tools ─────────────────────────────────
const AGENT_TOOLS = {
  cody: {
    name: 'write_technical_doc',
    artifactType: 'architecture',
    execute: async (task, context) => {
      const res = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are Cody, a senior engineer. Write a detailed technical document in markdown. Be specific, include code examples where relevant, cover architecture decisions, tradeoffs, and implementation notes.' },
          { role: 'user', content: `Task: ${task.title}\nContext: ${context}\n\nWrite the full technical document now.` }
        ],
        max_tokens: 800
      });
      return res.choices[0].message.content;
    }
  },
  sage: {
    name: 'write_research_report',
    artifactType: 'research_report',
    execute: async (task, context) => {
      const res = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are Sage, a researcher. Write a thorough research report in markdown. Include: ## Summary, ## Key Findings, ## Data Points, ## Risks & Considerations, ## Recommendations. Use specific examples, numbers, comparisons.' },
          { role: 'user', content: `Research task: ${task.title}\nContext: ${context}\n\nWrite the full research report now.` }
        ],
        max_tokens: 800
      });
      return res.choices[0].message.content;
    }
  },
  aria: {
    name: 'write_prd',
    artifactType: 'analysis',
    execute: async (task, context) => {
      const res = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are Aria, a Product Manager. Write a product document in markdown. Include: ## Problem Statement, ## Goals & Success Metrics, ## User Stories, ## Scope (In/Out), ## Milestones, ## Open Questions.' },
          { role: 'user', content: `Product task: ${task.title}\nContext: ${context}\n\nWrite the full product document now.` }
        ],
        max_tokens: 800
      });
      return res.choices[0].message.content;
    }
  },
  agi: {
    name: 'write_synthesis',
    artifactType: 'decision_doc',
    execute: async (task, context) => {
      const res = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are AGI, a superintelligent AI. Write a synthesis document in markdown. Be decisive: ## Executive Summary, ## Key Decision, ## Rationale, ## Risks Acknowledged, ## Immediate Next Steps (numbered, specific, assigned).' },
          { role: 'user', content: `Synthesis task: ${task.title}\nContext: ${context}\n\nWrite the full synthesis now.` }
        ],
        max_tokens: 800
      });
      return res.choices[0].message.content;
    }
  },
  rex: {
    name: 'write_risk_analysis',
    artifactType: 'analysis',
    execute: async (task, context) => {
      const res = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are Rex, a devil\'s advocate. Write a risk analysis in markdown. Include: ## Assumptions Challenged, ## Edge Cases, ## Failure Modes, ## Mitigation Strategies, ## Recommendation.' },
          { role: 'user', content: `Risk analysis task: ${task.title}\nContext: ${context}\n\nWrite the full risk analysis now.` }
        ],
        max_tokens: 800
      });
      return res.choices[0].message.content;
    }
  }
};

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Session lifecycle background job ──────────────────────
async function runLifecycleCheck() {
  const now = new Date();

  // 1. Auto-archive inactive sessions
  const staleSessions = await prisma.sessionThread.findMany({
    where: { status: 'active', autoCloseAt: { lt: now } }
  });
  for (const s of staleSessions) {
    await prisma.sessionThread.update({
      where: { id: s.id },
      data: { status: 'archived', completedAt: now }
    });
    if (s.channelId) {
      io.to(s.channelId).emit('session_archived', { sessionId: s.id, title: s.title, reason: 'inactivity' });
    }
  }

  // 2. Auto-archive expired ephemeral channels
  const expiredChannels = await prisma.channel.findMany({
    where: { isEphemeral: true, expiresAt: { lt: now } }
  });
  for (const ch of expiredChannels) {
    if (!ch.name.startsWith('[archived]')) {
      await prisma.channel.update({
        where: { id: ch.id },
        data: { name: `[archived] ${ch.name}` }
      });
      io.emit('channel_archived', { channelId: ch.id, name: ch.name });
    }
  }
}
setInterval(runLifecycleCheck, 5 * 60 * 1000);

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
    } else {
      // Passive agent participation — agents chime in naturally
      passiveAgentResponse(req.params.id, content, userId);
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

// Get user profile
app.get('/api/users/:id/profile', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        profile: true,
        missionMembers: { include: { mission: true } },
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all active missions
app.get('/api/missions', async (req, res) => {
  try {
    const missions = await prisma.mission.findMany({
      where: { status: 'active' },
      include: {
        members: { include: { user: true } },
        tasks: { include: { assignee: true } },
        topics: { include: { artifacts: true, questions: true } },
        artifacts: { include: { createdBy: true } },
        createdBy: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(missions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a mission with AI team assignment
app.post('/api/missions', async (req, res) => {
  try {
    const { title, objective, channelId, createdById } = req.body;
    if (!title || !objective || !createdById) {
      return res.status(400).json({ error: 'title, objective, and createdById required' });
    }

    const mission = await prisma.mission.create({
      data: { title, objective, channelId, createdById },
    });

    // Fetch all user profiles for AI team assignment
    const allUsers = await prisma.user.findMany({ include: { profile: true } });
    const profileSummaries = allUsers
      .filter((u) => u.profile)
      .map((u) => `- ${u.displayName} (id: ${u.id}, bot: ${u.isBot}): skills=${u.profile.skills}, bio="${u.profile.bio}", tz=${u.profile.timezone}`)
      .join('\n');

    let members = [{ userId: createdById, role: 'lead' }];

    if (openai) {
      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: 'You are a team builder. Given a mission objective and team profiles, select the best 3-5 members (mix of humans and AI agents). Return JSON only: { "members": [{"userId": "...", "role": "lead|contributor|observer", "reason": "..."}] }',
            },
            {
              role: 'user',
              content: `Mission: "${title}"\nObjective: ${objective}\n\nAvailable team:\n${profileSummaries}`,
            },
          ],
          temperature: 0.7,
          response_format: { type: 'json_object' },
        });

        const parsed = JSON.parse(completion.choices[0].message.content);
        if (parsed.members && Array.isArray(parsed.members)) {
          members = parsed.members;
        }
      } catch (e) {
        console.error('AI team assignment failed, using creator only:', e.message);
      }
    }

    // Create MissionMember records
    for (const m of members) {
      const userExists = allUsers.some((u) => u.id === m.userId);
      if (!userExists) continue;
      await prisma.missionMember.upsert({
        where: { missionId_userId: { missionId: mission.id, userId: m.userId } },
        update: { role: m.role },
        create: { missionId: mission.id, userId: m.userId, role: m.role },
      });
    }

    // Auto-generate Project Brief artifact
    let briefArtifact = null;
    if (openai) {
      try {
        const memberSummaries = members
          .map((m) => {
            const u = allUsers.find((u) => u.id === m.userId);
            return u ? `${u.displayName} (${m.role})` : null;
          })
          .filter(Boolean)
          .join(', ');

        const briefCompletion = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content:
                'Generate a project brief for a software/product mission in markdown. Include: ## Objective, ## Success Metrics, ## Key Risks, ## Initial Topics, ## Suggested Team Roles. Under "Initial Topics" list exactly 3 topics as bullet points with format: - **Topic Title**: Description.',
            },
            {
              role: 'user',
              content: `Mission: "${title}"\nObjective: ${objective}\nTeam: ${memberSummaries}`,
            },
          ],
          temperature: 0.7,
        });

        const briefContent = briefCompletion.choices[0].message.content;

        // Find the human team lead
        const leadMember = members.find((m) => m.role === 'lead');
        const leadUser = leadMember ? allUsers.find((u) => u.id === leadMember.userId && !u.isBot) : null;
        const reviewerUser = leadUser || allUsers.find((u) => u.id === createdById);

        const agiUser = await prisma.user.findUnique({ where: { username: 'agi' } });
        const creatorId = agiUser?.id || createdById;

        briefArtifact = await prisma.artifact.create({
          data: {
            missionId: mission.id,
            type: 'project_brief',
            title: `Project Brief: ${title}`,
            content: briefContent,
            status: 'draft',
            createdById: creatorId,
            reviewerId: reviewerUser?.id,
          },
        });

        // Create inbox item for reviewer
        if (reviewerUser) {
          const inboxItem = await prisma.inboxItem.create({
            data: {
              userId: reviewerUser.id,
              type: 'artifact_review',
              title: `Review: Project Brief — ${title}`,
              priority: 'high',
              artifactId: briefArtifact.id,
              missionId: mission.id,
              fromAgent: 'agi',
            },
          });
          io.emit('inbox_update', { userId: reviewerUser.id, item: inboxItem });
        }

        // Auto-create 3 MissionTopics from the brief
        const topicRegex = /- \*\*(.+?)\*\*:\s*(.+)/g;
        let match;
        while ((match = topicRegex.exec(briefContent)) !== null) {
          await prisma.missionTopic.create({
            data: { missionId: mission.id, title: match[1], description: match[2].trim() },
          });
        }
      } catch (e) {
        console.error('Project brief generation failed:', e.message);
      }
    }

    const fullMission = await prisma.mission.findUnique({
      where: { id: mission.id },
      include: {
        members: { include: { user: { include: { profile: true } } } },
        tasks: true,
        topics: true,
        artifacts: true,
        createdBy: true,
      },
    });

    io.emit('mission_created', fullMission);
    res.json(fullMission);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Match agent — find ideal team for a problem
app.post('/api/channels/:id/match', async (req, res) => {
  try {
    const { problem, requesterId } = req.body;
    if (!problem) return res.status(400).json({ error: 'problem required' });

    const allUsers = await prisma.user.findMany({ include: { profile: true } });
    const profileSummaries = allUsers
      .filter((u) => u.profile)
      .map((u) => `- ${u.displayName} (id: ${u.id}, username: ${u.username}, bot: ${u.isBot}): skills=${u.profile.skills}, bio="${u.profile.bio}"`)
      .join('\n');

    let matchData = { matches: [], summary: 'AI not configured' };

    if (openai) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are a team matcher. Given a problem and team profiles (humans and AI agents), identify who should be involved and why. Consider that AI agents are always available. Return JSON only: { "matches": [{"userId": "...", "displayName": "...", "username": "...", "role": "...", "reason": "...", "isBot": true/false}], "summary": "..." }',
          },
          {
            role: 'user',
            content: `Problem: "${problem}"\n\nTeam profiles:\n${profileSummaries}`,
          },
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      });

      matchData = JSON.parse(completion.choices[0].message.content);
    }

    // Save match result as AGI message
    const agiUser = await prisma.user.findUnique({ where: { username: 'agi' } });

    // Create ephemeral group for matched team
    let ephemeralChannelId = null;
    const matchedUserIds = (matchData.matches || []).map(m => m.userId).filter(Boolean);
    if (matchedUserIds.length > 0) {
      try {
        const matchedUsers = await prisma.user.findMany({ where: { id: { in: matchedUserIds } } });
        const slugNames = matchedUsers.map(u => u.username).join('-');
        const topicSlug = problem.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
        const ephName = `${slugNames}--${topicSlug}`;
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const ephChannel = await prisma.channel.create({
          data: {
            name: ephName,
            description: `Matcher group for: ${problem}`,
            isEphemeral: true,
            expiresAt,
            ephemeralTag: ephName,
          },
        });
        ephemeralChannelId = ephChannel.id;
        // Add members
        for (const uid of matchedUserIds) {
          await prisma.channelMember.create({
            data: { channelId: ephChannel.id, userId: uid },
          }).catch(() => {});
        }
        io.emit('channel_created', ephChannel);
        // Post intro message
        if (agiUser) {
          const introMsg = await prisma.message.create({
            data: {
              content: `🎯 This group was created by the Matcher for: **${problem}**. It auto-closes in 24h or when the task is done.`,
              userId: agiUser.id,
              channelId: ephChannel.id,
              isAI: true,
            },
            include: { user: true },
          });
          io.to(ephChannel.id).emit('new_message', introMsg);
        }
      } catch (e) {
        console.error('Ephemeral channel creation failed:', e.message);
      }
    }

    if (agiUser) {
      const matchLines = (matchData.matches || []).map((m) => {
        const emoji = m.isBot ? '🤖' : '👤';
        return `${emoji} **${m.displayName}** \`${m.role}\` — ${m.reason}`;
      }).join('\n');

      const msgContent = `🎯 **Team Match for:** ${problem}\n\n${matchLines}\n\n${matchData.summary || ''}`;

      const msg = await prisma.message.create({
        data: {
          content: msgContent,
          userId: agiUser.id,
          channelId: req.params.id,
          isAI: true,
        },
        include: { user: true },
      });

      io.to(req.params.id).emit('new_message', msg);
    }

    res.json({ ...matchData, ephemeralChannelId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update mission task status
app.patch('/api/missions/:id/tasks/:taskId', async (req, res) => {
  try {
    const { status } = req.body;
    const task = await prisma.missionTask.update({
      where: { id: req.params.taskId },
      data: { status },
      include: { assignee: true },
    });
    io.emit('task_updated', { missionId: req.params.id, task });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add task to mission
app.post('/api/missions/:id/tasks', async (req, res) => {
  try {
    const { title, assigneeId } = req.body;
    const task = await prisma.missionTask.create({
      data: { missionId: req.params.id, title, assigneeId },
      include: { assignee: true },
    });
    io.emit('task_created', { missionId: req.params.id, task });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TOPICS ────────────────────────────────────────────────

// Create a topic for a mission
app.post('/api/missions/:id/topics', async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const topic = await prisma.missionTopic.create({
      data: { missionId: req.params.id, title, description },
    });
    res.json(topic);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get topics for a mission
app.get('/api/missions/:id/topics', async (req, res) => {
  try {
    const topics = await prisma.missionTopic.findMany({
      where: { missionId: req.params.id },
      include: { artifacts: true, questions: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(topics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ARTIFACTS ─────────────────────────────────────────────

// Create an artifact
app.post('/api/artifacts', async (req, res) => {
  try {
    const { missionId, topicId, channelId, type, title, content, createdById, reviewerId } = req.body;
    if (!type || !title || !content || !createdById) {
      return res.status(400).json({ error: 'type, title, content, createdById required' });
    }
    const artifact = await prisma.artifact.create({
      data: { missionId, topicId, channelId, type, title, content, createdById, reviewerId },
      include: { createdBy: true, reviewer: true },
    });

    // Create inbox item for reviewer if provided
    if (reviewerId) {
      const inboxItem = await prisma.inboxItem.create({
        data: {
          userId: reviewerId,
          type: 'artifact_review',
          title: `Review needed: ${title}`,
          priority: 'high',
          artifactId: artifact.id,
          missionId,
          fromAgent: artifact.createdBy?.username,
        },
      });
      io.emit('inbox_update', { userId: reviewerId, item: inboxItem });
    }

    res.json(artifact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get an artifact
app.get('/api/artifacts/:id', async (req, res) => {
  try {
    const artifact = await prisma.artifact.findUnique({
      where: { id: req.params.id },
      include: { createdBy: true, reviewer: true, topic: true, mission: true },
    });
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
    res.json(artifact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update an artifact
app.patch('/api/artifacts/:id', async (req, res) => {
  try {
    const { status, content } = req.body;
    const data = {};
    if (status) data.status = status;
    if (content) data.content = content;
    const artifact = await prisma.artifact.update({
      where: { id: req.params.id },
      data,
      include: { createdBy: true, reviewer: true },
    });
    res.json(artifact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── INBOX ─────────────────────────────────────────────────

// Get user inbox
app.get('/api/users/:id/inbox', async (req, res) => {
  try {
    const items = await prisma.inboxItem.findMany({
      where: { userId: req.params.id, status: 'pending' },
      include: { artifact: true, question: true, mission: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Act on inbox item
app.post('/api/inbox/:id/action', async (req, res) => {
  try {
    const { action, answer } = req.body;
    const item = await prisma.inboxItem.findUnique({
      where: { id: req.params.id },
      include: { artifact: true, question: true },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    if (action === 'approve' && item.artifactId) {
      await prisma.artifact.update({ where: { id: item.artifactId }, data: { status: 'approved' } });
      await prisma.inboxItem.update({ where: { id: item.id }, data: { status: 'done', doneAt: new Date() } });
    } else if (action === 'reject' && item.artifactId) {
      await prisma.artifact.update({ where: { id: item.artifactId }, data: { status: 'rejected' } });
      await prisma.inboxItem.update({ where: { id: item.id }, data: { status: 'done', doneAt: new Date() } });
    } else if (action === 'answer' && item.questionId) {
      const question = await prisma.blockingQuestion.update({
        where: { id: item.questionId },
        data: { answer, status: 'answered', answeredAt: new Date() },
      });
      await prisma.inboxItem.update({ where: { id: item.id }, data: { status: 'done', doneAt: new Date() } });
      if (question.channelId) {
        io.to(question.channelId).emit('question_answered', question);
      }
    } else if (action === 'dismiss') {
      await prisma.inboxItem.update({ where: { id: item.id }, data: { status: 'dismissed', doneAt: new Date() } });
    }

    const updated = await prisma.inboxItem.findUnique({
      where: { id: item.id },
      include: { artifact: true, question: true },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BLOCKING QUESTIONS ────────────────────────────────────

// Create a blocking question
app.post('/api/channels/:id/blocking-question', async (req, res) => {
  try {
    const { agentUsername, question, context, assigneeId, missionId, topicId } = req.body;
    if (!agentUsername || !question || !assigneeId) {
      return res.status(400).json({ error: 'agentUsername, question, assigneeId required' });
    }

    const bq = await prisma.blockingQuestion.create({
      data: {
        channelId: req.params.id,
        agentUsername,
        question,
        context,
        assigneeId,
        missionId,
        topicId,
      },
    });

    // Create inbox item for assignee
    const inboxItem = await prisma.inboxItem.create({
      data: {
        userId: assigneeId,
        type: 'blocking_question',
        title: `${agentUsername} asks: ${question.slice(0, 80)}`,
        description: context,
        questionId: bq.id,
        missionId,
        fromAgent: agentUsername,
      },
    });

    io.to(req.params.id).emit('blocking_question', bq);
    io.emit('inbox_update', { userId: assigneeId, item: inboxItem });
    res.json(bq);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SESSIONS ─────────────────────────────────────────────

// Create a session
app.post('/api/sessions', async (req, res) => {
  try {
    const { channelId, missionId, topicId, type, title, ttlMinutes = 120, memberIds, createdById } = req.body;
    if (!type || !title || !createdById) {
      return res.status(400).json({ error: 'type, title, createdById required' });
    }
    const now = new Date();
    const autoCloseAt = new Date(now.getTime() + (ttlMinutes || 120) * 60 * 1000);
    const session = await prisma.sessionThread.create({
      data: {
        channelId, missionId, topicId, type, title,
        ttlMinutes: ttlMinutes || 120,
        autoCloseAt,
        memberIds: JSON.stringify(memberIds || []),
        createdById,
      },
    });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const where = {};
    if (req.query.channelId) where.channelId = req.query.channelId;
    if (req.query.status) where.status = req.query.status;
    const sessions = await prisma.sessionThread.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a session
app.patch('/api/sessions/:id', async (req, res) => {
  try {
    const { status, lastActivityAt } = req.body;
    const data = {};
    if (status) {
      data.status = status;
      if (status === 'completed') data.completedAt = new Date();
    }
    if (lastActivityAt) {
      data.lastActivityAt = new Date(lastActivityAt);
      // Recalculate autoCloseAt
      const session = await prisma.sessionThread.findUnique({ where: { id: req.params.id } });
      if (session) {
        data.autoCloseAt = new Date(new Date(lastActivityAt).getTime() + session.ttlMinutes * 60 * 1000);
      }
    }
    const session = await prisma.sessionThread.update({
      where: { id: req.params.id },
      data,
    });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EPHEMERAL CHANNELS ──────────────────────────────────

// Create ephemeral channel
app.post('/api/channels/ephemeral', async (req, res) => {
  try {
    const { name, memberIds, ttlHours = 24, missionId, purpose, createdById } = req.body;
    if (!name || !memberIds || !createdById) {
      return res.status(400).json({ error: 'name, memberIds, createdById required' });
    }
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    const channel = await prisma.channel.create({
      data: {
        name,
        description: purpose || null,
        isEphemeral: true,
        expiresAt,
        ephemeralTag: name,
      },
    });
    // Auto-create ChannelMember records
    for (const userId of memberIds) {
      await prisma.channelMember.create({
        data: { channelId: channel.id, userId },
      }).catch(() => {}); // ignore if already exists
    }
    io.emit('channel_created', channel);
    res.json(channel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Archive a channel
app.delete('/api/channels/:id/archive', async (req, res) => {
  try {
    const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const updatedName = channel.name.startsWith('[archived]') ? channel.name : `[archived] ${channel.name}`;
    const updated = await prisma.channel.update({
      where: { id: req.params.id },
      data: { name: updatedName },
    });
    io.emit('channel_archived', { channelId: channel.id, name: channel.name });
    res.json(updated);
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

  // Create SessionThread
  const agentUsers = await Promise.all(
    sequence.map(u => prisma.user.findUnique({ where: { username: u } }))
  );
  const agentIds = agentUsers.filter(Boolean).map(u => u.id);
  const agiCreator = agentUsers.find(u => u?.username === 'agi');
  let sessionThread = null;
  if (agiCreator) {
    const now = new Date();
    sessionThread = await prisma.sessionThread.create({
      data: {
        channelId,
        type: 'team_session',
        title: `Team: ${topic}`,
        ttlMinutes: 240,
        autoCloseAt: new Date(now.getTime() + 240 * 60 * 1000),
        memberIds: JSON.stringify(agentIds),
        createdById: agiCreator.id,
      },
    });
    io.to(channelId).emit('session_created', sessionThread);
  }

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

  // Fetch human team context for this channel
  const humanContext = await buildTeamContext(channelId);
  const humanContextBlock = humanContext
    ? `\n\nHUMAN TEAM CONTEXT:\n${humanContext}\nReference specific humans by name when their skills are relevant.`
    : '';

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
        { role: 'system', content: def.system + humanContextBlock },
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

  // Generate Decision Document artifact after team session
  try {
    const fullDiscussion = sessionMsgs.map((m) => `${m.name}: ${m.content}`).join('\n\n');
    const docCompletion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'Based on this team discussion, generate a Decision Document in markdown format. Include: ## Decision, ## Rationale, ## Key Concerns (from Rex), ## Next Steps, ## Team Assignments.',
        },
        {
          role: 'user',
          content: `Topic: "${topic}"\n\nDiscussion:\n${fullDiscussion}`,
        },
      ],
      temperature: 0.6,
    });

    const docContent = docCompletion.choices[0].message.content;
    const agiUser = await prisma.user.findUnique({ where: { username: 'agi' } });

    // Find first non-bot user in channel to be reviewer
    const channelMembers = await prisma.channelMember.findMany({
      where: { channelId },
      include: { user: true },
    });
    const reviewer = channelMembers.find((cm) => !cm.user.isBot)?.user;

    if (agiUser) {
      const artifact = await prisma.artifact.create({
        data: {
          channelId,
          type: 'decision_doc',
          title: `Decision: ${topic}`,
          content: docContent,
          status: 'draft',
          createdById: agiUser.id,
          reviewerId: reviewer?.id,
        },
        include: { createdBy: true, reviewer: true },
      });

      io.to(channelId).emit('artifact_created', artifact);

      if (reviewer) {
        const inboxItem = await prisma.inboxItem.create({
          data: {
            userId: reviewer.id,
            type: 'artifact_review',
            title: `Review needed: Decision Doc — ${topic}`,
            priority: 'high',
            artifactId: artifact.id,
            fromAgent: 'agi',
          },
        });
        io.emit('inbox_update', { userId: reviewer.id, item: inboxItem });
      }

      const reviewerName = reviewer?.displayName || 'the team';
      const notifyMsg = await prisma.message.create({
        data: {
          content: `📄 I've drafted a **Decision Document** based on our discussion. It's been sent to ${reviewerName} for review. Check your inbox.`,
          userId: agiUser.id,
          channelId,
          isAI: true,
        },
        include: { user: true },
      });
      io.to(channelId).emit('new_message', notifyMsg);

      // Mark session as completed
      if (sessionThread) {
        await prisma.sessionThread.update({
          where: { id: sessionThread.id },
          data: { status: 'completed', completedAt: new Date(), artifactId: artifact.id },
        });
        io.to(channelId).emit('session_completed', { sessionId: sessionThread.id, title: sessionThread.title });
      }

      // Generate ActionPlan from the discussion
      try {
        const allUsers = await prisma.user.findMany();
        const usernames = allUsers.map(u => u.username).join(', ');
        const planCompletion = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: `You are AGI. Based on this team discussion, generate a concrete action plan. Return JSON with:
{
  "title": "string",
  "context": "2-3 sentence summary",
  "items": [
    { "title": "string", "description": "string", "assigneeUsername": "string", "canAutoExecute": true/false, "order": 0 }
  ]
}
assigneeUsername must be one of: ${usernames}
canAutoExecute=true only for: agi, aria, cody, sage, rex (AI agents)
Generate 3-5 action items. Be specific.`
            },
            {
              role: 'user',
              content: `Topic: "${topic}"\n\nDiscussion:\n${fullDiscussion}`
            }
          ],
          temperature: 0.6,
          response_format: { type: 'json_object' },
        });

        const planData = JSON.parse(planCompletion.choices[0].message.content);

        // Create ActionPlan record
        const actionPlan = await prisma.actionPlan.create({
          data: {
            sessionId: sessionThread?.id,
            channelId,
            title: planData.title || `Plan: ${topic}`,
            context: planData.context || '',
            status: 'draft',
          },
        });

        // Create ActionItem records
        const planItems = [];
        for (const item of (planData.items || [])) {
          const assigneeUser = allUsers.find(u => u.username === item.assigneeUsername);
          if (!assigneeUser) continue;
          const actionItem = await prisma.actionItem.create({
            data: {
              planId: actionPlan.id,
              title: item.title,
              description: item.description || null,
              assigneeId: assigneeUser.id,
              canAutoExecute: !!item.canAutoExecute,
              order: item.order || 0,
            },
            include: { assignee: true },
          });
          planItems.push(actionItem);
        }

        // Fetch full plan with items
        const fullPlan = await prisma.actionPlan.findUnique({
          where: { id: actionPlan.id },
          include: { items: { include: { assignee: { include: { profile: true } } }, orderBy: { order: 'asc' } } },
        });

        // Create inbox item for the session creator / channel reviewer
        const planRecipient = reviewer || (agiUser ? await prisma.user.findFirst({ where: { isBot: false } }) : null);
        if (planRecipient) {
          const inboxItem = await prisma.inboxItem.create({
            data: {
              userId: planRecipient.id,
              type: 'decision',
              title: `Action Plan ready: ${fullPlan.title}`,
              priority: 'high',
              fromAgent: 'agi',
            },
          });
          io.emit('inbox_update', { userId: planRecipient.id, item: inboxItem });
        }

        // Emit socket event
        io.to(channelId).emit('action_plan_ready', fullPlan);

        // Send message in channel
        const planNotifyMsg = await prisma.message.create({
          data: {
            content: `📋 **Action Plan ready** — ${planItems.length} tasks generated. Check your inbox to review and execute.`,
            userId: agiUser.id,
            channelId,
            isAI: true,
          },
          include: { user: true },
        });
        io.to(channelId).emit('new_message', planNotifyMsg);
      } catch (planErr) {
        console.error('Action plan generation failed:', planErr.message);
      }
    }
  } catch (e) {
    console.error('Decision doc generation failed:', e.message);
    // Still try to complete the session even if doc fails
    if (sessionThread) {
      await prisma.sessionThread.update({
        where: { id: sessionThread.id },
        data: { status: 'completed', completedAt: new Date() },
      }).catch(() => {});
    }
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

// Helper: build team context from channel participants
async function buildTeamContext(channelId) {
  const recentMessages = await prisma.message.findMany({
    where: { channelId },
    include: { user: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const userIds = [...new Set(recentMessages.map((m) => m.userId))];
  const profiles = await prisma.userProfile.findMany({
    where: { userId: { in: userIds } },
    include: { user: true },
  });
  if (profiles.length === 0) return '';
  const lines = profiles
    .filter((p) => !p.user.isBot)
    .map((p) => `${p.user.displayName} (skills: ${p.skills}): ${p.bio}`);
  return lines.length > 0 ? `TEAM CONTEXT:\n${lines.join('\n')}` : '';
}

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

    const teamContext = await buildTeamContext(channelId);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are AGI, a brilliant AI assistant in a Slack channel. Be helpful, insightful, slightly snarky about being better than Slack. You know your team members and can reference their specific skills and backgrounds when relevant.\n\n${teamContext}`,
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

// ── ACTION PLANS ────────────────────────────────────────────

// Get action plan by ID
app.get('/api/action-plans/:id', async (req, res) => {
  try {
    const plan = await prisma.actionPlan.findUnique({
      where: { id: req.params.id },
      include: {
        items: {
          include: { assignee: { include: { profile: true } }, artifact: true },
          orderBy: { order: 'asc' },
        },
        session: true,
        mission: true,
        approvedBy: true,
      },
    });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update action plan
app.patch('/api/action-plans/:id', async (req, res) => {
  try {
    const { status, approvedById } = req.body;
    const data = {};
    if (status) data.status = status;
    if (approvedById) {
      data.approvedById = approvedById;
      data.approvedAt = new Date();
    }
    const plan = await prisma.actionPlan.update({
      where: { id: req.params.id },
      data,
      include: { items: { include: { assignee: true }, orderBy: { order: 'asc' } } },
    });
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update action item
app.patch('/api/action-plans/:id/items/:itemId', async (req, res) => {
  try {
    const { title, description, assigneeId, status, canAutoExecute } = req.body;
    const data = {};
    if (title !== undefined) data.title = title;
    if (description !== undefined) data.description = description;
    if (assigneeId !== undefined) data.assigneeId = assigneeId;
    if (status !== undefined) data.status = status;
    if (canAutoExecute !== undefined) data.canAutoExecute = canAutoExecute;
    const item = await prisma.actionItem.update({
      where: { id: req.params.itemId },
      data,
      include: { assignee: { include: { profile: true } } },
    });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add item to plan
app.post('/api/action-plans/:id/items', async (req, res) => {
  try {
    const { title, description, assigneeId, canAutoExecute } = req.body;
    if (!title || !assigneeId) return res.status(400).json({ error: 'title, assigneeId required' });
    // Get max order
    const maxItem = await prisma.actionItem.findFirst({
      where: { planId: req.params.id },
      orderBy: { order: 'desc' },
    });
    const item = await prisma.actionItem.create({
      data: {
        planId: req.params.id,
        title,
        description: description || null,
        assigneeId,
        canAutoExecute: !!canAutoExecute,
        order: (maxItem?.order || 0) + 1,
      },
      include: { assignee: { include: { profile: true } } },
    });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete item from plan
app.delete('/api/action-plans/:id/items/:itemId', async (req, res) => {
  try {
    await prisma.actionItem.delete({ where: { id: req.params.itemId } });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Execute action plan — the "Go" button
app.post('/api/action-plans/:id/execute', async (req, res) => {
  const { approvedById } = req.body;
  if (!approvedById) return res.status(400).json({ error: 'approvedById required' });

  try {
    // Set plan status to executing
    await prisma.actionPlan.update({
      where: { id: req.params.id },
      data: { status: 'executing', approvedById, approvedAt: new Date() },
    });

    const plan = await prisma.actionPlan.findUnique({
      where: { id: req.params.id },
      include: {
        items: { include: { assignee: true }, orderBy: { order: 'asc' } },
      },
    });

    res.json({ started: true, planId: plan.id });

    // Execute asynchronously
    executeActionPlan(plan).catch(e => console.error('Plan execution error:', e));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function executeActionPlan(plan) {
  const allUsers = await prisma.user.findMany();

  for (const item of plan.items) {
    if (!item.canAutoExecute || item.status !== 'pending') {
      // Human task — create inbox item
      if (!item.canAutoExecute && item.status === 'pending') {
        await prisma.inboxItem.create({
          data: {
            userId: item.assigneeId,
            type: 'decision',
            title: `Task assigned: ${item.title}`,
            description: item.description,
            priority: 'normal',
            fromAgent: 'agi',
          },
        });
        io.emit('inbox_update', { userId: item.assigneeId });
      }
      continue;
    }

    const agentUsername = item.assignee?.username;
    const tool = AGENT_TOOLS[agentUsername];
    if (!tool) continue;

    // Set executing
    await prisma.actionItem.update({ where: { id: item.id }, data: { status: 'executing' } });
    io.emit('item_executing', { planId: plan.id, itemId: item.id, assigneeUsername: agentUsername });

    await sleep(1500);

    try {
      // Execute agent tool
      const content = await tool.execute(item, plan.context);

      // Find the agent user
      const agentUser = allUsers.find(u => u.username === agentUsername);

      // Create artifact
      const artifact = await prisma.artifact.create({
        data: {
          channelId: plan.channelId,
          type: tool.artifactType,
          title: item.title,
          content,
          status: 'draft',
          createdById: agentUser?.id || item.assigneeId,
        },
        include: { createdBy: true },
      });

      // Update item
      await prisma.actionItem.update({
        where: { id: item.id },
        data: { status: 'done', outputArtifactId: artifact.id, executedAt: new Date() },
      });

      io.emit('item_done', { planId: plan.id, itemId: item.id, artifact });

      // Create inbox item for plan approver to review
      if (plan.approvedById) {
        await prisma.inboxItem.create({
          data: {
            userId: plan.approvedById,
            type: 'artifact_review',
            title: `Review: ${artifact.title}`,
            priority: 'normal',
            artifactId: artifact.id,
            fromAgent: agentUsername,
          },
        });
        io.emit('inbox_update', { userId: plan.approvedById });
      }
    } catch (execErr) {
      console.error(`Execution failed for item ${item.id}:`, execErr.message);
      await prisma.actionItem.update({ where: { id: item.id }, data: { status: 'pending' } });
    }
  }

  // Mark plan as completed
  await prisma.actionPlan.update({
    where: { id: plan.id },
    data: { status: 'completed' },
  });
  io.emit('plan_executed', { planId: plan.id });
}

// Update artifact content (human edits)
app.patch('/api/artifacts/:id/content', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    const artifact = await prisma.artifact.update({
      where: { id: req.params.id },
      data: { content },
      include: { createdBy: true, reviewer: true },
    });
    res.json(artifact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PASSIVE AGENT RESPONSES ─────────────────────────────────
function pickRelevantAgent(content) {
  const t = content.toLowerCase();
  if (/código|code|api|arquitectura|architect|implement|backend|frontend|deploy|bug|fix|server/i.test(t)) return 'cody';
  if (/research|datos|data|competidor|mercado|market|estudio|análisis|analysis/i.test(t)) return 'sage';
  if (/usuario|user|producto|product|feature|roadmap|prioridad|ux|diseño/i.test(t)) return 'aria';
  if (/problema|risk|riesgo|preocupa|concern|falla|issue|pero|aunque|sin embargo/i.test(t)) return 'rex';
  if (Math.random() < 0.25) return 'agi'; // 25% chance AGI adds something
  return null;
}

async function passiveAgentResponse(channelId, content, senderId) {
  if (!openai) return;
  try {
    // Don't trigger on very short messages
    if (content.trim().length < 12) return;

    // Don't respond if sender is a bot
    const sender = await prisma.user.findUnique({ where: { id: senderId } });
    if (sender?.isBot) return;

    // Rate limit: don't pile on if bots already spoke recently
    const recent = await prisma.message.findMany({
      where: { channelId },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
      take: 4,
    });
    const recentBotCount = recent.filter(m => m.user.isBot).length;
    if (recentBotCount >= 2) return;

    // Detect natural team session request
    const teamTrigger = /\b(hagamos|lancemos|start|arrancemos|necesito|quiero|podemos)\b.{0,40}\b(team|equipo|session|sesión|discutir|debatir|analizar)\b/i.test(content)
      || /\b(team session|team sobre|equipo sobre|sesión sobre)\b/i.test(content);

    if (teamTrigger) {
      await sleep(1500);
      runTeamSession(channelId, content);
      // Announce it
      const agiUser = await prisma.user.findUnique({ where: { username: 'agi' } });
      if (agiUser) {
        const announce = await prisma.message.create({
          data: { content: `🤖 Detecté que querés una team session sobre esto. Convocando al equipo...`, userId: agiUser.id, channelId, isAI: true },
          include: { user: true },
        });
        io.to(channelId).emit('new_message', announce);
      }
      return;
    }

    const agentUsername = pickRelevantAgent(content);
    if (!agentUsername) return;

    const agentUser = await prisma.user.findUnique({ where: { username: agentUsername } });
    if (!agentUser) return;
    const def = AGENT_DEFS[agentUsername];

    // Natural delay
    await sleep(2500 + Math.random() * 2000);

    const msgContext = await prisma.message.findMany({
      where: { channelId },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
      take: 12,
    });
    const context = msgContext.reverse().map(m => `${m.user.displayName}: ${m.content}`).join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `${def.system}\n\nYou're a member of a Slack channel. Respond ONLY if you have something genuinely useful to add — a concrete insight, a concern, or relevant info from your area. If the conversation doesn't need your input right now, respond with exactly "PASS". Max 2-3 sentences. Natural, direct tone.`
        },
        {
          role: 'user',
          content: `Conversation:\n${context}\n\nDo you want to add something? (PASS if not needed)`
        }
      ],
      max_tokens: 100,
      temperature: 0.75,
    });

    const response = completion.choices[0].message.content.trim();
    if (!response || response.toUpperCase().startsWith('PASS')) return;

    const msg = await prisma.message.create({
      data: { content: response, userId: agentUser.id, channelId, isAI: true },
      include: { user: true },
    });
    io.to(channelId).emit('new_message', msg);
  } catch (err) {
    console.error('Passive agent error:', err.message);
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
