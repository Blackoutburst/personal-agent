"use strict";

const previewButton = document.querySelector("#preview-button");
const previewStatus = document.querySelector("#preview-status");
const resultPanel = document.querySelector("#preview-result");
const accountButton = document.querySelector("#account-button");
const accountStatus = document.querySelector("#account-status");
const companionIdentity = document.querySelector("#companion-identity");
const activeRequests = new Set();
let accountEpoch = 0;

async function getJson(path, options = {}) {
  const controller = new AbortController();
  activeRequests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
      ...options,
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Local service returned ${response.status}.`);
    return body;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The local request was cancelled or timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
    activeRequests.delete(controller);
  }
}

function showAdapter(card, adapter) {
  const state = typeof adapter?.state === "string" ? adapter.state : "unavailable";
  const label = card.querySelector(".state");
  label.textContent = state.replace(/[_-]/g, " ");
  label.dataset.state = state;
  card.querySelector(".adapter-reason").textContent = adapter?.reason || "No adapter status is available.";
}

async function loadStatus() {
  try {
    const status = await getJson("api/status");
    document.querySelectorAll("[data-adapter]").forEach(card => showAdapter(card, status.adapters?.[card.dataset.adapter]));
    const mode = status.service?.mode;
    const isDemo = mode === "demo";
    const isAccount = mode === "account";
    document.querySelector("#account-panel").hidden = !isAccount;
    document.querySelector("#demo-badge").hidden = !isDemo;
    document.querySelector("#connection-notice").textContent = isDemo
      ? "Demo mode uses synthetic data. Real service connections remain unavailable."
      : isAccount ? "Platform session checks are configured. Personal Codex and Board connections are still unavailable."
      : "Local service status. Real connections are not configured in this foundation.";
    document.querySelector("#foundation-notice").textContent = isAccount
      ? "Platform sign-in and personal Codex are separate connections. Chat, goals and runtime control come in later steps."
      : "This foundation is not connected to real accounts, Board services or a model provider. Chat and goals are a later step.";
    document.querySelector("#storage-state").textContent = [status.storage?.state || "unavailable", status.storage?.mode].filter(Boolean).join(" · ");
    document.querySelector("#service-version").textContent = `${status.service?.name || "Personal Agent"} · ${status.service?.version || "local"}`;
    previewButton.disabled = !isDemo;
    previewStatus.textContent = isDemo
      ? "Demo ready. The preview makes no external calls."
      : "Contract preview is available only in demo mode.";
  } catch (error) {
    document.querySelectorAll("[data-adapter]").forEach(card => showAdapter(card, { state: "unavailable", reason: "Local service status could not be loaded." }));
    document.querySelector("#connection-notice").textContent = "Local service unavailable. Start the development server and reload this page.";
    document.querySelector("#storage-state").textContent = "Unavailable";
    previewStatus.textContent = error.message;
  }
}

previewButton.addEventListener("click", async () => {
  previewButton.disabled = true;
  previewStatus.textContent = "Loading the synthetic contract preview…";
  resultPanel.hidden = true;
  document.querySelector("#preview-json").textContent = "";
  try {
    const preview = await getJson("api/contract-preview");
    if (preview.synthetic !== true) throw new Error("The service did not identify this preview as synthetic. No preview was displayed.");
    document.querySelector("#preview-message").textContent = preview.message || "Synthetic local contract data. Real adapters remain disconnected.";
    document.querySelector("#preview-json").textContent = JSON.stringify(preview, null, 2);
    resultPanel.hidden = false;
    previewStatus.textContent = "Synthetic preview loaded. No work was submitted.";
  } catch (error) {
    previewStatus.textContent = error.message;
  } finally {
    previewButton.disabled = false;
  }
});

function clearIdentity() {
  accountEpoch++;
  companionIdentity.hidden = true;
  companionIdentity.textContent = "";
  accountStatus.textContent = "Check your current platform sign-in to continue.";
}

accountButton.addEventListener("click", async () => {
  accountButton.disabled = true;
  clearIdentity();
  const requestEpoch = accountEpoch;
  accountStatus.textContent = "Checking your current platform sign-in…";
  try {
    const session = await getJson("api/session", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: "{}" });
    if (requestEpoch !== accountEpoch || document.visibilityState === "hidden") return;
    if (typeof session.companionId !== "string" || !/^[0-9a-f-]{36}$/.test(session.companionId)
      || session.provider?.state !== "unavailable" || session.runtime?.state !== "unavailable") {
      throw new Error("The account response could not be verified. Please try again.");
    }
    companionIdentity.textContent = `Companion ${session.companionId}`;
    companionIdentity.hidden = false;
    accountStatus.textContent = "Your invited platform account is verified. Your companion identity is ready; personal Codex is not connected.";
  } catch (error) {
    if (requestEpoch !== accountEpoch || document.visibilityState === "hidden") return;
    clearIdentity();
    accountStatus.textContent = error.message;
  } finally {
    accountButton.disabled = false;
  }
});

// Clear a previous display when returning from platform login/logout. This display is never authority.
window.addEventListener("pageshow", clearIdentity);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    clearIdentity();
    accountStatus.textContent = "Check your current platform sign-in to continue.";
  }
});
window.addEventListener("pagehide", () => {
  clearIdentity();
  activeRequests.forEach(controller => controller.abort());
});

loadStatus();
