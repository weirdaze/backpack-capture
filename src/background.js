/*
 * Backpack Capture — background service worker.
 *
 * Owns the local capture store (chrome.storage.local), the capture session
 * (Start/End capture), saved templates, and replay. Never touches the
 * network — this extension has no server and no API calls anywhere in it;
 * captures leave the browser only when the parent explicitly exports them.
 */
importScripts("supported-sites.js", "template-builder.js");

const STORAGE_KEY = "backpack_captures";
const SESSION_KEY = "backpack_session"; // also read by core-content.js
const TEMPLATES_KEY = "backpack_templates"; // deliberately NOT cleared by CLEAR_CAPTURES
const REPLAY_KEY = "backpack_replay";
const MAX_CAPTURES = 500; // simple cap so storage.local never grows unbounded
const MAX_SESSION_PAGES = 300;
const IDLE_SESSION = { active: false, startedAt: null, count: 0, pages: [] };
const PAGE_STEP_TIMEOUT_MS = 45000;
const PROMPT_STEP_TIMEOUT_MS = 180000;

async function readKey(key, fallback) {
  const data = await chrome.storage.local.get(key);
  return data[key] === undefined ? fallback : data[key];
}

async function getCaptures() {
  return readKey(STORAGE_KEY, []);
}

async function setCaptures(captures) {
  await chrome.storage.local.set({ [STORAGE_KEY]: captures });
}

async function getSession() {
  return { ...IDLE_SESSION, ...(await readKey(SESSION_KEY, {})) };
}

async function showSessionBadge(session) {
  await chrome.action.setBadgeText({ text: session.active ? "REC" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
  await chrome.action.setTitle({
    title: session.active
      ? "Backpack Capture: capturing Google Classroom and Genesis pages"
      : "Backpack Capture: not capturing",
  });
}

async function saveSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  await showSessionBadge(session);
}

async function getTemplates() {
  return readKey(TEMPLATES_KEY, []);
}

async function setTemplates(templates) {
  await chrome.storage.local.set({ [TEMPLATES_KEY]: templates });
}

async function setReplay(replay) {
  await chrome.storage.local.set({ [REPLAY_KEY]: replay });
}

// A session never survives a browser restart, so capture is never left
// running for days by someone who forgot to press End.
chrome.runtime.onStartup.addListener(async () => {
  const session = await getSession();
  await saveSession({ ...session, active: false });
  await setReplay(null);
});

chrome.runtime.onInstalled.addListener(async () => {
  await showSessionBadge(await getSession());
});

// ---- replay -----------------------------------------------------------------

let runner = null; // { cancelled, tabId, onCapture, onStepDone }

function waitFor(assign, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      assign(null);
      resolve({ timedOut: true });
    }, timeoutMs);
    assign((value) => {
      clearTimeout(timer);
      assign(null);
      resolve(value || {});
    });
  });
}

async function runReplay(template) {
  const steps = template.steps || [];
  if (!steps.length) return;
  // MV3 service workers can be shut down while idle; a replay spends most of
  // its time waiting on page loads, so keep it awake until it's finished.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  let captured = 0;
  let skipped = 0;

  try {
    await saveSession({ active: true, startedAt: new Date().toISOString(), count: 0, pages: [], replaying: template.name });
    const tab = await chrome.tabs.create({ url: steps[0].url, active: true });
    runner = { cancelled: false, tabId: tab.id, onCapture: null, onStepDone: null };

    for (let i = 0; i < steps.length; i++) {
      if (runner.cancelled) break;
      const step = steps[i];
      await setReplay({
        active: true,
        name: template.name,
        templateId: template.id,
        index: i,
        total: steps.length,
        kind: step.kind,
        url: step.url,
      });

      if (step.kind === "page") {
        if (i > 0) await chrome.tabs.update(runner.tabId, { url: step.url });
        const result = await waitFor((fn) => {
          runner.onCapture = fn;
        }, PAGE_STEP_TIMEOUT_MS);
        if (result.timedOut) skipped++;
        else captured++;
      } else {
        try {
          await chrome.tabs.sendMessage(runner.tabId, { type: "SHOW_REPLAY_PROMPT", label: step.label });
        } catch (e) {
          // the tab has no content script (wrong page) - nothing to prompt on
        }
        const result = await waitFor((fn) => {
          runner.onStepDone = fn;
        }, PROMPT_STEP_TIMEOUT_MS);
        if (result.timedOut || result.skipped) skipped++;
        else captured++;
      }
    }

    const cancelled = runner.cancelled;
    const summary = cancelled
      ? "Backpack: replay stopped."
      : `Backpack: replay finished — ${captured} page${captured === 1 ? "" : "s"} captured${
          skipped ? `, ${skipped} skipped` : ""
        }. Open the extension to export.`;
    try {
      await chrome.tabs.sendMessage(runner.tabId, { type: "SHOW_REPLAY_TOAST", message: summary });
    } catch (e) {
      // tab closed mid-replay - the popup still shows the result
    }

    const templates = await getTemplates();
    await setTemplates(
      templates.map((t) =>
        t.id === template.id
          ? { ...t, lastReplayedAt: new Date().toISOString(), lastResult: { captured, skipped, cancelled } }
          : t
      )
    );
    await setReplay({ active: false, name: template.name, captured, skipped, cancelled });
  } finally {
    clearInterval(keepAlive);
    runner = null;
    const session = await getSession();
    await saveSession({ ...session, active: false, replaying: null });
  }
}

// ---- messages ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "STORE_CAPTURE") {
    (async () => {
      const captures = await getCaptures();
      captures.unshift(message.envelope);
      if (captures.length > MAX_CAPTURES) captures.length = MAX_CAPTURES;
      await setCaptures(captures);

      const session = await getSession();
      if (session.active) {
        const pages = [...(session.pages || []), { url: message.envelope.source_url, at: message.envelope.captured_at }];
        if (pages.length > MAX_SESSION_PAGES) pages.splice(0, pages.length - MAX_SESSION_PAGES);
        await saveSession({ ...session, count: session.count + 1, pages });
      }
      if (runner && runner.onCapture && sender.tab && sender.tab.id === runner.tabId) runner.onCapture({});
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "START_SESSION") {
    (async () => {
      const session = { active: true, startedAt: new Date().toISOString(), count: 0, pages: [] };
      await saveSession(session);
      sendResponse({ ok: true, session });
    })();
    return true;
  }

  if (message && message.type === "END_SESSION") {
    (async () => {
      const session = { ...(await getSession()), active: false };
      await saveSession(session);
      sendResponse({ ok: true, session });
    })();
    return true;
  }

  if (message && message.type === "GET_SESSION") {
    (async () => {
      sendResponse({ ok: true, session: await getSession() });
    })();
    return true;
  }

  if (message && message.type === "SAVE_TEMPLATE") {
    (async () => {
      const session = await getSession();
      const steps = self.BackpackTemplates.buildSteps(session.pages);
      if (!steps.length) {
        sendResponse({ ok: false, error: "no_pages" });
        return;
      }
      const template = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: (message.name || "").trim() || self.BackpackTemplates.defaultName(new Date()),
        createdAt: new Date().toISOString(),
        steps,
        lastReplayedAt: null,
        lastResult: null,
      };
      await setTemplates([template, ...(await getTemplates())]);
      sendResponse({ ok: true, template });
    })();
    return true;
  }

  if (message && message.type === "GET_TEMPLATES") {
    (async () => {
      sendResponse({ ok: true, templates: await getTemplates(), replay: await readKey(REPLAY_KEY, null) });
    })();
    return true;
  }

  if (message && message.type === "DELETE_TEMPLATE") {
    (async () => {
      await setTemplates((await getTemplates()).filter((t) => t.id !== message.id));
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "START_REPLAY") {
    (async () => {
      if (runner) {
        sendResponse({ ok: false, error: "already_replaying" });
        return;
      }
      const template = (await getTemplates()).find((t) => t.id === message.id);
      if (!template) {
        sendResponse({ ok: false, error: "not_found" });
        return;
      }
      runReplay(template); // deliberately not awaited - it outlives this message
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "CANCEL_REPLAY") {
    (async () => {
      if (runner) {
        runner.cancelled = true;
        if (runner.onCapture) runner.onCapture({});
        else if (runner.onStepDone) runner.onStepDone({ skipped: true });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "REPLAY_STEP_DONE") {
    (async () => {
      if (runner && runner.onStepDone) runner.onStepDone({ skipped: Boolean(message.skipped) });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "DELETE_CAPTURE") {
    (async () => {
      const captures = await getCaptures();
      await setCaptures(captures.filter((c) => c.id !== message.id));
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "CLEAR_CAPTURES") {
    (async () => {
      await setCaptures([]); // saved templates are kept - each has its own X
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "GET_CAPTURES") {
    (async () => {
      sendResponse({ ok: true, captures: await getCaptures() });
    })();
    return true;
  }

  if (message && message.type === "EXPORT_CAPTURES") {
    (async () => {
      const captures = await getCaptures();
      const payload = JSON.stringify({ exported_at: new Date().toISOString(), captures }, null, 2);
      const url = `data:application/json;base64,${btoa(unescape(encodeURIComponent(payload)))}`;
      // Include time, not just date - re-exporting later the same day
      // previously overwrote the earlier file (with saveAs, only if the
      // user keeps the suggested name), losing whatever the earlier
      // export had already captured for diagnosis.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `backpack-captures-${stamp}.json`;
      const downloadId = await chrome.downloads.download({ url, filename, saveAs: true });
      sendResponse({ ok: true, downloadId });
    })();
    return true;
  }

  if (message && message.type === "TRIGGER_MANUAL_CAPTURE") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !self.BackpackSites.supportedSite(tab.url)) {
        sendResponse({ ok: false, error: "unsupported_tab" });
        return;
      }
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { type: "MANUAL_CAPTURE" });
        sendResponse(result || { ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  return undefined;
});
