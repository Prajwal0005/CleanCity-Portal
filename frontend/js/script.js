const inferredHost = window.location.hostname;
const inferredBase = inferredHost ? `http://${inferredHost}:5000` : null;
const API_BASES = [
  window.API_BASE,
  localStorage.getItem("apiBase"),
  inferredBase,
  "http://127.0.0.1:5000",
  "http://localhost:5000",
].filter(Boolean);
const API_BASE = API_BASES[0];
let activeApiBase = API_BASE;

const authStorage = window.sessionStorage;
const APP_EVENT_KEY = "cleancity:last-event";
const ADMIN_REFRESH_INTERVAL_MS = 10000;
const WORKER_REFRESH_INTERVAL_MS = 8000;

const getSessionValue = (key) => authStorage.getItem(key);
const setSessionValue = (key, value) => authStorage.setItem(key, value);
const removeSessionValue = (key) => authStorage.removeItem(key);
const getToken = () => getSessionValue("token");
const getRole = () => getSessionValue("role");
const getName = () => getSessionValue("name");
const complaintCacheKey = "complaintCache";
const complaintStatusKey = "complaintStatusCache";
let complaintImageData = "";
let complaintImageFile = null;
const workerResolveImages = {};
let workerFilePickerOpen = false;
let citizenRefreshTimer = null;
let adminRefreshTimer = null;
let workerRefreshTimer = null;
const SLA_HOURS = 72;
const SECOND_ESCALATION_HOURS = 48;
const HIGHER_AUTHORITY_CONTACT = {
  name: "City Commissioner Office",
  phone: "1800-123-7000",
  email: "commissioner@cleancity.gov",
};
let adminComplaintsCache = [];
let adminFilteredComplaints = [];
let adminSearchTimer = null;
let adminPage = 1;
const adminPageSizeKey = "adminPageSize";
let adminReadOnly = false;
let adminEscalatedCache = [];
let adminWorkersCache = [];
let citizenComplaintsCache = [];
let citizenActiveTab = "all";
let citizenRenderedList = [];

const statusClassMap = {
  pending: "badge-pending",
  assigned: "badge-awaiting",
  accepted: "badge-progress",
  "work started": "badge-progress",
  "in progress": "badge-progress",
  "awaiting verification": "badge-awaiting",
  resolved: "badge-resolved",
};

function statusBadge(status) {
  const key = (status || "pending").toLowerCase();
  const cls = statusClassMap[key] || "badge-pending";
  return `<span class="badge-status ${cls}">${status || "Pending"}</span>`;
}

function getComplaintCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(complaintCacheKey));
    return cached && typeof cached === "object" ? cached : {};
  } catch {
    return {};
  }
}

function setComplaintCache(cache) {
  localStorage.setItem(complaintCacheKey, JSON.stringify(cache));
}

function makeComplaintKey(item) {
  return `${item.title || ""}||${item.location || ""}||${item.issue_type || ""}`
    .trim()
    .toLowerCase();
}

function getComplaintId(item) {
  return (
    item?._id ||
    item?.id ||
    item?.complaint_id ||
    item?.complaintId ||
    ""
  );
}

function normalizeImageUrl(value) {
  if (!value) return "";
  const text = String(value);
  if (text.startsWith("data:") || text.startsWith("http://") || text.startsWith("https://")) {
    return text;
  }
  const base = activeApiBase || API_BASE || "";
  if (!base) return text;
  const needsSlash = !text.startsWith("/");
  return `${base}${needsSlash ? "/" : ""}${text}`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function getSlaMeta(complaint) {
  const status = (complaint.status || "").toLowerCase();
  const submitted = new Date(complaint.submitted_at);
  const hasDate = !Number.isNaN(submitted.getTime());

  if (!hasDate) {
    return {
      label: `SLA: ${SLA_HOURS}h`,
      className: "badge-sla-ok",
      overdue: false,
    };
  }

  const diffHours = Math.max(0, (Date.now() - submitted.getTime()) / 36e5);

  if (status === "resolved") {
    return {
      label: `Resolved in ${Math.ceil(diffHours)}h`,
      className: "badge-sla-ok",
      overdue: false,
    };
  }

  if (diffHours > SLA_HOURS) {
    return {
      label: `Overdue by ${Math.ceil(diffHours - SLA_HOURS)}h`,
      className: "badge-sla-overdue",
      overdue: true,
    };
  }

  return {
    label: `Due in ${Math.ceil(SLA_HOURS - diffHours)}h`,
    className: "badge-sla-ok",
    overdue: false,
  };
}

function getSecondEscalationMeta(complaint) {
  const level = Number(complaint.escalated_level || 0);
  if (level < 1) {
    return { label: "", eligible: false, level };
  }
  if (level >= 2) {
    return { label: "Escalated Level 2", eligible: false, level };
  }

  const escalatedAt = new Date(complaint.escalated_at);
  if (Number.isNaN(escalatedAt.getTime())) {
    return { label: `Escalate Level 2 (after ${SECOND_ESCALATION_HOURS}h)`, eligible: true, level };
  }
  const diffHours = Math.max(0, (Date.now() - escalatedAt.getTime()) / 36e5);
  if (diffHours >= SECOND_ESCALATION_HOURS) {
    return { label: "Escalate Level 2", eligible: true, level };
  }
  return {
    label: `Escalate Level 2 in ${Math.ceil(SECOND_ESCALATION_HOURS - diffHours)}h`,
    eligible: false,
    level,
  };
}

function escapeCsv(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function getAdminPageSize() {
  const select = document.getElementById("adminPageSize");
  const stored = localStorage.getItem(adminPageSizeKey);
  const value = select?.value || stored || "6";
  const size = Number.parseInt(value, 10);
  return Number.isFinite(size) && size > 0 ? size : 6;
}

function syncAdminPageSize(size) {
  const select = document.getElementById("adminPageSize");
  if (select && select.value !== String(size)) {
    select.value = String(size);
  }
  localStorage.setItem(adminPageSizeKey, String(size));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function broadcastAppEvent(type, payload = {}) {
  try {
    localStorage.setItem(
      APP_EVENT_KEY,
      JSON.stringify({
        type,
        payload,
        at: Date.now(),
      })
    );
  } catch {
    // ignore storage errors
  }
}

function refreshCurrentPageData() {
  const page = document.body?.dataset?.page;
  if (page === "admin") {
    loadAdminDashboard().catch(() => {});
    return;
  }
  if (page === "worker") {
    loadWorkerDashboard().catch(() => {});
    return;
  }
  if (page === "citizen") {
    loadCitizenComplaints().catch(() => {});
  }
}

function handleCrossWindowEvent(rawValue) {
  if (!rawValue) return;

  let eventData;
  try {
    eventData = JSON.parse(rawValue);
  } catch {
    return;
  }

  const type = eventData?.type || "";
  if (type === "session-logout") {
    if (!getToken()) {
      const page = document.body?.dataset?.page;
      if (page !== "login" && page !== "reset") {
        window.location.href = "index.html";
      }
    }
    return;
  }

  if (type === "complaint-created" || type === "complaint-updated") {
    refreshCurrentPageData();
  }
}

function initCrossWindowSync() {
  window.addEventListener("storage", (event) => {
    if (event.key !== APP_EVENT_KEY) return;
    handleCrossWindowEvent(event.newValue);
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshCurrentPageData();
    }
  });
}

function getAssignedWorkerMeta(item) {
  return {
    workerId: item?.assigned_worker_id || "",
    workerName: item?.assigned_worker_name || item?.assigned_to || "",
  };
}

function renderWorkerOptions(item) {
  const { workerId, workerName } = getAssignedWorkerMeta(item);
  const placeholderLabel = adminWorkersCache.length
    ? "Select worker"
    : "No workers available";

  return [
    `<option value="">${placeholderLabel}</option>`,
    ...adminWorkersCache.map((worker) => {
      const selected =
        (workerId && worker._id === workerId) ||
        (!workerId && workerName && worker.name === workerName);
      const label = worker.email ? `${worker.name} (${worker.email})` : worker.name;
      return `<option value="${escapeHtml(worker._id)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
    }),
  ].join("");
}

function showAdminToast(title, message, tone = "success") {
  const stack = document.getElementById("adminToastStack");
  if (!stack) return;

  const toast = document.createElement("div");
  toast.className = `admin-toast is-${tone}`;
  toast.innerHTML = `
    <div class="admin-toast-title">${escapeHtml(title)}</div>
    <div class="admin-toast-text">${escapeHtml(message)}</div>
  `;

  stack.appendChild(toast);
  window.setTimeout(() => {
    toast.remove();
  }, 3200);
}

function showWorkerMessage(message, tone = "success") {
  const box = document.getElementById("workerActionMessage");
  if (!box) return;
  box.textContent = message || "";
  box.classList.remove("text-success", "text-danger");
  box.classList.add(tone === "error" ? "text-danger" : "text-success");
}

function setInlineMessage(elementOrId, message, tone = "success") {
  const box =
    typeof elementOrId === "string"
      ? document.getElementById(elementOrId)
      : elementOrId;
  if (!box) return;
  box.textContent = message || "";
  box.classList.remove("text-success", "text-danger");
  if (message) {
    box.classList.add(tone === "error" ? "text-danger" : "text-success");
  }
}

function disableForm(formId, disabled = true) {
  const form = document.getElementById(formId);
  if (!form) return;
  form.querySelectorAll("input, select, button, textarea").forEach((field) => {
    field.disabled = disabled;
  });
}

function redirectToRoleHome() {
  const role = getRole();
  if (role === "admin") {
    window.location.href = "admin.html";
    return;
  }
  if (role === "worker") {
    window.location.href = "worker.html";
    return;
  }
  window.location.href = "citizen.html";
}

function getUnauthorizedMessage(area = "this page") {
  return `Your session does not have permission to use ${area}. Please logout and login again with an admin account.`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

function compressImageFile(file, options = {}) {
  const maxDimension = options.maxDimension ?? 1280;
  const quality = options.quality ?? 0.72;
  const maxSizeBytes = options.maxSizeBytes ?? 350 * 1024;

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const image = new Image();

    reader.onload = () => {
      image.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Image read failed"));

    image.onload = () => {
      const width = image.width || 1;
      const height = image.height || 1;
      const longestSide = Math.max(width, height);
      const needsResize = longestSide > maxDimension || file.size > maxSizeBytes;

      if (!needsResize) {
        resolve(reader.result);
        return;
      }

      const scale = Math.min(1, maxDimension / longestSide);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };

    image.onerror = () => reject(new Error("Image load failed"));

    reader.readAsDataURL(file);
  });
}

function logout(redirect = true) {
  ["token", "userId", "role", "name"].forEach(removeSessionValue);
  broadcastAppEvent("session-logout");
  if (redirect) {
    window.location.href = "index.html";
  }
}

function reachabilityMessage() {
  const bases = API_BASES.join(", ");
  if (window.location.protocol === "https:") {
    return `Backend not reachable at ${bases}. This page is served over HTTPS, so the browser blocks HTTP APIs. Open the frontend with http:// or enable HTTPS on the backend.`;
  }
  if (window.location.protocol === "file:") {
    return `Backend not reachable at ${bases}. Open the frontend using a local server (e.g. Live Server) and try again.`;
  }
  return `Backend not reachable at ${bases}. Please start the server.`;
}

async function apiFetch(path, options = {}, auth = false) {
  const headers = { ...(options.headers || {}) };

  const isFormData =
    typeof FormData !== "undefined" && options.body instanceof FormData;
  if (options.body && !headers["Content-Type"] && !isFormData) {
    headers["Content-Type"] = "application/json";
  }

  const token = getToken();
  if ((auth || token) && token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const basesToTry = [
    activeApiBase,
    ...API_BASES.filter((base) => base !== activeApiBase),
  ];
  let response;
  let lastError;

  for (const base of basesToTry) {
    try {
      response = await fetch(`${base}${path}`, {
        ...options,
        headers,
      });
      activeApiBase = base;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!response) {
    throw lastError || new Error("Network error");
  }

  if (auth && (response.status === 401 || response.status === 422)) {
    logout();
    throw new Error(`Unauthorized (${response.status})`);
  }

  return response;
}

async function handleLogin(email, password) {
  const errorEl = document.getElementById("loginError");
  if (errorEl) {
    errorEl.textContent = "";
  }

  try {
    const response = await apiFetch("/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    const data = await response.json();

    if (!response.ok) {
      if (errorEl) {
        errorEl.textContent = data.error || "Login failed.";
      }
      return;
    }

    const token = data.access_token || data.token;
    if (!token) {
      if (errorEl) {
        errorEl.textContent = "Login token missing.";
      }
      return;
    }

    setSessionValue("token", token);
    setSessionValue("userId", data.user_id || data.id || "");
    setSessionValue("role", data.role || "citizen");
    setSessionValue("name", data.name || "User");

    const welcome = document.getElementById("loginWelcome");
    if (welcome) {
      welcome.classList.add("show");
    }

    const redirect = () => {
      if (data.role === "admin") {
        window.location.href = "admin.html";
      } else if (data.role === "worker") {
        window.location.href = "worker.html";
      } else {
        window.location.href = "citizen.html";
      }
    };

    setTimeout(redirect, 2500);
  } catch (error) {
    if (errorEl) {
      errorEl.textContent = reachabilityMessage();
    }
  }
}

function initLoginPage() {
  const form = document.getElementById("loginForm");
  const emailInput = document.getElementById("loginEmail");
  const passwordInput = document.getElementById("loginPassword");
  const errorEl = document.getElementById("loginError");
  const toggleButton = document.querySelector(".toggle-password");
  const demoButtons = document.querySelectorAll("[data-demo]");
  const forgotModal = document.getElementById("forgotModal");
  const forgotOpen = document.querySelector('[data-modal-open="forgot"]');
  const forgotForm = document.getElementById("forgotForm");
  const forgotEmail = document.getElementById("forgotEmail");
  const forgotMessage = document.getElementById("forgotMessage");
  const modalCloseEls = forgotModal
    ? forgotModal.querySelectorAll("[data-modal-close]")
    : [];
  let lastFocus = null;

  const clearFieldState = (input) => {
    if (!input) return;
    input.removeAttribute("aria-invalid");
    const wrap = input.closest(".input-wrap");
    if (wrap) wrap.classList.remove("invalid");
  };

  const markInvalid = (input) => {
    if (!input) return;
    input.setAttribute("aria-invalid", "true");
    const wrap = input.closest(".input-wrap");
    if (wrap) wrap.classList.add("invalid");
  };

  const showLoginError = (message) => {
    if (errorEl) {
      errorEl.textContent = message;
    }
  };

  const clearLoginError = () => {
    if (errorEl) {
      errorEl.textContent = "";
    }
  };

  const validateLogin = () => {
    if (!emailInput || !passwordInput) return null;
    clearLoginError();
    clearFieldState(emailInput);
    clearFieldState(passwordInput);

    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();
    let message = "";

    if (!email) {
      message = "Please enter your email address.";
      markInvalid(emailInput);
    } else if (!emailInput.checkValidity()) {
      message = "Please enter a valid email address.";
      markInvalid(emailInput);
    }

    if (!password) {
      if (!message) message = "Please enter your password.";
      markInvalid(passwordInput);
    } else if (password.length < 8) {
      if (!message) message = "Password should be at least 8 characters.";
      markInvalid(passwordInput);
    }

    if (message) {
      showLoginError(message);
      const focusTarget = emailInput.matches('[aria-invalid="true"]')
        ? emailInput
        : passwordInput;
      focusTarget?.focus();
      return null;
    }

    return { email, password };
  };

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const credentials = validateLogin();
      if (!credentials) return;
      handleLogin(credentials.email, credentials.password);
    });
  }

  if (emailInput) {
    emailInput.addEventListener("input", () => {
      clearFieldState(emailInput);
      clearLoginError();
    });
  }

  if (passwordInput) {
    passwordInput.addEventListener("input", () => {
      clearFieldState(passwordInput);
      clearLoginError();
    });
  }

  if (toggleButton && passwordInput) {
    toggleButton.addEventListener("click", () => {
      const isHidden = passwordInput.type === "password";
      passwordInput.type = isHidden ? "text" : "password";
      toggleButton.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
      toggleButton.setAttribute("aria-pressed", isHidden ? "true" : "false");
      toggleButton.innerHTML = isHidden
        ? '<i class="fa-regular fa-eye-slash"></i>'
        : '<i class="fa-regular fa-eye"></i>';
    });
  }

  const openForgotModal = () => {
    if (!forgotModal) return;
    lastFocus = document.activeElement;
    clearLoginError();
    clearFieldState(emailInput);
    clearFieldState(passwordInput);
    document.body.classList.add("modal-open");
    forgotModal.classList.add("show");
    forgotModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    if (forgotForm) forgotForm.reset();
    if (forgotMessage) {
      forgotMessage.textContent = "";
      forgotMessage.classList.remove("text-danger", "text-success");
    }
    clearFieldState(forgotEmail);
    setTimeout(() => forgotEmail?.focus(), 50);
  };

  const closeForgotModal = () => {
    if (!forgotModal) return;
    forgotModal.classList.remove("show");
    forgotModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    document.body.classList.remove("modal-open");
    if (lastFocus && typeof lastFocus.focus === "function") {
      lastFocus.focus();
    }
  };

  if (forgotOpen) {
    forgotOpen.addEventListener("click", (event) => {
      event.preventDefault();
      openForgotModal();
    });
  }

  modalCloseEls.forEach((btn) => {
    btn.addEventListener("click", closeForgotModal);
  });

  if (forgotModal) {
    forgotModal.addEventListener("click", (event) => {
      if (event.target === forgotModal) closeForgotModal();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && forgotModal?.classList.contains("show")) {
      closeForgotModal();
    }
  });

  if (forgotForm && forgotEmail && forgotMessage) {
    forgotForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearFieldState(forgotEmail);
      forgotMessage.textContent = "";
      forgotMessage.classList.remove("text-danger", "text-success");

      const email = forgotEmail.value.trim();
      if (!email || !forgotEmail.checkValidity()) {
        markInvalid(forgotEmail);
        forgotMessage.textContent = "Please enter a valid email address.";
        forgotMessage.classList.add("text-danger");
        forgotEmail.focus();
        return;
      }

      const origin = window.location.origin || "";
      const path = window.location.pathname || "";
      let frontendBase = "";
      if (origin.startsWith("http")) {
        frontendBase = path.startsWith("/frontend") ? `${origin}/frontend` : origin;
      }

      try {
        const response = await apiFetch("/forgot-password", {
          method: "POST",
          body: JSON.stringify({ email, frontend_base: frontendBase }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          forgotMessage.textContent = data.error || "Unable to send reset link. Please try again.";
          forgotMessage.classList.add("text-danger");
          return;
        }
      } catch {
        forgotMessage.textContent = reachabilityMessage();
        forgotMessage.classList.add("text-danger");
        return;
      }

      forgotMessage.textContent =
        "If this email is registered, a reset link will be shared shortly.";
      forgotMessage.classList.add("text-success");
      forgotForm.reset();
    });
  }

  if (forgotEmail && forgotMessage) {
    forgotEmail.addEventListener("input", () => {
      clearFieldState(forgotEmail);
      forgotMessage.textContent = "";
      forgotMessage.classList.remove("text-danger", "text-success");
    });
  }

  demoButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const email = btn.dataset.email || "demo@cleancity.gov";
      const password = btn.dataset.password || "Demo@123";
      if (emailInput) emailInput.value = email;
      if (passwordInput) passwordInput.value = password;
      handleLogin(email, password);
    });
  });
}

function initResetPage() {
  const form = document.getElementById("resetForm");
  const passwordInput = document.getElementById("resetPassword");
  const confirmInput = document.getElementById("resetConfirm");
  const message = document.getElementById("resetMessage");
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const toggleButtons = document.querySelectorAll('[data-toggle="password"]');

  const clearFieldState = (input) => {
    if (!input) return;
    input.removeAttribute("aria-invalid");
    const wrap = input.closest(".input-wrap");
    if (wrap) wrap.classList.remove("invalid");
  };

  const markInvalid = (input) => {
    if (!input) return;
    input.setAttribute("aria-invalid", "true");
    const wrap = input.closest(".input-wrap");
    if (wrap) wrap.classList.add("invalid");
  };

  const setMessage = (text, tone) => {
    if (!message) return;
    message.textContent = text;
    message.classList.remove("text-danger", "text-success");
    if (tone) message.classList.add(tone);
  };

  toggleButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-target");
      const input = targetId ? document.getElementById(targetId) : null;
      if (!input) return;
      const isHidden = input.type === "password";
      input.type = isHidden ? "text" : "password";
      btn.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
      btn.setAttribute("aria-pressed", isHidden ? "true" : "false");
      btn.innerHTML = isHidden
        ? '<i class="fa-regular fa-eye-slash"></i>'
        : '<i class="fa-regular fa-eye"></i>';
    });
  });

  if (!token) {
    setMessage("Invalid or missing reset link. Please request a new one.", "text-danger");
    if (passwordInput) passwordInput.disabled = true;
    if (confirmInput) confirmInput.disabled = true;
    if (form) form.querySelector("button[type='submit']")?.setAttribute("disabled", "true");
    return;
  }

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearFieldState(passwordInput);
      clearFieldState(confirmInput);
      setMessage("", "");

      const password = passwordInput?.value.trim() || "";
      const confirm = confirmInput?.value.trim() || "";

      if (!password || password.length < 8) {
        markInvalid(passwordInput);
        setMessage("Password should be at least 8 characters.", "text-danger");
        passwordInput?.focus();
        return;
      }

      if (password !== confirm) {
        markInvalid(confirmInput);
        setMessage("Passwords do not match. Please re-enter.", "text-danger");
        confirmInput?.focus();
        return;
      }

      try {
        const response = await apiFetch("/reset-password", {
          method: "POST",
          body: JSON.stringify({ token, password }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setMessage(data.error || "Unable to reset password. Please try again.", "text-danger");
          return;
        }
      } catch {
        setMessage(reachabilityMessage(), "text-danger");
        return;
      }

      setMessage("Password updated successfully. Redirecting to login...", "text-success");
      if (passwordInput) passwordInput.disabled = true;
      if (confirmInput) confirmInput.disabled = true;
      form.querySelector("button[type='submit']")?.setAttribute("disabled", "true");
      setTimeout(() => {
        window.location.href = "index.html";
      }, 2000);
    });
  }

  if (passwordInput && message) {
    passwordInput.addEventListener("input", () => {
      clearFieldState(passwordInput);
      setMessage("", "");
    });
  }

  if (confirmInput && message) {
    confirmInput.addEventListener("input", () => {
      clearFieldState(confirmInput);
      setMessage("", "");
    });
  }
}

function initWelcome() {
  const raw = getName() || "User";
  const name = String(raw).replace(/^[^a-zA-Z0-9]+/, "").trim() || "User";
  const welcomeEls = document.querySelectorAll("[data-welcome]");
  welcomeEls.forEach((el) => {
    el.textContent = name;
  });
}

function initCitizenSidebar() {
  const links = document.querySelectorAll(".sidebar-menu .menu-item[data-tab]");
  const triggers = document.querySelectorAll("[data-tab]");
  const panels = document.querySelectorAll(".tab-panel[data-panel]");
  if (!links.length || !panels.length) return;

  const showPanel = (target) => {
    panels.forEach((panel) => {
      const isTarget = panel.dataset.panel === target;
      panel.classList.toggle("is-hidden", !isTarget);
    });
    links.forEach((link) => {
      const isActive = link.dataset.tab === target;
      link.classList.toggle("active", isActive);
      if (isActive) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  };

  const initialHash = window.location.hash.replace("#", "");
  if (initialHash === "complaints") {
    showPanel("complaints");
  } else {
    showPanel("new");
  }

  triggers.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const target = link.dataset.tab;
      if (!target) return;
      showPanel(target);
      window.history.replaceState(null, "", `#${target}`);
    });
  });
}

function initComplaintsFilters() {
  const tabs = document.querySelectorAll(".complaints-tabs .tab");
  const statusSelect = document.getElementById("complaintStatusFilter");

  if (tabs.length) {
    tabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        citizenActiveTab = btn.dataset.filter || "all";
        tabs.forEach((tab) => tab.classList.toggle("active", tab === btn));
        applyCitizenFilters();
      });
    });
  }

  if (statusSelect) {
    statusSelect.addEventListener("change", applyCitizenFilters);
  }
}

async function loadCitizenComplaints() {
  const container = document.getElementById("citizenComplaints");
  if (!container) return;

  const response = await apiFetch("/complaints/my", {}, true);
  const data = await response.json();
  const complaints = Array.isArray(data) ? data : [];

  const totals = {
    total: document.getElementById("citizenTotal"),
    open: document.getElementById("citizenOpen"),
    progress: document.getElementById("citizenInProgress"),
    closed: document.getElementById("citizenClosed"),
  };

  const openCount = complaints.filter(
    (item) => {
      const status = (item.status || "").toLowerCase();
      return status === "pending" || status === "assigned";
    }
  ).length;
  const progressCount = complaints.filter((item) => {
    const status = (item.status || "").toLowerCase();
    return (
      status === "accepted" ||
      status === "work started" ||
      status === "in progress" ||
      status === "awaiting verification"
    );
  }).length;
  const closedCount = complaints.filter(
    (item) => (item.status || "").toLowerCase() === "resolved"
  ).length;

  if (totals.total) totals.total.textContent = complaints.length;
  if (totals.open) totals.open.textContent = openCount;
  if (totals.progress) totals.progress.textContent = progressCount;
  if (totals.closed) totals.closed.textContent = closedCount;

  const donut = document.getElementById("complaintsDonut");
  if (donut) {
    const total = complaints.length || 1;
    const openPct = Math.round((openCount / total) * 100);
    const progressPct = Math.round((progressCount / total) * 100);
    const closedPct = Math.max(0, 100 - openPct - progressPct);
    donut.style.setProperty("--open", `${openPct}%`);
    donut.style.setProperty("--progress", `${progressPct}%`);
    donut.style.setProperty("--closed", `${closedPct}%`);
  }

  citizenComplaintsCache = complaints;
  handleCitizenNotifications(complaints);
  applyCitizenFilters();
}

function getStatusMeta(status) {
  const key = (status || "pending").toLowerCase();
  if (key === "resolved") return { label: "Closed", cls: "status-closed" };
  if (key === "assigned") return { label: "Assigned", cls: "status-open" };
  if (key === "accepted") return { label: "Accepted", cls: "status-progress" };
  if (key === "work started") return { label: "Work Started", cls: "status-progress" };
  if (key === "in progress" || key === "awaiting verification") {
    return { label: "In-Progress", cls: "status-progress" };
  }
  return { label: "Open", cls: "status-open" };
}

function renderCitizenList(list) {
  const container = document.getElementById("citizenComplaints");
  if (!container) return;

  if (!list.length) {
    container.innerHTML = "<p class=\"text-muted\">No complaints found.</p>";
    citizenRenderedList = [];
    return;
  }

  citizenRenderedList = list;
  const cache = getComplaintCache();
  container.innerHTML = list
    .map((item, index) => {
      const status = getStatusMeta(item.status);
      const title = item.title || "Untitled";
      const location = item.location || "Location not set";
      const category = item.issue_type || "Complaint";
      const complaintId = getComplaintId(item);
      const key = makeComplaintKey(item);
      const cachedImage = cache[key]?.image || "";
      const imageRaw =
        item.image ||
        item.image_url ||
        item.imageUrl ||
        item.photo ||
        item.imagePath ||
        cachedImage;
      const imageSrc = normalizeImageUrl(imageRaw);
      const media = imageSrc
        ? `<div class="row-thumb">
            <img class="clickable-image" data-index="${index}" data-id="${complaintId}" data-image="${imageSrc}" src="${imageSrc}" alt="${title} preview" loading="lazy">
          </div>`
        : `<div class="row-thumb row-thumb-empty" aria-hidden="true">
            <i class="fa-regular fa-image"></i>
          </div>`;
      return `
        <div class="complaint-row" data-image="${imageSrc || ""}" data-index="${index}" data-id="${complaintId}">
          <div class="row-left">
            ${media}
            <div>
              <div class="row-title">${title}</div>
              <div class="row-meta">${location} • ${category}</div>
            </div>
          </div>
          <div class="row-right">
            <span class="status-pill ${status.cls}">${status.label}</span>
            <button class="row-action" type="button" aria-label="View complaint" data-image="${imageSrc || ""}" data-index="${index}" data-id="${complaintId}">
              <i class="fa-solid fa-chevron-right"></i>
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

function applyCitizenFilters() {
  const statusSelect = document.getElementById("complaintStatusFilter");
  const statusValue = statusSelect?.value || "all";
  let list = [...citizenComplaintsCache];

  if (statusValue !== "all") {
    list = list.filter(
      (item) => (item.status || "pending").toLowerCase() === statusValue
    );
  }

  if (citizenActiveTab !== "all") {
    list = list.filter((item) => {
      if (citizenActiveTab === "public") {
        return item.visibility === "public" || item.is_public === true;
      }
      if (citizenActiveTab === "private") {
        return item.visibility === "private" || item.is_public === false;
      }
      return true;
    });
  }

  renderCitizenList(list);
}


function initComplaintImageUpload() {
  const input = document.getElementById("complaintImage");
  const preview = document.getElementById("complaintImagePreview");
  const previewImg = document.getElementById("complaintImagePreviewImg");
  if (!input || !preview || !previewImg) return;

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) {
      complaintImageData = "";
      complaintImageFile = null;
      preview.style.display = "none";
      previewImg.src = "";
      return;
    }

    try {
      preview.style.display = "none";
      previewImg.src = "";
      complaintImageFile = file;
      complaintImageData = await compressImageFile(file);
      previewImg.src = complaintImageData;
      preview.style.display = "block";
    } catch {
      complaintImageFile = file;
      complaintImageData = await fileToDataUrl(file);
      previewImg.src = complaintImageData;
      preview.style.display = "block";
    }
  });
}

function updateNotificationUI() {
  const btn = document.getElementById("notifyBtn");
  if (!btn) return;

  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    btn.textContent = "Notifications Unavailable";
    btn.disabled = true;
    return;
  }

  const permission = Notification.permission;
  if (permission === "granted") {
    btn.textContent = "Notifications On";
    btn.classList.remove("btn-soft");
    btn.classList.add("btn-success");
  } else if (permission === "denied") {
    btn.textContent = "Notifications Blocked";
    btn.classList.remove("btn-soft");
    btn.classList.add("btn-secondary");
  } else {
    btn.textContent = "Enable Notifications";
    btn.classList.remove("btn-success", "btn-secondary");
    btn.classList.add("btn-soft");
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function getVapidPublicKey() {
  const response = await apiFetch("/notifications/vapid-public-key");
  const data = await response.json();
  if (!response.ok || !data.publicKey) {
    throw new Error(data.error || "VAPID key missing");
  }
  return data.publicKey;
}

async function subscribeForPush() {
  const registration = await navigator.serviceWorker.register("/frontend/sw.js");
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    return existing;
  }

  const publicKey = await getVapidPublicKey();
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  const permission = await Notification.requestPermission();
  updateNotificationUI();
  if (permission !== "granted") return;

  try {
    const subscription = await subscribeForPush();
    await apiFetch(
      "/notifications/subscribe",
      {
        method: "POST",
        body: JSON.stringify(subscription),
      },
      true
    );
  } catch (error) {
    alert("Notifications setup failed. Please contact admin.");
    return;
  }

  try {
    new Notification("Notifications enabled", {
      body: "We will alert you when a complaint is resolved.",
    });
  } catch {
    // Ignore notification errors
  }
}

function getStatusCache() {
  try {
    return JSON.parse(localStorage.getItem(complaintStatusKey)) || {};
  } catch {
    return {};
  }
}

function setStatusCache(cache) {
  localStorage.setItem(complaintStatusKey, JSON.stringify(cache));
}

function handleCitizenNotifications(complaints) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }

  const cache = getStatusCache();
  complaints.forEach((complaint) => {
    const id = complaint._id;
    if (!id) return;
    const status = (complaint.status || "").toLowerCase();
    const prev = cache[id];

    if (prev && prev !== "resolved" && status === "resolved") {
      try {
        new Notification("Complaint Resolved", {
          body: `${complaint.title || "Complaint"} is resolved.`,
        });
      } catch {
        // Ignore notification errors
      }
    }

    cache[id] = status;
  });

  setStatusCache(cache);
}

function bindCitizenActions() {
  const container = document.getElementById("citizenComplaints");
  if (!container) return;

  container.addEventListener("click", (event) => {
    const image = event.target.closest(".clickable-image");
    const rowAction = event.target.closest(".row-action");
    const row = event.target.closest(".complaint-row");
    const escalateBtn = event.target.closest('[data-action="escalate"]');
    const higherBtn = event.target.closest('[data-action="higher-authority"]');
    const feedbackBtn = event.target.closest('[data-action="feedback"]');

    if (image) {
      const indexValue = image.dataset.index;
      const index = indexValue ? Number(indexValue) : Number.NaN;
      const item = Number.isNaN(index) ? null : citizenRenderedList[index];
      if (item) {
        openCitizenDetailPage(item);
      }
      return;
    }

    if (rowAction || row) {
      const indexValue = rowAction?.dataset.index || row?.dataset.index;
      const index = indexValue ? Number(indexValue) : Number.NaN;
      const item = Number.isNaN(index) ? null : citizenRenderedList[index];
      if (item) {
        openCitizenDetailPage(item);
      }
      return;
    }

    if (higherBtn) {
      const title = higherBtn.dataset.title || "your complaint";
      alert(
        `Your complaint "${title}" has reached Level 2 escalation.\n\n` +
          `Please contact ${HIGHER_AUTHORITY_CONTACT.name}:\n` +
          `Phone: ${HIGHER_AUTHORITY_CONTACT.phone}\n` +
          `Email: ${HIGHER_AUTHORITY_CONTACT.email}`
      );
      return;
    }

    if (feedbackBtn) {
      const id = feedbackBtn.dataset.id;
      const ratingEl = container.querySelector(`[data-feedback-rating][data-id="${id}"]`);
      const commentEl = container.querySelector(`[data-feedback-comment][data-id="${id}"]`);
      const rating = ratingEl ? ratingEl.value : "";
      const comment = commentEl ? commentEl.value : "";

      if (!rating) {
        alert("Please select a rating (1-5).");
        return;
      }

      apiFetch(
        `/complaints/${id}/feedback`,
        {
          method: "POST",
          body: JSON.stringify({ rating, comment }),
        },
        true
      )
        .then((response) => response.json().then((data) => ({ response, data })))
        .then(({ response, data }) => {
          if (!response.ok) {
            alert(data.error || "Unable to submit feedback.");
            return;
          }
          alert(data.message || "Thanks for your feedback!");
          loadCitizenComplaints();
        })
        .catch(() => {
          alert("Server not reachable. Please try again.");
        });
      return;
    }

    if (!escalateBtn || escalateBtn.disabled) return;

    const title = escalateBtn.dataset.title || "your complaint";
    const level = Number(escalateBtn.dataset.level || 0);
    const complaintId = escalateBtn.dataset.id;
    if (!complaintId) return;

    apiFetch(
      `/complaints/${complaintId}/escalate`,
      { method: "POST" },
      true
    )
      .then((response) => response.json().then((data) => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok) {
          alert(data.error || "Unable to escalate complaint.");
          return;
        }
        alert(
          data.message ||
            (level >= 1
              ? `Your complaint "${title}" has been escalated to level 2.`
              : `Your complaint "${title}" has been escalated to the senior officer.`)
        );
        loadCitizenComplaints();
      })
      .catch(() => {
        alert("Server not reachable. Please try again.");
      });
  });
}

function bindCitizenViewerClose() {
  const viewer = document.getElementById("imageViewer");
  if (!viewer) return;

  document.addEventListener("click", (event) => {
    const closeViewer = event.target.closest('[data-action="close-viewer"]');
    if (!closeViewer) return;
    const viewerImg = document.getElementById("imageViewerImg");
    viewer.classList.add("d-none");
    if (viewerImg) viewerImg.src = "";
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const viewerImg = document.getElementById("imageViewerImg");
    viewer.classList.add("d-none");
    if (viewerImg) viewerImg.src = "";
  });
}

function openCitizenDetailPage(item) {
  try {
    localStorage.setItem("selectedComplaint", JSON.stringify(item));
  } catch {
    // ignore storage errors
  }
  const complaintId = getComplaintId(item);
  const query = complaintId ? `?id=${encodeURIComponent(complaintId)}` : "";
  window.location.href = `complaint-detail.html${query}`;
}

function renderComplaintDetail(item) {
  const titleEl = document.getElementById("detailTitle");
  const statusEl = document.getElementById("detailStatus");
  const typeEl = document.getElementById("detailType");
  const locationEl = document.getElementById("detailLocation");
  const dateEl = document.getElementById("detailDate");
  const phoneEl = document.getElementById("detailPhone");
  const workerEl = document.getElementById("detailWorker");
  const descEl = document.getElementById("detailDesc");
  const beforeImg = document.getElementById("detailBeforeImg");
  const afterImg = document.getElementById("detailAfterImg");
  const beforeEmpty = document.getElementById("detailBeforeEmpty");
  const afterEmpty = document.getElementById("detailAfterEmpty");

  if (titleEl) titleEl.textContent = item.title || "Complaint";
  if (statusEl) statusEl.textContent = item.status || "Pending";
  if (typeEl) typeEl.textContent = item.issue_type || "Complaint";
  if (locationEl) locationEl.textContent = item.location || "Location not set";
  if (dateEl) dateEl.textContent = formatDate(item.submitted_at || item.created_at);
  if (phoneEl) phoneEl.textContent = item.phone || "—";

  const workerName =
    item.worker_name ||
    item.assigned_worker_name ||
    item.assigned_worker ||
    item.assigned_to ||
    item.worker ||
    item.completed_by ||
    item.resolved_by ||
    "—";
  if (workerEl) workerEl.textContent = workerName;

  if (descEl) descEl.textContent = item.description || "No description provided.";

  const key = makeComplaintKey(item);
  const cache = getComplaintCache();
  const cachedImage = cache[key]?.image || "";
  const beforeRaw =
    item.image ||
    item.image_url ||
    item.imageUrl ||
    item.photo ||
    item.imagePath ||
    cachedImage;
  const beforeSrc = normalizeImageUrl(beforeRaw);
  if (beforeImg) {
    if (beforeSrc) {
      beforeImg.src = beforeSrc;
      beforeImg.classList.remove("d-none");
      if (beforeEmpty) beforeEmpty.classList.add("d-none");
    } else {
      beforeImg.src = "";
      beforeImg.classList.add("d-none");
      if (beforeEmpty) beforeEmpty.classList.remove("d-none");
    }
  }

  const afterRaw =
    item.resolved_image_url ||
    item.after_image ||
    item.afterImage ||
    item.resolution_image ||
    item.resolved_image;
  const afterSrc = normalizeImageUrl(afterRaw);
  if (afterImg) {
    if (afterSrc) {
      afterImg.src = afterSrc;
      afterImg.classList.remove("d-none");
      if (afterEmpty) afterEmpty.classList.add("d-none");
    } else {
      afterImg.src = "";
      afterImg.classList.add("d-none");
      if (afterEmpty) afterEmpty.classList.remove("d-none");
    }
  }
}

async function loadComplaintDetail() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  let selected = null;
  try {
    const stored = localStorage.getItem("selectedComplaint");
    selected = stored ? JSON.parse(stored) : null;
  } catch {
    selected = null;
  }

  if (id) {
    const selectedId = getComplaintId(selected || {});
    if (!selected || selectedId !== id) {
      try {
        const response = await apiFetch("/complaints/my", {}, true);
        if (response.ok) {
          const data = await response.json();
          const list = Array.isArray(data) ? data : data.complaints || [];
          selected = list.find((item) => String(getComplaintId(item)) === String(id)) || selected;
        }
      } catch {
        // ignore fetch errors and fall back to stored
      }
    }
  }

  if (selected) {
    renderComplaintDetail(selected);
    return;
  }

  const message = document.getElementById("detailMessage");
  if (message) {
    message.textContent = "Complaint details not found.";
  }
}

async function submitComplaint(event) {
  event.preventDefault();
  const submitButton = document.querySelector("#complaintForm button[type=\"submit\"]");
  const originalSubmitLabel = submitButton?.dataset.label || submitButton?.textContent;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.dataset.label = originalSubmitLabel || "Submit Complaint";
    submitButton.textContent = "Submitting...";
  }

  const payload = {
    title: document.getElementById("complaintTitle").value.trim(),
    description: document.getElementById("complaintDescription").value.trim(),
    issue_type: document.getElementById("complaintType").value,
    location: document.getElementById("complaintLocation").value.trim(),
    phone: document.getElementById("complaintPhone").value.trim(),
  };
  const imageData = complaintImageData;
  const imageFile = complaintImageFile;
  if (!imageFile) {
    const messageEl = document.getElementById("complaintMessage");
    if (messageEl) {
      messageEl.textContent = "Please upload an image to submit the complaint.";
      messageEl.classList.remove("text-success");
      messageEl.classList.add("text-danger");
    }
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = originalSubmitLabel || "Submit Complaint";
    }
    return;
  }
  const formData = new FormData();
  Object.entries(payload).forEach(([key, value]) => {
    formData.append(key, value || "");
  });
  formData.append("image", imageFile);

  const messageEl = document.getElementById("complaintMessage");
  if (messageEl) {
    messageEl.textContent = "";
    messageEl.classList.remove("text-success", "text-danger");
  }

  try {
    const response = await apiFetch(
      "/create-complaint",
      {
        method: "POST",
        body: formData,
      },
      true
    );

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (response.ok) {
      if (messageEl) {
        messageEl.textContent = data.message || "Complaint submitted successfully.";
        messageEl.classList.remove("text-danger");
        messageEl.classList.add("text-success");
      }
      if (payload.title || payload.location || payload.issue_type) {
        const cache = getComplaintCache();
        const key = makeComplaintKey(payload);
        cache[key] = {
          description: payload.description,
          image: imageData || "",
        };
        setComplaintCache(cache);
      }
      document.getElementById("complaintForm").reset();
      complaintImageData = "";
      complaintImageFile = null;
      const preview = document.getElementById("complaintImagePreview");
      const previewImg = document.getElementById("complaintImagePreviewImg");
      if (preview && previewImg) {
        preview.style.display = "none";
        previewImg.src = "";
      }
      broadcastAppEvent("complaint-created", { title: payload.title || "" });
      loadCitizenComplaints();
    } else if (messageEl) {
      messageEl.textContent =
        data.error || `Unable to submit complaint. (${response.status})`;
      messageEl.classList.remove("text-success");
      messageEl.classList.add("text-danger");
    }
  } catch (error) {
    if (messageEl) {
      if (error && String(error.message).startsWith("Unauthorized")) {
        messageEl.textContent = "Session expired. Please login again.";
      } else {
        messageEl.textContent = reachabilityMessage();
      }
      messageEl.classList.remove("text-success");
      messageEl.classList.add("text-danger");
    }
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = originalSubmitLabel || "Submit Complaint";
    }
  }
}

function setAdminLoading(message = "Loading complaints...") {
  const container = document.getElementById("adminComplaints");
  if (!container) return;
  container.innerHTML = `
    <div class="col-12">
      <div class="glass-card text-center py-4">
        <div class="spinner-border text-primary mb-2" role="status"></div>
        <div class="text-muted">${message}</div>
      </div>
    </div>
  `;
}

function updateAdminTypeFilter(complaints) {
  const select = document.getElementById("adminTypeFilter");
  if (!select) return;

  const selected = select.value;
  const types = Array.from(
    new Set(
      complaints
        .map((item) => (item.issue_type || "").trim())
        .filter((value) => value)
    )
  ).sort((a, b) => a.localeCompare(b));

  select.innerHTML = '<option value="all">All</option>';
  types.forEach((type) => {
    const option = document.createElement("option");
    option.value = type.toLowerCase();
    option.textContent = type;
    select.appendChild(option);
  });

  if ([...select.options].some((opt) => opt.value === selected)) {
    select.value = selected;
  }
}

function updateAdminPagination(totalItems) {
  const pageInfo = document.getElementById("adminPageInfo");
  const prevBtn = document.getElementById("adminPrev");
  const nextBtn = document.getElementById("adminNext");
  const size = getAdminPageSize();
  const totalPages = Math.max(1, Math.ceil(totalItems / size));

  if (adminPage > totalPages) {
    adminPage = totalPages;
  }

  if (pageInfo) {
    pageInfo.textContent = `Page ${adminPage} of ${totalPages}`;
  }
  if (prevBtn) {
    prevBtn.disabled = adminPage <= 1;
  }
  if (nextBtn) {
    nextBtn.disabled = adminPage >= totalPages;
  }
}

function adminCardTemplate(item, highlight = false) {
  const actionsEnabled = !adminReadOnly;
  const cardClass = highlight ? "complaint-card h-100 escalated-card" : "complaint-card h-100";
  const feedbackRating = item.feedback_rating;
  const feedbackComment = item.feedback;
  const resolvedImage = normalizeImageUrl(item.resolved_image_url);
  const assignedLabel = item.assigned_worker_name || item.assigned_to || "Unassigned";
  const hasWorkers = adminWorkersCache.length > 0;
  const assignLabel = assignedLabel === "Unassigned" ? "Assign Worker" : "Reassign Worker";
  const acknowledged = Boolean(item.accepted_at);
  const workStarted = Boolean(item.started_at);
  const ackBadge = assignedLabel === "Unassigned"
    ? `<span class="badge-status badge-pending">Unassigned</span>`
    : workStarted
      ? `<span class="badge-status badge-progress">Work Started</span>`
      : acknowledged
        ? `<span class="badge-status badge-resolved">Accepted</span>`
      : `<span class="badge-status badge-awaiting">Not Acknowledged</span>`;

  return `
    <div class="col-md-6">
      <div class="card ${cardClass}">
        <div class="card-body d-flex flex-column gap-2">
          <div class="d-flex justify-content-between align-items-start">
            <h5 class="mb-1">${item.title || "Untitled"}</h5>
            ${statusBadge(item.status)}
          </div>
          ${
            item.escalated_level >= 2
              ? `<span class="badge-status badge-escalated">Escalated L2</span>`
              : item.escalated
                ? `<span class="badge-status badge-escalated">Escalated</span>`
                : ""
          }
          <p class="mb-1 text-muted small">${item.location || "Location not set"}</p>
          <p class="mb-2">${item.description || "No description provided."}</p>
          <div class="d-flex flex-wrap gap-2">
            <span class="text-muted small">Citizen: ${item.citizen_name || "Unavailable"}</span>
            <span class="text-muted small">Assigned: ${assignedLabel}</span>
            ${ackBadge}
            ${
              item.assigned_at
                ? `<span class="text-muted small">Assigned at: ${formatDate(item.assigned_at)}</span>`
                : ""
            }
            ${
              item.accepted_at
                ? `<span class="text-muted small">Accepted at: ${formatDate(item.accepted_at)}</span>`
                : ""
            }
            ${
              item.started_at
                ? `<span class="text-muted small">Work started: ${formatDate(item.started_at)}</span>`
                : ""
            }
            ${
              item.escalated_at
                ? `<span class="text-muted small">Escalated: ${formatDate(
                    item.escalated_at
                  )}</span>`
                : ""
            }
          </div>
          ${
            actionsEnabled
              ? `<div class="d-flex flex-column flex-md-row gap-2 mt-2">
                  <select class="form-select" id="worker-${item._id}" ${hasWorkers ? "" : "disabled"}>
                    ${renderWorkerOptions(item)}
                  </select>
                  <button class="btn btn-soft" data-action="assign" data-id="${item._id}" ${hasWorkers ? "" : "disabled"}>
                    ${assignLabel}
                  </button>
                </div>`
              : ""
          }
          ${
            resolvedImage
              ? `<div class="mt-2">
                  <label class="form-label small mb-1">Resolution Image</label>
                  <img class="preview-img clickable-image" data-image="${resolvedImage}" src="${resolvedImage}" alt="Resolution image">
                </div>`
              : `<p class="text-muted small mb-0">Resolution image not uploaded yet.</p>`
          }
          ${
            feedbackRating != null
              ? `<div class="alert alert-success py-2 px-3 mb-0">
                  <strong>Citizen Feedback:</strong> ${feedbackRating}/5
                  ${feedbackComment ? `<div class="small mt-1">${feedbackComment}</div>` : ""}
                </div>`
              : ""
          }
          ${
            actionsEnabled
              ? `<div class="d-flex flex-column flex-md-row gap-2 mt-2">
                  <select class="form-select" id="status-${item._id}">
                    <option${item.status === "Pending" ? " selected" : ""}>Pending</option>
                    <option${item.status === "Assigned" ? " selected" : ""}>Assigned</option>
                    <option${item.status === "Accepted" ? " selected" : ""}>Accepted</option>
                    <option${item.status === "Work Started" ? " selected" : ""}>Work Started</option>
                    <option${item.status === "In Progress" ? " selected" : ""}>In Progress</option>
                    <option${
                      item.status === "Awaiting Verification" ? " selected" : ""
                    }>Awaiting Verification</option>
                    <option${item.status === "Resolved" ? " selected" : ""} ${
                      item.resolved_image_url ? "" : "disabled"
                    }>Resolved</option>
                  </select>
                  <button class="btn btn-primary" data-action="status" data-id="${item._id}" ${
                    item.resolved_image_url ? "" : "disabled"
                  }>
                    Update Status
                  </button>
                </div>`
              : ""
          }
        </div>
      </div>
    </div>
  `;
}

function renderAdminPage() {
  const size = getAdminPageSize();
  syncAdminPageSize(size);
  const totalItems = adminFilteredComplaints.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / size));
  if (adminPage > totalPages) {
    adminPage = totalPages;
  }
  const start = (adminPage - 1) * size;
  const pageItems = adminFilteredComplaints.slice(start, start + size);
  renderAdminComplaints(pageItems);
  updateAdminPagination(totalItems);
}

function applyAdminFilters(resetPage = false) {
  const searchInput = document.getElementById("adminSearch");
  const statusSelect = document.getElementById("adminStatusFilter");
  const typeSelect = document.getElementById("adminTypeFilter");

  const query = (searchInput?.value || "").trim().toLowerCase();
  const status = (statusSelect?.value || "all").toLowerCase();
  const issueType = (typeSelect?.value || "all").toLowerCase();

  adminFilteredComplaints = adminComplaintsCache.filter((item) => {
    const itemStatus = (item.status || "pending").toLowerCase();
    const itemType = (item.issue_type || "").toLowerCase();

    if (status !== "all" && itemStatus !== status) return false;
    if (issueType !== "all" && itemType !== issueType) return false;

    if (!query) return true;
    const haystack = [
      item.title,
      item.location,
      item.citizen_name,
      item.assigned_to,
      item.description,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  if (resetPage) {
    adminPage = 1;
  }
  renderAdminPage();
}

function exportAdminCsv() {
  const rows = adminFilteredComplaints.length
    ? adminFilteredComplaints
    : adminComplaintsCache;

  if (!rows.length) return;

  const header = [
    "Title",
    "Issue Type",
    "Location",
    "Status",
    "Citizen",
    "Assigned To",
    "Escalated",
    "Escalation Level",
    "Escalated At",
    "Submitted At",
  ];

  const csv = [
    header.map(escapeCsv).join(","),
    ...rows.map((item) =>
      [
        item.title,
        item.issue_type,
        item.location,
        item.status,
        item.citizen_name,
        item.assigned_to,
        item.escalated ? "Yes" : "No",
        item.escalated_level || 0,
        formatDate(item.escalated_at),
        formatDate(item.submitted_at),
      ]
        .map(escapeCsv)
        .join(",")
    ),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "cleancity-complaints.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function loadAdminDashboard() {
  const stats = {
    total: document.getElementById("statTotal"),
    pending: document.getElementById("statPending"),
    progress: document.getElementById("statProgress"),
    resolved: document.getElementById("statResolved"),
  };

  adminReadOnly = false;
  setAdminLoading();
  try {
    await loadAdminWorkers();
    const dashboardResponse = await apiFetch("/admin/dashboard", {}, true);
    const dashboardData = await dashboardResponse.json();

    if (stats.total) stats.total.textContent = dashboardData.total_complaints ?? 0;
    if (stats.pending) stats.pending.textContent = dashboardData.pending_complaints ?? 0;
    if (stats.resolved) stats.resolved.textContent = dashboardData.resolved_complaints ?? 0;

    const complaintsResponse = await apiFetch("/complaints");
    const complaints = await complaintsResponse.json();
    const list = Array.isArray(complaints) ? complaints : [];
    const visibleList = list.filter(
      (item) => (item.status || "").toLowerCase() !== "resolved"
    );
    const escalatedList = visibleList
      .filter((item) => item.escalated)
      .sort((a, b) => {
        const levelA = a.escalated_level || 1;
        const levelB = b.escalated_level || 1;
        if (levelA !== levelB) return levelB - levelA;
        const dateA = new Date(a.escalated_level2_at || a.escalated_at || 0).getTime();
        const dateB = new Date(b.escalated_level2_at || b.escalated_at || 0).getTime();
        return dateB - dateA;
      });
    const mainList = visibleList.filter((item) => !item.escalated);
    const inProgress = list.filter((item) => {
      const status = (item.status || "").toLowerCase();
      return (
        status === "accepted" ||
        status === "work started" ||
        status === "in progress" ||
        status === "awaiting verification"
      );
    }).length;

    if (stats.progress) stats.progress.textContent = inProgress;

    adminEscalatedCache = escalatedList;
    renderAdminEscalated(escalatedList);
    adminComplaintsCache = mainList;
    updateAdminTypeFilter(mainList);
    applyAdminFilters(true);
  } catch (error) {
    setAdminLoading(error.message || "Unable to load complaints. Please refresh.");
  }
}

async function loadAdminWorkers() {
  const response = await apiFetch("/admin/workers", {}, true);
  const data = await response.json();
  if (response.status === 401 || response.status === 403) {
    adminWorkersCache = [];
    const message = "Your admin session expired. Please logout and login again as admin.";
    showAdminToast("Login required", message, "error");
    throw new Error(message);
  }
  adminWorkersCache = response.ok && Array.isArray(data) ? data : [];
}

async function loadResolvedArchive() {
  adminReadOnly = true;
  setAdminLoading("Loading resolved complaints...");
  try {
    const complaintsResponse = await apiFetch("/complaints");
    const complaints = await complaintsResponse.json();
    const list = Array.isArray(complaints) ? complaints : [];
    const resolvedList = list.filter(
      (item) => (item.status || "").toLowerCase() === "resolved"
    );

    adminComplaintsCache = resolvedList;
    updateAdminTypeFilter(resolvedList);
    applyAdminFilters(true);
  } catch {
    setAdminLoading("Unable to load resolved complaints. Please refresh.");
  }
}

function renderAdminComplaints(complaints) {
  const container = document.getElementById("adminComplaints");
  if (!container) return;

  if (!complaints.length) {
    container.innerHTML =
      "<p class=\"text-muted\">No complaints found for the current filters.</p>";
    return;
  }

  container.innerHTML = complaints
    .map((item) => adminCardTemplate(item))
    .join("");
}

function renderAdminEscalated(complaints) {
  const container = document.getElementById("adminEscalated");
  if (!container) return;

  if (!complaints.length) {
    container.innerHTML =
      "<p class=\"text-muted\">No escalated complaints right now.</p>";
    return;
  }

  container.innerHTML = complaints
    .map((item) => adminCardTemplate(item, true))
    .join("");
}

function bindAdminFilters() {
  const searchInput = document.getElementById("adminSearch");
  const statusSelect = document.getElementById("adminStatusFilter");
  const typeSelect = document.getElementById("adminTypeFilter");
  const exportBtn = document.getElementById("exportCsv");

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      if (adminSearchTimer) clearTimeout(adminSearchTimer);
      adminSearchTimer = setTimeout(() => applyAdminFilters(true), 200);
    });
  }

  if (statusSelect) {
    statusSelect.addEventListener("change", () => applyAdminFilters(true));
  }

  if (typeSelect) {
    typeSelect.addEventListener("change", () => applyAdminFilters(true));
  }

  if (exportBtn) {
    exportBtn.addEventListener("click", exportAdminCsv);
  }

  const prevBtn = document.getElementById("adminPrev");
  const nextBtn = document.getElementById("adminNext");
  const pageSizeSelect = document.getElementById("adminPageSize");

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      if (adminPage > 1) {
        adminPage -= 1;
        renderAdminPage();
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const size = getAdminPageSize();
      const totalPages = Math.max(1, Math.ceil(adminFilteredComplaints.length / size));
      if (adminPage < totalPages) {
        adminPage += 1;
        renderAdminPage();
      }
    });
  }

  if (pageSizeSelect) {
    const stored = localStorage.getItem(adminPageSizeKey);
    if (stored) {
      pageSizeSelect.value = stored;
    }
    pageSizeSelect.addEventListener("change", () => {
      const size = getAdminPageSize();
      syncAdminPageSize(size);
      adminPage = 1;
      renderAdminPage();
    });
  }
}

function bindAdminActions() {
  const containers = [
    document.getElementById("adminComplaints"),
    document.getElementById("adminEscalated"),
  ].filter(Boolean);
  if (!containers.length) return;

  containers.forEach((container) => {
    container.addEventListener("click", async (event) => {
      const assignBtn = event.target.closest('[data-action="assign"]');
      const statusBtn = event.target.closest('[data-action="status"]');
      const image = event.target.closest(".clickable-image");
      const closeViewer = event.target.closest('[data-action="close-viewer"]');

      if (image) {
        const viewer = document.getElementById("imageViewer");
        const viewerImg = document.getElementById("imageViewerImg");
        if (viewer && viewerImg) {
          viewerImg.src = image.dataset.image || image.src;
          viewer.classList.remove("d-none");
        }
        return;
      }

      if (closeViewer) {
        const viewer = document.getElementById("imageViewer");
        const viewerImg = document.getElementById("imageViewerImg");
        if (viewer && viewerImg) {
          viewer.classList.add("d-none");
          viewerImg.src = "";
        }
        return;
      }

      if (assignBtn) {
        const id = assignBtn.dataset.id;
        const complaint = [...adminComplaintsCache, ...adminEscalatedCache].find((item) => item._id === id);
        const workerId = document.getElementById(`worker-${id}`).value.trim();
        if (!workerId) return;
        const worker = adminWorkersCache.find((item) => item._id === workerId);
        const wasAssigned = Boolean(
          complaint && (complaint.assigned_worker_name || complaint.assigned_to)
        );

        let response;
        let responseData = {};
        try {
          response = await apiFetch(
            `/admin/assign/${id}`,
            {
              method: "PUT",
              body: JSON.stringify({ worker_id: workerId }),
            },
            true
          );
          responseData = await response.json().catch(() => ({}));

          if (response.status === 404 || response.status === 405) {
            response = await apiFetch(
              `/assign-complaint/${id}`,
              {
                method: "PUT",
                body: JSON.stringify({ worker_id: workerId }),
              },
              true
            );
            responseData = await response.json().catch(() => ({}));
          }
        } catch (error) {
          const errorText =
            error && String(error.message).startsWith("Unauthorized")
              ? getUnauthorizedMessage("complaint assignment")
              : reachabilityMessage();
          showAdminToast("Assignment failed", errorText, "error");
          return;
        }

        if (!response.ok) {
          const errorText =
            response.status === 401 || response.status === 403
              ? getUnauthorizedMessage("complaint assignment")
              : responseData.error || "Unable to assign worker.";
          showAdminToast("Assignment failed", errorText, "error");
          return;
        }

        showAdminToast(
          wasAssigned ? "Worker reassigned" : "Worker assigned",
          worker
            ? `${worker.name} is now handling this complaint.`
            : "Complaint assignment updated successfully.",
          "success"
        );

        broadcastAppEvent("complaint-updated", { complaintId: id, action: "assigned" });
        loadAdminDashboard();
      }

      if (statusBtn) {
        const id = statusBtn.dataset.id;
        const status = document.getElementById(`status-${id}`).value;

        const response = await apiFetch(
          `/admin/complaint/status/${id}`,
          {
            method: "PUT",
            body: JSON.stringify({ status }),
          },
          true
        );

        if (!response.ok) {
          let errorText = "Unable to update complaint status.";
          try {
            const data = await response.json();
            errorText = data.error || errorText;
          } catch {}
          showAdminToast("Status update failed", errorText, "error");
          return;
        }

        showAdminToast("Status updated", `Complaint moved to ${status}.`, "success");

        broadcastAppEvent("complaint-updated", { complaintId: id, action: "status-updated" });
        loadAdminDashboard();
      }
    });
  });
}

function bindAdminResetPassword() {
  const form = document.getElementById("resetPasswordForm");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.getElementById("resetEmail").value.trim();
    const newPassword = document.getElementById("resetPassword").value.trim();
    const message = document.getElementById("resetMessage");
    try {
      const response = await apiFetch(
        "/admin/reset-password",
        {
          method: "POST",
          body: JSON.stringify({ email, new_password: newPassword }),
        },
        true
      );

      const data = await response.json();
      if (response.ok) {
        setInlineMessage(message, data.message || "Password reset successfully.", "success");
        form.reset();
      } else {
        const errorMessage =
          response.status === 401 || response.status === 403
            ? getUnauthorizedMessage("the password reset tool")
            : data.error || "Unable to reset password.";
        setInlineMessage(message, errorMessage, "error");
      }
    } catch (error) {
      const errorMessage =
        error && String(error.message).startsWith("Unauthorized")
          ? getUnauthorizedMessage("the password reset tool")
          : reachabilityMessage();
      setInlineMessage(message, errorMessage, "error");
    }
  });
}

function bindAdminCreateWorker() {
  const form = document.getElementById("createWorkerForm");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.getElementById("workerName").value.trim();
    const email = document.getElementById("workerEmail").value.trim();
    const password = document.getElementById("workerPassword").value.trim();
    const role = document.getElementById("workerRole")?.value || "worker";
    const roleLabel = role === "admin" ? "Admin" : "Worker";
    const message = document.getElementById("workerMessage");
    try {
      const response = await apiFetch(
        "/admin/create-user",
        {
          method: "POST",
          body: JSON.stringify({ name, email, password, role }),
        },
        true
      );

      const data = await response.json();
      if (response.ok) {
        setInlineMessage(message, data.message || `${roleLabel} created successfully.`, "success");
        form.reset();
      } else {
        const errorMessage =
          response.status === 401 || response.status === 403
            ? getUnauthorizedMessage("the staff creation tool")
            : data.error || `Unable to create ${roleLabel.toLowerCase()}.`;
        setInlineMessage(message, errorMessage, "error");
      }
    } catch (error) {
      const errorMessage =
        error && String(error.message).startsWith("Unauthorized")
          ? getUnauthorizedMessage("the staff creation tool")
          : reachabilityMessage();
      setInlineMessage(message, errorMessage, "error");
    }
  });
}

function bindAdminTestEmail() {
  const form = document.getElementById("testEmailForm");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.getElementById("testEmail").value.trim();
    const message = document.getElementById("testEmailMessage");

    const response = await apiFetch(
      "/admin/test-email",
      {
        method: "POST",
        body: JSON.stringify({ email }),
      },
      true
    );

    const data = await response.json();
    if (response.ok) {
      if (message) {
        message.textContent = data.message || "Test email sent.";
        message.classList.remove("text-danger");
        message.classList.add("text-success");
      }
      form.reset();
    } else if (message) {
      message.textContent = data.error || "Unable to send test email.";
      message.classList.remove("text-success");
      message.classList.add("text-danger");
    }
  });
}

async function loadWorkerDashboard() {
  if (workerFilePickerOpen) return;
  const response = await apiFetch("/worker/dashboard", {}, true);
  const data = await response.json();
  const complaints = data.assigned_complaints || [];
  const active = complaints.filter(
    (item) => (item.status || "").toLowerCase() !== "resolved"
  );
  const resolved = complaints.filter(
    (item) => (item.status || "").toLowerCase() === "resolved"
  );
  renderWorkerComplaints(active);
  renderWorkerResolved(resolved);
}

function renderWorkerComplaints(complaints) {
  const container = document.getElementById("workerComplaints");
  if (!container) return;

  if (!complaints.length) {
    container.innerHTML = "<p class=\"text-muted\">No assigned complaints yet.</p>";
    return;
  }

  container.innerHTML = complaints
    .map(
      (item) => {
        const status = (item.status || "").toLowerCase();
        const awaiting = status === "awaiting verification";
        const accepted = Boolean(item.accepted_at);
        const started = Boolean(item.started_at);
        const selectedResolveImage = workerResolveImages[item._id];
        const hasSelectedResolveImage = Boolean(selectedResolveImage?.preview);
        return `
      <div class="col-md-6">
        <div class="card complaint-card h-100">
          <div class="card-body d-flex flex-column gap-2">
            <div class="d-flex justify-content-between align-items-start">
              <h5 class="mb-1">${item.title || "Untitled"}</h5>
              ${statusBadge(item.status)}
            </div>
            <p class="mb-1 text-muted small">${item.location || "Location not set"}</p>
            <p class="mb-2">${item.description || "No description provided."}</p>
            <span class="text-muted small">Reported by: ${item.citizen_name || "Unavailable"}</span>
            ${
              item.assigned_at
                ? `<span class="text-muted small">Assigned: ${formatDate(item.assigned_at)}</span>`
                : ""
            }
            ${
              awaiting
                ? `<div class="alert alert-warning py-2 px-3 mb-0">
                    Resolution submitted. Waiting for admin verification.
                  </div>`
                : `${started
                    ? `<div class="alert alert-success py-2 px-3 mb-0">
                        Work started. Upload the completion photo after finishing the job.
                      </div>`
                    : accepted
                      ? `<div class="alert alert-success py-2 px-3 mb-0">
                          Job accepted. Tap the button below when you begin field work.
                        </div>
                        <button class="btn btn-primary mt-1" data-action="start-work" data-id="${item._id}">
                          Start Work
                        </button>`
                    : `<div class="alert alert-warning py-2 px-3 mb-0">
                        Please accept this job before starting work.
                      </div>
                      <button class="btn btn-primary mt-1" data-action="accept-job" data-id="${item._id}">
                        I Accept This Job
                      </button>`
                  }
                  <div class="mt-2">
                    <label class="form-label small mb-1">Resolution Photo</label>
                    <input
                      type="file"
                      class="form-control form-control-sm"
                      accept="image/*"
                      data-resolve-image
                      data-id="${item._id}"
                      ${started ? "" : "disabled"}
                    >
                    <div class="mt-2" id="resolvePreview-${item._id}" style="display: ${hasSelectedResolveImage ? "block" : "none"};">
                      <img
                        class="preview-img"
                        id="resolvePreviewImg-${item._id}"
                        alt="Resolution preview"
                        src="${hasSelectedResolveImage ? selectedResolveImage.preview : ""}"
                      >
                    </div>
                  </div>
                  <button class="btn btn-primary mt-2" data-action="resolve" data-id="${item._id}" ${started ? "" : "disabled"}>
                    Submit for Verification
                  </button>`
            }
          </div>
        </div>
      </div>
    `;
      }
    )
    .join("");
}

function renderWorkerResolved(complaints) {
  const container = document.getElementById("workerResolved");
  if (!container) return;

  if (!complaints.length) {
    container.innerHTML = "<p class=\"text-muted\">No resolved complaints yet.</p>";
    return;
  }

  container.innerHTML = complaints
    .map(
      (item) => {
        const resolvedImage = normalizeImageUrl(item.resolved_image_url);
        return `
      <div class="col-md-6">
        <div class="card complaint-card h-100">
          <div class="card-body d-flex flex-column gap-2">
            <div class="d-flex justify-content-between align-items-start">
              <h5 class="mb-1">${item.title || "Untitled"}</h5>
              ${statusBadge(item.status)}
            </div>
            <p class="mb-1 text-muted small">${item.location || "Location not set"}</p>
            <p class="mb-2">${item.description || "No description provided."}</p>
            ${
              resolvedImage
                ? `<div class="mt-2">
                    <label class="form-label small mb-1">Resolution Image</label>
                    <img class="preview-img" src="${resolvedImage}" alt="Resolution image">
                  </div>`
                : ""
            }
            ${
              item.feedback_rating != null
                ? `<div class="alert alert-success py-2 px-3 mb-0">
                    <strong>Citizen Feedback:</strong> ${item.feedback_rating}/5
                    ${item.feedback ? `<div class="small mt-1">${item.feedback}</div>` : ""}
                  </div>`
                : ""
            }
          </div>
        </div>
      </div>
    `;
      }
    )
    .join("");
}

function bindWorkerActions() {
  const container = document.getElementById("workerComplaints");
  if (!container) return;

  container.addEventListener("click", (event) => {
    const fileInput = event.target.closest("[data-resolve-image]");
    if (fileInput && !fileInput.disabled) {
      workerFilePickerOpen = true;
    }
  });

  container.addEventListener("click", async (event) => {
    const acceptBtn = event.target.closest('[data-action="accept-job"]');
    const startBtn = event.target.closest('[data-action="start-work"]');
    const resolveBtn = event.target.closest('[data-action="resolve"]');
    if (acceptBtn) {
      const id = acceptBtn.dataset.id;
      const response = await apiFetch(
        `/worker/complaint/${id}/accept`,
        {
          method: "PUT",
        },
        true
      );
      const data = await response.json();
      if (!response.ok) {
        showWorkerMessage(data.error || "Unable to accept job.", "error");
        return;
      }
      showWorkerMessage(data.message || "Job accepted successfully.", "success");
      broadcastAppEvent("complaint-updated", { complaintId: id, action: "accepted" });
      loadWorkerDashboard();
      return;
    }

    if (startBtn) {
      const id = startBtn.dataset.id;
      const response = await apiFetch(
        `/worker/complaint/${id}/start`,
        {
          method: "PUT",
        },
        true
      );
      const data = await response.json();
      if (!response.ok) {
        showWorkerMessage(data.error || "Unable to start work.", "error");
        return;
      }
      showWorkerMessage(data.message || "Work started successfully.", "success");
      broadcastAppEvent("complaint-updated", { complaintId: id, action: "started" });
      loadWorkerDashboard();
      return;
    }

    if (!resolveBtn) return;

    const id = resolveBtn.dataset.id;
    const resolveItem = workerResolveImages[id];
    if (!resolveItem || !resolveItem.file) {
      alert("Please upload a resolution photo before resolving.");
      return;
    }
    showWorkerMessage("");
    const formData = new FormData();
    formData.append("worker_id", getSessionValue("userId") || getName() || "");
    formData.append("image", resolveItem.file);
    const response = await apiFetch(
      `/worker/complaint/${id}`,
      {
        method: "PUT",
        body: formData,
      },
      true
    );
    const data = await response.json();
    if (!response.ok) {
      showWorkerMessage(data.error || "Unable to submit resolution.", "error");
      return;
    }

    delete workerResolveImages[id];
    showWorkerMessage(data.message || "Resolution submitted for verification.", "success");
    broadcastAppEvent("complaint-updated", { complaintId: id, action: "awaiting-verification" });
    loadWorkerDashboard();
  });

  container.addEventListener("change", (event) => {
    const input = event.target.closest("[data-resolve-image]");
    if (!input) return;

    workerFilePickerOpen = false;
    const id = input.dataset.id;
    const file = input.files && input.files[0];
    const preview = document.getElementById(`resolvePreview-${id}`);
    const previewImg = document.getElementById(`resolvePreviewImg-${id}`);

    if (!file) {
      delete workerResolveImages[id];
      if (preview && previewImg) {
        preview.style.display = "none";
        previewImg.src = "";
      }
      return;
    }

    if (preview && previewImg) {
      preview.style.display = "none";
      previewImg.src = "";
    }

    compressImageFile(file)
      .then((dataUrl) => {
        workerResolveImages[id] = { file, preview: dataUrl };
        if (preview && previewImg) {
          previewImg.src = dataUrl;
          preview.style.display = "block";
        }
      })
      .catch(() => {
        fileToDataUrl(file).then((dataUrl) => {
          workerResolveImages[id] = { file, preview: dataUrl };
          if (preview && previewImg) {
            previewImg.src = dataUrl;
            preview.style.display = "block";
          }
        });
      });
  });

  window.addEventListener("focus", () => {
    if (!workerFilePickerOpen) return;
    window.setTimeout(() => {
      workerFilePickerOpen = false;
    }, 300);
  });
}

function requireAuth(requiredRole = "") {
  if (!getToken()) {
    window.location.href = "index.html";
    return false;
  }
  if (requiredRole && getRole() !== requiredRole) {
    redirectToRoleHome();
    return false;
  }
  return true;
}

async function verifyAdminAccess(options = {}) {
  const {
    formId = "",
    messageId = "",
    area = "this page",
  } = options;

  try {
    const response = await apiFetch("/admin/workers", {}, true);
    const data = await response.json().catch(() => []);

    if (response.status === 401 || response.status === 403) {
      disableForm(formId, true);
      setInlineMessage(messageId, getUnauthorizedMessage(area), "error");
      return false;
    }

    adminWorkersCache = response.ok && Array.isArray(data) ? data : [];
    return response.ok;
  } catch {
    disableForm(formId, true);
    setInlineMessage(messageId, "Unable to verify admin session. Please try again.", "error");
    return false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  initWelcome();
  initCrossWindowSync();

  if (page === "login") {
    initLoginPage();
    return;
  }

  if (page === "reset") {
    initResetPage();
    return;
  }

  if (page === "citizen") {
    if (!requireAuth()) return;
    const form = document.getElementById("complaintForm");
    if (form) form.addEventListener("submit", submitComplaint);
    initComplaintImageUpload();
    bindCitizenActions();
    bindCitizenViewerClose();
    initCitizenSidebar();
    initComplaintsFilters();
    loadCitizenComplaints();
    updateNotificationUI();
    const notifyBtn = document.getElementById("notifyBtn");
    if (notifyBtn) {
      notifyBtn.addEventListener("click", requestNotificationPermission);
    }
    if (!citizenRefreshTimer) {
      citizenRefreshTimer = setInterval(loadCitizenComplaints, 30000);
    }
    return;
  }

  if (page === "admin") {
    if (!requireAuth("admin")) return;
    if (document.body.dataset.mode === "tools") {
      initWelcome();
      bindAdminResetPassword();
      bindAdminCreateWorker();
      const resetForm = document.getElementById("resetPasswordForm");
      const createForm = document.getElementById("createWorkerForm");
      if (resetForm) {
        verifyAdminAccess({
          formId: "resetPasswordForm",
          messageId: "resetMessage",
          area: "the password reset tool",
        });
      }
      if (createForm) {
        verifyAdminAccess({
          formId: "createWorkerForm",
          messageId: "workerMessage",
          area: "the staff creation tool",
        });
      }
      return;
    }
    bindAdminActions();
    bindAdminFilters();
    bindAdminResetPassword();
    bindAdminCreateWorker();
    bindAdminTestEmail();
    loadAdminDashboard();
    if (!adminRefreshTimer) {
      adminRefreshTimer = setInterval(() => {
        if (!document.hidden) {
          loadAdminDashboard().catch(() => {});
        }
      }, ADMIN_REFRESH_INTERVAL_MS);
    }
    return;
  }

  if (page === "admin-resolved") {
    if (!requireAuth("admin")) return;
    bindAdminFilters();
    loadResolvedArchive();
    return;
  }

  if (page === "worker") {
    if (!requireAuth("worker")) return;
    bindWorkerActions();
    loadWorkerDashboard();
    if (!workerRefreshTimer) {
      workerRefreshTimer = setInterval(() => {
        if (!document.hidden) {
          loadWorkerDashboard().catch(() => {});
        }
      }, WORKER_REFRESH_INTERVAL_MS);
    }
    return;
  }

  if (page === "complaint-detail") {
    if (!requireAuth()) return;
    loadComplaintDetail();
  }
});






