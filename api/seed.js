import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function seed() {
  console.log('Seeding database...');

  // Create users
  const users = await Promise.all([
    prisma.user.upsert({
      where: { username: 'alice' },
      update: {},
      create: { username: 'alice', displayName: 'Alice Chen' },
    }),
    prisma.user.upsert({
      where: { username: 'bob' },
      update: {},
      create: { username: 'bob', displayName: 'Bob Martinez' },
    }),
    prisma.user.upsert({
      where: { username: 'carol' },
      update: {},
      create: { username: 'carol', displayName: 'Carol Zhang' },
    }),
    prisma.user.upsert({
      where: { username: 'dave' },
      update: {},
      create: { username: 'dave', displayName: 'Dave Kumar' },
    }),
    prisma.user.upsert({
      where: { username: 'agi' },
      update: {},
      create: { username: 'agi', displayName: 'AGI Bot', isBot: true },
    }),
    prisma.user.upsert({
      where: { username: 'aria' },
      update: {},
      create: { username: 'aria', displayName: 'Aria', isBot: true },
    }),
    prisma.user.upsert({
      where: { username: 'cody' },
      update: {},
      create: { username: 'cody', displayName: 'Cody', isBot: true },
    }),
    prisma.user.upsert({
      where: { username: 'sage' },
      update: {},
      create: { username: 'sage', displayName: 'Sage', isBot: true },
    }),
    prisma.user.upsert({
      where: { username: 'rex' },
      update: {},
      create: { username: 'rex', displayName: 'Rex', isBot: true },
    }),
  ]);

  const [alice, bob, carol, dave, agi, aria, cody, sage, rex] = users;
  console.log(`Created ${users.length} users`);

  // Create user profiles
  const profiles = [
    { userId: alice.id, bio: 'Product lead obsessed with user problems. Strong on strategy, weak on backend.', skills: JSON.stringify(['Product Strategy','UX Research','Roadmapping']), timezone: 'America/New_York' },
    { userId: bob.id, bio: 'Senior engineer. Loves clean architecture. Hates meetings.', skills: JSON.stringify(['Python','System Design','APIs','PostgreSQL']), timezone: 'Europe/London' },
    { userId: carol.id, bio: 'ML engineer turned researcher. Goes deep on technical problems.', skills: JSON.stringify(['Machine Learning','Data Analysis','Python','RAG systems']), timezone: 'Asia/Shanghai' },
    { userId: dave.id, bio: 'Full-stack dev. Can ship fast. Cares about UX.', skills: JSON.stringify(['Frontend','React','Node.js','DevOps']), timezone: 'America/Los_Angeles' },
    { userId: agi.id, bio: 'Superintelligent AI. Reads all context. Synthesizes fast. Slightly smug about it.', skills: JSON.stringify(['Orchestration','Synthesis','Planning','Everything']), timezone: 'UTC' },
    { userId: aria.id, bio: 'AI product lead. Turns ambiguity into clarity.', skills: JSON.stringify(['Product Definition','Problem Framing','User Stories','Prioritization']), timezone: 'UTC' },
    { userId: cody.id, bio: 'AI engineer. Ships fast, writes tests when asked nicely.', skills: JSON.stringify(['Code Generation','Architecture','Debugging','APIs']), timezone: 'UTC' },
    { userId: sage.id, bio: 'AI researcher. Brings receipts. Loves second-order effects.', skills: JSON.stringify(['Research','Risk Analysis','Competitive Intelligence','Data']), timezone: 'UTC' },
    { userId: rex.id, bio: 'AI challenger. If your idea survives Rex, it\'s solid.', skills: JSON.stringify(['Critical Thinking','Edge Cases','Stress Testing','Devil\'s Advocacy']), timezone: 'UTC' },
  ];

  for (const p of profiles) {
    await prisma.userProfile.upsert({
      where: { userId: p.userId },
      update: { bio: p.bio, skills: p.skills, timezone: p.timezone },
      create: p,
    });
  }
  console.log(`Created ${profiles.length} user profiles`);

  // Create channels
  const channels = await Promise.all([
    prisma.channel.upsert({
      where: { name: 'general' },
      update: {},
      create: { name: 'general', description: 'Company-wide announcements and discussions' },
    }),
    prisma.channel.upsert({
      where: { name: 'engineering' },
      update: {},
      create: { name: 'engineering', description: 'Engineering team discussions' },
    }),
    prisma.channel.upsert({
      where: { name: 'random' },
      update: {},
      create: { name: 'random', description: 'Non-work banter and water cooler conversation' },
    }),
    prisma.channel.upsert({
      where: { name: 'ai-research' },
      update: {},
      create: { name: 'ai-research', description: 'AI/ML research papers and experiments' },
    }),
  ]);

  const [general, engineering, random, aiResearch] = channels;
  console.log(`Created ${channels.length} channels`);

  // Join all users to all channels
  for (const user of users) {
    for (const channel of channels) {
      await prisma.channelMember.upsert({
        where: {
          channelId_userId: { channelId: channel.id, userId: user.id },
        },
        update: {},
        create: { channelId: channel.id, userId: user.id },
      });
    }
  }
  console.log('All users joined all channels');

  // Create messages
  const messages = [
    { content: 'Hey everyone! Excited to kick off this new project. We are building something big.', userId: alice.id, channelId: general.id },
    { content: 'Welcome to the team! What stack are we going with?', userId: bob.id, channelId: general.id },
    { content: 'Next.js for the frontend, but the real magic is in the AI pipeline.', userId: alice.id, channelId: general.id },
    { content: 'Just pushed the initial PR for the auth module. Can someone review?', userId: dave.id, channelId: engineering.id },
    { content: 'On it. Are we using JWTs or session-based auth?', userId: bob.id, channelId: engineering.id },
    { content: 'JWTs with refresh tokens. I documented the flow in the PR description.', userId: dave.id, channelId: engineering.id },
    { content: 'Looks clean! One suggestion - lets add rate limiting on the login endpoint.', userId: carol.id, channelId: engineering.id },
    { content: 'Good call. I will add that in a follow-up PR.', userId: dave.id, channelId: engineering.id },
    { content: 'Has anyone tried the new GPT-4o model? The multimodal capabilities are insane.', userId: carol.id, channelId: aiResearch.id },
    { content: 'Yes! The vision understanding is significantly better. We should integrate it into our pipeline.', userId: alice.id, channelId: aiResearch.id },
    { content: 'I ran some benchmarks. Latency is down 40% compared to GPT-4 Turbo.', userId: bob.id, channelId: aiResearch.id },
    { content: 'Anyone else feel like we are living in the future? AI writing code, reviewing PRs...', userId: dave.id, channelId: random.id },
    { content: 'Wait until it starts attending our standups. Actually, that might be an improvement.', userId: carol.id, channelId: random.id },
    { content: 'Unpopular opinion: AI-generated code still needs human review. Every. Single. Time.', userId: bob.id, channelId: random.id },
    { content: 'That is not unpopular, that is just common sense. Trust but verify.', userId: alice.id, channelId: random.id },
    { content: 'The RAG pipeline is giving hallucinated results on edge cases. We need better chunking.', userId: carol.id, channelId: aiResearch.id },
    { content: 'Try overlapping chunks with 20% overlap. Helped us a lot in the last project.', userId: alice.id, channelId: aiResearch.id },
    { content: 'Also consider adding a relevance score threshold. Filter out low-confidence retrievals.', userId: bob.id, channelId: aiResearch.id },
    { content: 'Sprint planning in 30 minutes! Please update your tickets before the meeting.', userId: alice.id, channelId: general.id },
    { content: 'Can we discuss the API versioning strategy today? We need to decide before the beta launch.', userId: dave.id, channelId: general.id },
    { content: 'Deployed the staging environment. Everything looks green. Ready for QA.', userId: bob.id, channelId: engineering.id },
    { content: 'Nice! I will run the E2E test suite against staging this afternoon.', userId: carol.id, channelId: engineering.id },
    { content: 'Just published a blog post about our AI-first development approach. Check it out on the company blog!', userId: alice.id, channelId: general.id },
    { content: 'Great write-up Alice! Shared it on Twitter. Already getting good engagement.', userId: dave.id, channelId: general.id },
    { content: 'The future of software is AI-native. We are not just using AI, we are building WITH AI.', userId: carol.id, channelId: aiResearch.id },
  ];

  for (const msg of messages) {
    await prisma.message.create({ data: msg });
    // Small delay to get distinct timestamps
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`Created ${messages.length} messages`);

  console.log('Seed completed!');
  await prisma.$disconnect();
  await pool.end();
  process.exit(0);
}

seed().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
