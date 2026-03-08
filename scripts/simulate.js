#!/usr/bin/env node
/**
 * Slack AGI — Scale Simulation
 * Generates 30k users, 100+ channels/DMs, simulates concurrent message load
 */

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();
const BASE = 'https://slack-agi-app-production.up.railway.app';

const DEPARTMENTS = ['engineering', 'product', 'design', 'sales', 'marketing',
  'data', 'infra', 'security', 'legal', 'finance', 'support', 'research',
  'devrel', 'hr', 'operations', 'partnerships', 'growth', 'mobile', 'platform', 'ai'];

const CHANNEL_TEMPLATES = [
  ...DEPARTMENTS.map(d => ({ name: d, desc: `${d} team channel` })),
  { name: 'general', desc: 'Company-wide' },
  { name: 'announcements', desc: 'Important updates' },
  { name: 'random', desc: 'Off-topic' },
  { name: 'ai-research', desc: 'AI/ML research' },
  { name: 'incidents', desc: 'Production incidents' },
  { name: 'hiring', desc: 'Recruiting pipeline' },
  { name: 'ideas', desc: 'Product ideas' },
  { name: 'wins', desc: 'Celebrate wins 🎉' },
  { name: 'help-backend', desc: 'Backend help' },
  { name: 'help-frontend', desc: 'Frontend help' },
  { name: 'help-data', desc: 'Data questions' },
  { name: 'standup-eng', desc: 'Engineering standups' },
  { name: 'releases', desc: 'Deploy notifications' },
  { name: 'metrics', desc: 'Business metrics' },
];

const MESSAGES = [
  "Just pushed the fix, deploying now",
  "Can someone review PR #847?",
  "The metrics look great this week 📈",
  "Who's joining the architecture review at 3pm?",
  "Heads up: staging is down for maintenance",
  "Really impressive work on the new feature 🚀",
  "We hit 10k DAU today!",
  "The latency spike was a DB query issue, fixed",
  "New RFC up: https://docs/rfc-142",
  "Bug bash tomorrow 10am — all engineers welcome",
  "Deployed v2.4.1 to prod ✅",
  "Anyone else seeing this error in logs?",
  "Weekly metrics summary just landed in your inbox",
  "The customer demo went super well",
  "Reminder: sprint planning in 30 min",
];

async function createUsers(count) {
  console.log(`\n🧑 Creating ${count} users in batches...`);
  const batchSize = 1000;
  let created = 0;

  for (let b = 0; b < Math.ceil(count / batchSize); b++) {
    const users = [];
    const base = b * batchSize;
    for (let i = 0; i < Math.min(batchSize, count - base); i++) {
      const idx = base + i + 1;
      const dept = DEPARTMENTS[idx % DEPARTMENTS.length];
      const id = randomUUID().replace(/-/g, '').slice(0, 20);
      users.push({
        id,
        username: `user_${idx}`,
        displayName: `User ${idx} (${dept})`,
        status: 'online',
        isBot: false,
        createdAt: new Date(),
      });
    }
    await prisma.user.createMany({ data: users, skipDuplicates: true });
    created += users.length;
    process.stdout.write(`\r  ${created}/${count} users...`);
  }
  console.log(`\n  ✅ ${created} users created`);
}

async function createChannels() {
  console.log(`\n📢 Creating ${CHANNEL_TEMPLATES.length} channels...`);
  let created = 0;
  for (const t of CHANNEL_TEMPLATES) {
    const exists = await prisma.channel.findFirst({ where: { name: t.name } });
    if (!exists) {
      await prisma.channel.create({
        data: {
          id: randomUUID().replace(/-/g,'').slice(0,20),
          name: t.name, description: t.desc,
        }
      });
      created++;
    }
  }
  console.log(`  ✅ ${created} new channels created`);
}

async function seedMemberships(sampleSize = 500) {
  console.log(`\n🔗 Adding ${sampleSize} sample users to channels...`);
  const channels = await prisma.channel.findMany();
  const users = await prisma.user.findMany({ where: { isBot: false }, take: sampleSize, orderBy: { createdAt: 'desc' } });

  let added = 0;
  for (const ch of channels) {
    const sample = users.sort(() => 0.5 - Math.random()).slice(0, Math.floor(Math.random() * 50) + 10);
    for (const u of sample) {
      await prisma.channelMember.upsert({
        where: { channelId_userId: { channelId: ch.id, userId: u.id } },
        create: { channelId: ch.id, userId: u.id },
        update: {},
      }).catch(() => {});
      added++;
    }
  }
  console.log(`  ✅ ${added} memberships created`);
}

async function simulateConcurrentMessages(parallelism = 50) {
  console.log(`\n⚡ Simulating ${parallelism} concurrent users sending messages...`);
  const users = await prisma.user.findMany({ where: { isBot: false }, take: parallelism });
  const channels = await prisma.channel.findMany({ take: 5 });

  const start = Date.now();
  const results = await Promise.allSettled(
    users.map((u, i) => {
      const ch = channels[i % channels.length];
      const msg = MESSAGES[i % MESSAGES.length];
      return fetch(`${BASE}/api/channels/${ch.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: msg, userId: u.id }),
      });
    })
  );

  const elapsed = Date.now() - start;
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const fail = results.filter(r => r.status === 'rejected').length;
  console.log(`  ✅ ${ok}/${parallelism} succeeded | ❌ ${fail} failed | ⏱ ${elapsed}ms total | ${(parallelism/elapsed*1000).toFixed(1)} msg/s`);
  return { ok, fail, elapsed, throughput: parallelism/elapsed*1000 };
}

async function runLoadTest(rounds = 5, parallelism = 100) {
  console.log(`\n🔥 Load test: ${rounds} rounds × ${parallelism} concurrent messages`);
  const results = [];
  for (let r = 0; r < rounds; r++) {
    process.stdout.write(`  Round ${r+1}/${rounds}... `);
    const res = await simulateConcurrentMessages(parallelism);
    results.push(res);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const avgThroughput = results.reduce((a, b) => a + b.throughput, 0) / results.length;
  const avgLatency = results.reduce((a, b) => a + b.elapsed, 0) / results.length;
  console.log(`\n  📊 Average: ${avgThroughput.toFixed(1)} msg/s | ${avgLatency.toFixed(0)}ms per batch`);
}

async function stats() {
  const [users, channels, messages, bots] = await Promise.all([
    prisma.user.count({ where: { isBot: false } }),
    prisma.channel.count(),
    prisma.message.count(),
    prisma.user.count({ where: { isBot: true } }),
  ]);
  console.log(`\n📊 DB Stats:`);
  console.log(`  Users: ${users.toLocaleString()} human + ${bots} bots`);
  console.log(`  Channels: ${channels}`);
  console.log(`  Messages: ${messages.toLocaleString()}`);
}

const mode = process.argv[2] || 'all';

if (mode === 'users' || mode === 'all') await createUsers(30000);
if (mode === 'channels' || mode === 'all') await createChannels();
if (mode === 'memberships' || mode === 'all') await seedMemberships(500);
if (mode === 'concurrent' || mode === 'all') await simulateConcurrentMessages(100);
if (mode === 'loadtest') await runLoadTest(10, 100);
if (mode === 'stats' || mode === 'all') await stats();

await prisma.$disconnect();
console.log('\n✅ Done');
