// Keep preparation failures on the safe side of stopping the current agent.
// Dependencies make this transaction testable without touching real histories.
async function switchAgent(sess, cmd, deps) {
  if (!sess || !sess.proc || sess.exited) return { ok: false, reason: 'no shell' };
  const target = deps.accountFor(cmd);
  if (!target) return { ok: false, reason: 'unknown account' };
  if (sess.switching) return { ok: false, reason: 'busy' };
  sess.switching = true;
  let current = null;
  let stopped = false;
  try {
    current = await deps.detect(sess);
    if (current && current.cmd === cmd) return { ok: false, reason: 'already' };
    if (current && !current.sessionId) throw new Error(`No session found for ${current.cmd}. Wait for the conversation to be saved, then retry.`);
    if (current && !deps.signedIn(cmd)) throw new Error(`${cmd} is not signed in. Sign in from another tab, then retry.`);
    let prepared = current ? await deps.prepare(current, target) : { launch: {}, how: 'fresh' };
    if (current && (!prepared || prepared.how === 'fresh' || (!prepared.launch.resume && !prepared.launch.prompt))) {
      throw new Error('The conversation could not be prepared for the destination.');
    }
    let line = deps.launch(cmd, prepared.launch);
    if (!sess.proc || sess.exited) return { ok: false, reason: 'no shell' };
    if (current) {
      if (!(await deps.stop(sess, current.pid))) throw new Error(`Could not stop ${current.cmd}; it may still be running.`);
      stopped = true;
      await deps.pause();
      // Include any final output saved while the old process was stopping.
      // The initial successful preparation remains a prerequisite for stopping.
      if (deps.refresh) {
        prepared = await deps.refresh(current, target, prepared);
        line = deps.launch(cmd, prepared.launch);
      }
    }
    if (!sess.proc || sess.exited) throw new Error('The shell closed before the new agent could launch.');
    sess.proc.write(`${line}\r`);
    const verification = deps.verify ? await deps.verify(sess, target, prepared.launch) : null;
    if (verification && verification.error) throw new Error(verification.error);
    // Writing to a shell is not proof that an agent authenticated or resumed.
    return { ok: true, status: verification && verification.verified ? 'ready' : 'launching', verified: !!(verification && verification.verified), verification: verification ? verification.level : null, from: current ? current.cmd : null, to: cmd,
      sessionId: current ? current.sessionId : null, resumeSessionId: prepared.launch.resume || null,
      how: prepared.how, crossProvider: !!current && current.kind !== target.kind };
  } catch (error) {
    let recovery = null;
    if (stopped && current) {
      try { recovery = deps.launch(current.cmd, { resume: current.sessionId }); } catch (_) { /* preserve the original error */ }
    }
    const reason = `${error.message}${stopped ? ' The previous conversation is saved.' : ' The current agent has not been replaced.'}`;
    deps.note(reason);
    return { ok: false, reason, recovery, stopped };
  } finally {
    sess.switching = false;
  }
}

// Only an exact saved-session match proves a native resume. A handoff prompt
// has no session identity to compare: report process detection separately.
async function verifyLaunch(sess, target, launch, { detect, pause, attempts = 16 }) {
  for (let i = 0; i < attempts; i++) {
    await pause();
    if (!sess.proc || sess.exited) return { error: 'The shell exited while starting the new agent.' };
    const found = await detect(sess);
    if (!found || found.cmd !== target.cmd) continue;
    if (launch.resume) {
      if (found.sessionId === launch.resume) return { verified: true, level: 'session' };
      // Startup markers can temporarily point to an earlier conversation.
      if (i === attempts - 1 && found.sessionId) return { error: `${target.cmd} started a different conversation. The requested resume could not be verified.` };
    } else return { verified: false, level: 'process' };
  }
  return { verified: false, level: 'timeout' };
}

module.exports = { switchAgent, verifyLaunch };
