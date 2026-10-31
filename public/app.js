"use strict";

const previewButton = document.querySelector("#preview-button");
const previewStatus = document.querySelector("#preview-status");
const resultPanel = document.querySelector("#preview-result");
const activeRequests = new Set();

async function getJson(path) {
  const controller = new AbortController();
  activeRequests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
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
    const status = await getJson("/api/status");
    document.querySelectorAll("[data-adapter]").forEach(card => showAdapter(card, status.adapters?.[card.dataset.adapter]));
    const mode = status.service?.mode;
    const isDemo = mode === "demo";
    document.querySelector("#demo-badge").hidden = !isDemo;
    document.querySelector("#connection-notice").textContent = isDemo
      ? "Demo mode uses synthetic data. Real service connections remain unavailable."
      : "Local service status. Real connections are not configured in this foundation.";
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
    const preview = await getJson("/api/contract-preview");
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

window.addEventListener("pagehide", () => {
  activeRequests.forEach(controller => controller.abort());
});

loadStatus();
