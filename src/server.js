
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { chromium } from "playwright";

const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "16kb" }));

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.API_TOKEN || "";
const TARGET = new URL(
  process.env.SPEEDTEST_TARGET_URL || "http://speedtest.llsapi.com/"
);

const MAX_JOBS = Math.max(
  1,
  Number(process.env.MAX_CONCURRENT_JOBS || 1)
);
const JOB_TIMEOUT = Math.max(
  10000,
  Number(process.env.JOB_TIMEOUT_MS || 60000)
);
const NAVIGATION_TIMEOUT = Math.max(
  5000,
  Number(process.env.NAVIGATION_TIMEOUT_MS || 20000)
);
const RETENTION = Math.max(
  60000,
  Number(process.env.JOB_RETENTION_MS || 1800000)
);

if (
  !["http:", "https:"].includes(TARGET.protocol) ||
  TARGET.hostname !== "speedtest.llsapi.com" ||
  TARGET.username ||
  TARGET.password
) {
  throw new Error("Invalid speed-test target hostname");
}

if (TOKEN.length < 32) {
  throw new Error("API_TOKEN must contain at least 32 characters");
}

const appState = {
  jobs: new Map(),
  activeJobs: 0
};

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false
});

function authenticate(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(
    req.get("authorization") || ""
  );

  if (!match) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(TOKEN);

  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function emit(job, type, data = {}) {
  const event = {
    id: ++job.sequence,
    type,
    timestamp: new Date().toISOString(),
    data
  };

  job.events.push(event);

  if (job.events.length > 200) {
    job.events.shift();
  }

  for (const res of job.clients) {
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function changeStatus(job, status, extra = {}) {
  job.status = status;
  Object.assign(job, extra);
  emit(job, "status", { status, ...extra });
}

function terminal(status) {
  return [
    "completed",
    "failed",
    "cancelled",
    "timed_out"
  ].includes(status);
}

function publicJob(job) {
  return {
    id: job.id,
    target: job.target,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    result: job.result,
    updates: job.updates,
    eventsUrl: `/api/speedtest/${job.id}/events`
  };
}

function buttonState(state) {
  return {
    text: String(state.text || "").trim().slice(0, 300),
    disabled: Boolean(state.disabled),
    className: String(state.className || "").slice(0, 300),
    ariaLabel: state.ariaLabel || null,
    ariaBusy: state.ariaBusy || null,
    title: state.title || null
  };
}

const BUTTON_SELECTOR =
  'button, [role="button"], input[type="button"], input[type="submit"]';

async function runBrowserJob(job) {
  let browser;

  try {
    changeStatus(job, "launching");

    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext();
    const page = await context.newPage();

    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    page.setDefaultTimeout(10000);

    // Restrict top-level navigation to the configured target host.
    // The website may still load third-party scripts and resources.
    await page.route("**/*", async (route) => {
      const request = route.request();

      if (request.isNavigationRequest()) {
        try {
          const url = new URL(request.url());

          if (
            url.hostname !== TARGET.hostname ||
            !["http:", "https:"].includes(url.protocol)
          ) {
            return route.abort("blockedbyclient");
          }
        } catch {
          return route.abort("blockedbyclient");
        }
      }

      return route.continue();
    });

    page.on("pageerror", (error) => {
      emit(job, "page-error", {
        message: error.message.slice(0, 500)
      });
    });

    page.on("requestfailed", (request) => {
      emit(job, "request-failed", {
        url: request.url().slice(0, 500),
        reason: request.failure()?.errorText || "unknown"
      });
    });

    page.on("response", (response) => {
      if (
        /speed|test|download|upload|ping|latency/i.test(
          response.url()
        )
      ) {
        emit(job, "network-response", {
          url: response.url().slice(0, 500),
          status: response.status(),
          contentType:
            response.headers()["content-type"] || null
        });
      }
    });

    changeStatus(job, "navigating");

    await page.goto(TARGET.href, {
      waitUntil: "domcontentloaded"
    });

    job.result.page = {
      title: await page.title().catch(() => ""),
      finalUrl: page.url()
    };

    emit(job, "page-loaded", job.result.page);

    // Inspect standard interactive button elements. We don't assume
    // that the site's actual Start button has a particular CSS class.
    const candidates = await page.evaluate((selector) => {
      return Array.from(document.querySelectorAll(selector))
        .slice(0, 100)
        .map((element, index) => {
          const input = element instanceof HTMLInputElement;

          return {
            index,
            tag: element.tagName.toLowerCase(),
            text: (
              input
                ? element.value
                : element.innerText || element.textContent || ""
            ).trim().slice(0, 300),
            id: element.id || "",
            disabled: input
              ? element.disabled
              : element.disabled === true ||
                element.getAttribute("aria-disabled") === "true",
            className:
              typeof element.className === "string"
                ? element.className.slice(0, 300)
                : "",
            ariaLabel: element.getAttribute("aria-label"),
            title: element.getAttribute("title")
          };
        });
    }, BUTTON_SELECTOR);

    job.result.buttonCandidates = candidates;

    emit(job, "button-candidates", { candidates });

    const matches = candidates.filter((button) => {
      const label = [
        button.text,
        button.ariaLabel,
        button.title
      ].filter(Boolean).join(" ");

      return (
        !button.disabled &&
        /\b(start|go|begin)\b|speed[\s-]*test/i.test(label)
      );
    });

    // Fail closed: never click a guessed or ambiguous control.
    if (matches.length !== 1) {
      job.result.buttonDiscovery = {
        outcome:
          matches.length === 0
            ? "no-start-button-found"
            : "multiple-start-buttons-found",
        matchingCandidates: matches
      };

      throw new Error(
        matches.length === 0
          ? "No unique enabled Start button was identified. No button was clicked."
          : "Multiple possible Start buttons were found. No button was clicked."
      );
    }

    const selected = matches[0];

    // The locator index corresponds to the same DOM query used above.
    const button = page.locator(BUTTON_SELECTOR).nth(selected.index);

    const verified = await button.evaluate((element) => {
      const input = element instanceof HTMLInputElement;

      return {
        text: (
          input
            ? element.value
            : element.innerText || element.textContent || ""
        ).trim(),
        disabled: input
          ? element.disabled
          : element.hasAttribute("disabled") ||
            element.getAttribute("aria-disabled") === "true"
      };
    });

    if (
      verified.disabled ||
      !/\b(start|go|begin)\b|speed[\s-]*test/i.test(verified.text)
    ) {
      throw new Error(
        "Button changed before clicking. Inspect candidates and retry."
      );
    }

    // Register the callback before attaching the observer.
    await page.exposeFunction("reportSpeedTestButton", (raw) => {
      const state = buttonState(raw);
      const previous = job.updates.at(-1);

      if (
        previous &&
        JSON.stringify(previous.state) === JSON.stringify(state)
      ) {
        return;
      }

      const update = {
        at: new Date().toISOString(),
        state
      };

      job.updates.push(update);

      if (job.updates.length > 100) {
        job.updates.shift();
      }

      emit(job, "button-update", update);
    });

    // MutationObserver catches text/attribute/child changes.
    // Polling below also catches property-only changes such as input.value.
    await button.evaluate((element) => {
      const report = () => {
        const input = element instanceof HTMLInputElement;

        void window.reportSpeedTestButton({
          text: input
            ? element.value
            : element.innerText || element.textContent || "",
          disabled: input
            ? element.disabled
            : element.hasAttribute("disabled") ||
              element.getAttribute("aria-disabled") === "true",
          className:
            typeof element.className === "string"
              ? element.className
              : "",
          ariaLabel: element.getAttribute("aria-label"),
          ariaBusy: element.getAttribute("aria-busy"),
          title: element.getAttribute("title")
        });
      };

      const observer = new MutationObserver(report);

      observer.observe(element, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true
      });

      window.__speedTestObserver = observer;
      report();
    });

    changeStatus(job, "running");
    emit(job, "test-starting", { selectedButton: selected });

    await button.click();

    const startTime = Date.now();
    let sawBusy = false;
    let lastSignature = "";

    while (Date.now() - startTime < JOB_TIMEOUT) {
      if (job.cancelRequested) {
        changeStatus(job, "cancelled", {
          finishedAt: new Date().toISOString()
        });
        return;
      }

      const state = await button.evaluate((element) => {
        const input = element instanceof HTMLInputElement;

        return {
          text: (
            input
              ? element.value
              : element.innerText || element.textContent || ""
          ).trim(),
          disabled: input
            ? element.disabled
            : element.hasAttribute("disabled") ||
              element.getAttribute("aria-disabled") === "true",
          className:
            typeof element.className === "string"
              ? element.className
              : "",
          ariaLabel: element.getAttribute("aria-label"),
          ariaBusy: element.getAttribute("aria-busy"),
          title: element.getAttribute("title")
        };
      }).catch(() => null);

      if (state) {
        const signature = JSON.stringify(state);

        if (signature !== lastSignature) {
          lastSignature = signature;

          const busy =
            state.disabled ||
            state.ariaBusy === "true" ||
            /\b(testing|running|loading|measuring|stop|cancel)\b/i.test(
              `${state.text} ${state.className}`
            );

          if (busy) sawBusy = true;

          emit(job, "button-snapshot", {
            state: buttonState(state),
            sawBusy
          });

          // This is only a heuristic, not a verified site-specific
          // completion signal.
          if (sawBusy && !busy) {
            changeStatus(job, "completed", {
              finishedAt: new Date().toISOString(),
              result: {
                ...job.result,
                completionReason:
                  "button-returned-to-non-busy-state",
                elapsedMs: Date.now() - startTime
              }
            });

            return;
          }
        }
      }

      await page.waitForTimeout(500);
    }

    changeStatus(job, "timed_out", {
      finishedAt: new Date().toISOString(),
      result: {
        ...job.result,
        completionReason: "observation-window-expired"
      }
    });
  } catch (error) {
    changeStatus(job, "failed", {
      error:
        error instanceof Error
          ? error.message
          : "Browser automation failed",
      finishedAt: new Date().toISOString()
    });
  } finally {
    if (browser) await browser.close().catch(() => {});

    appState.activeJobs = Math.max(0, appState.activeJobs - 1);

    if (!job.finishedAt && terminal(job.status)) {
      job.finishedAt = new Date().toISOString();
    }

    emit(job, "finished", { status: job.status });
  }
}

// Public health endpoint. Never expose the API token here.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "superapp-speedtest-api",
    activeJobs: appState.activeJobs,
    uptimeSeconds: Math.round(process.uptime())
  });
});

// All automation endpoints require service-to-service authentication.
app.use("/api", authenticate);

app.post("/api/speedtest/start", limiter, (_req, res) => {
  if (appState.activeJobs >= MAX_JOBS) {
    return res.status(429).json({
      error: "Browser worker is busy. Try again later."
    });
  }

  const now = new Date().toISOString();

  const job = {
    id: randomUUID(),
    target: TARGET.href,
    status: "queued",
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    error: null,
    result: {},
    updates: [],
    events: [],
    clients: new Set(),
    sequence: 0,
    cancelRequested: false
  };

  appState.jobs.set(job.id, job);
  appState.activeJobs += 1;

  emit(job, "created", { id: job.id });

  void runBrowserJob(job);

  res.status(202).json({
    id: job.id,
    status: job.status,
    statusUrl: `/api/speedtest/${job.id}`,
    eventsUrl: `/api/speedtest/${job.id}/events`
  });
});

app.get("/api/speedtest/:id", (req, res) => {
  const job = appState.jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }

  res.json(publicJob(job));
});

app.get("/api/speedtest/:id/events", (req, res) => {
  const job = appState.jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  res.flushHeaders();

  const lastId = Number(
    req.get("last-event-id") || req.query.lastEventId || 0
  );

  res.write(
    `event: snapshot\ndata: ${JSON.stringify(publicJob(job))}\n\n`
  );

  for (const event of job.events) {
    if (event.id > lastId) {
      res.write(`id: ${event.id}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15000);

  job.clients.add(res);

  req.on("close", () => {
    clearInterval(heartbeat);
    job.clients.delete(res);
  });
});

app.post("/api/speedtest/:id/cancel", (req, res) => {
  const job = appState.jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }

  if (terminal(job.status)) {
    return res.status(409).json({
      error: `Job is already ${job.status}`
    });
  }

  job.cancelRequested = true;
  emit(job, "cancel-requested", { id: job.id });

  res.json({ id: job.id, status: "cancellation-requested" });
});

setInterval(() => {
  const cutoff = Date.now() - RETENTION;

  for (const [id, job] of appState.jobs) {
    const time = Date.parse(job.finishedAt || job.createdAt);

    if (terminal(job.status) && time < cutoff) {
      for (const client of job.clients) client.end();
      appState.jobs.delete(id);
    }
  }
}, 60000).unref();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Speed-test API listening on port ${PORT}`);
});