const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanSnapshot, extractTopics, cleanConversationTitle, createTopicProfile, updateTopicProfile,
  profileTopics, planScene, buildBackdropPlan, buildPrompt,
} = require('../src/backdrop');

test('cleans URLs, long values, secrets, duplicates, and control characters', () => {
  const secret = 'sk-' + 'a'.repeat(60);
  const clean = cleanSnapshot(`clipboard tabs\nclipboard tabs\nlogin https://example.com/auth\napi key ${secret}\n\x1b browser links`);
  assert.equal((clean.match(/clipboard tabs/g) || []).length, 1);
  assert.doesNotMatch(clean, /https:|example|sk-|api key|\x1b/);
  assert.match(clean, /browser links/);
});

test('extracts conversation subjects instead of terminal boilerplate', () => {
  const topics = extractTopics(`
    We are fixing clipboard paste duplication and draggable tabs.
    Clipboard copy needs reliable browser links.
    The detached tab keeps its live shell while browser authentication opens externally.
  `);
  assert.ok(topics.includes('clipboard'));
  assert.ok(topics.includes('browser'));
  assert.ok(topics.includes('tabs') || topics.includes('draggable'));
  assert.ok(!topics.includes('terminal'));
});

test('builds a visual prompt only after enough meaningful content', () => {
  assert.equal(buildPrompt('too short'), null);
  const subjects = ['clipboard behavior', 'detachable tabs', 'local image generation', 'browser authentication', 'atmospheric backgrounds', 'privacy safeguards', 'pixel art mascots', 'live shell handoff'];
  const conversation = subjects.map((subject, i) => `Codex and the user discuss ${subject}, visual storytelling, implementation details and test scenario ${i}.`).join('\n');
  const prompt = buildPrompt(conversation);
  assert.match(prompt, /clipboard/);
  assert.match(prompt, /desktop workbench/);
  assert.match(prompt, /immediately recognizable/);
  assert.match(prompt, /high-contrast/);
  assert.doesNotMatch(prompt, /mascot|limpet/i);
  assert.match(prompt, /no text/);
});

test('plans a slot-machine scene from slot-app terminal content', () => {
  const clean = cleanSnapshot(Array(15).fill('Building a slot machine app with spinning reels, paylines, jackpot animation and a spin button.').join('\n'));
  const scene = planScene(clean, extractTopics(clean));
  assert.match(scene, /single classic casino slot machine/);
  assert.doesNotMatch(scene, /mascot|limpet/i);
});

test('keeps only a bounded sanitized topic profile, not a transcript', () => {
  const profile = createTopicProfile();
  for (let i = 0; i < 120; i++) {
    updateTopicProfile(profile, `Investigating projectsubject${i} componentfeature${i} renderer pipeline stage ${i}.`);
  }
  updateTopicProfile(profile, 'api key sk-' + 'a'.repeat(60));
  assert.ok(profile.topicScores.size <= 64);
  assert.deepEqual(Object.keys(profile).sort(), ['sceneScores', 'topicScores', 'updates']);
  assert.doesNotMatch(profileTopics(profile, 64).join(' '), /secret|api|key|sk-/i);
});

test('keeps a clear project subject through an extremely long generic log tail', () => {
  const profile = createTopicProfile();
  for (let i = 0; i < 12; i++) {
    updateTopicProfile(profile, `Building slot casino stage ${i}: reels payline jackpot spin fruit symbols and payout animation.`);
  }
  for (let i = 0; i < 24; i++) {
    updateTopicProfile(profile, `Build status ${i}: compiled module worker${i}, ran test scenario case${i}, no warning detected.`);
  }
  const recent = Array.from({ length: 30 }, (_, i) =>
    `Build status ${i}: compiled module worker${i} and completed routine validation case${i}.`).join('\n');
  const plan = buildBackdropPlan(recent, profile);
  assert.equal(plan.sceneKey, 'rule:0');
  assert.match(plan.prompt, /single classic casino slot machine/);
  assert.ok(plan.confidence >= 2);
});

test('switches the scene after sustained evidence of a genuinely new subject', () => {
  const profile = createTopicProfile();
  for (let i = 0; i < 10; i++) {
    updateTopicProfile(profile, `Slot casino stage ${i}: reels payline jackpot spin fruit symbols and payout animation.`);
  }
  for (let i = 0; i < 24; i++) {
    updateTopicProfile(profile, `Database migration ${i}: SQL query schema table records index transaction and relational storage.`);
  }
  const recent = Array.from({ length: 20 }, (_, i) =>
    `Database migration ${i}: SQL query updates schema table records, index and transaction plan.`).join('\n');
  const plan = buildBackdropPlan(recent, profile);
  assert.equal(plan.sceneKey, 'rule:2');
  assert.match(plan.prompt, /data cylinders/);
  assert.ok(plan.confidence >= 2);
});

test('uses a meaningful Claude Code title as the primary image subject', () => {
  const profile = createTopicProfile();
  for (let i = 0; i < 20; i++) {
    updateTopicProfile(profile, `Database migration ${i}: SQL schema table query records and index work.`);
  }
  const plan = buildBackdropPlan('short recent output', profile, 'Claude Code - Building a slot machine app');
  assert.equal(plan.source, 'title');
  assert.equal(plan.title, 'Building a slot machine app');
  assert.equal(plan.sceneKey, 'title:building a slot machine app');
  assert.match(plan.prompt, /Building a slot machine app/);
  assert.match(plan.prompt, /single classic casino slot machine/);
});

test('ignores generic or sensitive terminal titles and uses the profile fallback', () => {
  assert.equal(cleanConversationTitle('PowerShell'), null);
  assert.equal(cleanConversationTitle('Claude Code'), null);
  assert.equal(cleanConversationTitle('sbarb'), null);
  assert.equal(cleanConversationTitle('sbarb@workstation:~'), null);
  assert.equal(cleanConversationTitle('api key sk-' + 'x'.repeat(60)), null);
  assert.equal(buildBackdropPlan('too short', createTopicProfile(), 'PowerShell'), null);

  const profile = createTopicProfile();
  for (let i = 0; i < 8; i++) {
    updateTopicProfile(profile, `Travel route ${i}: map location weather forecast train flight and compass planning.`);
  }
  const plan = buildBackdropPlan('routine output', profile, 'limpet');
  assert.equal(plan.source, 'profile');
  assert.match(plan.prompt, /folded map/);
});
