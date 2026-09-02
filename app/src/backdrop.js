// Fully local conversation-to-image support. No transcript or prompt leaves
// the machine: stable-diffusion.cpp reads a repo-local model and writes a PNG.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const LOCAL_AI_DIR = path.join(__dirname, '..', 'local-ai');
const SD_EXE = path.join(LOCAL_AI_DIR, 'bin', 'sd-cli.exe');
const MODEL = path.join(LOCAL_AI_DIR, 'models', 'lcm-dreamshaper-v7-f16.gguf');
const OUTPUT_DIR = path.join(LOCAL_AI_DIR, 'backgrounds');
const MIN_OUTPUT_CHARS = 3000;
const UPDATE_OUTPUT_CHARS = 9000;
const MIN_UPDATE_MS = 10 * 60 * 1000;
const MAX_SNAPSHOT_CHARS = 24000;
const PROFILE_MAX_TOPICS = 64;
const PROFILE_DECAY = 0.97;
const PROFILE_GAIN = 0.24;
const MIN_SCENE_CHANGE_CONFIDENCE = 2;

const STOP_WORDS = new Set((`
  about after again also always and another because been before being between both
  can cannot could did does doing done each else enough even every from get gets
  getting give going good great had has have having here how into its just know
  like make many more most much need new now only other our out over please really
  same should since some still such than that the their them then there these they
  thing this those through too under use used using very want was way were what when
  where which while who why will with would yes you your
  terminal powershell command output input line lines code file files function
  true false null undefined error warning info pass failed localhost windows
  ctrl shift write host string const return async await event session codex claude
  user discuss discussion implementation details scenario test testing visual storytelling
`).trim().split(/\s+/));

function cleanSnapshot(input) {
  const text = String(input || '').slice(-MAX_SNAPSHOT_CHARS);
  const seen = new Set();
  const lines = [];
  for (let line of text.split(/\r?\n/)) {
    line = line
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/[A-Za-z]:\\[^\s]+/g, ' ')
      .replace(/\b(?:sk-|ghp_|github_pat_|Bearer\s+)[A-Za-z0-9_.-]+/gi, '[secret removed]')
      .replace(/\b[A-Za-z0-9+/=_-]{48,}\b/g, '[long value removed]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line || line.length < 4 || line.length > 320) continue;
    if (/\b(?:password|passphrase|api[ _-]?key|access[ _-]?token|auth(?:entication)?[ _-]?token|private[ _-]?key|secret)\b/i.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines.slice(-120).join('\n');
}

function extractTopics(snapshot, limit = 10) {
  const clean = cleanSnapshot(snapshot);
  const counts = new Map();
  const words = clean.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  for (const word of words) {
    if (STOP_WORDS.has(word) || /^\d/.test(word) || word.includes('--')) continue;
    const score = word.length >= 8 ? 1.35 : 1;
    counts.set(word, (counts.get(word) || 0) + score);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

const SCENE_RULES = [
  {
    pattern: /\b(slot|slots|casino|reel|reels|payline|jackpot|spin|spinning)\b/gi,
    scene: 'one single classic casino slot machine, front view, with a blank top panel, three large fruit-symbol reels, a bright spin button, a side lever and a few coins',
  },
  {
    pattern: /\b(clipboard|copy|paste|tab|tabs|window|detach|drag|browser|hyperlink|authentication|login)\w*\b/gi,
    scene: 'a tidy desktop workbench with a clipboard, overlapping rounded window cards, and one card being moved into its own little frame',
  },
  {
    pattern: /\b(database|sql|query|schema|table|record|migration)\w*\b/gi,
    scene: 'a tiny organized archive of stacked data cylinders, connected tables and neatly sorted record cards',
  },
  {
    pattern: /\b(server|ssh|network|socket|http|endpoint|cloud|deploy|hosting)\w*\b/gi,
    scene: 'two small computers and a compact server rack connected by softly glowing cables and network nodes',
  },
  {
    pattern: /\b(game|player|sprite|level|score|enemy|physics|controller)\w*\b/gi,
    scene: 'a miniature game world with a controller, a tiny level platform and a few playful collectible shapes',
  },
  {
    pattern: /\b(image|photo|camera|pixel|art|render|canvas|background|backdrop)\w*\b/gi,
    scene: 'a cozy little pixel-art studio with a canvas, color swatches, a camera and a small landscape being painted',
  },
  {
    pattern: /\b(audio|music|song|sound|waveform|microphone|speaker)\w*\b/gi,
    scene: 'a tiny music studio with headphones, a microphone, speakers and a gentle colored waveform',
  },
  {
    pattern: /\b(shop|store|cart|checkout|product|order|payment|commerce)\w*\b/gi,
    scene: 'a small friendly shop counter with a basket, parcels, product shelves and a card reader',
  },
  {
    pattern: /\b(chart|finance|trading|stock|price|budget|invoice|accounting)\w*\b/gi,
    scene: 'a calm miniature finance desk with coin stacks, a simple rising chart and an open ledger',
  },
  {
    pattern: /\b(map|travel|route|location|weather|forecast|train|flight)\w*\b/gi,
    scene: 'a small folded map with a winding route, a compass, a cloud and a tiny travel case',
  },
  {
    pattern: /\b(test|testing|bug|debug|error|failure|fix|repair)\w*\b/gi,
    scene: 'a neat repair bench where a tiny mechanical bug is being checked with a magnifier and a wrench',
    weight: 0.45,
  },
  {
    pattern: /\b(document|readme|docs|writing|report|book|notes)\w*\b/gi,
    scene: 'a cozy writing desk with an open blank book, tidy note cards, a pencil and a small reading lamp',
  },
  {
    pattern: /\b(git|commit|branch|merge|repository|repo|code|function|class|module)\w*\b/gi,
    scene: 'a miniature software workshop with connected code blocks, a branching node tree and a few precise tools',
    weight: 0.4,
  },
];

function createTopicProfile() {
  return {
    topicScores: new Map(),
    sceneScores: new Array(SCENE_RULES.length).fill(0),
    updates: 0,
  };
}

function updateTopicProfile(profile, snapshot) {
  if (!profile || !(profile.topicScores instanceof Map) || !Array.isArray(profile.sceneScores)) {
    throw new TypeError('invalid topic profile');
  }
  const clean = cleanSnapshot(snapshot);
  if (clean.length < 20) return profile;

  for (const [topic, score] of profile.topicScores) {
    const decayed = score * PROFILE_DECAY;
    if (decayed < 0.08) profile.topicScores.delete(topic);
    else profile.topicScores.set(topic, decayed);
  }
  for (let i = 0; i < profile.sceneScores.length; i++) {
    profile.sceneScores[i] *= PROFILE_DECAY;
  }

  const counts = new Map();
  const words = clean.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  for (const word of words) {
    if (STOP_WORDS.has(word) || /^\d/.test(word) || word.includes('--')) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  for (const topic of extractTopics(clean, 24)) {
    // Cap repetition so one noisy build line cannot overpower a project noun.
    const evidence = 1 + Math.min(counts.get(topic) || 1, 4) * 0.35;
    profile.topicScores.set(topic, (profile.topicScores.get(topic) || 0) + evidence * PROFILE_GAIN);
  }

  for (let i = 0; i < SCENE_RULES.length; i++) {
    const rule = SCENE_RULES[i];
    const matches = clean.match(rule.pattern) || [];
    const distinct = new Set(matches.map((match) => match.toLowerCase())).size;
    if (distinct) profile.sceneScores[i] += distinct * (rule.weight || 1) * PROFILE_GAIN;
  }

  if (profile.topicScores.size > PROFILE_MAX_TOPICS) {
    const keep = [...profile.topicScores]
      .sort((a, b) => b[1] - a[1])
      .slice(0, PROFILE_MAX_TOPICS);
    profile.topicScores.clear();
    for (const [topic, score] of keep) profile.topicScores.set(topic, score);
  }
  profile.updates++;
  return profile;
}

function profileTopics(profile, limit = 10) {
  if (!profile || !(profile.topicScores instanceof Map)) return [];
  return [...profile.topicScores]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([topic]) => topic);
}

function chooseScene(clean, topics, profile = null) {
  let best = null;
  let runnerUp = null;
  for (let index = 0; index < SCENE_RULES.length; index++) {
    const rule = SCENE_RULES[index];
    const matches = clean.match(rule.pattern) || [];
    // Distinct vocabulary identifies the subject better than raw frequency;
    // build logs can repeat a generic word such as "test" hundreds of times.
    const recent = new Set(matches.map((match) => match.toLowerCase())).size * (rule.weight || 1);
    const rolling = profile && Number(profile.sceneScores[index]) || 0;
    const candidate = { score: recent + rolling, scene: rule.scene, key: `rule:${index}` };
    if (!best || candidate.score > best.score) {
      runnerUp = best;
      best = candidate;
    } else if (!runnerUp || candidate.score > runnerUp.score) {
      runnerUp = candidate;
    }
  }
  if (best && best.score > 0) {
    return {
      ...best,
      confidence: Math.max(0, best.score - (runnerUp ? runnerUp.score * 0.65 : 0)),
    };
  }
  const fallbackTopics = topics.slice(0, 5);
  return {
    scene: `a small imaginative diorama about ${fallbackTopics.join(', ')}, expressed with two or three simple recognizable objects`,
    key: `topics:${fallbackTopics.slice(0, 3).join('|')}`,
    score: fallbackTopics.length / 2,
    confidence: fallbackTopics.length >= 4 ? 2 : 0,
  };
}

function planScene(clean, topics, profile = null) {
  return chooseScene(clean, topics, profile).scene;
}

function buildBackdropPlan(snapshot, profile = null) {
  const clean = cleanSnapshot(snapshot);
  const recentTopics = extractTopics(clean);
  const stableTopics = profileTopics(profile, 12);
  const topics = [...new Set([...stableTopics, ...recentTopics])].slice(0, 12);
  if ((clean.length < 500 && stableTopics.length < 3) || topics.length < 3) return null;
  const choice = chooseScene(clean, topics, profile);
  const prompt = [
    `Clear high-contrast digital illustration of ${choice.scene}.`,
    'The single main subject is large, centered, sharply defined and immediately recognizable at a glance, with a bold silhouette and clearly separated functional parts.',
    'Polished game concept art, crisp edges, rich distinct colors, simple dark navy background, subtle indigo and lavender accents, generous empty space around the subject, no atmospheric haze, no text, no letters, no labels, no logos, no user interface, not a terminal screenshot.',
  ].join(' ');
  return { prompt, scene: choice.scene, sceneKey: choice.key, confidence: choice.confidence, topics };
}

function buildPrompt(snapshot, profile = null) {
  const plan = buildBackdropPlan(snapshot, profile);
  return plan && plan.prompt;
}

function backendStatus() {
  return {
    ready: fs.existsSync(SD_EXE) && fs.existsSync(MODEL),
    executable: SD_EXE,
    model: MODEL,
  };
}

function outputPath(sessionId) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  return path.join(OUTPUT_DIR, `session-${sessionId}-${Date.now()}.png`);
}

function generateLocalImage({ prompt, destination, onSpawn }) {
  const negative = 'text, letters, words, signage, captions, watermark, logo, terminal screenshot, user interface, blur, blurry, haze, hazy, fog, muddy, washed out, monochrome, low contrast, faint subject, clutter, repeated subject, duplicate objects, multiple machines, rows of machines, mascot, limpet, group of characters';
  const threads = String(Math.min(8, os.cpus().length));
  const args = [
    '-m', MODEL, '-p', prompt, '-n', negative,
    '--sampling-method', 'lcm', '--steps', '8', '--cfg-scale', '1.0',
    '-W', '640', '-H', '384', '--rng', 'cpu', '--seed', '-1',
    '--threads', threads,
    '-o', destination,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(SD_EXE, args, {
      cwd: path.dirname(SD_EXE), windowsHide: true,
      env: { ...process.env, OMP_NUM_THREADS: threads },
    });
    if (onSpawn) onSpawn(child);
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) {}
    let diagnostics = '';
    const collect = (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error('local image generation timed out after 15 minutes'));
    }, 15 * 60 * 1000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(destination)) resolve(destination);
      else reject(new Error(`local generator exited ${code}: ${diagnostics.trim()}`));
    });
  });
}

module.exports = {
  MIN_OUTPUT_CHARS, UPDATE_OUTPUT_CHARS, MIN_UPDATE_MS, MIN_SCENE_CHANGE_CONFIDENCE,
  cleanSnapshot, extractTopics, createTopicProfile, updateTopicProfile, profileTopics,
  planScene, buildBackdropPlan, buildPrompt, backendStatus, outputPath, generateLocalImage,
};
