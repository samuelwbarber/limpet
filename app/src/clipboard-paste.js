// Clipboard images become files that terminal agents can attach by path. Keep
// bytes in the main process; only text/paths cross the renderer bridge.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const remoteCopy = require('./remote-copy');
const platform = require('./platform');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

async function readClipboard(clipboard, nativeImage) {
  // Electron 44 uses the asynchronous ClipboardItem API. Read one snapshot so
  // a clipboard change cannot mix one copy's image with another copy's text.
  const items = await clipboard.read();
  for (const type of ['image/png', 'image/jpeg']) {
    const item = items.find((entry) => entry.types.includes(type));
    if (!item) continue;
    const blob = await item.getType(type);
    if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error('Clipboard images must be between 1 byte and 20 MB.');
    const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
    if (image.isEmpty()) throw new Error('The clipboard image could not be decoded.');
    const png = image.toPNG();
    if (!png.length || png.length > MAX_IMAGE_BYTES) throw new Error('The clipboard image is too large (20 MB PNG limit).');
    return { kind: 'image', png };
  }
  const item = items.find((entry) => entry.types.includes('text/plain'));
  return { kind: 'text', text: item ? await (await item.getType('text/plain')).text() : '' };
}

async function preparePaste({ clipboard, nativeImage, directory, remote, remoteCwd,
  ensureCurrent = () => {}, checkLocal = async () => {}, copyImage }) {
  const value = await readClipboard(clipboard, nativeImage);
  ensureCurrent();
  if (value.kind === 'text') return value;

  let plan;
  if (remote) {
    plan = remoteCopy.planDrop(remote, remoteCwd);
    if (!plan.ok) throw new Error(`Can't paste an image: ${plan.reason}.`);
  } else {
    await checkLocal();
    ensureCurrent();
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `clipboard-${crypto.randomUUID()}.png`);
  try {
    await fs.writeFile(file, value.png, { flag: 'wx', mode: 0o600 });
    ensureCurrent();
    if (plan) {
      const result = await copyImage(file);
      if (!result.ok) {
        if (result.cancelled) return { kind: 'cancelled' };
        throw new Error(result.reason || 'Image upload failed. Paste again to retry.');
      }
      ensureCurrent();
    }
    const imagePath = plan ? path.posix.join(plan.dir, path.basename(file)) : file;
    // A whole image path is recognized by Codex/Claude's paste handlers. Quotes
    // keep spaces together for other agents too; do not append Enter or a command.
    const text = /^[a-zA-Z0-9_./:\\-]+$/.test(imagePath) ? imagePath
      : (plan ? platform.posixQuote(imagePath) : platform.shellQuote(imagePath));
    return { kind: 'image', text, path: imagePath };
  } catch (error) {
    await fs.unlink(file).catch(() => {});
    throw error;
  } finally {
    // The remote copy is the attachment now. Local attachments stay available
    // across tab closes/restarts so agents can read them later in the chat.
    if (plan) await fs.unlink(file).catch(() => {});
  }
}

module.exports = { MAX_IMAGE_BYTES, readClipboard, preparePaste };
